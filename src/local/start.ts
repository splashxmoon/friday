import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createApp } from "../app.js";
import { localKV } from "./kv.js";
import { NO_MODELS } from "./no-models.js";
import { outsideToken, writeOutsideShim } from "./outside-mcp.js";
import { PhoneAccess } from "./phone.js";
import { relayBase } from "./reach.js";
import { JoinHub } from "./join.js";
import { Nearby } from "./nearby.js";
import { endTools } from "../runner/spawn-cli.js";

/**
 * Starting Friday on this computer, for the command (main.ts) and the desktop app (desktop.ts) alike.
 *
 * One Friday per folder: it keeps everything in one file, and two writing it would each throw the other's work away. So a
 * running one leaves its address beside the data (`running.json`), and a second start, from either, is handed that address
 * to open instead of starting another. Before that address is there (a Friday still starting), or while it doesn't answer, the
 * lock file taken first thing (`friday.lock`, takeLock) turns a second start away with FridayAlreadyOpen.
 */

/**
 * Another Friday has this data folder and isn't answering at its address yet (still starting, or stuck). Thrown by startLocal so
 * the desktop app can say "Friday is already open" and the command can say so and exit, rather than both writing one folder.
 */
export class FridayAlreadyOpen extends Error {
  readonly code = "FRIDAY_ALREADY_OPEN";
  constructor(
    readonly home: string,
    /** The other Friday's process. */
    readonly pid: number,
  ) {
    super(`Friday is already open, using ${home} (process ${pid}). Close that one first, or wait a moment for it to finish starting.`);
    this.name = "FridayAlreadyOpen";
  }
}

/** When this computer last started, to the second: a lock from before then is stale whatever its pid (pids start over at boot). */
const bootedAt = () => Math.round(Date.now() / 1000 - os.uptime());
/** Whether a process is running. One we may not signal (another user's) is running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * This data folder's lock: `<home>/friday.lock`, made with an exclusive create and holding this process's pid and the boot it is
 * in. One whose process has gone, or from before this computer last started, is taken over; one held by a running Friday throws
 * FridayAlreadyOpen. Only the open-source edition's store takes it (startLocal): the desktop app's runner shares ~/.friday but never
 * opens data.json, so it never takes or waits on this. Returns the way to let it go.
 */
export async function takeLock(home: string): Promise<() => void> {
  const file = path.join(home, "friday.lock");
  const mine = JSON.stringify({ pid: process.pid, boot: bootedAt(), at: Date.now() });
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      try {
        writeSync(fd, mine);
      } finally {
        closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // Only ours: one taken over after this process was thought gone is the other's now.
        try {
          if (readFileSync(file, "utf8") === mine) rmSync(file, { force: true });
        } catch {
          // Already gone.
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    type Held = { pid?: unknown; boot?: unknown } | null;
    let held: Held = null;
    let text = "";
    try {
      text = readFileSync(file, "utf8");
      held = JSON.parse(text) as Held;
    } catch {
      held = null;
    }
    const pid = Number(held?.pid);
    if (!held || !Number.isInteger(pid) || pid <= 0) {
      // Being written this moment (made, not yet filled): given a moment. Left that way for seconds, it is a crash's: taken over.
      const age = (() => {
        try {
          return Date.now() - statSync(file).mtimeMs;
        } catch {
          return 0;
        }
      })();
      if (age < 3000) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
    } else if (alive(pid) && Math.abs(Number(held.boot) - bootedAt()) < 120) throw new FridayAlreadyOpen(home, pid);
    // Stale: its process has gone (or it is from before a restart). Taken over only if it is still the one read, so two starts
    // taking over the same stale lock don't both think they have it.
    try {
      if (readFileSync(file, "utf8") === text) rmSync(file, { force: true });
    } catch {
      // Gone meanwhile: try again.
    }
  }
  throw new Error(`Friday couldn't take ${file}. Delete it if no other Friday is open, and start again.`);
}

export interface Started {
  url: string;
  home: string;
  /** Another Friday was already running on this folder: this is its address, and nothing was started. */
  already?: boolean;
  /** That other Friday's process, when `already`. */
  pid?: number;
  /** Whether the computer should be kept awake: the team works while the person is away (app.ts teammates). */
  awake?: () => Promise<boolean>;
  /**
   * Done bringing back what was going when Friday last closed. That happens after the server listens, in the background: startLocal
   * resolves as soon as the page can be loaded (spec 13, Arun 2026-11-24: "Go all out and fix these problems").
   */
  restored?: Promise<void>;
  close(): Promise<void>;
}

/** Whether something answers on this address and port. */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect({ host, port });
    const done = (yes: boolean) => (c.destroy(), resolve(yes));
    c.setTimeout(500, () => done(false));
    c.once("connect", () => done(true));
    c.once("error", () => done(false));
  });
}

/**
 * A port on 127.0.0.1 that nothing is listening on: the one asked for when it is free, else whatever the system gives.
 * Free means nothing answers there either, at 127.0.0.1 or ::1: a Mac lets 127.0.0.1 be bound beside a server on ::1 or on
 * every address, and 4321 is also Astro's dev server's, on "localhost" (::1). Friday then shared its port, and its previews
 * at http://localhost:4321 reached the other server.
 */
export function freePort(preferred: number): Promise<number> {
  const tryPort = async (port: number) =>
    port > 0 && (await Promise.all([answers("127.0.0.1", port), answers("::1", port)])).some(Boolean)
      ? null
      : new Promise<number | null>((resolve) => {
          const s = net.createServer();
          s.once("error", () => resolve(null));
          s.listen(port, "127.0.0.1", () => {
            const got = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(got));
          });
        });
  return tryPort(preferred).then((p) => p ?? tryPort(0).then((q) => q ?? preferred));
}

/** The Friday already running on this folder, if its address still answers as Friday. */
async function runningOn(home: string): Promise<{ url: string; pid: number } | null> {
  const file = path.join(home, "running.json");
  if (!existsSync(file)) return null;
  try {
    const { url, pid } = JSON.parse(readFileSync(file, "utf8")) as { url?: string; pid?: number };
    if (!url || !pid) return null;
    process.kill(pid, 0);
    const r = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? { url, pid } : null;
  } catch {
    return null;
  }
}

/** A command's output, or "" if it fails or takes more than two seconds. Never holds the server up while it runs. */
const outputOf = (bin: string, args: string[]) => new Promise<string>((resolve) => execFile(bin, args, { encoding: "utf8", timeout: 2000, windowsHide: true }, (e, out) => resolve(e ? "" : String(out).trim())));

/**
 * What the phone calls this computer: its own name, as the system has it ("Maya's MacBook Pro"), else its host name. Asked once,
 * and alongside the rest of starting: each command asked in turn held the start up (git alone, through macOS's /usr/bin/git, was
 * 70 ms some starts).
 */
let nameRead: Promise<string> | null = null;
function computerName(): Promise<string> {
  return (nameRead ??= (async () => (process.platform === "darwin" ? (await outputOf("scutil", ["--get", "ComputerName"])).slice(0, 60) : "") || os.hostname().replace(/\.local$/, "").slice(0, 60) || "This computer")());
}

/** The name git has for the person ("Maya Chen"), else their login: the page said "Good morning, mchen" (2026-11-02 walk-through). */
async function personName(): Promise<string> {
  const git = (await outputOf("git", ["config", "--global", "user.name"])).slice(0, 60);
  if (git) return git;
  try {
    return os.userInfo().username || "You";
  } catch {
    return "You";
  }
}

/**
 * This computer's names on the network, for a link another computer keeps (phone.ts pairCode): its .local name, which follows it
 * to any network where the two see each other, and its Tailscale (MagicDNS) name when Tailscale is on. Read once, a few seconds
 * at most; none where they can't be had.
 */
let namesRead: Promise<string[]> | null = null;
export function networkNames(): Promise<string[]> {
  const run = (bin: string, args: string[]) => new Promise<string>((resolve) => execFile(bin, args, { timeout: 3000, windowsHide: true }, (e, out) => resolve(e ? "" : String(out))));
  return (namesRead ??= (async () => {
    const out: string[] = [];
    const local = process.platform === "darwin" ? (await run("scutil", ["--get", "LocalHostName"])).trim() : os.hostname().replace(/\.local$/i, "");
    if (/^[\w-]{1,60}$/.test(local)) out.push(`${local}.local`);
    for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
      const raw = await run(bin, ["status", "--json"]);
      if (!raw) continue;
      try {
        const dns = String((JSON.parse(raw) as { Self?: { DNSName?: unknown } }).Self?.DNSName ?? "").replace(/\.$/, "");
        if (/^[\w.-]{1,64}$/.test(dns)) out.push(dns);
      } catch {
        // Not JSON: no Tailscale name.
      }
      break;
    }
    return out;
  })());
}

/** This Friday's version (its package.json), said to another computer as they link. */
function fridayVersion(): string {
  try {
    return String((JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown }).version ?? "");
  } catch {
    return "";
  }
}

export async function startLocal(o: { home?: string; port?: number; /** A link from another computer's Settings › Your computers: this one is paired with it, once (add-computer.ts). */ join?: string; /** Removed or turned away there for good: what to do (a service exits, so it isn't started again). */ onGone?: () => void; /** Whether the person is using this computer now (the desktop app): their phone isn't notified then. */ atComputer?: () => boolean; /** For a test: bringing back what was going waits for this. */ restoreAfter?: Promise<unknown> } = {}): Promise<Started> {
  // The local client, built from its own entry (client-build.ts), whatever the environment says.
  process.env.FRIDAY_EDITION = "local";
  const home = path.resolve(o.home || process.env.FRIDAY_HOME || path.join(os.homedir(), ".friday"));
  const running = await runningOn(home);
  if (running) return { url: running.url, pid: running.pid, home, already: true, close: async () => {} };
  // One Friday per folder, first thing, before anything in it is read or written (two once wrote over each other's work).
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const unlock = await takeLock(home);
  // Asked now, answered while the store is read.
  const names = Promise.all([personName(), computerName()]);

  let kv: Awaited<ReturnType<typeof localKV>>;
  try {
    kv = await localKV(home);
  } catch (e) {
    unlock();
    throw e;
  }
  /** The key Friday signs its own links with, made once for this computer and kept beside the data. */
  const secretFile = path.join(home, "secret");
  // One cut short (the computer went off as it was first written) is made again: an empty key would sign everything.
  const kept = existsSync(secretFile) ? readFileSync(secretFile, "utf8").trim() : "";
  const secret = kept.length >= 16 ? kept : randomBytes(32).toString("base64url");
  if (secret !== kept) writeFileSync(secretFile, secret, { mode: 0o600 });
  const [name, thisComputer] = await names;

  // Agents outside Friday reach it through a script beside the data, with a token only this person can read (outside-mcp.ts).
  const outside = { token: outsideToken(home), shim: writeOutsideShim(home) };

  const port = await freePort(o.port ?? Number(process.env.PORT ?? 4321));
  const url = `http://127.0.0.1:${port}`;
  // Your phone (phone.ts): its own listener, off until turned on in Settings, handing what it may ask to this server.
  const version = fridayVersion();
  const phone = new PhoneAccess({ kv: kv.redis, home, appPort: port, computer: thisComputer, names: networkNames, version, relay: relayBase(process.env) });
  // This computer used from another one's Friday (join.ts): a link it holds there, once paired from Settings › Your computers.
  // Known there by this install's own id (from its secret, so the same each time and nobody else's): pairing it again replaces its row.
  const machineId = createHash("sha256").update(`friday-machine:${secret}`).digest("hex").slice(0, 32);
  const join = new JoinHub({ kv: kv.redis, name: thisComputer, log: (l) => console.log(`[computers] ${l}`), machineId, version, ...(o.onGone ? { onGone: o.onGone } : {}) });
  // Your other Fridays on this network, found and offered a link in two clicks (nearby.ts). FRIDAY_NEARBY_PORT(S): two on one computer.
  const nearbyPorts = (process.env.FRIDAY_NEARBY_PORTS ?? "").split(",").map(Number).filter((n) => n > 0 && n < 65536);
  const myName = thisComputer;
  const nearby = new Nearby({ id: machineId, name: () => process.env.FRIDAY_MACHINE_NAME || myName, version, pairedWith: () => join.hubCertificate(), ...(Number(process.env.FRIDAY_NEARBY_PORT) > 0 ? { port: Number(process.env.FRIDAY_NEARBY_PORT) } : {}), ...(nearbyPorts.length ? { ask: nearbyPorts } : {}), log: (l) => console.log(`[computers] ${l}`) });
  await nearby.start();
  const app = await createApp({
    port,
    // Friday at 127.0.0.1, where the runner it starts connects back too; previews at localhost, which a browser counts as another
    // origin, so a previewed page's scripts can't call Friday's API as Friday's own page (app.ts localOnly) and that address
    // answers previews only.
    appUrl: url,
    previewOrigin: `http://localhost:${port}`,
    redisUrl: "",
    prefix: "friday:",
    secret,
    driverGraceMs: 15_000,
    llm: NO_MODELS,
    // Project memory (brain.ts): each finished run read by the coding tool that did it, on this computer, for what it taught.
    decisionLog: true,
    dataDir: path.join(home, "uploads"),
    local: { redis: kv.redis, sub: kv.sub, saves: kv.saves, user: { id: "local", name }, ...(o.atComputer ? { atComputer: o.atComputer } : {}), ...(o.restoreAfter ? { restoreAfter: o.restoreAfter } : {}), phone, outside, join, nearby, models: path.join(home, "models"),
      backdrops: path.join(home, "backdrops"), // Backdrops (backdrops.ts).
      // The coding tools on this computer kept up to date, a while after it starts and every six hours (tool-updates.ts).
      toolUpdates: true,
    },
  }).catch(async (e: unknown) => {
    // Not started: the folder is let go of, so the next try isn't turned away by this one.
    nearby.stop();
    await kv.close().catch(() => {});
    unlock();
    throw e;
  });
  // Turned on before, so on again: the phone stays connected through a restart.
  void phone.resume();
  // Started to be another computer's extra machine (`--join`): paired with that link the first time, and the pairing it keeps
  // held after that (a service restarting). A link it wasn't paired with (added again by SSH or a command, after a removal
  // there) pairs anew, replacing the pairing kept: it used to be skipped for the old one, which was refused, so the service
  // stopped for good while setup said it was done (2026-11-04 linking test).
  if (o.join && !(await join.pairedWith(o.join))) {
    const got = await join.join(o.join);
    console.log(!got.error && got.hub ? `[computers] paired with ${got.hub.name}` : `[computers] couldn't pair: ${got.error ?? "no answer"}`);
    // Not paired: the pairing it had, if it still holds, is kept.
    if (got.error) void join.resume();
  } else void join.resume();
  const runningFile = path.join(home, "running.json");
  writeFileSync(runningFile, JSON.stringify({ url, pid: process.pid }), { mode: 0o600 });

  let closed: Promise<void> | null = null;
  return {
    url,
    home,
    awake: () => app.teammates.awake(),
    restored: app.restored,
    close: () =>
      (closed ??= (async () => {
        rmSync(runningFile, { force: true });
        await phone.stop().catch(() => {});
        nearby.stop();
        join.stop();
        // Saved as it closes: the desktop app gives all of this five seconds (desktop.ts), and the store used to be written last,
        // after the coding tools' three, so a slow close lost the last changes. Written right after the app has closed (which marks
        // each run a restart cut off, to carry on next time: hub.ts instructions.requeued), and halfway through a close that is
        // slow, before the tools are stopped; then once more at the very end, if stopping them changed anything.
        const late = setTimeout(() => void kv.flush(), 2500);
        await app.close().catch(() => {});
        clearTimeout(late);
        await kv.flush();
        // The coding tools told to stop, given three seconds to, then killed: none outlives Friday (spawn-cli.ts endTools).
        await endTools(3000);
        await kv.close();
        unlock();
      })()),
  };
}
