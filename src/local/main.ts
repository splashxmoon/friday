/**
 * Friday on your own computer (the open-source edition), from a terminal.
 *
 * Your coding agents (Claude Code, Codex, Cursor and the rest you have installed) side by side, in one place, on this computer.
 * Nothing hosted and no account: the server is this process, answering only this computer's own browser; what it keeps is in
 * one folder (FRIDAY_HOME, else ~/.friday); and the work runs on your tools' own plans. Friday's own models aren't part of it.
 * The desktop app (desktop.ts) starts the same thing in a window of its own.
 *
 *   npx github:splashxmoon/friday   start it and open it in your browser
 *   PORT=4321 FRIDAY_HOME=…         where it listens, and where it keeps things
 *   --no-open                       don't open the browser
 */
import { spawn } from "node:child_process";
import { startLocal } from "./start.js";

const friday = await startLocal();
console.log(friday.already ? `Friday is already running at ${friday.url}` : `Friday is running at ${friday.url}`);
if (!friday.already) console.log(`Kept in ${friday.home}. Stop with Ctrl+C.`);

if (!process.argv.includes("--no-open") && process.env.FRIDAY_NO_OPEN !== "1") {
  const open = process.platform === "darwin" ? ["open", [friday.url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", friday.url]] : ["xdg-open", [friday.url]];
  try {
    spawn(open[0] as string, open[1] as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    // No browser to open: the address above is enough.
  }
}
if (friday.already) process.exit(0);

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    await friday.close();
    process.exit(0);
  });
}
