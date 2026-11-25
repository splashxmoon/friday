import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./git-panel.css";
import type { RepoStatus, StatusEntry, LogEntry } from "../runner/git.js";
import type { SessionState } from "../session/projection.js";
import { MAIN_LANE, type DiffFile, type Member } from "../types.js";
import { BranchButton } from "./Branches.js";
import { DiffView } from "./DiffView.js";
import { hunksOf } from "./git-hunks.js";
import { Icon } from "./icons.js";
import { patchLines } from "./patchLines.js";
import { ShipDialog } from "./ShipLazy.js";
import { Picker, Skeleton, SkeletonCode, relTime, useConfirm } from "./ui.js";
import { CircleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/dass/EmptyState";
import type { Send } from "./useSession.js";

/**
 * The folder's git, worked by hand (Arun, 2026-10-25, after the other tools' git panels): what is staged, what isn't and what
 * is new, each file openable to its hunks, any file or hunk staged, unstaged or thrown away; the branch, how it stands to its
 * upstream and to main, pull and commit; and the branch's history, each commit openable to its changes. Reads come straight
 * from the folder (the repo route); moves go through the session (folder.git), so a change by hand is seen like an agent's.
 */

type Key = `staged:${string}` | `unstaged:${string}` | `untracked:${string}` | `commit:${string}`;
interface Compare {
  base: string;
  ahead: number;
  behind: number;
  files: number;
  additions: number;
  deletions: number;
}

const LETTER: Record<StatusEntry["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

export function GitPanel({ state, sid, invite, send, me, lane }: { state: SessionState; sid: string; invite: string; send: Send; me: Member; lane?: string }) {
  const laneId = lane ?? MAIN_LANE;
  const engine = state.engines[laneId] ?? state.engines[MAIN_LANE];
  const live = !!engine?.online;
  const mayWork = live && engine.mode !== "plan";
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [compare, setCompare] = useState<Compare | null>(null);
  const [error, setError] = useState("");
  /** The last look at the folder got no answer: before the first one did, said with Try again where the files would be. */
  const [unread, setUnread] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Key | null>(null);
  const [patches, setPatches] = useState<Record<string, DiffFile[] | "loading" | "none" | "failed">>({});
  const openRef = useRef(open);
  openRef.current = open;
  const patchesRef = useRef(patches);
  patchesRef.current = patches;
  const [shipping, setShipping] = useState(false);
  // The folders the agent also works in (multi-repo): the latest change set names them; the panel reads and acts in the one picked.
  const others = [...new Set((state.diffs[laneId]?.files ?? []).map((f) => f.repo).filter((r): r is string => !!r))];
  const [dir, setDir] = useState("");
  useEffect(() => {
    if (dir && !others.includes(dir)) setDir("");
  }, [others.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const [ask, confirmUI] = useConfirm();
  const alive = useRef(true);
  // Set again on mounting: React's development double mount ran the clean-up once and left every read dropped.
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  /** Bumped by each fresh look, so the row that is open reads its changes again (below). */
  const [looked, setLooked] = useState(0);

  const url = (op: string, extra = "") => `/api/sessions/${encodeURIComponent(sid)}/repo?op=${op}&lane=${encodeURIComponent(laneId)}&invite=${encodeURIComponent(invite)}${dir ? `&dir=${encodeURIComponent(dir)}` : ""}${extra}`;
  const read = useCallback(
    async <T,>(op: string, extra = "", quiet = false): Promise<T | null> => {
      const r = await fetch(url(op, extra), { credentials: "same-origin" }).catch(() => null);
      if (!r?.ok) return null;
      const j = (await r.json().catch(() => null)) as { output?: string; error?: string } | null;
      if (!j?.output) return null;
      try {
        const out = JSON.parse(j.output) as T & { error?: string };
        if (out && typeof out === "object" && "error" in out && out.error) {
          if (!quiet) setError(String(out.error));
          return null;
        }
        return out;
      } catch {
        return null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sid, invite, laneId, dir],
  );

  const refresh = useCallback(async () => {
    if (!live) return;
    setError("");
    const [s, l] = await Promise.all([read<RepoStatus>("status"), read<{ commits: LogEntry[] }>("log", "&limit=40")]);
    if (!alive.current) return;
    setUnread(!s);
    if (s) setStatus(s);
    if (l) setLog(l.commits);
    // How the branch stands to main (the runner finds it locally, on origin, or as master), when it isn't that branch. A
    // nicety: trouble reading it is never shown over the panel.
    if (s && !/^(main|master)$/.test(s.branch)) {
      const c = await read<Compare & { missing?: true }>("compare", "&ref=main", true);
      if (alive.current) setCompare(c && !c.missing ? c : null);
    } else setCompare(null);
    // What is open may have changed under it: the rest are forgotten, and the open one keeps what it showed until it has
    // been read again. Clearing it too left an open row on "Reading…" for good, nothing reading it again (2026-10-28 QA:
    // "Reading…" stuck after the 15-second look, a stage or a refresh; Arun: "TEST EVERYTHING… EVERY INTERACTION").
    setPatches((p) => Object.fromEntries(Object.entries(p).filter(([k, v]) => k === openRef.current && v !== "loading")));
    setLooked((n) => n + 1);
  }, [live, read]);

  // On opening, after every run ends, and now and then while the panel is up: a terminal or an agent may have moved things.
  const runsEnded = Object.values(state.laneRuns).filter((r) => r.status !== "running").length + (state.run.status !== "running" ? 1 : 0);
  useEffect(() => void refresh(), [refresh, runsEnded]);
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  /** One move through the session, then a fresh look. */
  const act = async (label: string, cmd: Record<string, unknown>) => {
    setBusy(label);
    setError("");
    const r = await send({ type: "folder.git", lane: laneId, ...(dir ? { dir } : {}), ...cmd });
    if (!r.ok) setError(r.error ?? "That didn't work.");
    await refresh();
    if (alive.current) setBusy(null);
  };
  const discard = (paths: string[], untracked: boolean) =>
    ask({
      title: untracked ? `Delete ${paths.length === 1 ? paths[0] : `${paths.length} untracked files`}?` : `Throw away the changes to ${paths.length === 1 ? paths[0] : `${paths.length} files`}?`,
      body: untracked ? "They aren't in git, so nothing keeps a copy." : "Staged or not, the files go back to the last commit. There is no undo for this.",
      action: untracked ? "Delete" : "Throw away",
      onConfirm: () => void act("discard", { action: "discard", paths, untracked }),
    });

  /** The file's hunks, or a commit's changes, fetched when its row opens, and again after each fresh look while it is open. */
  const toggle = (key: Key) => setOpen(open === key ? null : key);
  /** A change that couldn't be read, read again: forgotten, and looked at afresh. */
  const readAgain = (key: Key) => {
    setPatches((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== key)));
    setLooked((n) => n + 1);
  };
  const failedRead = (key: Key, what: string) => (
    <p className="gx-failed" role="alert">
      Couldn't read {what}.{" "}
      <button type="button" className="link-btn" onClick={() => readAgain(key)}>
        Try again
      </button>
    </p>
  );
  const readFor = useRef({ open, looked });
  useEffect(() => {
    if (!open) return;
    // Opened again with nothing newer to show: what it read is still right.
    const was = readFor.current;
    readFor.current = { open, looked };
    const have = patchesRef.current[open];
    if (have && have !== "loading" && was.looked === looked && was.open !== open) return;
    if (!have) setPatches((p) => ({ ...p, [open]: "loading" }));
    let stale = false;
    const [kind, ...rest] = open.split(":");
    const ref = rest.join(":");
    void (kind === "commit"
      ? read<{ files: DiffFile[] }>("show", `&ref=${encodeURIComponent(ref)}`)
      : read<{ files: DiffFile[] }>("gitdiff", `&staged=${kind === "staged" ? 1 : 0}&path=${encodeURIComponent(ref)}`)
    ).then((got) => {
      // Nothing came back is not "nothing changed": said as a read that failed, with Try again (below).
      if (!stale && alive.current) setPatches((p) => ({ ...p, [open]: got === null ? (Array.isArray(p[open]) ? p[open] : "failed") : got.files?.length ? got.files : "none" }));
    });
    return () => void (stale = true);
  }, [open, looked, read]);

  const changed = status ? status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length : 0;
  const branch = status?.branch ?? engine?.branch ?? "";
  const dialog = shipping ? <ShipDialog state={state} sid={sid} invite={invite} send={send} lane={laneId} {...(dir ? { dir } : {})} onClose={() => (setShipping(false), void refresh())} /> : null;

  if (!live) {
    return (
      <div className="gitp gitp-empty">
        <p className="muted">No computer is working in this session right now, so its git can't be read.</p>
      </div>
    );
  }

  const fileRow = (kind: "staged" | "unstaged" | "untracked", path: string, entry?: StatusEntry) => {
    const key: Key = `${kind}:${path}`;
    const on = open === key;
    const got = patches[key];
    const name = path.split("/").pop() ?? path;
    const folder = path.slice(0, path.length - name.length).replace(/\/$/, "");
    const letter = entry ? LETTER[entry.status] : "N";
    const tone = entry?.status ?? "added";
    return (
      <li key={key} className={`gitp-file gx-file${on ? " on" : ""}`}>
        <div className="gx-row">
          <button type="button" className="gx-main" aria-expanded={on} onClick={() => toggle(key)} title={entry?.from ? `${entry.from} → ${path}` : path}>
            <Icon name="chevronRight" size={12} className="gx-caret" />
            <span className={`gx-letter is-${tone}`} title={entry ? entry.status : "new, not in git yet"}>{letter}</span>
            <span className="gx-name">{name}</span>
            {folder && <span className="gx-dir">{folder}</span>}
            {entry?.from && <span className="gx-dir">from {entry.from.split("/").pop()}</span>}
          </button>
          {mayWork && (
            <span className="gx-acts">
              {kind !== "staged" && (
                <button type="button" className="gx-icon" title={kind === "untracked" ? "Delete this file" : "Throw the changes away"} aria-label={kind === "untracked" ? `Delete ${path}` : `Throw away the changes to ${path}`} disabled={!!busy} onClick={() => discard([path], kind === "untracked")}>
                  <Icon name={kind === "untracked" ? "trash" : "refresh"} size={13} />
                </button>
              )}
              {kind === "staged" ? (
                <button type="button" className="gx-icon" title="Unstage: leave it out of the commit" aria-label={`Unstage ${path}`} disabled={!!busy} onClick={() => void act("unstage", { action: "unstage", paths: [path] })}>
                  <Icon name="minus" size={14} />
                </button>
              ) : (
                <button type="button" className="gx-icon" title="Stage: put it in the commit" aria-label={`Stage ${path}`} disabled={!!busy} onClick={() => void act("stage", { action: "stage", paths: [path] })}>
                  <Icon name="plus" size={14} />
                </button>
              )}
            </span>
          )}
        </div>
        {on && (
          <div className="gitp-hunks">
            {got === "loading" || !got ? (
              <SkeletonCode lines={6} label="Reading the change" />
            ) : got === "failed" ? (
              failedRead(key, "this change")
            ) : got === "none" ? (
              <p className="muted small">{kind === "untracked" ? "An empty file." : entry?.status === "deleted" ? "The whole file was deleted." : "Nothing to show."}</p>
            ) : (
              got.flatMap((f) =>
                hunksOf(f).map((h, i) => (
                  <div key={`${f.path}:${i}`} className="gitp-hunk">
                    <DiffView path={f.path} lines={patchLines(h.patch)} defaultOpen maxHeight={300} />
                    {mayWork && (
                      <div className="gitp-hunk-acts">
                        <span className="muted small">
                          Hunk {i + 1} of {hunksOf(f).length} · <b className="diff-add">+{h.additions}</b> <b className="diff-del">−{h.deletions}</b>
                        </span>
                        {kind === "staged" ? (
                          <button type="button" className="btn ghost small" disabled={!!busy} onClick={() => void act("hunk", { action: "hunk", patch: h.patch, cached: true, reverse: true })}>
                            Unstage hunk
                          </button>
                        ) : kind === "unstaged" ? (
                          <>
                            <button type="button" className="btn ghost small" disabled={!!busy} onClick={() => void act("hunk", { action: "hunk", patch: h.patch, cached: true })}>
                              Stage hunk
                            </button>
                            <button
                              type="button"
                              className="btn ghost small gitp-danger"
                              disabled={!!busy}
                              onClick={() => ask({ title: `Throw away hunk ${i + 1} of ${f.path}?`, body: "Those lines go back to how the last commit has them.", action: "Throw away", onConfirm: () => void act("hunk", { action: "hunk", patch: h.patch, reverse: true }) })}
                            >
                              Throw away
                            </button>
                          </>
                        ) : null}
                      </div>
                    )}
                  </div>
                )),
              )
            )}
          </div>
        )}
      </li>
    );
  };

  const section = (title: string, hint: string, count: number, actions: ReactNode, children: ReactNode, tone = "") =>
    count > 0 ? (
      <section className={`gx-sec${tone ? ` ${tone}` : ""}`}>
        <header className="gx-sec-head">
          <h3>
            {title} <span className="gx-count">{count}</span>
          </h3>
          {mayWork && <span className="gx-sec-acts">{actions}</span>}
        </header>
        <p className="gx-hint">{hint}</p>
        <ul className="gx-list">{children}</ul>
      </section>
    ) : null;

  const unpushed = log?.filter((c) => c.pushed === false).length ?? 0;
  const staged = status?.staged.length ?? 0;

  return (
    <div className="gitp gx">
      {confirmUI}
      {dialog}
      {/* Where the branch stands, in words: what is waiting to go up or come down, and how it compares with main. */}
      <header className="gx-head">
        <div className="gx-branch">
          {others.length > 0 && (
            <label className="gitp-dir" title="Which folder: the agent's own, or one it also works in">
              <Picker value={dir} label="Which folder" onChange={setDir} options={[{ value: "", label: (engine?.cwd ?? "This folder").split(/[\\/]/).filter(Boolean).pop() ?? "This folder" }, ...others.map((d) => ({ value: d, label: d.split(/[\\/]/).filter(Boolean).pop() ?? d, sub: d }))]} />
            </label>
          )}
          <BranchButton sid={sid} invite={invite} send={send} lane={laneId} branch={branch} idle={state.run.status !== "running"} />
          <span className="gx-grow" />
          <button type="button" className="gx-icon" title="Look again" aria-label="Refresh" disabled={!!busy} onClick={() => void refresh()}>
            <Icon name="refresh" size={13} />
          </button>
        </div>
        {status && (
          <div className="gx-sync">
            {status.upstream ? (
              status.ahead || status.behind ? (
                <>
                  {status.ahead > 0 && (
                    <span className="gx-chip up" title={`On this computer, not on ${status.upstream} yet`}>
                      <Icon name="arrowUp" size={11} /> {status.ahead} to push
                    </span>
                  )}
                  {status.behind > 0 && (
                    <span className="gx-chip down" title={`On ${status.upstream}, not here yet`}>
                      <Icon name="arrowDown" size={11} /> {status.behind} to pull
                    </span>
                  )}
                </>
              ) : (
                <span className="gx-chip even">
                  <Icon name="check" size={11} /> Up to date with {status.upstream}
                </span>
              )
            ) : (
              <span className="gx-chip">Not pushed anywhere yet: the first push publishes it</span>
            )}
            {mayWork && status.upstream && status.behind > 0 && (
              <button type="button" className="gx-btn" disabled={!!busy} title="Bring in the upstream's new commits (fast-forward only)" onClick={() => void act("pull", { action: "pull" })}>
                {busy === "pull" ? <span className="spinner" /> : <Icon name="download" size={12} />} {busy === "pull" ? "Pulling" : `Pull ${status.behind}`}
              </button>
            )}
          </div>
        )}
        {compare && (compare.ahead > 0 || compare.behind > 0) && (
          <p className="gx-vs">
            Against <code>{compare.base}</code>: {compare.ahead} commit{compare.ahead === 1 ? "" : "s"} ahead{compare.behind > 0 ? `, ${compare.behind} behind` : ""} · {compare.files} file{compare.files === 1 ? "" : "s"} <b className="diff-add">+{compare.additions}</b> <b className="diff-del">−{compare.deletions}</b>
          </p>
        )}
      </header>
      {error && !(unread && !status) && <p className="form-error gitp-error">{error}</p>}
      <div className="gx-body">
        {!status ? (
          unread ? (
            <EmptyState small className="gx-unread" tone="bad" icon={<CircleAlertIcon />} title="Couldn't read the folder's git" action={<Button variant="outline" size="sm" onClick={() => void refresh()}>Try again</Button>}>
              <span role="alert">{error || "Friday didn't answer. The computer may be busy or offline."}</span>
            </EmptyState>
          ) : (
            // The changes in their shape while git is read: a heading and a few file rows.
            <div className="gx-skel" role="status" aria-label="Reading the folder's git">
              <Skeleton w={92} h={12} />
              {[52, 38, 60].map((w, i) => (
                <div key={i} className="gx-skel-file">
                  <Skeleton w={14} h={14} r={4} />
                  <Skeleton w={`${w}%`} h={11} />
                </div>
              ))}
            </div>
          )
        ) : changed === 0 ? (
          <div className="gx-clean">
            <span className="gx-clean-mark" aria-hidden="true">
              <Icon name="check" size={14} />
            </span>
            <div>
              <b>Nothing to commit</b>
              <span>The folder matches the last commit.</span>
            </div>
          </div>
        ) : (
          <>
            {status.conflicted.length > 0 &&
              section(
                "Conflicts",
                "Both sides changed these lines. Settle them in the files, then stage them.",
                status.conflicted.length,
                null,
                status.conflicted.map((p) => (
                  <li key={p} className="gitp-file gx-file">
                    <div className="gx-row">
                      <span className="gx-main">
                        <span className="gx-letter is-conflict">!</span>
                        <span className="gx-name">{p.split("/").pop()}</span>
                        <span className="gx-dir">{p.slice(0, p.lastIndexOf("/"))}</span>
                      </span>
                    </div>
                  </li>
                )),
                "bad",
              )}
            {section(
              "Ready to commit",
              "Staged: these go in the next commit.",
              status.staged.length,
              <button type="button" className="gx-link" disabled={!!busy} onClick={() => void act("unstage", { action: "unstage", paths: status.staged.map((e) => e.path) })}>
                Unstage all
              </button>,
              status.staged.map((e) => fileRow("staged", e.path, e)),
              "ok",
            )}
            {section(
              "Changed",
              "Not staged yet: press + to put one in the commit.",
              status.unstaged.length,
              <>
                <button type="button" className="gx-link" disabled={!!busy} onClick={() => void act("stage", { action: "stage", paths: status.unstaged.map((e) => e.path) })}>
                  Stage all
                </button>
                <button type="button" className="gx-link danger" disabled={!!busy} onClick={() => discard(status.unstaged.map((e) => e.path), false)}>
                  Throw all away
                </button>
              </>,
              status.unstaged.map((e) => fileRow("unstaged", e.path, e)),
            )}
            {section(
              "New files",
              "Not in git yet.",
              status.untracked.length,
              <button type="button" className="gx-link" disabled={!!busy} onClick={() => void act("stage", { action: "stage", paths: status.untracked })}>
                Stage all
              </button>,
              status.untracked.map((p) => fileRow("untracked", p)),
            )}
          </>
        )}
        {/* The branch's commits, newest first, on a line: hollow ones are only on this computer. */}
        <section className="gx-sec gx-history">
          <header className="gx-sec-head">
            <h3>
              History {log && log.length > 0 && <span className="gx-count">{log.length}</span>}
            </h3>
            {unpushed > 0 && <span className="gx-unpushed">{unpushed} not pushed</span>}
          </header>
          {!log ? (
            // The commits' rows in grey: a dot, a subject, who and when.
            <div className="gx-skel-log" role="status" aria-label="Reading the history">
              {[64, 48, 72, 40, 56].map((w, i) => (
                <div key={i} className="gx-skel-commit">
                  <Skeleton w={9} h={9} r={5} />
                  <div className="gx-skel-text">
                    <Skeleton w={`${w}%`} h={11} />
                    <Skeleton w={`${w / 2 + 12}%`} h={9} />
                  </div>
                </div>
              ))}
            </div>
          ) : log.length === 0 ? (
            <p className="gx-quiet">No commits yet.</p>
          ) : (
            <ol className="gx-log">
              {log.map((c) => {
                const key: Key = `commit:${c.sha}`;
                const on = open === key;
                const got = patches[key];
                return (
                  <li key={c.sha} className={`gx-commit${c.pushed === false ? " local" : ""}${on ? " on" : ""}`}>
                    <button type="button" className="gx-commit-main" aria-expanded={on} onClick={() => toggle(key)}>
                      <span className="gx-dot" aria-hidden="true" />
                      <span className="gx-commit-text">
                        <span className="gx-subject" title={c.subject}>
                          {c.subject}
                        </span>
                        <span className="gx-commit-meta" title={new Date(c.at).toLocaleString()}>
                          {c.author.split(/\s+/)[0]} · {relTime(c.at)} · <code>{c.sha.slice(0, 7)}</code>
                          {c.pushed === false && <span className="gx-local">Not pushed</span>}
                        </span>
                      </span>
                      <Icon name="chevronRight" size={12} className="gx-caret" />
                    </button>
                    {on && (
                      <div className="gitp-hunks gx-hunks">
                        {got === "loading" || !got ? (
                          <SkeletonCode lines={6} label="Reading the commit" />
                        ) : got === "failed" ? (
                          failedRead(key, "this commit")
                        ) : got === "none" ? (
                          <p className="muted small">No file changes in this commit.</p>
                        ) : (
                          got.map((f) => <DiffView key={f.path} path={f.path} status={f.status} lines={patchLines(f.patch)} defaultOpen={got.length <= 3} maxHeight={320} />)
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
        {me.role === "viewer" && <p className="gx-quiet">You're watching: only the driver or an owner can stage, commit or pull.</p>}
      </div>
      {/* Commit, at the foot where it is always in reach, saying what it will take. */}
      {mayWork && status && changed > 0 && (
        <footer className="gx-foot">
          <span className="gx-foot-text">{staged ? `${staged} staged, ${changed - staged} not` : `${changed} change${changed === 1 ? "" : "s"}, none staged yet`}</span>
          <button type="button" className="gx-btn primary" disabled={!!busy} onClick={() => setShipping(true)}>
            <Icon name="commit" size={13} /> Commit
          </button>
        </footer>
      )}
    </div>
  );
}

/** Whether the Git panel has anything new for its tab's dot: staged or unstaged changes. Exported for the Workbench's tab row. */
export function gitDirty(status: Pick<RepoStatus, "staged" | "unstaged" | "untracked"> | null): boolean {
  return !!status && status.staged.length + status.unstaged.length + status.untracked.length > 0;
}

