import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { Focus } from "./focus.js";
import { MAIN_LANE, type DiffFile, type PresenceMember, type SessionEvent } from "./types.js";
import { sessionKeys, wakeChannel } from "./session/keys.js";
import { hideSecrets, hideSecretsIn } from "./secrets.js";

/**
 * What each lane's agent has typed of its current message, for a person who joins or reconnects mid-answer: live deltas are
 * never logged, so they used to see nothing until the message ended. Kept as it streamed (unhidden, so the joined text is
 * what the shield reads: a key split across two deltas is hidden whole), and cleared just before the message, the run's end,
 * a pause or a cancel is logged (SessionStore.appendAll), so a joiner is never shown a finished message twice.
 *
 * Every delta carries `n`, one counter for the whole process, and `origin`, this process: a joiner is sent the held text,
 * then only this process's deltas numbered after it, so nothing doubles or goes missing. Another server's deltas (a second
 * instance, or old and new overlapping in a deploy) are not in this one's held text and its `n` is another counter, so they
 * always pass.
 *
 * ponytail: this process's memory, so it knows only the deltas this server published (Render runs one). More than one
 * instance: keep it in Redis beside heldDiff (APPEND per delta, `n` from INCR) and read it with the hello.
 */
const HELD_MAX = 256 * 1024;
type Held = { text: string; reasoning: string; over?: { text?: boolean; reasoning?: boolean } };
const heldText = new Map<string, Map<string, Held>>();
let deltaN = 0;
/** This process, on every delta it publishes (see heldText). */
export const DELTA_ORIGIN = randomUUID();

/** Forget a lane's current message; called before its end is logged. `channel` is the session's bus key. */
export function endLiveText(channel: string, lane: string): void {
  const lanes = heldText.get(channel);
  if (!lanes?.delete(lane)) return;
  if (!lanes.size) heldText.delete(channel);
}

function holdDelta(channel: string, lane: string, text: string, kind: "text" | "reasoning"): void {
  let lanes = heldText.get(channel);
  if (!lanes) heldText.set(channel, (lanes = new Map()));
  let h = lanes.get(lane);
  if (!h) lanes.set(lane, (h = { text: "", reasoning: "" }));
  if (h.over?.[kind]) return;
  // Past the cap that channel is dropped, not cut: a cut could start in the middle of a key the shield then can't see. A
  // joiner then sees it from where they came in, as before any of this.
  if (h[kind].length + text.length > HELD_MAX) {
    h[kind] = "";
    h.over = { ...h.over, [kind]: true };
    return;
  }
  h[kind] += text;
}

/**
 * Fan-out over Redis pub/sub. Durable events are published by the append
 * script itself; ephemeral messages (token deltas, presence) go through
 * `publish` and are never written to the log.
 */
export type BusMessage =
  | { kind: "event"; event: SessionEvent }
  | { kind: "delta"; text: string; channel?: "text" | "reasoning"; /** Absent for the main lane. */ lane?: string; /** Set by publish: see heldText. */ n?: number; origin?: string }
  /** A coding tool's change set while its turn runs: logged once, as the turn ends (see LaneHost.onRunner). */
  | { kind: "diff"; base: string; files: DiffFile[]; /** Absent for the main lane. */ lane?: string }
  /** `anonymous`: how many watch live without an account (live-watch.ts), a count and nothing more. */
  | { kind: "presence"; members: PresenceMember[]; anonymous?: number }
  /** Where somebody is looking. Ephemeral: never logged, and gone when they are. `at: null` means they left. */
  | { kind: "focus"; id: string; at: Focus | null };

/** `raw` is the message as published, for passing on as it is: a room of sockets used to stringify it again each. */
type Handler = (m: BusMessage, raw: string) => void;

export class Bus {
  private handlers = new Map<string, Set<Handler>>();
  /** The SUBSCRIBE still waiting on Redis, by channel. */
  private subscribing = new Map<string, Promise<void>>();
  private wakeHandlers = new Set<(sid: string, lane: string) => void>();

  constructor(
    private pub: Redis,
    private sub: Redis,
    private prefix: string,
  ) {
    sub.on("message", (channel: string, raw: string) => {
      if (channel === wakeChannel(prefix)) {
        // "sid|lane"; a bare sid is a wake published before lanes existed.
        const i = raw.lastIndexOf("|");
        const sid = i === -1 ? raw : raw.slice(0, i);
        const lane = i === -1 ? MAIN_LANE : raw.slice(i + 1);
        for (const h of this.wakeHandlers) h(sid, lane);
        return;
      }
      const set = this.handlers.get(channel);
      if (!set) return;
      const msg = JSON.parse(raw) as BusMessage;
      for (const h of set) h(msg, raw);
    });
  }

  async start(): Promise<void> {
    await this.sub.subscribe(wakeChannel(this.prefix));
  }

  async subscribe(sid: string, h: Handler): Promise<() => Promise<void>> {
    const ch = sessionKeys(this.prefix, sid).bus;
    let set = this.handlers.get(ch);
    if (!set) {
      const fresh = (set = new Set());
      this.handlers.set(ch, set);
      const p: Promise<void> = this.sub.subscribe(ch).then(
        () => void (this.subscribing.get(ch) === p && this.subscribing.delete(ch)),
        (e) => {
          if (this.subscribing.get(ch) === p) this.subscribing.delete(ch);
          if (this.handlers.get(ch) === fresh) this.handlers.delete(ch);
          throw e;
        },
      );
      this.subscribing.set(ch, p);
    }
    // In the set before the wait, not after: added after, the last other subscriber leaving meanwhile (a run ending as a page
    // joins) dropped the set and unsubscribed the channel, and this one was added to a set nothing delivers to again.
    set.add(h);
    // A second subscriber waits for the same SUBSCRIBE: returning before Redis has it, its snapshot could miss an event
    // published in between.
    await this.subscribing.get(ch);
    return async () => {
      set.delete(h);
      if (set.size === 0 && this.handlers.get(ch) === set) {
        this.handlers.delete(ch);
        await this.sub.unsubscribe(ch);
      }
    };
  }

  async publish(sid: string, msg: BusMessage): Promise<void> {
    // What streams live (a tool's words as it writes them, its changes mid-turn) is shown to the room too: its secrets are
    // hidden as the log's are (secrets.ts). A key split across two streamed pieces can show half of itself until the logged
    // message, which is hidden whole, replaces it.
    const ch = sessionKeys(this.prefix, sid).bus;
    if (msg.kind === "delta") {
      // Held and numbered in one tick, so a joiner's snapshot (liveText) and the counter always agree.
      holdDelta(ch, msg.lane ?? MAIN_LANE, msg.text, msg.channel === "reasoning" ? "reasoning" : "text");
      msg = { ...msg, n: ++deltaN, origin: DELTA_ORIGIN };
    }
    if (msg.kind === "delta" || msg.kind === "diff") msg = hideSecretsIn(msg);
    await this.pub.publish(ch, JSON.stringify(msg));
  }

  /**
   * What every lane is typing now, as deltas to send a joiner right after the hello, secrets hidden on the joined text; and
   * `upTo`, the last delta number they include, so only the live deltas after it are passed on.
   */
  liveText(sid: string): { deltas: BusMessage[]; upTo: number } {
    const deltas: BusMessage[] = [];
    for (const [lane, h] of heldText.get(sessionKeys(this.prefix, sid).bus) ?? []) {
      for (const channel of ["reasoning", "text"] as const) {
        if (h[channel]) deltas.push({ kind: "delta", text: hideSecrets(h[channel]).text, ...(channel === "reasoning" ? { channel } : {}), ...(lane !== MAIN_LANE ? { lane } : {}) });
      }
    }
    return { deltas, upTo: deltaN };
  }

  /** Ask whichever node can take the lane's runner lease to run its agent. */
  async wake(sid: string, lane: string = MAIN_LANE): Promise<void> {
    await this.pub.publish(wakeChannel(this.prefix), `${sid}|${lane}`);
  }

  onWake(h: (sid: string, lane: string) => void): void {
    this.wakeHandlers.add(h);
  }
}
