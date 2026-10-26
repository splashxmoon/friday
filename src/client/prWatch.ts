import { useEffect, useSyncExternalStore } from "react";
import { prAlerts, type PrAlert, type Seen } from "../code-review.js";
import type { PullRequest, PullRequests } from "../runner/workspace.js";
import { ENGINE_TOOLS, type EngineTool, type ReviewFinding } from "../types.js";
import { machineError } from "./GitHubConnect.js";
import { askToNotify } from "./Attention.js";
import { hostApi, useMachine } from "./local.js";
import { notificationsOn } from "./prefs.js";
import type { Identity } from "./storage.js";

/**
 * Your pull requests, kept current for the whole app rather than only while Code Review is open.
 *
 * One reading shared by the page and the app around it: the rail says how many are waiting on you, a notification says
 * when somebody asks for your review or one of yours goes red, gets approved or can merge, and auto-review has your own
 * agents read a new request before you open it. The page asks every minute while it is on screen; the app every few
 * minutes otherwise, hidden or not, since being told while you're elsewhere is the point.
 */

type PrState = { prs: PullRequests | null; error: string; busy: boolean };
let state: PrState = { prs: null, error: "", busy: false };
const subs = new Set<() => void>();
const set = (patch: Partial<PrState>) => {
  state = { ...state, ...patch };
  for (const s of subs) s();
};
const subscribe = (s: () => void) => (subs.add(s), () => void subs.delete(s));
export const usePrs = () => useSyncExternalStore(subscribe, () => state);

let inflight: Promise<void> | null = null;
let onOpen: (() => void) | null = null;
export function refreshPrs(identity: Identity): Promise<void> {
  inflight ??= (async () => {
    set({ busy: true });
    try {
      const got = await hostApi<PullRequests>(identity, "/api/runner/prs");
      // A machine still on an older runner can leave the lists out (GitHub not answering), which blanked Code Review.
      const prs = { ...got, mine: got.mine ?? [], review: got.review ?? [], merged: got.merged ?? [] };
      set({ prs, error: "", busy: false });
      if (prs.available) changed(identity, prs);
    } catch (e) {
      set({ error: machineError(e), busy: false });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

const WATCH_MS = 3 * 60_000;
/** The app's side: a reading now, then every few minutes, for as long as a machine is there to ask. */
export function usePrWatch(identity: Identity, open: () => void): void {
  onOpen = open;
  const { state: machine } = useMachine(identity);
  const linked = machine.mode === "local" || machine.mode === "linked";
  useEffect(() => {
    if (!linked) return;
    void refreshPrs(identity);
    const t = setInterval(() => void refreshPrs(identity), WATCH_MS);
    return () => clearInterval(t);
  }, [identity.id, linked]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The watch as a piece of the app, mounted once somebody is signed in. Draws nothing. */
export function PrWatch({ identity, onOpen: open }: { identity: Identity; onOpen: () => void }): null {
  usePrWatch(identity, open);
  return null;
}

// ── what changed since the last look ─────────────────────────────────

const SEEN_KEY = "mpa.review.seen";
function readSeen(): Seen | null {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "null") as Seen | null;
  } catch {
    return null;
  }
}

function changed(identity: Identity, prs: PullRequests) {
  const { alerts, seen } = prAlerts(readSeen(), prs);
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* told again next time, which is better than never */
  }
  if (alerts.length) askToNotify();
  for (const a of alerts) {
    notify(a);
    if (a.kind === "requested") autoReview(identity, a.pr);
  }
}

/** Said outside the app, while its window is hidden: the rail already says it to somebody looking. */
function notify(a: PrAlert) {
  if (typeof Notification === "undefined" || document.visibilityState === "visible" || !notificationsOn() || Notification.permission !== "granted") return;
  try {
    const n = new Notification(a.title, { body: a.body, tag: `${a.pr.url}:${a.kind}` });
    n.onclick = () => {
      window.focus();
      onOpen?.();
      n.close();
    };
  } catch {
    // Notifications are a courtesy; a window that refuses them changes nothing.
  }
}

// ── auto-review ──────────────────────────────────────────────────────

const AUTO_KEY = "mpa.review.auto";
export type AutoReview = { on: boolean; tools: EngineTool[] };
export function readAuto(): AutoReview {
  try {
    const a = JSON.parse(localStorage.getItem(AUTO_KEY) ?? "null") as AutoReview | null;
    return a && typeof a.on === "boolean" ? { on: a.on, tools: (a.tools ?? []).filter((t) => ENGINE_TOOLS.includes(t)) } : { on: false, tools: [] };
  } catch {
    return { on: false, tools: [] };
  }
}
let auto = readAuto();
export function setAuto(next: AutoReview) {
  auto = next;
  try {
    localStorage.setItem(AUTO_KEY, JSON.stringify(next));
  } catch {
    /* on for this visit only */
  }
  version++;
  for (const l of listeners) l();
}
export const useAuto = () => (useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), () => version), auto);

function autoReview(identity: Identity, pr: PullRequest) {
  if (!auto.on || !auto.tools.length) return;
  const had = reviews.get(pr.url);
  // Read once per commit: a request that comes again for the same code has its answer already.
  if (had && (had.running.length || (had.head && had.head === pr.head))) return;
  // A handful at a time: somebody back from a week away shouldn't come back to every CLI they have busy at once.
  if ([...reviews.values()].filter((r) => r.running.length).length >= 3) return;
  void runReview(identity, pr, auto.tools, true);
}

// ── agent reviews, kept while the app is open (and the last answers between launches) ──

export type ReviewRun = {
  head: string;
  results: { tool: EngineTool; findings: ReviewFinding[] }[];
  running: EngineTool[];
  errors: Partial<Record<EngineTool, string>>;
  at: number;
  /** The team's rule files the review was checked against, by name. */
  rules: string[];
  /** Started by auto-review rather than by a press. */
  auto?: boolean;
};
const REVIEWS_KEY = "mpa.review.agent";
export const reviews = new Map<string, ReviewRun>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(REVIEWS_KEY) ?? "[]") as [string, ReviewRun][];
    } catch {
      return [];
    }
  })().map(([k, v]) => [k, { ...v, running: [], rules: v.rules ?? [] }]),
);
const listeners = new Set<() => void>();
let version = 0;
function setReview(url: string, next: ReviewRun) {
  reviews.set(url, next);
  version++;
  for (const l of listeners) l();
  if (next.running.length) return;
  try {
    localStorage.setItem(REVIEWS_KEY, JSON.stringify([...reviews.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, 30)));
  } catch {
    /* kept for this visit only */
  }
}
export const useReviews = () => useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), () => version);

export async function runReview(identity: Identity, pr: PullRequest, tools: EngineTool[], byAuto = false) {
  setReview(pr.url, { head: pr.head ?? "", results: [], running: [...tools], errors: {}, at: Date.now(), rules: [], ...(byAuto ? { auto: true } : {}) });
  await Promise.all(
    tools.map(async (tool) => {
      try {
        const r = await hostApi<{ tool: EngineTool; findings: ReviewFinding[]; head: string; rules?: string[] }>(identity, "/api/runner/pr.review", { method: "POST", body: JSON.stringify({ url: pr.url, tool }) });
        const now = reviews.get(pr.url)!;
        setReview(pr.url, { ...now, head: r.head || now.head, rules: r.rules?.length ? r.rules : now.rules, results: [...now.results, { tool, findings: r.findings }], running: now.running.filter((t) => t !== tool) });
      } catch (e) {
        const now = reviews.get(pr.url)!;
        setReview(pr.url, { ...now, errors: { ...now.errors, [tool]: machineError(e) }, running: now.running.filter((t) => t !== tool) });
      }
    }),
  );
}
