import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { CircleDotIcon, ExternalLinkIcon, MessageSquareIcon, SearchIcon, XIcon } from "lucide-react";
import { issueBrief, issueMatches, type GithubIssues, type InboxIssue, type LinearIssues } from "../issues.js";
import { api } from "./api.js";
import { isLocal } from "./edition.js";
import { machineError } from "./GitHubConnect.js";
import { hostApi } from "./local.js";
import { md } from "./markdown.js";
import { openOutside } from "./openOutside.js";
import type { Identity } from "./storage.js";
import { SkeletonRows, relTime } from "./ui.js";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState as DassEmpty } from "@/components/dass/EmptyState";
import { Dot, Tip } from "@/components/dass/page-bits";

/**
 * The issue inbox, on Code Review's fifth tab: what is on your plate in GitHub and Linear, and Start work on any of it.
 *
 * GitHub's issues come from this computer's own login (the runner's `issues`), Linear's from the workspace key the server
 * holds. An issue a label already started a session for says so, with the way in, instead of offering to start another.
 * Start work fills the box on Home with the issue, plan first: a person reads the plan before any code moves.
 */

type Started = Record<string, { sid: string; link: string; title: string }>;
export interface IssuesState {
  github: GithubIssues | null;
  linear: LinearIssues | null;
  started: Started;
  error: string;
}

/** The lists the tab shows, read once per visit and on Refresh; kept across tab switches for the visit. */
let last: IssuesState | null = null;

export function useIssues(identity: Identity, enabled: boolean, n: number): IssuesState & { busy: boolean } {
  const [st, setSt] = useState<IssuesState>(last ?? { github: null, linear: null, started: {}, error: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setBusy(true);
    const gh = hostApi<GithubIssues>(identity, "/api/runner/issues").catch((e) => ({ available: false, reason: machineError(e), assigned: [], authored: [] }) as GithubIssues);
    // Linear is the paid edition's (its server has the route): the open-source edition doesn't ask, so it doesn't print "Not
    // found" over the GitHub issues it does have (2026-10-27 audit).
    const li = isLocal()
      ? Promise.resolve({ available: false, reason: "", issues: [] } as unknown as LinearIssues)
      : api<LinearIssues>(identity, "/api/issues/linear").catch((e) => ({ available: false, reason: e instanceof Error ? e.message : String(e), issues: [] }) as LinearIssues);
    void Promise.all([gh, li]).then(async ([github, linear]) => {
      if (!live) return;
      const keys = [...github.assigned, ...github.authored, ...linear.issues].map((i) => i.key);
      const started = keys.length ? await api<{ started: Started }>(identity, "/api/issues/started", { method: "POST", body: JSON.stringify({ keys }) }).then((r) => r.started, () => ({}) as Started) : {};
      if (!live) return;
      last = { github, linear, started, error: "" };
      setSt(last);
      setBusy(false);
    });
    return () => void (live = false);
  }, [identity.id, enabled, n]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...st, busy };
}

export function IssuesInbox({ data, controls, onWork, query, setQuery, search }: { data: IssuesState & { busy: boolean }; controls: ReactNode; onWork: (brief: string) => void; query: string; setQuery: (q: string) => void; search: RefObject<HTMLInputElement | null> }) {
  const { github, linear, started, busy } = data;
  const loading = busy && !github && !linear;
  const groups = useMemo(() => {
    const assigned = [...(github?.assigned ?? []), ...(linear?.issues ?? [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const authored = github?.authored ?? [];
    const f = (xs: InboxIssue[]) => xs.filter((i) => issueMatches(i, query));
    return [
      { title: "Assigned to you", items: f(assigned) },
      { title: "You opened", items: f(authored) },
    ].filter((g) => g.items.length);
  }, [github, linear, query]);
  const order = groups.flatMap((g) => g.items);
  const [sel, setSel] = useState("");
  const current = order.find((i) => i.key === sel) ?? order[0];

  // j and k walk the list, as on the pull requests.
  const keys = useRef({ order, current });
  keys.current = { order, current };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector(".overlay")) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k = keys.current;
      const at = k.order.findIndex((i) => i.key === k.current?.key);
      if (e.key === "j" || e.key === "ArrowDown") setSel(k.order[Math.min(k.order.length - 1, at + 1)]?.key ?? "");
      else if (e.key === "k" || e.key === "ArrowUp") setSel(k.order[Math.max(0, at - 1)]?.key ?? "");
      else if (e.key === "g" && k.current) openOutside(k.current.url);
      else if (e.key === "Enter" && k.current && !started[k.current.key]) onWork(issueBrief(k.current));
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [started, onWork]);

  const problems = [github && !github.available ? github.reason : "", linear && !linear.available ? linear.reason : ""].filter(Boolean) as string[];
  const nothing = !loading && order.length === 0;
  const empty = query ? "No issue matches that." : github?.available || linear?.available ? "Nothing is assigned to you, and you have no open issues." : "Nothing can be read yet.";

  return (
    <div className="rv-split gap-5! min-[721px]:grid-cols-[clamp(320px,30%,460px)_minmax(0,1fr)]!">
      <aside className="rv-queue" aria-label="Issues">
        <div className="page-top-in flex items-center gap-2 border-b border-[var(--border)] p-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-[var(--text-muted)]" />
            <Input ref={search} value={query} placeholder="Search" aria-label="Search issues" className="h-8 border-[var(--border)] bg-[var(--bg)] pr-8 pl-8 text-[13px] shadow-none md:text-[13px]" onChange={(e) => setQuery(e.target.value)} />
            <span className="absolute top-1/2 right-1.5 -translate-y-1/2">
              {query ? (
                <Button variant="ghost" size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}>
                  <XIcon />
                </Button>
              ) : (
                <kbd aria-hidden>/</kbd>
              )}
            </span>
          </div>
        </div>
        {problems.map((p) => (
          <p key={p} role="note" className="m-0 border-b border-[var(--border)] px-3 py-2 text-[12px] leading-snug text-[var(--text-muted)]">
            {p}
          </p>
        ))}
        <div className="rv-queue-list">
          {loading ? (
            <SkeletonRows rows={4} />
          ) : (
            groups.map((g) => (
              <div key={g.title} className="flex flex-col gap-px">
                <h2 className="m-0 flex items-center gap-1.5 px-2.5 pt-2.5 pb-1 text-[12px] font-medium tracking-[0.06em] text-[var(--text-muted)] uppercase">
                  {g.title} <span className="tabular-nums">{g.items.length}</span>
                </h2>
                {g.items.map((i) => (
                  <IssueRow key={i.key} issue={i} on={current?.key === i.key} working={!!started[i.key]} onPick={() => setSel(i.key)} />
                ))}
              </div>
            ))
          )}
        </div>
      </aside>
      <section className="rv-pane" aria-label="Issue">
        <div className="page-top mb-4 flex shrink-0 items-center justify-end gap-2">{controls}</div>
        {current ? (
          <IssuePane key={current.key} issue={current} started={started[current.key]} onWork={() => onWork(issueBrief(current))} />
        ) : nothing ? (
          <DassEmpty className="mt-16" icon={<CircleDotIcon />} title={empty} action={query ? <Button variant="outline" size="sm" onClick={() => setQuery("")}>Clear search</Button> : undefined}>
            {!github?.available && !linear?.available && !query ? "GitHub issues are read by this computer's login; Linear's need a key under Settings · Integrations." : undefined}
          </DassEmpty>
        ) : null}
      </section>
    </div>
  );
}

/** Where an issue comes from, as a small mark before its ref. */
function SourceMark({ source }: { source: InboxIssue["source"] }) {
  return source === "linear" ? (
    <svg viewBox="0 0 100 100" className="size-3.5 shrink-0 text-[#5E6AD2]" aria-label="Linear" fill="currentColor">
      <path d="M1.2 61.4a50 50 0 0 0 37.4 37.4L1.2 61.4ZM0 46.6 53.4 100a50 50 0 0 0 11.6-2.6L2.6 35A50 50 0 0 0 0 46.6Zm5.5-22.5 70.4 70.4a50 50 0 0 0 7.8-6.1L11.6 16.3a50 50 0 0 0-6.1 7.8Zm11-13.4a50 50 0 1 1 72.8 72.8L16.5 10.7Z" />
    </svg>
  ) : (
    <CircleDotIcon className="size-3.5 shrink-0 text-[var(--green)]" aria-label="GitHub issue" />
  );
}

/** An issue's labels, as quiet chips: their names, not GitHub's colours (colour is for state here, docs/dass-design-language.md). */
function Labels({ labels, max = 4, className }: { labels: InboxIssue["labels"]; max?: number; className?: string }) {
  if (!labels.length) return null;
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}>
      {labels.slice(0, max).map((l) => (
        <span key={l.name} className="inline-flex h-[22px] max-w-[180px] items-center truncate rounded-md bg-[var(--hover)] px-2 text-[12px] text-[var(--ink-2)]" title={l.name}>
          {l.name}
        </span>
      ))}
      {labels.length > max && <span className="text-[12px] text-[var(--text-muted)]">+{labels.length - max}</span>}
    </span>
  );
}

/**
 * One issue in the list: its title, and one quiet line under it (where, who, its comments, when). Its labels are on its page, not
 * here: two rows of pills under every title made the list hard to read (Arun, 2026-11-05: "design this better").
 */
function IssueRow({ issue: i, on, working, onPick }: { issue: InboxIssue; on: boolean; working: boolean; onPick: () => void }) {
  const root = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (on) root.current?.scrollIntoView({ block: "nearest" });
  }, [on]);
  const where = i.source === "github" && i.repo ? `${i.repo.split("/")[1]} #${i.number}` : i.ref;
  const linearState = i.source === "linear" ? [i.state, i.priority && i.priorityLabel && i.priorityLabel !== "No priority" ? i.priorityLabel : ""].filter(Boolean).join(" · ") : i.milestone;
  return (
    <button
      ref={root}
      type="button"
      aria-current={on || undefined}
      onClick={onPick}
      className="flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-[var(--dass-fast)] hover:bg-[var(--hover)] aria-[current=true]:bg-[var(--hover)]"
    >
      <Dot state={working ? "working" : i.stateType === "started" ? "needs" : "idle"} className="mt-[6px]" title={working ? "In a session" : i.state} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 text-[13px] leading-[18px] font-medium text-[var(--ink)]">{i.title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-[18px] text-[var(--text-muted)]">
          {working ? <span className="shrink-0 font-medium text-[var(--dass-live)]">Friday is on it</span> : null}
          <span className="min-w-0 truncate">
            {working ? " · " : ""}
            {where}
            {i.author ? ` · ${i.author}` : ""}
            {linearState ? ` · ${linearState}` : ""}
          </span>
          {i.comments ? (
            <span className="inline-flex shrink-0 items-center gap-1 tabular-nums" title={`${i.comments} comment${i.comments === 1 ? "" : "s"}`}>
              <MessageSquareIcon className="size-3" aria-hidden />
              {i.comments}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 tabular-nums">{i.updatedAt ? relTime(Date.parse(i.updatedAt)) : ""}</span>
        </span>
      </span>
    </button>
  );
}

/**
 * The issue picked, read as a page: its title with Start work beside it (the one action), one quiet line of facts, its labels, and
 * what it says at a reading width, with no heading over it.
 */
function IssuePane({ issue: i, started, onWork }: { issue: InboxIssue; started?: Started[string]; onWork: () => void }) {
  const body = i.body.trim();
  const facts = [
    i.state && i.source === "linear" ? i.state : "",
    i.priorityLabel && i.priority ? i.priorityLabel : "",
    i.milestone ?? "",
    i.assignees?.length ? `assigned to ${i.assignees.join(", ")}` : "",
    i.updatedAt ? `updated ${relTime(Date.parse(i.updatedAt))}` : "",
  ].filter(Boolean);
  return (
    <article className="flex max-w-[720px] flex-col gap-5 px-1 pt-1 pb-10">
      <header className="flex flex-col gap-2.5">
        <div className="flex items-start gap-4">
          <h2 className="m-0 min-w-0 flex-1 text-[20px] leading-[28px] font-semibold tracking-[-0.015em] text-pretty text-[var(--ink)]">{i.title}</h2>
          <div className="flex shrink-0 items-center gap-1 pt-0.5">
            <Tip label={i.source === "linear" ? "Open in Linear" : "Open on GitHub"} keys="G">
              <Button variant="ghost" size="icon-sm" aria-label={i.source === "linear" ? "Open in Linear" : "Open on GitHub"} className="text-[var(--text-muted)] hover:text-[var(--ink)]" onClick={() => openOutside(i.url)}>
                <ExternalLinkIcon />
              </Button>
            </Tip>
            {started ? (
              <Button size="sm" className="h-8 text-[13px]" onClick={() => (location.href = started.link)}>
                Open the session
              </Button>
            ) : (
              <Tip label="A new session, its box filled with this issue; the agent proposes a plan first" keys="↵">
                <Button size="sm" className="h-8 text-[13px]" onClick={onWork}>
                  Start work
                </Button>
              </Tip>
            )}
          </div>
        </div>
        <p className="m-0 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] leading-[20px] text-[var(--text-muted)]">
          <SourceMark source={i.source} />
          <span className="text-[var(--ink-2)]">{i.ref}</span>
          {i.author && (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1.5">
                {i.avatar && <img className="size-4 rounded-full" src={i.avatar} alt="" />}
                {i.author}
              </span>
            </>
          )}
          {i.comments ? (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1 tabular-nums">
                <MessageSquareIcon className="size-3.5" aria-hidden /> {i.comments} comment{i.comments === 1 ? "" : "s"}
              </span>
            </>
          ) : null}
          {facts.map((f) => (
            <span key={f} className="contents">
              <span aria-hidden>·</span>
              <span title={f.startsWith("updated") && i.updatedAt ? new Date(i.updatedAt).toLocaleString() : undefined}>{f}</span>
            </span>
          ))}
        </p>
        <Labels labels={i.labels} max={8} />
        {started && (
          <p className="m-0 text-[13px] text-[var(--ink-2)]">
            <span className="font-medium text-[var(--dass-live)]">Friday is on it</span> in “{started.title || "a session"}”.
          </p>
        )}
      </header>
      <div className="border-t border-[var(--border)] pt-5">
        {body ? <div className="md max-w-[68ch] text-[14px] leading-[22px]" dangerouslySetInnerHTML={{ __html: md(body) }} /> : <p className="m-0 text-[13px] text-[var(--text-muted)]">Just the title.</p>}
      </div>
    </article>
  );
}
