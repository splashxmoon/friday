import { RISKS } from "./code-review.js";
import { NOT_CODE, TEST_FILE, type ReceiptFlag } from "./receipt.js";
import type { PullRequest } from "./runner/workspace.js";
import type { ReviewFinding } from "./types.js";

/**
 * How risky a finished change is to wave through, so the riskiest gets read first.
 *
 * Agents now finish more work than people can read, so the review queue is the bottleneck. This scores a change from what
 * is already known about it, without reading it again: how much it changes, what it touches (auth, billing, migrations, CI,
 * dependencies, infrastructure), whether its tests ran and passed, what its receipt caught it doing, what the second
 * reviewer found, and what the pull request's checks say. The highest score goes to the top of the column; the reason that
 * weighs most is the chip on the card; small changes with nothing against them are "quick to review" and can be cleared together.
 * Nothing here is stored or asked for: the same facts give the same score.
 */

export type RiskLevel = "high" | "medium" | "low";

export interface RiskFacts {
  /** The files it changes, with their line counts when known. */
  files?: { path: string; additions?: number; deletions?: number; status?: string }[];
  /** Lines changed in all, when the file list is cut short (GitHub lists 60 at most). */
  lines?: number;
  /** Files changed in all, likewise. */
  fileCount?: number;
  /** The newest attempt at each test command, from the receipt; absent when nothing says either way. */
  tests?: "pass" | "fail" | "none";
  /** What the receipt caught: a test switched off, a check silenced, a claim that doesn't hold. */
  flags?: ReceiptFlag[];
  /** What the second reviewer (or your own agents' review) found and is still open. */
  findings?: ReviewFinding[];
  /** The pull request's checks, when it has one. */
  checks?: "passing" | "failing" | "pending" | "none";
}

export interface Risk {
  /** 0 to 100: higher is looked at first. */
  score: number;
  level: RiskLevel;
  /** Why, weightiest first, each a few words: "Touches billing", "Tests not run". */
  reasons: string[];
  /** The one reason the card names: the weightiest, or what there is to say for a change with none. */
  top: string;
  /** Small, nothing sensitive, nothing failing, nothing found: safe to clear along with others like it. */
  quick: boolean;
}

/** What each sensitive path is worth, and the chip that says it. Keyed by code-review.ts's labels, so one list of paths serves both. */
const SENSITIVE: Record<string, { weight: number; chip: string }> = {
  "Touches auth": { weight: 30, chip: "Touches auth" },
  "Touches billing": { weight: 30, chip: "Touches billing" },
  Migration: { weight: 30, chip: "Has a migration" },
  "CI config": { weight: 20, chip: "Changes CI" },
  Infra: { weight: 20, chip: "Changes infra" },
  Dependencies: { weight: 15, chip: "Changes dependencies" },
};

/** A receipt flag without the path it ends on: the chip has room for what happened, the card for where. */
const flagWords = (text: string) => text.replace(/ (?:in|from) \S+$/, "");
/** The receipt's own "ran no tests" says what `tests: "none"` already counts; counting both would score one fact twice. */
const SAID_BY_TESTS = /^Changed code and ran no tests$/;

export const QUICK_LINES = 200;
const HIGH = 45;
const MEDIUM = 18;

export function riskOf(f: RiskFacts): Risk {
  const files = f.files ?? [];
  const lines = f.lines ?? files.reduce((n, x) => n + (x.additions ?? 0) + (x.deletions ?? 0), 0);
  const fileCount = Math.max(f.fileCount ?? 0, files.length);
  const scored: { weight: number; text: string }[] = [];
  const add = (weight: number, text: string) => scored.push({ weight, text });

  let sensitive = false;
  for (const [label, re] of RISKS) {
    const s = SENSITIVE[label];
    if (s && files.some((x) => re.test(x.path))) (add(s.weight, s.chip), (sensitive = true));
  }

  const code = files.some((x) => !NOT_CODE.test(x.path) && !TEST_FILE.test(x.path));
  if (f.tests === "fail") add(40, "Tests failing");
  else if (f.tests === "none" && code) add(20, "Tests not run");

  if (f.checks === "failing") add(40, "Checks failing");
  else if (f.checks === "pending") add(3, "Checks running");

  const bad = (f.flags ?? []).filter((x) => x.level === "bad");
  const warn = (f.flags ?? []).filter((x) => x.level === "warn" && !SAID_BY_TESTS.test(x.text));
  bad.slice(0, 2).forEach((x) => add(30, flagWords(x.text)));
  warn.slice(0, 3).forEach((x) => add(8, flagWords(x.text)));

  const findings = f.findings ?? [];
  const high = findings.filter((x) => x.severity === "high");
  const medium = findings.filter((x) => x.severity === "medium");
  high.slice(0, 2).forEach((x) => add(35, `Reviewer: ${x.title}`));
  medium.slice(0, 3).forEach((x) => add(15, `Reviewer: ${x.title}`));
  if (findings.length && !high.length && !medium.length) add(2, "Reviewer left notes");

  const size = lines.toLocaleString("en-US");
  if (lines > 1000) add(25, `${size} lines`);
  else if (lines > 400) add(15, `${size} lines`);
  else if (lines > 150) add(7, `${size} lines`);
  if (fileCount > 25) add(10, `${fileCount} files`);
  else if (fileCount > 10) add(4, `${fileCount} files`);

  // Heaviest first; of two as heavy, the one found first (sensitive paths, then tests, then checks…) leads.
  const reasons = scored.map((r, i) => ({ ...r, i })).sort((a, b) => b.weight - a.weight || a.i - b.i);
  const score = Math.min(100, reasons.reduce((n, r) => n + r.weight, 0));
  const level: RiskLevel = score >= HIGH ? "high" : score >= MEDIUM ? "medium" : "low";
  const quick = level === "low" && !sensitive && lines <= QUICK_LINES && f.tests !== "fail" && f.checks !== "failing" && !bad.length && !high.length && !medium.length;
  const top = reasons[0]?.text ?? (f.tests === "pass" ? "Tests pass" : lines ? `${size} line${lines === 1 ? "" : "s"}` : "Small change");
  return { score, level, reasons: reasons.map((r) => r.text), top, quick };
}

/** Riskiest first; of two as risky, the newest. Anything without a score goes after everything with one. */
export function byRisk<T extends { risk?: Risk; at?: number }>(a: T, b: T): number {
  return (b.risk?.score ?? -1) - (a.risk?.score ?? -1) || (b.at ?? 0) - (a.at ?? 0);
}

/**
 * A pull request's risk, from what GitHub lists (its files, lines and checks), with what its session knows when one of
 * Friday's agents made it (the tests it ran, its receipt, the second reviewer) and what your own agents' review found.
 */
export function riskOfPr(pr: Pick<PullRequest, "files" | "additions" | "deletions" | "changedFiles" | "checks">, session?: RiskFacts, findings: ReviewFinding[] = []): Risk {
  const found = [...(session?.findings ?? []), ...findings];
  return riskOf({
    files: pr.files ?? [],
    lines: pr.additions + pr.deletions,
    ...(pr.changedFiles ? { fileCount: pr.changedFiles } : {}),
    checks: pr.checks,
    ...(session?.tests ? { tests: session.tests } : {}),
    ...(session?.flags?.length ? { flags: session.flags } : {}),
    ...(found.length ? { findings: found } : {}),
  });
}
