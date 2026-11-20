import { checkpointsByMessage, isSetAside, reversedBy, rewindsIn } from "../../rewind.js";
import { originOf } from "../../session/patches.js";
import { ENGINE_NAMES, MAIN_LANE, type EngineTool, type SessionEvent } from "../../types.js";
import { api } from "../api.js";
import type { Identity } from "../storage.js";

/**
 * Rewinding a Code chat from the IDE's column (Arun, 2026-11-19, wave 4: "Rewind an agent run: go back to before any message of a Code
 * chat, files and all, and redo if you change your mind"). The checkpoints and the rewind itself are the session's own (src/rewind.ts,
 * the `folder.restore` command): nothing new is saved. These are the words and the sums the column puts on top of them, kept apart from
 * the screen so they can be tested.
 */

/** A turn of the chat that can be gone back to: your message, when you said it, and what the agent did to files after it. */
export interface Turn {
  seq: number;
  lane: string;
  text: string;
  ts: number;
  /** Files the agent (or you, by hand) changed from this message until the next one. */
  files: number;
  checkpoint: string;
}

/** What you said, as a person's message (not the session's own notes to its agent). */
function said(e: SessionEvent): string | null {
  return e.body.type === "instruction" && e.actor.kind === "human" && !e.body.text.startsWith("[session]") ? e.body.text : null;
}

/** A logged file as the change sets keep it: where its patch is kept (patches.ts), and its text when this page has it. */
interface Held {
  origin: number;
  patch: string;
}

/**
 * What the folder looked like to the session just before `before` on `lane`: the agent's last change set (each file by where its
 * patch is kept). A change set is the folder against where the session began, not one run's, and one is said again after every undo or
 * rewind, so two of them compared say what changed between them, rewinds and all. A page that opens a chat is sent only the lane's
 * latest change set whole; older ones arrive without their text (patches.ts lightener), so files are told apart by where their patch
 * is kept, as Activity's samePatch() does, and only else by their text.
 */
function diffAt(events: SessionEvent[], lane: string, before: number): Map<string, Held> {
  const out = new Map<string, Held>();
  const d = events.findLast((e) => e.seq < before && e.body.type === "agent.diff" && (e.lane ?? MAIN_LANE) === lane);
  if (d?.body.type === "agent.diff") for (const f of d.body.files) out.set(f.path, { origin: f.later ?? originOf(f, d.seq), patch: f.patch });
  return out;
}

/** The paths that differ between two change sets (changed, added or gone). */
function differing(a: Map<string, Held>, b: Map<string, Held>): Set<string> {
  const out = new Set<string>();
  const same = (x: Held, y: Held) => x.origin === y.origin || (!!x.patch && x.patch === y.patch);
  for (const [p, v] of a) {
    const w = b.get(p);
    if (!w || !same(v, w)) out.add(p);
  }
  for (const p of b.keys()) if (!a.has(p)) out.add(p);
  return out;
}

/** Files edited by hand in a stretch of the log. */
function editedIn(events: SessionEvent[], from: number, to: number): string[] {
  return events.flatMap((e) => (e.seq >= from && e.seq < to && e.body.type === "folder.edited" ? [e.body.path] : []));
}

/**
 * Where a message's turn ran in the log: from the run it started (the one its checkpoint is of, so a message queued while another run
 * went is the next run's, not this one's) to the end of that run. A message with no run has the message itself as its start.
 */
function windowOf(events: SessionEvent[], e: SessionEvent): { start: number; end: number } {
  const lane = e.lane ?? MAIN_LANE;
  const run = events.find((x) => x.seq > e.seq && (x.lane ?? MAIN_LANE) === lane && x.body.type === "run.started");
  if (!run) return { start: e.seq, end: Infinity };
  const ended = events.find((x) => x.seq > run.seq && (x.lane ?? MAIN_LANE) === lane && x.body.type === "run.ended");
  return { start: run.seq, end: ended ? ended.seq + 1 : Infinity };
}

/** Every file changed from this message on: what a rewind to before it would put back (the agent's, and what you edited by hand). */
export function filesFrom(events: SessionEvent[], seq: number): string[] {
  const m = events.find((e) => e.seq === seq);
  const lane = m?.lane ?? MAIN_LANE;
  const start = m ? windowOf(events, m).start : seq;
  const out = differing(diffAt(events, lane, start), diffAt(events, lane, Infinity));
  editedIn(events, seq, Infinity).forEach((p) => out.add(p));
  return [...out].sort();
}

/** The turns of a chat that have a checkpoint, newest first. A rewind of Friday's own agent sets some aside: they are not offered again. */
export function turnsOf(events: SessionEvent[]): Turn[] {
  const marks = checkpointsByMessage(events);
  const rs = rewindsIn(events);
  const turns: Turn[] = [];
  for (const e of events) {
    if (said(e) === null) continue;
    const lane = e.lane ?? MAIN_LANE;
    const checkpoint = marks.get(e.seq);
    if (!checkpoint || isSetAside(rs, e.seq, lane)) continue;
    const w = windowOf(events, e);
    const changed = differing(diffAt(events, lane, w.start), diffAt(events, lane, w.end));
    editedIn(events, e.seq, w.end).forEach((p) => changed.add(p));
    turns.push({ seq: e.seq, lane, text: said(e)!, ts: e.ts, files: changed.size, checkpoint });
  }
  return turns.reverse();
}

/** A rewind that still stands, until the next message: how many files it put back, and what a redo goes back to. */
export interface Rewound {
  seq: number;
  lane: string;
  files: number;
  /** The folder as it was just before the rewind, which a redo puts back. Absent when the rewind can't be redone. */
  undo?: string;
}

/**
 * The rewind the chat is standing on now, or null: the last one, while nobody has sent a message since and it has not been redone.
 * A coding tool's rewind (its conversation stays) can be redone; Friday's own agent's, which sets the conversation aside, cannot,
 * so it is said but offers no Redo.
 */
export function rewoundNow(events: SessionEvent[]): Rewound | null {
  const r = events.findLast((e) => e.body.type === "folder.restored" && (e.body.rewoundTo !== undefined || e.body.whole === true) && reversedBy(events, e) === undefined);
  if (!r || r.body.type !== "folder.restored") return null;
  const lane = r.lane ?? MAIN_LANE;
  if (events.some((e) => e.seq > r.seq && (e.lane ?? MAIN_LANE) === lane && said(e) !== null)) return null;
  // Followed through its reversals: a redo of it, and an undo of that redo, which stands rewound again. The last of the chain is
  // what a Redo reverses, and an odd number of reversals means the folder is not rewound now.
  let last: SessionEvent = r;
  let depth = 0;
  for (let next = events.find((e) => e.seq > last.seq && e.body.type === "folder.restored" && reversedBy(events, e)?.seq === last.seq); next; next = events.find((e) => e.seq > last.seq && e.body.type === "folder.restored" && reversedBy(events, e)?.seq === last.seq)) {
    last = next;
    depth++;
  }
  if (depth % 2 === 1 || last.body.type !== "folder.restored") return null;
  return { seq: r.seq, lane, files: last.body.restored + last.body.removed, ...(r.body.rewoundTo === undefined ? { undo: last.body.undo } : {}) };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Names for a sentence: the first few, then how many more. */
function list(names: string[], max = 3): string {
  const shown = names.slice(0, max).map((n) => n.split("/").pop() || n);
  return names.length > max ? `${shown.join(", ")} and ${names.length - max} more` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : (shown[0] ?? "");
}

/**
 * What the confirm says: how many files go back, whether the agent forgets, whether it can be redone, and any unsaved edits that stay.
 * `exact` is when the folder itself was asked what differs from the checkpoint: a coding tool's rewind puts back every file that
 * differs, the person's own saved edits included, so those are named as theirs (`mine`). Otherwise only the agent's change sets are
 * known, and it says that what the person changed since goes back too.
 */
export function rewindConfirm(o: { files: string[]; dirty: string[]; tool?: EngineTool | undefined; exact?: boolean; mine?: string[] }): { title: string; body: string; action: string } {
  const n = o.files.length;
  const mine = o.mine ?? [];
  let back: string;
  if (!n) back = "The files go back to how they were";
  else if (o.exact) back = `${plural(n, "file")} ${n === 1 ? "goes back to how it was" : "go back to how they were"}`;
  else back = `${plural(n, "file")} the agent changed ${n === 1 ? "goes back to how it was" : "go back to how they were"}`;
  const yours = mine.length ? ` ${mine.length === 1 ? "One is yours" : `${mine.length} are yours`}: ${list(mine)}, which you saved since.` : o.exact || !o.tool ? "" : " Anything you saved yourself since goes back too.";
  const rest = o.tool
    ? `${ENGINE_NAMES[o.tool]} keeps its own conversation, so it still remembers what came after. Your message goes back in the box to change and send again, and you can redo this until you send it.`
    : "The agent forgets everything after it. The log keeps all of it, and this can't be redone.";
  const unsaved = o.dirty.length
    ? ` You have unsaved edits in ${list(o.dirty)}. They stay in the editor as they are, and saving them asks whether to keep yours or the rewound file.`
    : "";
  return { title: "Rewind to before this message?", body: `${back} before this message was acted on.${yours} ${rest}${unsaved}`, action: "Rewind to here" };
}

/** A path as a comparison key: forward slashes, and, for a Windows drive path, lower case (the drive's letter and the disk's names don't tell cases apart). */
const key = (p: string) => {
  const f = p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(f) ? f.toLowerCase() : f;
};

/** A path under a folder, as an absolute path: `root` is where `rel` is relative to. */
export const absolute = (root: string, rel: string): string => (/^([a-z]:)?\//i.test(rel.replace(/\\/g, "/")) ? rel : `${root.replace(/[\\/]+$/, "")}/${rel.replace(/\\/g, "/")}`);

/**
 * The unsaved files (absolute paths, as the IDE says them) that the rewind would touch: those among the files going back (absolute
 * too), or, when those aren't known, every unsaved file.
 */
export function touchedDirty(dirty: string[], files: string[]): string[] {
  const going = new Set(files.map(key));
  return dirty.filter((p) => !going.size || going.has(key(p)));
}

/** What the IDE has unsaved right now, as absolute paths, as its extension(s) last said (src/vscode-dirty.ts); nothing when it can't be asked. */
export async function unsavedInIde(identity: Identity | null | undefined): Promise<string[]> {
  if (!identity) return [];
  try {
    const r = await api<{ files?: string[] }>(identity, "/api/vscode/dirty");
    return Array.isArray(r.files) ? r.files.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/**
 * What the folder holds that differs from a checkpoint right now, which is what a coding tool's rewind puts back, the person's own
 * saved edits among it (the runner's diff op, read-only). Null when the folder can't be asked: the caller then says it only knows the
 * agent's part. `root` is the repository's top, which the paths are relative to.
 */
export async function folderDiffers(sid: string, invite: string, lane: string, checkpoint: string, dir?: string): Promise<{ root: string; paths: string[] } | null> {
  try {
    const q = `op=diff&lane=${encodeURIComponent(lane)}&invite=${encodeURIComponent(invite)}&ref=${encodeURIComponent(checkpoint)}${dir ? `&dir=${encodeURIComponent(dir)}` : ""}`;
    const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/repo?${q}`, { credentials: "same-origin" });
    if (!r.ok) return null;
    const j = (await r.json()) as { output?: string };
    const out = JSON.parse(j.output ?? "null") as { root?: string; files?: { path: string }[]; error?: string } | null;
    if (!out || out.error || !Array.isArray(out.files) || typeof out.root !== "string") return null;
    return { root: out.root, paths: out.files.map((f) => f.path) };
  } catch {
    return null;
  }
}

/** When a turn was, in a menu row: the time today, the day and time before. */
export function turnWhen(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return now - ts < 20 * 3_600_000 && new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** A turn's second line in the menu: when, and how many files it changed. */
export const turnSub = (t: Turn, now = Date.now()): string => `${turnWhen(t.ts, now)} · ${t.files ? plural(t.files, "file") : "no files"}`;

/** A turn's name in a menu row: the first line of what you said, cut short. */
export function turnLabel(text: string, max = 44): string {
  const t = (text.split("\n").find((l) => l.trim()) ?? text).trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t || "Untitled";
}
