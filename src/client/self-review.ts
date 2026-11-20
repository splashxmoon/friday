/**
 * The agent's self-review (Arun, 2026-11-19: "The agent reviews its own diff the way a senior engineer would (bugs, security,
 * missing tests) and fixes what it finds before you see it"): what it is asked, how its report is read, and what each button of the
 * card says back to it.
 */
export type Severity = "bug" | "security" | "test" | "style" | "for-you";
export interface Finding {
  title: string;
  severity: Severity;
  status: "fixed" | "open";
  detail: string;
  file: string;
  line: number;
}

/** The fence the agent ends its report with: read by the chat (SelfReviewCard) and the IDE's comment threads. */
export const REVIEW_FENCE = "friday-review";

const FORMAT = `End your report with one fenced block, \`\`\`${REVIEW_FENCE}, holding one JSON object, {"files": how many files you went over, "findings": an array with one object per finding: {"title": a short name, "severity": "bug" | "security" | "test" | "style" | "for-you", "status": "fixed" | "open", "detail": one plain line, "file": the file's path, "line": the line number}}. Use "for-you" for what only I can decide. Leave "file" empty and "line" 0 when a finding has none. An empty findings array if you found nothing.`;

/** Asked of the agent in the header's button, and by "Review again". */
// Worded as work to do, not a read: "Review your…" opened with a reading verb and smartReach put the agent in Plan, which cannot fix
// anything (review, 2026-11-19).
export const SELF_REVIEW_ASK = `Go over your whole diff (git diff against the base branch) the way a senior engineer would and fix what they would flag: bugs, security, missing tests, and anything that misses what was asked. Commit nothing new unless I ask. Then report what you found and fixed. ${FORMAT}`;

/** The step the ticket flow takes before the pull request. */
export const TICKET_REVIEW_STEP = `Go over your own diff (git diff against the base branch) like a senior engineer and fix what they would flag: bugs, security, missing tests, and anything that misses what the ticket asked. Then end that report with a \`\`\`${REVIEW_FENCE} block as JSON: {"files": how many files you went over, "findings": [{"title", "severity": "bug|security|test|style|for-you", "status": "fixed|open", "detail", "file", "line"}]}.`;

export const OPEN_PR_ASK = "Open the pull request now, with what changed and why, and give me its link.";

const SEVERITIES = new Set<string>(["bug", "security", "test", "style", "for-you"]);

/** The findings in a fence's JSON, or null when it isn't a list (an unfinished or broken block is drawn as plain code instead). */
export function parseReview(text: string): Finding[] | null {
  return readReview(text)?.findings ?? null;
}

/** A fence's JSON as a list of findings, or as {files, findings} with the count of files the agent went over. */
export function readReview(text: string): { findings: Finding[]; files: number } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  let files = 0;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if (typeof o.files === "number" && o.files > 0) files = Math.min(Math.floor(o.files), 9999);
    raw = o.findings;
  }
  if (!Array.isArray(raw)) return null;
  const out: Finding[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    if (!title) continue;
    out.push({
      title,
      severity: SEVERITIES.has(String(o.severity)) ? (o.severity as Severity) : "style",
      status: o.status === "fixed" ? "fixed" : "open",
      detail: typeof o.detail === "string" ? o.detail.trim() : "",
      file: typeof o.file === "string" ? o.file.trim() : "",
      line: typeof o.line === "number" && o.line > 0 ? Math.floor(o.line) : 0,
    });
  }
  return { findings: out, files };
}

export const SEVERITY_TAG: Record<Severity, string> = { bug: "Bug", security: "Security", test: "Test", style: "Style", "for-you": "For you" };

/** "3 files · 4 findings", the header's counts. `reviewed` is how many files the agent says it went over, when it says. */
export function reviewCounts(f: Finding[], reviewed = 0): string {
  const files = reviewed || new Set(f.map((x) => x.file).filter(Boolean)).size;
  const parts = [];
  if (files) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  parts.push(f.length ? `${f.length} finding${f.length === 1 ? "" : "s"}` : "no findings");
  return parts.join(" · ");
}
