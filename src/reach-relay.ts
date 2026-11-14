import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";

/**
 * Reach your computer from anywhere (Arun, 2026-11-12, phase 2 of the phone plan; docs/plans/remote-anywhere.md): the relay.
 *
 * The Friday on your computer keeps one connection here (`/home`), with an id and a secret it made itself: no account. Your phone,
 * away from your Wi-Fi, connects to `/reach/<id>`; the relay tells the computer, the computer opens a fresh stream back
 * (`/stream/<n>`) and pipes it into its own phone listener, and the relay joins the two. Inside runs the same TLS as on your Wi-Fi,
 * with the certificate your phone pinned as it paired, so the relay forwards ciphertext and never holds a key: it can't read
 * anything, and can't stand in for your computer. Pairing, device tokens, the listener's list of what a phone may ask, and removal
 * all work exactly as on Wi-Fi, because the listener decides as it always does.
 *
 * Open source with the edition; Friday's hosted service runs it, and anyone can run their own (docs/push-relay.md).
 */

/** What a computer's claim on its id is kept as: the hash of its secret. Memory on a relay of its own, Redis on the hosted one. */
export interface ClaimStore {
  get(id: string): Promise<string | null>;
  set(id: string, hash: string): Promise<unknown>;
}

export function memoryClaims(): ClaimStore {
  const m = new Map<string, string>();
  return { get: async (id) => m.get(id) ?? null, set: async (id, h) => void m.set(id, h) };
}

export interface ReachLimits {
  /** Streams open at once to one computer. */
  streams: number;
  /** Bytes through one computer's streams a day, both ways. */
  bytesPerDay: number;
  /** Tries to reach any computer a minute, from one address. */
  reachesPerMinute: number;
  /** How long a stream may sit with nothing passing before it's closed. */
  idleMs: number;
  /** How long a phone waits for the computer to open its stream. */
  openMs: number;
}

export const REACH_LIMITS: ReachLimits = { streams: 24, bytesPerDay: 4 * 1024 ** 3, reachesPerMinute: 60, idleMs: 15 * 60_000, openMs: 10_000 };

/** Close codes a phone or computer reads. */
export const CLOSE = { offline: 4404, busy: 4429, refused: 4401, idle: 4408, ended: 4000 } as const;

export const ID = /^[0-9a-f]{32}$/;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

interface Home {
  ws: WebSocket;
  streams: number;
  bytes: { day: number; n: number };
}

interface Waiting {
  client: WebSocket;
  held: Buffer[];
  size: number;
  timer: ReturnType<typeof setTimeout>;
}

export class ReachRelay {
  private homes = new Map<string, Home>();
  private waiting = new Map<string, Waiting & { id: string }>();
  private tries = new Map<string, number[]>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  constructor(
    private o: { prefix?: string; claims?: ClaimStore; limits?: Partial<ReachLimits>; log?: (line: string) => void } = {},
  ) {}

  private get prefix() {
    return (this.o.prefix ?? "/api/relay").replace(/\/+$/, "");
  }
  private get limits(): ReachLimits {
    return { ...REACH_LIMITS, ...this.o.limits };
  }
  private claimStore: ClaimStore | null = null;
  private get claims(): ClaimStore {
    return (this.claimStore ??= this.o.claims ?? memoryClaims());
  }

  /** Whether a request is for the relay (so a server hands it here). */
  handles(pathname: string): boolean {
    return pathname.startsWith(`${this.prefix}/home`) || pathname.startsWith(`${this.prefix}/reach/`) || pathname.startsWith(`${this.prefix}/stream/`);
  }

  /** How many computers are linked now, for a health check. */
  get linked(): number {
    return this.homes.size;
  }

  /** An upgrade on one of the relay's paths: the computer's link, a phone reaching it, or the computer's stream for that phone. */
  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, from = req.socket.remoteAddress ?? ""): void {
    void this.route(req, socket, head, from).catch(() => socket.destroy());
  }

  private async route(req: http.IncomingMessage, socket: Duplex, head: Buffer, from: string): Promise<void> {
    const url = new URL(req.url ?? "/", "http://relay");
    const rest = url.pathname.slice(this.prefix.length);
    const id = url.searchParams.get("id") ?? "";
    const accept = (then: (ws: WebSocket) => void) => this.wss.handleUpgrade(req, socket, head, then);
    const refuse = (status: number): void => {
      socket.write(`HTTP/1.1 ${status} ${status === 429 ? "Too Many Requests" : status === 404 ? "Not Found" : "Unauthorized"}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    // A phone, reaching a computer by its id. Limited per address, so ids can't be tried at speed.
    const reach = /^\/reach\/([0-9a-f]{32})$/.exec(rest);
    if (reach) {
      if (!this.allowed(from)) return refuse(429);
      const home = this.homes.get(reach[1]!);
      return accept((client) => this.reach(reach[1]!, home, client));
    }
    // The computer: its id and secret, the first secret for an id claiming it.
    const secret = String(req.headers["x-friday-secret"] ?? "");
    if (!ID.test(id) || secret.length < 32 || !(await this.owns(id, secret))) return refuse(401);
    if (rest === "/home") return accept((ws) => this.home(id, ws));
    const stream = /^\/stream\/([0-9a-f]{24})$/.exec(rest);
    if (stream) return accept((ws) => this.join(id, stream[1]!, ws));
    refuse(404);
  }

  private async owns(id: string, secret: string): Promise<boolean> {
    const hash = sha(`friday-reach:${secret}`);
    const held = await this.claims.get(id);
    if (!held) {
      await this.claims.set(id, hash);
      return true;
    }
    return same(held, hash);
  }

  private allowed(from: string): boolean {
    const now = Date.now();
    const recent = (this.tries.get(from) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.limits.reachesPerMinute) return false;
    this.tries.set(from, [...recent, now]);
    if (this.tries.size > 10_000) this.tries.clear();
    return true;
  }

  /** The computer's link: the newest replaces any before it (the same computer reconnecting). */
  private home(id: string, ws: WebSocket): void {
    const old = this.homes.get(id);
    if (old && old.ws !== ws) old.ws.close(CLOSE.ended, "replaced");
    const home: Home = { ws, streams: old?.streams ?? 0, bytes: old?.bytes ?? { day: dayOf(), n: 0 } };
    this.homes.set(id, home);
    this.o.log?.(`computer ${id.slice(0, 6)}… linked`);
    // Pings both ways keep a quiet link open through proxies and show a dead one.
    const beat = setInterval(() => ws.readyState === WebSocket.OPEN && ws.ping(), 25_000);
    ws.on("close", () => {
      clearInterval(beat);
      if (this.homes.get(id)?.ws === ws) this.homes.delete(id);
    });
    ws.on("error", () => ws.terminate());
    ws.on("message", () => {}); // The computer says nothing on its link but pings.
  }

  /** A phone reaching a computer: told to open a stream, which the phone waits for, its first bytes held meanwhile. */
  private reach(id: string, home: Home | undefined, client: WebSocket): void {
    if (!home || home.ws.readyState !== WebSocket.OPEN) return client.close(CLOSE.offline, "Your computer isn't reachable right now.");
    if (home.streams >= this.limits.streams) return client.close(CLOSE.busy, "Too many connections to this computer.");
    const n = randomBytes(12).toString("hex");
    const waiting: Waiting & { id: string } = {
      id,
      client,
      held: [],
      size: 0,
      timer: setTimeout(() => {
        if (this.waiting.delete(n)) client.close(CLOSE.offline, "Your computer didn't answer.");
      }, this.limits.openMs),
    };
    this.waiting.set(n, waiting);
    client.on("message", (data: RawData) => {
      if (!this.waiting.has(n)) return;
      const b = toBuffer(data);
      waiting.size += b.length;
      if (waiting.size > 256 * 1024) return client.close(CLOSE.busy, "Too much before the computer answered.");
      waiting.held.push(b);
    });
    client.on("close", () => {
      const w = this.waiting.get(n);
      if (w) (clearTimeout(w.timer), this.waiting.delete(n));
    });
    client.on("error", () => client.terminate());
    home.ws.send(JSON.stringify({ open: n }));
  }

  /** The computer's stream for a waiting phone: the two joined, bytes passed as they come, counted against the day. */
  private join(id: string, n: string, stream: WebSocket): void {
    const w = this.waiting.get(n);
    const home = this.homes.get(id);
    if (!w || w.id !== id || !home) return stream.close(CLOSE.offline, "Nobody is waiting for this stream.");
    this.waiting.delete(n);
    clearTimeout(w.timer);
    const client = w.client;
    client.removeAllListeners("message");
    if (client.readyState !== WebSocket.OPEN) return stream.close(CLOSE.ended, "The phone left.");
    home.streams++;
    let idle: ReturnType<typeof setTimeout>;
    const poke = () => {
      clearTimeout(idle);
      idle = setTimeout(() => (client.close(CLOSE.idle, "Idle."), stream.close(CLOSE.idle, "Idle.")), this.limits.idleMs);
    };
    const count = (len: number) => {
      const day = dayOf();
      if (home.bytes.day !== day) home.bytes = { day, n: 0 };
      home.bytes.n += len;
      return home.bytes.n <= this.limits.bytesPerDay;
    };
    const pass = (to: WebSocket, closeBoth: () => void) => (data: RawData) => {
      const b = toBuffer(data);
      poke();
      if (!count(b.length)) return closeBoth();
      if (to.readyState === WebSocket.OPEN) to.send(b, { binary: true });
    };
    let closed = false;
    const end = (code: number = CLOSE.ended) => {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      home.streams = Math.max(0, home.streams - 1);
      if (client.readyState === WebSocket.OPEN) client.close(code);
      if (stream.readyState === WebSocket.OPEN) stream.close(code);
    };
    const over = () => end(CLOSE.busy);
    for (const b of w.held) if (count(b.length)) stream.send(b, { binary: true });
    poke();
    client.on("message", pass(stream, over));
    stream.on("message", pass(client, over));
    client.on("close", () => end());
    stream.on("close", () => end());
    client.on("error", () => end());
    stream.on("error", () => end());
  }

  close(): void {
    for (const h of this.homes.values()) h.ws.terminate();
    for (const w of this.waiting.values()) (clearTimeout(w.timer), w.client.terminate());
    this.homes.clear();
    this.waiting.clear();
    this.wss.close();
  }
}

const dayOf = () => Math.floor(Date.now() / 86_400_000);
function toBuffer(d: RawData): Buffer {
  return Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d);
}
