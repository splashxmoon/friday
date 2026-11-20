/**
 * Refactor across the codebase (Arun, 2026-11-19: "rename a concept, move a module, change an API — the agent plans every file
 * first, you approve, it does them all and shows one review"): what the agent is asked first (a plan, in Plan, nothing touched),
 * how its plan is read (the chat draws it as a card), what "Go ahead" says back, and how its closing line is read.
 */

/** The fence the agent ends its plan with: read by the chat (RefactorPlanCard). */
export const PLAN_FENCE = "friday-plan";
/** The fence it ends the work with: a short "Done: N files, checks passed" line, and the IDE's review opens. */
export const DONE_FENCE = "friday-refactor-done";

export interface PlanFile {
  path: string;
  change: string;
}
export interface RefactorPlan {
  summary: string;
  files: PlanFile[];
  risks: string[];
  checks: string[];
}

const PLAN_FORMAT = `End your answer with one fenced block, \`\`\`${PLAN_FENCE}, holding one JSON object: {"summary": one line on what changes, "files": [{"path": the file's path from the folder's root, "change": one plain line on what changes in it}], "risks": [short lines on what could go wrong], "checks": [the commands that would show it still works]}. List every file the change touches (the definition, every use, the tests, the docs, the config), one object each. Write the plan in your reply itself, as text: don't hand it to a plan tool or ExitPlanMode, since the person only sees what is in your reply.`;

const HOW = `Plan this change across the whole codebase before anything is touched. Look through it for everything the change reaches. Don't change anything yet: I'll read the plan and say go ahead. ${PLAN_FORMAT}`;

/**
 * Asked first, in the box or from the IDE ("Friday: Refactor across the codebase…"). Worded so the agent reads as a reader
 * (smartReach: "don't change anything" puts it in Plan, where the folder can't change under it) until the plan is approved.
 */
export function refactorAsk(change: string, symbol = ""): string {
  const what = change.trim();
  const title = what ? `Refactor: ${what.length > 44 ? `${what.slice(0, 43)}…` : what}` : "Refactor across the codebase";
  const from = symbol && !what.includes(symbol) ? ` It starts from \`${symbol}\`.` : "";
  // Ends in one full stop, never two: "Rename the API." was said as "…the API..".
  return `${title}\n\n${HOW}\n\nWhat to change: ${what.replace(/[\s.!?;:,]+$/, "")}.${from}\n`;
}

/** The starter's words, for the box (the person finishes the last line, then sends it). */
export const REFACTOR_STARTER = `Refactor across the codebase\n\n${HOW}\n\nWhat to change: `;

// Worded as work to do, and with no "don't … commit" in it: smartReach reads that as hands-off and keeps the agent in Plan, which
// cannot change a file. "Run the checks" puts it where commands run from the start.
/**
 * What a revision of the plan starts with (the card's "Change the plan" puts it in the box, the person adds the change). Worded so
 * smartReach reads it as hands-off ("don't change any files" wins over everything else), because what is typed after it ("also
 * include the docs folder", "add the legacy imports too") says nothing clear on its own and would put the agent back in Auto, with
 * the whole plan still unapproved. Asks for the block again, so the revision comes back as a card.
 */
export const REVISE_LEAD = `Change the plan (don't change any files yet, and end with the new ${PLAN_FENCE} block): `;

/** What "Go ahead" says: do the plan, run its checks, leave the commit. It is what switches the agent out of Plan. */
export const GO_AHEAD_ASK = `Go ahead with the plan. Change every file it lists (and any other that turns out to need it, saying which), run its checks and fix what they catch. Leave the commit to me. End with a \`\`\`${DONE_FENCE} block: {"files": how many files you changed, "checks": "passed" | "failed" | "none", "note": one line on what to look at first}.`;

/** Whether a message is a plan card's "Go ahead" (the chat says it as one short line). */
export const isGoAhead = (text: string) => text.startsWith("Go ahead with the plan.");

const cap = (v: unknown, n: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, n) : "");
const lines = (v: unknown, max: number, n: number): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    // A check may come as a command or as {command}/{name}; anything else is let go.
    const s = cap(typeof x === "object" && x ? ((x as Record<string, unknown>).command ?? (x as Record<string, unknown>).name) : x, n);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
};

/** A path as the folder knows it: slashes forward, no leading "./". */
const cleanPath = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** The plan in a fence's JSON, or null when it isn't one (an unfinished or broken block is drawn as plain code instead). */
export function parsePlan(text: string): RefactorPlan | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.files)) return null;
  const files: PlanFile[] = [];
  for (const x of o.files) {
    const path = cleanPath(cap(typeof x === "string" ? x : (x as Record<string, unknown> | null)?.path, 400));
    if (!path) continue;
    const change = typeof x === "object" && x ? cap((x as Record<string, unknown>).change, 400) : "";
    // The same file named twice is one row: its changes read together.
    const same = files.find((f) => f.path === path);
    if (same) {
      if (change && !same.change.includes(change)) same.change = same.change ? `${same.change}; ${change}` : change;
    } else files.push({ path, change });
    if (files.length >= 300) break;
  }
  if (!files.length) return null;
  return { summary: cap(o.summary, 400), files, risks: lines(o.risks, 12, 400), checks: lines(o.checks, 12, 300) };
}

export interface RefactorDone {
  files: number;
  checks: "passed" | "failed" | "none";
  note: string;
}

/** Whether the agent's own words about its checks say they passed, failed, or nothing: failure wins ("2 failed, 10 passed"). */
function checksSaid(v: unknown): RefactorDone["checks"] {
  if (v === true) return "passed";
  if (v === false) return "failed";
  const c = (typeof v === "string" ? v : typeof v === "object" && v ? JSON.stringify(v) : "").toLowerCase().replace(/\b(0|no|zero) (failed|failures?)\b|\bwithout fail\w*/g, "");
  if (/fail|not pass|didn'?t pass|\bred\b/.test(c)) return "failed";
  if (/\bnone\b|not run|no checks|skipped/.test(c)) return "none";
  return /pass|\bok\b|green|success|true/.test(c) ? "passed" : "none";
}

/** The closing block's JSON, or null when it isn't one. Agents are loose with it, so the files may be a count or a list. */
export function parseDone(text: string): RefactorDone | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const n = Array.isArray(o.files) ? o.files.length : typeof o.files === "number" ? o.files : typeof o.files === "string" && o.files.trim() ? Number(o.files) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return { files: Math.min(Math.floor(n), 9999), checks: checksSaid(o.checks), note: cap(o.note, 300) };
}

/** What Friday itself saw of the run: the files it changed and the tests it saw run, when it has them. */
export interface RunSeen {
  files: number | null;
  tests: "pass" | "fail" | null;
  /** The run is still going: what Friday will see isn't known yet, so no claim about the checks is made. */
  pending?: boolean;
}

/**
 * The closing line, from what the agent said and what Friday saw (Arun, 2026-11-19: "shows one review"): the number of files is
 * Friday's own when it has one, and the checks are said as fact only when Friday saw them run; otherwise they are the agent's
 * word, said as its claim underneath, so the line never contradicts the "Done · unverified" beside it.
 */
export function doneSummary(d: RefactorDone, seen?: RunSeen | null): { title: string; claim: string } {
  const files = seen?.files != null && seen.files > 0 ? seen.files : d.files;
  const n = `${files} file${files === 1 ? "" : "s"}`;
  if (seen?.tests) return { title: `Done: ${n}, checks ${seen.tests === "pass" ? "passed" : "failed"}`, claim: "" };
  // Nothing Friday knows (no run around the line): the agent's line as it said it.
  if (!seen) return { title: doneLine({ ...d, files }), claim: "" };
  if (seen.pending) return { title: `Done: ${n}`, claim: "" };
  // Nothing Friday could see run: what it says it ran is its claim.
  return { title: `Done: ${n}`, claim: d.checks === "none" ? "No checks run" : `It says its checks ${d.checks}, and Friday didn't see them run` };
}

/** "Done: 6 files, checks passed". */
export function doneLine(d: RefactorDone): string {
  const files = `${d.files} file${d.files === 1 ? "" : "s"}`;
  return `Done: ${files}, ${d.checks === "none" ? "no checks run" : `checks ${d.checks}`}`;
}

/** "6 files · 2 risks": the card's counts. */
export function planCounts(p: RefactorPlan): string {
  const parts = [`${p.files.length} file${p.files.length === 1 ? "" : "s"}`];
  if (p.risks.length) parts.push(`${p.risks.length} risk${p.risks.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/**
 * A plan's path as a row shows it: the file's name, and its folder from the chat's root when it sits under it. An absolute path
 * outside the root (or with no root known) shows its last two folders, not the whole of the long one.
 */
export function splitPath(path: string, root = ""): { name: string; dir: string } {
  let p = path.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (r && p.toLowerCase().startsWith(`${r.toLowerCase()}/`)) p = p.slice(r.length + 1);
  const cut = p.lastIndexOf("/");
  const name = p.slice(cut + 1);
  let dir = cut > 0 ? p.slice(0, cut) : "";
  if (/^([a-z]:)?\//i.test(p) && dir) {
    const parts = dir.split("/").filter((x) => x && !/^[a-z]:$/i.test(x));
    dir = parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : parts.join("/");
  }
  return { name, dir };
}
