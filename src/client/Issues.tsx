import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { CircleDotIcon, ExternalLinkIcon, MessageSquareIcon, SearchIcon, XIcon } from "lucide-react";
import { issueBrief, issueMatches, issueStanding, type GithubIssues, type InboxIssue, type LinearIssues } from "../issues.js";
import { api } from "./api.js";
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
    const li = api<LinearIssues>(identity, "/api/issues/linear").catch((e) => ({ available: false, reason: e instanceof Error ? e.message : String(e), issues: [] }) as LinearIssues);
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
        <div className="flex items-center gap-2 border-b border-[var(--border)] p-2">
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
                <h2 className="m-0 flex items-center gap-1.5 px-2.5 pt-2.5 pb-1 text-[11px] font-medium tracking-[0.06em] text-[var(--text-muted)] uppercase">
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
        <div className="mb-4 flex shrink-0 items-center justify-end gap-2">{controls}</div>
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

function Labels({ labels, max = 4, className }: { labels: InboxIssue["labels"]; max?: number; className?: string }) {
  if (!labels.length) return null;
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
      {labels.slice(0, max).map((l) => (
        <span key={l.name} className="inline-flex max-w-[140px] items-center gap-1 truncate rounded-full border border-[var(--border)] px-1.5 py-px text-[11px] text-[var(--ink-2)]" title={l.name}>
          <span className="size-2 shrink-0 rounded-full" style={{ background: l.color ?? "var(--text-muted)" }} />
          <span className="truncate">{l.name}</span>
        </span>
      ))}
      {labels.length > max && <span className="text-[11px] text-[var(--text-muted)]">+{labels.length - max}</span>}
    </span>
  );
}

function IssueRow({ issue: i, on, working, onPick }: { issue: InboxIssue; on: boolean; working: boolean; onPick: () => void }) {
  const root = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (on) root.current?.scrollIntoView({ block: "nearest" });
  }, [on]);
  const standing = issueStanding(i);
  return (
    <button
      ref={root}
      type="button"
      aria-current={on || undefined}
      onClick={onPick}
      className="flex w-full min-w-0 flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-colors duration-[var(--dass-fast)] hover:bg-[var(--hover)] aria-[current=true]:bg-[var(--hover)] aria-[current=true]:shadow-[inset_0_0_0_1px_var(--border)]"
    >
      <span className="flex min-w-0 items-start gap-2">
        <Dot state={working ? "working" : i.stateType === "started" ? "needs" : "idle"} className="mt-[5px]" title={working ? "In a session" : i.state} />
        <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug font-medium text-[var(--ink)]">{i.title}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-[21px] text-[11.5px] text-[var(--text-muted)]">
        <SourceMark source={i.source} />
        <span className="truncate">
          {i.source === "github" && i.repo ? `${i.repo.split("/")[1]} #${i.number}` : i.ref}
          {i.author ? ` · ${i.author}` : ""}
        </span>
        <span className="ml-auto shrink-0 tabular-nums">{i.updatedAt ? relTime(Date.parse(i.updatedAt)) : ""}</span>
      </span>
      {(standing || working || i.labels.length > 0) && (
        <span className="flex min-w-0 items-center gap-2 pl-[21px]">
          <span className={cn("min-w-0 truncate text-[11.5px] font-medium", working ? "text-[var(--dass-live)]" : "text-[var(--text-muted)]")}>{working ? "Friday is on it" : standing}</span>
          <Labels labels={i.labels} max={2} className="ml-auto justify-end" />
        </span>
      )}
    </button>
  );
}

function IssuePane({ issue: i, started, onWork }: { issue: InboxIssue; started?: Started[string]; onWork: () => void }) {
  const body = i.body.trim();
  return (
    <div className="flex flex-col gap-6 px-1 pt-1 pb-8">
      <header className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <h2 className="m-0 min-w-0 flex-1 text-[20px] leading-tight font-semibold tracking-[-0.015em] text-[var(--ink)]" title={i.title}>
            {i.title}
          </h2>
          <div className="flex shrink-0 items-center gap-1">
            {started ? (
              <Button size="sm" className="h-8 text-[12.5px]" onClick={() => (location.href = started.link)}>
                Open the session
              </Button>
            ) : (
              <Tip label="A new session, its box filled with this issue; the agent proposes a plan first" keys="↵">
                <Button size="sm" className="h-8 text-[12.5px]" onClick={onWork}>
                  Start work
                </Button>
              </Tip>
            )}
            <Tip label={i.source === "linear" ? "Open in Linear" : "Open on GitHub"} keys="G">
              <Button variant="ghost" size="icon-sm" aria-label={i.source === "linear" ? "Open in Linear" : "Open on GitHub"} className="text-[var(--text-muted)] hover:text-[var(--ink)]" onClick={() => openOutside(i.url)}>
                <ExternalLinkIcon />
              </Button>
            </Tip>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-1.5">
            <SourceMark source={i.source} /> {i.ref}
          </span>
          {i.author && (
            <span className="inline-flex items-center gap-1.5 text-[var(--ink-2)]">
              {i.avatar && <img className="size-4 rounded-full" src={i.avatar} alt="" />}
              {i.author}
            </span>
          )}
          {i.state && <span>{i.state}</span>}
          {i.priorityLabel && i.priority ? <span>{i.priorityLabel}</span> : null}
          {i.milestone && <span>{i.milestone}</span>}
          {i.assignees && i.assignees.length > 0 && <span title="Assigned to">→ {i.assignees.join(", ")}</span>}
          {i.comments ? (
            <span className="inline-flex items-center gap-1">
              <MessageSquareIcon className="size-3.5" /> {i.comments}
            </span>
          ) : null}
          {i.updatedAt && <span title={new Date(i.updatedAt).toLocaleString()}>updated {relTime(Date.parse(i.updatedAt))}</span>}
          <Labels labels={i.labels} max={8} />
        </div>
        {started && (
          <p className="m-0 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[12.5px] text-[var(--ink-2)]">
            <span className="text-[var(--dass-live)]">Friday is on it</span> in “{started.title || "a session"}”.
          </p>
        )}
      </header>
      <section className="flex flex-col gap-3">
        <h3 className="m-0 text-[13px] font-semibold text-[var(--ink)]">What it says</h3>
        {body ? <div className="md text-[13.5px]" dangerouslySetInnerHTML={{ __html: md(body) }} /> : <p className="m-0 text-[13px] text-[var(--text-muted)]">Just the title.</p>}
      </section>
    </div>
  );
}
