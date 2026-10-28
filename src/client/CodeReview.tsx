import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BoardCard } from "../board.js";
import { commentFor, fixesOf, loadOf, matches, mergeFindings, pileOf, risksOf, shortDuration, sizeOf, stepsOf, waitedMs, type AgreedFinding, type Mark } from "../code-review.js";
import type { PullRequest } from "../runner/workspace.js";
import { riskOfPr, type Risk } from "../review-risk.js";
import { QuickHeader, RiskChip, approveTogether } from "./reviewRisk.js";
import { ENGINE_NAMES, ENGINE_TOOLS, type EngineTool, type ReviewFinding } from "../types.js";
import { api } from "./api.js";
import { EngineMark } from "./BrandMarks.js";
import { FileIcon } from "./fileIcons.js";
import { GitHubConnect, machineError, useGithub } from "./GitHubConnect.js";
import { Icon } from "./icons.js";
import { RELEASES, connectThisComputer, hostApi, useMachine } from "./local.js";
import { openOutside } from "./openOutside.js";
import { refreshPrs, reviews, runReview, setAuto, useAuto, usePrs, useReviews } from "./prWatch.js";
import { ReviewTour } from "./ReviewTour.js";
import { IssuesInbox, useIssues } from "./Issues.js";
import type { Identity, RecentSession } from "./storage.js";
import { ConfirmDialog, SkeletonRows, isTyping, relTime, type Confirmation } from "./ui.js";
import { CheckIcon, ChevronDownIcon, EllipsisIcon, ExternalLinkIcon, FolderIcon, GitBranchIcon, GitPullRequestIcon, RefreshCwIcon, SearchIcon, ShieldIcon, UserIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/dass";
import { EmptyState as DassEmpty } from "@/components/dass/EmptyState";
import { Count, Dot, PageTabs, Tip, type DotState } from "@/components/dass/page-bits";

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
type Tab = "you" | "mine" | "repos" | "merged" | "issues";
const TAB_KEY = "mpa.review.tab";
// Kept for the visit, so coming back to the tab shows the last answer at once while a fresh one is fetched.
let lastTeam: PullRequest[] | null = null;

export type WorkOptions = { shepherd?: boolean };

type Kind = "review" | "ready" | "fix" | "waiting" | "draft" | "team" | "merged";
const PILES = { ready: "Ready to merge", fix: "Needs a fix", waiting: "Waiting on others", draft: "Drafts" } as const;
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
  onOpen?: (sid: string) => void;
}) {
  const { state: machine } = useMachine(identity);
  const linked = machine.mode === "local" || machine.mode === "linked";
  const { prs, error: prsError, busy } = usePrs();
  const [team, setTeam] = useState<PullRequest[] | null>(lastTeam);
  const [teamError, setTeamError] = useState("");
  const error = prsError || teamError;
  const [n, setN] = useState(0);
  const [tab, setTabState] = useState<Tab | null>(() => {
    try {
      return (localStorage.getItem(TAB_KEY) as Tab | null) ?? null;
    } catch {
      return null;
    }
  });
  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* the tab is only for this visit */
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

  const repos = useMemo(() => [...new Set([...(prs?.mine ?? []), ...(prs?.review ?? []), ...(prs?.merged ?? [])].map((p) => p.repo))], [prs]);
  const shownTab: Tab = tab ?? ((prs?.review.length ?? 0) > 0 ? "you" : "mine");
  useEffect(() => {
    if (shownTab !== "repos" || !linked || !repos.length) return;
    let live = true;
    hostApi<{ team: PullRequest[] }>(identity, `/api/runner/prs.team?repos=${encodeURIComponent(repos.join(","))}`).then(
      (r) => live && (setTeam((lastTeam = r.team)), setTeamError("")),
      (e) => live && (setTeam([]), setTeamError(machineError(e))),
    );
    return () => void (live = false);
  }, [shownTab, linked, repos.join(","), n]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = (shownTab === "you" ? prs?.review : shownTab === "mine" ? prs?.mine : shownTab === "merged" ? prs?.merged : team) ?? [];
  const tabRepos = [...new Set(list.map((p) => p.repo))];
  const shown = list.filter((p) => (!repo || p.repo === repo) && matches(p, query));
  const refresh = () => setN((x) => x + 1);
  const tools = machine.tools.filter((t) => t.path && t.loggedIn !== false).map((t) => t.tool);
  const auto = useAuto();
  useReviews();
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
  const riskiest = (a: PullRequest, b: PullRequest) => risks.get(b.url)!.score - risks.get(a.url)!.score;

  // The queue, in the order it is drawn: yours by what stands between each and merging, the riskiest first in each pile;
  // somebody else's riskiest first (the longest wait first among equals), with the small safe ones gathered at the end.
  const reviewable = (kind: Kind) => {
    const sorted = [...shown].sort((a, b) => riskiest(a, b) || waitedMs(b) - waitedMs(a));
    const quick = sorted.filter((p) => risks.get(p.url)!.quick);
    return [
      { title: "", items: sorted.filter((p) => !risks.get(p.url)!.quick).map((pr) => ({ pr, kind })) },
      { title: "Quick to review", quick: true, items: quick.map((pr) => ({ pr, kind })) },
    ].filter((g) => g.items.length);
  };
  const groups: { title: string; quick?: boolean; items: { pr: PullRequest; kind: Kind }[] }[] =
    shownTab === "mine"
      ? (["fix", "ready", "waiting", "draft"] as const).map((pile) => ({ title: PILES[pile], items: shown.filter((p) => pileOf(p) === pile).sort(riskiest).map((pr) => ({ pr, kind: pile as Kind })) })).filter((g) => g.items.length)
      : shownTab === "you"
        ? reviewable("review")
        : shownTab === "repos"
          ? reviewable("team")
          : [{ title: "", items: shown.map((pr) => ({ pr, kind: "merged" as Kind })) }];
  /** Approve the quick ones together, on GitHub as you: those not approved yet and not drafts. */
  const approveQuick = (prs: PullRequest[]) => {
    const list = prs.filter((p) => !p.draft && p.review !== "approved");
    if (!list.length) return;
    setConfirm({
      title: `Approve ${list.length} pull request${list.length === 1 ? "" : "s"}?`,
      body: `${list.length === 1 ? "It is" : "Each is"} small, touches nothing sensitive, and has nothing failing or found by a reviewer. ${list.length === 1 ? "It gets" : "They get"} your approval on GitHub: ${list.map((p) => `#${p.number} ${p.title}`).join(", ")}.`,
      action: `Approve ${list.length}`,
      danger: false,
      onConfirm: () => approveTogether(identity, list.map((p) => ({ url: p.url, title: `#${p.number} ${p.title}`, head: p.head, id: p.id }))).finally(refresh),
    });
  };
  const order = groups.flatMap((g) => g.items);
  const [sel, setSel] = useState("");
  const current = order.find((i) => i.pr.url === sel) ?? order[0];
  const [cmd, setCmd] = useState<Cmd | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const keys = useRef({ order, current, tools, auto, setTab, refresh });
  keys.current = { order, current, tools, auto, setTab, refresh };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector(".overlay")) {
        if (e.key === "Escape" && document.activeElement === search.current) search.current?.blur();
        return;
      }
      const k = keys.current;
      const at = k.order.findIndex((i) => i.pr.url === k.current?.pr.url);
      const send = (key: Cmd["key"]) => setCmd((c) => ({ key, n: (c?.n ?? 0) + 1 }));
      const tab = ({ "1": "you", "2": "mine", "3": "repos", "4": "merged", "5": "issues" } as Record<string, Tab>)[e.key];
      if (e.key === "/") search.current?.focus();
      else if (tab) k.setTab(tab);
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
  // The issues (GitHub by this computer, Linear by the server), read once the page can show them: the tab carries their count.
  const issues = useIssues(identity, ready, n);
  const issueCount = (issues.github?.assigned.length ?? 0) + (issues.linear?.issues.length ?? 0);
  const empty =
    shownTab === "you"
      ? query || repo
        ? "Nothing waiting matches that."
        : "Nobody is waiting on your review."
      : shownTab === "mine"
        ? query || repo
          ? "None of yours match that."
          : "You have no open pull requests."
        : shownTab === "merged"
          ? "Nothing of yours merged this week."
          : repos.length
            ? "Nobody else has a pull request open in your repos."
            : "Your repos show here once you have a pull request in one.";

  // The list and the pull request side by side: shown once the pull requests are read and there are some to show.
  const split = !!prs && !!prs.available && linked && !(error && !prs) && !(machine.mode === "checking" && !prs);
  // The page's own controls: which pull requests, refresh, and the way out to GitHub.
  const controls = ready && (
    <>
            <PageTabs<Tab>
              label="Pull requests and issues"
              value={shownTab}
              onChange={(t) => (setTab(t), setSel(""))}
              options={[
                { value: "you", label: <>Needs you{prs!.review.length > 0 && <Count n={prs!.review.length} needs />}</>, tip: "Waiting on your review", keys: "1" },
                { value: "mine", label: <>Yours{prs!.mine.length > 0 && <Count n={prs!.mine.length} />}</>, tip: "Your open pull requests", keys: "2" },
                { value: "repos", label: "Team", tip: "Everyone's in your repos", keys: "3" },
                { value: "merged", label: "Merged", tip: "Yours merged this week", keys: "4" },
                { value: "issues", label: <>Issues{issueCount > 0 && <Count n={issueCount} />}</>, tip: "Assigned to you in GitHub and Linear", keys: "5" },
              ]}
            />
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
    <div className={`page conns-page review-page ${ready ? "inbox" : ""} px-6! max-[640px]:px-4!`}>
      <div className="page-inner">
        <PageHeader
          className="mb-0 shrink-0"
          title="Code Review"
          subtitle="Your pull requests as an inbox, with what waits on you first."
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
            <GitHubConnect empty identity={identity} onChange={refresh} why="See what's waiting on your review, have your own agents read each pull request first, and merge without leaving Friday." />
          ) : (
            <EmptyState tone="bad" title="GitHub isn't answering" body={prs.reason || "Your pull requests couldn't be read just now."} actions={<Button onClick={refresh}>Try again</Button>} />
          )
        ) : !prs ? (
          <SkeletonRows rows={4} />
        ) : shownTab === "issues" ? (
          <IssuesInbox data={issues} controls={controls} onWork={(brief) => onWork(brief)} query={query} setQuery={setQuery} search={search} />
        ) : (
          <div className="rv-split gap-5! min-[721px]:grid-cols-[clamp(320px,30%,460px)_minmax(0,1fr)]!">
            <aside className="rv-queue" aria-label="Pull requests">
              <div className="flex items-center gap-2 border-b border-[var(--border)] p-2">
                <div className="relative min-w-0 flex-1">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-[var(--text-muted)]" />
                  <Input
                    ref={search}
                    value={query}
                    placeholder="Search"
                    aria-label="Search pull requests"
                    className="h-8 border-[var(--border)] bg-[var(--bg)] pr-8 pl-8 text-[13px] shadow-none md:text-[13px]"
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
              {error && (
                <p role="alert" className="m-0 border-b border-[var(--border)] px-3 py-2 text-[13px] text-[var(--red)]">
                  {error}
                </p>
              )}
              {shownTab === "repos" && team && <Load prs={team} />}
              <div className="rv-queue-list">
                {shownTab === "repos" && team === null ? (
                  <SkeletonRows rows={3} />
                ) : order.length ? (
                  groups.map((g) => (
                    <div key={g.title || "all"} className="flex flex-col gap-px" role={g.quick ? "group" : undefined} aria-label={g.quick ? `Quick to review, ${g.items.length}` : undefined}>
                      {g.quick ? (
                        <QuickHeader n={g.items.length}>
                          {g.items.some(({ pr }) => !pr.draft && pr.review !== "approved") && (
                            <Tip label="Approve these on GitHub together">
                              <Button variant="ghost" size="xs" className="h-6 text-[12px] text-[var(--ink-2)]" onClick={() => approveQuick(g.items.map((i) => i.pr))}>
                                <CheckIcon /> Approve all
                              </Button>
                            </Tip>
                          )}
                        </QuickHeader>
                      ) : g.title && (
                        <h2 className="m-0 flex items-center gap-1.5 px-2.5 pt-2.5 pb-1 text-[11px] font-medium tracking-[0.06em] text-[var(--text-muted)] uppercase">
                          {g.title} <span className="tabular-nums">{g.items.length}</span>
                        </h2>
                      )}
                      {g.items.map(({ pr, kind }) => (
                        <QueueItem key={pr.url} pr={pr} kind={kind} on={current?.pr.url === pr.url} working={ctx.sessionFor.get(pr.url)} risk={kind === "merged" || g.quick ? undefined : risks.get(pr.url)} onPick={() => setSel(pr.url)} />
                      ))}
                    </div>
                  ))
                ) : null /* Said once, in the pane beside it, with the way on. */}
              </div>
              {shownTab === "you" && <AutoReview tools={tools} />}
            </aside>
            <section className="rv-pane" aria-label="Pull request">
              {/* The page's tabs and buttons, level with the top of the list beside it (Arun, 2026-10-19). */}
              {ready && <div className="mb-4 flex shrink-0 items-center justify-end gap-2">{controls}</div>}
              {current ? (
                <Pane key={current.pr.url} pr={current.pr} kind={current.kind} ctx={ctx} cmd={cmd} risk={risks.get(current.pr.url)} />
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
                    ) : shownTab === "you" && (prs?.mine.length ?? 0) > 0 ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setTab("mine");
                          // This button goes with the empty tab it sat in, so a keyboard user would be dropped on the page body:
                          // focus follows them to the tab they just went to.
                          requestAnimationFrame(() => document.querySelector<HTMLElement>('.review-page [role="tab"][aria-selected="true"]')?.focus());
                        }}
                      >
                        See yours · {prs!.mine.length}
                      </Button>
                    ) : shownTab === "mine" ? (
                      <Button size="sm" onClick={() => onWork("")}>
                        Start a session
                      </Button>
                    ) : undefined
                  }
                />
              )}
            </section>
          </div>
        )}
        {confirm && <ConfirmDialog confirmation={confirm} onClose={() => setConfirm(null)} />}
        {ready && (
          // As in a session: who you are on GitHub and whether it's checking on the left, the keys on the right.
          <footer className="status-bar rv-status mx-[-24px]! max-[640px]:mx-[-16px]!" aria-label="Code Review status">
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
              <span><kbd>1</kbd>–<kbd>5</kbd> Tabs</span>
              <span><kbd>R</kbd> Agent review</span>
              <span><kbd>G</kbd> GitHub</span>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}

/** The page with nothing to show yet: Dass's empty state, with the pull request mark on its tile. */
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
  onOpen?: (sid: string) => void;
  sessionFor: Map<string, BoardCard>;
  refresh: () => void;
  /** The coding tools on this computer that can review: installed and signed in. */
  tools: EngineTool[];
};

type Tone = "ok" | "bad" | "warn" | "wait" | "muted";
const DAY = 86_400_000;
const FIX_WORD = { checks: "Checks failing", conflicts: "Conflicts", comments: "Comments to address", behind: "Behind its base" } as const;

/** Where a pull request stands, in a few words, for its line in the queue. */
function standing(pr: PullRequest, kind: Kind): { text: string; tone: Tone } {
  const s = stepsOf(pr);
  if (kind === "review") {
    const d = Math.floor(waitedMs(pr) / DAY);
    return d >= 1 ? { text: `Waiting ${d}d on you`, tone: d >= 2 ? "warn" : "wait" } : { text: "Asked for your review", tone: "wait" };
  }
  if (kind === "ready") return { text: "Ready to merge", tone: "ok" };
  if (kind === "fix") return { text: fixesOf(pr).map((f) => FIX_WORD[f]).join(" · ") || "Needs a fix", tone: "bad" };
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

function QueueItem({ pr, kind, on, working, risk, onPick }: { pr: PullRequest; kind: Kind; on: boolean; working?: BoardCard; risk?: Risk; onPick: () => void }) {
  const root = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (on) root.current?.scrollIntoView({ block: "nearest" });
  }, [on]);
  const st = standing(pr, kind);
  const others = kind === "review" || kind === "team";
  const dot = dotOf(st.tone, kind, working);
  // State first: the dot and where it stands, then the title, then where it lives and who made it.
  return (
    <button
      ref={root}
      type="button"
      aria-current={on || undefined}
      onClick={onPick}
      className="flex w-full min-w-0 flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-colors duration-[var(--dass-fast)] hover:bg-[var(--hover)] aria-[current=true]:bg-[var(--hover)] aria-[current=true]:shadow-[inset_0_0_0_1px_var(--border)]"
    >
      <span className="flex min-w-0 items-start gap-2">
        <Dot state={dot} className="mt-[5px]" />
        <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug font-medium text-[var(--ink)]">{pr.title}</span>
        <Diff add={pr.additions} del={pr.deletions} className="mt-px" />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-[21px] text-[12px] text-[var(--text-muted)]">
        {others && pr.avatar && <img className="size-3.5 rounded-full" src={pr.avatar} alt="" />}
        <span className="truncate">
          {pr.repo.split("/")[1]} #{pr.number}
          {others && pr.author ? ` · ${pr.author}` : ""}
          {pr.base && !/^(main|master|trunk|develop)$/.test(pr.base) ? ` · stacked on ${pr.base}` : ""}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-2 pl-[21px]">
        <span className={cn("min-w-0 flex-1 truncate text-[12px] font-medium", TONE_TEXT[dotOf(st.tone, kind)])} title={`${sizeOf(pr)} change: ${pr.additions + pr.deletions} lines`}>
          {st.text}
          {working?.shepherd && <span className="text-[var(--dass-live)]"> · Friday is on it</span>}
        </span>
        {risk && !risk.quick && <RiskChip risk={risk} />}
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
        "h-7 rounded-full border-[var(--border)] bg-transparent px-2.5 text-[12px] font-medium text-[var(--text-muted)] shadow-none hover:bg-[var(--hover)] hover:text-[var(--ink)] dark:bg-transparent",
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
function AutoReview({ tools }: { tools: EngineTool[] }) {
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
    <div className="flex flex-col gap-2.5 border-t border-[var(--border)] p-3">
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
      <span className="mr-1 text-[11px] font-medium tracking-[0.06em] text-[var(--text-muted)] uppercase">Review load</span>
      {load.slice(0, 6).map((l) => (
        <Badge key={l.login} variant="outline" className="h-6 gap-1.5 rounded-full border-[var(--border)] pr-1 pl-1 text-[12px] font-medium text-[var(--ink-2)]" title={`${l.login}: asked to review ${l.count}`}>
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
  const [busy, setBusy] = useState("");
  const [tour, setTour] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [asking, setAsking] = useState(false);
  const [changes, setChanges] = useState("");
  const merged = kind === "merged";
  const others = kind === "review" || kind === "team";
  const session = ctx.sessionFor.get(pr.url);
  const fixes = fixesOf(pr);
  // Why it is where it is in the queue, weightiest first: the paths it touches, its tests and checks, what a reviewer found.
  const risks = kind === "merged" ? risksOf(pr) : (risk?.reasons ?? risksOf(pr));
  const quiet = (p: Promise<unknown>) => void p.catch(() => {});

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action);
    setNote(null);
    try {
      const r = await hostApi<{ note?: string; url?: string }>(ctx.identity, "/api/runner/pr.act", { method: "POST", body: JSON.stringify({ url: pr.url, action, head: pr.head, id: pr.id, ...extra }) });
      setNote({ text: r.note ?? "Done." });
      if (r.url) openOutside(r.url);
      ctx.refresh();
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
  if (kind === "fix" || kind === "waiting") {
    if (fixes.includes("behind")) buttons.push(quietBtn("b", busy === "update_branch" ? "Updating…" : "Update branch", () => quiet(act("update_branch")), { disabled: !!busy }));
    if (fixes.includes("checks")) buttons.push(quietBtn("c", "Fix checks", () => ctx.onWork(briefs.checks(pr))));
    if (fixes.includes("conflicts")) buttons.push(quietBtn("x", "Resolve conflicts", () => ctx.onWork(briefs.conflicts(pr))));
    if (fixes.includes("comments")) buttons.push(quietBtn("r", "Address comments", () => ctx.onWork(briefs.comments(pr))));
    if (kind === "fix" && !session?.shepherd)
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

  const files = pr.files ?? [];
  const risky = new Set(files.filter((f) => risksOf({ files: [f] }).length).map((f) => f.path));
  const nextDot: DotState = kind === "review" ? "needs" : next.tone === "bad" ? "bad" : next.tone === "ok" ? "done" : "idle";

  return (
    <div className="flex flex-col gap-7 px-1 pt-1 pb-8">
      <header className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <h2 className="m-0 min-w-0 flex-1 text-[20px] leading-tight font-semibold tracking-[-0.015em] text-[var(--ink)]" title={pr.title}>
            {pr.title}
          </h2>
          <div className="flex shrink-0 items-center gap-1">
            {!merged && (
              <Button variant="outline" size="sm" className="h-8 border-[var(--border)] bg-[var(--bg)] text-[13px] shadow-none" onClick={() => ctx.onWork(`${pr.url} `)}>
                Open in a session
              </Button>
            )}
            <Tip label="Open on GitHub" keys="G">
              <Button variant="ghost" size="icon-sm" aria-label="Open on GitHub" className="text-[var(--text-muted)] hover:text-[var(--ink)]" onClick={() => openOutside(pr.url)}>
                <ExternalLinkIcon />
              </Button>
            </Tip>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-[var(--text-muted)]">
          <span>
            {pr.repo} #{pr.number}
          </span>
          {pr.author && (
            <span className="inline-flex items-center gap-1.5 text-[var(--ink-2)]">
              {pr.avatar && <img className="size-4 rounded-full" src={pr.avatar} alt="" />}
              {pr.author}
            </span>
          )}
          {pr.branch && (
            <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[12px]" title={`${pr.branch} into ${pr.base || "its base"}`}>
              <GitBranchIcon className="size-3.5 shrink-0" />
              <span className="truncate">
                {pr.branch}
                {pr.base ? ` → ${pr.base}` : ""}
              </span>
            </span>
          )}
          <Diff add={pr.additions} del={pr.deletions} />
          <span>updated {relTime(Date.parse(pr.updatedAt))}</span>
        </div>
        {(session || risks.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {session && (
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
            )}
            {risks.map((r) => (
              <Badge
                key={r}
                variant="outline"
                className={cn("h-6 gap-1 rounded-md border-[var(--border)] px-2 text-[12px] font-medium text-[var(--ink-2)]", risk?.level === "high" && r === risk.top && "border-[color-mix(in_srgb,var(--red)_40%,var(--border))] text-[var(--red)]")}
                title="Worth a careful look"
              >
                <ShieldIcon /> {r}
              </Badge>
            ))}
          </div>
        )}
      </header>

      <div
        className={cn(
          "tray flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4",
          nextDot === "needs" && "border-[color-mix(in_srgb,var(--dass-needs)_40%,var(--border))]",
          nextDot === "bad" && "border-[color-mix(in_srgb,var(--red)_35%,var(--border))]",
        )}
      >
        <div className="flex items-start gap-2.5">
          <Dot state={nextDot} className="mt-[6px]" />
          <div className="flex min-w-0 flex-col gap-1">
            <b className="text-[14px] font-semibold text-[var(--ink)]">{next.title}</b>
            <span className="text-[13px] leading-relaxed text-[var(--text-muted)]">{next.body}</span>
          </div>
        </div>
        {asking ? (
          <div className="flex flex-col gap-2 pl-[21px]">
            <Textarea className="min-h-20 border-[var(--border)] bg-[var(--bg)] text-[13px] md:text-[13px]" rows={3} autoFocus value={changes} placeholder="What should change before this merges" onChange={(e) => setChanges(e.target.value)} />
            <div className="flex justify-end gap-1.5">
              {quietBtn("cancel", "Cancel", () => setAsking(false))}
              <Button size="sm" className="h-8 text-[13px]" disabled={!changes.trim() || !!busy} onClick={() => quiet(act("request_changes", { body: changes }).then(() => setAsking(false)))}>
                Request changes
              </Button>
            </div>
          </div>
        ) : (
          buttons.length > 0 && <div className="flex flex-wrap items-center justify-end gap-1.5">{buttons}</div>
        )}
        {note && (
          <p className={cn("m-0 pl-[21px] text-[13px]", note.bad ? "text-[var(--red)]" : "text-[var(--text-muted)]")} role={note.bad ? "alert" : "status"}>
            {note.text}
          </p>
        )}
      </div>

      {!merged && <Checklist pr={pr} mine={!others} ctx={ctx} act={act} />}
      {!merged && <AgentReview pr={pr} ctx={ctx} mine={!others} act={act} />}

      {files.length > 0 && (
        <Section
          title="Files changed"
          meta={
            <>
              {pr.changedFiles ?? files.length}
              {" · "}
              <button type="button" className="link-btn" onClick={() => setTour(true)}>
                Guided tour
              </button>
            </>
          }
        >
          {tour && <ReviewTour pr={pr} files={files} onClose={() => setTour(false)} />}
          <ul className="tray m-0 flex list-none flex-col divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] p-0">
            {files.slice(0, 20).map((f) => (
              <li key={f.path} className="flex min-w-0 items-center gap-2.5 px-3 py-2 text-[13px]" title={f.path}>
                <FileIcon path={f.path} size={14} />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--ink)]">
                  {f.path.includes("/") && <span className="text-[var(--text-muted)]">{f.path.slice(0, f.path.lastIndexOf("/") + 1)}</span>}
                  {f.path.slice(f.path.lastIndexOf("/") + 1)}
                </span>
                {risky.has(f.path) && (
                  <Badge variant="outline" className="h-5 gap-1 rounded-md border-[var(--border)] px-1.5 text-[11px] font-medium text-[var(--ink-2)]">
                    <ShieldIcon /> Worth a look
                  </Badge>
                )}
                <Diff add={f.additions} del={f.deletions} />
              </li>
            ))}
          </ul>
          {(pr.changedFiles ?? files.length) > 20 && (
            <Button variant="link" size="sm" className="h-auto self-start p-0 text-[13px]" onClick={() => openOutside(`${pr.url}/files`)}>
              {(pr.changedFiles ?? files.length) - 20} more on GitHub
            </Button>
          )}
        </Section>
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
  if (kind === "ready") return { title: "Ready to merge", body: "Checks pass, it's approved and it merges cleanly.", tone: "ok" };
  if (kind === "fix") {
    const f = fixesOf(pr);
    return { title: f.length > 1 ? `${f.length} things to fix before it can merge` : "One thing to fix before it can merge", body: `${f.map((x, i) => (i ? FIX_WORD[x].toLowerCase() : FIX_WORD[x])).join(", ")}. Fix each in a session, or let Friday see it through: it keeps fixing new red checks and comments until it merges.`, tone: "bad" };
  }
  if (kind === "draft") return { title: "Still a draft", body: "Nobody is asked to review it yet. Mark it ready when it is.", tone: "muted" };
  if (kind === "merged") return { title: "Merged", body: `Went into ${pr.base || "its base branch"} ${relTime(Date.parse(pr.mergedAt ?? pr.updatedAt))}.`, tone: "muted" };
  if (kind === "team") {
    const who = (pr.requested ?? []).map((r) => r.login);
    return { title: `${pr.author || "A teammate"}'s pull request`, body: who.length ? `Waiting on a review from ${who.join(", ")}.` : "Nobody is asked to review it.", tone: "muted" };
  }
  return { title: "Nothing for you to do yet", body: s.checks === "wait" ? "Its checks are still running." : s.review === "wait" ? "It's waiting for someone to review it." : pr.mergeState === "behind" ? "It's behind its base branch: update it to merge." : "GitHub is still working out whether it merges cleanly.", tone: "wait" };
}

const STEP_WORD: Record<"checks" | "review" | "merge", Record<Mark, string>> = {
  checks: { ok: "All checks pass", bad: "Checks are failing", wait: "Checks are running", skip: "No checks on this repo" },
  review: { ok: "Approved", bad: "Changes were requested", wait: "Waiting for a review", skip: "No review needed" },
  merge: { ok: "Merges cleanly", bad: "Conflicts with its base branch", wait: "Merge check pending", skip: "" },
};

/** The three things between a pull request and merging, top to bottom, with what is wrong under the one that is. */
function Checklist({ pr, mine, ctx, act }: { pr: PullRequest; mine: boolean; ctx: Ctx; act: (action: string, extra?: Record<string, unknown>) => Promise<void> }) {
  const s = stepsOf(pr);
  const failing = pr.failing ?? [];
  const quiet = (p: Promise<unknown>) => void p.catch(() => {});
  const mergeWord = pr.mergeState === "behind" && pr.mergeable !== false ? "Behind its base branch" : STEP_WORD.merge[s.merge];
  // The three steps in a row, read left to right like any progress; what is wrong with one is said under the row.
  const step = (k: "checks" | "review" | "merge", label: string) => (
    <li
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-[13px] font-medium text-[var(--ink)]",
        s[k] === "bad" && "border-[color-mix(in_srgb,var(--red)_40%,var(--border))]",
        s[k] === "skip" && "text-[var(--text-muted)]",
      )}
      aria-label={`${k}: ${label}`}
    >
      <span
        aria-hidden
        className={cn(
          "grid size-[18px] shrink-0 place-items-center rounded-full [&_svg]:size-3",
          s[k] === "ok" && "bg-[var(--ink)] text-[var(--bg)]",
          s[k] === "bad" && "bg-[var(--red)] text-white",
          s[k] === "wait" && "border-[1.5px] border-dashed border-[var(--border-strong)]",
          s[k] === "skip" && "border-[1.5px] border-[var(--border)]",
        )}
      >
        {s[k] === "ok" ? <CheckIcon strokeWidth={3} /> : s[k] === "bad" ? <XIcon strokeWidth={3} /> : null}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </li>
  );
  const checksDetail =
    failing.length > 0 && (
      <>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {failing.slice(0, 8).map((c) => (
            <li key={c.name + c.url} className="flex items-center gap-2 text-[13px]">
              <Dot state={c.state === "failing" ? "bad" : "idle"} />
              {c.url ? (
                <Button variant="link" size="sm" className="h-auto p-0 text-[13px] font-medium text-[var(--ink)]" onClick={() => openOutside(c.url)}>
                  {c.name}
                </Button>
              ) : (
                <span className="font-medium text-[var(--ink)]">{c.name}</span>
              )}
              <span className="ml-auto text-[12px] text-[var(--text-muted)]">{c.state === "failing" ? "failed" : "running"}</span>
            </li>
          ))}
        </ul>
        {mine && failing.some((c) => c.state === "failing") && (
          <div className="flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" className="h-7 border-[var(--border)] bg-[var(--bg)] text-[12px] shadow-none" onClick={() => quiet(act("rerun"))}>
              Re-run failed
            </Button>
            <Button variant="outline" size="sm" className="h-7 border-[var(--border)] bg-[var(--bg)] text-[12px] shadow-none" onClick={() => ctx.onWork(briefs.checks(pr))}>
              Fix in a session
            </Button>
          </div>
        )}
      </>
    );
  return (
    <Section title="Before it can merge">
      <ol className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-3">
        {step("checks", STEP_WORD.checks[s.checks])}
        {step("review", STEP_WORD.review[s.review])}
        {step("merge", mergeWord)}
      </ol>
      {checksDetail && <div className="flex flex-col gap-2.5 px-1">{checksDetail}</div>}
      {(pr.unresolved ?? 0) > 0 && (
        <p className="m-0 px-1 text-[13px] text-[var(--text-muted)]">
          {pr.unresolved} unresolved comment thread{pr.unresolved === 1 ? "" : "s"}
        </p>
      )}
    </Section>
  );
}

const SEV: Record<ReviewFinding["severity"], string> = { high: "High", medium: "Medium", low: "Low" };

function AgentReview({ pr, ctx, mine, act }: { pr: PullRequest; ctx: Ctx; mine: boolean; act: (action: string, extra?: Record<string, unknown>) => Promise<void> }) {
  useReviews();
  const run = reviews.get(pr.url);
  const [picked, setPicked] = useState<EngineTool[]>(() => (run?.results.length ? run.results.map((r) => r.tool) : ctx.tools.slice(0, 1)));
  const tools = ENGINE_TOOLS.filter((t) => ctx.tools.includes(t));
  const merged = useMemo(() => (run ? mergeFindings(run.results) : []), [run]);
  const agreed = merged.filter((f) => f.by.length > 1).length;
  const asked = run ? run.results.length + Object.keys(run.errors).length + run.running.length : 0;
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
      {!tools.length ? (
        <p className={muted}>Install or sign in to Claude Code, Codex or Cursor on this computer to have them review pull requests.</p>
      ) : (
        <>
          {!run && <p className={muted}>Your own coding tools read the change against the repo's rules and say what would break or isn't safe. Pick more than one to see where they agree.</p>}
          <div className="flex flex-wrap items-center gap-1.5">
            {tools.map((t) => (
              <ToolChip key={t} tool={t} on={picked.includes(t)} onClick={() => setPicked((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]))} />
            ))}
            <Tip label="Have your agents read it" keys="R">
              <Button
                variant={run ? "outline" : "default"}
                size="sm"
                className={cn("ml-auto h-8 text-[13px]", run && "border-[var(--border)] bg-[var(--bg)] shadow-none")}
                disabled={!picked.length || !!run?.running.length}
                onClick={() => void runReview(ctx.identity, pr, picked)}
              >
                {run?.running.length ? <Dot state="working" /> : null}
                {run?.running.length ? `Reading… ${asked - run.running.length}/${asked}` : run ? "Review again" : picked.length > 1 ? `Review with ${picked.length} agents` : "Run agent review"}
              </Button>
            </Tip>
          </div>
        </>
      )}
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
                    "mt-px h-5 w-[58px] shrink-0 rounded-md border-[var(--border)] px-1.5 text-[11px] font-medium text-[var(--text-muted)]",
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
