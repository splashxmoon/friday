import { useSyncExternalStore } from "react";
import type { EngineTool } from "../types.js";
import { hostApi } from "./local.js";
import type { Issue } from "../github-issue.js";
import type { Identity, RecentSession } from "./storage.js";

/**
 * Issues that start threads by themselves (Arun, 2026-11-16, "Do 2": as Devin takes work from a ticket): a project turned on
 * from its thread card has every open GitHub issue carrying its label (`friday` unless changed) started as a thread of its own,
 * the issue its brief, in a worktree on friday/<number>-<title>, with the coding tool chosen when it was turned on. Read through
 * the gh this computer is signed in with (runner repo.items), every two minutes while Friday is open. Each issue starts once:
 * taking it off the label and putting it back doesn't start it again. Three at most a round, so a label put on twenty
 * issues at once doesn't start twenty agents in a minute.
 */

export interface Intake {
  label: string;
  tool: EngineTool;
  /** The project's name, said in what it starts. */
  name: string;
}

const KEY = "friday.intake";
const DONE_KEY = "friday.intake.done";
const EVERY_MS = 120_000;
const AT_ONCE = 3;

const read = <T,>(k: string, dflt: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : dflt;
  } catch {
    return dflt;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // Blocked storage: nothing is kept, so nothing starts by itself either.
  }
};

let intakes: Record<string, Intake> = read(KEY, {});
const subs = new Set<() => void>();
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
/** Every project with issues starting threads, by its folder. */
export const useIntakes = () => useSyncExternalStore(subscribe, () => intakes);
export function setIntake(path: string, v: Intake | null) {
  const next = { ...intakes };
  if (v) next[path] = v;
  else delete next[path];
  intakes = next;
  write(KEY, intakes);
  for (const f of subs) f();
  if (v) dispatchEvent(new Event("friday:intake-now"));
}

/** Taken: written down before it starts, so a second window or a slow start never starts it twice. */
const taken = () => new Set(read<string[]>(DONE_KEY, []));
const take = (url: string) => write(DONE_KEY, [...taken(), url].slice(-600));

type Item = { number: number; title: string; url: string; labels?: string[] };

/** The issues to start, oldest first: open, carrying the label (in any case), and never started before. */
export function toStart(issues: readonly Item[], label: string, done: ReadonlySet<string>): Item[] {
  const want = label.trim().toLowerCase();
  return issues.filter((i) => i.labels?.some((l) => l.toLowerCase() === want) && !done.has(i.url)).reverse();
}

/** Every two minutes while Friday is open, and as soon as a project is turned on: its labelled issues, each started once. Stops when called back. */
export function startIntake(identity: Identity, remember: () => (r: RecentSession) => void): () => void {
  let gone = false;
  let running = false;
  const round = async () => {
    if (running || gone) return;
    running = true;
    try {
      let started = 0;
      for (const [path, it] of Object.entries(intakes)) {
        if (started >= AT_ONCE || gone) break;
        const r = await hostApi<{ issues: Item[] } | { error: string }>(identity, `/api/runner/repo.items?path=${encodeURIComponent(path)}`).catch(() => null);
        if (!r || "error" in r) continue;
        for (const x of toStart(r.issues, it.label, taken())) {
          if (started >= AT_ONCE || gone) break;
          take(x.url);
          started++;
          try {
            // Loaded with the first issue it starts, not with the app.
            const [{ startSession }, { issueBranch, withIssue }] = await Promise.all([import("./start-session.js"), import("../github-issue.js")]);
            const { issue } = await hostApi<{ issue: Issue }>(identity, `/api/runner/github.item?url=${encodeURIComponent(x.url)}`);
            const branch = issueBranch(issue);
            const { sid, invite, title } = await startSession(identity, { path, tool: it.tool, text: withIssue(`Labelled "${it.label}" on GitHub, so Friday started this thread on it. Work on the issue, and open a pull request for it when it's done.`, issue), aside: { branch, base: "HEAD" }, title: `#${issue.number} ${issue.title}` });
            remember()({ sid, title, invite, role: "owner", openedAt: Date.now(), repos: [{ name: it.name, path, live: true, worktree: true, branch }] });
          } catch (e) {
            console.warn("[intake]", x.url, (e as Error).message);
          }
        }
      }
    } finally {
      running = false;
    }
  };
  const t = setInterval(() => void round(), EVERY_MS);
  const now = () => void round();
  addEventListener("friday:intake-now", now);
  const first = setTimeout(now, 8_000);
  return () => {
    gone = true;
    clearInterval(t);
    clearTimeout(first);
    removeEventListener("friday:intake-now", now);
  };
}
