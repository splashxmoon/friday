import { createHash, createSign } from "node:crypto";
import http from "node:http";
import http2 from "node:http2";
import type { ReachRelay } from "./reach-relay.js";

/**
 * Friday's push service for the open-source edition, open itself (Arun, 2026-11-12: "this is for the open source build").
 *
 * Apple delivers a notification to the Friday iPhone app only when it is signed with the key of whoever builds that app. The
 * Friday on your computer can't hold that key, so it seals each notification for your phone (local/phone-push.ts) and hands the
 * sealed bytes here; this asks Apple to deliver "Friday" plus them, and the phone opens them. Nothing here can read them, keeps
 * them, or needs an account. Friday's hosted service runs this (app.ts), and anyone can run their own: `npm run push-relay` with
 * the Apple key of the app they build, and FRIDAY_PUSH_RELAY pointed at it (docs/push-relay.md).
 */

export interface PushConfig {
  key: string;
  keyId: string;
  teamId: string;
  topic: string;
}

/** Off until the Apple key is set: APNS_KEY (the .p8 file's text), APNS_KEY_ID, APNS_TEAM_ID, and APNS_TOPIC (the app's bundle id). */
export function pushConfigFromEnv(env: NodeJS.ProcessEnv): PushConfig | null {
  const key = env.APNS_KEY?.replace(/\\n/g, "\n").trim();
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  const topic = env.APNS_TOPIC?.trim() || "com.tryfridaywork.friday";
  return key && keyId && teamId ? { key, keyId, teamId, topic } : null;
}

/** Where a notification goes: Apple's token for the phone, and whether it is a debug (sandbox) or release build. */
export interface Device {
  token: string;
  env: "production" | "sandbox";
}

/** Sends one notification; resolves to Apple's status (0 when Apple didn't answer). Replaced in tests. */
export type SendOne = (c: PushConfig, d: Device, jwt: string, payload: Record<string, unknown>) => Promise<number>;

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** The provider token Apple asks for: an ES256 JWT, good for up to an hour, so made again every 50 minutes. */
export function providerToken(c: PushConfig, now = Date.now()): string {
  const head = b64(JSON.stringify({ alg: "ES256", kid: c.keyId }));
  const body = b64(JSON.stringify({ iss: c.teamId, iat: Math.floor(now / 1000) }));
  const sig = createSign("SHA256").update(`${head}.${body}`).sign({ key: c.key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64(sig)}`;
}

/** What Apple is given for a sealed notification: "Friday", the sealed bytes, and the flag that wakes the phone's extension. */
export function sealedPayload(sealed: string, level: "time-sensitive" | "active", thread: string): Record<string, unknown> {
  return {
    aps: { alert: { title: "Friday", body: "Something needs you" }, "mutable-content": 1, sound: "default", "interruption-level": level, ...(thread ? { "thread-id": thread } : {}) },
    s: sealed,
  };
}

/** How many times a key has been counted this hour (the limits): Redis on the hosted service, memory when run on its own. */
export type Counter = (key: string) => Promise<number>;

/** Counts in memory, by the hour: for a relay run on its own. */
export function memoryCounter(): Counter {
  let hour = -1;
  const counts = new Map<string, number>();
  return async (key) => {
    const now = Math.floor(Date.now() / 3_600_000);
    if (now !== hour) (hour = now), counts.clear();
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n;
  };
}

/** A notification an hour per phone, and per sender, at most. */
export const PER_PHONE = 120;
export const PER_SENDER = 1_000;

export class PushRelay {
  private token: { value: string; at: number } | null = null;

  constructor(
    private config: PushConfig | null,
    private count: Counter = memoryCounter(),
    private sendOne: SendOne = apns,
  ) {}

  get on(): boolean {
    return !!this.config;
  }

  /**
   * One sealed notification, passed to Apple as it came. Resolves to Apple's status: 200 delivered, 410 the phone's token is gone,
   * 400 not a notification this relays, 429 over the limit, 503 no Apple key here.
   */
  async relay(d: Device, sealed: string, level: "time-sensitive" | "active", thread: string, from: string): Promise<number> {
    if (!this.config) return 503;
    if (!/^[0-9a-f]{32,200}$/i.test(d.token) || !/^[\w-]{40,4000}$/.test(sealed) || !/^[\w-]{0,40}$/.test(thread)) return 400;
    const hour = Math.floor(Date.now() / 3_600_000);
    const phone = createHash("sha256").update(d.token).digest("hex").slice(0, 24);
    if ((await this.count(`phone:${phone}:${hour}`)) > PER_PHONE || (await this.count(`from:${from.slice(0, 64)}:${hour}`)) > PER_SENDER) return 429;
    const payload = sealedPayload(sealed, level, thread);
    let status = await this.sendOne(this.config, d, this.jwt(), payload).catch(() => 0);
    // A build installed from Xcode is signed for development whatever its configuration, so its token is the sandbox's: Apple says
    // 400 to it in production. Tried once in the other place.
    if (status === 400) {
      const retry = await this.sendOne(this.config, { token: d.token, env: d.env === "production" ? "sandbox" : "production" }, this.jwt(), payload).catch(() => 0);
      status = retry === 0 ? status : retry;
    }
    return status;
  }

  /** The relay's answer to an HTTP request's body, as the computer reads it. */
  async answer(body: unknown, from: string): Promise<{ status: number; body: { ok: boolean } }> {
    const b = (body && typeof body === "object" ? body : {}) as { token?: unknown; env?: unknown; sealed?: unknown; level?: unknown; thread?: unknown };
    const status = await this.relay(
      { token: String(b.token ?? ""), env: b.env === "sandbox" ? "sandbox" : "production" },
      String(b.sealed ?? ""),
      b.level === "time-sensitive" ? "time-sensitive" : "active",
      String(b.thread ?? ""),
      from,
    );
    return { status: [200, 400, 410, 429, 503].includes(status) ? status : 502, body: { ok: status === 200 } };
  }

  private jwt(): string {
    if (!this.token || Date.now() - this.token.at > 50 * 60_000) this.token = { value: providerToken(this.config!), at: Date.now() };
    return this.token.value;
  }
}

/** One notification over HTTP/2 to Apple. A session per call: pushes are rare enough that keeping one open isn't worth it. */
export function apns(c: PushConfig, d: Device, jwt: string, payload: Record<string, unknown>): Promise<number> {
  const host = d.env === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  return new Promise((resolve) => {
    const client = http2.connect(host);
    client.on("error", () => resolve(0));
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${d.token}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": c.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    });
    let status = 0;
    req.on("response", (h) => (status = Number(h[":status"] ?? 0)));
    req.on("end", () => (client.close(), resolve(status)));
    req.on("error", () => (client.close(), resolve(0)));
    req.setTimeout(10_000, () => (req.close(), client.close(), resolve(0)));
    req.end(JSON.stringify(payload));
    req.resume();
  });
}

/**
 * The relay on its own: one route, POST /api/push/relay (the path Friday's hosted service answers it at, so FRIDAY_PUSH_RELAY
 * reads the same either way), and GET /healthz. Behind a proxy, the sender's address is the first X-Forwarded-For when
 * TRUST_PROXY is set.
 */
export function relayServer(relay: PushRelay, o: { trustProxy?: boolean; reach?: ReachRelay } = {}): http.Server {
  const fromOf = (req: http.IncomingMessage) => (o.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim() : "") || req.socket.remoteAddress || "";
  const server = http.createServer((req, res) => {
    const send = (status: number, body: object) => (res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }), res.end(JSON.stringify(body)));
    if (req.method === "GET" && req.url === "/healthz") return send(200, { ok: true, push: relay.on, ...(o.reach ? { linked: o.reach.linked } : {}) });
    if (req.method !== "POST" || req.url !== "/api/push/relay") return send(404, { error: "Not found" });
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 8_192) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return send(400, { error: "Not JSON." });
      }
      void relay.answer(body, fromOf(req)).then((a) => send(a.status, a.body), () => send(502, { ok: false }));
    });
  });
  // Reaching computers from anywhere (reach-relay.ts), on the same port.
  server.on("upgrade", (req, socket, head) => {
    const p = new URL(req.url ?? "/", "http://relay").pathname;
    if (o.reach?.handles(p)) o.reach.upgrade(req, socket, head, fromOf(req));
    else socket.destroy();
  });
  return server;
}
