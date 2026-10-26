/**
 * Where somebody is looking, shared while they look.
 *
 * Not part of the session: nothing here is written to the log, replayed or kept. It is a few words about where one person's
 * attention is (which panel, which agent, which file and line) sent to the others as it moves, so a teammate can follow along
 * and a diff can show who is reading which line. It goes over the same socket as presence and dies with it.
 */

export interface Focus {
  /** The workbench panel that is open: "tasks", "files", "terminal"… Absent when none is. */
  panel?: string;
  /** The agent whose chat is in front. */
  lane?: string;
  /** A file, and the line in it that the pointer is on or a comment is open on. */
  path?: string;
  line?: number;
}

const PANELS = new Set(["overview", "tree", "files", "terminal", "preview", "usage", "rules", "history"]);
const word = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** What a client said, made safe to hand to everyone else: only known fields, short, and nothing that is not a place. */
export function cleanFocus(raw: unknown): Focus | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: Focus = {};
  const panel = word(r.panel, 20);
  if (PANELS.has(panel)) out.panel = panel;
  const lane = word(r.lane, 40);
  if (lane) out.lane = lane;
  const path = word(r.path, 300).replace(/\\/g, "/");
  // A path inside the folder: no climbing out, no drive letters. It is only ever matched against files the room can already see.
  if (path && !path.split("/").includes("..") && !/^[a-zA-Z]:/.test(path) && !path.startsWith("/")) out.path = path;
  const line = Number(r.line);
  if (out.path && Number.isInteger(line) && line >= 0 && line < 1_000_000) out.line = line;
  return Object.keys(out).length ? out : {};
}

export function sameFocus(a: Focus | undefined | null, b: Focus | undefined | null): boolean {
  return (a?.panel ?? "") === (b?.panel ?? "") && (a?.lane ?? "") === (b?.lane ?? "") && (a?.path ?? "") === (b?.path ?? "") && (a?.line ?? -1) === (b?.line ?? -1);
}

/** Others who are looking at this line of this file, for the marks in a diff. */
export function watchersOf(others: Record<string, { name: string; at: Focus }>, path: string, line: number): { id: string; name: string }[] {
  return Object.entries(others)
    .filter(([, o]) => o.at.path === path && o.at.line === line)
    .map(([id, o]) => ({ id, name: o.name }));
}
