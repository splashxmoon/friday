import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
  /** Whether the computer should be kept awake: the team works while the person is away (app.ts teammates). */
  awake?: () => Promise<boolean>;
  close(): Promise<void>;
}

/** A port on 127.0.0.1 that nothing is listening on: the one asked for when it is free, else whatever the system gives. */
export function freePort(preferred: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number | null>((resolve) => {
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
async function runningOn(home: string): Promise<string | null> {
  const file = path.join(home, "running.json");
  if (!existsSync(file)) return null;
  try {
    const { url, pid } = JSON.parse(readFileSync(file, "utf8")) as { url?: string; pid?: number };
    if (!url || !pid) return null;
    process.kill(pid, 0);
    const r = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? url : null;
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

export async function startLocal(o: { home?: string; port?: number } = {}): Promise<Started> {
  // The local client, built from its own entry (client-build.ts), whatever the environment says.
  process.env.FRIDAY_EDITION = "local";
  const home = path.resolve(o.home || process.env.FRIDAY_HOME || path.join(os.homedir(), ".friday"));
  const running = await runningOn(home);
  if (running) return { url: running, home, already: true, close: async () => {} };

  const kv = await localKV(home);
  /** The key Friday signs its own links with, made once for this computer and kept beside the data. */
  const secretFile = path.join(home, "secret");
  const secret = existsSync(secretFile) ? readFileSync(secretFile, "utf8").trim() : randomBytes(32).toString("base64url");
  if (!existsSync(secretFile)) writeFileSync(secretFile, secret, { mode: 0o600 });
  const name = (() => {
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
  const phone = new PhoneAccess({ kv: kv.redis, home, appPort: port, computer: computerName() });
  // This computer used from another one's Friday (join.ts): a link it holds there, once paired from Settings › Your computers.
  const join = new JoinHub({ kv: kv.redis, name: computerName(), log: (l) => console.log(`[computers] ${l}`) });
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
    dataDir: path.join(home, "uploads"),
    local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name }, phone, outside, join },
  });
  // Turned on before, so on again: the phone stays connected through a restart.
  void phone.resume();
  void join.resume();
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
        await kv.close();
      })()),
  };
}
