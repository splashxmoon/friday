import { useEffect, useState, type ReactNode } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import type { SessionState } from "../session/projection.js";
import { MAIN_LANE, type Member, type SessionEvent } from "../types.js";
import type { PrStatus } from "../github-status.js";
import type { PrCheckState, PrDetail, PrPerson } from "../pr-detail.js";
import { Avatar, Icon, type IconName } from "./icons.js";
import { ShipDialog } from "./Ship.js";
import { relTime } from "./ui.js";
import type { Send } from "./useSession.js";
import "./git-panel.css";
import "./pr-panel.css";

/**
 * The session's pull request, a panel of its own beside the chat (Arun, 2026-11-16: "let's add these", after the other tools' side
 * panels, where PR and checks are a tab of their own): where it stands on GitHub in three steps (checks, review, merge), the
 * checks that failed with their links, the ways to hand them or the reviewers' comments to the agent, and Friday seeing it through
 * to merge. With none yet, the way to open one: the commit box, at "Open a pull request".
 *
 * In full, as GitHub's own page and Graphite's keep one (Arun, 2026-11-19: "a more better design of this, with more details and
 * info and stuff like how others do it", then "FOLLOW MY DESIGN LANGUAGE I HAVE THROUGHOUT THE APP"), in the Git panel's grammar
 * (git-panel.css): a header strip with who opened it, where it goes and its facts as chips; where it stands; then sections headed
 * by a name and a count, Checks (what failed and runs first, how long each took), Reviewers, Description, Commits on the history
 * line, Files with their lines. Read from the person's gh (pr-detail.ts); without it, where it stands alone.
 */

type Checks = { failures: { name: string; workflow?: string; link?: string; outcome?: string }[]; pending: number } | { error: string };
type Got = { url: string; at: number; lane?: string; status: PrStatus | null; checks?: Checks; detail?: PrDetail } | null;

/** How often it asks while open: GitHub's answer is cached for a minute on the server anyway. */
const EVERY_MS = 45_000;

export function PrPanel({ state, events, sid, invite, send, me, shown, onTab }: { state: SessionState; events: readonly SessionEvent[]; sid: string; invite: string; send: Send; me: Member; /** Showing now: it only asks GitHub while it is. */ shown: boolean; onTab: (t: "files") => void }) {
  // The pull request the session's last commit opened, as the chat's commit card names it.
  const commit = events.findLast((e) => e.body.type === "folder.committed" && !e.body.error && !!e.body.prUrl);
  const prUrl = commit?.body.type === "folder.committed" ? (commit.body.prUrl ?? "") : "";
  const lane = commit?.lane ?? MAIN_LANE;
  const [got, setGot] = useState<Got | undefined>(undefined);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [shipping, setShipping] = useState(false);
  useEffect(() => {
    if (!shown || !prUrl) return;
    let live = true;
    const ask = () =>
      fetch(`/api/sessions/${encodeURIComponent(sid)}/pr?invite=${encodeURIComponent(invite)}&checks=1&detail=1`, { credentials: "same-origin" })
        .then((r) => r.json() as Promise<{ pr: Got }>)
        .then((d) => live && setGot(d.pr))
        .catch(() => live && setGot((g) => g ?? null));
    void ask();
    const t = setInterval(ask, EVERY_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [shown, prUrl, sid, invite]);

  const engine = state.engines[lane] ?? state.engines[MAIN_LANE];
  const may = me.role !== "viewer" && !!engine?.online;
  const act = async (key: string, cmd: Record<string, unknown>, ok: string) => {
    setBusy(key);
    setNote("");
    const r = await send(cmd);
    setBusy("");
    setNote(r.ok ? ok : (r.error ?? "That didn't go through."));
  };

  if (!prUrl) {
    const changed = Object.values(state.diffs).reduce((n, d) => n + (d?.files.length ?? 0), 0);
    return (
      <div className="prp prp-empty">
        <span className="prp-empty-mark" aria-hidden="true">
          <Icon name="gitPullRequest" size={20} />
        </span>
        <h3>No pull request yet</h3>
        <p>{changed ? `The agents have changed ${changed} file${changed === 1 ? "" : "s"}. Commit them and open one, and its checks and reviews show here.` : "When the agents' work is ready, commit it and open one. Its checks and reviews show here, and Friday can see it through to merge."}</p>
        {may && changed > 0 && (
          <button type="button" className="prp-btn primary" onClick={() => setShipping(true)}>
            <Icon name="gitPullRequest" size={13} /> Open a pull request
          </button>
        )}
        {changed > 0 && (
          <button type="button" className="prp-link" onClick={() => onTab("files")}>
            See the changes first
          </button>
        )}
        {shipping && <ShipDialog state={state} sid={sid} invite={invite} send={send} lane={lane} start="pr" onClose={() => setShipping(false)} />}
      </div>
    );
  }

  const st = got?.status ?? null;
  const d = got?.detail ?? null;
  const number = prUrl.match(/\/pull\/(\d+)/)?.[1];
  const repo = prUrl.match(/github\.com\/([^/]+\/[^/]+)\//)?.[1];
  const merged = st?.state === "merged" || !!state.pr?.merged || !!d?.mergedAt;
  const closed = !merged && (st?.state === "closed" || (!!d?.closedAt && !st));
  const open = !merged && !closed;
  const seeing = state.shepherd?.prUrl === prUrl;
  const failures = got?.checks && "failures" in got.checks ? got.checks.failures : [];
  const pending = got?.checks && "pending" in got.checks ? got.checks.pending : 0;
  const checksErr = got?.checks && "error" in got.checks ? got.checks.error : "";
  const body = commit?.body.type === "folder.committed" ? commit.body : null;
  const title = d?.title || (body?.message.split("\n")[0] ?? `Pull request #${number ?? ""}`);
  const base = d?.base || body?.base || "main";
  const head = d?.head || body?.branch || "";
  const files = state.diffs[lane]?.files ?? [];
  const adds = d ? d.additions : files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const dels = d ? d.deletions : files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  const fileCount = d ? d.changedFiles : (body?.files ?? files.length);
  const by = d?.author ? who(d.author) : commit ? commit.actor.name.replace(/^[^']+'s /, "") : "";
  const draft = !!(st?.draft || d?.mergeState === "DRAFT");
  const pill: [string, string] = merged ? ["Merged", "merged"] : closed ? ["Closed", "closed"] : draft ? ["Draft", "draft"] : ["Open", "open"];
  const ago = (ts: number) => ((t) => (t === "now" ? "just now" : /\d$/.test(t) ? t : `${t} ago`))(relTime(ts));

  // Every check, the failing first (pr-detail.ts); the counts by how each stands.
  const checks = [...(d?.checks ?? [])].sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state] || a.name.localeCompare(b.name));
  const count = (k: PrCheckState) => checks.filter((c) => c.state === k).length;
  const tally = { pass: count("pass"), fail: count("fail"), pending: count("pending"), skip: count("skip") + count("neutral") };
  const tallyLine = [tally.pass && `${tally.pass} passed`, tally.fail && `${tally.fail} failed`, tally.pending && `${tally.pending} running`, tally.skip && `${tally.skip} skipped`].filter(Boolean).join(" · ");

  // Where it stands, in a line: what is in its way, if anything, the most pressing first.
  const verdict: [string, "ok" | "bad" | "wait" | "none" | "merged"] | null = merged
    ? ["Merged", "merged"]
    : closed
      ? ["Closed without merging", "none"]
      : !st
        ? null
        : st.checks === "failing"
          ? [`Blocked: ${(tally.fail || failures.length) > 1 ? `${tally.fail || failures.length} checks are` : "a check is"} failing`, "bad"]
          : st.review === "changes_requested"
            ? ["Blocked: changes were requested", "bad"]
            : st.mergeable === false
              ? ["Blocked: it conflicts with its base", "bad"]
              : st.checks === "pending"
                ? ["Checks are still running", "wait"]
                : st.review === "review_required"
                  ? ["Waiting on a review", "wait"]
                  : d?.mergeState === "BEHIND"
                    ? [`Behind ${base}: update the branch to merge`, "wait"]
                    : ["Ready to merge", "ok"];

  const reviewers = d?.reviewers ?? [];
  const approvals = reviewers.filter((r) => r.state === "approved");
  const steps: { key: string; name: string; word: string; sub: string; tone: "ok" | "bad" | "wait" | "none" | "merged" }[] = st
    ? [
        st.checks === "passing"
          ? { key: "checks", name: "Checks", word: "All passing", sub: tallyLine || "Every check GitHub ran on it passed.", tone: "ok" }
          : st.checks === "failing"
            ? { key: "checks", name: "Checks", word: `${tally.fail || failures.length || "Some"} failing`, sub: tallyLine || (pending ? `${pending} still running.` : "The rest passed."), tone: "bad" }
            : st.checks === "pending"
              ? { key: "checks", name: "Checks", word: "Running", sub: tallyLine || (pending ? `${pending} still to finish.` : "GitHub is running them."), tone: "wait" }
              : { key: "checks", name: "Checks", word: "None", sub: "This repository runs no checks on pull requests.", tone: "none" },
        st.review === "approved"
          ? { key: "review", name: "Review", word: "Approved", sub: approvals.length ? `By ${names(approvals.map((r) => who(r.who)))}.` : "A reviewer approved it.", tone: "ok" }
          : st.review === "changes_requested"
            ? { key: "review", name: "Review", word: "Changes requested", sub: ((r) => (r.length ? `${names(r.map((x) => who(x.who)))} asked for changes before it merges.` : "A reviewer asked for changes before it merges."))(reviewers.filter((r) => r.state === "changes")), tone: "bad" }
            : st.review === "review_required"
              ? { key: "review", name: "Review", word: "Waiting on a reviewer", sub: ((r) => (r.length ? `Asked: ${names(r.map((x) => who(x.who)))}.` : "The repository needs an approval to merge."))(reviewers.filter((r) => r.state === "pending")), tone: "wait" }
              : { key: "review", name: "Review", word: reviewers.some((r) => r.state === "commented") ? "Commented" : "Not needed", sub: reviewers.some((r) => r.state === "commented") ? `${names(reviewers.filter((r) => r.state === "commented").map((r) => who(r.who)))} left a review. Nobody has to approve it to merge.` : "Nobody has to approve it to merge.", tone: "none" },
        merged
          ? { key: "merge", name: "Merge", word: "Merged", tone: "merged", sub: `${d?.mergedBy ? `By ${who(d.mergedBy)} into` : "Into"} ${base}${d?.mergedAt ? `, ${ago(d.mergedAt)}` : ""}.` }
          : closed
            ? { key: "merge", name: "Merge", word: "Closed", sub: "It was closed without merging.", tone: "none" }
            : st.mergeable === false
              ? { key: "merge", name: "Merge", word: "Conflicts", sub: `It conflicts with ${base}: the branch needs updating.`, tone: "bad" }
              : st.mergeable === null
                ? { key: "merge", name: "Merge", word: "Checking", sub: "GitHub is still working out whether it can merge.", tone: "wait" }
                : { key: "merge", name: "Merge", word: "No conflicts", sub: `It merges cleanly into ${base}.`, tone: "ok" },
      ]
    : [];

  // What happened to it since it opened: the commits pushed to its branch, and what Friday did seeing it through.
  const since = commit ? events.filter((e) => e.seq > commit.seq) : [];
  const activity = since
    .flatMap((e) => {
      const b = e.body;
      if (b.type === "folder.committed" && !b.error && (!body?.branch || b.branch === body.branch)) return [{ seq: e.seq, ts: e.ts, icon: "gitCommit" as IconName, text: `${e.actor.name.replace(/^[^']+'s /, "")} pushed “${b.message.split("\n")[0]}”`, tone: "" }];
      if (b.type === "pr.shepherd") return [{ seq: e.seq, ts: e.ts, icon: "gitPullRequest" as IconName, text: b.on ? `${e.actor.name.split(/\s+/)[0]} handed it to Friday to see through` : `${e.actor.name.split(/\s+/)[0]} took it back from Friday`, tone: "" }];
      if (b.type === "pr.shepherd.step") return [{ seq: e.seq, ts: e.ts, icon: (b.step === "pushed" ? "gitCommit" : b.step === "comments" ? "chat" : "check") as IconName, text: b.text, tone: "" }];
      if (b.type === "pr.shepherd.ended") return [{ seq: e.seq, ts: e.ts, icon: "check" as IconName, text: b.text, tone: b.outcome === "merged" ? "ok" : "" }];
      return [];
    })
    .slice(-6)
    .reverse();

  const handLogs = open && failures.length > 0 && may && !seeing && (
    <button type="button" className="gx-link" disabled={!!busy} onClick={() => void act("checks", { type: "pr.checks", lane }, "The failing checks are with the agent.")}>
      {busy === "checks" ? <span className="spinner" /> : null} Hand the logs to the agent
    </button>
  );
  const when = (merged ? d?.mergedAt : closed ? d?.closedAt : undefined) ?? d?.createdAt ?? commit?.ts;

  return (
    <div className="prp gx">
      {/* Which pull request, as the Git panel heads a branch: its state and number, its title, who and where, and its facts. */}
      <header className="gx-head prp-head">
        <div className="prp-head-row">
          <span className={`prp-pill ${pill[1]}`}>
            <Icon name={merged ? "gitMerge" : "gitPullRequest"} size={12} />
            {pill[0]}
          </span>
          <span className="prp-num">
            {repo ? <span className="prp-repo">{repo}</span> : null}
            <b>#{number ?? "?"}</b>
          </span>
          <span className="gx-grow" />
          <button type="button" className="gx-icon" aria-label="Copy its link" title="Copy its link" onClick={() => void navigator.clipboard?.writeText(prUrl).then(() => setNote("Link copied."))}>
            <Icon name="copy" size={13} />
          </button>
          <a className="gx-btn prp-gh" href={prUrl} target="_blank" rel="noreferrer">
            GitHub <Icon name="arrowUpRight" size={12} />
          </a>
        </div>
        <h3 className="prp-title-text">{title}</h3>
        <p className="gx-vs prp-by">
          {by && <b>{by}</b>} {merged ? "merged" : closed ? "closed" : "wants to merge"}
          {d ? ` ${d.commitCount} commit${d.commitCount === 1 ? "" : "s"}` : ""} into <code>{base}</code>
          {head && (
            <>
              {" "}
              from <code title={head}>{head}</code>
            </>
          )}
          {when ? <span title={new Date(when).toLocaleString()}> · {ago(when)}</span> : null}
        </p>
        <div className="gx-sync">
          {(adds > 0 || dels > 0) && (
            <span className="gx-chip prp-lines" title={`${adds.toLocaleString()} lines added, ${dels.toLocaleString()} removed`}>
              <span className="add">+{adds.toLocaleString()}</span>
              <span className="del">−{dels.toLocaleString()}</span>
            </span>
          )}
          {fileCount > 0 && <span className="gx-chip">{fileCount} file{fileCount === 1 ? "" : "s"}</span>}
          {d && d.comments > 0 && (
            <span className="gx-chip">
              <Icon name="chat" size={11} /> {d.comments}
            </span>
          )}
          {d?.closes.map((i) => (
            <a key={i.url} className="gx-chip prp-closes" href={i.url} target="_blank" rel="noreferrer" title="It closes this issue when it merges">
              Closes {i.repo && i.repo !== repo ? `${i.repo}#${i.number}` : `#${i.number}`}
            </a>
          ))}
          {d?.labels.map((l) => (
            <span key={l.name} className="gx-chip prp-label" style={{ ["--label" as string]: `#${l.color}` }}>
              {l.name}
            </span>
          ))}
        </div>
      </header>

      <div className="gx-body">
        {got === undefined && <p className="gx-quiet">Asking GitHub where it stands…</p>}
        {got !== undefined && !st && !d && <p className="gx-quiet">GitHub didn't answer. Signing in to gh on this computer (gh auth login) lets Friday read the pull request.</p>}

        {/* Where it stands: the verdict, then checks, review and merge. */}
        {st && (
          <section className="prp-card" aria-label="Where it stands">
            {verdict && (
              <div className={`prp-verdict ${verdict[1]}`}>
                <span className="prp-verdict-dot" aria-hidden="true" />
                {verdict[0]}
                {st.source === "gh" && <span className="prp-src">via gh</span>}
              </div>
            )}
            <ol className="prp-steps">
              {steps.map((x) => (
                <li key={x.key} className={`prp-step ${x.tone}`}>
                  <span className="prp-step-mark" aria-hidden="true">
                    {x.tone === "merged" ? <Icon name="gitMerge" size={11} /> : x.tone === "ok" ? <Icon name="check" size={11} /> : x.tone === "bad" ? <Icon name="x" size={11} /> : x.tone === "wait" ? <span className="prp-spin" /> : null}
                  </span>
                  <div className="prp-step-text">
                    <div className="prp-step-line">
                      <span className="prp-step-name">{x.name}</span>
                      <span className="prp-step-word">{x.word}</span>
                    </div>
                    <span className="prp-step-sub">{x.sub}</span>
                    {/* Without the whole of it (an older runner), the failing checks here, as before. */}
                    {x.key === "checks" && open && !d && failures.length > 0 && (
                      <ul className="prp-fails">
                        {failures.map((f) => (
                          <li key={`${f.workflow ?? ""}/${f.name}`}>
                            <span className="prp-fail-dot" aria-hidden="true" />
                            <span className="prp-fail-name">
                              {f.name}
                              {f.workflow && f.workflow !== f.name ? <span className="prp-fail-wf"> · {f.workflow}</span> : null}
                            </span>
                            {f.link && (
                              <a href={f.link} target="_blank" rel="noreferrer" className="prp-fail-link" title="Its log on GitHub">
                                Log <Icon name="arrowUpRight" size={11} />
                              </a>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {x.key === "checks" && open && checksErr && <span className="prp-step-sub">{checksErr}</span>}
                    {x.key === "checks" && !d && handLogs}
                    {x.key === "review" && open && st.review !== "none" && may && !seeing && (
                      <button type="button" className="gx-link prp-step-act" disabled={!!busy} onClick={() => void act("feedback", { type: "pr.feedback", lane }, "Review comments sent to the agent.")}>
                        {busy === "feedback" ? <span className="spinner" /> : null} Pull in the review comments
                      </button>
                    )}
                    {x.key === "merge" && merged && d?.mergeCommit && repo && (
                      <a className="prp-sha-link" href={`https://github.com/${repo}/commit/${d.mergeCommit}`} target="_blank" rel="noreferrer" title="The merge commit on GitHub">
                        <code>{d.mergeCommit.slice(0, 7)}</code>
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}

        {open && (
          <section className={`prp-see${seeing ? " on" : ""}`} aria-label="See it through">
            <span className="prp-see-mark" aria-hidden="true">
              {seeing ? <span className="prp-spin live" /> : <Icon name="gitPullRequest" size={14} />}
            </span>
            <div className="prp-see-text">
              <b>{seeing ? "Friday is seeing it through" : "See it through to merge"}</b>
              <span>{seeing ? `${state.shepherd!.by.split(/\s+/)[0]} handed it over. Red checks and new review comments go to the agent, and its fixes are pushed.` : "Friday watches its checks and reviews, hands what fails to the agent, and pushes the fixes until it can merge."}</span>
            </div>
            {may && (
              <button type="button" className={`gx-btn${seeing ? "" : " primary"}`} disabled={!!busy} onClick={() => void act("see", { type: "pr.shepherd", on: !seeing, lane }, seeing ? "Friday stopped watching it." : "Friday is seeing it through.")}>
                {busy === "see" ? <span className="spinner" /> : null}
                {seeing ? "Stop" : "Start"}
              </button>
            )}
          </section>
        )}

        {note && (
          <p className="gx-quiet" role="status">
            {note}
          </p>
        )}

        {d && checks.length > 0 && <Checks checks={checks} act={handLogs || null} />}

        {d && reviewers.length > 0 && (
          <Sec title="Reviewers" count={reviewers.length} hint={d.assignees.length ? `Assigned to ${names(d.assignees.map(who))}.` : undefined}>
            <ul className="gx-list">
              {reviewers.map((r) => (
                <li key={r.who.login} className="gx-file">
                  <span className="gx-main prp-row" title={r.who.name ? `${r.who.name} (@${r.who.login})` : `@${r.who.login}`}>
                    <Avatar name={who(r.who)} id={r.who.login} size={18} />
                    <span className="gx-name">{who(r.who)}</span>
                    {r.body && <span className="gx-dir">“{r.body.split("\n")[0]}”</span>}
                    <span className="gx-grow" />
                    <span className={`gx-chip prp-review ${r.state}`}>{REVIEW_WORD[r.state]}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Sec>
        )}

        {d && <Description text={d.body} />}

        {d && d.commits.length > 0 && <Commits commits={d.commits} total={d.commitCount} repo={repo} ago={ago} prUrl={prUrl} />}

        {d && d.files.length > 0 && <Files files={d.files} total={d.changedFiles} adds={d.additions} dels={d.deletions} prUrl={prUrl} />}

        {activity.length > 0 && (
          <Sec title="Since it opened">
            <ol className="prp-feed">
              {activity.map((a) => (
                <li key={a.seq} className={a.tone}>
                  <span className="prp-feed-mark" aria-hidden="true">
                    <Icon name={a.icon} size={12} />
                  </span>
                  <span className="prp-feed-text">{a.text}</span>
                  <span className="prp-feed-when">{ago(a.ts)}</span>
                </li>
              ))}
            </ol>
          </Sec>
        )}

        {state.prs.length > 1 && (
          <Sec title="Earlier in this session">
            <ul className="prp-earlier">
              {state.prs
                .filter((u) => u !== prUrl)
                .reverse()
                .map((u) => (
                  <li key={u}>
                    <a href={u} target="_blank" rel="noreferrer">
                      #{u.match(/\/pull\/(\d+)/)?.[1] ?? u}
                    </a>
                  </li>
                ))}
            </ul>
          </Sec>
        )}
      </div>
    </div>
  );
}

// ── Pieces, each a section as the Git panel draws one ────────────────────────────────────────────────────────────────

const CHECK_ORDER: Record<PrCheckState, number> = { fail: 0, pending: 1, pass: 2, neutral: 3, skip: 4 };
const CHECK_WORD: Record<PrCheckState, string> = { pass: "Passed", fail: "Failed", pending: "Running", skip: "Skipped", neutral: "Neutral" };
const REVIEW_WORD: Record<PrDetail["reviewers"][number]["state"], string> = { approved: "Approved", changes: "Changes requested", commented: "Commented", pending: "Asked", dismissed: "Dismissed" };
const CHANGE: Record<PrDetail["files"][number]["change"], [string, string]> = { added: ["A", "added"], modified: ["M", "modified"], deleted: ["D", "deleted"], renamed: ["R", "renamed"] };
const who = (p: PrPerson) => p.name || p.login;
const names = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
/** "1m 52s", "40s", "1h 3m": how long a check ran. */
const took = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/** A section, headed as the Git panel heads one: its name and count, its actions at the end, a line of what it means. */
function Sec({ title, count, acts, hint, children }: { title: string; count?: number; acts?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="gx-sec" aria-label={title}>
      <header className="gx-sec-head">
        <h3>
          {title} {count !== undefined && <span className="gx-count">{count}</span>}
        </h3>
        {acts && <span className="gx-sec-acts">{acts}</span>}
      </header>
      {hint && <p className="gx-hint">{hint}</p>}
      {children}
    </section>
  );
}

/** Every check: what failed and what still runs, always; what passed or was skipped, a press away. */
function Checks({ checks, act }: { checks: PrDetail["checks"]; act: ReactNode }) {
  const [all, setAll] = useState(false);
  const urgent = checks.filter((c) => c.state === "fail" || c.state === "pending");
  const rest = checks.length - urgent.length;
  const shown = all || !urgent.length ? checks : urgent;
  return (
    <Sec
      title="Checks"
      count={checks.length}
      acts={
        <>
          {act}
          {urgent.length > 0 && rest > 0 && (
            <button type="button" className="gx-link" onClick={() => setAll((a) => !a)}>
              {all ? "Only what needs looking at" : `Show the ${rest} that finished`}
            </button>
          )}
        </>
      }
    >
      <ul className="gx-list">
        {shown.map((c, i) => (
          <li key={`${c.workflow ?? ""}/${c.name}/${i}`} className={`gx-file prp-check ${c.state}`}>
            {(() => {
              const inner = (
                <>
                  <span className="prp-check-mark" aria-label={CHECK_WORD[c.state]}>
                    {c.state === "pass" ? <Icon name="check" size={10} /> : c.state === "fail" ? <Icon name="x" size={10} /> : c.state === "pending" ? <span className="prp-spin" /> : <Icon name="minus" size={10} />}
                  </span>
                  <span className="gx-name">{c.name}</span>
                  {c.workflow && <span className="gx-dir">{c.workflow}</span>}
                  <span className="gx-grow" />
                  <span className="prp-took">{c.startedAt && c.completedAt ? took(c.completedAt - c.startedAt) : CHECK_WORD[c.state]}</span>
                  {c.link && <Icon name="arrowUpRight" size={12} className="prp-out" />}
                </>
              );
              return c.link ? (
                <a className="gx-main prp-row" href={c.link} target="_blank" rel="noreferrer" title={`${c.name}: its log on GitHub`}>
                  {inner}
                </a>
              ) : (
                <span className="gx-main prp-row">{inner}</span>
              );
            })()}
          </li>
        ))}
      </ul>
    </Sec>
  );
}

function Description({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const long = text.length > 700 || text.split("\n").length > 14;
  return (
    <Sec title="Description">
      {text.trim() ? (
        <>
          <div className={`prp-desc${long && !full ? " folded" : ""}`}>
            <MessageResponse>{text}</MessageResponse>
          </div>
          {/* Where the text fades, not up by the heading: the eye is at the fold when it wants the rest. */}
          {long && (
            <button type="button" className="gx-link prp-desc-more" aria-expanded={full} onClick={() => setFull((f) => !f)}>
              {full ? "Show less" : "Show all"}
            </button>
          )}
        </>
      ) : (
        <p className="gx-quiet">No description.</p>
      )}
    </Sec>
  );
}

/** Its commits on a line, newest first, as the Git panel's History: each one opens on GitHub. */
function Commits({ commits, total, repo, ago, prUrl }: { commits: PrDetail["commits"]; total: number; repo: string | undefined; ago: (ts: number) => string; prUrl: string }) {
  const [all, setAll] = useState(false);
  const newest = [...commits].reverse();
  const shown = all ? newest : newest.slice(0, 10);
  return (
    <Sec
      title="Commits"
      count={total}
      acts={
        newest.length > shown.length ? (
          <button type="button" className="gx-link" onClick={() => setAll(true)}>
            Show all
          </button>
        ) : total > commits.length ? (
          <a className="gx-link" href={`${prUrl}/commits`} target="_blank" rel="noreferrer">
            All on GitHub
          </a>
        ) : undefined
      }
    >
      <ol className="gx-log">
        {shown.map((c) => (
          <li key={c.sha} className="gx-commit">
            <a className="gx-commit-main" href={repo ? `https://github.com/${repo}/commit/${c.sha}` : prUrl} target="_blank" rel="noreferrer">
              <span className="gx-dot" aria-hidden="true" />
              <span className="gx-commit-text">
                <span className="gx-subject" title={c.headline}>
                  {c.headline || "(no message)"}
                </span>
                <span className="gx-commit-meta" title={c.at ? new Date(c.at).toLocaleString() : undefined}>
                  <code>{c.sha.slice(0, 7)}</code> · {c.who ?? c.login ?? "Someone"}
                  {c.at ? ` · ${ago(c.at)}` : ""}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ol>
    </Sec>
  );
}

/** Its files, as the Git panel lists a change: the letter, the name and its folder, its lines added and removed. */
function Files({ files, total, adds, dels, prUrl }: { files: PrDetail["files"]; total: number; adds: number; dels: number; prUrl: string }) {
  const [all, setAll] = useState(false);
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const shown = all ? sorted : sorted.slice(0, 12);
  return (
    <Sec
      title="Files"
      count={total}
      hint={
        <>
          <span className="prp-add">+{adds.toLocaleString()}</span> <span className="prp-del">−{dels.toLocaleString()}</span> across {total} file{total === 1 ? "" : "s"}
        </>
      }
      acts={
        sorted.length > shown.length ? (
          <button type="button" className="gx-link" onClick={() => setAll(true)}>
            Show all
          </button>
        ) : (
          <a className="gx-link" href={`${prUrl}/files`} target="_blank" rel="noreferrer">
            Open the diff
          </a>
        )
      }
    >
      <ul className="gx-list">
        {shown.map((f) => {
          const at = f.path.lastIndexOf("/");
          return (
            <li key={f.path} className="gx-file">
              <a className="gx-main prp-row" href={`${prUrl}/files`} target="_blank" rel="noreferrer" title={f.path}>
                <span className={`gx-letter is-${CHANGE[f.change][1]}`}>{CHANGE[f.change][0]}</span>
                <span className="gx-name">{f.path.slice(at + 1)}</span>
                {at > 0 && <span className="gx-dir">{f.path.slice(0, at)}</span>}
                <span className="gx-grow" />
                <span className="prp-file-lines">
                  {f.additions > 0 && <span className="prp-add">+{f.additions}</span>}
                  {f.deletions > 0 && <span className="prp-del">−{f.deletions}</span>}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
      {total > files.length && (
        <a className="gx-link prp-more" href={`${prUrl}/files`} target="_blank" rel="noreferrer">
          {total - files.length} more on GitHub
        </a>
      )}
    </Sec>
  );
}
