import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { Attention } from "../attention.js";

/**
 * Notifications on your phone from the Friday on this computer (Arun, 2026-11-12, the phone app's phase 1: "tell me when I'm
 * needed", product/specs/07-mobile-app.md).
 *
 * Apple delivers a push only when it is signed with the app maker's key, and that key can't ship in open-source code. So this
 * computer seals what it has to say with a key the phone gave it as it paired (AES-256-GCM), and hands the sealed bytes to
 * Friday's push service, which asks Apple to deliver "Friday" plus them. On the phone the app's notification extension opens
 * them and shows the real words. Apple and the push service only ever see "Friday" and bytes they can't read.
 *
 * Only what needs the person is sent (an approval, a question, a stopped run, a run done), each once, and only while nobody is
 * looking at that session here: someone at the computer sees it already.
 */

/** A phone that said where its notifications go: Apple's token, debug or release, and the key it sealed them with. */
export interface PushTarget {
  id: string;
  token: string;
  env: "production" | "sandbox";
  key: string;
}

/** What the phone shows once it opens it: the notification's own words, and where a tap or Approve goes. */
export interface PushNote {
  title: string;
  body: string;
  sid: string;
  kind: string;
  lane?: string;
  approval?: string;
}

export interface PhonePushKV {
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  hdel(key: string, field: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
}

/** Sends one sealed push to the service; resolves to its status (0 when it didn't answer). Replaced in tests. */
export type RelaySend = (url: string, body: Record<string, unknown>) => Promise<number>;

/** Friday's push service, unless FRIDAY_PUSH_RELAY names another (one you run yourself) or says "off". */
export const DEFAULT_RELAY = "https://www.app.tryfridaywork.com/api/push/relay";

export const relayFromEnv = (env: NodeJS.ProcessEnv): string | null => {
  const v = env.FRIDAY_PUSH_RELAY?.trim();
  if (v === "off" || v === "0") return null;
  return v || DEFAULT_RELAY;
};

/** A key a phone gave: 32 bytes, as base64 or base64url. Null when it isn't one. */
export function pushKey(raw: unknown): Buffer | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const b = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return b.length === 32 ? b : null;
}

/** The note, sealed for the phone that owns `key`: base64url of a 12-byte nonce, the ciphertext, then GCM's 16-byte tag. */
export function seal(key: Buffer, note: PushNote): string {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([c.update(JSON.stringify(note), "utf8"), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]).toString("base64url");
}

/** The words for one thing waiting, as the hosted push says them (push.ts payloadFor). */
export function noteFor(item: Attention): PushNote {
  const lead: Record<Attention["kind"], string> = {
    approval: "",
    question: item.agent ? `${item.agent} asks: ` : "",
    ask: item.agent ? `${item.agent} asks: ` : "",
    control: "",
    handover: "",
    stopped: item.agent ? `${item.agent} stopped: ` : "Stopped: ",
    mention: "",
  };
  return {
    title: (item.title || "Friday").slice(0, 120),
    body: `${lead[item.kind]}${item.text}`.slice(0, 240),
    sid: item.sid,
    kind: item.kind,
    ...(item.lane ? { lane: item.lane } : {}),
    ...(item.approval ? { approval: item.approval } : {}),
  };
}

const SENT = "friday:phone:pushed";
/** How long "sent already" is remembered: past that, an item still open a week later may push once more. */
const KEEP_MS = 7 * 86_400_000;

export class PhonePush {
  private lastPrune = 0;

  constructor(
    private o: {
      kv: PhonePushKV;
      /** The phones to tell, now: none while phone access is off (phone.ts pushTargets). */
      targets: () => Promise<PushTarget[]>;
      /** A phone whose token Apple says is gone: forgotten, so it isn't sent to again (phone.ts dropPush). */
      gone: (id: string) => Promise<unknown>;
      relay: string | null;
      send?: RelaySend;
      log?: (line: string) => void;
    },
  ) {}

  get on(): boolean {
    return !!this.o.relay;
  }

  /** What newly waits on the person: each item once, to each phone. Returns how many reached the service. */
  async notify(items: Attention[]): Promise<number> {
    if (!this.o.relay || !items.length) return 0;
    let sent = 0;
    for (const item of items) sent += await this.once(`${item.sid}:${item.kind}:${item.seq}`, noteFor(item), item.kind === "approval" || item.kind === "question" || item.kind === "ask" ? "time-sensitive" : "active");
    return sent;
  }

  /** A run done, for whoever set it going: sent once by its key. A question (a Captain's) goes time-sensitive, as an agent's does. */
  async done(once: string, note: PushNote, level: "time-sensitive" | "active" = "active"): Promise<number> {
    if (!this.o.relay) return 0;
    return this.once(once, note, level);
  }

  private async once(id: string, note: PushNote, level: "time-sensitive" | "active"): Promise<number> {
    const targets = await this.o.targets();
    if (!targets.length) return 0;
    const field = createHash("sha256").update(id).digest("hex").slice(0, 32);
    if (await this.o.kv.hget(SENT, field)) return 0;
    await this.o.kv.hset(SENT, field, String(Date.now()));
    void this.prune().catch(() => {});
    let sent = 0;
    for (const t of targets) {
      const key = pushKey(t.key);
      if (!key) continue;
      // The thread a phone groups it under: the session, hashed, so the service never learns which session it is.
      const thread = createHash("sha256").update(`${t.key}:${note.sid}`).digest("base64url").slice(0, 22);
      const status = await (this.o.send ?? post)(this.o.relay!, { token: t.token, env: t.env, sealed: seal(key, note), level, thread }).catch(() => 0);
      if (status === 410) await this.o.gone(t.id);
      if (status === 200) sent++;
      else this.o.log?.(`a notification for your phone didn't go out (${status || "no answer"})`);
    }
    return sent;
  }

  private lastTest = new Map<string, number>();

  /**
   * One notification to one phone, asked for from it (Settings › Notifications › Send a test): the same sealed path as a real
   * one, so a phone can see its notifications work end to end. Once every ten seconds per phone. Resolves to the service's
   * status: 200 delivered, 0 not sent (no relay, no key, too soon).
   */
  async test(id: string, computer: string): Promise<number> {
    if (!this.o.relay) return 0;
    const t = (await this.o.targets()).find((x) => x.id === id);
    const key = t && pushKey(t.key);
    if (!t || !key || Date.now() - (this.lastTest.get(id) ?? 0) < 10_000) return 0;
    this.lastTest.set(id, Date.now());
    const note: PushNote = { title: "Friday", body: `Notifications from ${computer} reach this phone.`, sid: "", kind: "test" };
    const status = await (this.o.send ?? post)(this.o.relay, { token: t.token, env: t.env, sealed: seal(key, note), level: "active", thread: "" }).catch(() => 0);
    if (status === 410) await this.o.gone(t.id);
    return status;
  }

  /** Items sent more than a week ago, forgotten: at most once an hour. */
  private async prune(): Promise<void> {
    if (Date.now() - this.lastPrune < 3_600_000) return;
    this.lastPrune = Date.now();
    for (const [f, at] of Object.entries(await this.o.kv.hgetall(SENT))) if (Date.now() - Number(at) > KEEP_MS) await this.o.kv.hdel(SENT, f);
  }
}

/** One sealed push to the service, ten seconds at most. */
async function post(url: string, body: Record<string, unknown>): Promise<number> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  return r.status;
}
