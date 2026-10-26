import type { PullRequest } from "./runner/workspace.js";
import type { EngineTool, ReviewFinding } from "./types.js";
import { TEST_FILE } from "./receipt.js";

/**
 * What Code Review works out about pull requests, apart from drawing them: how big one is, what it touches that deserves a
 * careful look, what stands between it and merging, which pile it goes in, and what several agents' reviews agree on.
 * No DOM here, so all of it can be checked by a test.
 */

export type Size = "XS" | "S" | "M" | "L" | "XL";
/** Lines changed, in the sizes people already use for pull requests. */
export function sizeOf(pr: Pick<PullRequest, "additions" | "deletions">): Size {
  const n = pr.additions + pr.deletions;
  return n <= 10 ? "XS" : n <= 50 ? "S" : n <= 250 ? "M" : n <= 1000 ? "L" : "XL";
}

export const RISKS: [string, RegExp][] = [
  ["Touches auth", /(^|[/_.-])(auth|login|oauth|session|password|token|secret|permission|crypto|acl)s?([/_.-]|$)/i],
  ["Touches billing", /(^|[/_.-])(billing|payments?|stripe|invoices?|checkout|subscriptions?|pricing|metering)([/_.-]|$)/i],
  ["Migration", /(^|\/)migrations?\/|\.sql$|schema\.prisma$/i],
  ["CI config", /^\.github\/workflows\/|(^|\/)(\.gitlab-ci\.yml|Jenkinsfile|\.circleci\/)/i],
  ["Dependencies", /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|requirements[^/]*\.txt|poetry\.lock|Gemfile\.lock|composer\.lock)$/i],
  ["Infra", /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml|render\.yaml|vercel\.json|fly\.toml)$|\.tf$|(^|\/)(k8s|helm|terraform)\//i],
];
/** What a change touches that is worth a careful look, from the paths it changes. */
export function risksOf(pr: Pick<PullRequest, "files">): string[] {
  const paths = (pr.files ?? []).map((f) => f.path);
  return RISKS.filter(([, re]) => paths.some((p) => re.test(p))).map(([label]) => label);
}

/** A changed file, in the order a careful reviewer would read it, with why it is where it is. */
export interface Reviewed<F> {
  file: F;
  risks: string[];
  /** Only formatting, reordering or imports changed: folded away at the end. */
  mechanical: boolean;
}

const changed = (patch: string, sign: "+" | "-") => patch.split("\n").filter((l) => l.startsWith(sign) && !l.startsWith(sign.repeat(3))).map((l) => l.slice(1));
const IMPORT = /^\s*(import\b|export\s+(\*|\{[^}]*\})\s+from\b|from\s+\S+\s+import\b|(const|let|var)\s+[\w{}\s,]+=\s*require\(|use\s+[\w:]+;|#include\b)/;

/**
 * An agent's change set, riskiest first. The same marks Code Review puts on a pull request (auth, migrations, CI,
 * dependencies, infrastructure), plus a deleted test, put those files at the top; a file whose change is only formatting,
 * lines moved about, or imports goes to the bottom, folded. Everything else keeps the order it came in. Reading a big diff
 * top to bottom spent the attention on whatever came first, which was alphabetical.
 */
export function reviewOrder<F extends { path: string; status: string; patch: string }>(files: F[]): Reviewed<F>[] {
  const out = files.map((file, i) => {
    const risks = RISKS.filter(([, re]) => re.test(file.path)).map(([label]) => label);
    if (file.status === "deleted" && TEST_FILE.test(file.path)) risks.push("Deletes a test");
    const plus = changed(file.patch, "+").filter((l) => l.trim());
    const minus = changed(file.patch, "-").filter((l) => l.trim());
    const squash = (ls: string[]) => ls.map((l) => l.replace(/\s+/g, "")).sort().join("\n");
    const mechanical =
      !risks.length && file.status === "modified" && (plus.length > 0 || minus.length > 0) && (squash(plus) === squash(minus) || [...plus, ...minus].every((l) => IMPORT.test(l)));
    return { file, risks, mechanical, i };
  });
  const rank = (r: { risks: string[]; mechanical: boolean }) => (r.risks.length ? 0 : r.mechanical ? 2 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || b.risks.length - a.risks.length || a.i - b.i).map(({ file, risks, mechanical }) => ({ file, risks, mechanical }));
}

export type Mark = "ok" | "bad" | "wait" | "skip";
/** The three things between a pull request and merging, each as a mark. */
export function stepsOf(pr: PullRequest): { checks: Mark; review: Mark; merge: Mark } {
  return {
    checks: pr.checks === "passing" ? "ok" : pr.checks === "failing" ? "bad" : pr.checks === "pending" ? "wait" : "skip",
    review: pr.review === "approved" ? "ok" : pr.review === "changes_requested" ? "bad" : pr.review === "review_required" ? "wait" : "skip",
    merge: pr.mergeable === false ? "bad" : pr.mergeState === "behind" ? "wait" : pr.mergeable === true ? "ok" : "wait",
  };
}

export type Pile = "ready" | "fix" | "waiting" | "draft";
/** Which pile one of yours goes in: ready to merge, needs a fix, waiting on somebody, or still a draft. */
export function pileOf(pr: PullRequest): Pile {
  if (pr.draft) return "draft";
  const s = stepsOf(pr);
  if (s.checks === "bad" || s.merge === "bad" || s.review === "bad") return "fix";
  if (s.checks !== "wait" && s.review !== "wait" && s.merge === "ok") return "ready";
  return "waiting";
}

/** What could fix a pull request that needs one, each named as the button that does it. */
export function fixesOf(pr: PullRequest): ("checks" | "conflicts" | "comments" | "behind")[] {
  const out: ("checks" | "conflicts" | "comments" | "behind")[] = [];
  if (pr.checks === "failing") out.push("checks");
  if (pr.mergeable === false) out.push("conflicts");
  else if (pr.mergeState === "behind") out.push("behind");
  if (pr.review === "changes_requested" || (pr.unresolved ?? 0) > 0) out.push("comments");
  return out;
}

const DAY = 86_400_000;
/** How long somebody has been waiting on a review, from when it was asked for. */
export const waitedMs = (pr: PullRequest, now = Date.now()) => Math.max(0, now - Date.parse(pr.requestedAt ?? pr.createdAt ?? pr.updatedAt));
/** A wait worth saying: a day or more. */
export function waitWord(ms: number): string {
  const d = Math.floor(ms / DAY);
  return d >= 1 ? `waiting ${d}d` : "";
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
/** "1.4d", "5h", "20m": a duration as short as it can be said. */
export function shortDuration(ms: number): string {
  if (ms >= DAY) return `${Math.round((ms / DAY) * 10) / 10}d`;
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

export interface Stats {
  waiting: number;
  oldestWait: number | null;
  open: number;
  merged: number;
  /** Median time from opening to merging, over this week's merges. */
  toMerge: number | null;
}
export function statsOf(lists: { mine: PullRequest[]; review: PullRequest[]; merged: PullRequest[] }, now = Date.now()): Stats {
  const waits = lists.review.map((p) => waitedMs(p, now));
  const spans = lists.merged.filter((p) => p.createdAt && p.mergedAt).map((p) => Date.parse(p.mergedAt!) - Date.parse(p.createdAt!)).filter((n) => n >= 0);
  return { waiting: lists.review.length, oldestWait: waits.length ? Math.max(...waits) : null, open: lists.mine.length, merged: lists.merged.length, toMerge: median(spans) };
}

/** Who is being asked to review the most: the team's review load, busiest first. */
export function loadOf(prs: PullRequest[]): { login: string; avatar: string; count: number }[] {
  const by = new Map<string, { login: string; avatar: string; count: number }>();
  for (const p of prs) for (const r of p.requested ?? []) {
    const had = by.get(r.login) ?? { login: r.login, avatar: r.avatar, count: 0 };
    had.count++;
    by.set(r.login, had);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.login.localeCompare(b.login));
}

/** Search as people type it: words in the title, the branch, the repo, the author, or the number. */
export function matches(pr: PullRequest, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${pr.title} ${pr.branch} ${pr.repo} ${pr.author} #${pr.number}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

// ── several agents' reviews, read together ───────────────────────────

export interface AgreedFinding extends ReviewFinding {
  /** Which agents found it. Two or more is agreement, the strongest signal there is that it's real. */
  by: EngineTool[];
}

const RANK = { high: 0, medium: 1, low: 2 } as const;
const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
function alike(a: ReviewFinding, b: ReviewFinding): boolean {
  if (a.path && b.path && a.path !== b.path) return false;
  if (a.line && b.line && a.path === b.path) return Math.abs(a.line - b.line) <= 4;
  // No line on one of them: the same file and a title in common.
  const wa = words(a.title);
  const wb = words(b.title);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return !!a.path && a.path === b.path && shared >= Math.min(2, Math.min(wa.size, wb.size));
}

/**
 * One list from several agents' findings: the same problem found twice is one finding, said to be found by both, at the
 * graver of the two severities. Agreed findings first, then by severity.
 */
export function mergeFindings(results: { tool: EngineTool; findings: ReviewFinding[] }[]): AgreedFinding[] {
  const out: AgreedFinding[] = [];
  for (const { tool, findings } of results) {
    for (const f of findings) {
      const same = out.find((o) => !o.by.includes(tool) && alike(o, f));
      if (same) {
        same.by.push(tool);
        if (RANK[f.severity] < RANK[same.severity]) same.severity = f.severity;
        if (!same.line && f.line) same.line = f.line;
      } else out.push({ ...f, by: [tool] });
    }
  }
  return out.sort((a, b) => Number(b.by.length > 1) - Number(a.by.length > 1) || RANK[a.severity] - RANK[b.severity]);
}

/** A finding as a review comment: what is wrong, and which agents said so. */
export function commentFor(f: AgreedFinding, names: Record<EngineTool, string>): string {
  return `**${f.title}** (${f.severity})\n\n${f.detail}${f.by.length ? `\n\n_Found by ${f.by.map((t) => names[t]).join(" and ")}._` : ""}`;
}

// ── what's worth being told about ────────────────────────────────────

/** What was true at the last look, per pull request: enough to tell what changed since. */
export type Seen = { at: number; prs: Record<string, { r?: 1; c: PullRequest["checks"]; v: PullRequest["review"]; m: boolean | null; p: Pile }> };
export type PrAlert = { kind: "requested" | "failing" | "approved" | "changes" | "conflicts" | "ready"; pr: PullRequest; title: string; body: string };

/**
 * The news between two looks: somebody asked for your review, or one of yours went red, was approved, had changes asked
 * for, started to conflict, or can now merge. The first look is never news (it is what was already there), and neither
 * is a pull request of yours appearing, since you opened it.
 */
export function prAlerts(before: Seen | null, prs: { mine: PullRequest[]; review: PullRequest[] }, now = Date.now()): { alerts: PrAlert[]; seen: Seen } {
  const seen: Seen = { at: now, prs: {} };
  for (const p of prs.mine) seen.prs[p.url] = { c: p.checks, v: p.review, m: p.mergeable, p: pileOf(p) };
  for (const p of prs.review) seen.prs[p.url] = { r: 1, c: p.checks, v: p.review, m: p.mergeable, p: pileOf(p) };
  if (!before) return { alerts: [], seen };
  const alerts: PrAlert[] = [];
  const about = (p: PullRequest) => `#${p.number} ${p.title} · ${p.repo}`;
  for (const p of prs.review) if (!before.prs[p.url]?.r) alerts.push({ kind: "requested", pr: p, title: `${p.author || "Somebody"} asked for your review`, body: about(p) });
  for (const p of prs.mine) {
    const b = before.prs[p.url];
    if (!b) continue;
    if (p.checks === "failing" && b.c !== "failing") alerts.push({ kind: "failing", pr: p, title: "Checks failed", body: about(p) });
    if (p.mergeable === false && b.m !== false) alerts.push({ kind: "conflicts", pr: p, title: "Now conflicts with its base", body: about(p) });
    const ready = seen.prs[p.url]!.p === "ready" && b.p !== "ready";
    if (p.review === "approved" && b.v !== "approved") alerts.push({ kind: "approved", pr: p, title: ready ? "Approved and ready to merge" : "Approved", body: about(p) });
    else if (p.review === "changes_requested" && b.v !== "changes_requested") alerts.push({ kind: "changes", pr: p, title: "Changes requested", body: about(p) });
    else if (ready) alerts.push({ kind: "ready", pr: p, title: "Ready to merge", body: about(p) });
  }
  return { alerts, seen };
}
