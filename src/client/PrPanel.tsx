import { useEffect, useState } from "react";
import type { SessionState } from "../session/projection.js";
import { MAIN_LANE, type Member, type SessionEvent } from "../types.js";
import type { PrStatus } from "../github-status.js";
import { Icon, type IconName } from "./icons.js";
import { ShipDialog } from "./Ship.js";
import { relTime } from "./ui.js";
import type { Send } from "./useSession.js";
import "./pr-panel.css";

/**
 * The session's pull request, a panel of its own beside the chat (Arun, 2026-11-16: "let's add these", after the other tools' side
 * panels, where PR and checks are a tab of their own): where it stands on GitHub in three steps (checks, review, merge), the
 * checks that failed with their links, the ways to hand them or the reviewers' comments to the agent, and Friday seeing it through
 * to merge. With none yet, the way to open one: the commit box, at "Open a pull request".
 */

type Checks = { failures: { name: string; workflow?: string; link?: string; outcome?: string }[]; pending: number } | { error: string };
type Got = { url: string; at: number; lane?: string; status: PrStatus | null; checks?: Checks } | null;

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
      fetch(`/api/sessions/${encodeURIComponent(sid)}/pr?invite=${encodeURIComponent(invite)}&checks=1`, { credentials: "same-origin" })
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
  const number = prUrl.match(/\/pull\/(\d+)/)?.[1];
  const repo = prUrl.match(/github\.com\/([^/]+\/[^/]+)\//)?.[1];
  const merged = st?.state === "merged" || !!state.pr?.merged;
  const closed = st?.state === "closed";
  const open = !merged && !closed;
  const seeing = state.shepherd?.prUrl === prUrl;
  const failures = got?.checks && "failures" in got.checks ? got.checks.failures : [];
  const pending = got?.checks && "pending" in got.checks ? got.checks.pending : 0;
  const checksErr = got?.checks && "error" in got.checks ? got.checks.error : "";
  const body = commit?.body.type === "folder.committed" ? commit.body : null;
  const title = body?.message.split("\n")[0] ?? `Pull request #${number ?? ""}`;
  const files = state.diffs[lane]?.files ?? [];
  const adds = files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const dels = files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  const by = commit ? commit.actor.name.replace(/^[^']+'s /, "") : "";
  const pill: [string, string] = merged ? ["Merged", "merged"] : closed ? ["Closed", "closed"] : st?.draft ? ["Draft", "draft"] : ["Open", "open"];

  // Where it stands, in a line: what is in its way, if anything, the most pressing first.
  const verdict: [string, "ok" | "bad" | "wait" | "none"] | null = merged
    ? ["Merged", "ok"]
    : closed
      ? ["Closed without merging", "none"]
      : !st
        ? null
        : st.checks === "failing"
          ? [`Blocked: ${failures.length > 1 ? `${failures.length} checks are` : "a check is"} failing`, "bad"]
          : st.review === "changes_requested"
            ? ["Blocked: changes were requested", "bad"]
            : st.mergeable === false
              ? ["Blocked: it conflicts with its base", "bad"]
              : st.checks === "pending"
                ? ["Checks are still running", "wait"]
                : st.review === "review_required"
                  ? ["Waiting on a review", "wait"]
                  : ["Ready to merge", "ok"];

  const steps: { key: string; name: string; word: string; sub: string; tone: "ok" | "bad" | "wait" | "none" }[] = st
    ? [
        st.checks === "passing"
          ? { key: "checks", name: "Checks", word: "All passing", sub: "Every check GitHub ran on it passed.", tone: "ok" }
          : st.checks === "failing"
            ? { key: "checks", name: "Checks", word: `${failures.length || "Some"} failing`, sub: pending ? `${pending} still running.` : "The rest passed.", tone: "bad" }
            : st.checks === "pending"
              ? { key: "checks", name: "Checks", word: "Running", sub: pending ? `${pending} still to finish.` : "GitHub is running them.", tone: "wait" }
              : { key: "checks", name: "Checks", word: "None", sub: "This repository runs no checks on pull requests.", tone: "none" },
        st.review === "approved"
          ? { key: "review", name: "Review", word: "Approved", sub: "A reviewer approved it.", tone: "ok" }
          : st.review === "changes_requested"
            ? { key: "review", name: "Review", word: "Changes requested", sub: "A reviewer asked for changes before it merges.", tone: "bad" }
            : st.review === "review_required"
              ? { key: "review", name: "Review", word: "Waiting on a reviewer", sub: "The repository needs an approval to merge.", tone: "wait" }
              : { key: "review", name: "Review", word: "Not needed", sub: "Nobody has to approve it to merge.", tone: "none" },
        merged
          ? { key: "merge", name: "Merge", word: "Merged", sub: `Into ${body?.base ?? "its base"}.`, tone: "ok" }
          : closed
            ? { key: "merge", name: "Merge", word: "Closed", sub: "It was closed without merging.", tone: "none" }
            : st.mergeable === false
              ? { key: "merge", name: "Merge", word: "Conflicts", sub: `It conflicts with ${body?.base ?? "its base"}: the branch needs updating.`, tone: "bad" }
              : st.mergeable === null
                ? { key: "merge", name: "Merge", word: "Checking", sub: "GitHub is still working out whether it can merge.", tone: "wait" }
                : { key: "merge", name: "Merge", word: "No conflicts", sub: `It merges cleanly into ${body?.base ?? "its base"}.`, tone: "ok" },
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
  const ago = (ts: number) => ((t) => (t === "now" ? "just now" : /\d$/.test(t) ? t : `${t} ago`))(relTime(ts));

  return (
    <div className="prp">
      {/* Which pull request: its state, number and repository, where it goes, how big, who opened it and when. */}
      <header className="prp-head">
        <div className="prp-head-row">
          <span className={`prp-pill ${pill[1]}`}>
            <Icon name="gitPullRequest" size={12} />
            {pill[0]}
          </span>
          <span className="prp-num">
            {repo ? <span className="prp-repo">{repo}</span> : null}
            <b>#{number ?? "?"}</b>
          </span>
          <span className="prp-grow" />
          <button type="button" className="prp-icon" aria-label="Copy its link" title="Copy its link" onClick={() => void navigator.clipboard?.writeText(prUrl).then(() => setNote("Link copied."))}>
            <Icon name="copy" size={13} />
          </button>
          <a className="prp-btn small" href={prUrl} target="_blank" rel="noreferrer">
            GitHub <Icon name="arrowUpRight" size={12} />
          </a>
        </div>
        <h3 className="prp-title-text">{title}</h3>
        <div className="prp-meta">
          {body?.branch && (
            <span className="prp-branches">
              <code>{body.branch}</code>
              <Icon name="arrowRight" size={11} />
              <code>{body.base ?? "main"}</code>
            </span>
          )}
          {(adds > 0 || dels > 0 || (body?.files ?? 0) > 0) && (
            <span className="prp-size">
              {body?.files ?? files.length} file{(body?.files ?? files.length) === 1 ? "" : "s"}
              {adds > 0 && <b className="add"> +{adds}</b>}
              {dels > 0 && <b className="del"> −{dels}</b>}
            </span>
          )}
          {commit && (
            <span className="prp-by">
              {by} · {ago(commit.ts)}
            </span>
          )}
        </div>
      </header>

      {got === undefined && <p className="prp-quiet">Asking GitHub where it stands…</p>}
      {got !== undefined && !st && <p className="prp-quiet">GitHub didn't answer. Signing in to gh on this computer (gh auth login) lets Friday read the pull request.</p>}

      {/* Where it stands: the verdict, then checks, review and merge, the failing checks under Checks. */}
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
                  {x.tone === "ok" ? <Icon name="check" size={11} /> : x.tone === "bad" ? <Icon name="x" size={11} /> : x.tone === "wait" ? <span className="prp-spin" /> : null}
                </span>
                <div className="prp-step-text">
                  <div className="prp-step-line">
                    <span className="prp-step-name">{x.name}</span>
                    <span className="prp-step-word">{x.word}</span>
                  </div>
                  <span className="prp-step-sub">{x.sub}</span>
                  {x.key === "checks" && open && failures.length > 0 && (
                    <ul className="prp-fails">
                      {failures.map((f) => (
                        <li key={`${f.workflow ?? ""}/${f.name}`}>
                          <span className="prp-fail-dot" aria-hidden="true" />
                          <span className="prp-fail-name">
                            {f.name}
                            {f.workflow && f.workflow !== f.name ? <span className="prp-fail-wf"> · {f.workflow}</span> : null}
                            {f.outcome ? <span className="prp-fail-wf"> · {f.outcome}</span> : null}
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
                  {x.key === "checks" && open && failures.length > 0 && may && !seeing && (
                    <button type="button" className="prp-btn small" disabled={!!busy} onClick={() => void act("checks", { type: "pr.checks", lane }, "The failing checks are with the agent.")}>
                      {busy === "checks" ? <span className="spinner" /> : null} Hand the logs to the agent
                    </button>
                  )}
                  {x.key === "review" && open && st.review !== "none" && may && !seeing && (
                    <button type="button" className="prp-btn small" disabled={!!busy} onClick={() => void act("feedback", { type: "pr.feedback", lane }, "Review comments sent to the agent.")}>
                      {busy === "feedback" ? <span className="spinner" /> : null} Pull in the review comments
                    </button>
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
            <button type="button" className={`prp-btn${seeing ? "" : " primary"}`} disabled={!!busy} onClick={() => void act("see", { type: "pr.shepherd", on: !seeing, lane }, seeing ? "Friday stopped watching it." : "Friday is seeing it through.")}>
              {busy === "see" ? <span className="spinner" /> : null}
              {seeing ? "Stop" : "Start"}
            </button>
          )}
        </section>
      )}

      {note && (
        <p className="prp-note" role="status">
          {note}
        </p>
      )}

      {activity.length > 0 && (
        <section className="prp-sec" aria-label="Since it opened">
          <h4>Since it opened</h4>
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
        </section>
      )}

      {state.prs.length > 1 && (
        <section className="prp-sec" aria-label="Earlier pull requests">
          <h4>Earlier in this session</h4>
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
        </section>
      )}
    </div>
  );
}
