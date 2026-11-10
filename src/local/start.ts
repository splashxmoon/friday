import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createApp } from "../app.js";
import { localKV } from "./kv.js";
import { NO_MODELS } from "./no-models.js";
import { outsideToken, writeOutsideShim } from "./outside-mcp.js";
import { PhoneAccess } from "./phone.js";
import { JoinHub } from "./join.js";
import { endTools } from "../runner/spawn-cli.js";

/**
 * Starting Friday on this computer, for the command (main.ts) and the desktop app (desktop.ts) alike.
 *
 * One Friday per folder: it keeps everything in one file, and two writing it would each throw the other's work away. So a
 * running one leaves its address beside the data (`running.json`), and a second start, from either, is handed that address
 * to open instead of starting another.
 */

export interface Started {
  url: string;
  home: string;
  /** Another Friday was already running on this folder: this is its address, and nothing was started. */
  already?: boolean;
  /** That other Friday's process, when `already`. */
  pid?: number;
  /** Whether the computer should be kept awake: the team works while the person is away (app.ts teammates). */
  awake?: () => Promise<boolean>;
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

/** What the phone calls this computer: its own name, as the system has it ("Maya's MacBook Pro"), else its host name. */
function computerName(): string {
  try {
    if (process.platform === "darwin") {
      const n = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim();
      if (n) return n.slice(0, 60);
    }
  } catch {
    // The host name, then.
  }
  return os.hostname().replace(/\.local$/, "").slice(0, 60) || "This computer";
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

export async function startLocal(o: { home?: string; port?: number; /** A link from another computer's Settings › Your computers: this one is paired with it, once (add-computer.ts). */ join?: string; /** Removed or turned away there for good: what to do (a service exits, so it isn't started again). */ onGone?: () => void } = {}): Promise<Started> {
  // The local client, built from its own entry (client-build.ts), whatever the environment says.
  process.env.FRIDAY_EDITION = "local";
  const home = path.resolve(o.home || process.env.FRIDAY_HOME || path.join(os.homedir(), ".friday"));
  const running = await runningOn(home);
  if (running) return { url: running.url, pid: running.pid, home, already: true, close: async () => {} };

  const kv = await localKV(home);
  /** The key Friday signs its own links with, made once for this computer and kept beside the data. */
  const secretFile = path.join(home, "secret");
  // One cut short (the computer went off as it was first written) is made again: an empty key would sign everything.
  const kept = existsSync(secretFile) ? readFileSync(secretFile, "utf8").trim() : "";
  const secret = kept.length >= 16 ? kept : randomBytes(32).toString("base64url");
  if (secret !== kept) writeFileSync(secretFile, secret, { mode: 0o600 });
  // The name git has for the person ("Maya Chen"), else their login: the page said "Good morning, mchen" (2026-11-02 walk-through).
  const name = (() => {
    try {
      const git = execFileSync("git", ["config", "--global", "user.name"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (git) return git.slice(0, 60);
    } catch {
      // No git, or no name set in it.
    }
    try {
      return os.userInfo().username || "You";
    } catch {
      return "You";
    }
  })();

  // Agents outside Friday reach it through a script beside the data, with a token only this person can read (outside-mcp.ts).
  const outside = { token: outsideToken(home), shim: writeOutsideShim(home) };

  const port = await freePort(o.port ?? Number(process.env.PORT ?? 4321));
  const url = `http://127.0.0.1:${port}`;
  // Your phone (phone.ts): its own listener, off until turned on in Settings, handing what it may ask to this server.
  const version = fridayVersion();
  const phone = new PhoneAccess({ kv: kv.redis, home, appPort: port, computer: computerName(), names: networkNames, version });
  // This computer used from another one's Friday (join.ts): a link it holds there, once paired from Settings › Your computers.
  // Known there by this install's own id (from its secret, so the same each time and nobody else's): pairing it again replaces its row.
  const machineId = createHash("sha256").update(`friday-machine:${secret}`).digest("hex").slice(0, 32);
  const join = new JoinHub({ kv: kv.redis, name: computerName(), log: (l) => console.log(`[computers] ${l}`), machineId, version, ...(o.onGone ? { onGone: o.onGone } : {}) });
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
    local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name }, phone, outside, join, models: path.join(home, "models"),
    },
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
    close: () =>
      (closed ??= (async () => {
        rmSync(runningFile, { force: true });
        await phone.stop().catch(() => {});
        join.stop();
        await app.close().catch(() => {});
        // The coding tools told to stop, given three seconds to, then killed: none outlives Friday (spawn-cli.ts endTools).
        await endTools(3000);
        await kv.close();
      })()),
  };
}
