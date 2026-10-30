import { execFile } from "node:child_process";
import { createHash, randomBytes, randomInt, timingSafeEqual, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Your phone, connected to the Friday on this computer (Arun, 2026-10-30: phone access so people stay with Friday, paired over
 * Wi-Fi or Tailscale, nothing through a server of ours).
 *
 * Friday itself answers only 127.0.0.1 and its own page (app.ts localOnly). The phone gets a listener of its own, off until the
 * person turns it on in Settings, on this computer's network addresses. Every request on it must carry a device token, given
 * once to a phone that showed the code on screen, and only what the phone app needs goes through (PHONE_ROUTES): its sessions,
 * their messages, answers and replies, the crew. What passes is handed to Friday from 127.0.0.1 without the phone's token, as
 * Friday's own page would ask it. Nothing that starts a terminal, installs, signs a tool in or opens a preview is reachable.
 *
 * Over Wi-Fi it is HTTPS with a certificate made on this computer, which the phone pins by the fingerprint in the code it
 * scanned: nobody else on the network can read the token or stand in for the computer. Where no certificate can be made
 * (no openssl), it is offered only on Tailscale's addresses, whose traffic Tailscale already encrypts.
 */

export interface PhoneKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  hdel(key: string, field: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
}

export interface Device {
  id: string;
  name: string;
  /** A phone (the app), or another computer of yours whose Friday links here (computers.ts). Absent on a phone paired before. */
  kind?: "phone" | "computer";
  /** SHA-256 of its token: the token itself is never kept. */
  hash: string;
  at: number;
  seen: number;
}

export interface PhoneState {
  on: boolean;
  /** Listening now, and where. */
  listening: boolean;
  port: number | null;
  addresses: { address: string; via: "wifi" | "tailscale" }[];
  secure: boolean;
  devices: Omit<Device, "hash">[];
  error?: string;
}

/** What the phone app calls, by method and path. Everything else is refused before Friday sees it. */
export const PHONE_ROUTES: [string, RegExp][] = [
  ["GET", /^\/api\/me$/],
  ["GET", /^\/api\/version$/],
  ["GET", /^\/api\/sessions\/mine$/],
  ["POST", /^\/api\/sessions\/mine\/forget$/],
  ["GET", /^\/api\/sessions\/search$/],
  ["POST", /^\/api\/sessions$/],
  ["GET", /^\/api\/sessions\/[\w-]{4,40}\/history$/],
  ["POST", /^\/api\/sessions\/[\w-]{4,40}\/(answer|instruct)$/],
  ["POST", /^\/api\/attention$/],
  ["GET", /^\/api\/morning$/],
  ["POST", /^\/api\/board$/],
  ["GET", /^\/api\/(agents|templates|workspace|machines)$/],
  // Which tools and folders are here, for a new session: read only. Never the runner's other calls.
  ["POST", /^\/api\/runner\/(tools|folders)$/],
  ["GET", /^\/api\/teammates(\/since)?$/],
  ["POST", /^\/api\/teammates\/(away|stop-all|pause|lift)$/],
  // A session's live feed.
  ["GET", /^\/ws$/],
];

export const phoneAllowed = (method: string, pathname: string): boolean => PHONE_ROUTES.some(([m, re]) => m === method && re.test(pathname));

/** The headers a phone's request is passed on with: its own, less anything that is about who it is or where it came from. */
export function passedHeaders(h: http.IncomingHttpHeaders, appPort: number, device?: Device): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    if (/^(authorization|cookie|origin|referer|host|forwarded|x-forwarded-.*|x-real-ip|x-friday-.*)$/i.test(k)) continue;
    out[k] = v;
  }
  out.host = `127.0.0.1:${appPort}`;
  // As this computer's own page asks: what the phone may do is the list above, so only that is ever asked this way.
  out["x-friday-local"] = "1";
  // And that it is the phone asking: Friday then refuses it what a phone mustn't do (app.ts PHONE_COMMANDS). The phone's own
  // x-friday-* headers are dropped above, so only this listener can set it, and it only ever takes rights away.
  out["x-friday-via"] = "phone";
  // A computer's link and its agents' runners say which computer it is (computers.ts), as only this listener can.
  if (device?.kind === "computer") {
    out["x-friday-via"] = "computer";
    out["x-friday-device"] = device.id;
    out["x-friday-device-name"] = encodeURIComponent(device.name);
  }
  return out;
}

/**
 * What another computer's Friday reaches here (computers.ts): its link, its agents' runners, and the files a turn's message
 * carries. Nothing a phone reaches, and no page.
 */
export const COMPUTER_SOCKETS = new Set(["/link", "/runner"]);
export const computerAllowed = (method: string, pathname: string): boolean => method === "GET" && /^\/api\/sessions\/[\w-]{4,40}\/files\/[\w-]{1,80}$/.test(pathname);

const KEY = (p: string) => `friday:phone:${p}`;
/** A code to type, from letters nobody misreads, and how long it lasts. */
const CODE_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 10 * 60_000;
/** Wrong codes before the one on screen stops working, and pairings tried a minute from anywhere. */
const CODE_TRIES = 5;
const PAIRS_PER_MINUTE = 10;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sameHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

/** This computer's addresses the phone can reach: its network's, and Tailscale's (100.64.0.0/10) when it is up. */
export function reachable(ifaces = os.networkInterfaces()): { address: string; via: "wifi" | "tailscale" }[] {
  const out: { address: string; via: "wifi" | "tailscale" }[] = [];
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal) continue;
      const [a, b] = i.address.split(".").map(Number) as [number, number];
      if (a === 100 && b >= 64 && b <= 127) out.push({ address: i.address, via: "tailscale" });
      else if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) out.push({ address: i.address, via: "wifi" });
    }
  }
  return out;
}

const run = (cmd: string, args: string[]) => new Promise<void>((resolve, reject) => execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (e) => (e ? reject(e) : resolve())));

/**
 * A certificate made before its curve was named (its key carries the prime field's OID, 1.2.840.10045.1.1): one no phone can
 * use, so it is made again. Phones paired with it never connected, so none loses anything.
 */
export function explicitCurve(certFile: string): boolean {
  try {
    return new X509Certificate(readFileSync(certFile)).raw.includes(Buffer.from("06072a8648ce3d0101", "hex"));
  } catch {
    return false;
  }
}

/** The certificate the listener shows, made once on this computer and kept beside its data. Null where none can be made. */
async function certificate(home: string): Promise<{ key: string; cert: string; fingerprint: string } | null> {
  const keyFile = path.join(home, "phone-key.pem");
  const certFile = path.join(home, "phone-cert.pem");
  if (!existsSync(keyFile) || !existsSync(certFile) || explicitCurve(certFile)) {
    // The curve by name: macOS's own openssl (LibreSSL) otherwise writes the key with the curve's parameters spelled out, which
    // the iPhone's TLS refuses outright (found pairing the app, 2026-10-30: "elliptic curve routines: DECODE_ERROR").
    const args = ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-pkeyopt", "ec_param_enc:named_curve", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "3650", "-subj", "/CN=Friday on this computer"];
    let made = false;
    for (const bin of ["openssl", "/usr/bin/openssl", "/opt/homebrew/bin/openssl"]) {
      try {
        await run(bin, args);
        made = true;
        break;
      } catch {
        // Not there, or too old for these options: the next.
      }
    }
    if (!made) return null;
    // Its key readable by this person only, whatever the umask made it (Security review, 6).
    try {
      chmodSync(keyFile, 0o600);
    } catch {
      // Not on this file system: the folder's own permissions hold.
    }
  }
  try {
    const cert = readFileSync(certFile, "utf8");
    const fingerprint = new X509Certificate(cert).fingerprint256.replace(/:/g, "").toLowerCase();
    return { key: readFileSync(keyFile, "utf8"), cert, fingerprint };
  } catch {
    return null;
  }
}

export class PhoneAccess {
  private server: http.Server | https.Server | null = null;
  private port: number | null = null;
  private secure = false;
  private fingerprint = "";
  private error = "";
  /** The codes on screen now, a phone's and a computer's: what each is, until when, and how many wrong ones it has had. */
  private codes: Record<"phone" | "computer", { code: string; until: number; tries: number } | null> = { phone: null, computer: null };
  /** Pairings tried in the last minute, by the address they came from: one noisy device can't stop the owner pairing. */
  private recent = new Map<string, number[]>();
  /** Starting, while it is: a second turn-on waits for this one rather than opening another listener (Security review, 4). */
  private starting: Promise<void> | null = null;
  /** Each phone's open session sockets, closed when the phone is removed or access turned off (Security review, 2). */
  private sockets = new Map<string, Set<net.Socket>>();
  private seenWrite = new Map<string, number>();

  constructor(private o: { kv: PhoneKV; home: string; appPort: number; computer: string; addresses?: () => { address: string; via: "wifi" | "tailscale" }[]; /** A computer removed: its link closed too (computers.ts). */ onForget?: (id: string) => void }) {}

  private addresses() {
    const all = (this.o.addresses ?? reachable)();
    // Without a certificate, only Tailscale's: plain HTTP over Wi-Fi would show the token to the network.
    return this.secure ? all : all.filter((a) => a.via === "tailscale");
  }

  async state(): Promise<PhoneState> {
    const on = (await this.o.kv.get(KEY("on"))) === "1";
    const devices = Object.values(await this.o.kv.hgetall(KEY("devices")))
      .map((v) => JSON.parse(v) as Device)
      .map(({ hash: _h, ...d }) => d)
      .sort((a, b) => b.seen - a.seen);
    return { on, listening: !!this.server, port: this.port, addresses: this.server ? this.addresses() : [], secure: this.secure, devices, ...(this.error ? { error: this.error } : {}) };
  }

  /** Starts it if the person turned it on before: Friday opening again keeps the phone connected. */
  async resume(): Promise<void> {
    if ((await this.o.kv.get(KEY("on"))) === "1") await this.listen().catch((e) => (this.error = (e as Error).message));
  }

  async setOn(on: boolean): Promise<PhoneState> {
    await this.o.kv.set(KEY("on"), on ? "1" : "0");
    this.error = "";
    if (on) await this.listen().catch((e) => (this.error = (e as Error).message));
    else await this.stop();
    return this.state();
  }

  /**
   * A new code for a phone (or another computer) to pair with, and what its link holds: where to reach this computer and the
   * certificate to trust. A computer's turns the listener on as it is asked for: adding one is the person saying so.
   */
  async pairCode(kind: "phone" | "computer" = "phone"): Promise<{ code: string; until: number; link: string } | { error: string }> {
    if (kind === "computer" && !this.server) {
      await this.o.kv.set(KEY("on"), "1");
      await this.listen().catch((e) => (this.error = (e as Error).message));
    }
    if (!this.server || !this.port) return { error: kind === "computer" ? this.error || "Friday couldn't open a way in for your other computer." : "Turn on phone access first." };
    const addresses = this.addresses();
    if (!addresses.length) return { error: this.secure ? `This computer isn't on a network the ${kind} can reach.` : `That needs Tailscale on this computer and the ${kind}.` };
    const code = Array.from({ length: 8 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join("");
    const c = (this.codes[kind] = { code, until: Date.now() + CODE_TTL_MS, tries: 0 });
    const q = new URLSearchParams({ h: addresses.map((a) => a.address).join(","), p: String(this.port), c: code, s: this.secure ? "https" : "http", n: this.o.computer, ...(this.secure ? { f: this.fingerprint } : {}) });
    return { code, until: c.until, link: `friday://${kind === "computer" ? "computer" : "pair"}?${q}` };
  }

  async forget(id: string): Promise<PhoneState> {
    await this.o.kv.hdel(KEY("devices"), id);
    this.o.onForget?.(id);
    // Removed: its open sockets go too, not only its next request.
    for (const s of this.sockets.get(id) ?? []) s.destroy();
    this.sockets.delete(id);
    return this.state();
  }

  /** A phone (or a computer) giving the code it scanned or was given: its token, once, or nothing. */
  private async pair(code: string, name: string, from: string, kind: "phone" | "computer" = "phone"): Promise<{ token: string; id: string } | null> {
    const now = Date.now();
    const tries = (this.recent.get(from) ?? []).filter((t) => now - t < 60_000);
    if (tries.length >= PAIRS_PER_MINUTE) return null;
    this.recent.set(from, [...tries, now]);
    if (this.recent.size > 1000) this.recent.clear();
    const c = this.codes[kind];
    if (!c || now > c.until) return null;
    if (code.trim().toUpperCase().replace(/[\s-]/g, "") !== c.code) {
      if (++c.tries >= CODE_TRIES) this.codes[kind] = null;
      return null;
    }
    // Used once: a second phone needs a new code.
    this.codes[kind] = null;
    const token = randomBytes(32).toString("base64url");
    const id = randomBytes(8).toString("hex");
    const device: Device = { id, name: name.replace(/[^\p{L}\p{N} '’._-]/gu, "").slice(0, 60) || (kind === "computer" ? "Computer" : "Phone"), kind, hash: sha(token), at: now, seen: now };
    await this.o.kv.hset(KEY("devices"), id, JSON.stringify(device));
    return { token, id };
  }

  /** The phone a request comes from, by the token it carries, or null. */
  private async deviceOf(req: http.IncomingMessage): Promise<Device | null> {
    const token = /^Bearer\s+([\w-]{20,200})$/.exec(String(req.headers.authorization ?? ""))?.[1];
    if (!token) return null;
    const hash = sha(token);
    for (const v of Object.values(await this.o.kv.hgetall(KEY("devices")))) {
      const d = JSON.parse(v) as Device;
      if (sameHex(d.hash, hash)) {
        // When it was last here, for the list in Settings: written at most once a minute.
        if (Date.now() - (this.seenWrite.get(d.id) ?? 0) > 60_000) {
          this.seenWrite.set(d.id, Date.now());
          void this.o.kv.hset(KEY("devices"), d.id, JSON.stringify({ ...d, seen: Date.now() })).catch(() => {});
        }
        return d;
      }
    }
    return null;
  }

  private listen(): Promise<void> {
    if (this.server) return Promise.resolve();
    this.starting ??= this.open().finally(() => (this.starting = null));
    return this.starting;
  }

  private async open(): Promise<void> {
    const tls = await certificate(this.o.home);
    this.secure = !!tls;
    this.fingerprint = tls?.fingerprint ?? "";
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => void this.handle(req, res).catch(() => !res.headersSent && end(res, 500, { error: "Something went wrong." }));
    const server = tls ? https.createServer({ key: tls.key, cert: tls.cert }, handler) : http.createServer(handler);
    server.on("upgrade", (req, socket, head) => void this.upgrade(req, socket as net.Socket, head).catch(() => socket.destroy()));
    const saved = Number(await this.o.kv.get(KEY("port"))) || 0;
    const host = tls ? "0.0.0.0" : (this.addresses()[0]?.address ?? "");
    if (!host) throw new Error("Phone access needs Tailscale on this computer, as it can't make a certificate here.");
    await new Promise<void>((resolve, reject) => {
      const tryOn = (port: number) => {
        server.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" && port !== 0 ? tryOn(0) : reject(e)));
        // With a certificate, every interface, since the addresses change as the computer moves between networks, and each
        // request is checked anyway. Without one, Tailscale's address only: plain HTTP on the Wi-Fi would show the token to
        // anyone on it (Security review, 5).
        server.listen(port, host, () => resolve());
      };
      tryOn(saved || 4390);
    });
    this.server = server;
    this.port = (server.address() as net.AddressInfo).port;
    await this.o.kv.set(KEY("port"), String(this.port));
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.port = null;
    this.codes = { phone: null, computer: null };
    // The phones' open session sockets first: an upgraded socket outlives closeAllConnections, and close() waited on it.
    for (const set of this.sockets.values()) for (const sock of set) sock.destroy();
    this.sockets.clear();
    if (s) await new Promise<void>((resolve) => (s.close(() => resolve()), (s as http.Server).closeAllConnections?.()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://phone");
    res.setHeader("Cache-Control", "no-store");
    // Not a page for a browser: nothing here may be framed or read by one.
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.headers.origin) return end(res, 403, { error: "Phones only." });
    if (req.method === "POST" && url.pathname === "/phone/pair") {
      const body = await readBody(req, 4096).catch(() => null);
      const b = (body ? safeJson(body) : null) as { code?: unknown; name?: unknown; kind?: unknown } | null;
      const got = typeof b?.code === "string" ? await this.pair(b.code, typeof b.name === "string" ? b.name : "", req.socket.remoteAddress ?? "", b.kind === "computer" ? "computer" : "phone") : null;
      if (!got) return end(res, 401, { error: "That code didn't work. Make a new one in Friday on your computer." });
      return end(res, 200, { token: got.token, device: got.id, computer: this.o.computer });
    }
    const device = await this.deviceOf(req);
    if (!device) return end(res, 401, { error: "This phone isn't connected to Friday on this computer. Pair it again." });
    if (url.pathname === "/phone/hello" && req.method === "GET") return end(res, 200, { computer: this.o.computer, device: device.id });
    if (!(device.kind === "computer" ? computerAllowed(req.method ?? "GET", url.pathname) : phoneAllowed(req.method ?? "GET", url.pathname))) return end(res, 404, { error: device.kind === "computer" ? "Not something another computer can do here." : "Not something the phone can do." });
    const fwd = http.request({ host: "127.0.0.1", port: this.o.appPort, method: req.method, path: url.pathname + url.search, headers: passedHeaders(req.headers, this.o.appPort, device) }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    fwd.on("error", () => !res.headersSent && end(res, 502, { error: "Friday on this computer didn't answer." }));
    req.pipe(fwd);
  }

  /** A session's live feed: the same checks, then the socket joined to Friday's own. */
  private async upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", "http://phone");
    const found = req.headers.origin ? null : await this.deviceOf(req);
    // A phone's session feed; a computer's link and its agents' runners (computers.ts).
    const device = found && (found.kind === "computer" ? COMPUTER_SOCKETS.has(url.pathname) : phoneAllowed("GET", url.pathname)) ? found : null;
    if (!device) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    const mine = this.sockets.get(device.id) ?? new Set<net.Socket>();
    this.sockets.set(device.id, mine.add(socket));
    socket.on("close", () => mine.delete(socket));
    const up = net.connect(this.o.appPort, "127.0.0.1", () => {
      const headers = passedHeaders(req.headers, this.o.appPort, device);
      const lines = [`GET ${url.pathname}${url.search} HTTP/1.1`, ...Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}: ${x}`)), "", ""];
      up.write(lines.join("\r\n"));
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    // Either end closing closes the other: a phone gone (removed, access off, out of range) leaves no socket to Friday open.
    const close = () => (up.destroy(), socket.destroy());
    up.on("error", close);
    socket.on("error", close);
    up.on("close", close);
    socket.on("close", close);
  }
}

function end(res: http.ServerResponse, status: number, body: object) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
function readBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        req.destroy();
        return reject(new Error("too large"));
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
