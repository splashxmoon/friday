/**
 * The pull request's checks, for the IDE's status bar (Arun, 2026-11-19, wave 3: "CI in the IDE: the PR's checks in the status bar; a
 * failure opens at the failing line with the log, and Fix with Friday.").
 *
 * Asked of the person's own `gh`, by folder: the branch the folder is on, its open pull request, and that pull request's checks. It reuses
 * what the board's shepherd reads with (pr-checks.ts: failedChecks, tailLog, checksText) and adds only the counting and the caching.
 * Read-only. The IDE asks every few seconds while something runs, so answers are kept for a short while and a second ask while one is out
 * waits for it, not for another `gh`.
 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { checksText, failedChecks, tailLog, type CheckFailure } from "../pr-checks.js";
import { gh } from "./git.js";

export interface CiCheck {
  /** Tells checks apart, names repeat (a workflow on push and on pull_request, two jobs called build): the job when there is one, else the link, else the place. */
  id: string;
  name: string;
  workflow?: string;
  link?: string;
  /** gh's own word: pass, fail, pending, skipping or cancel. */
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
  runId?: string;
  jobId?: string;
}

export interface CiOverview {
  /** The open pull request the folder's branch is on; null when there is none (the status item stays away). */
  pr: { url: string; number: number; title: string } | null;
  branch: string;
  checks: CiCheck[];
  counts: { pass: number; fail: number; pending: number };
  /** failing beats running beats passing; none when no check has reported. */
  state: "failing" | "running" | "passing" | "none";
  /** Why nothing could be read (no gh, not a git folder), for the IDE to stay quiet about but a person to see in a tooltip. */
  error?: string;
}

const BUCKETS = new Set(["pass", "fail", "pending", "skipping", "cancel"]);

/** `gh pr checks --json name,workflow,link,bucket,state` as checks, with the run and job a link names. Pure. */
export function checksFrom(json: unknown): CiCheck[] {
  if (!Array.isArray(json)) return [];
  const out: CiCheck[] = [];
  const used = new Set<string>();
  for (const c of json as { name?: unknown; workflow?: unknown; link?: unknown; bucket?: unknown; state?: unknown }[]) {
    if (!c || typeof c.name !== "string" || !c.name) continue;
    let bucket = String(c.bucket ?? "").toLowerCase();
    // A status context with no bucket: its state says it.
    if (!BUCKETS.has(bucket)) {
      const st = String(c.state ?? "").toUpperCase();
      bucket = ["FAILURE", "TIMED_OUT", "ERROR", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(st) ? "fail" : ["CANCELLED", "STALE"].includes(st) ? "cancel" : ["SUCCESS", "NEUTRAL"].includes(st) ? "pass" : st === "SKIPPED" ? "skipping" : "pending";
    }
    const link = typeof c.link === "string" ? c.link : "";
    const m = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(link);
    const wf = typeof c.workflow === "string" ? c.workflow : "";
    let id = m ? `job:${m[2]}` : link ? `link:${link}` : `${c.name}\0${wf}`;
    // The same id twice (a status context repeated): told apart by place.
    if (used.has(id)) id = `${id}#${out.length}`;
    used.add(id);
    out.push({ id, name: c.name, bucket: bucket as CiCheck["bucket"], ...(typeof c.workflow === "string" && c.workflow ? { workflow: c.workflow } : {}), ...(link ? { link } : {}), ...(m ? { runId: m[1]!, jobId: m[2]! } : {}) });
  }
  return out;
}

/** The counts and the one word for them: a cancelled check counts as failed, as failedChecks counts it; a skipped one as passed. Pure. */
export function rollup(checks: CiCheck[]): Pick<CiOverview, "counts" | "state"> {
  const counts = { pass: 0, fail: 0, pending: 0 };
  for (const c of checks) {
    if (c.bucket === "fail" || c.bucket === "cancel") counts.fail++;
    else if (c.bucket === "pending") counts.pending++;
    else counts.pass++;
  }
  const state = !checks.length ? "none" : counts.fail ? "failing" : counts.pending ? "running" : "passing";
  return { counts, state };
}

const cache = new Map<string, { at: number; value: CiOverview; raw: unknown }>();
/** A read in progress, so a second ask for the same folder waits for it (a fresh ask waits only for a fresh one). */
const inflight = new Map<string, { fresh: boolean; work: Promise<CiOverview> }>();
/** How long an answer is kept: the IDE asks every 15 s while something runs and every minute otherwise, so a second window shares it. */
const KEEP_MS = 8000;

async function isDir(p: string): Promise<boolean> {
  return stat(p).then((s) => s.isDirectory(), () => false);
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile("git", args, { cwd, timeout: 5000, windowsHide: true }, (err, out) => resolve(err ? "" : String(out).trim())));
}

/** The folder's branch, its open pull request and that pull request's checks. Never throws: trouble is in `error`. */
export async function ciOverview(folder: string, fresh = false): Promise<CiOverview> {
  if (!folder || !(await isDir(folder))) return { pr: null, branch: "", checks: [], counts: { pass: 0, fail: 0, pending: 0 }, state: "none", error: "No such folder." };
  const branch = await git(folder, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const key = `${folder}\0${branch}`;
  const had = cache.get(key);
  if (had && !fresh && Date.now() - had.at < KEEP_MS) return had.value;
  const going = inflight.get(key);
  if (going && (going.fresh || !fresh)) return going.work;
  const empty = { pr: null, branch, checks: [] as CiCheck[], counts: { pass: 0, fail: 0, pending: 0 }, state: "none" as const };
  const work = (async (): Promise<CiOverview> => {
    // A detached HEAD or no commit yet has no pull request.
    if (!branch || branch === "HEAD") return empty;
    let view: { url?: string; number?: number; title?: string; state?: string } | null = null;
    try {
      view = JSON.parse(await gh(folder, ["pr", "view", "--json", "url,number,title,state"]));
    } catch (e) {
      const m = (e as Error).message;
      // "no pull requests found for branch" is the ordinary answer; a missing gh or an unreadable remote is said, quietly.
      if (/no pull requests? found/i.test(m)) {
        cache.delete(key);
        return empty;
      }
      return { ...empty, error: /ENOENT|not found|command/i.test(m) && /gh/i.test(m) ? "The GitHub CLI (gh) isn't installed on this machine." : m.slice(0, 200) };
    }
    // Only a pull request still open has checks worth watching.
    if (!view?.url || String(view.state ?? "").toUpperCase() !== "OPEN") {
      cache.delete(key);
      return empty;
    }
    // gh exits 8 when a check failed and 1 when none has reported: the JSON, if any, is still on stdout.
    const raw = await gh(folder, ["pr", "checks", view.url, "--json", "name,workflow,link,bucket,state"]).catch((e: Error & { stdout?: string }) => e.stdout ?? "");
    let all: unknown = [];
    try {
      all = JSON.parse(raw || "[]");
    } catch {
      all = [];
    }
    const checks = checksFrom(all);
    const value: CiOverview = { pr: { url: view.url, number: Number(view.number) || 0, title: String(view.title ?? "").slice(0, 200) }, branch, checks, ...rollup(checks) };
    cache.set(key, { at: Date.now(), value, raw: all });
    return value;
  })()
    .catch(() => empty)
    .finally(() => {
      if (inflight.get(key)?.work === work) inflight.delete(key);
    });
  inflight.set(key, { fresh, work });
  return work;
}

/** A log as text a person or an agent reads: without the terminal colours and cursor moves a program printed into it. */
const plain = (log: string) => log.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

/** A check's log, the failing part of it: the failed steps' output, or the job's whole log while its run is still going. Empty when it has none to read. */
export async function ciCheckLog(folder: string, which: string, max = 24000): Promise<{ log: string; link: string; check: CiCheck | null }> {
  const o = await ciOverview(folder);
  // By id; a bare name still finds the check while no other has it.
  const check = o.checks.find((c) => c.id === which) ?? o.checks.find((c) => c.name === which) ?? null;
  if (!check) return { log: "", link: "", check: null };
  if (!check.runId || !check.jobId) return { log: "", link: check.link ?? "", check };
  // --log-failed refuses while the run's other jobs are going, though this job is done: its own log then.
  let log = await gh(folder, ["run", "view", check.runId, "--job", check.jobId, "--log-failed"]).catch(() => "");
  if (!log.trim()) log = await gh(folder, ["run", "view", check.runId, "--job", check.jobId, "--log"]).catch(() => "");
  return { log: log.trim() ? tailLog(plain(log), max) : "", link: check.link ?? "", check };
}

/** What the agent is told for a "Fix with Friday" on the status item: the same words the board's shepherd uses (pr-checks.ts checksText), up to three failed checks with their logs. */
export async function ciFixText(folder: string): Promise<{ text: string; count: number } | null> {
  const o = await ciOverview(folder, true);
  if (!o.pr) return null;
  const raw = cache.get(`${folder}\0${o.branch}`)?.raw;
  const all = failedChecks(raw);
  const failures: CheckFailure[] = all.slice(0, 3);
  const more = all.slice(3).map((f) => f.name);
  for (const f of failures) {
    if (!f.runId || !f.jobId) continue;
    let log = await gh(folder, ["run", "view", f.runId, "--job", f.jobId, "--log-failed"]).catch(() => "");
    if (!log.trim()) log = await gh(folder, ["run", "view", f.runId, "--job", f.jobId, "--log"]).catch(() => "");
    if (log.trim()) f.log = tailLog(plain(log), 3000);
  }
  if (!failures.length) return null;
  return { text: checksText(failures, o.pr.url, more), count: all.length };
}

/** For the tests: forget what was kept. */
export function forgetCi(): void {
  cache.clear();
  inflight.clear();
}
