import { ENGINE_NAMES, type EngineTool } from "../../types.js";

/**
 * Race in Code's column (Arun, 2026-11-19, wave 2: "Race the tools: the same ask to two or three coding tools at once, compare, keep
 * the best"). The engine is Agents' own (Race.tsx: a lane per racer in a checkout of its own, scored by race-score.ts); this is the
 * part that is Code's: who races by default, what a row says, and what Compare asks the IDE to open.
 */

/** Two to three: a column is 280-640px wide, and each racer is a copy of the folder and a tool running. */
export const RACE_MIN = 2;
export const RACE_MAX = 3;

/**
 * Who races when the person has not picked: the tool the box is on first, then the others they have signed in, up to three. Fewer
 * than two are ready: whoever there is (the button says it takes two).
 */
export function defaultRacers(ready: EngineTool[], current: EngineTool | ""): EngineTool[] {
  const first = current && ready.includes(current) ? [current] : [];
  return [...first, ...ready.filter((t) => t !== current)].slice(0, RACE_MAX);
}

/** The picks as they stand once one is toggled: kept in the order they were made, never more than three. */
export function toggleRacer(picked: EngineTool[], tool: EngineTool): EngineTool[] {
  if (picked.includes(tool)) return picked.filter((t) => t !== tool);
  return picked.length >= RACE_MAX ? picked : [...picked, tool];
}

/** The race's chat, named for its tab: what was asked, with a mark that it is a race. */
export function raceTitle(ask: string): string {
  const line = ask.trim().split("\n")[0]!.trim();
  return `Race: ${line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line || "the tools"}`;
}

/** "Claude Code, Codex and Cursor": the racers in words. */
export function racerNames(tools: EngineTool[]): string {
  const names = tools.map((t) => ENGINE_NAMES[t]);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** A run's time, short: "42s", "3m 05s". */
export function raceTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Tokens, short: "820", "3.4k", "21k". Null for a tool on its owner's own plan, which doesn't say. */
export function raceTokens(n: number | null): string {
  if (n === null) return "";
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k tokens` : `${n} tokens`;
}

/**
 * What a racer's row says under its name, as short facts: its changes, its tests, how long it took and what it used. "Not run" for
 * tests is left out while it works (nothing has been asked of it yet).
 */
export function raceFacts(r: { files: number; added: number; removed: number; tests: "pass" | "fail" | "none"; seconds: number; tokens: number | null; working: boolean }): string[] {
  const out = [r.files ? `${r.files} file${r.files === 1 ? "" : "s"} +${r.added} −${r.removed}` : r.working ? "No changes yet" : "No changes"];
  if (r.tests === "pass") out.push("Tests passed");
  else if (r.tests === "fail") out.push("Tests failed");
  else if (!r.working) out.push("Tests not run");
  if (r.seconds > 0) out.push(raceTime(r.seconds));
  const t = raceTokens(r.tokens);
  if (t) out.push(t);
  return out;
}

/** What Compare sends the IDE: that racer's checkout, the folder's branch it forked from, and a name for the diff's tab. */
export function compareDetail(dir: string, base: string | undefined, racer: string): { dir: string; base?: string; label: string } {
  return { dir, ...(base ? { base } : {}), label: `Race · ${racer}` };
}

/** Where the kept racer's changes landed, in a line: "Kept Claude Code. 2 files are in the folder." */
export function keptNote(name: string, files: number, conflicts: number): string {
  const n = `${files} file${files === 1 ? "" : "s"}`;
  return conflicts ? `Kept ${name}. ${n} are in the folder; ${conflicts} ${conflicts === 1 ? "has" : "have"} conflict marks to settle.` : `Kept ${name}. ${n} ${files === 1 ? "is" : "are"} in the folder.`;
}

/** The line after Keep when the log already says how many files came over: which tool, and that the other copies are gone. */
export function keptShort(name: string): string {
  return `Kept ${name}. The other copies are gone.`;
}
