import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AutopilotButton, PilotTimeline, pilotWords, useAutopilot } from "./autopilot-ui.js";
import type { PilotPrRecord } from "../autopilot.js";
import type { BoardCard } from "../board.js";
import { commentFor, fixesOf, loadOf, matches, mergeFindings, pileOf, risksOf, shortDuration, sizeOf, stepsOf, waitedMs, type AgreedFinding, type Mark } from "../code-review.js";
import type { PullRequest } from "../runner/workspace.js";
import { riskOfPr, type Risk } from "../review-risk.js";
import { RiskChip } from "./reviewRisk.js";
import { ENGINE_NAMES, ENGINE_TOOLS, type EngineTool, type ReviewFinding } from "../types.js";
import { api } from "./api.js";
import { EngineMark } from "./BrandMarks.js";
import { FileIcon } from "./fileIcons.js";
import { GitHubConnect, machineError, useGithub } from "./GitHubConnect.js";
import { isLocal } from "./edition.js";
import { reviewInIde } from "./ide/pr-review.js";
import { Icon } from "./icons.js";
import { RELEASES, connectThisComputer, hostApi, useMachine } from "./local.js";
import { openOutside } from "./openOutside.js";
import { refreshPrs, reviews, runReview, setAuto, useAuto, usePrs, useReviews } from "./prWatch.js";
import { ReviewTour } from "./ReviewTour.js";
import { loadRecents, type Identity, type RecentSession } from "./storage.js";
import { PrProof } from "./PrProof.js";
import { ConfirmDialog, SkeletonRows, agoWords, isTyping, relTime, type Confirmation } from "./ui.js";
import { CheckIcon, ChevronDownIcon, EllipsisIcon, ExternalLinkIcon, FolderIcon, GitBranchIcon, GitPullRequestIcon, RefreshCwIcon, SearchIcon, ShieldIcon, TriangleAlertIcon, UserIcon, XIcon } from "lucide-react";
import { TabRing, useNow } from "./presence.js";
import { askCard } from "./card-ask.js";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/dass";
import { EmptyState as DassEmpty } from "@/components/dass/EmptyState";
import { Count, Dot, Tip, type DotState } from "@/components/dass/page-bits";

/**
 * Code Review: your pull requests, as an inbox.
 *
 * Read from GitHub by your own computer, signed in as you (Connect GitHub when it has no login yet). On the left, the
 * queue: each pull request with one line saying where it stands ("Checks failing", "Ready to merge", "Waiting 3d on
 * you"). On the right, the one picked: what happens next, said as a sentence with the button that does it at the end of
 * the row; the three things between it and merging (checks, review, merge); your own agents' review; and its files.
 * Merging, approving and re-running happen here, as you; a blocker can be handed to a session that fixes it.
 */

const POLL_MS = 60_000;
/**
 * One list of every pull request (Arun, 2026-11-20: "a complete redesign of the code review page, i only want to show PRs... with the
 * most recent PRs decending order"): yours, the ones waiting on your review, your team's and yours merged lately, newest first,
 * narrowed by a filter. It replaced five tabs (Needs you, Yours, Team, Merged, Issues).
 */
type Filter = "all" | "mine" | "review" | "team" | "merged";
const FILTER_KEY = "friday.review.filter";
const FILTERS: { value: Filter; label: string; tip: string }[] = [
  { value: "all", label: "All", tip: "Every pull request here, newest first" },
  { value: "mine", label: "Yours", tip: "Your open pull requests" },
  { value: "review", label: "To review", tip: "Waiting on your review" },
  { value: "team", label: "Team", tip: "Everyone else's in your repos" },
  { value: "merged", label: "Merged", tip: "Yours merged this week" },
];
const filterOf = (kind: Kind): Filter => (kind === "review" ? "review" : kind === "team" ? "team" : kind === "merged" ? "merged" : "mine");
// Kept for the visit, so coming back to the tab shows the last answer at once while a fresh one is fetched.
let lastTeam: PullRequest[] | null = null;

export type WorkOptions = { shepherd?: boolean };

type Kind = "review" | "ready" | "fix" | "waiting" | "draft" | "team" | "merged";
/** A key pressed on the page, for the open pull request to carry out. `n` makes the same key twice two commands. */
type Cmd = { key: "github" | "merge" | "approve"; n: number };

// ── the page ─────────────────────────────────────────────────────────

export function CodeReview({
  identity,
  recents = [],
  onWork,
  onOpen,
}: {
  identity: Identity;
  recents?: RecentSession[];
  /** A new session, its box filled with this: the pull request's link, and what to do with it. */
  onWork: (brief: string, opts?: WorkOptions) => void;
  /** A session opened by its id, with its link when the page has it (autopilot's, which may not be on the sidebar). */
  onOpen?: (sid: string, invite?: string) => void;
}) {
  const { state: machine } = useMachine(identity);
  const linked = machine.mode === "local" || machine.mode === "linked";
  const { prs, error: prsError, busy } = usePrs();
  const [team, setTeam] = useState<PullRequest[] | null>(lastTeam);
  const [teamError, setTeamError] = useState("");
  const [n, setN] = useState(0);
  const [filter, setFilterState] = useState<Filter>(() => {
    try {
      const f = localStorage.getItem(FILTER_KEY) as Filter | null;
      return f && FILTERS.some((x) => x.value === f) ? f : "all";
    } catch {
      return "all";
    }
  });
  const setFilter = (f: Filter) => {
    setFilterState(f);
    try {
      localStorage.setItem(FILTER_KEY, f);
    } catch {
      /* the filter is only for this visit */
    }
  };
  const [query, setQuery] = useState("");
  const [repo, setRepo] = useState("");
  const [cards, setCards] = useState<BoardCard[]>([]);
  const gh = useGithub(identity, linked);

  // The app keeps them current every few minutes; on screen, every minute, and at once when the window comes back.
  useEffect(() => {
    if (!linked) return;
    void refreshPrs(identity);
    const t = setInterval(() => !document.hidden && void refreshPrs(identity), POLL_MS);
    const back = () => !document.hidden && void refreshPrs(identity);
    document.addEventListener("visibilitychange", back);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", back);
    };
  }, [identity.id, linked, n]); // eslint-disable-line react-hooks/exhaustive-deps

  // The sessions this browser knows, for "made in a session" and "Friday is seeing it through".
  const sids = recents.map((r) => r.sid).join(",");
  useEffect(() => {
    if (!sids) return;
    let live = true;
    api<{ cards: BoardCard[] }>(identity, "/api/board", { method: "POST", body: JSON.stringify({ sids: sids.split(",") }) }).then(
      (r) => live && setCards(r.cards),
      () => {},
    );
    return () => void (live = false);
  }, [identity.id, sids, n, prs]);
  const sessionFor = useMemo(() => {
    const m = new Map<string, BoardCard>();
    for (const c of cards) {
      for (const url of [c.pr?.url, c.prFrom]) if (url && (!m.has(url) || c.shepherd)) m.set(url, c);
    }
    return m;
  }, [cards]);

  // The Team tab's repos: the ones you can push to, and the ones somebody asked you to review in. Every repo you ever sent a pull
  // request to (an awesome list, microsoft/winget-pkgs) isn't your team's, and searching them all made GitHub answer 502, so the
  // tab could never load (Arun, 2026-11-19). A runner from before canPush was read sends none: then every repo, as before.
  const repos = useMemo(() => {
    const all = [...(prs?.mine ?? []), ...(prs?.review ?? []), ...(prs?.merged ?? [])];
    const known = all.some((p) => p.canPush !== undefined);
    const asked = new Set((prs?.review ?? []).map((p) => p.repo));
    return [...new Set(all.filter((p) => !known || p.canPush || asked.has(p.repo)).map((p) => p.repo))];
  }, [prs]);
  // A failed read of the team's pull requests is the Team filter's to say, not the whole page's (Arun's screenshots, 2026-11-19:
  // "GitHub answered 502." over all five tabs).
  const error = prsError || (filter === "team" ? teamError : "");
  useEffect(() => {
    // Your login too: every repo of yours is your team's, a pull request of yours there or not (an outside contributor's on
    // splashxmoon/friday-code never showed, Arun 2026-11-19). A runner from before that ignores it.
    const owner = prs?.account ?? "";
    if (!linked || (!repos.length && !owner)) return;
    let live = true;
    hostApi<{ team: PullRequest[] }>(identity, `/api/runner/prs.team?repos=${encodeURIComponent(repos.join(","))}${owner ? `&owner=${encodeURIComponent(owner)}` : ""}`).then(
      (r) => live && (setTeam((lastTeam = r.team)), setTeamError("")),
      (e) => live && (setTeam((t) => t ?? []), setTeamError(machineError(e))),
    );
    return () => void (live = false);
  }, [linked, repos.join(","), prs?.account, n]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every pull request once, as what it is to you: one waiting on your review, one of yours by where it stands, one merged, a
  // teammate's. Newest first: by when it last changed, a merged one by when it merged.
  const all = useMemo(() => {
    const seen = new Map<string, { pr: PullRequest; kind: Kind }>();
    for (const pr of prs?.review ?? []) seen.set(pr.url, { pr, kind: "review" });
    for (const pr of prs?.mine ?? []) if (!seen.has(pr.url)) seen.set(pr.url, { pr, kind: pileOf(pr) as Kind });
    for (const pr of prs?.merged ?? []) if (!seen.has(pr.url)) seen.set(pr.url, { pr, kind: "merged" });
    for (const pr of team ?? []) if (!seen.has(pr.url)) seen.set(pr.url, { pr, kind: "team" });
    return [...seen.values()];
  }, [prs, team]);
  const whenOf = (i: { pr: PullRequest; kind: Kind }) => Date.parse(i.kind === "merged" ? (i.pr.mergedAt ?? i.pr.updatedAt) : i.pr.updatedAt) || 0;
  const counts = Object.fromEntries(FILTERS.map((f) => [f.value, f.value === "all" ? all.length : all.filter((i) => filterOf(i.kind) === f.value).length])) as Record<Filter, number>;
  const inFilter = all.filter((i) => filter === "all" || filterOf(i.kind) === filter);
  const list = inFilter.map((i) => i.pr);
  const tabRepos = [...new Set(list.map((p) => p.repo))];
  const shown = inFilter.filter((i) => (!repo || i.pr.repo === repo) && matches(i.pr, query)).sort((a, b) => whenOf(b) - whenOf(a));
  const refresh = () => setN((x) => x + 1);
  const tools = machine.tools.filter((t) => t.path && t.loggedIn !== false).map((t) => t.tool);
  const auto = useAuto();
  useReviews();
  const pilots = useAutopilot(identity);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);

  // How risky each is to wave through (review-risk.ts): GitHub's files and checks, what its session knows when an agent of
  // yours made it, and what your agents' review of its current head found.
  const riskFor = (pr: PullRequest): Risk => {
    const card = sessionFor.get(pr.url);
    const run = reviews.get(pr.url);
    const found = run && (!pr.head || !run.head || run.head === pr.head) ? mergeFindings(run.results) : [];
    return riskOfPr(pr, card?.pr?.url === pr.url ? card.review : undefined, found);
  };
  const risks = new Map(list.map((p) => [p.url, riskFor(p)]));

  const order = shown;
  const [sel, setSel] = useState("");
  /** Nothing here and nothing filtered out: the page says so across its width. */
  const blank = !shown.length && !query && !repo && !(filter === "team" && team === null);
  const teamFailed = filter === "team" && !!teamError && !team?.length;
  const current = shown.find((i) => i.pr.url === sel) ?? shown[0];
  const [cmd, setCmd] = useState<Cmd | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const keys = useRef({ order, current, tools, auto, setFilter, refresh });
  keys.current = { order, current, tools, auto, setFilter, refresh };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector(".overlay")) {
        if (e.key === "Escape" && document.activeElement === search.current) search.current?.blur();
        return;
      }
      const k = keys.current;
      const at = k.order.findIndex((i) => i.pr.url === k.current?.pr.url);
      const send = (key: Cmd["key"]) => setCmd((c) => ({ key, n: (c?.n ?? 0) + 1 }));
      const f = ({ "1": "all", "2": "mine", "3": "review", "4": "team", "5": "merged" } as Record<string, Filter>)[e.key];
      if (e.key === "/") search.current?.focus();
      else if (f) (k.setFilter(f), setSel(""));
      else if (e.key === "j" || e.key === "ArrowDown") setSel(k.order[Math.min(k.order.length - 1, at + 1)]?.pr.url ?? "");
      else if (e.key === "k" || e.key === "ArrowUp") setSel(k.order[Math.max(0, at - 1)]?.pr.url ?? "");
      else if (e.key === "g") send("github");
      else if (e.key === "m") send("merge");
      else if (e.key === "a") send("approve");
      else if (e.key === "R") k.refresh();
      else if (e.key === "r") {
        const pr = k.current?.pr;
        const use = k.auto.tools.filter((t) => k.tools.includes(t));
        if (!pr || !k.tools.length) return;
        void runReview(identity, pr, use.length ? use : k.tools.slice(0, 1));
      } else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [identity.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const ctx: Ctx = { identity, onWork, onOpen, sessionFor, refresh, tools };

  const ready = linked && !!prs?.available;
  const empty =
    query || repo
      ? "No pull request matches that."
      : filter === "review"
        ? "Nobody is waiting on your review."
        : filter === "mine"
          ? "You have no open pull requests."
          : filter === "merged"
            ? "Nothing of yours merged this week."
            : filter === "team"
              ? repos.length || prs?.account
                ? "Nobody else has a pull request open in your repos."
                : "Your repos show here once you have a pull request in one."
              : "No pull requests yet. Ones you open, and ones you're asked to review, show here.";

  // The list and the pull request side by side: shown once the pull requests are read and there are some to show.
  const split = !!prs && !!prs.available && linked && !(error && !prs) && !(machine.mode === "checking" && !prs);
  // The page's own controls: which pull requests, refresh, and the way out to GitHub.
  const controls = ready && (
    <>
            <AutopilotButton identity={identity} tools={tools} {...(onOpen ? { onOpen } : {})} />
            <Tip label={busy ? "Checking…" : "Refresh"} keys="⇧R">
              <Button variant="ghost" size="icon-sm" aria-label="Refresh" disabled={busy} onClick={refresh} className="text-[var(--text-muted)] hover:text-[var(--ink)]">
                <RefreshCwIcon className={busy ? "animate-spin" : ""} />
              </Button>
            </Tip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More" className="text-[var(--text-muted)] hover:text-[var(--ink)]">
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => openOutside("https://github.com/pulls")}>
                  <ExternalLinkIcon /> Your pull requests on GitHub
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
  );

  return (
    // The whole width: 24px either side, the list growing a little on wide windows and the pull request taking the rest.
    // The list and the open pull request run closer to the window's edges, the pane's scroll bar at the right edge (Arun,
    // 2026-11-07: "there is still some space here, utilize it", "reduce the same on the left side as well slightly").
    <div className={`page conns-page review-page ${ready ? "inbox pr-0! pl-3!" : "px-6!"} max-[640px]:px-4!`}>
      <div className="page-inner">
        <PageHeader
          className="mb-0 shrink-0"
          title="Code Review"
          subtitle="Every pull request of yours and your team's, newest first."
          // With the list showing, the tabs and buttons sit over the pull request, so the list can run up level with them.
          actions={ready && !split ? controls : undefined}
        />

        {machine.mode === "checking" && !prs ? (
          <SkeletonRows rows={4} />
        ) : !linked ? (
          <EmptyState
            title="Connect this computer"
            body={
              window.fridayDesktop?.link
                ? "Your pull requests are read from GitHub by your own computer, signed in as you. Friday's desktop app connects this computer on its own; this updates once it has."
                : "Your pull requests are read from GitHub by your own computer, signed in as you. Connect this computer with one command in a terminal, or use the desktop app."
            }
            actions={
              !window.fridayDesktop?.link && (
                <>
                  <Button variant="ghost" onClick={() => openOutside(RELEASES)}>
                    Get the desktop app
                  </Button>
                  <Button onClick={connectThisComputer}>Connect this computer</Button>
                </>
              )
            }
          />
        ) : error && !prs ? (
          <EmptyState tone="bad" title="Couldn't read your pull requests" body={error} actions={<Button onClick={refresh}>Try again</Button>} />
        ) : prs && !prs.available ? (
          gh.status && !gh.status.connected ? (
            <NoGitHub identity={identity} recents={recents} gh={gh} onOpen={onOpen} onConnected={() => (void gh.read(), refresh())} />
          ) : (
            <EmptyState tone="bad" title="GitHub isn't answering" body={prs.reason || "Your pull requests couldn't be read just now."} actions={<Button onClick={refresh}>Try again</Button>} />
          )
        ) : !prs ? (
          <SkeletonRows rows={4} />
        ) : (
          <>
          {/* A narrow window stacks the list over the open one: the tabs go first, not down between the two (they sat mid-page). */}
          <div className="page-top mb-2 hidden shrink-0 flex-wrap items-center justify-end gap-2 max-[720px]:flex">{controls}</div>
          {(
          // A filter with nothing in it is said once, across the page: no list column standing empty beside it with a search box
          // for nothing (Arun, 2026-11-19: "fix the design of the code review pages").
          <div className={cn("rv-split gap-5!", blank ? "min-[721px]:grid-cols-1!" : "min-[721px]:grid-cols-[clamp(320px,30%,460px)_minmax(0,1fr)]!")}>
            {!blank && (
            <aside className="rv-queue" aria-label="Pull requests">
              <div className="page-top-in flex items-center gap-2 border-b border-[var(--border)] p-2">
                <div className="relative min-w-0 flex-1">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
                  <Input
                    ref={search}
                    value={query}
                    placeholder="Search"
                    aria-label="Search pull requests"
                    className="h-8 rounded-[9px] border-[var(--border-strong)] bg-[var(--card)] pr-8 pl-8 text-[13px] shadow-none placeholder:text-[var(--text-muted)] focus-visible:border-[var(--border-focus)] focus-visible:ring-0 md:text-[13px]"
                    onChange={(e) => setQuery(e.target.value)}
                  />
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
                {tabRepos.length > 1 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" aria-label="Which repo" className="h-8 max-w-[150px] border-[var(--border)] bg-[var(--bg)] px-2.5 text-[13px] shadow-none">
                        <FolderIcon />
                        <span className="truncate">{repo ? repo.split("/")[1] : "All repos"}</span>
                        <ChevronDownIcon className="opacity-60" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuRadioGroup value={repo} onValueChange={setRepo}>
                        <DropdownMenuRadioItem value="">All repos</DropdownMenuRadioItem>
                        {tabRepos.map((r) => (
                          <DropdownMenuRadioItem key={r} value={r}>
                            {r}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              {/* What to show: everything, or one kind, each with how many (Arun, 2026-11-20). Newest first in each. */}
              <div className="rv-filters" role="radiogroup" aria-label="Show">
                {FILTERS.map((f) => (
                  <button key={f.value} type="button" role="radio" aria-checked={filter === f.value} title={f.tip} className="rv-filter" data-kind={f.value} onClick={() => (setFilter(f.value), setSel(""))}>
                    {f.label}
                    {counts[f.value] > 0 && <span className="rv-filter-n">{counts[f.value]}</span>}
                  </button>
                ))}
              </div>
              {error && <Stale error={error} busy={busy} onRetry={refresh} />}
              {filter === "team" && team && <Load prs={team} />}
              <div className="rv-queue-list">
                {filter === "team" && team === null ? (
                  <SkeletonRows rows={3} />
                ) : shown.length ? (
                  <div className="flex flex-col gap-1">
                    {shown.map(({ pr, kind }) => (
                      <QueueItem key={pr.url} pr={pr} kind={kind} on={current?.pr.url === pr.url} working={ctx.sessionFor.get(pr.url)} pilot={kind === "merged" ? undefined : pilots?.prs.get(pr.url)} risk={kind === "merged" ? undefined : risks.get(pr.url)} when={whenOf({ pr, kind })} showKind={filter === "all"} onPick={() => setSel(pr.url)} />
                    ))}
                  </div>
                ) : null /* Said once, in the pane beside it, with the way on. */}
              </div>
              {filter === "review" && <AutoReview tools={tools} />}
            </aside>
            )}
            <section className="rv-pane" aria-label="Pull request">
              {/* The page's tabs and buttons, level with the top of the list beside it (Arun, 2026-10-19). */}
              {/* The same height and padding as the search bar beside it, so the two rows share one centre line (Arun, 2026-11-18:
                  "tese need to be lined up properly"). */}
              {ready && <div className="page-top mb-4 flex min-h-12 shrink-0 items-center justify-end gap-2 py-2 max-[720px]:hidden">{controls}</div>}
              {blank && error && !teamFailed && <Stale error={error} busy={busy} onRetry={refresh} className="mx-auto w-full max-w-[440px] rounded-lg border" />}
              {current ? (
                <Pane key={current.pr.url} pr={current.pr} kind={current.kind} ctx={ctx} cmd={cmd} risk={risks.get(current.pr.url)} />
              ) : filter === "team" && team === null ? null /* Still reading: "nobody has one open" said beside the loading rows wasn't true yet. */ : teamFailed ? (
                <DassEmpty className="mt-16" tone="bad" icon={<GitPullRequestIcon />} title="Couldn't read your team's pull requests" action={<Button variant="outline" size="sm" disabled={busy} onClick={refresh}>Try again</Button>}>
                  {said(teamError)}
                </DassEmpty>
              ) : (
                <DassEmpty
                  className="mt-16"
                  icon={<GitPullRequestIcon />}
                  title={empty}
                  action={
                    // The one next step from an empty tab: your own pull requests when nobody waits on you, a session when you have none.
                    query || repo ? (
                      <Button variant="outline" size="sm" onClick={() => (setQuery(""), setRepo(""))}>
                        Clear filters
                      </Button>
                    ) : filter !== "all" && all.length > 0 ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setFilter("all");
                          // The button goes with the empty filter it sat in: focus follows to the filter now chosen.
                          requestAnimationFrame(() => document.querySelector<HTMLElement>('.review-page .rv-filter[aria-checked="true"]')?.focus());
                        }}
                      >
                        See all · {all.length}
                      </Button>
                    ) : filter === "mine" || filter === "all" ? (
                      <Button size="sm" onClick={() => onWork("")}>
                        Start a session
                      </Button>
                    ) : undefined
                  }
                />
              )}
              {/* Nobody waiting yet: whether your agents read each one first is the one thing to set here. */}
              {blank && filter === "review" && !teamFailed && <AutoReview tools={tools} className="mx-auto mt-6 w-full max-w-[440px] rounded-lg border border-[var(--border)]" />}
            </section>
          </div>
        )}
          </>
        )}
        {confirm && <ConfirmDialog confirmation={confirm} onClose={() => setConfirm(null)} />}
        {ready && (
          // As in a session: who you are on GitHub and whether it's checking on the left, the keys on the right.
          <footer className={cn("status-bar rv-status max-[640px]:mx-[-16px]!", ready ? "mr-0! ml-[-12px]!" : "mx-[-24px]!")} aria-label="Code Review status">
            <div className="stb-start">
              <span className="stb-item stb-quiet">
                <GitPullRequestIcon className="size-3.5" /> @{prs!.account ?? "you"} on GitHub
              </span>
              {busy && <span className="stb-item stb-quiet">Checking…</span>}
            </div>
            <div className="stb-end rv-status-keys" aria-hidden>
              <span><kbd>J</kbd><kbd>K</kbd> Move</span>
              <span><kbd>A</kbd> Approve</span>
              <span><kbd>M</kbd> Merge</span>
              <span><kbd>1</kbd>–<kbd>5</kbd> Filters</span>
              <span><kbd>R</kbd> Agent review</span>
              <span><kbd>G</kbd> GitHub</span>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}

/** A read that failed, in words: "GitHub answered 502." is GitHub not answering, which is what a person needs to know. */
const said = (error: string) => (/GitHub answered 5\d\d/.test(error) ? "GitHub didn't answer just now. It usually does again in a moment." : error);

/**
 * GitHub didn't answer this time, though what it said before is still on screen: said once, quietly, with the way to ask again.
 * It was a red line over the list on every tab (Arun's screenshots, 2026-11-19), louder than anything it was about.
 */
function Stale({ error, busy, onRetry, className }: { error: string; busy?: boolean; onRetry: () => void; className?: string }) {
  return (
    <p role="status" title={error} className={cn("m-0 flex items-center gap-2 border-[var(--border)] px-3 py-2 text-[12px] leading-snug text-[var(--text-muted)]", className ?? "border-b")}>
      <TriangleAlertIcon className="size-3.5 shrink-0 text-[var(--amber)]" aria-hidden />
      <span className="min-w-0 flex-1">{said(error)}</span>
      <Button variant="ghost" size="xs" className="h-6 shrink-0 text-[12px] text-[var(--ink-2)]" disabled={busy} onClick={onRetry}>
        Try again
      </Button>
    </p>
  );
}

/** The page with nothing to show yet: Dass's empty state, with the pull request mark on its tile. */
// ── no GitHub yet: the branches the agents have ready ──────────────────

/** Lines added and taken away across what an agent changed (the Agent Board's Ready column reads it the same way, Board.tsx sizeOf). */
function branchSize(card: BoardCard): { files: number; add?: number; del?: number } | null {
  const f = card.review;
  if (f?.fileCount) {
    const fs = f.files ?? [];
    if (!fs.some((x) => x.additions || x.deletions)) return { files: f.fileCount };
    return { files: f.fileCount, add: fs.reduce((n, x) => n + (x.additions ?? 0), 0), del: fs.reduce((n, x) => n + (x.deletions ?? 0), 0) };
  }
  return card.files > 0 ? { files: card.files } : null;
}

/** What a committed branch's agent is told by Push & open PR: its own commit is there, so it pushes and opens the pull request. */
const PUSH_ASK = "Push this branch and open a pull request for it with gh pr create: a title and a short description of what changed and how it was checked. Don't merge it.";

/**
 * Code Review with no GitHub on this computer (spec 13, "Where it sits still" 9): not only "Connect GitHub", but the branches the
 * agents have ready, the Agent Board's Ready column (/api/board), each with its session, its files and lines, when it finished, and
 * Push & open PR. That press connects GitHub first (a sheet with the same Connect GitHub as everywhere), then does it: changes not
 * yet committed open the session's commit dialog at Push and open PR, its message drafted for you to look at; a branch already
 * committed is handed to its agent to push and open. Connect GitHub stays at the top for the rest of the page.
 */
function NoGitHub({ identity, recents, gh, onOpen, onConnected }: { identity: Identity; recents: RecentSession[]; gh: ReturnType<typeof useGithub>; onOpen?: (sid: string, invite?: string) => void; onConnected: () => void }) {
  const sids = recents.map((r) => r.sid).join(",");
  const [cards, setCards] = useState<BoardCard[] | null>(sids ? null : []);
  const [failed, setFailed] = useState("");
  const [trying, setTrying] = useState(false);
  const [pushing, setPushing] = useState<BoardCard | null>(null);
  const [said, setSaid] = useState("");
  // "done 4m ago" moves as time does.
  useNow(30_000);
  const read = useCallback(async () => {
    if (!sids) return setCards([]);
    try {
      const r = await api<{ cards: BoardCard[] }>(identity, "/api/board", { method: "POST", body: JSON.stringify({ sids: sids.split(",") }) });
      setCards(r.cards);
      setFailed("");
    } catch (e) {
      setFailed((e as Error).message || "Friday didn't answer.");
    }
  }, [identity.id, sids]); // eslint-disable-line react-hooks/exhaustive-deps
  // Live as the board is: every 15 seconds in sight, when the window comes back, and when work finishes or is answered.
  useEffect(() => {
    void read();
    const t = setInterval(() => !document.hidden && void read(), 15_000);
    const again = () => !document.hidden && void read();
    document.addEventListener("visibilitychange", again);
    addEventListener("friday:attention", again);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", again);
      removeEventListener("friday:attention", again);
    };
  }, [read]);
  const ready = (cards ?? []).filter((c) => c.column === "ready" && !c.pr).sort((a, b) => b.at - a.at);
  const inviteOf = (sid: string) => recents.find((r) => r.sid === sid)?.invite;

  /** GitHub is there: the push and the pull request, the session's own way. */
  const go = async (c: BoardCard) => {
    setSaid("");
    if (c.files > 0) {
      // Changes not yet committed: the session's commit dialog, at Push and open PR (card-ask.ts, RunReview takes it).
      askCard(c.sid, c.lane, "pr");
      onOpen?.(c.sid, inviteOf(c.sid));
      return;
    }
    const invite = inviteOf(c.sid);
    if (!invite) return setSaid("Open the session to push it: this browser doesn't have its link.");
    try {
      await api(identity, `/api/sessions/${encodeURIComponent(c.sid)}/instruct?invite=${encodeURIComponent(invite)}`, { method: "POST", body: JSON.stringify({ text: PUSH_ASK, lane: c.lane }) });
      onOpen?.(c.sid, invite);
    } catch (e) {
      setSaid((e as Error).message || "That didn't reach the agent.");
    }
  };
  const press = (c: BoardCard) => (gh.status?.connected ? void go(c) : setPushing(c));
  // Connecting, from the sheet: looked at every few seconds (a sign-in with gh in a terminal finishes outside the page), and once
  // GitHub is there the sheet closes and the push goes on. Done in the look itself, not after a redraw: the page shows the pull
  // requests as soon as GitHub is there, and this list with it is gone by then.
  const carry = useRef<BoardCard | null>(null);
  carry.current = pushing;
  const look = useCallback(async () => {
    const st = await gh.read();
    const c = carry.current;
    if (!st?.connected || !c) return;
    carry.current = null;
    setPushing(null);
    void go(c);
    onConnected();
  }, [gh.read, onConnected]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pushing) return;
    const t = setInterval(() => void look(), 3000);
    return () => clearInterval(t);
  }, [pushing, look]);

  const why = "See your pull requests here, have your own agents read each one first, and merge without leaving Friday.";
  if (cards !== null && !ready.length && !failed) return <GitHubConnect empty identity={identity} onChange={onConnected} why={why} />;
  return (
    <div className="rv-nogh mx-auto flex w-full max-w-[880px] flex-col gap-5 pt-4">
      <GitHubConnect identity={identity} onChange={onConnected} why={why} />
      <section aria-label="Ready to ship" className="flex flex-col gap-3">
        <header className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <h2 className="m-0 text-[14px] leading-[22px] font-semibold text-[var(--ink)]">
              Ready to ship {ready.length > 0 && <span className="ml-1 font-normal text-[var(--text-muted)] tabular-nums">{ready.length}</span>}
            </h2>
            <p className="m-0 text-[13px] leading-[18px] text-[var(--text-muted)]">Branches your agents finished. Push one and open its pull request: GitHub is connected on the way.</p>
          </div>
        </header>
        {said && (
          <p className="m-0 text-[13px] text-[var(--red)]" role="alert">
            {said}
          </p>
        )}
        {failed && cards === null ? (
          <DassEmpty
            small
            tone="bad"
            icon={<TriangleAlertIcon />}
            title="Couldn't read the agents' branches"
            action={
              <Button variant="outline" size="sm" disabled={trying} onClick={() => (setTrying(true), void read().finally(() => setTrying(false)))}>
                {trying ? "Trying…" : "Try again"}
              </Button>
            }
          >
            <span role="alert">{failed}</span>
          </DassEmpty>
        ) : cards === null ? (
          <div role="status" aria-label="Reading the agents' branches">
            <SkeletonRows rows={3} />
          </div>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Branches ready">
            {ready.map((c) => {
              const size = branchSize(c);
              return (
                <li key={c.id} className="rv-ready-row flex min-w-0 items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 max-[560px]:flex-wrap" data-ready={c.id}>
                  <span className="grid size-7 shrink-0 place-items-center rounded-full border border-[var(--border)] bg-[var(--bg)]" aria-hidden>
                    {c.tool ? <EngineMark tool={c.tool} size={14} /> : <GitBranchIcon className="size-3.5 text-[var(--text-muted)]" />}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[13.5px] leading-5 font-medium text-[var(--ink)]" title={c.task || c.title}>
                      {c.task || c.title}
                    </span>
                    {/* Its session (when the task isn't already its name), its branch, its size and when it finished, a dot between each. */}
                    <span className="rv-ready-meta flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] leading-4 text-[var(--text-muted)]">
                      {c.task && c.title !== c.task && <span className="max-w-[220px] truncate">{c.title}</span>}
                      {c.branch && (
                        <span className="inline-flex max-w-[200px] items-center gap-1 truncate font-mono text-[11.5px]">
                          <GitBranchIcon className="size-3 shrink-0" />
                          <span className="truncate">{c.branch}</span>
                        </span>
                      )}
                      {size && (
                        <span className="tabular-nums" title={`${size.files} file${size.files === 1 ? "" : "s"} changed`}>
                          {size.add !== undefined && (size.add || size.del) ? (
                            <>
                              <span className="text-[var(--green)]">+{size.add}</span> <span className="text-[var(--red)]">−{size.del}</span> in {size.files} file{size.files === 1 ? "" : "s"}
                            </>
                          ) : (
                            `${size.files} file${size.files === 1 ? "" : "s"}`
                          )}
                        </span>
                      )}
                      <span className="tabular-nums" title={new Date(c.at).toLocaleString()}>
                        {c.files > 0 ? "" : `${c.status} · `}
                        done {agoWords(c.at)}
                      </span>
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 max-[560px]:w-full max-[560px]:justify-end">
                    <Button variant="ghost" size="sm" onClick={() => onOpen?.(c.sid, inviteOf(c.sid))}>
                      Open
                    </Button>
                    <Button size="sm" onClick={() => press(c)}>
                      <GitPullRequestIcon /> Push & open PR
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <Dialog open={!!pushing} onOpenChange={(o) => !o && setPushing(null)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Connect GitHub to open the pull request</DialogTitle>
            <DialogDescription>
              Friday pushes {pushing?.branch ? <code className="font-mono text-[12.5px]">{pushing.branch}</code> : "this branch"} and opens its pull request from this computer, signed in as you. Connect once and it carries on by itself.
            </DialogDescription>
          </DialogHeader>
          <GitHubConnect identity={identity} bare onChange={() => void look()} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState({ title, body, actions, tone }: { title: string; body: string; actions?: ReactNode; tone?: "bad" }) {
  return (
    <DassEmpty className="mt-6" tone={tone} icon={<GitPullRequestIcon />} title={title} action={actions || undefined}>
      {body}
    </DassEmpty>
  );
}

type Ctx = {
  identity: Identity;
  onWork: (brief: string, opts?: WorkOptions) => void;
  onOpen?: (sid: string, invite?: string) => void;
  sessionFor: Map<string, BoardCard>;
  refresh: () => void;
  /** The coding tools on this computer that can review: installed and signed in. */
  tools: EngineTool[];
};

type Tone = "ok" | "bad" | "warn" | "wait" | "muted";
const DAY = 86_400_000;
const FIX_WORD = { checks: "Checks failing", conflicts: "Conflicts", comments: "Comments to address", behind: "Behind its base" } as const;
const FIX_SHORT = { checks: "Checks", conflicts: "Conflicts", comments: "Comments", behind: "Behind" } as const;

/** Where a pull request stands, in a few words, for its line in the queue. */
function standing(pr: PullRequest, kind: Kind): { text: string; tone: Tone } {
  const s = stepsOf(pr);
  if (kind === "review") {
    const d = Math.floor(waitedMs(pr) / DAY);
    return d >= 1 ? { text: `Waiting ${d}d on you`, tone: d >= 2 ? "warn" : "wait" } : { text: "Asked for your review", tone: "wait" };
  }
  if (kind === "ready") return { text: "Ready to merge", tone: "ok" };
  // Short, under a "Needs a fix" heading, and said once: the row used to say it twice, in words and again in a pill.
  if (kind === "fix") return { text: fixesOf(pr).map((f, i) => (i ? FIX_SHORT[f].toLowerCase() : FIX_SHORT[f])).join(", ") || "Needs a fix", tone: "bad" };
  if (kind === "draft") return { text: "Draft", tone: "muted" };
  if (kind === "merged") return { text: `Merged ${relTime(Date.parse(pr.mergedAt ?? pr.updatedAt))}`, tone: "muted" };
  if (kind === "team") {
    const who = (pr.requested ?? []).map((r) => r.login);
    return who.length ? { text: `Review asked of ${who.slice(0, 2).join(", ")}${who.length > 2 ? ` +${who.length - 2}` : ""}`, tone: "wait" } : { text: s.checks === "bad" ? "Checks failing" : "Open", tone: s.checks === "bad" ? "bad" : "muted" };
  }
  return { text: s.checks === "wait" ? "Checks running" : s.review === "wait" ? "Waiting for a review" : "Waiting on GitHub's merge check", tone: "wait" };
}

/** A tone as a state dot: amber only when it waits on you, teal only while Friday works on it. */
function dotOf(tone: Tone, kind: Kind, working?: BoardCard): DotState {
  if (working?.shepherd) return "working";
  if (kind === "review") return "needs";
  // Merged is finished, not waiting to start: the done ring, not the faint one a draft has.
  if (kind === "merged") return "done";
  return tone === "bad" ? "bad" : tone === "ok" ? "done" : "idle";
}
const TONE_TEXT: Record<DotState, string> = {
  needs: "text-[var(--dass-needs)]",
  working: "text-[var(--dass-live)]",
  bad: "text-[var(--red)]",
  done: "text-[var(--ink-2)]",
  idle: "text-[var(--text-muted)]",
};

/** Lines added and taken away: the one place green and red mean what they always mean in a diff. */
function Diff({ add, del, className }: { add: number; del: number; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 gap-1.5 font-mono text-[12px] tabular-nums", className)}>
      <span className="text-[var(--green)]">+{add}</span>
      <span className="text-[var(--red)]">−{del}</span>
    </span>
  );
}

/** What a pull request is to you, said on its row in the All list. */
const KIND_WORD: Record<Kind, string> = { review: "To review", ready: "Yours", fix: "Yours", waiting: "Yours", draft: "Yours", team: "Team", merged: "Merged" };

function QueueItem({ pr, kind, on, working, pilot, risk, when, showKind, onPick }: { pr: PullRequest; kind: Kind; on: boolean; working?: BoardCard; pilot?: PilotPrRecord | undefined; risk?: Risk; /** When it last changed (merged: when it merged), for its age on the row. */ when?: number; /** In the All list: whose it is, so the one list still says. */ showKind?: boolean; onPick: () => void }) {
  const root = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (on) root.current?.scrollIntoView({ block: "nearest" });
  }, [on]);
  const st = standing(pr, kind);
  const others = kind === "review" || kind === "team";
  // Autopilot's word for it while it has the pull request (autopilot-ui.tsx), in place of where it stands on GitHub.
  const ap = pilotWords(pilot);
  const dot: DotState = ap ? (ap.tone === "working" ? "working" : ap.tone === "stopped" ? "bad" : "idle") : dotOf(st.tone, kind, working);
  const word = ap?.text ?? (working?.shepherd ? "Friday is on it" : st.text);
  // Two lines (Arun, 2026-11-07, code review design A): the title, then where it lives, its size and where it stands, once.
  // What makes it worth a careful look is in its tooltip and the open pull request, no longer a second pill on the row.
  return (
    <button
      ref={root}
      type="button"
      aria-current={on || undefined}
      onClick={onPick}
      title={risk && !risk.quick && risk.reasons.length ? `Worth a careful look: ${risk.reasons.join(", ")}` : undefined}
      className="flex w-full min-w-0 flex-col gap-2 rounded-[10px] px-3 py-2.5 text-left transition-colors duration-[var(--dass-fast)] hover:bg-[var(--hover)] aria-[current=true]:bg-[var(--hover)] aria-[current=true]:shadow-[inset_0_0_0_1px_var(--border)]"
    >
      <span className="flex min-w-0 items-start gap-2">
        <span className="line-clamp-2 min-w-0 flex-1 text-[13.5px] leading-[1.4] font-medium text-[var(--ink)]">{pr.title}</span>
        {when ? (
          <time className="mt-px shrink-0 text-[11.5px] text-[var(--text-muted)] tabular-nums" dateTime={new Date(when).toISOString()} title={new Date(when).toLocaleString()}>
            {relTime(when)}
          </time>
        ) : null}
      </span>
      <span className="flex min-w-0 items-center gap-2 text-[12px] text-[var(--text-muted)]">
        {others && pr.avatar && <img className="size-3.5 shrink-0 rounded-full" src={pr.avatar} alt="" />}
        {/* Where it lives keeps its words; a long status gives way first (2026-11-07 release walk: "edge…" beside "Checks,
            conflicts, comments"). */}
        {showKind && <span className="rv-kind shrink-0" data-kind={filterOf(kind)}>{KIND_WORD[kind]}</span>}
        <span className="max-w-[55%] min-w-0 shrink-0 truncate">
          {pr.repo.split("/")[1]} #{pr.number}
          {others && pr.author ? ` · ${pr.author}` : ""}
          {pr.base && !/^(main|master|trunk|develop)$/.test(pr.base) ? ` · stacked on ${pr.base}` : ""}
        </span>
        <Diff add={pr.additions} del={pr.deletions} />
        <span className={cn("ml-auto inline-flex min-w-0 items-center gap-1.5 font-medium", TONE_TEXT[dot])} title={`${ap ? `${ap.text}: ${pilot?.log.at(-1)?.text ?? ""}` : word} · ${sizeOf(pr)} change: ${pr.additions + pr.deletions} lines`}>
          <Dot state={dot} className="shrink-0" />
          <span className="truncate">{word}</span>
        </span>
      </span>
    </button>
  );
}

/** Pressed or not, monochrome: picking which of your coding tools does something. */
function ToolChip({ tool, on, onClick }: { tool: EngineTool; on: boolean; onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="xs"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "h-7 rounded-[8px] border-[var(--border)] bg-transparent px-2.5 text-[12px] font-medium text-[var(--text-muted)] shadow-none hover:bg-[var(--hover)] hover:text-[var(--ink)] dark:bg-transparent",
        on && "border-[var(--border-strong)] bg-[var(--hover)] text-[var(--ink)] dark:bg-[var(--hover)]",
      )}
    >
      <EngineMark tool={tool} size={12} /> {ENGINE_NAMES[tool]}
      {on && <CheckIcon className="size-3" />}
    </Button>
  );
}

/**
 * Auto-review: somebody asks for your review, and your own agents read it before you open it. On this computer, since it
 * is this computer's Claude Code, Codex or Cursor doing the reading, and only for requests that arrive after it is on.
 */
function AutoReview({ tools, className }: { tools: EngineTool[]; /** Its frame: a rule above it in the list, a card of its own on an empty tab. */ className?: string }) {
  const auto = useAuto();
  const usable = ENGINE_TOOLS.filter((t) => tools.includes(t));
  if (!usable.length) return null;
  const picked = auto.tools.filter((t) => usable.includes(t));
  const toggle = (t: EngineTool) => {
    const next = picked.includes(t) ? picked.filter((x) => x !== t) : [...picked, t];
    setAuto({ on: auto.on && next.length > 0, tools: next });
  };
  const who = picked.map((t) => ENGINE_NAMES[t]).join(" and ");
  return (
    <div className={cn("flex flex-col gap-2.5 p-3", className ?? "border-t border-[var(--border)]")}>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--ink)]">
            {auto.on && <Dot state="working" />}
            Auto-review
          </span>
          <span className="text-[12px] leading-snug text-[var(--text-muted)]">{auto.on ? `${who} ${picked.length > 1 ? "read" : "reads"} each new request first.` : "Your agents read each new request before you do."}</span>
        </div>
        <Switch checked={auto.on} aria-label="Auto-review new review requests" onCheckedChange={(on) => setAuto({ on, tools: picked.length ? picked : usable.slice(0, 1) })} />
      </div>
      {auto.on && usable.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {usable.map((t) => (
            <ToolChip key={t} tool={t} on={picked.includes(t)} onClick={() => toggle(t)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Who is asked to review the most, so a pull request can go to somebody with room for it. */
function Load({ prs }: { prs: PullRequest[] }) {
  const load = loadOf(prs);
  if (!load.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-3 py-2" aria-label="Review requests per person">
      <span className="mr-1 text-[12px] font-medium text-[var(--text-muted)]">Review load</span>
      {load.slice(0, 6).map((l) => (
        <Badge key={l.login} variant="outline" className="h-6 gap-1.5 rounded-[6px] border-[var(--border)] pr-1 pl-1 text-[12px] font-medium text-[var(--ink-2)]" title={`${l.login}: asked to review ${l.count}`}>
          {l.avatar ? <img className="size-4 rounded-full" src={l.avatar} alt="" /> : <UserIcon />}
          {l.login}
          <Count n={l.count} className="h-4 min-w-4 px-1 text-[11px]" />
        </Badge>
      ))}
    </div>
  );
}

const briefs = {
  checks: (pr: PullRequest) => `Fix the failing checks on this pull request${pr.failing?.length ? ` (${pr.failing.filter((c) => c.state === "failing").map((c) => c.name).slice(0, 4).join(", ")})` : ""}: find why they fail, fix the cause, and run them here to be sure. ${pr.url}`,
  conflicts: (pr: PullRequest) => `This pull request conflicts with ${pr.base || "its base branch"}. Merge ${pr.base || "the base branch"} into its branch, resolve the conflicts so both sides keep working, and run the tests. ${pr.url}`,
  comments: (pr: PullRequest) => `Work through the unresolved review comments on this pull request and make the changes they ask for. ${pr.url}`,
  through: (pr: PullRequest) => `Get this pull request ready to merge: fix what its failing checks and review comments point to. ${pr.url}`,
  review: (pr: PullRequest) => `Review this pull request and tell me what should change before it merges: ${pr.url}`,
  findings: (pr: PullRequest, fs: AgreedFinding[]) => `A review of this pull request found these. Fix the ones that are real problems:\n\n${fs.map((f) => `- ${f.path ? `${f.path}${f.line ? `:${f.line}` : ""}: ` : ""}${f.title}. ${f.detail}`).join("\n")}\n\n${pr.url}`,
};

// ── the open pull request ────────────────────────────────────────────

/** A titled part of the open pull request. */
function Section({ title, meta, children, className }: { title: ReactNode; meta?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="m-0 text-[13px] font-semibold text-[var(--ink)]">{title}</h3>
        {meta && <span className="text-[12px] text-[var(--text-muted)]">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function Pane({ pr, kind, ctx, cmd, risk }: { pr: PullRequest; kind: Kind; ctx: Ctx; cmd: Cmd | null; risk?: Risk }) {
  const pilot = useAutopilot(ctx.identity)?.prs.get(pr.url);
  const pilotLive = pilot?.state === "working" || pilot?.state === "watching";
  const [busy, setBusy] = useState("");
  const [tour, setTour] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [asking, setAsking] = useState(false);
  const [changes, setChanges] = useState("");
  // Merged from here: shown as merged at once, where GitHub's search can still list it open for a while (it said "GitHub is still
  // checking" over "Merged."; Arun, 2026-11-22). The lists are asked again over the next half minute until they agree.
  const [mergedNow, setMergedNow] = useState(false);
  useEffect(() => setMergedNow(false), [pr.url]);
  const merged = kind === "merged" || mergedNow;
  const others = kind === "review" || kind === "team";
  const session = ctx.sessionFor.get(pr.url);
  const proofInvite = session ? (loadRecents().find((r) => r.sid === session.sid)?.invite ?? "") : "";
  const files = pr.files ?? [];
  // Why it is where it is in the queue, weightiest first: the paths it touches, its tests and checks, what a reviewer found.
  const risks = kind === "merged" ? risksOf(pr) : (risk?.reasons ?? risksOf(pr));
  // Of those, what the rest of the page doesn't say already: its size is beside the title, its checks in the card.
  const looks = risks.filter((r) => !/check|conflict|\b(lines|files)\b/i.test(r));
  const quiet = (p: Promise<unknown>) => void p.catch(() => {});
  // Review in the IDE (Arun, 2026-11-19, wave 3): somebody else's pull request, checked out beside your own folder and read in Code.
  const [inIde, setInIde] = useState(false);
  const reviewHere = async () => {
    setInIde(true);
    setNote(null);
    try {
      await reviewInIde(ctx.identity, pr, ctx.tools[0]);
    } catch (e) {
      setNote({ text: machineError(e), bad: true });
    } finally {
      setInIde(false);
    }
  };

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action);
    setNote(null);
    try {
      const r = await hostApi<{ note?: string; url?: string }>(ctx.identity, "/api/runner/pr.act", { method: "POST", body: JSON.stringify({ url: pr.url, action, head: pr.head, id: pr.id, ...extra }) });
      setNote({ text: r.note ?? "Done." });
      if (r.url) openOutside(r.url);
      ctx.refresh();
      if (action === "merge") {
        // Only one that merged: a merge set to happen once checks pass is still open.
        if (/^merged\b/i.test((r.note ?? "").trim())) setMergedNow(true);
        for (const ms of [4000, 12_000, 30_000]) setTimeout(() => ctx.refresh(), ms);
      }
    } catch (e) {
      setNote({ text: machineError(e), bad: true });
      throw e;
    } finally {
      setBusy("");
    }
  };
  const merge = (method: "squash" | "merge" | "rebase") =>
    setConfirm({
      title: `${method === "squash" ? "Squash and merge" : method === "rebase" ? "Rebase and merge" : "Merge"} #${pr.number}?`,
      body: `${pr.title} goes into ${pr.base || "its base branch"} in ${pr.repo}. This can't be undone from here.`,
      action: method === "squash" ? "Squash and merge" : method === "rebase" ? "Rebase and merge" : "Merge",
      danger: false,
      onConfirm: () => act("merge", { method }),
    });
  const approve = () =>
    setConfirm({ title: `Approve #${pr.number}?`, body: `${pr.title}, by ${pr.author || "its author"}, gets your approval on GitHub.`, action: "Approve", danger: false, onConfirm: () => act("approve") });
  // What a key asked the open pull request to do.
  const seen = useRef(cmd?.n ?? 0);
  useEffect(() => {
    if (!cmd || cmd.n === seen.current) return;
    seen.current = cmd.n;
    if (cmd.key === "github") openOutside(pr.url);
    else if (cmd.key === "merge" && kind === "ready") merge("squash");
    else if (cmd.key === "approve" && kind === "review") approve();
  }, [cmd?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // What happens next, said once, and the buttons that do it: quietest first, the one that moves it forward last.
  const next = nextStep(pr, kind);
  const quietBtn = (key: string, label: string, onClick: () => void, opts: { disabled?: boolean; title?: string } = {}) => (
    <Button key={key} variant="ghost" size="sm" className="h-8 text-[13px] text-[var(--ink-2)]" disabled={opts.disabled} title={opts.title} onClick={onClick}>
      {label}
    </Button>
  );
  const buttons: ReactNode[] = [];
  if (kind === "review" && !asking)
    buttons.push(
      quietBtn("s", "Review in a session", () => ctx.onWork(briefs.review(pr))),
      quietBtn("c", "Request changes", () => setAsking(true)),
      <Tip key="a" label="Approve on GitHub" keys="A">
        <Button size="sm" className="h-8 text-[13px]" disabled={!!busy} onClick={approve}>
          {busy === "approve" ? "Approving…" : "Approve"}
        </Button>
      </Tip>,
    );
  if (kind === "ready")
    buttons.push(
      <DropdownMenu key="m">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="More ways to merge" className="text-[var(--ink-2)]">
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => merge("merge")}>Merge commit</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => merge("rebase")}>Rebase and merge</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
      <Tip key="s" label="Squash and merge" keys="M">
        <Button size="sm" className="h-8 text-[13px]" disabled={!!busy} onClick={() => merge("squash")}>
          {busy === "merge" ? "Merging…" : "Squash and merge"}
        </Button>
      </Tip>,
    );
  // Each fix is on its own line in the card below (MergeRows), beside what it fixes; the card's one button sees it all through.
  if (kind === "fix") {
    // Autopilot on it already: its own session sees it through (autopilot-ui.tsx), and a second one would race it.
    if (!session?.shepherd && !pilotLive)
      buttons.push(
        <Tip key="t" label="A session fixes what's blocking it, then Friday keeps handing new red checks and review comments to the agent until it merges">
          <Button size="sm" className="h-8 text-[13px]" onClick={() => ctx.onWork(briefs.through(pr), { shepherd: true })}>
            See it through
          </Button>
        </Tip>,
      );
  }
  if (kind === "draft")
    buttons.push(
      <Button key="d" size="sm" className="h-8 text-[13px]" disabled={!!busy} onClick={() => quiet(act("ready"))}>
        {busy === "ready" ? "Marking…" : "Mark ready for review"}
      </Button>,
    );
  if (kind === "team") buttons.push(quietBtn("s", "Review in a session", () => ctx.onWork(briefs.review(pr))));

  const risky = new Set(files.filter((f) => risksOf({ files: [f] }).length).map((f) => f.path));
  // Checks under way, or GitHub still working out whether it merges: the heading's mark turns too (Arun, 2026-11-22: "add status ring
  // too the checks when it is running", "also add status ring for the merge").
  const nextDot: DotState = kind === "review" ? "needs" : kind === "merged" ? "done" : next.tone === "bad" ? "bad" : next.tone === "ok" ? "done" : stepsOf(pr).checks === "wait" || (stepsOf(pr).merge === "wait" && pr.mergeState !== "behind") ? "working" : "idle";

  return (
    <div className="flex flex-col gap-8 px-2 pt-2 pb-12">
      <header className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <h2 className="m-0 min-w-0 flex-1 text-[20px] leading-[28px] font-semibold tracking-[-0.015em] text-pretty text-[var(--ink)]" title={pr.title}>
            {pr.title}
          </h2>
          {/* The way out, then the action, as the Issues tab's pane has them: the button the eye ends on is the one to press. */}
          <div className="flex shrink-0 items-center gap-1 pt-0.5">
            <Tip label="Open on GitHub" keys="G">
              <Button variant="ghost" size="icon-sm" aria-label="Open on GitHub" className="text-[var(--text-muted)] hover:text-[var(--ink)]" onClick={() => openOutside(pr.url)}>
                <ExternalLinkIcon />
              </Button>
            </Tip>
            {others && !merged && isLocal() && (
              <Tip label="Their branch checked out on the side, its diff and comments in the IDE, and an agent's first pass">
                <Button variant="outline" size="sm" className="h-8 border-[var(--border)] bg-[var(--bg)] text-[13px] shadow-none" disabled={inIde} onClick={() => void reviewHere()}>
                  {inIde ? "Opening…" : "Review in the IDE"}
                </Button>
              </Tip>
            )}
            {!merged && (
              <Button variant="outline" size="sm" className="h-8 border-[var(--border)] bg-[var(--bg)] text-[13px] shadow-none" onClick={() => ctx.onWork(`${pr.url} `)}>
                Open in a session
              </Button>
            )}
          </div>
        </div>
        {/* One quiet line of what it is (design A): where, who, which branch, its size, and what makes it worth a careful look.
            The size and the paths it touches were a row of chips, one of them the failing checks the card says already. */}
        <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[var(--text-muted)]">
          {[
            <span key="n">
              {pr.repo} #{pr.number}
            </span>,
            pr.author && (
              <span key="a" className="inline-flex items-center gap-1.5 text-[var(--ink-2)]">
                {pr.avatar && <img className="size-4 rounded-full" src={pr.avatar} alt="" />}
                {pr.author}
              </span>
            ),
            pr.branch && (
              <span key="b" className="inline-flex min-w-0 items-center gap-1 font-mono text-[12px]" title={`${pr.branch} into ${pr.base || "its base"}`}>
                <GitBranchIcon className="size-3.5 shrink-0" />
                <span className="truncate">
                  {pr.branch}
                  {pr.base ? ` → ${pr.base}` : ""}
                </span>
              </span>
            ),
            <span key="d" className="inline-flex items-center gap-1.5">
              <Diff add={pr.additions} del={pr.deletions} />
              {(pr.changedFiles ?? files.length) > 0 && `in ${pr.changedFiles ?? files.length} file${(pr.changedFiles ?? files.length) === 1 ? "" : "s"}`}
            </span>,
            looks.length > 0 && (
              <span key="r" className="text-[var(--ink-2)]" title="Worth a careful look">
                {looks.map((r, i) => (i ? r.charAt(0).toLowerCase() + r.slice(1) : r)).join(", ")}
              </span>
            ),
            <span key="u">updated {relTime(Date.parse(pr.updatedAt))}</span>,
          ]
            .filter(Boolean)
            .flatMap((n, i) => (i ? [<span key={`s${i}`} aria-hidden className="text-[var(--ink-4,var(--text-muted))]">·</span>, n] : [n]))}
        </p>
        {session && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="outline"
              size="xs"
              className={cn(
                "h-6 gap-1.5 rounded-md border-[var(--border)] bg-transparent px-2 text-[12px] font-medium text-[var(--ink-2)] shadow-none dark:bg-transparent",
                session.shepherd && "border-transparent bg-[color-mix(in_srgb,var(--dass-live)_14%,transparent)] text-[var(--dass-live)] hover:text-[var(--dass-live)] dark:bg-[color-mix(in_srgb,var(--dass-live)_14%,transparent)]",
              )}
              onClick={() => ctx.onOpen?.(session.sid)}
              title={`Open “${session.title}”`}
            >
              {session.shepherd ? <Dot state="working" /> : session.tool ? <EngineMark tool={session.tool} size={12} /> : <Icon name="agent" size={12} />}
              {session.shepherd ? `Friday is seeing it through · ${session.shepherd}` : session.pr?.url === pr.url ? `Made in a session by ${session.agent}` : `Being worked on by ${session.agent}`}
            </Button>
          </div>
        )}
      </header>
      {/* What autopilot did on it, in order, with its session to open or stop (autopilot-ui.tsx). */}
      <PilotTimeline identity={ctx.identity} url={pr.url} {...(ctx.onOpen ? { onOpen: ctx.onOpen } : {})} />

      {/* What stands between it and merging, said once (Arun, 2026-11-07, code review design A): a heading, the one action
          that moves it forward, and a line for each of checks, review and merging with its own fix beside it. It was a card, then
          three boxes, then the failing check again, each saying the same failure. */}
      <section
        aria-label={next.title}
        className={cn(
          "tray flex flex-col rounded-xl border border-[var(--border)] bg-[var(--card)]",
          nextDot === "needs" && "border-[color-mix(in_srgb,var(--dass-needs)_40%,var(--border))]",
          nextDot === "bad" && "border-[color-mix(in_srgb,var(--red)_35%,var(--border))]",
        )}
      >
        <div className="flex flex-col gap-1 p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Dot state={nextDot} />
            <b className="min-w-0 flex-1 text-[14px] font-semibold text-[var(--ink)]">{next.title}</b>
            {!asking && buttons.length > 0 && <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">{buttons}</div>}
          </div>
          {next.body && <span className="pl-[21px] text-[13px] leading-relaxed text-[var(--text-muted)]">{next.body}</span>}
        </div>
        {asking && (
          <div className="flex flex-col gap-2 px-4 pb-4 pl-[37px]">
            <Textarea className="min-h-20 border-[var(--border)] bg-[var(--bg)] text-[13px] md:text-[13px]" rows={3} autoFocus value={changes} placeholder="What should change before this merges" onChange={(e) => setChanges(e.target.value)} />
            <div className="flex justify-end gap-1.5">
              {quietBtn("cancel", "Cancel", () => setAsking(false))}
              <Button size="sm" className="h-8 text-[13px]" disabled={!changes.trim() || !!busy} onClick={() => quiet(act("request_changes", { body: changes }).then(() => setAsking(false)))}>
                Request changes
              </Button>
            </div>
          </div>
        )}
        {!merged && <MergeRows pr={pr} mine={!others} ctx={ctx} act={act} busy={busy} />}
        {note && (
          <p className={cn("m-0 border-t border-[var(--border)] px-4 py-2.5 text-[13px]", note.bad ? "text-[var(--red)]" : "text-[var(--text-muted)]")} role={note.bad ? "alert" : "status"}>
            {note.text}
          </p>
        )}
      </section>

      {/* Proof (Arun, 2026-11-22: "how do i see the proof for the merge???"): the clip from the session of yours that opened it. */}
      {isLocal() && session && proofInvite && <PrProof sid={session.sid} invite={proofInvite} merged={merged} />}

      {(files.length > 0 || !merged) && (
        <section className="flex flex-col gap-3">
          {/* The change itself is the page's body; your agents' review is a small control over it, its findings under it. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="m-0 text-[13px] font-semibold text-[var(--ink)]">Files changed</h3>
            {files.length > 0 && (
              <span className="text-[12px] text-[var(--text-muted)]">
                {pr.changedFiles ?? files.length}
                {" · "}
                <button type="button" className="link-btn" onClick={() => setTour(true)}>
                  Guided tour
                </button>
              </span>
            )}
            {!merged && <ReviewControl pr={pr} ctx={ctx} />}
          </div>
          {!merged && <AgentReview pr={pr} ctx={ctx} mine={!others} act={act} />}
          {tour && <ReviewTour identity={ctx.identity} pr={pr} files={files} onClose={() => setTour(false)} />}
          {/* The tour walks the files in its own place; the list is back when it ends. */}
          {files.length > 0 && !tour && (
          <ul className="tray m-0 flex list-none flex-col divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] p-0">
            {files.slice(0, 20).map((f) => (
              <li key={f.path} className="flex min-w-0 items-center gap-2.5 px-3 py-2 text-[13px]" title={f.path}>
                <FileIcon path={f.path} size={14} />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--ink)]">
                  {f.path.includes("/") && <span className="text-[var(--text-muted)]">{f.path.slice(0, f.path.lastIndexOf("/") + 1)}</span>}
                  {f.path.slice(f.path.lastIndexOf("/") + 1)}
                </span>
                {risky.has(f.path) && (
                  <Badge variant="outline" className="h-5 gap-1 rounded-md border-[var(--border)] px-1.5 text-[12px] font-medium text-[var(--ink-2)]">
                    <ShieldIcon /> Worth a look
                  </Badge>
                )}
                <Diff add={f.additions} del={f.deletions} />
              </li>
            ))}
          </ul>
          )}
          {!tour && (pr.changedFiles ?? files.length) > 20 && (
            <Button variant="link" size="sm" className="h-auto self-start p-0 text-[13px]" onClick={() => openOutside(`${pr.url}/files`)}>
              {(pr.changedFiles ?? files.length) - 20} more on GitHub
            </Button>
          )}
        </section>
      )}
      {confirm && <ConfirmDialog confirmation={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

/** What happens next for a pull request, as a heading and a sentence. */
function nextStep(pr: PullRequest, kind: Kind): { title: string; body: string; tone: Tone } {
  const s = stepsOf(pr);
  if (kind === "review") {
    const d = Math.floor(waitedMs(pr) / DAY);
    return { title: "Your review", body: `${pr.author || "Someone"} asked for your review${d >= 1 ? ` ${shortDuration(waitedMs(pr))} ago` : ""}. Read the change below, or have your agents read it first, then approve it or ask for changes.`, tone: d >= 2 ? "warn" : "wait" };
  }
  // The lines under the heading say each part (MergeRows), so a sentence saying them again is left out.
  if (kind === "ready") return { title: "Ready to merge", body: "", tone: "ok" };
  if (kind === "fix") {
    const f = fixesOf(pr);
    const n = ["One thing", "Two things", "Three things", "Four things"][f.length - 1] ?? `${f.length} things`;
    return { title: `${n} before it can merge`, body: `Fix ${f.length > 1 ? "each" : "it"} below, or let Friday see it through: it keeps fixing new red checks and comments until it merges.`, tone: "bad" };
  }
  if (kind === "draft") return { title: "Still a draft", body: "Nobody is asked to review it yet. Mark it ready when it is.", tone: "muted" };
  if (kind === "merged") return { title: "Merged", body: `Went into ${pr.base || "its base branch"} ${relTime(Date.parse(pr.mergedAt ?? pr.updatedAt))}.`, tone: "muted" };
  if (kind === "team") {
    const who = (pr.requested ?? []).map((r) => r.login);
    return { title: `${pr.author || "A teammate"}'s pull request`, body: who.length ? `Waiting on a review from ${who.join(", ")}.` : "Nobody is asked to review it.", tone: "muted" };
  }
  return { title: pr.mergeState === "behind" && s.checks !== "wait" && s.review !== "wait" ? "Behind its base branch" : "Nothing for you to do yet", body: "", tone: "wait" };
}

/** A part's state as a small round mark: filled when done, red when it stops the merge, dashed while it waits. */
function StepMark({ mark, live = false }: { mark: Mark; /** Running now (checks under way): the app's own working ring, turning, rather than a dashed wait. */ live?: boolean }) {
  // Checks running (Arun, 2026-11-22: "add status ring too the checks when it is running"): the same ring a working agent wears.
  if (live && mark === "wait")
    return (
      <span className="grid size-4 shrink-0 place-items-center" title="Running">
        <TabRing state="working" />
      </span>
    );
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-full [&_svg]:size-2.5",
        mark === "ok" && "bg-[var(--ink)] text-[var(--bg)]",
        mark === "bad" && "bg-[var(--red)] text-white",
        mark === "wait" && "border-[1.5px] border-dashed border-[var(--border-strong)]",
        mark === "skip" && "border-[1.5px] border-[var(--border)]",
      )}
    >
      {mark === "ok" ? <CheckIcon strokeWidth={3} /> : mark === "bad" ? <XIcon strokeWidth={3} /> : null}
    </span>
  );
}

const REVIEW_WORD: Record<Mark, string> = { ok: "approved", bad: "changes were requested", wait: "waiting for a review", skip: "none needed on this repo" };

/**
 * Checks, review and merging, a line each under the card's heading (code review design A): what each one is now, the failing
 * checks by name, and the fix for it beside it, for your own pull requests: Re-run and Fix in a session, Address comments,
 * Resolve conflicts, Update branch.
 */
function MergeRows({ pr, mine, ctx, act, busy }: { pr: PullRequest; mine: boolean; ctx: Ctx; act: (action: string, extra?: Record<string, unknown>) => Promise<void>; busy: string }) {
  const s = stepsOf(pr);
  const failing = pr.failing ?? [];
  const failed = failing.filter((c) => c.state === "failing");
  const base = pr.base || "its base branch";
  const behind = pr.mergeState === "behind" && pr.mergeable !== false;
  const unresolved = pr.unresolved ?? 0;
  const quiet = (p: Promise<unknown>) => void p.catch(() => {});
  const link = (key: string, label: string, onClick: () => void, disabled = false) => (
    <Button key={key} variant="link" size="sm" disabled={disabled} className="h-auto p-0 text-[13px] font-medium text-[var(--ink-2)] hover:text-[var(--ink)]" onClick={onClick}>
      {label}
    </Button>
  );
  const named = (cs: typeof failing) =>
    cs.slice(0, 3).map((c, i) => (
      <span key={c.name + c.url}>
        {i ? ", " : ""}
        {c.url ? (
          <button type="button" className="link-btn text-[var(--ink-2)]" onClick={() => openOutside(c.url)}>
            {c.name}
          </button>
        ) : (
          c.name
        )}
      </span>
    ));
  const rows: { key: string; mark: Mark; name: string; detail: ReactNode; actions: ReactNode[] }[] = [
    {
      key: "checks",
      mark: s.checks,
      name: "Checks",
      detail: s.checks === "bad" && failed.length ? <>{named(failed)}{failed.length > 3 ? ` and ${failed.length - 3} more` : ""} failed</> : s.checks === "wait" ? failing.length ? <>{named(failing)} running</> : "running" : s.checks === "ok" ? "all pass" : s.checks === "bad" ? "failing" : "none on this repo",
      actions: mine && failed.length ? [link("rerun", busy === "rerun" ? "Re-running…" : "Re-run", () => quiet(act("rerun")), !!busy), link("fix", "Fix in a session", () => ctx.onWork(briefs.checks(pr)))] : [],
    },
    {
      key: "review",
      mark: s.review,
      name: "Review",
      detail: `${REVIEW_WORD[s.review]}${unresolved ? `, ${unresolved} comment thread${unresolved === 1 ? "" : "s"} open` : ""}`,
      actions: mine && unresolved ? [link("comments", "Address comments", () => ctx.onWork(briefs.comments(pr)))] : [],
    },
    {
      key: "merge",
      mark: behind && s.merge !== "bad" ? "wait" : s.merge,
      name: s.merge === "bad" ? "Conflicts" : "Merge",
      detail: s.merge === "bad" ? `with ${base}` : behind ? `behind ${base}` : s.merge === "ok" ? `merges cleanly into ${base}` : "GitHub is still checking",
      actions: !mine ? [] : s.merge === "bad" ? [link("conflicts", "Resolve conflicts", () => ctx.onWork(briefs.conflicts(pr)))] : behind ? [link("update", busy === "update_branch" ? "Updating…" : "Update branch", () => quiet(act("update_branch")), !!busy)] : [],
    },
  ];
  return (
    <ul className="m-0 flex list-none flex-col border-t border-[var(--border)] p-0" aria-label="Before it can merge">
      {rows.map((r) => (
        <li key={r.key} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border)] px-4 py-2.5 text-[13px] last:border-b-0">
          <StepMark mark={r.mark} live={r.key === "checks" || (r.key === "merge" && !behind && s.merge === "wait")} />
          <span className="min-w-0 flex-1 basis-48">
            <span className="font-medium text-[var(--ink)]">{r.name}</span>
            <span className="text-[var(--text-muted)]"> · {r.detail}</span>
          </span>
          {r.actions.length > 0 && <span className="ml-auto flex shrink-0 items-center gap-3">{r.actions}</span>}
        </li>
      ))}
    </ul>
  );
}

const SEV: Record<ReviewFinding["severity"], string> = { high: "High", medium: "Medium", low: "Low" };

/**
 * Agent review as a small control over the files (code review design A): which of your coding tools read it, and Run. Your own
 * coding tools read the change against the repo's rules and say what would break or isn't safe; more than one show where they
 * agree. What they found is under it (AgentReview).
 */
function ReviewControl({ pr, ctx }: { pr: PullRequest; ctx: Ctx }) {
  useReviews();
  const run = reviews.get(pr.url);
  const tools = ENGINE_TOOLS.filter((t) => ctx.tools.includes(t));
  const [picked, setPicked] = useState<EngineTool[]>(() => (run?.results.length ? run.results.map((r) => r.tool) : tools.slice(0, 1)));
  if (!tools.length) return null;
  const asked = run ? run.results.length + Object.keys(run.errors).length + run.running.length : 0;
  const label = picked.length > 1 ? `${picked.length} agents` : picked.length ? ENGINE_NAMES[picked[0]!] : "Pick an agent";
  return (
    <div className="ml-auto flex items-center gap-1">
      <span className="mr-0.5 text-[12px] text-[var(--text-muted)]" title="Your own coding tools read the change against the repo's rules and say what would break or isn't safe. Pick more than one to see where they agree.">
        Agent review
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-[12px] font-medium text-[var(--ink-2)]" aria-label={`Agent review by ${picked.map((t) => ENGINE_NAMES[t]).join(" and ") || "nobody yet"}. Choose which`}>
            {picked.length === 1 && <EngineMark tool={picked[0]!} size={12} />}
            {label}
            <ChevronDownIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {tools.map((t) => (
            <DropdownMenuCheckboxItem key={t} checked={picked.includes(t)} onSelect={(e) => e.preventDefault()} onCheckedChange={() => setPicked((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]))}>
              <EngineMark tool={t} size={12} /> {ENGINE_NAMES[t]}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Tip label="Have your agents read it" keys="R">
        <Button variant="outline" size="sm" className="h-7 border-[var(--border)] bg-[var(--bg)] text-[12px] shadow-none" disabled={!picked.length || !!run?.running.length} onClick={() => void runReview(ctx.identity, pr, picked)}>
          {run?.running.length ? <Dot state="working" /> : null}
          {run?.running.length ? `Reading… ${asked - run.running.length}/${asked}` : run ? "Review again" : "Run"}
        </Button>
      </Tip>
    </div>
  );
}

/** What your agents found, under the files' heading: only once a review has run. */
function AgentReview({ pr, ctx, mine, act }: { pr: PullRequest; ctx: Ctx; mine: boolean; act: (action: string, extra?: Record<string, unknown>) => Promise<void> }) {
  useReviews();
  const run = reviews.get(pr.url);
  const merged = useMemo(() => (run ? mergeFindings(run.results) : []), [run]);
  const agreed = merged.filter((f) => f.by.length > 1).length;
  const stale = !!run && !!pr.head && !!run.head && run.head !== pr.head && !run.running.length;
  const names = (ts: EngineTool[]) => ts.map((t) => ENGINE_NAMES[t]).join(" and ");
  const quiet = (p: Promise<unknown>) => void p.catch(() => {});
  const post = () =>
    quiet(
      act("draft_review", {
        body: `Review by ${names(run!.results.map((r) => r.tool))}, from Friday.`,
        comments: merged.map((f) => ({ path: f.path ?? "", line: f.line, body: commentFor(f, ENGINE_NAMES) })).filter((c) => c.path),
      }),
    );
  const done = !!run && !run.running.length && run.results.length > 0;
  const muted = "m-0 text-[13px] leading-relaxed text-[var(--text-muted)]";
  if (!run || !ctx.tools.length) return null;

  return (
    <Section
      title="Agent review"
      meta={
        done && (
          <>
            {run.results.length > 1 ? (agreed ? `${names(run.results.map((r) => r.tool))} agree on ${agreed} of ${merged.length}` : `${names(run.results.map((r) => r.tool))} found different things`) : `${ENGINE_NAMES[run.results[0]!.tool]} · ${relTime(run.at)}`}
            {stale ? " · read an earlier commit" : ""}
          </>
        )
      }
    >
      {run?.running.length ? (
        <p className={muted}>
          Your own {names(run.running)} {run.running.length > 1 ? "are" : "is"} reading the change. This takes a minute or two.
        </p>
      ) : null}
      {run &&
        Object.entries(run.errors).map(([t, e]) => (
          <p key={t} className="m-0 text-[13px] text-[var(--red)]">
            {ENGINE_NAMES[t as EngineTool]}: {e}
          </p>
        ))}
      {done && (
        <p className={muted}>
          {run.auto ? "Read by auto-review when your review was asked for. " : ""}
          {run.rules.length ? `Checked against the repo's ${run.rules.join(" and ")}.` : "The repo has no AGENTS.md or CLAUDE.md, so it was read for bugs and safety only."}
        </p>
      )}
      {done && !merged.length && (
        <p className="m-0 flex items-center gap-2 text-[13px] text-[var(--ink-2)]">
          <CheckIcon className="size-4" /> Nothing found that would break or is unsafe.
        </p>
      )}
      {merged.length > 0 && (
        <>
          <ul className="tray m-0 flex list-none flex-col divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] p-0">
            {merged.map((f, i) => (
              <li key={i} className="flex items-start gap-3 px-3 py-2.5">
                <Badge
                  variant="outline"
                  className={cn(
                    "mt-px h-5 w-[58px] shrink-0 rounded-md border-[var(--border)] px-1.5 text-[12px] font-medium text-[var(--text-muted)]",
                    f.severity === "high" && "border-transparent bg-[color-mix(in_srgb,var(--red)_14%,transparent)] text-[var(--red)]",
                    f.severity === "medium" && "text-[var(--ink)]",
                  )}
                >
                  {SEV[f.severity]}
                </Badge>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px] font-medium text-[var(--ink)]">
                    <span>{f.title}</span>
                    {f.path && (
                      <Button variant="link" size="sm" className="h-auto p-0 font-mono text-[12px] font-normal text-[var(--text-muted)]" onClick={() => openOutside(`${pr.url}/files`)} title="Open the files on GitHub">
                        {f.path}
                        {f.line ? `:${f.line}` : ""}
                      </Button>
                    )}
                  </div>
                  {f.detail && <p className={muted}>{f.detail}</p>}
                </div>
                {run!.results.length > 1 && (
                  <span className="flex shrink-0 gap-1 pt-0.5" title={`Found by ${names(f.by)}`}>
                    {f.by.map((t) => (
                      <EngineMark key={t} tool={t} size={12} />
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap justify-end gap-1.5">
            <Tip label="A pending review on GitHub that only you can see until you submit it there">
              <Button variant="ghost" size="sm" className="h-8 text-[13px] text-[var(--ink-2)]" onClick={post}>
                Post as draft review
              </Button>
            </Tip>
            {mine && (
              <Button size="sm" className="h-8 text-[13px]" onClick={() => ctx.onWork(briefs.findings(pr, merged))}>
                Fix these in a session
              </Button>
            )}
          </div>
        </>
      )}
    </Section>
  );
}
