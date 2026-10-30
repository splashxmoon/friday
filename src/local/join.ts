import { LinkHost } from "../runner/host.js";
import { certAt, pinServer, postJson, unpinServer } from "../runner/dial.js";
import type { Runner } from "../runner/runner.js";

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
}

export interface JoinState {
  /** The computer this one is used from, and whether its link holds now. */
  hub: { name: string; connected: boolean; address?: string; since?: number } | null;
  error?: string;
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

  constructor(private o: { kv: JoinKV; name: string; log?: (line: string) => void }) {}

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
    return {
      hub: h ? { name: h.name, connected: this.connectedAt !== null, ...(this.address ? { address: this.address } : {}), ...(this.connectedAt ? { since: this.connectedAt } : {}) } : null,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Friday opening again: the link it had, taken up again. */
  async resume(): Promise<void> {
    if (await this.saved()) this.start();
  }

  /** The link from the other computer, pasted here: paired once, then held. */
  async join(link: string): Promise<JoinState> {
    const parsed = parseComputerLink(link);
    if (!parsed) return { ...(await this.state()), error: "That isn't a link from Friday's Your computers. Copy it again from the other computer." };
    const { hub, code } = parsed;
    let lastError = `Couldn't reach ${hub.name}. Both computers need to be on the same Wi-Fi, or both on Tailscale.`;
    for (const address of hub.addresses) {
      try {
        // Its certificate first, checked against the one in the link, before anything (the code) is sent to it.
        const pem = hub.scheme === "https" ? await certAt(address, hub.port, hub.fingerprint!) : undefined;
        if (hub.scheme === "https" && !pem) {
          lastError = `The computer at ${address} isn't ${hub.name}: its certificate doesn't match the link.`;
          continue;
        }
        const r = await postJson(`${urlOf(hub, address)}/phone/pair`, { code, name: this.o.name, kind: "computer" }, { ...(pem ? { pem, fingerprint: hub.fingerprint! } : {}) });
        if (r.status === 200 && typeof r.json.token === "string") {
          await this.leave();
          const kept: Hub = { ...hub, token: r.json.token, ...(pem ? { pem } : {}), last: address };
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

  /** No longer used from the other computer: the link closed and forgotten here (it is removed there from its own Settings). */
  async leave(): Promise<JoinState> {
    this.stopped = true;
    clearTimeout(this.retry);
    const h = await this.saved();
    if (h) for (const a of h.addresses) unpinServer(urlOf(h, a));
    this.link?.disconnect();
    this.link = null;
    this.connectedAt = null;
    this.address = undefined;
    await this.o.kv.del(KEY);
    return this.state();
  }

  /** Holds the link: each of the other computer's addresses in turn, the last one that answered first, and again after a drop. */
  private start(): void {
    this.stopped = false;
    clearTimeout(this.retry);
    let wait = 2_000;
    const go = async () => {
      if (this.stopped) return;
      const h = await this.saved();
      if (!h) return;
      const order = [...(h.last ? [h.last] : []), ...h.addresses.filter((a) => a !== h.last)];
      for (const address of order) {
        if (this.stopped) return;
        const server = urlOf(h, address);
        pinServer(server, { token: h.token, ...(h.pem ? { pem: h.pem, fingerprint: h.fingerprint! } : {}) });
        const link = new LinkHost({ server, token: "", runners: this.runners, ...(this.o.log ? { log: this.o.log } : {}) });
        try {
          await link.connect();
        } catch (e) {
          // Turned away for good (removed on the other computer): said, and not tried again until it is paired again.
          const code = (e as { code?: number }).code;
          if (code === 4001 || code === 4003) {
            this.error = `${h.name} doesn't take this computer any more. Pair it again from its Settings › Your computers.`;
            this.stopped = true;
            return;
          }
          continue;
        }
        this.link = link;
        this.connectedAt = Date.now();
        this.address = address;
        this.error = "";
        wait = 2_000;
        if (h.last !== address) await this.o.kv.set(KEY, JSON.stringify({ ...h, last: address }));
        this.o.log?.(`linked to ${h.name} at ${address}`);
        const { code } = await link.closed;
        this.link = null;
        this.connectedAt = null;
        this.address = undefined;
        // Removed there: its listener refuses this token from now on, and the next try says so.
        if (code === 4002) this.error = `${h.name} removed this computer.`;
        break;
      }
      if (this.stopped) return;
      this.retry = setTimeout(() => void go(), wait);
      wait = Math.min(wait * 2, 60_000);
    };
    void go();
  }

  /** Friday closing: the link goes; agents it started here carry on, as a linked machine's do. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.link?.disconnect();
  }
}
