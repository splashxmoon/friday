import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { RepoStatus, StatusEntry, LogEntry } from "../runner/git.js";
import type { SessionState } from "../session/projection.js";
import { MAIN_LANE, type DiffFile, type Member } from "../types.js";
import { BranchButton } from "./Branches.js";
import { DiffView } from "./DiffView.js";
import { hunksOf } from "./git-hunks.js";
import { Icon } from "./icons.js";
import { patchLines } from "./patchLines.js";
import { ShipDialog } from "./Ship.js";
import { relTime, useConfirm } from "./ui.js";
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
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Key | null>(null);
  const [patches, setPatches] = useState<Record<string, DiffFile[] | "loading" | "none">>({});
  const [shipping, setShipping] = useState(false);
  // The folders the agent also works in (multi-repo): the latest change set names them; the panel reads and acts in the one picked.
  const others = [...new Set((state.diffs[laneId]?.files ?? []).map((f) => f.repo).filter((r): r is string => !!r))];
  const [dir, setDir] = useState("");
  useEffect(() => {
    if (dir && !others.includes(dir)) setDir("");
  }, [others.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const [ask, confirmUI] = useConfirm();
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

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
    if (s) setStatus(s);
    if (l) setLog(l.commits);
    // How the branch stands to main (the runner finds it locally, on origin, or as master), when it isn't that branch. A
    // nicety: trouble reading it is never shown over the panel.
    if (s && !/^(main|master)$/.test(s.branch)) {
      const c = await read<Compare & { missing?: true }>("compare", "&ref=main", true);
      if (alive.current) setCompare(c && !c.missing ? c : null);
    } else setCompare(null);
    // What is open may have changed under it.
    setPatches({});
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

  /** The file's hunks, or a commit's changes, fetched when its row opens. */
  const toggle = async (key: Key) => {
    if (open === key) return setOpen(null);
    setOpen(key);
    if (patches[key]) return;
    setPatches((p) => ({ ...p, [key]: "loading" }));
    const [kind, ...rest] = key.split(":");
    const ref = rest.join(":");
    const got =
      kind === "commit"
        ? await read<{ files: DiffFile[] }>("show", `&ref=${encodeURIComponent(ref)}`)
        : await read<{ files: DiffFile[] }>("gitdiff", `&staged=${kind === "staged" ? 1 : 0}&path=${encodeURIComponent(ref)}`);
    if (alive.current) setPatches((p) => ({ ...p, [key]: got?.files?.length ? got.files : "none" }));
  };

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
    return (
      <li key={key} className={`gitp-file${on ? " on" : ""}`}>
        <div className="gitp-file-row">
          <button type="button" className="gitp-file-main" aria-expanded={on} onClick={() => void toggle(key)}>
            <span className={`gitp-letter is-${entry?.status ?? "untracked"}`}>{entry ? LETTER[entry.status] : "?"}</span>
            <span className="gitp-path" title={entry?.from ? `${entry.from} → ${path}` : path}>
              {entry?.from ? <><span className="muted">{entry.from.split("/").pop()} → </span>{path}</> : path}
            </span>
            <Icon name={on ? "chevronUp" : "chevronDown"} size={12} />
          </button>
          {mayWork && (
            <span className="gitp-file-acts">
              {kind === "staged" ? (
                <button type="button" className="btn ghost small" disabled={!!busy} onClick={() => void act("unstage", { action: "unstage", paths: [path] })}>
                  Unstage
                </button>
              ) : (
                <>
                  <button type="button" className="btn ghost small" disabled={!!busy} onClick={() => void act("stage", { action: "stage", paths: [path] })}>
                    Stage
                  </button>
                  <button type="button" className="icon-btn tiny gitp-discard" title={kind === "untracked" ? "Delete this file" : "Throw the changes away"} aria-label={kind === "untracked" ? `Delete ${path}` : `Throw away the changes to ${path}`} disabled={!!busy} onClick={() => discard([path], kind === "untracked")}>
                    <Icon name="x" size={12} />
                  </button>
                </>
              )}
            </span>
          )}
        </div>
        {on && (
          <div className="gitp-hunks">
            {got === "loading" || !got ? (
              <p className="muted small">Reading…</p>
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

  const section = (title: string, count: number, actions: ReactNode, children: ReactNode) =>
    count > 0 ? (
      <section className="gitp-section">
        <header className="gitp-section-head">
          <h3>
            {title} <span className="gitp-count">{count}</span>
          </h3>
          {mayWork && <span className="gitp-section-acts">{actions}</span>}
        </header>
        <ul className="gitp-list">{children}</ul>
      </section>
    ) : null;

  return (
    <div className="gitp">
      {confirmUI}
      {dialog}
      <header className="gitp-head">
        {others.length > 0 && (
          <label className="gitp-dir" title="Which folder: the agent's own, or one it also works in">
            <select value={dir} aria-label="Which folder" onChange={(e) => setDir(e.target.value)}>
              <option value="">{(engine?.cwd ?? "This folder").split(/[\\/]/).filter(Boolean).pop()}</option>
              {others.map((d) => (
                <option key={d} value={d}>
                  {d.split(/[\\/]/).filter(Boolean).pop()}
                </option>
              ))}
            </select>
          </label>
        )}
        <BranchButton sid={sid} invite={invite} send={send} lane={laneId} branch={branch} idle={state.run.status !== "running"} />
        {status?.upstream ? (
          <span className="gitp-sync" title={`Against ${status.upstream}`}>
            {status.ahead > 0 && <span className="gitp-pill up">↑{status.ahead}</span>}
            {status.behind > 0 && <span className="gitp-pill down">↓{status.behind}</span>}
            {!status.ahead && !status.behind && <span className="gitp-pill even">in step</span>}
          </span>
        ) : status ? (
          <span className="gitp-pill even" title="No upstream branch yet: a push sets one">not pushed yet</span>
        ) : null}
        {compare && (compare.ahead > 0 || compare.behind > 0) && (
          <span className="gitp-compare" title={`${compare.ahead} commit${compare.ahead === 1 ? "" : "s"} ahead of ${compare.base}, ${compare.behind} behind`}>
            vs {compare.base}: {compare.files} file{compare.files === 1 ? "" : "s"} <b className="diff-add">+{compare.additions}</b> <b className="diff-del">−{compare.deletions}</b>
            {compare.behind > 0 && <span className="muted"> · {compare.behind} behind</span>}
          </span>
        )}
        <span className="gitp-head-acts">
          <button type="button" className="icon-btn tiny" title="Look again" aria-label="Refresh" disabled={!!busy} onClick={() => void refresh()}>
            <Icon name="refresh" size={13} />
          </button>
          {mayWork && status?.upstream && status.behind > 0 && (
            <button type="button" className="btn ghost small" disabled={!!busy} title="Bring in the upstream's new commits (fast-forward only)" onClick={() => void act("pull", { action: "pull" })}>
              {busy === "pull" ? "Pulling…" : `Pull ${status.behind}`}
            </button>
          )}
          {mayWork && (
            <button type="button" className="btn primary small" disabled={!!busy || !changed} onClick={() => setShipping(true)}>
              <Icon name="commit" size={13} /> Commit
            </button>
          )}
        </span>
      </header>
      {error && <p className="form-error gitp-error">{error}</p>}
      {!status ? (
        <p className="muted small gitp-note">Reading the folder's git…</p>
      ) : changed === 0 ? (
        <p className="muted small gitp-note">Nothing to commit. The working files match the last commit.</p>
      ) : (
        <>
          {status.conflicted.length > 0 && (
            <section className="gitp-section">
              <header className="gitp-section-head">
                <h3 className="gitp-conflict">
                  Conflicts <span className="gitp-count">{status.conflicted.length}</span>
                </h3>
              </header>
              <ul className="gitp-list">
                {status.conflicted.map((p) => (
                  <li key={p} className="gitp-file">
                    <div className="gitp-file-row">
                      <span className="gitp-file-main">
                        <span className="gitp-letter is-conflict">!</span>
                        <span className="gitp-path">{p}</span>
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {section(
            "Staged",
            status.staged.length,
            <button type="button" className="btn ghost small" disabled={!!busy} onClick={() => void act("unstage", { action: "unstage", paths: status.staged.map((e) => e.path) })}>
              Unstage all
            </button>,
            status.staged.map((e) => fileRow("staged", e.path, e)),
          )}
          {section(
            "Changes",
            status.unstaged.length,
            <>
              <button type="button" className="btn ghost small" disabled={!!busy} onClick={() => void act("stage", { action: "stage", paths: status.unstaged.map((e) => e.path) })}>
                Stage all
              </button>
              <button type="button" className="btn ghost small gitp-danger" disabled={!!busy} onClick={() => discard(status.unstaged.map((e) => e.path), false)}>
                Throw all away
              </button>
            </>,
            status.unstaged.map((e) => fileRow("unstaged", e.path, e)),
          )}
          {section(
            "Untracked",
            status.untracked.length,
            <button type="button" className="btn ghost small" disabled={!!busy} onClick={() => void act("stage", { action: "stage", paths: status.untracked })}>
              Stage all
            </button>,
            status.untracked.map((p) => fileRow("untracked", p)),
          )}
        </>
      )}
      <section className="gitp-section gitp-history">
        <header className="gitp-section-head">
          <h3>
            History {log && <span className="gitp-count">{log.length}</span>}
          </h3>
          {log?.some((c) => c.pushed === false) && <span className="muted small">{log.filter((c) => c.pushed === false).length} not pushed</span>}
        </header>
        {!log ? (
          <p className="muted small gitp-note">Reading…</p>
        ) : log.length === 0 ? (
          <p className="muted small gitp-note">No commits yet.</p>
        ) : (
          <ul className="gitp-list">
            {log.map((c) => {
              const key: Key = `commit:${c.sha}`;
              const on = open === key;
              const got = patches[key];
              return (
                <li key={c.sha} className={`gitp-file gitp-commit${on ? " on" : ""}`}>
                  <button type="button" className="gitp-file-main" aria-expanded={on} onClick={() => void toggle(key)}>
                    <span className={`gitp-dot${c.pushed === false ? " unpushed" : ""}`} title={c.pushed === false ? "Not pushed yet" : c.pushed ? "Pushed" : ""} />
                    <code className="gitp-sha">{c.sha.slice(0, 7)}</code>
                    <span className="gitp-path" title={c.subject}>
                      {c.subject}
                    </span>
                    <span className="gitp-when" title={new Date(c.at).toLocaleString()}>
                      {c.author.split(/\s+/)[0]} · {relTime(c.at)}
                    </span>
                    <Icon name={on ? "chevronUp" : "chevronDown"} size={12} />
                  </button>
                  {on && (
                    <div className="gitp-hunks">
                      {got === "loading" || !got ? (
                        <p className="muted small">Reading…</p>
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
          </ul>
        )}
      </section>
      {me.role === "viewer" && <p className="muted small gitp-note">You're watching: only the driver or an owner can stage, commit or pull.</p>}
    </div>
  );
}

/** Whether the Git panel has anything new for its tab's dot: staged or unstaged changes. Exported for the Workbench's tab row. */
export function gitDirty(status: Pick<RepoStatus, "staged" | "unstaged" | "untracked"> | null): boolean {
  return !!status && status.staged.length + status.unstaged.length + status.untracked.length > 0;
}

