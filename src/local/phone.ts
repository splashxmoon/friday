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
  /**
   * Another computer's: which Friday install it is (join.ts machineId), so pairing the same one again replaces its row rather
   * than adding one; what it calls itself, its system and the address it last linked from; the Friday version it runs; and the
   * certificate and port it paired with, which say why it can't link when either has changed here (2026-11-04 linking test).
   */
  machine?: string;
  /** Called something of its own in Settings, which a pairing again keeps. */
  named?: true;
  host?: string;
  platform?: string;
  address?: string;
  version?: string;
  fp?: string;
  port?: number;
}

/** What another computer said of itself (computers.ts hello, /phone/hello), kept with its pairing. */
export type DeviceNote = Partial<Pick<Device, "host" | "platform" | "address" | "version">>;

/** What the app hears from the listener about other computers: one paired again under a new id, and one that left. */
export interface PhoneHooks {
  replaced?: (old: string[], now: string) => void;
  forgot?: (id: string) => void;
  /** The Friday version another computer said it runs, as it linked. */
  heard?: (id: string, version: string) => void;
}

export interface PhoneState {
  on: boolean;
  /** Listening now, and where. */
  listening: boolean;
  port: number | null;
  addresses: { address: string; via: "wifi" | "tailscale" }[];
  secure: boolean;
  devices: Omit<Device, "hash">[];
  /** Where another computer reaches this one, open or not (computers.ts): the port it pairs with, the certificate it pins. */
  computers?: { port: number | null; fingerprint: string; addresses: string[] };
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
  // The crew from the phone: away, pause, stop all, lift holds, and a room run on its own or stopped (Arun, 2026-10-31: "so i can
  // watch and manage the crew pages too").
  ["POST", /^\/api\/teammates\/(away|stop-all|pause|lift|selfrun)$/],
  // A session's live feed.
  ["GET", /^\/ws$/],
];

export const phoneAllowed = (method: string, pathname: string): boolean => PHONE_ROUTES.some(([m, re]) => m === method && re.test(pathname));

/** The headers a phone's request is passed on with: its own, less anything that is about who it is or where it came from. */
export function passedHeaders(h: http.IncomingHttpHeaders, appPort: number, device?: Device, from?: string): http.OutgoingHttpHeaders {
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
    // Where it is, for its row in Settings: two of your computers can have the same name.
    if (from) out["x-friday-device-address"] = from.replace(/^::ffff:/, "");
  }
  return out;
}

/** The address a request came from, as a person reads it (no IPv4-in-IPv6 prefix). */
const fromAddress = (a: string | undefined) => (a ?? "").replace(/^::ffff:/, "").slice(0, 64);

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
/** Tries at the port paired computers know, at a start, before saying it is taken: the last Friday may still be letting go of it. */
const PORT_TRIES = 5;

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
  /** Trying again for the port paired computers know, while another program has it. */
  private portRetry: ReturnType<typeof setTimeout> | undefined;
  /** What the app hears about other computers (app.ts sets them). */
  hooks: PhoneHooks = {};

  constructor(
    private o: {
      kv: PhoneKV;
      home: string;
      appPort: number;
      computer: string;
      addresses?: () => { address: string; via: "wifi" | "tailscale" }[];
      /** This computer's names on the network (its .local name, Tailscale's MagicDNS name): a link works when its address changes. */
      names?: () => Promise<string[]>;
      /** This Friday's version, said to another computer as it links (/phone/hello). */
      version?: string;
      /** How long between tries at a taken port (tests make it short). */
      portRetryMs?: number;
      /** A computer removed: its link closed too (computers.ts). */
      onForget?: (id: string) => void;
    },
  ) {}

  private addresses() {
    const all = (this.o.addresses ?? reachable)();
    // Without a certificate, only Tailscale's: plain HTTP over Wi-Fi would show the token to the network.
    return this.secure ? all : all.filter((a) => a.via === "tailscale");
  }

  /** Whether the person let their phone connect: the switch in Settings › Your phone, and nothing else, sets it. */
  private async phoneOn(): Promise<boolean> {
    return (await this.o.kv.get(KEY("on"))) === "1";
  }

  /** Another computer of yours paired here, whose link comes in on this listener (computers.ts). */
  private async hasComputer(): Promise<boolean> {
    return Object.values(await this.o.kv.hgetall(KEY("devices"))).some((v) => (JSON.parse(v) as Device).kind === "computer");
  }

  async state(): Promise<PhoneState> {
    const on = await this.phoneOn();
    const devices = Object.values(await this.o.kv.hgetall(KEY("devices")))
      .map((v) => JSON.parse(v) as Device)
      .map(({ hash: _h, ...d }) => d)
      .sort((a, b) => b.seen - a.seen);
    // Listening for the phone: open for another computer only, it is not (audit REST-1).
    const listening = on && !!this.server;
    const computers = { port: this.port ?? (Number(await this.o.kv.get(KEY("port"))) || null), fingerprint: this.fingerprint, addresses: this.server ? this.addresses().map((a) => a.address) : [] };
    return { on, listening, port: listening ? this.port : null, addresses: listening ? this.addresses() : [], secure: this.secure, devices, computers, ...(this.error ? { error: this.error } : {}) };
  }

  /** Starts it if the person turned it on before, or another computer of theirs links here: Friday opening again keeps both. */
  async resume(): Promise<void> {
    if ((await this.phoneOn()) || (await this.hasComputer())) await this.listen().catch((e) => (this.error = (e as Error).message));
  }

  async setOn(on: boolean): Promise<PhoneState> {
    await this.o.kv.set(KEY("on"), on ? "1" : "0");
    this.error = "";
    if (on) await this.listen().catch((e) => (this.error = (e as Error).message));
    else {
      // The phones go at once, their code with them; the listener stays only while another computer still needs it.
      this.codes.phone = null;
      await this.dropPhones();
      await this.settle();
    }
    return this.state();
  }

  /** The phones' open session sockets, closed: phone access turned off while the listener stays for another computer. */
  private async dropPhones(): Promise<void> {
    const devices = Object.values(await this.o.kv.hgetall(KEY("devices"))).map((v) => JSON.parse(v) as Device);
    for (const d of devices) {
      if (d.kind === "computer") continue;
      for (const s of this.sockets.get(d.id) ?? []) s.destroy();
      this.sockets.delete(d.id);
    }
  }

  /**
   * The listener closed when nothing needs it: phone access off, no other computer paired, and no code for one on screen. Adding
   * a computer opens it without turning phone access on, and cancelling closes it again (audit REST-1, Arun 2026-11-04).
   */
  private async settle(): Promise<void> {
    if (!this.server) return;
    const code = this.codes.computer;
    if ((await this.phoneOn()) || (await this.hasComputer()) || (code && Date.now() < code.until)) return;
    await this.stop();
  }

  /** The computer code on screen, cancelled: it stops working, and the listener closes if it was opened only for it. */
  async dropCode(): Promise<void> {
    this.codes.computer = null;
    await this.settle();
  }

  /**
   * A new code for a phone (or another computer) to pair with, and what its link holds: where to reach this computer and the
   * certificate to trust. A computer's opens the listener as it is asked for, adding one being the person saying so, and leaves
   * phone access as it was: a phone still can't connect unless that is on (audit REST-1).
   */
  async pairCode(kind: "phone" | "computer" = "phone"): Promise<{ code: string; until: number; link: string } | { error: string }> {
    if (kind === "computer" && !this.server) await this.listen().catch((e) => (this.error = (e as Error).message));
    if (kind === "phone" && !(await this.phoneOn())) return { error: "Turn on phone access first." };
    if (!this.server || !this.port) return { error: kind === "computer" ? this.error || "Friday couldn't open a way in for your other computer." : "Turn on phone access first." };
    const addresses = this.addresses();
    if (!addresses.length) return { error: this.secure ? `This computer isn't on a network the ${kind} can reach.` : `That needs Tailscale on this computer and the ${kind}.` };
    const code = Array.from({ length: 8 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join("");
    const c = (this.codes[kind] = { code, until: Date.now() + CODE_TTL_MS, tries: 0 });
    // A computer's code unused when it runs out: the listener closes if it was opened only for it.
    if (kind === "computer") setTimeout(() => void this.settle().catch(() => {}), CODE_TTL_MS + 1000).unref?.();
    // Its names too, after the addresses: a computer that moves to another network, or is given another address, is still
    // found by name, where the addresses alone left the other one reconnecting for good (2026-11-04 linking test).
    const names = kind === "computer" ? await this.names() : [];
    const q = new URLSearchParams({ h: [...addresses.map((a) => a.address), ...names].join(","), p: String(this.port), c: code, s: this.secure ? "https" : "http", n: this.o.computer, ...(this.secure ? { f: this.fingerprint } : {}) });
    return { code, until: c.until, link: `friday://${kind === "computer" ? "computer" : "pair"}?${q}` };
  }

  /** This computer's names on the network, when they can be had (never more than a few, never a hang). */
  private async names(): Promise<string[]> {
    const got = await (this.o.names?.() ?? Promise.resolve([])).catch(() => [] as string[]);
    return [...new Set(got.filter((n) => /^[\w.-]{1,64}$/.test(n)))].slice(0, 3);
  }

  /** A computer's own name for itself, its system, address or version, kept with its pairing (computers.ts, /phone/hello). */
  async note(id: string, patch: DeviceNote): Promise<void> {
    const raw = await this.o.kv.hget(KEY("devices"), id);
    if (!raw) return;
    const d = JSON.parse(raw) as Device;
    const next = { ...d, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => typeof v === "string" && v)), seen: Date.now() };
    await this.o.kv.hset(KEY("devices"), id, JSON.stringify(next));
  }

  /** A computer (or phone) called something else in Settings. */
  async rename(id: string, name: string): Promise<PhoneState> {
    const raw = await this.o.kv.hget(KEY("devices"), id);
    const clean = name.replace(/[^\p{L}\p{N} '’._-]/gu, "").trim().slice(0, 60);
    if (raw && clean) await this.o.kv.hset(KEY("devices"), id, JSON.stringify({ ...(JSON.parse(raw) as Device), name: clean, named: true }));
    return this.state();
  }

  async forget(id: string): Promise<PhoneState> {
    // A computer's install, kept a while after it goes: pairing the same one again gives back what ran on it (app.ts hooks).
    const raw = await this.o.kv.hget(KEY("devices"), id);
    const gone = raw ? (JSON.parse(raw) as Device) : null;
    if (gone?.kind === "computer" && gone.machine) await this.o.kv.hset(KEY("gone"), id, JSON.stringify({ machine: gone.machine, name: gone.name, ...(gone.named ? { named: true } : {}), at: Date.now() }));
    await this.o.kv.hdel(KEY("devices"), id);
    this.o.onForget?.(id);
    this.hooks.forgot?.(id);
    // Removed: its open sockets go too, not only its next request. A computer's a second later, once the link has said "removed"
    // (4002, computers.ts forget) through them: cut at once, it heard only a drop, tried again at a listener that had closed, and
    // said "Friday isn't letting other computers in" for good (2026-11-04 linking test).
    const sockets = [...(this.sockets.get(id) ?? [])];
    this.sockets.delete(id);
    const cut = async () => {
      for (const s of sockets) s.destroy();
      // The last other computer gone, with phone access off: nothing needs the listener.
      await this.settle();
    };
    if (gone?.kind === "computer" && sockets.length) setTimeout(() => void cut().catch(() => {}), 1000).unref?.();
    else await cut();
    return this.state();
  }

  /** A phone (or a computer) giving the code it scanned or was given: its token, once, or nothing. */
  private async pair(code: string, name: string, from: string, kind: "phone" | "computer" = "phone", machine = ""): Promise<{ token: string; id: string } | null> {
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
    const mid = kind === "computer" && /^[0-9a-f]{16,64}$/.test(machine) ? machine : "";
    const device: Device = {
      id,
      name: name.replace(/[^\p{L}\p{N} '’._-]/gu, "").slice(0, 60) || (kind === "computer" ? "Computer" : "Phone"),
      kind,
      hash: sha(token),
      at: now,
      seen: now,
      ...(kind === "computer" ? { address: fromAddress(from), ...(this.fingerprint ? { fp: this.fingerprint } : {}), ...(this.port ? { port: this.port } : {}), ...(mid ? { machine: mid } : {}) } : {}),
    };
    // The same install paired again (added again by SSH, a command, or its app, after a re-pair or a removal): its new pairing
    // takes the old one's place, and what ran on the old one is this one's (app.ts hooks.replaced). Rows used to pile up.
    const old: string[] = [];
    if (mid) {
      const was = await this.o.kv.hgetall(KEY("devices"));
      for (const [k, v] of Object.entries(was)) if ((JSON.parse(v) as Device).machine === mid) (old.push(k), await this.o.kv.hdel(KEY("devices"), k));
      const left = await this.o.kv.hgetall(KEY("gone"));
      for (const [k, v] of Object.entries(left)) if ((JSON.parse(v) as { machine?: string }).machine === mid) (old.push(k), await this.o.kv.hdel(KEY("gone"), k));
      // The name it was given here carries over; its own name is the one it says now.
      const named = [...Object.values(was), ...Object.values(left)].map((v) => JSON.parse(v) as Pick<Device, "machine" | "name" | "named">).find((d) => d.machine === mid && d.named);
      if (named) Object.assign(device, { name: named.name, named: true });
    }
    await this.o.kv.hset(KEY("devices"), id, JSON.stringify(device));
    if (old.length) this.hooks.replaced?.(old, id);
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
    // With a certificate, every interface, since the addresses change as the computer moves between networks, and each request is
    // checked anyway. Without one, Tailscale's address only: plain HTTP on the Wi-Fi would show the token to anyone on it
    // (Security review, 5). False when another program has the port.
    const listenOn = (port: number) =>
      new Promise<boolean>((resolve, reject) => {
        const failed = (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" ? resolve(false) : reject(e));
        server.once("error", failed);
        server.listen(port, host, () => (server.off("error", failed), resolve(true)));
      });
    // Something paired already: the port it knows is the only one that works. Taken (the last Friday still letting go of it, or
    // another program), it is tried again and said, never swapped for another: a random one was saved instead, and every
    // computer and phone paired here was left reconnecting for good, saying nothing (2026-11-04 linking test).
    const paired = !!saved && Object.keys(await this.o.kv.hgetall(KEY("devices"))).length > 0;
    let got = false;
    if (paired) {
      for (let i = 0; i < PORT_TRIES && !got; i++) {
        got = await listenOn(saved);
        if (!got && i < PORT_TRIES - 1) await new Promise((r) => setTimeout(r, Math.min(1000, (this.o.portRetryMs ?? 15_000) / 5)));
      }
      if (!got) {
        clearTimeout(this.portRetry);
        this.portRetry = setTimeout(() => {
          this.portRetry = undefined;
          void this.listen().then(
            () => ((this.error = ""), console.log(`[phone] port ${saved} is free again: your other computers and phones can link`)),
            (e: Error) => (this.error = e.message),
          );
        }, this.o.portRetryMs ?? 15_000);
        this.portRetry.unref?.();
        const why = `Port ${saved}, which your other computers and phone use to reach this one, is taken by another program. Friday keeps trying it, and they link again once it's free.`;
        console.log(`[phone] ${why}`);
        throw new Error(why);
      }
    } else got = (await listenOn(saved || Number(process.env.FRIDAY_PHONE_PORT) || 4390)) || (await listenOn(0)); // FRIDAY_PHONE_PORT: a test rig's own, beside a Friday of yours on 4390
    if (!got) throw new Error("Friday couldn't open a way in for your phone or other computers.");
    this.server = server;
    this.port = (server.address() as net.AddressInfo).port;
    if (this.port !== saved) await this.o.kv.set(KEY("port"), String(this.port));
    // A new certificate while something is paired (its files deleted, or remade): each one pinned the old one and won't link.
    // Said here, and on each computer's row in Settings (app.ts), rather than left as a silent "Reconnecting…".
    const was = await this.o.kv.get(KEY("fp"));
    if (this.fingerprint && was !== this.fingerprint) {
      if (was && paired) console.log("[phone] this computer's certificate is new: your other computers and phones paired before must pair again");
      await this.o.kv.set(KEY("fp"), this.fingerprint);
    }
  }

  async stop(): Promise<void> {
    clearTimeout(this.portRetry);
    this.portRetry = undefined;
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
      const b = (body ? safeJson(body) : null) as { code?: unknown; name?: unknown; kind?: unknown; machine?: unknown } | null;
      const got = typeof b?.code === "string" ? await this.pair(b.code, typeof b.name === "string" ? b.name : "", req.socket.remoteAddress ?? "", b.kind === "computer" ? "computer" : "phone", typeof b.machine === "string" ? b.machine : "") : null;
      if (!got) return end(res, 401, { error: "That code didn't work. Make a new one in Friday on your computer." });
      return end(res, 200, { token: got.token, device: got.id, computer: this.o.computer });
    }
    const device = await this.deviceOf(req);
    if (!device) return end(res, 401, { error: "This phone isn't connected to Friday on this computer. Pair it again." });
    // Open for another computer while phone access is off: a phone is refused (audit REST-1).
    if (device.kind !== "computer" && !(await this.phoneOn())) return end(res, 401, { error: "Phone access is off in Friday on this computer." });
    if (url.pathname === "/phone/hello" && req.method === "GET") return end(res, 200, { computer: this.o.computer, device: device.id });
    // Another computer, once linked: says which Friday it runs, and hears this one's and where this computer is now, so a link
    // whose addresses went stale (another network, a new address) finds it again (join.ts).
    if (url.pathname === "/phone/hello" && req.method === "POST" && device.kind === "computer") {
      const b = safeJson((await readBody(req, 4096).catch(() => "")) || "{}") as { version?: unknown } | null;
      if (typeof b?.version === "string") (await this.note(device.id, { version: b.version.slice(0, 40) }), this.hooks.heard?.(device.id, b.version.slice(0, 40)));
      return end(res, 200, { computer: this.o.computer, device: device.id, ...(this.o.version ? { version: this.o.version } : {}), addresses: [...this.addresses().map((a) => a.address), ...(await this.names())], port: this.port });
    }
    // Stop, on another computer: it is forgotten here too, rather than left as a row that never connects again.
    if (url.pathname === "/phone/leave" && req.method === "POST" && device.kind === "computer") {
      await this.forget(device.id);
      return end(res, 200, { ok: true });
    }
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
    const device = found && (found.kind === "computer" ? COMPUTER_SOCKETS.has(url.pathname) : phoneAllowed("GET", url.pathname) && (await this.phoneOn())) ? found : null;
    if (!device) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    const mine = this.sockets.get(device.id) ?? new Set<net.Socket>();
    this.sockets.set(device.id, mine.add(socket));
    socket.on("close", () => mine.delete(socket));
    const up = net.connect(this.o.appPort, "127.0.0.1", () => {
      const headers = passedHeaders(req.headers, this.o.appPort, device, req.socket.remoteAddress);
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
