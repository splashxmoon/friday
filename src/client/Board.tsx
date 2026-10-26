import { useEffect, useMemo, useRef, useState } from "react";
import { shortPaths } from "./shortPaths.js";
import type { BoardCard, BoardColumn } from "../board.js";
import { api } from "./api.js";
import { EngineMark, FridayMark } from "./BrandMarks.js";
import { Avatar, Icon } from "./icons.js";
import { openOutside } from "./openOutside.js";
import type { Identity, Project, RecentSession } from "./storage.js";
import { ConfirmDialog, isTyping, relTime, type Confirmation } from "./ui.js";
import { useMachine } from "./local.js";
import { usePrs } from "./prWatch.js";
import { QuickHeader, RiskChip, approveTogether, type Approvable } from "./reviewRisk.js";
import { ChartLineIcon, CheckIcon, ChevronRightIcon, CopyIcon, GitPullRequestIcon, LayoutGridIcon, SearchIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/dass";
import { EmptyState } from "@/components/dass/EmptyState";
import { Count, Dot, PageTabs, Tip, type DotState } from "@/components/dass/page-bits";

/**
 * The Agent Board: every agent working for you, in one place.
 *
 * One card per agent in every session this browser lists, sorted into what a person would do next: what is waiting on
 * them, what is running, what is up for review, what is ready to ship. The server arranges it from each session's own
 * log, so nothing here can disagree with the session. It polls while it is on screen and stops while the window is hidden.
 *
 * Built to be worked from the keyboard as much as the pointer: arrows (or j/k and h/l) move between cards, Enter opens one,
 * 1 to 4 jump to a column, / searches. What waits on you longest is first in its column; a card's branch can be copied and
 * its pull request opened from the card; the filters are remembered; the foot says whether the board is live.
 */

const COLUMNS: { id: Exclude<BoardColumn, "idle">; title: string; hint: string; empty: string }[] = [
  { id: "needs", title: "Needs you", hint: "Questions, approvals, stopped runs and review comments", empty: "Nothing waiting on you" },
  { id: "working", title: "Working", hint: "Agents running right now", empty: "No agent is running" },
  { id: "review", title: "In review", hint: "A pull request is open", empty: "No pull requests open" },
  { id: "ready", title: "Ready", hint: "Ready to merge, or changes to commit, or a branch to open a pull request for", empty: "Nothing ready to ship yet" },
];

const POLL_MS = 5000;
const FILTERS = "mpa.board.filters";

function useBoard(identity: Identity, recents: RecentSession[]) {
  const [cards, setCards] = useState<BoardCard[] | null>(null);
  const [week, setWeek] = useState<Week | null>(null);
  // Why the last reading failed ("" when it didn't): with nothing read yet, the board says so instead of loading forever.
  const [failed, setFailed] = useState("");
  // Each Try again that fails, counted, so the same words failing again are said again (the line is put back, and an alert put
  // back is read). Only those: the poll every few seconds failing while offline must not read it out each time.
  const [fails, setFails] = useState(0);
  const [at, setAt] = useState(0);
  const retry = useRef<() => Promise<boolean>>(async () => false);
  // A retry in flight, so Try again says it is trying and a second failure doesn't look like nothing happened.
  const [trying, setTrying] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const sids = recents.map((r) => r.sid).join(",");

  useEffect(() => {
    if (!sids) {
      setCards([]);
      return;
    }
    let live = true;
    const ask = async (): Promise<boolean> => {
      if (document.hidden) return false;
      try {
        const got = await api<{ cards: BoardCard[]; week?: Week }>(identity, "/api/board", { method: "POST", body: JSON.stringify({ sids: sids.split(",") }) });
        if (live) (setCards(got.cards), setWeek(got.week ?? null), setFailed(""), setAt(Date.now()));
        return true;
      } catch (e) {
        // Never reached Friday: that sentence says it all. Anything else is the server's few words, so say what failed first.
        const said = (e as Error).message || "";
        if (live) setFailed(e instanceof TypeError ? said || "Couldn't reach Friday. Check your connection and try again." : `Couldn't load the board.${said ? ` ${said}` : ""}`);
        return false;
      }
    };
    retry.current = async () => {
      setTrying(true);
      const ok = await ask();
      if (live) (setTrying(false), ok || setFails((n) => n + 1));
      return ok;
    };
    void ask();
    const t = setInterval(ask, POLL_MS);
    const wake = () => (setHidden(document.hidden), !document.hidden && void ask());
    document.addEventListener("visibilitychange", wake);
    return () => {
      live = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [identity.id, sids]);

  return { cards, week, failed, fails, at, hidden, trying, retry: () => retry.current() };
}

/** The week in three numbers, from the server. */
type Week = { sessions: number; shipped: number; runs: number };

/** Each column's state, as a dot: teal is alive, amber waits on you, the rest are quiet. */
const DOT: Record<BoardColumn, DotState> = { needs: "needs", working: "working", review: "idle", ready: "done", idle: "idle" };

function Mark({ card }: { card: BoardCard }) {
  return (
    <span className="grid size-5 shrink-0 place-items-center text-[var(--ink-2)]">
      {card.tool ? <EngineMark tool={card.tool} size={14} /> : card.agent === "Friday Code" ? <FridayMark size={14} /> : <Icon name="agent" size={14} />}
    </span>
  );
}

/** `solo`: every agent here is yours and nobody else is in the room, so names lose their "Arun's" and the room isn't drawn. */
function Card({ card, onOpen, solo, focused, onFocus }: { card: BoardCard; onOpen: (sid: string) => void; solo: boolean; focused: boolean; onFocus: () => void }) {
  const agent = solo ? card.agent.replace(/^[^']+'s /, "") : card.agent;
  const el = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (focused && document.activeElement !== el.current) el.current?.focus({ preventScroll: false });
  }, [focused]);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const needsYou = card.you && card.column === "needs";
  // Up for review or ready to ship: the reason it sits where it does in its column. The quick ones say it in their heading.
  const risk = (card.column === "review" || card.column === "ready") && card.risk && !card.risk.quick ? card.risk : null;
  return (
    // An article holding a button and the card's own buttons beside it, rather than one big role="button": a button's
    // contents are read as plain text, so Copy branch and the pull request inside it couldn't be reached by a screen reader,
    // and Enter on them opened the session too. The title is the way in; its press area covers the card (::after).
    // State first: the dot and what it is doing, then which piece of work, then who and where.
    <article
      className={cn(
        "group/card relative flex cursor-pointer flex-col gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--raised)] px-3 pt-2.5 pb-2.5 shadow-[var(--shadow-xs),var(--edge)] transition-[border-color,box-shadow] duration-[var(--dass-fast)] ease-[var(--dass-ease)] hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-md),var(--edge)]",
        "has-[[data-open]:focus-visible]:border-[var(--border-focus)] has-[[data-open]:focus-visible]:shadow-[var(--dass-ring)]",
        needsYou && "border-[color-mix(in_srgb,var(--dass-needs)_45%,var(--border))] hover:border-[color-mix(in_srgb,var(--dass-needs)_70%,var(--border))]",
      )}
      data-card={card.id}
      onClick={() => onOpen(card.sid)}
    >
      <div className="flex min-w-0 items-center gap-2 text-[12px] font-medium">
        <Dot state={DOT[card.column]} />
        <span className={cn("min-w-0 flex-1 truncate", card.column === "needs" ? "text-[var(--dass-needs)]" : card.column === "working" ? "text-[var(--dass-live)]" : "text-[var(--ink-2)]")}>
          {needsYou ? "Needs you" : card.status}
        </span>
        {card.at > 0 && <span className="shrink-0 text-[11px] font-normal text-[var(--text-muted)] tabular-nums">{relTime(card.at)}</span>}
      </div>
      <button
        ref={el}
        type="button"
        data-open
        className="block w-full min-w-0 truncate text-left text-[13.5px] leading-snug font-medium text-[var(--ink)] outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:shadow-none!"
        onFocus={onFocus}
        onClick={(e) => (e.stopPropagation(), onOpen(card.sid))}
        aria-label={`${card.title}, ${agent}: ${card.status}${card.you ? ", waiting on you" : ""}`}
      >
        {card.title}
      </button>
      <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--text-muted)]" title={`${agent}${card.branch ? ` · ${card.branch}` : ""}`}>
        <Mark card={card} />
        <span className="shrink-0">{agent}</span>
        {card.branch && (
          <>
            <span aria-hidden>·</span>
            <span className="min-w-0 truncate font-mono text-[11.5px]">{card.branch}</span>
          </>
        )}
      </div>
      {card.task && card.task !== card.title && !card.title.startsWith(card.task.slice(0, 40)) && <p className="m-0 line-clamp-2 text-[12.5px] leading-snug text-[var(--ink-2)]">{card.task}</p>}
      {card.detail && (
        <p className="m-0 truncate text-[12px] text-[var(--text-muted)]" title={card.detail}>
          {shortPaths(card.detail)}
        </p>
      )}
      {risk || (card.files > 0 && card.column !== "ready") || (!solo && card.people && card.people.length > 0) || card.branch || card.pr ? (
        <div className="flex min-h-6 min-w-0 items-center gap-1.5">
          {risk && <RiskChip risk={risk} />}
          {card.files > 0 && card.column !== "ready" && (
            <Badge variant="outline" className="h-5 rounded-md border-[var(--border)] px-1.5 text-[11px] font-medium text-[var(--ink-2)]">
              {card.files} file{card.files === 1 ? "" : "s"}
            </Badge>
          )}
          {/* Who is in the room right now; a ring on whoever the agent is waiting on. */}
          {!solo && card.people && card.people.length > 0 && (
            <span className="flex items-center -space-x-1.5" aria-label={`In the room: ${card.people.map((p) => p.name).join(", ")}`}>
              {card.people.slice(0, 3).map((p) => (
                <span
                  key={p.id}
                  className={cn("rounded-full ring-2 ring-[var(--bg)]", p.waiting && "ring-[var(--dass-needs)]")}
                  title={p.waiting ? `${p.name} · the agent is waiting on them` : `${p.name} is here`}
                >
                  <Avatar name={p.name} id={p.id} size={18} />
                </span>
              ))}
              {card.people.length > 3 && <span className="pl-2.5 text-[11px] text-[var(--text-muted)]">+{card.people.length - 3}</span>}
            </span>
          )}
          {/* Quick actions, without opening the session: shown on hover and focus. */}
          <span
            className="relative z-10 ml-auto flex items-center gap-0.5 opacity-0 transition-opacity duration-[var(--dass-fast)] group-hover/card:opacity-100 group-focus-within/card:opacity-100"
            onClick={stop}
            onKeyDown={stop}
          >
            {card.branch && (
              <Tip label={copied ? "Copied" : "Copy branch name"}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-[var(--text-muted)] hover:text-[var(--ink)]"
                  aria-label={`Copy branch ${card.branch}`}
                  onClick={() => void navigator.clipboard?.writeText(card.branch).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1400)))}
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </Button>
              </Tip>
            )}
            {card.pr && (
              <Tip label="Open the pull request on GitHub">
                <Button variant="ghost" size="xs" className="text-[var(--ink-2)]" onClick={() => openOutside(card.pr!.url)}>
                  <GitPullRequestIcon /> {card.pr.number ? `#${card.pr.number}` : "PR"}
                </Button>
              </Tip>
            )}
          </span>
        </div>
      ) : null}
    </article>
  );
}

/**
 * What waits on you longest goes first; up for review or ready, the riskiest change (review-risk.ts), with the quick ones
 * gathered after the rest; elsewhere, what moved most recently.
 */
const reviewing = (col: BoardColumn) => col === "review" || col === "ready";
const isQuick = (c: BoardCard) => reviewing(c.column) && !!c.risk?.quick;
const order = (col: BoardColumn, cs: BoardCard[]) =>
  [...cs].sort((a, b) =>
    col === "needs"
      ? Number(b.you) - Number(a.you) || a.at - b.at
      : reviewing(col)
        ? Number(isQuick(a)) - Number(isQuick(b)) || (b.risk?.score ?? -1) - (a.risk?.score ?? -1) || b.at - a.at
        : b.at - a.at,
  );

function readFilters(): { project: string; onlyYou: boolean } {
  try {
    return { project: "", onlyYou: false, ...(JSON.parse(localStorage.getItem(FILTERS) ?? "{}") as object) };
  } catch {
    return { project: "", onlyYou: false };
  }
}

/** A filter chip: pressed or not, monochrome. */
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button
      variant="outline"
      size="xs"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "h-7 rounded-full border-[var(--border)] bg-transparent px-3 text-[12px] font-medium text-[var(--ink-2)] shadow-none hover:bg-[var(--hover)] hover:text-[var(--ink)] dark:bg-transparent",
        on && "border-[var(--ink)] bg-[var(--ink)] text-[var(--bg)] hover:bg-[var(--ink)] hover:text-[var(--bg)] dark:bg-[var(--ink)]",
      )}
    >
      {children}
    </Button>
  );
}

export function Board({ identity, recents, projects, onOpen, onNew, solo = false }: { identity: Identity; recents: RecentSession[]; projects: Project[]; onOpen: (sid: string) => void; onNew: () => void; solo?: boolean }) {
  const { cards, week, failed, fails, at, hidden, trying, retry } = useBoard(identity, recents);
  // A retry that works takes the Try again button away; the focus goes to the board's heading, not to the page.
  const heading = useRef<HTMLHeadingElement>(null);
  const retried = useRef(false);
  useEffect(() => {
    if (!retried.current || cards === null) return;
    retried.current = false;
    if (document.activeElement === document.body) heading.current?.focus();
  }, [cards]);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState(readFilters);
  const { project, onlyYou } = filters;
  const setFilter = (f: Partial<typeof filters>) =>
    setFilters((cur) => {
      const next = { ...cur, ...f };
      try {
        localStorage.setItem(FILTERS, JSON.stringify(next));
      } catch {
        /* remembered for this visit only */
      }
      return next;
    });
  const [idleOpen, setIdleOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  // Approving goes through this person's own computer, signed in to GitHub as them, as on Code Review.
  const { state: machine } = useMachine(identity);
  const linked = machine.mode === "local" || machine.mode === "linked";
  const { prs } = usePrs();
  const yours = useMemo(() => new Set((prs?.mine ?? []).map((p) => p.url)), [prs]);
  /** The quick pull requests this person may approve: open, not approved yet, and not their own (GitHub refuses those). */
  const approvable = (list: BoardCard[]): Approvable[] =>
    linked
      ? list
          .filter((c) => c.pr && c.column === "review" && c.gh?.state !== "merged" && c.gh?.state !== "closed" && c.gh?.review !== "approved" && !c.gh?.draft)
          .filter((c) => (prs ? !yours.has(c.pr!.url) : !c.mine))
          .map((c) => ({ url: c.pr!.url, title: c.title }))
      : [];
  const approveAll = (list: Approvable[]) =>
    setConfirm({
      title: `Approve ${list.length} pull request${list.length === 1 ? "" : "s"}?`,
      body: `${list.length === 1 ? "It is" : "Each is"} small, touches nothing sensitive, and has nothing failing or found by the reviewer. ${list.length === 1 ? "It gets" : "They get"} your approval on GitHub: ${list.map((p) => p.title).join(", ")}.`,
      action: `Approve ${list.length}`,
      danger: false,
      onConfirm: () => approveTogether(identity, list),
    });
  const [weekOpen, setWeekOpen] = useState(false);
  const [focus, setFocus] = useState<string>("");
  const search = useRef<HTMLInputElement>(null);
  // The "updated 3s ago" in the foot moves on its own.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const projectOf = useMemo(() => new Map(recents.map((r) => [r.sid, r.projectId ?? ""])), [recents]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (cards ?? []).filter((c) => {
      if (project && projectOf.get(c.sid) !== project) return false;
      if (onlyYou && !(c.column === "needs" && c.you)) return false;
      return !q || [c.title, c.agent, c.branch, c.task, c.status].some((t) => t.toLowerCase().includes(q));
    });
  }, [cards, query, project, onlyYou, projectOf]);

  const by = (col: BoardColumn) => order(col, shown.filter((c) => c.column === col));
  const grid = COLUMNS.map((c) => by(c.id));
  const waitingOnYou = (cards ?? []).filter((c) => c.column === "needs" && c.you).length;
  const active = (cards ?? []).filter((c) => c.column !== "idle").length;
  const idle = by("idle");
  const usedProjects = projects.filter((p) => recents.some((r) => r.projectId === p.id));

  // Keys: the board is a grid of cards.
  const keys = useRef({ grid, focus, onOpen });
  keys.current = { grid, focus, onOpen };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector(".overlay")) return;
      if (isTyping(e.target)) {
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      const g = keys.current.grid;
      let c = g.findIndex((col) => col.some((x) => x.id === keys.current.focus));
      let r = c === -1 ? -1 : g[c]!.findIndex((x) => x.id === keys.current.focus);
      const go = (col: number, row: number) => {
        const list = g[col];
        if (!list?.length) return false;
        setFocus(list[Math.max(0, Math.min(list.length - 1, row))]!.id);
        return true;
      };
      if (e.key === "/") search.current?.focus();
      else if (/^[1-4]$/.test(e.key)) go(Number(e.key) - 1, 0);
      else if (c === -1 && ["ArrowDown", "ArrowRight", "j", "l"].includes(e.key)) g.some((_, i) => go(i, 0));
      else if (e.key === "ArrowDown" || e.key === "j") go(c, r + 1);
      else if (e.key === "ArrowUp" || e.key === "k") go(c, r - 1);
      else if (e.key === "ArrowRight" || e.key === "l") {
        for (let i = c + 1; i < g.length; i++) if (go(i, r)) break;
      } else if (e.key === "ArrowLeft" || e.key === "h") {
        for (let i = c - 1; i >= 0; i--) if (go(i, r)) break;
      } else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const ago = at ? Math.max(0, Math.round((now - at) / 1000)) : null;
  const freshness = hidden ? "Paused while hidden" : failed ? (cards === null ? "Couldn't load" : "Couldn't refresh, showing the last answer") : ago === null ? "Reading…" : ago < 5 ? "Live" : `Updated ${ago < 60 ? `${ago}s` : relTime(at)} ago`;
  const filtered = !!(query || project || onlyYou);

  return (
    <div className="page conns-page board-page px-6! max-[640px]:px-4!">
      {/* Its columns go by the board's own width, not the window's (Arun, 2026-10-22: "make this four columns"): with the
          sidebar open a wide window still had room for four, and got two. */}
      <div className="page-inner @container">
        <PageHeader title="Agent Board" titleRef={heading} />
        {confirm && <ConfirmDialog confirmation={confirm} onClose={() => setConfirm(null)} />}

        {/* One row: finding on the left, which cards and the week on the right, all 32px and centred on one line. */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-[340px] min-w-[220px] flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-[var(--text-muted)]" />
            <Input
              ref={search}
              value={query}
              placeholder="Search agents, tasks, branches"
              aria-label="Search the board"
              className="h-8 border-[var(--border)] bg-[var(--bg)] pr-9 pl-8 text-[13px] shadow-none md:text-[13px]"
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center">
              {query ? (
                <Button variant="ghost" size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}>
                  <XIcon />
                </Button>
              ) : (
                <kbd aria-hidden>/</kbd>
              )}
            </span>
          </div>
          {usedProjects.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Project">
              <Chip on={project === ""} onClick={() => setFilter({ project: "" })}>
                All projects
              </Chip>
              {usedProjects.map((p) => (
                <Chip key={p.id} on={project === p.id} onClick={() => setFilter({ project: project === p.id ? "" : p.id })}>
                  {p.name}
                </Chip>
              ))}
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <PageTabs<"all" | "you">
              label="Show"
              value={onlyYou ? "you" : "all"}
              onChange={(v) => setFilter({ onlyYou: v === "you" })}
              options={[
                { value: "all", label: <>All{active > 0 && <Count n={active} />}</> },
                { value: "you", label: <>Needs you{waitingOnYou > 0 && <Count n={waitingOnYou} needs />}</> },
              ]}
            />
          </div>
        </div>

        {cards === null && failed ? (
          // Nothing read yet and the reading failed: say so, with the way to try again, rather than placeholders forever.
          <EmptyState
            icon={<LayoutGridIcon />}
            title="Couldn't load the board"
            action={
              // aria-disabled, not disabled, so the focus stays on it while it tries.
              <Button aria-disabled={trying || undefined} onClick={() => !trying && ((retried.current = true), void retry().then((ok) => ok || (retried.current = false)))}>
                {trying ? "Trying…" : "Try again"}
              </Button>
            }
          >
            {/* The alert is the reason alone, so "Trying…" and "Try again" changing on the button don't read it all out again. */}
            <span role="alert" key={fails}>
              {failed}
            </span>
          </EmptyState>
        ) : cards !== null && cards.length === 0 ? (
          <EmptyState icon={<LayoutGridIcon />} title="No agents yet" action={<Button onClick={onNew}>New session</Button>}>
            Start a session and the agents working in it show up here, sorted by what needs you.
          </EmptyState>
        ) : (
          <>
            {/* A filter that matches nothing is said once, across the board, with the way back; not four boxes that each say it. */}
            {cards !== null && shown.length === 0 && cards.length > 0 && filtered && (
              <div className="flex items-center gap-3 rounded-xl border border-dashed border-[var(--border-strong)] px-4 py-3 text-[13px] text-[var(--ink-2)]" role="status">
                Nothing on the board matches{query ? ` “${query.trim()}”` : " these filters"}.
                <Button variant="outline" size="sm" className="ml-auto h-7" onClick={() => (setQuery(""), setFilter({ project: "", onlyYou: false }))}>
                  Clear filters
                </Button>
              </div>
            )}
            <div className="mt-1 grid grid-cols-1 items-start gap-3 @min-[480px]:grid-cols-2 @min-[720px]:grid-cols-4">
              {COLUMNS.map((col, i) => {
                const list = grid[i]!;
                return (
                  // A lane: a quiet well the cards sit in, its head saying what is in it, how many, and its key.
                  <section key={col.id} className="group/lane flex min-w-0 flex-col gap-1.5 rounded-xl bg-[var(--card)] p-1.5 shadow-[inset_0_0_0_1px_var(--border)]" aria-label={`${col.title}, ${list.length}`}>
                    <Tip label={col.hint} keys={String(i + 1)}>
                      <div className="flex h-8 items-center gap-2 px-2">
                        <Dot state={DOT[col.id]} />
                        <span className="text-[13px] font-semibold text-[var(--ink)]">{col.title}</span>
                        <Count n={list.length} needs={col.id === "needs" && list.some((c) => c.you)} />
                        <kbd aria-hidden className="ml-auto opacity-0 transition-opacity duration-[var(--dass-fast)] group-hover/lane:opacity-100">
                          {i + 1}
                        </kbd>
                      </div>
                    </Tip>
                    <div className="flex flex-col gap-1.5">
                      {list.filter((c) => !isQuick(c)).map((c) => (
                        <Card key={c.id} card={c} onOpen={onOpen} solo={solo} focused={focus === c.id} onFocus={() => setFocus(c.id)} />
                      ))}
                      {(() => {
                        const quick = list.filter(isQuick);
                        if (!quick.length) return null;
                        const ok = col.id === "review" ? approvable(quick) : [];
                        return (
                          <div className="flex flex-col gap-1.5" role="group" aria-label={`Quick to review, ${quick.length}`}>
                            <QuickHeader n={quick.length}>
                              {ok.length > 0 && (
                                <Tip label="Approve these on GitHub together">
                                  <Button variant="ghost" size="xs" className="h-6 text-[12px] text-[var(--ink-2)]" onClick={() => approveAll(ok)}>
                                    <CheckIcon /> Approve {ok.length === quick.length && ok.length > 1 ? "all" : ok.length}
                                  </Button>
                                </Tip>
                              )}
                            </QuickHeader>
                            {quick.map((c) => (
                              <Card key={c.id} card={c} onOpen={onOpen} solo={solo} focused={focus === c.id} onFocus={() => setFocus(c.id)} />
                            ))}
                          </div>
                        );
                      })()}
                      {!list.length &&
                        (cards === null ? (
                          <>
                            <Skeleton className="h-[84px] rounded-lg bg-[var(--hover)]" />
                            <Skeleton className="h-[84px] rounded-lg bg-[var(--hover)]" />
                          </>
                        ) : filtered && !shown.length ? null : (
                          <div className="grid h-[72px] place-items-center rounded-lg border border-dashed border-[var(--border-strong)] px-3 text-center text-[12.5px] text-[var(--text-muted)] opacity-80">
                            {filtered ? "Nothing here matches" : col.empty}
                          </div>
                        ))}
                    </div>
                  </section>
                );
              })}
            </div>

            {/* Sessions with nothing running: folded under a hairline, so the four lanes stay the board. */}
            <Collapsible open={idleOpen} onOpenChange={setIdleOpen} className="mt-2 border-t border-[var(--border)] pt-3">
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 gap-2 px-2 text-[13px] font-semibold text-[var(--ink)] hover:bg-[var(--hover)]">
                  <ChevronRightIcon className={cn("text-[var(--text-muted)] transition-transform duration-[var(--dass-med)] ease-[var(--dass-ease)]", idleOpen && "rotate-90")} />
                  <Dot state="idle" />
                  Idle
                  <Count n={idle.length} />
                  <span className="font-normal text-[12px] text-[var(--text-muted)]">Nothing running</span>
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="grid grid-cols-1 gap-1.5 pt-2 @min-[480px]:grid-cols-2 @min-[720px]:grid-cols-4">
                  {idle.map((c) => (
                    <Card key={c.id} card={c} onOpen={onOpen} solo={solo} focused={focus === c.id} onFocus={() => setFocus(c.id)} />
                  ))}
                  {!idle.length && <div className="px-2 text-[12.5px] text-[var(--text-muted)]">Nothing idle</div>}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </>
        )}

        {/* As in a session: the week and whether the board is live on the left, the keys on the right. */}
        <footer className="status-bar bd-status-bar mx-[-24px]! max-[640px]:mx-[-16px]!" aria-label="Agent Board status">
          <div className="stb-start">
            <span className="stb-run" role="status">
              <Dot state={failed ? "bad" : hidden || ago === null ? "idle" : "done"} />
              <span className="stb-run-text">{freshness}</span>
            </span>
            {week && (week.sessions || week.runs) ? (
              <span className="stb-item stb-quiet">
                This week: {week.sessions} session{week.sessions === 1 ? "" : "s"} · {week.shipped} shipped · {week.runs} run{week.runs === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          {/* The keys move between cards, so with no board to move in (its first reading failed) they aren't offered. */}
          {!(cards === null && failed) && (
            <div className="stb-end rv-status-keys" aria-hidden>
              <span><kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> Move</span>
              <span><kbd>↵</kbd> Open</span>
              <span><kbd>1</kbd>–<kbd>4</kbd> Column</span>
              <span><kbd>/</kbd> Search</span>
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}
