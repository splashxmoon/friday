import { createHash } from "node:crypto";
import { LinkHost } from "../runner/host.js";
import { certAt, pinServer, postJson, unpinServer } from "../runner/dial.js";
import type { Runner } from "../runner/runner.js";
import { LINKED_AGAIN } from "./computers.js";

/**
 * This computer used from another computer's Friday (Arun, 2026-10-30: "lets also add support for multi machine for coding and
 * crew"): its own Friday stays as it is, and also holds a link to the other one, which can then start coding tools here, list
 * this computer's folders and tools, and run its teammates here (local/computers.ts on the other side). Over Wi-Fi or
 * Tailscale, with the certificate in the code pinned, and with nothing through Friday's servers.
 *
 * The code comes from Settings › Your computers on the other computer, as a link: friday://computer?h=<addresses>&p=<port>&
 * c=<code>&s=https&f=<sha256>&n=<its name>. Pasted into Settings › Your computers here, it pairs once, and the link is kept,
 * held, and taken up again whenever Friday opens.
 */

export interface JoinKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

interface Hub {
  /** The other computer's name. */
  name: string;
  addresses: string[];
  port: number;
  scheme: "https" | "http";
  fingerprint?: string;
  pem?: string;
  token: string;
  /** The address that answered last, tried first next time. */
  last?: string;
  /** Which code it was paired with (a hash of it): the same link again is this pairing; another is a new one (startLocal). */
  paired?: string;
  /** The Friday version it said it runs, when it last linked. */
  version?: string;
  /** Removed there: kept so a restart says so, rather than trying a listener that may have closed and saying "refused". */
  removed?: true;
}

/**
 * Why the link can't be had, sorted, so the person is told which one and what fixes it (2026-11-04 linking test: a certificate
 * made again, an address gone and a port taken all read as the same "Reconnecting…" for good, with nothing in the log).
 * - certificate: something answered at its address with another certificate (it made a new one): only pairing again fixes it.
 * - refused: the computer is there, but nothing of Friday's answers on the port (Friday closed, or its port taken there).
 * - unreachable: nothing answered at any of its addresses (another network, asleep, off).
 * - removed: it doesn't take this computer any more: pairing again fixes it.
 */
export type JoinProblem = { kind: "certificate" | "refused" | "unreachable" | "removed"; said: string; at: number; repair: boolean };

export interface JoinState {
  /** The computer this one is used from, and whether its link holds now. */
  hub: { name: string; connected: boolean; address?: string; since?: number; /** When it was last tried, while it isn't linked. */ tried?: number; problem?: JoinProblem; version?: string } | null;
  /** The Friday this computer runs. */
  version?: string;
  error?: string;
}

const codeHash = (code: string) => createHash("sha256").update(`friday-join:${code.trim().toUpperCase()}`).digest("hex").slice(0, 32);

/** What an address that didn't link said, sorted (JoinProblem). */
export function whyNot(e: unknown): JoinProblem["kind"] {
  const code = (e as { code?: unknown }).code;
  const m = String((e as Error)?.message ?? e);
  if (code === 4001 || code === 4002 || code === 4003 || /server response: 40[13]\b/.test(m)) return "removed";
  if (/isn't the computer this one was paired with|certificate|self.signed|CERT_/i.test(m)) return "certificate";
  if (/ECONNREFUSED|ECONNRESET|socket hang up|wrong version number|EPROTO/i.test(m)) return "refused";
  return "unreachable";
}

const KEY = "friday:join:hub";

export function parseComputerLink(link: string): { hub: Omit<Hub, "token" | "pem">; code: string } | null {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "friday:" || (u.hostname || u.pathname.replace(/^\/+/, "").split("?")[0]) !== "computer") return null;
  const q = u.searchParams;
  const addresses = (q.get("h") ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => /^[\w.:-]{1,64}$/.test(a));
  const port = Number(q.get("p"));
  const code = (q.get("c") ?? "").trim();
  const scheme = q.get("s") === "http" ? "http" : "https";
  const fingerprint = (q.get("f") ?? "").toLowerCase();
  if (!addresses.length || !Number.isInteger(port) || port < 1 || port > 65535 || code.length < 6) return null;
  // A secure link without the certificate to pin is no use: it could be anyone's.
  if (scheme === "https" && !/^[0-9a-f]{64}$/.test(fingerprint)) return null;
  return { hub: { name: (q.get("n") ?? "").slice(0, 60) || "your other computer", addresses, port, scheme, ...(scheme === "https" ? { fingerprint } : {}) }, code };
}

const urlOf = (h: Pick<Hub, "scheme" | "port">, address: string) => `${h.scheme}://${address.includes(":") ? `[${address}]` : address}:${h.port}`;

export class JoinHub {
  private link: LinkHost | null = null;
  private connectedAt: number | null = null;
  private address: string | undefined;
  private error = "";
  private stopped = true;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly runners = new Map<string, Runner>();
  /** Which holding of the link is the live one: one started over another stops the older, so two never take turns (4012). */
  private gen = 0;
  /** Pairing anew: the old pairing's link closing meanwhile (replaced there) isn't this computer being removed. */
  private pairing = false;
  private problem: JoinProblem | null = null;
  private tried: number | undefined;

  constructor(
    private o: {
      kv: JoinKV;
      name: string;
      log?: (line: string) => void;
      /** Turned away or removed there for good (a machine added as a service stops then, rather than trying forever). */
      onGone?: () => void;
      /** Which Friday install this is, the same each time (start.ts): pairing it again replaces its old row there. */
      machineId?: string;
      /** This Friday's version, said to the other computer as it links. */
      version?: string;
    },
  ) {}

  private async saved(): Promise<Hub | null> {
    const raw = await this.o.kv.get(KEY);
    try {
      return raw ? (JSON.parse(raw) as Hub) : null;
    } catch {
      return null;
    }
  }

  async state(): Promise<JoinState> {
    const h = await this.saved();
    const linked = this.connectedAt !== null;
    return {
      hub: h
        ? {
            name: h.name,
            connected: linked,
            ...(this.address ? { address: this.address } : {}),
            ...(this.connectedAt ? { since: this.connectedAt } : {}),
            ...(!linked && this.tried ? { tried: this.tried } : {}),
            ...(!linked && this.problem ? { problem: this.problem } : {}),
            ...(h.version ? { version: h.version } : {}),
          }
        : null,
      ...(this.o.version ? { version: this.o.version } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Friday opening again: the link it had, taken up again. Once: a second resume while it holds starts no second loop. */
  async resume(): Promise<void> {
    const h = await this.saved();
    if (!h || !this.stopped) return;
    // Removed there before this start: said again, and not tried (a service stops, as it did when it heard).
    if (h.removed) return (this.said(h, { kind: "removed", address: h.last ?? h.addresses[0] ?? "" }), this.o.onGone?.());
    this.start();
  }

  /** Whether this link is the one this computer is paired with already (a service restarting with the link it was set up with). */
  async pairedWith(link: string): Promise<boolean> {
    const parsed = parseComputerLink(link);
    const h = await this.saved();
    return !!parsed && !!h?.paired && h.paired === codeHash(parsed.code);
  }

  /** The link from the other computer, pasted here: paired once, then held. */
  async join(link: string): Promise<JoinState> {
    const parsed = parseComputerLink(link);
    if (!parsed) return { ...(await this.state()), error: "That isn't a link from Friday's Your computers. Copy it again from the other computer." };
    const { hub, code } = parsed;
    let lastError = `Couldn't reach ${hub.name} at ${hub.addresses.join(", ")}. Both computers need to be on the same Wi-Fi, or both on Tailscale.`;
    this.pairing = true;
    try {
      return await this.pair(hub, code, lastError);
    } finally {
      this.pairing = false;
    }
  }

  private async pair(hub: Omit<Hub, "token" | "pem">, code: string, lastError: string): Promise<JoinState> {
    for (const address of hub.addresses) {
      try {
        // Its certificate first, checked against the one in the link, before anything (the code) is sent to it.
        const pem = hub.scheme === "https" ? await certAt(address, hub.port, hub.fingerprint!) : undefined;
        if (hub.scheme === "https" && !pem) {
          lastError = `The computer at ${address} isn't ${hub.name}: its certificate doesn't match the link.`;
          continue;
        }
        const r = await postJson(`${urlOf(hub, address)}/phone/pair`, { code, name: this.o.name, kind: "computer", ...(this.o.machineId ? { machine: this.o.machineId } : {}) }, { ...(pem ? { pem, fingerprint: hub.fingerprint! } : {}) });
        if (r.status === 200 && typeof r.json.token === "string") {
          // A pairing it had (with this computer, removed there, or with another) is replaced: told there, then forgotten here.
          await this.leave();
          const kept: Hub = { ...hub, token: r.json.token, ...(pem ? { pem } : {}), last: address, paired: codeHash(code) };
          await this.o.kv.set(KEY, JSON.stringify(kept));
          this.error = "";
          this.start();
          return this.state();
        }
        // It answered, and said no: the code ran out or was used. Another address would say the same.
        lastError = typeof r.json.error === "string" ? r.json.error : "That code didn't work. Make a new one on the other computer.";
        break;
      } catch {
        // Not there: the next address.
      }
    }
    this.error = lastError;
    return this.state();
  }

  /**
   * No longer used from the other computer: the link closed and forgotten here, and the other computer told, so it forgets this
   * one too rather than keeping a row that never connects again (2026-11-04 linking test). Told only while it can be reached.
   */
  async leave(): Promise<JoinState> {
    this.stopped = true;
    this.gen++;
    clearTimeout(this.retry);
    const h = await this.saved();
    const at = this.address;
    if (h && at) await postJson(`${urlOf(h, at)}/phone/leave`, {}, { token: h.token, ...(h.pem ? { pem: h.pem, fingerprint: h.fingerprint! } : {}) }, 3000).catch(() => null);
    if (h) for (const a of h.addresses) unpinServer(urlOf(h, a));
    this.link?.disconnect();
    this.link = null;
    this.connectedAt = null;
    this.address = undefined;
    this.problem = null;
    this.tried = undefined;
    await this.o.kv.del(KEY);
    return this.state();
  }

  /**
   * Holds the link: each of the other computer's addresses in turn, the last one that answered first, and again after a drop,
   * a little later each time (with some jitter, so computers dropped together don't all come back at once). One holding at a
   * time: a new one (paired again, Friday resuming) ends the one before, which used to keep going beside it, each link taking
   * the computer's place from the other.
   */
  private start(): void {
    this.stopped = false;
    clearTimeout(this.retry);
    const gen = ++this.gen;
    const live = () => !this.stopped && gen === this.gen;
    let wait = 2_000;
    const go = async () => {
      if (!live()) return;
      const h = await this.saved();
      if (!h) return;
      const order = [...(h.last ? [h.last] : []), ...h.addresses.filter((a) => a !== h.last)];
      this.tried = Date.now();
      /** Why each address didn't link, the most telling kept (JoinProblem). */
      let why: { kind: JoinProblem["kind"]; address: string } | null = null;
      const RANK = { unreachable: 0, refused: 1, certificate: 2, removed: 3 } as const;
      for (const address of order) {
        if (!live()) return;
        const server = urlOf(h, address);
        pinServer(server, { token: h.token, ...(h.pem ? { pem: h.pem, fingerprint: h.fingerprint! } : {}) });
        const link = new LinkHost({ server, token: "", runners: this.runners, ...(this.o.log ? { log: this.o.log } : {}) });
        try {
          await link.connect();
        } catch (e) {
          const kind = whyNot(e);
          if (!why || RANK[kind] > RANK[why.kind]) why = { kind, address };
          // Turned away for good (removed on the other computer): said, and not tried again until it is paired again. Its device
          // forgotten there (removed in its Settings): the listener turns the token away before the socket opens, a 401.
          if (kind === "removed") break;
          continue;
        }
        if (!live()) return link.disconnect();
        this.link = link;
        this.connectedAt = Date.now();
        this.address = address;
        this.error = "";
        this.problem = null;
        wait = 2_000;
        if (h.last !== address) await this.o.kv.set(KEY, JSON.stringify({ ...h, last: address }));
        this.o.log?.(`linked to ${h.name} at ${address}`);
        void this.hello(h, address);
        const { code } = await link.closed;
        if (this.link === link) {
          this.link = null;
          this.connectedAt = null;
          this.address = undefined;
        }
        if (!live()) return;
        // Removed there (its listener refuses this token from now on), unless it is this computer pairing again, whose old
        // pairing goes there as the new one is made. "Linked again" (LINKED_AGAIN) is a drop like any other: once it was this
        // same code, and a service hearing it stopped for good.
        if (code === 4002 && !this.pairing) why = { kind: "removed", address };
        else this.o.log?.(`link to ${h.name} closed (${code === LINKED_AGAIN ? "linked again" : code}): linking again`);
        break;
      }
      if (!live()) return;
      if (why) this.said(h, why);
      if (why?.kind === "removed") {
        this.stopped = true;
        await this.o.kv.set(KEY, JSON.stringify({ ...h, removed: true }));
        this.o.onGone?.();
        return;
      }
      const next = Math.round(wait * (0.8 + Math.random() * 0.4));
      this.retry = setTimeout(() => void go(), why ? next : 1_000);
      if (why) wait = Math.min(wait * 2, 60_000);
    };
    void go();
  }

  /** Why the link can't be had, kept for both sides to show, and said in the log once each time it changes. */
  private said(h: Hub, why: { kind: JoinProblem["kind"]; address: string }): void {
    const said = {
      removed: `${h.name} doesn't take this computer any more: it was removed there. Pair it again from its Settings › Your computers.`,
      certificate: `${h.name} answered at ${why.address}, but not with the certificate it paired with (it made a new one), so nothing is sent to it. Pair again from its Settings › Your computers.`,
      refused: `${h.name} is there at ${why.address}, but Friday isn't letting other computers in on port ${h.port}. Open Friday there, and check nothing else took that port.`,
      unreachable: `Can't reach ${h.name} at ${h.addresses.join(", ")}. Both computers need to be on the same network, or both on Tailscale, and ${h.name} awake.`,
    }[why.kind];
    if (this.problem?.kind !== why.kind) this.o.log?.(`can't link to ${h.name}: ${said}`);
    this.problem = { kind: why.kind, said, at: Date.now(), repair: why.kind === "removed" || why.kind === "certificate" };
    this.error = why.kind === "removed" ? said : "";
  }

  /**
   * Once linked: which Friday this is, said there, and where the other computer is now, kept, so a link whose addresses went
   * stale (another network, a new address) finds it again by its new ones or its names. An older Friday there doesn't answer.
   */
  private async hello(h: Hub, address: string): Promise<void> {
    const r = await postJson(`${urlOf(h, address)}/phone/hello`, { ...(this.o.version ? { version: this.o.version } : {}) }, { token: h.token, ...(h.pem ? { pem: h.pem, fingerprint: h.fingerprint! } : {}) }).catch(() => null);
    if (r?.status !== 200) return;
    const now = (Array.isArray(r.json.addresses) ? r.json.addresses : []).filter((a): a is string => typeof a === "string" && /^[\w.:-]{1,64}$/.test(a));
    const cur = await this.saved();
    if (!cur || cur.token !== h.token) return;
    const addresses = [...new Set([...now, ...cur.addresses])].slice(0, 8);
    const version = typeof r.json.version === "string" ? r.json.version.slice(0, 40) : undefined;
    if (addresses.join() !== cur.addresses.join() || version !== cur.version) await this.o.kv.set(KEY, JSON.stringify({ ...cur, addresses, ...(version ? { version } : {}) }));
  }

  /** Friday closing: the link goes; agents it started here carry on, as a linked machine's do. */
  stop(): void {
    this.stopped = true;
    this.gen++;
    clearTimeout(this.retry);
    this.link?.disconnect();
  }
}
