import { stepKind } from "./run-strip.js";

/**
 * One stretch of an agent's work, said as one line the way Claude says it: "Ran 2 commands, read 3 files". Each part is a
 * kind of step in the order it first happened; a single file or page is named instead of counted. The line opens to show
 * every step (Response.tsx, StepGroup).
 */
type StepLike = { mark: string; verb: string; target?: string; state?: string };

const secs = (s: number) => (s < 60 ? `${s}s` : `${Math.round(s / 60)}m`);
const n = (count: number, one: string, many: string) => (count === 1 ? one : `${count} ${many}`);
/** A step still under way, said as such: "Running npm test", never "Ran". */
const DOING: Record<string, string> = { Ran: "Running", Read: "Reading", Listed: "Listing", Searched: "Searching", "Searched the web": "Searching the web", Edited: "Editing", Wrote: "Writing", Opened: "Opening", Noted: "Noting", Planned: "Planning", Used: "Using" };
const doingVerb = (verb: string) => DOING[verb] ?? `${verb}…`;

export function stepsSummary(all: StepLike[], thoughtSecs = 0): string {
  if (!all.length) return thoughtSecs > 0 ? `Thought for ${secs(thoughtSecs)}` : "Thought";
  // A step that never ran (still waiting on an approval, or stopped before it) isn't something the agent did: it is counted
  // after the sentence, not in it, so "Ran a command" never stands for a command nobody let run.
  const notRun = all.filter((s) => s.state === "waiting").length;
  // A step still running isn't done either: it is left out of the sentence, and alone it is the whole line.
  const running = all.filter((s) => s.state === "running");
  const steps = all.filter((s) => s.state !== "waiting" && s.state !== "running");
  if (!steps.length && running.length) return `${doingVerb(running[0]!.verb)}${running[0]!.target ? ` ${running[0]!.target}` : ""}`;
  if (!steps.length) return `${n(notRun, "A step", "steps")} didn't run`;
  // Each kind collects what it touched, in the order the kinds first turned up.
  const kinds = new Map<string, string[]>();
  for (const s of steps) {
    const k = s.verb === "Searched the web" ? "web" : s.verb === "Opened" ? "open" : stepKind(s) === "test" ? "run" : stepKind(s) === "other" ? `other:${s.verb}` : stepKind(s);
    kinds.set(k, [...(kinds.get(k) ?? []), s.target ?? ""]);
  }
  const parts: string[] = [];
  for (const [k, targets] of kinds) {
    const files = [...new Set(targets.filter(Boolean))];
    const c = targets.length;
    if (k === "read") parts.push(files.length === 1 ? `Read ${files[0]}` : `Read ${n(files.length || c, "a file", "files")}`);
    else if (k === "edit") parts.push(files.length === 1 ? `Edited ${files[0]}` : `Edited ${n(files.length || c, "a file", "files")}`);
    else if (k === "run") parts.push(`Ran ${n(c, "a command", "commands")}`);
    else if (k === "search") parts.push(c === 1 ? "Searched the code" : `Searched the code ${c} times`);
    else if (k === "web") parts.push(c === 1 ? "Searched the web" : `Searched the web ${c} times`);
    else if (k === "open") parts.push(files.length === 1 ? `Opened ${files[0]}` : `Opened ${n(c, "a page", "pages")}`);
    else if (k === "ask") parts.push("Asked a question");
    else parts.push(k.startsWith("other:") ? k.slice(6) : k);
  }
  // Three parts read as a sentence; past that it is a list, so the rest are counted.
  const shown = parts.length > 3 ? [...parts.slice(0, 3), `${parts.length - 3} more`] : parts;
  const line = shown.map((p, i) => (i === 0 ? p : p.charAt(0).toLowerCase() + p.slice(1))).join(", ");
  const failed = steps.filter((s) => s.state === "failed").length;
  return [line, failed ? `${failed} failed` : "", notRun ? `${notRun} didn't run` : ""].filter(Boolean).join(" · ");
}
