import { untrusted, UNTRUSTED_NOTE } from "./untrusted.js";
/**
 * A pull request's failing checks, in a form the agent can act on.
 *
 * When CI goes red the person used to open the run, find the step, copy the log and paste it into the session. These
 * are the pure parts of doing that for them: reading `gh pr checks`'s answer into the failed ones, trimming a run's log
 * to the part that matters, and telling the agent the way a colleague would.
 */

export interface CheckFailure {
  name: string;
  workflow?: string;
  link?: string;
  /** A GitHub Actions run and job, when the link names one: that is where a log can be read from. */
  runId?: string;
  jobId?: string;
  /** The failing part of the log, when it could be read. */
  log?: string;
  /** How it ended when not plainly failed: "cancelled" or "stale", which have no log worth reading. */
  outcome?: string;
}

interface CheckJson {
  name?: string;
  workflow?: string;
  link?: string;
  bucket?: string;
  state?: string;
}

/** `gh pr checks --json name,workflow,link,bucket,state`: the ones that failed, with where their logs live. */
export function failedChecks(json: unknown): CheckFailure[] {
  if (!Array.isArray(json)) return [];
  const out: CheckFailure[] = [];
  for (const c of json as CheckJson[]) {
    if (!c || typeof c.name !== "string") continue;
    const bucket = (c.bucket ?? "").toLowerCase();
    const state = (c.state ?? "").toUpperCase();
    // Cancelled and stale count as failed, as the board's status reader counts them: left out here, the shepherd saw a
    // red pull request with nothing to hand over, and watched it in silence for good.
    const cancelled = bucket === "cancel" || ["CANCELLED", "STALE"].includes(state);
    if (bucket !== "fail" && !cancelled && !["FAILURE", "TIMED_OUT", "ERROR", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(state)) continue;
    const m = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(c.link ?? "");
    out.push({ name: c.name, ...(c.workflow ? { workflow: c.workflow } : {}), ...(c.link ? { link: c.link } : {}), ...(m ? { runId: m[1]!, jobId: m[2]! } : {}), ...(cancelled ? { outcome: state === "STALE" ? "stale" : "cancelled" } : {}) });
  }
  return out;
}

/**
 * The end of a log, where the failure is, without the noise GitHub puts in front of every line (job, step and a
 * timestamp). Cut at a line, and said to be.
 */
export function tailLog(log: string, max = 6000): string {
  const lines = log
    .split(/\r?\n/)
    .map((l) => {
      // GitHub's prefix is the job, the step and a timestamp, tab-separated; a tab in the program's own output stays.
      const parts = l.split("\t");
      const body = parts.length >= 3 && /^\d{4}-\d\d-\d\dT/.test(parts[2]!) ? parts.slice(2).join("\t") : l;
      return body.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "");
    })
    .filter((l) => l.trim());
  let text = lines.join("\n");
  if (text.length <= max) return text;
  text = text.slice(-max);
  const nl = text.indexOf("\n");
  return `…${nl >= 0 ? text.slice(nl) : text}`;
}

/** What the agent is told: each failed check, its log where there is one, and what is being asked of it. */
export function checksText(failures: CheckFailure[], prUrl: string): string {
  // A check's name is the workflow author's, and on a fork's pull request that is anyone: one line, no heading marks of its own.
  const one = (s: string) => s.replace(/\s+/g, " ").replace(/^#+\s*/, "").trim().slice(0, 80);
  const parts = failures.map((f) => {
    const head = `### ${one(f.name)}${f.workflow ? ` (${one(f.workflow)})` : ""}${f.outcome ? ` — ${f.outcome}` : ""}${f.link ? `\n${f.link}` : ""}`;
    // A log prints whatever the code under test printed, which on a fork's pull request is anyone's: fenced like a comment.
    return f.log ? `${head}\n${untrusted(`log of ${f.name}`, f.log)}` : `${head}\n(No log could be read for this one.)`;
  });
  const n = failures.length;
  return `[ci] ${n} check${n === 1 ? "" : "s"} failing on the pull request (${prUrl}):\n\n${parts.join("\n\n")}\n\nFind out why each one failed and fix the cause. If a failure isn't from this change, say so instead of working around it.\n\n${UNTRUSTED_NOTE}`;
}
