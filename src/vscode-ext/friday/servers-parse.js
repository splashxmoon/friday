"use strict";
// The pure parts of the Servers view (servers.js; Arun, 2026-11-19, wave 4: "Dev servers managed… shows its port and logs, and restarts
// it when it crashes."): the words, icons and notices, from what Friday says about a folder's servers (/api/vscode/servers). Tested on their own.

const MAX_TRIES = 3;

const isUp = (s) => s.phase === "running" || s.phase === "starting" || s.phase === "restarting";

/** The few words after the name in the list: ":3000 · running", "restarting, try 2 of 3". */
function describe(s) {
  const port = s.port ? `:${s.port}` : "";
  switch (s.phase) {
    case "running":
      return [port, "running"].filter(Boolean).join(" · ");
    case "starting":
      return [port, "starting…"].filter(Boolean).join(" · ");
    case "restarting":
      return `crashed · restarting, try ${s.tries} of ${MAX_TRIES}`;
    case "crashed":
      return `crashed ${MAX_TRIES} times · stopped`;
    default:
      return s.kind === "compose" ? "docker compose" : s.command || "stopped";
  }
}

/** The icon and colour of a server's row. */
function iconFor(s) {
  switch (s.phase) {
    case "running":
      return { id: "circle-filled", color: "testing.iconPassed" };
    case "starting":
      return { id: "loading~spin", color: "charts.yellow" };
    case "restarting":
      return { id: "sync~spin", color: "charts.yellow" };
    case "crashed":
      return { id: "error", color: "testing.iconFailed" };
    default:
      return { id: "circle-outline" };
  }
}

/**
 * The status bar's words and icon: the first server up as "● :3000 web" (a "+1" for another), one coming back up or crashed said so, and
 * "○ no server" when nothing of this folder is up. A server somebody else started counts as up: the folder has one.
 */
function statusWords(servers, external) {
  const list = servers || [];
  const up = list.filter((s) => s.phase === "running");
  const ext = external || [];
  const more = (n) => (n > 1 ? ` +${n - 1}` : "");
  if (up.length) return { icon: "circle-filled", text: `${up[0].port ? `:${up[0].port} ` : ""}${up[0].name}${more(up.length + ext.length)}`, state: "up" };
  const back = list.filter((s) => s.phase === "restarting" || s.phase === "starting");
  if (back.length) return { icon: back[0].phase === "restarting" ? "sync~spin" : "loading~spin", text: `${back[0].name} ${back[0].phase === "restarting" ? "restarting" : "starting"}${more(back.length)}`, state: "busy" };
  if (ext.length) return { icon: "circle-filled", text: `:${ext[0].port}${more(ext.length)}`, state: "up" };
  const dead = list.filter((s) => s.phase === "crashed");
  if (dead.length) return { icon: "error", text: `${dead[0].name} crashed`, state: "crashed" };
  return { icon: "circle-outline", text: "no server", state: "none" };
}

/** What the status bar shows, to redraw only when it changes. */
function signature(servers, external) {
  return JSON.stringify([(servers || []).map((s) => [s.id, s.phase, s.port, s.tries]), (external || []).map((s) => s.port)]);
}

/**
 * What to tell the person between two looks: a server that has just crashed and is being started again, or has been given up on. `armed`
 * is false for the first look, so a window that opens onto a crashed server says nothing it said before.
 */
function notices(prev, next, armed) {
  if (!armed) return [];
  // Two folders can both have a "dev": a server is told apart by its folder too.
  const k = (s) => `${s.root || ""}\0${s.id}`;
  const was = new Map((prev || []).map((s) => [k(s), s]));
  const out = [];
  for (const s of next || []) {
    const p = was.get(k(s));
    if (s.phase === "restarting" && (!p || p.phase !== "restarting" || p.tries !== s.tries)) out.push({ kind: "restarting", id: s.id, root: s.root, text: `${s.name} crashed. Friday is starting it again (try ${s.tries} of ${MAX_TRIES}).` });
    // A restart that came and went between two looks is still said, from the note Friday leaves.
    else if (s.phase === "running" && p && p.phase !== "running" && /^Back up after/.test(s.note || "")) out.push({ kind: "back", id: s.id, root: s.root, text: `${s.name} is ${String(s.note).replace(/^Back up/, "back up").replace(/\.$/, "")}.` });
    else if (s.phase === "running" && p && p.phase === "running" && s.note !== p.note && /^Back up after/.test(s.note || "")) out.push({ kind: "back", id: s.id, root: s.root, text: `${s.name} is ${String(s.note).replace(/^Back up/, "back up").replace(/\.$/, "")}.` });
    else if (s.phase === "crashed" && p && p.phase !== "crashed") out.push({ kind: "crashed", id: s.id, root: s.root, text: `${s.name} crashed ${MAX_TRIES} times in a row, so Friday stopped starting it again.` });
  }
  return out;
}

/** Seconds to the next look: quick while a server is coming or going, slow when nothing runs. */
function nextDelay(servers) {
  return (servers || []).some((s) => s.phase === "starting" || s.phase === "restarting") ? 1000 : (servers || []).some(isUp) ? 3000 : 6000;
}

/** Log lines for the Output channel: a line each, as Friday kept them. */
const logText = (lines) => (lines || []).map((l) => l.text).join("\n");

module.exports = { MAX_TRIES, isUp, describe, iconFor, statusWords, signature, notices, nextDelay, logText };
