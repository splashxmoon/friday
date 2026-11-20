/**
 * Stacked pull requests (Arun, 2026-11-19, wave 3: "Stacked PRs: split a big change into a stack of small PRs, each based on the
 * last, kept rebased for you."): what the agent is asked (propose a split), how its answer is read, what each part is called, and the
 * plan of git and gh steps that makes the stack and that restacks it. All pure, so the order of the steps is tested without a
 * repository: the page draws the card from it (client/StackCard.tsx), the runner carries the steps out (runner/stack-pr.ts).
 */

/** The fence the agent ends its proposal with: read by the chat (StackCard). */
export const STACK_FENCE = "friday-stack";

export { BIG_FILES, BIG_LINES, isBig } from "./stack-big.js";
const MAX_PARTS = 12;
const MAX_FILES = 500;

export interface StackPart {
  title: string;
  why: string;
  files: string[];
}
export interface StackPlan {
  parts: StackPart[];
}

const FORMAT = `End your answer with one fenced block, \`\`\`${STACK_FENCE}, holding one JSON object: {"parts": [{"title": a short pull request title, "why": one plain line on what this part does and why it can stand alone, "files": [each file's path from the repository's root]}]}. Order the parts the way they should merge: the first is based on the main branch, each next one on the one before it, so a part may use what the parts before it add and never what a later one adds. Put every changed file in exactly one part, keep each part small enough to read in one sitting (a few files, one idea) and make each one build and pass the tests on its own where you can. Write the proposal in your reply itself, as text.`;

/**
 * Asked of the agent by "Split into a stack" on a big change. Worded as a read (look at the diff, don't change anything) so the
 * agent stays out of the files while it proposes: the person edits the proposal on its card and the runner makes the branches.
 */
export const STACK_ASK = `Split into a stack\n\nLook over everything this branch has changed (git diff against the base branch, and the new files) and propose how to split it into a stack of small pull requests, each based on the last. Don't change anything and don't commit: I'll read the proposal, reorder or merge the parts, and make the stack from its card. ${FORMAT}\n`;

/** A path as the agent names it: forward slashes, no ./ in front; null for one that isn't a path inside the repository. */
function cleanPath(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const s = p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!s || s.startsWith("/") || s.startsWith("-") || /^[a-zA-Z]:/.test(s) || s.includes("\0") || s.split("/").some((x) => x === ".." || x === "")) return null;
  return s.slice(0, 400);
}

/** The parts in a fence's JSON, or null when it isn't a plan (an unfinished or broken block is drawn as plain code instead). */
export function parseStack(text: string): StackPlan | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? (raw as { parts?: unknown }).parts : null;
  if (!Array.isArray(list)) return null;
  const seen = new Set<string>();
  const parts: StackPart[] = [];
  let total = 0;
  for (const x of list) {
    if (!x || typeof x !== "object" || parts.length >= MAX_PARTS) continue;
    const o = x as Record<string, unknown>;
    const files: string[] = [];
    for (const f of Array.isArray(o.files) ? o.files : []) {
      const p = cleanPath(f);
      // A file belongs to one part: the first that names it keeps it.
      if (!p || seen.has(p) || total >= MAX_FILES) continue;
      seen.add(p);
      files.push(p);
      total++;
    }
    if (!files.length) continue;
    const title = typeof o.title === "string" ? o.title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    parts.push({ title: title || `Part ${parts.length + 1}`, why: typeof o.why === "string" ? o.why.replace(/\s+/g, " ").trim().slice(0, 400) : "", files });
  }
  return parts.length ? { parts } : null;
}

/** "3 parts · 14 files", the card's counts. */
export function stackCounts(plan: StackPlan): string {
  const files = plan.parts.reduce((n, p) => n + p.files.length, 0);
  return `${plan.parts.length} part${plan.parts.length === 1 ? "" : "s"} · ${files} file${files === 1 ? "" : "s"}`;
}

/** A part moved one place up (earlier: closer to the main branch) or down; the plan as it was when it can't move. */
export function moveStackPart(plan: StackPlan, i: number, by: -1 | 1): StackPlan {
  const j = i + by;
  if (i < 0 || j < 0 || i >= plan.parts.length || j >= plan.parts.length) return plan;
  const parts = plan.parts.slice();
  [parts[i], parts[j]] = [parts[j]!, parts[i]!];
  return { parts };
}

/** Part `i` and the one before it (`with` -1) or after it (+1) as one: the earlier one's title, both reasons and every file in order. */
export function mergeStackPart(plan: StackPlan, i: number, withPart: -1 | 1): StackPlan {
  const a = withPart === -1 ? i - 1 : i;
  const b = a + 1;
  if (a < 0 || b >= plan.parts.length) return plan;
  const x = plan.parts[a]!;
  const y = plan.parts[b]!;
  const why = [x.why, y.why].filter(Boolean).filter((w, k, all) => all.indexOf(w) === k).join(" ");
  const merged: StackPart = { title: x.title, why, files: [...x.files, ...y.files] };
  return { parts: [...plan.parts.slice(0, a), merged, ...plan.parts.slice(b + 1)] };
}

/** A branch name git accepts, as the runner checks it before it runs git with one. */
export const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[\w./-]{1,100}(?<![./])$/;

/** A title as a branch's last words: "Add the retry queue" -> "add-the-retry-queue". */
export function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
}

/**
 * The names the part branches take: `<branch>-1`, `<branch>-2`… from the branch the person is on, or, on the base branch itself (the
 * stack can't be named after main), from the first part's title under `stack/`. `taken` are the branches that already exist: the
 * prefix gets a word more until none of the names is taken, so a second stack never lands on the first one's branches.
 */
export function stackBranches(current: string, base: string, firstTitle: string, count: number, taken: ReadonlySet<string> | readonly string[] = []): { prefix: string; names: string[] } {
  const used = new Set(taken);
  const own = current && current !== "HEAD" && current !== base && BRANCH_NAME.test(current) ? current : `stack/${slug(firstTitle) || "changes"}`;
  for (let n = 1; ; n++) {
    const prefix = n === 1 ? own : `${own}-v${n}`;
    const names = Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
    if (!names.some((x) => used.has(x)) || n > 50) return { prefix, names };
  }
}

export type StackStep =
  /** A commit of this part's files made on the part below (or on the base's merge-base for the first), as a new branch. */
  | { kind: "commit"; part: number; branch: string; below: string | null; files: string[]; message: string }
  | { kind: "push"; part: number; branch: string }
  /** The pull request for a part: its base is the part below's branch, or the base branch for the first. */
  | { kind: "pr"; part: number; head: string; base: string; title: string; body: string }
  /** Every pull request's description again, now that each one's link is known. */
  | { kind: "links" };

/** A pull request's description: where it sits in the stack, why, and links to all the parts (the ones not yet opened are plain). */
export function stackBody(i: number, plan: StackPlan, urls: readonly (string | null | undefined)[], base: string): string {
  const n = plan.parts.length;
  const part = plan.parts[i]!;
  const rows = plan.parts.map((p, k) => {
    const url = urls[k];
    const label = url ? `[${p.title}](${url})` : p.title;
    return `${k + 1}. ${k === i ? `**${label}** (this pull request)` : label}`;
  });
  const below = i === 0 ? `It is based on \`${base}\`.` : `It is based on part ${i} (${urls[i - 1] ? `[${plan.parts[i - 1]!.title}](${urls[i - 1]})` : plan.parts[i - 1]!.title}), so merge that one first.`;
  return [`Part ${i + 1} of ${n} in a stack of pull requests.`, "", part.why, "", below, "", "The stack, in the order to merge:", ...rows, "", "Opened with Friday."].filter((l, k, all) => !(l === "" && (k === 0 || all[k - 1] === ""))).join("\n");
}

/**
 * The steps that make a stack, in order: every branch is committed first (locally, nothing to undo but a branch name), then pushed
 * bottom first, then the pull requests are opened bottom first (a pull request's base branch is on the remote by then), and last
 * every description is written again with the links. `base` is the branch the first part's pull request merges into.
 */
export function planStack(plan: StackPlan, names: readonly string[], base: string): StackStep[] {
  const n = plan.parts.length;
  const steps: StackStep[] = [];
  plan.parts.forEach((p, i) => steps.push({ kind: "commit", part: i + 1, branch: names[i]!, below: i === 0 ? null : names[i - 1]!, files: p.files, message: `${p.title}\n\nPart ${i + 1} of ${n} in a stack.` }));
  plan.parts.forEach((_, i) => steps.push({ kind: "push", part: i + 1, branch: names[i]! }));
  plan.parts.forEach((p, i) =>
    steps.push({ kind: "pr", part: i + 1, head: names[i]!, base: i === 0 ? base : names[i - 1]!, title: p.title, body: stackBody(i, plan, [], base) }),
  );
  steps.push({ kind: "links" });
  return steps;
}

export interface RestackPart {
  branch: string;
  /** Where its pull request stands, as gh says: open, merged, closed, or unknown when there is none or gh couldn't say. */
  state: "open" | "merged" | "closed" | "unknown";
}
export type RestackStep =
  /** Rebase `branch` from where it sat (its recorded base) onto `onto`: a branch name, or the base branch, and set its pull request's base to `retarget`. */
  | { kind: "rebase"; part: number; branch: string; onto: string; retarget: string }
  | { kind: "skip"; part: number; branch: string; why: string };

/**
 * What restacking does, part by part from the bottom: a part whose pull request merged drops out of the stack (the part above it
 * sits on the base branch now, or on the next part below that is still open); every other part is rebased onto the one below it
 * and its pull request's base follows. Pure: the runner decides what each rebase did.
 */
export function planRestack(parts: readonly RestackPart[], base: string): RestackStep[] {
  const steps: RestackStep[] = [];
  let below = base;
  parts.forEach((p, i) => {
    if (p.state === "merged") {
      steps.push({ kind: "skip", part: i + 1, branch: p.branch, why: "Merged" });
      return;
    }
    steps.push({ kind: "rebase", part: i + 1, branch: p.branch, onto: below, retarget: below });
    below = p.branch;
  });
  return steps;
}

/** A pull request's checks, as one word, from gh's statusCheckRollup. */
export function checksState(rollup: unknown): "pass" | "fail" | "pending" | "none" {
  if (!Array.isArray(rollup) || !rollup.length) return "none";
  let pending = false;
  for (const c of rollup) {
    const o = (c ?? {}) as { status?: string; conclusion?: string; state?: string };
    // A check run has status + conclusion; a commit status has only a state.
    const v = String(o.conclusion || o.state || "").toUpperCase();
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(v)) return "fail";
    if (!v || ["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING"].includes(v) || (o.status && String(o.status).toUpperCase() !== "COMPLETED")) pending = true;
  }
  return pending ? "pending" : "pass";
}

/**
 * What the stack view says beside a part: "#12", and only what is worth a word: checks that fail or still run, merged, how far it is
 * from the part below. Checks that pass are the icon's green check, so a narrow side bar keeps the words that matter; the tooltip has all.
 */
export function partDetail(p: { pr: number | null; state: string; checks: string; ahead: number; behind: number; pushed: boolean }): string {
  const bits: string[] = [];
  if (p.pr) bits.push(`#${p.pr}`);
  if (p.state === "merged") bits.push("merged");
  else if (p.state === "closed") bits.push("closed");
  else if (!p.pr) bits.push(p.pushed ? "no pull request" : "not pushed");
  if (p.state !== "merged" && p.pr) {
    if (p.checks === "fail") bits.push("checks failing");
    else if (p.checks === "pending") bits.push("checks running");
  }
  if (p.state !== "merged" && p.behind > 0) bits.push(`${p.behind} behind`);
  return bits.join(" · ");
}

/** What the agent is told when a restack stops on a conflict: the checkout is the person's, so the work is done in a copy. */
export function restackHandoff(c: { part: number; total: number; branch: string; onto: string; ontoRef: string; files: string[]; recorded: string }): string {
  const files = c.files.length ? ` It conflicts in: ${c.files.map((f) => `\`${f}\``).join(", ")}.` : "";
  return `Restack part ${c.part} of ${c.total}

Restacking my stack of pull requests stopped on a conflict: \`${c.branch}\` (part ${c.part}) no longer applies on top of \`${c.onto}\`.${files} Nothing was changed on \`${c.branch}\`, and my own checkout is untouched.

Do it in a SEPARATE worktree, not in my checkout (my uncommitted work and my current branch must stay exactly as they are). Make one outside this repository's folder with \`git worktree add --detach <a new folder> ${c.branch}\`, and in it run \`git rebase --onto ${c.ontoRef} ${c.recorded || c.ontoRef}\`. Resolve each conflict so that what part ${c.part} did is kept and what \`${c.onto}\` changed is kept, run the tests, and \`git rebase --continue\`. Then, from my checkout, move the branch with \`git branch -f ${c.branch} <the rebased commit>\` and push it with \`git push --force-with-lease origin ${c.branch}\`. Set its pull request's base to \`${c.onto}\` if it isn't already, and remove the worktree. Then tell me, and I'll restack the parts above it from the Stack view.`;
}
