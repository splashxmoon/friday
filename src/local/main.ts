/**
 * Friday on your own computer (the open-source edition).
 *
 * Your coding agents (Claude Code, Codex, Cursor and the rest you have installed) side by side, in one place, on this computer.
 * Nothing hosted and no account: the server is this process, answering only this computer's own browser; what it keeps is in
 * one folder (FRIDAY_HOME, else ~/.friday); and the work runs on your tools' own plans. Friday's own models aren't part of it.
 *
 *   npx friday-local            start it and open it in your browser
 *   PORT=4321 FRIDAY_HOME=…     where it listens, and where it keeps things
 *   --no-open                   don't open the browser
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createApp } from "../app.js";
import { localKV } from "./kv.js";
import { NO_MODELS } from "./no-models.js";

// The local client, built from its own entry (client-build.ts), whatever the environment says.
process.env.FRIDAY_EDITION = "local";
const home = path.resolve(process.env.FRIDAY_HOME || path.join(os.homedir(), ".friday"));
const kv = await localKV(home);

/** The key Friday signs its own links with, made once for this computer and kept beside the data. */
function localSecret(): string {
  const file = path.join(home, "secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const s = randomBytes(32).toString("base64url");
  writeFileSync(file, s, { mode: 0o600 });
  return s;
}

const port = Number(process.env.PORT ?? 4321);
const name = (() => {
  try {
    return os.userInfo().username || "You";
  } catch {
    return "You";
  }
})();

const appUrl = `http://127.0.0.1:${port}`;
const app = await createApp({
  port,
  // Friday at 127.0.0.1, where the runner it starts connects back too; previews at localhost, which a browser counts as another
  // origin, so a previewed page's scripts can't call Friday's API as Friday's own page (app.ts localOnly) and that address
  // answers previews only.
  appUrl,
  previewOrigin: `http://localhost:${port}`,
  redisUrl: "",
  prefix: "friday:",
  secret: localSecret(),
  driverGraceMs: 15_000,
  llm: NO_MODELS,
  dataDir: path.join(home, "uploads"),
  local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name } },
});

console.log(`Friday is running at ${appUrl}`);
console.log(`Kept in ${home}. Stop with Ctrl+C.`);

if (!process.argv.includes("--no-open") && process.env.FRIDAY_NO_OPEN !== "1") {
  const open = process.platform === "darwin" ? ["open", [appUrl]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", appUrl]] : ["xdg-open", [appUrl]];
  try {
    spawn(open[0] as string, open[1] as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    // No browser to open: the address above is enough.
  }
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    await app.close().catch(() => {});
    await kv.close();
    process.exit(0);
  });
}
