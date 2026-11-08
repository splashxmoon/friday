import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shortPaths } from "./shortPaths.js";
import type { BoardCard, BoardColumn } from "../board.js";
import type { Need, NeedMark } from "../needs-rank.js";
import { NEEDS_CHANGED, withCode } from "./Attention.js";
import { api } from "./api.js";
import { EngineMark, FridayMark } from "./BrandMarks.js";
import { Avatar, Icon } from "./icons.js";
import { teamCards, teamFace } from "./Teammates.js";
import { PresenceRing, type Presence } from "./presence.js";
import { openOutside } from "./openOutside.js";
import type { Identity, Project, RecentSession } from "./storage.js";
import { ConfirmDialog, isTyping, relTime, type Confirmation } from "./ui.js";
import { hostApi, useMachine } from "./local.js";
import { usePrs } from "./prWatch.js";
import { QuickHeader, RiskChip, approveTogether, type Approvable } from "./reviewRisk.js";
import { ChartLineIcon, CheckIcon, ChevronRightIcon, CopyIcon, GitPullRequestIcon, LayoutGridIcon, SearchIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

/**
 * What is waiting on you is not a column but a strip across the top, answered where it is (Arun, 2026-11-07, agent board design
 * A: "go with A for the agent board too but put a lot of attention to details and useful info"); the flow is the three lanes
 * under it.
 */
const COLUMNS: { id: Exclude<BoardColumn, "idle" | "needs">; title: string; hint: string; empty: string }[] = [
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
    // Answered, asked or put off anywhere: read again now, as the badge is.
    const now = () => void ask();
    addEventListener("friday:attention", now);
    addEventListener(NEEDS_CHANGED, now);
    return () => {
      live = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", wake);
      removeEventListener("friday:attention", now);
      removeEventListener(NEEDS_CHANGED, now);
    };
  }, [identity.id, sids]);

  return { cards, week, failed, fails, at, hidden, trying, retry: () => retry.current() };
}

/** The week in three numbers, from the server. */
type Week = { sessions: number; shipped: number; runs: number };

/** Each column's state, as a dot: teal is alive, amber waits on you, the rest are quiet. */
const DOT: Record<BoardColumn, DotState> = { needs: "needs", working: "working", review: "idle", ready: "done", idle: "idle" };

/** A column's state as the shared presence ring draws it on the card's face or mark (presence.tsx). */
const PRESENCE: Record<BoardColumn, Presence> = { needs: "needs", working: "working", review: "idle", ready: "idle", idle: "idle" };

/** The card's face (a teammate) or its coding tool's mark, wearing the ring of how it stands: the one state signal on a card. */
function Mark({ card }: { card: BoardCard }) {
  let face = null as React.ReactNode;
  face = teamFace(card);
  if (face) return <span className="board-mark">{face}</span>;
  return (
    <span className="board-mark">
      <PresenceRing state={PRESENCE[card.column]} size={24} square>
        <span className="sb-mark-disc">{card.tool ? <EngineMark tool={card.tool} size={13} /> : card.agent === "Friday Code" ? <FridayMark size={13} /> : <Icon name="agent" size={13} />}</span>
      </PresenceRing>
    </span>
  );
}

/** Lines added and taken away across what an agent changed, from what the board read of its work (board.ts reviewFacts). */
function sizeOf(card: BoardCard): { files: number; add?: number; del?: number } | null {
  const f = card.review;
  if (f?.fileCount) {
    const fs = f.files ?? [];
    // Lines are known only when a diff was read; a file only seen edited says its count alone.
    if (!fs.some((x) => x.additions || x.deletions)) return { files: f.fileCount };
    return { files: f.fileCount, add: fs.reduce((n, x) => n + (x.additions ?? 0), 0), del: fs.reduce((n, x) => n + (x.deletions ?? 0), 0) };
  }
  return card.files > 0 ? { files: card.files } : null;
}

/** The one thing a card offers besides opening it: its pull request, its failing checks, Merge, or a review to do. */
type CardAction = { label: string; title: string; primary?: boolean; icon?: boolean; run: () => void };

/**
 * One agent: its mark, its piece of work and how long since it moved; one live line (what it is doing, or where its pull request
 * stands, with a dot only when that means something: running, failing, ready); who and which branch, how big its change is, and
 * at most one action. `solo`: every agent here is yours and nobody else is in the room, so names lose their "Arun's".
 */
function Card({ card, onOpen, solo, focused, onFocus, action }: { card: BoardCard; onOpen: (sid: string) => void; solo: boolean; focused: boolean; onFocus: () => void; action?: CardAction | null }) {
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
  const failing = card.gh?.checks === "failing" && card.gh.state === "open";
  // The mark's ring and the lane already say running or ready; a dot on the line is kept for what the lane can't say: failing.
  const lineDot: DotState | null = failing ? "bad" : null;
  const size = card.column === "needs" ? null : sizeOf(card);
  const sizeEl = size ? (
    <span className="shrink-0 text-[12px] text-[var(--text-muted)] tabular-nums" title={`${size.files} file${size.files === 1 ? "" : "s"} changed${size.add !== undefined ? `, ${size.add} lines added and ${size.del} taken away` : ""}`}>
      {size.add !== undefined && (size.add || size.del) ? (
        <>
          <span className="text-[var(--green)]">+{size.add}</span> <span className="text-[var(--red)]">−{size.del}</span>
          <span> in {size.files} file{size.files === 1 ? "" : "s"}</span>
        </>
      ) : (
        `${size.files} file${size.files === 1 ? "" : "s"}`
      )}
    </span>
  ) : null;
  return (
    // An article holding a button and the card's own buttons beside it, rather than one big role="button": a button's
    // contents are read as plain text, so its actions couldn't be reached by a screen reader, and Enter on them opened the
    // session too. The title is the way in; its press area covers the card (::after).
    <article
      className={cn(
        "board-card group/card relative flex cursor-pointer flex-col gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 pt-2.5 pb-2.5 transition-[border-color,box-shadow] duration-[var(--dass-fast)] ease-[var(--dass-ease)] hover:border-[var(--border-strong)] hover:shadow-[0_1px_2px_rgb(0_0_0/0.04)]",
        "has-[[data-open]:focus-visible]:border-[var(--border-focus)] has-[[data-open]:focus-visible]:shadow-[var(--dass-ring)]",
        needsYou && "border-[color-mix(in_srgb,var(--dass-needs)_45%,var(--border))] hover:border-[color-mix(in_srgb,var(--dass-needs)_70%,var(--border))]",
      )}
      data-card={card.id}
      onClick={() => onOpen(card.sid)}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Mark card={card} />
        <button
          ref={el}
          type="button"
          data-open
          className="block min-w-0 flex-1 truncate text-left text-[13px] leading-[18px] font-medium text-[var(--ink)] outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:shadow-none!"
          onFocus={onFocus}
          onClick={(e) => (e.stopPropagation(), onOpen(card.sid))}
          title={card.task && card.task !== card.title ? card.task : card.title}
          aria-label={`${card.title}, ${agent}: ${card.status}${card.you ? ", waiting on you" : ""}`}
        >
          {card.title}
        </button>
        {card.at > 0 && (
          <span className="shrink-0 text-[12px] text-[var(--text-muted)] tabular-nums" title={new Date(card.at).toLocaleString()}>
            {relTime(card.at)}
          </span>
        )}
      </div>
      {/* One live line: the question when it waits on you, in ink; otherwise what it is doing, or where its pull request stands. */}
      <p className={cn("m-0 flex min-w-0 items-start gap-1.5 pl-8 text-[13px] leading-[18px]", needsYou ? "text-[var(--ink)]" : failing ? "text-[var(--red)]" : "text-[var(--ink-2)]")} title={card.detail || undefined}>
        {lineDot && <Dot state={lineDot} className="mt-[5px] shrink-0" />}
        <span className="line-clamp-2 min-w-0">{card.detail ? shortPaths(card.detail) : card.status}</span>
      </p>
      <div className="flex min-h-6 min-w-0 items-center gap-2 pl-8 text-[12px] text-[var(--text-muted)]">
        <span className="min-w-0 truncate" title={`${agent}${card.branch ? ` · ${card.branch}` : ""}`}>
          {agent}
          {card.branch && (
            <>
              <span aria-hidden> · </span>
              <span className="font-mono text-[12px]">{card.branch}</span>
            </>
          )}
        </span>
        {size && !action && sizeEl}
        {/* Who is in the room right now; a ring on whoever the agent is waiting on. */}
        {!solo && card.people && card.people.length > 0 && (
          <span className="flex shrink-0 items-center -space-x-1.5" aria-label={`In the room: ${card.people.map((p) => p.name).join(", ")}`}>
            {card.people.slice(0, 3).map((p) => (
              <span key={p.id} className={cn("rounded-full ring-2 ring-[var(--bg)]", p.waiting && "ring-[var(--dass-needs)]")} title={p.waiting ? `${p.name} · the agent is waiting on them` : `${p.name} is here`}>
                <Avatar name={p.name} id={p.id} size={18} />
              </span>
            ))}
            {card.people.length > 3 && <span className="pl-2.5 text-[12px] text-[var(--text-muted)]">+{card.people.length - 3}</span>}
          </span>
        )}
        <span className="relative z-10 ml-auto flex shrink-0 items-center gap-0.5" onClick={stop} onKeyDown={stop}>
          {/* Copy the branch: on hover and focus, so it doesn't crowd every card. */}
          {card.branch && (
            <Tip label={copied ? "Copied" : "Copy branch name"}>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-[var(--text-muted)] opacity-0 transition-opacity duration-[var(--dass-fast)] group-hover/card:opacity-100 group-focus-within/card:opacity-100 hover:text-[var(--ink)]"
                aria-label={`Copy branch ${card.branch}`}
                onClick={() => void navigator.clipboard?.writeText(card.branch).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1400)))}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
              </Button>
            </Tip>
          )}
        </span>
      </div>
      {/* The card's one action, on its own line with how big the change is: a pull request, its failing checks, or Merge. */}
      {(action || risk) && (
        <div className="relative z-10 flex min-h-6 min-w-0 items-center gap-2 pl-8" onClick={stop} onKeyDown={stop}>
          {risk && <RiskChip risk={risk} />}
          {action && sizeEl}
          {action && (
            <span className="ml-auto shrink-0">
              <Tip label={action.title}>
                <Button variant={action.primary ? "default" : "outline"} size="xs" className={cn("h-6 px-2 text-[12px]", !action.primary && "border-[var(--border)] bg-[var(--bg)] text-[var(--ink-2)] shadow-none")} onClick={action.run}>
                  {action.icon && <GitPullRequestIcon />}
                  {action.label}
                </Button>
              </Tip>
            </span>
          )}
        </div>
      )}
    </article>
  );
}

/** What waits on you, as the Needs you page has it (needs-you.ts): read with the board, so it can be answered here. */
function useNeedItems(identity: Identity, recents: RecentSession[]) {
  const [items, setItems] = useState<Need[] | null>(null);
  const sids = recents.map((r) => r.sid).join(",");
  const load = useCallback(async () => {
    if (document.hidden) return;
    try {
      const got = await api<{ items: Need[] }>(identity, "/api/needs-you", { method: "POST", body: JSON.stringify({ sids: sids ? sids.split(",") : [] }) });
      setItems(got.items);
    } catch {
      // The board's own reading says when Friday can't be reached; the strip keeps what it had.
    }
  }, [identity, sids]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    const now = () => void load();
    addEventListener("friday:attention", now);
    addEventListener(NEEDS_CHANGED, now);
    document.addEventListener("visibilitychange", now);
    return () => {
      clearInterval(t);
      removeEventListener("friday:attention", now);
      removeEventListener(NEEDS_CHANGED, now);
      document.removeEventListener("visibilitychange", now);
    };
  }, [load]);
  return { items, load };
}

/** The answer a card puts first: the one Friday or the asker suggests, else, for a command or a change, letting it. */
function firstChoice(n: Need): string | null {
  if (n.suggestion && n.choices.some((c) => c.value === n.suggestion!.answer)) return n.suggestion.answer;
  if (n.kind === "approval" || n.kind === "plan") return n.choices.find((c) => c.value === "yes")?.value ?? null;
  return null;
}

/**
 * One thing waiting on you, answered here (design A): who asks and from which piece of work, how long it has waited and what it
 * holds up; the question in full, a command to run as code; the suggested answer and why; its answers as buttons, the suggested
 * one first in weight; Reply for words of your own; and the session, for what can only be answered there.
 */
function NeedCard({ need, card, busy, error, solo, onAnswer, onOpen }: { need: Need; card?: BoardCard; busy: boolean; error: string; solo: boolean; onAnswer: (value: string, edited?: boolean) => void; onOpen: () => void }) {
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const agent = card ? (solo ? card.agent.replace(/^[^']+'s /, "") : card.agent) : need.who;
  const first = firstChoice(need);
  const choices = need.choices.length > 4 || need.asks?.length ? [] : need.choices;
  const ordered = [...choices.filter((c) => c.value !== first), ...choices.filter((c) => c.value === first)];
  const lines = need.detail?.split("\n").filter(Boolean) ?? [];
  const suggested = need.suggestion && (need.choices.find((c) => c.value === need.suggestion!.answer)?.label ?? (need.choices.length ? null : need.suggestion.answer));
  const holds = need.blocks.agents > 1 || need.blocks.tasks > 0 ? [need.blocks.agents > 1 ? `holds up ${need.blocks.agents} agents` : "", need.blocks.tasks ? `${need.blocks.tasks} task${need.blocks.tasks === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ") : "";
  return (
    <article className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-[color-mix(in_srgb,var(--dass-needs)_40%,var(--border))] bg-[var(--card)] p-3.5" aria-label={`${need.where.title}: ${need.text}`}>
      <div className="flex min-w-0 items-center gap-2">
        {card ? <Mark card={card} /> : <span className="board-mark"><PresenceRing state="needs" size={24} square><span className="sb-mark-disc"><Icon name="agent" size={13} /></span></PresenceRing></span>}
        <button type="button" className="link-btn min-w-0 flex-1 truncate text-left text-[13px] font-medium text-[var(--ink)]" onClick={onOpen} title={`Open “${need.where.title}”`}>
          {need.where.title}
        </button>
        <span className="shrink-0 text-[12px] text-[var(--text-muted)] tabular-nums" title={need.why || undefined}>
          {holds ? `${holds} · ` : ""}waited {relTime(need.since)}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 pl-8">
        <p className="m-0 line-clamp-4 text-[14px] leading-[20px] text-[var(--ink)] [&_code]:rounded [&_code]:bg-[var(--hover)] [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12.5px]">{withCode(need.text)}</p>
        {lines.length > 0 && (
          <pre className="m-0 max-h-24 overflow-auto rounded-md bg-[var(--hover)] px-2.5 py-1.5 font-mono text-[12px] leading-[18px] whitespace-pre-wrap text-[var(--ink)]">{lines.slice(0, 6).join("\n")}</pre>
        )}
        {suggested && need.suggestion && (
          <p className="m-0 text-[12px] leading-[17px] text-[var(--text-muted)]">
            {need.suggestion.by === "asker" ? `${agent} recommends` : "Friday suggests"} <span className="font-medium text-[var(--ink-2)]">{suggested}</span>
            {need.suggestion.reason && need.suggestion.by !== "asker" ? `: ${need.suggestion.reason}` : ""}
          </p>
        )}
        {need.noSuggestion && <p className="m-0 text-[12px] text-[var(--text-muted)]">{need.noSuggestion}</p>}
      </div>
      {replying ? (
        <div className="flex flex-col gap-2 pl-8">
          <Textarea
            className="min-h-16 border-[var(--border)] bg-[var(--bg)] text-[13px] md:text-[13px]"
            rows={2}
            autoFocus
            value={draft}
            placeholder={`Answer ${agent}`}
            aria-label={`Your answer to ${agent}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim()) onAnswer(draft.trim(), true);
              if (e.key === "Escape") setReplying(false);
            }}
          />
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" size="sm" className="h-7 text-[12px]" onClick={() => setReplying(false)}>
              Cancel
            </Button>
            <Button size="sm" className="h-7 text-[12px]" disabled={!draft.trim() || busy} onClick={() => onAnswer(draft.trim(), true)}>
              {busy ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 pl-8">
          <span className="min-w-0 flex-1 basis-40 truncate text-[12px] text-[var(--text-muted)]" title={`${agent}${card?.branch ? ` · ${card.branch}` : ""}`}>
            {agent}
            {card?.branch && (
              <>
                <span aria-hidden> · </span>
                <span className="font-mono">{card.branch}</span>
              </>
            )}
          </span>
          <span className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            {(!choices.length || need.free) && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px] text-[var(--ink-2)]" onClick={() => (choices.length ? (setDraft(""), setReplying(true)) : onOpen())}>
                {choices.length ? "Reply…" : "Answer in the session"}
              </Button>
            )}
            {ordered.map((c) => (
              <Button
                key={c.value}
                variant={c.value === first ? "default" : "outline"}
                size="sm"
                disabled={busy}
                className={cn("h-7 px-2.5 text-[12px]", c.value !== first && "border-[var(--border)] bg-[var(--bg)] shadow-none")}
                onClick={() => onAnswer(c.value)}
              >
                {c.label}
              </Button>
            ))}
          </span>
        </div>
      )}
      {error && (
        <p className="m-0 pl-8 text-[12px] text-[var(--red)]" role="alert">
          {error}
        </p>
      )}
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

export function Board({ identity, recents, projects, onOpen, onNew, onReview, solo = false, needs = [], off }: { identity: Identity; recents: RecentSession[]; projects: Project[]; onOpen: (sid: string) => void; onNew: () => void; /** A pull request asked of you: Code Review. */ onReview?: () => void; solo?: boolean; /** What the Needs you page lists, not put off (Attention.tsx). */ needs?: NeedMark[]; off?: Set<string> }) {
  const board = useBoard(identity, recents);
  // What waits on you, in full, to be answered on the board's strip (design A).
  const { items: needItems, load: loadNeeds } = useNeedItems(identity, recents);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [answering, setAnswering] = useState("");
  const [needError, setNeedError] = useState<{ id: string; text: string } | null>(null);
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(""), 4000);
    return () => clearTimeout(t);
  }, [said]);
  const answer = async (n: Need, value: string, edited = false) => {
    if (answering) return;
    setAnswering(n.id);
    setNeedError(null);
    try {
      const r = await api<{ said: string }>(identity, "/api/needs-you/answer", { method: "POST", body: JSON.stringify({ id: n.id, answer: value, edited }) });
      setSaid(`${r.said}: sent to ${n.who}`);
      setGone((g) => new Set(g).add(n.id));
      dispatchEvent(new Event("friday:attention"));
      void loadNeeds();
    } catch (e) {
      const text = (e as Error).message;
      setNeedError({ id: n.id, text });
      // Answered somewhere else meanwhile: it goes, with the reason said.
      if (/no longer waiting/.test(text)) setTimeout(() => (setGone((g) => new Set(g).add(n.id)), void loadNeeds()), 1200);
    } finally {
      setAnswering("");
    }
  };
  let { cards } = board;
  const { week, failed, fails, at, hidden, trying, retry } = board;
  // A team's cards are its teammates', named and faced as the sidebar has them, never a raw error (Teammates.tsx teamCards).
  cards = teamCards(cards);
  // What waits on you outside the sessions on the Board, a workflow at its Your OK, a pull request to review, as a card each in
  // Needs you, so its count is the Needs you page's: the Board said 3 and 5 over a page of 3, and nothing for a workflow waiting on
  // you (2026-11-04 retest). Opened, each goes to the Needs you page, where it is answered.
  const { prs: reviewing } = usePrs();
  if (cards) {
    // Not already a card waiting on you there: a workflow in a room whose teammates' cards rest is a card of its own.
    const onBoard = new Set(cards.filter((c) => c.you).map((c) => c.sid));
    const card = (id: string, title: string, who: string, text: string, since: number): BoardCard => ({ id: `need|${id}`, sid: "", lane: "", title, task: "", agent: who, tool: null, column: "needs", status: "Needs you", detail: text, branch: "", files: 0, pr: null, at: since, you: true, mine: true });
    cards = [
      ...cards,
      ...needs.filter((n) => !n.sid || !onBoard.has(n.sid)).map((n) => card(n.id, n.title, n.who, n.text, n.since)),
      ...(reviewing?.review ?? []).filter((p) => !off?.has(`review~${p.url}`)).map((p) => card(`review~${p.url}`, p.repo, p.author, `Asked for your review: #${p.number} ${p.title}`, Date.parse(p.requestedAt ?? p.createdAt ?? p.updatedAt) || 0)),
    ];
  }
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
  // What the search and the project leave; "Needs you" narrows it further. The tabs' counts are of this, so they follow the
  // search, and All counts the idle ones too, which it shows under the lanes (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
  const found = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (cards ?? []).filter((c) => {
      if (project && projectOf.get(c.sid) !== project) return false;
      return !q || [c.title, c.agent, c.branch, c.task, c.status].some((t) => t.toLowerCase().includes(q));
    });
  }, [cards, query, project, projectOf]);
  const shown = useMemo(() => (onlyYou ? found.filter((c) => c.column === "needs" && c.you) : found), [found, onlyYou]);
  // A column key pressed on a column with nothing in it: the lane is marked a moment, and its emptiness said.
  const [ping, setPing] = useState<{ col: number; at: number } | null>(null);
  useEffect(() => {
    if (!ping) return;
    const t = setTimeout(() => setPing(null), 1400);
    return () => clearTimeout(t);
  }, [ping]);

  const by = (col: BoardColumn) => order(col, shown.filter((c) => c.column === col));
  const grid = COLUMNS.map((c) => by(c.id));
  // The strip: each thing waiting on you that can be answered here, then the rest of what sits in Needs you (a pull request
  // asked of you, an agent waiting on somebody else) as cards to open.
  const q = query.trim().toLowerCase();
  const open = (needItems ?? []).filter((n) => !n.putOff && !gone.has(n.id) && n.kind !== "review" && (!project || !n.where.sid || projectOf.get(n.where.sid) === project) && (!q || [n.text, n.who, n.where.title].some((t) => t.toLowerCase().includes(q))));
  const answered = new Set((needItems ?? []).map((n) => n.id));
  const askingSids = new Set((needItems ?? []).filter((n) => !n.putOff && n.where.sid).map((n) => n.where.sid!));
  const rest = by("needs").filter((c) => (c.id.startsWith("need|") ? !answered.has(c.id.slice(5)) || c.id.startsWith("need|review~") : !needItems || !askingSids.has(c.sid) || !c.you));
  const cardOf = (sid?: string) => (sid ? (cards ?? []).find((c) => c.sid === sid && c.column === "needs") ?? (cards ?? []).find((c) => c.sid === sid) : undefined);
  const waitingOnYou = needItems ? open.length + rest.filter((c) => c.you).length : found.filter((c) => c.column === "needs" && c.you).length;
  const running = found.filter((c) => c.column === "working").length;
  const readyN = found.filter((c) => c.column === "ready").length;
  /** A card's one action: its pull request (its checks when they fail), Merge when it is ready, or a review asked of you. */
  const actionOf = (c: BoardCard): CardAction | null => {
    if (c.id.startsWith("need|review~")) return onReview ? { label: "Review", title: "Open it in Code Review", run: onReview } : null;
    if (!c.pr || c.gh?.state === "merged" || c.gh?.state === "closed") return null;
    const n = c.pr.number ? `#${c.pr.number}` : "PR";
    if (c.column === "ready" && linked && c.mine && c.gh && !c.gh.draft && c.gh.checks !== "failing" && c.gh.mergeable !== false)
      return {
        label: "Merge",
        title: `Squash and merge ${n} on GitHub`,
        primary: true,
        run: () =>
          setConfirm({
            title: `Squash and merge ${n}?`,
            body: `${c.title} goes into its base branch. This can't be undone from here.`,
            action: "Squash and merge",
            danger: false,
            onConfirm: async () => {
              await hostApi(identity, "/api/runner/pr.act", { method: "POST", body: JSON.stringify({ url: c.pr!.url, action: "merge", method: "squash" }) });
              dispatchEvent(new Event("friday:attention"));
            },
          }),
      };
    if (c.gh?.checks === "failing") return { label: `${n} checks`, title: "Its failing checks, on GitHub", icon: true, run: () => openOutside(`${c.pr!.url}/checks`) };
    return { label: n, title: "Open the pull request on GitHub", icon: true, run: () => openOutside(c.pr!.url) };
  };
  const active = found.length;
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
      else if (/^[1-3]$/.test(e.key)) {
        if (!go(Number(e.key) - 1, 0)) setPing({ col: Number(e.key) - 1, at: Date.now() });
      }
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
  // No sessions: nothing to read, and anything started shows at once, so it is Live, not "Reading…" forever (audit REST-3).
  const freshness = hidden ? "Paused while hidden" : failed ? (cards === null ? "Couldn't load" : "Couldn't refresh, showing the last answer") : ago === null ? (cards?.length === 0 ? "Live" : "Reading…") : ago < 5 ? "Live" : `Updated ${ago < 60 ? `${ago}s` : relTime(at)} ago`;
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
              // Escape clears the search and leaves it: left filled, the board stayed narrowed by a search no longer in view
              // (audit e2e, Arun 2026-11-04).
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                setQuery("");
                e.currentTarget.blur();
              }}
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
          <div className="ml-auto flex items-center gap-3">
            {/* The board in a line: how many run, wait on you and are ready, so a glance says whether to look further. */}
            {cards !== null && found.length > 0 && (
              <span className="hidden text-[12px] text-[var(--text-muted)] tabular-nums @min-[720px]:inline">
                {[`${running} running`, waitingOnYou ? `${waitingOnYou} need${waitingOnYou === 1 ? "s" : ""} you` : "", readyN ? `${readyN} ready` : ""].filter(Boolean).join(" · ")}
              </span>
            )}
            <PageTabs<"all" | "you">
              label="Show"
              value={onlyYou ? "you" : "all"}
              onChange={(v) => setFilter({ onlyYou: v === "you" })}
              options={[
                // A count only when there is one: an empty slot kept for it left a gap after "Needs you" (Arun, 2026-11-07: "make the
                // space next to needs you dynamic").
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
              <div className="flex items-center gap-3 border-b border-[var(--border)] px-1 pb-3 text-[13px] text-[var(--ink-2)]" role="status">
                Nothing on the board matches{query ? ` “${query.trim()}”` : " these filters"}.
                <Button variant="outline" size="sm" className="ml-auto h-7" onClick={() => (setQuery(""), setFilter({ project: "", onlyYou: false }))}>
                  Clear filters
                </Button>
              </div>
            )}
            <span className="sr-only" role="status">
              {ping ? `${COLUMNS[ping.col]!.title}: ${onlyYou && ping.col > 0 ? "not shown while Needs you is picked" : "nothing here"}` : ""}
            </span>
            {/* Needs you, across the top: answered here, and the agent carries on (design A). Not there when nothing waits. */}
            {/* Kept a moment after the last answer, so what was sent is said where it was answered. */}
            {(open.length > 0 || rest.length > 0 || onlyYou || !!said) && (
              <section className="mt-1 flex flex-col gap-2" aria-label={`Needs you, ${open.length + rest.length}`}>
                <div className="flex h-7 items-center gap-2 px-1">
                  <Dot state="needs" />
                  <span className="text-[13px] font-semibold text-[var(--ink)]">Needs you</span>
                  <Count n={open.length + rest.length} needs={open.length + rest.length > 0} />
                  <span className="truncate text-[12px] text-[var(--text-muted)]">{said || (open.length ? "Answer here and the agent carries on" : "")}</span>
                  <span className="sr-only" role="status">
                    {said}
                  </span>
                </div>
                {open.length + rest.length === 0 ? (
                  <p className="m-0 px-1 text-[13px] text-[var(--text-muted)]">Nothing is waiting on you.</p>
                ) : (
                  <div className="grid grid-cols-1 items-start gap-2 @min-[720px]:grid-cols-2 @min-[1180px]:grid-cols-3">
                    {open.map((n) => (
                      <NeedCard key={n.id} need={n} card={cardOf(n.where.sid)} solo={solo} busy={answering === n.id} error={needError?.id === n.id ? needError.text : ""} onAnswer={(v, edited) => void answer(n, v, edited)} onOpen={() => onOpen(n.where.sid ?? "")} />
                    ))}
                    {rest.map((c) => (
                      <Card key={c.id} card={c} onOpen={onOpen} solo={solo} focused={focus === c.id} onFocus={() => setFocus(c.id)} action={actionOf(c)} />
                    ))}
                  </div>
                )}
              </section>
            )}
            <div className={cn("mt-1 grid grid-cols-1 items-start gap-3 @min-[480px]:grid-cols-2 @min-[720px]:grid-cols-3", onlyYou && "hidden")}>
              {COLUMNS.map((col, i) => {
                const list = grid[i]!;
                const wide = false;
                return (
                  // A lane: a quiet well the cards sit in, its head saying what is in it, how many, and its key.
                  <section key={col.id} data-ping={ping?.col === i ? ping.at : undefined} className={cn("board-lane group/lane flex min-w-0 flex-col gap-1.5 rounded-xl bg-[var(--card)] p-1.5 shadow-[inset_0_0_0_1px_var(--border)]", wide && "col-span-full")} aria-label={`${col.title}, ${list.length}`}>
                    <Tip label={col.hint} keys={String(i + 1)}>
                      <div className="flex h-8 items-center gap-2 px-2">
                        <Dot state={DOT[col.id]} />
                        <span className="text-[13px] font-semibold text-[var(--ink)]">{col.title}</span>
                        <Count n={list.length} />
                        <kbd aria-hidden className="ml-auto opacity-0 transition-opacity duration-[var(--dass-fast)] group-hover/lane:opacity-100">
                          {i + 1}
                        </kbd>
                      </div>
                    </Tip>
                    <div className={wide ? "grid grid-cols-1 gap-1.5 @min-[480px]:grid-cols-2 @min-[720px]:grid-cols-4" : "flex flex-col gap-1.5"}>
                      {list.filter((c) => !isQuick(c)).map((c) => (
                        <Card key={c.id} card={c} onOpen={onOpen} solo={solo} focused={focus === c.id} onFocus={() => setFocus(c.id)} action={actionOf(c)} />
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
                              <Card key={c.id} card={c} onOpen={onOpen} solo={solo} focused={focus === c.id} onFocus={() => setFocus(c.id)} action={actionOf(c)} />
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
                          // An empty column is its heading and its 0 (2026-10-29 direction §9.4): no box saying so; said to a
                          // screen reader only.
                          <p className="sr-only">{filtered ? "Nothing here matches" : col.empty}</p>
                        ))}
                    </div>
                  </section>
                );
              })}
            </div>

            {/* Sessions with nothing running: folded under a hairline, so the four lanes stay the board. */}
            {/* Shown only when something is idle: "Idle 0 · Nothing running" said nothing worth a line. */}
            {!onlyYou && idle.length > 0 && (
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
                  {!idle.length && <div className="px-2 text-[13px] text-[var(--text-muted)]">Nothing idle</div>}
                </div>
              </CollapsibleContent>
            </Collapsible>
            )}
          </>
        )}

        {/* As in a session: the week and whether the board is live on the left, the keys on the right. */}
        <footer className="status-bar bd-status-bar mx-[-24px]! max-[640px]:mx-[-16px]!" aria-label="Agent Board status">
          <div className="stb-start">
            <span className="stb-run" role="status">
              <Dot state={failed ? "bad" : hidden || (ago === null && cards?.length !== 0) ? "idle" : "done"} />
              <span className="stb-run-text">{freshness}</span>
            </span>
            {week && (week.sessions || week.runs) ? (
              <span className="stb-item stb-quiet">
                This week: {week.sessions} session{week.sessions === 1 ? "" : "s"} · {week.shipped} shipped · {week.runs} run{week.runs === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          {/* The keys move between cards, so with no card to move to (none yet, or the first reading failed) they aren't offered
              (audit REST-30). */}
          {!!cards?.length && (
            <div className="stb-end rv-status-keys" aria-hidden>
              <span><kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> Move</span>
              <span><kbd>↵</kbd> Open</span>
              <span><kbd>1</kbd>–<kbd>3</kbd> Column</span>
              <span><kbd>/</kbd> Search</span>
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}
