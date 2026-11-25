import { randomBytes } from "node:crypto";
import net from "node:net";
import { WebSocket, type RawData } from "ws";

/**
 * This computer, reachable from anywhere through Friday's relay (reach-relay.ts; Arun, 2026-11-12, phase 2): on whenever phone access
 * is, with no switch of its own (Arun, 2026-11-24: "get rid of anything saying reach from anywhere ... by default it can be access
 * anywhere and over wifi too"). Only FRIDAY_RELAY=off (test servers, or someone who wants none) keeps it closed.
 *
 * On, it keeps one outbound connection to the relay, with an id and a secret made here once (no account), and for each phone that
 * reaches it opens a fresh stream back and pipes it into this computer's own phone listener (phone.ts) on 127.0.0.1. The phone runs
 * the same pinned TLS through it as over Wi-Fi, so the relay only ever passes ciphertext. Off, the connection closes at once and
 * nothing listens outside this network.
 */

export interface ReachKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

export interface ReachState {
  on: boolean;
  /** Linked to the relay now. */
  connected: boolean;
  /** What a pairing link carries so the phone can find this computer through the relay. */
  id?: string;
  relay?: string;
  error?: string;
}

const KEY = (p: string) => `friday:reach:${p}`;

/** Friday's relay, unless FRIDAY_RELAY names another (wss://…/api/relay) or says "off". */
export const DEFAULT_RELAY = "wss://www.app.tryfridaywork.com/api/relay";
export const relayBase = (env: NodeJS.ProcessEnv): string | null => {
  const v = env.FRIDAY_RELAY?.trim();
  if (v === "off" || v === "0") return null;
  return (v || DEFAULT_RELAY).replace(/\/+$/, "");
};

export class ReachHome {
  private ws: WebSocket | null = null;
  private connected = false;
  private error = "";
  private retry: ReturnType<typeof setTimeout> | undefined;
  private wait = 2_000;
  private streams = new Set<{ ws: WebSocket; sock: net.Socket }>();
  private stopped = true;

  constructor(
    private o: {
      kv: ReachKV;
      /** Where the phone listener is, on this computer: null while it isn't open. */
      port: () => number | null;
      relay: string | null;
      log?: (line: string) => void;
    },
  ) {}

  /** Always, where there is a relay: a switch set off before 2026-11-24 no longer keeps it closed. */
  async on(): Promise<boolean> {
    return true;
  }

  /** The id and secret, made once. The id is what a phone reaches; the secret, which never leaves here, is what claims it. */
  private async identity(): Promise<{ id: string; secret: string }> {
    let id = await this.o.kv.get(KEY("id"));
    let secret = await this.o.kv.get(KEY("secret"));
    if (!id || !/^[0-9a-f]{32}$/.test(id) || !secret) {
      id = randomBytes(16).toString("hex");
      secret = randomBytes(32).toString("base64url");
      await this.o.kv.set(KEY("id"), id);
      await this.o.kv.set(KEY("secret"), secret);
    }
    return { id, secret };
  }

  async state(): Promise<ReachState> {
    const on = await this.on();
    if (!on || !this.o.relay) return { on: on && !!this.o.relay, connected: false, ...(!this.o.relay && on ? { error: "The relay is turned off here (FRIDAY_RELAY=off)." } : {}) };
    const { id } = await this.identity();
    return { on, connected: this.connected, id, relay: this.o.relay, ...(this.error && !this.connected ? { error: this.error } : {}) };
  }

  async setOn(on: boolean): Promise<ReachState> {
    await this.o.kv.set(KEY("on"), on ? "1" : "0");
    if (on) await this.start();
    else this.stop();
    return this.state();
  }

  /** Back on as Friday starts, if it was on. */
  async resume(): Promise<void> {
    if (await this.on()) await this.start();
  }

  private async start(): Promise<void> {
    if (!this.o.relay) return;
    this.stopped = false;
    if (this.ws) return;
    const { id, secret } = await this.identity();
    const ws = new WebSocket(`${this.o.relay}/home?id=${id}`, { headers: { "x-friday-secret": secret }, handshakeTimeout: 15_000 });
    this.ws = ws;
    ws.on("open", () => {
      this.connected = true;
      this.error = "";
      this.wait = 2_000;
      this.o.log?.("reachable from anywhere through the relay");
    });
    ws.on("message", (data: RawData) => {
      try {
        const m = JSON.parse(String(data)) as { open?: unknown };
        if (typeof m.open === "string" && /^[0-9a-f]{24}$/.test(m.open)) this.open(id, secret, m.open);
      } catch {
        // Not something the relay says.
      }
    });
    ws.on("unexpected-response", (_req, res) => {
      this.error = res.statusCode === 401 ? "The relay turned this computer away." : `The relay answered ${res.statusCode}.`;
    });
    ws.on("error", (e) => (this.error ||= e.message));
    ws.on("close", () => {
      this.ws = null;
      this.connected = false;
      if (this.stopped) return;
      // Back off, with some jitter so many computers don't all come back at once after the relay restarts.
      const wait = this.wait + Math.floor(Math.random() * 1_000);
      this.wait = Math.min(this.wait * 2, 60_000);
      clearTimeout(this.retry);
      this.retry = setTimeout(() => void this.start().catch(() => {}), wait);
      this.retry.unref?.();
    });
  }

  /** A phone reaching this computer: a stream back to the relay, piped into the phone listener here. */
  private open(id: string, secret: string, n: string): void {
    const port = this.o.port();
    if (!port) return;
    const ws = new WebSocket(`${this.o.relay}/stream/${n}?id=${id}`, { headers: { "x-friday-secret": secret }, handshakeTimeout: 15_000 });
    const sock = net.connect(port, "127.0.0.1");
    const pair = { ws, sock };
    this.streams.add(pair);
    const held: Buffer[] = [];
    let open = false;
    const end = () => {
      this.streams.delete(pair);
      sock.destroy();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
    };
    sock.on("data", (b: Buffer) => (open ? ws.send(b, { binary: true }) : held.push(b)));
    ws.on("open", () => {
      open = true;
      for (const b of held.splice(0)) ws.send(b, { binary: true });
    });
    ws.on("message", (data: RawData) => sock.write(Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)));
    ws.on("close", end);
    ws.on("error", end);
    sock.on("close", end);
    sock.on("error", end);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.ws?.terminate();
    this.ws = null;
    this.connected = false;
    for (const s of this.streams) (s.sock.destroy(), s.ws.terminate());
    this.streams.clear();
  }
}
