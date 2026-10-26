import { useEffect, useMemo, useRef, useState } from "react";
import { driverOf, runOf, type SessionState } from "../session/projection.js";
import type { Member, SessionEvent } from "../types.js";
import { Icon } from "./icons.js";
import { commitPaths } from "../shepherd.js";
import { scriptsIn, type Script } from "./Problems.js";
import type { Send } from "./useSession.js";

/**
 * From a diff to a pull request, in the order people do it.
 *
 * Look at what changed, run the checks, commit what belongs, push it, and
 * open the pull request or read what reviewers said. They were four trips: the
 * diff here, a terminal for the tests, a dialog for the commit, a browser tab
 * for the PR. This is one drawer at the foot of the Diff panel with the four
 * as steps, each saying where it stands, so the whole path is in view and the
 * next move is always the one button that is lit.
 *
 * Nothing runs until somebody presses it. Checks are advice, not a gate: a
 * failing one is said plainly on the commit step, and the person decides.
 */

const BRANCHY = /^(main|master|trunk|develop)$/;
/** Ticked to begin with: what proves a change is sound, as opposed to what builds it or starts a server. */
const FIRST = ["typecheck", "lint", "test", "check"];

interface Ran {
  command: string;
  ok: boolean;
  output: string;
  seq: number;
}

type Remote = { url?: string; github?: string | null };

export function ShipFlow({ state, me, sid, invite, send, lane, events }: { state: SessionState; me: Member; sid: string; invite: string; send: Send; lane: string; events: SessionEvent[] }) {
  const engine = state.engines[lane] ?? Object.values(state.engines)[0];
  const files = state.diffs[lane]?.files ?? [];
  const may = me.role === "owner" || driverOf(state, lane)?.id === me.id;
  const running = runOf(state, lane).status === "running";
  const online = !!engine?.online;
  // A Plan-mode machine is look-only: nothing runs or commits there. Manual and Auto both take a person's press as the yes.
  const plan = online && engine?.mode === "plan";
  const canAct = online && !plan;

  // Where the log stood when the drawer opened, so a commit made now is told apart from one made last week.
  const base = useRef(events.at(-1)?.seq ?? 0);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);

  // 1. Review: which files go in.
  const [leave, setLeave] = useState<Set<string>>(new Set());
  const taking = files.filter((f) => !leave.has(f.path));
  const adds = taking.reduce((n, f) => n + f.additions, 0);
  const dels = taking.reduce((n, f) => n + f.deletions, 0);

  // 2. Checks: what this project says proves it works.
  const [scripts, setScripts] = useState<Script[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [started, setStarted] = useState(0);
  const [current, setCurrent] = useState("");
  const [skipped, setSkipped] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!open || scripts || !canAct) return;
    let live = true;
    const read = (path: string) =>
      fetch(`/api/sessions/${encodeURIComponent(sid)}/repo?op=read&raw=1&path=${encodeURIComponent(path)}&invite=${encodeURIComponent(invite)}${lane ? `&lane=${encodeURIComponent(lane)}` : ""}`)
        .then((r) => r.json() as Promise<{ output?: string; error?: string }>)
        .then((r) => (r.error ? null : { path, text: r.output ?? "" }))
        .catch(() => null);
    void Promise.all(["package.json", "Makefile", "Cargo.toml", "pyproject.toml"].map(read)).then((found) => {
      if (!live) return;
      const list = scriptsIn(found.filter((f): f is { path: string; text: string } => !!f)).filter((s) => !["dev", "start", "format", "e2e"].includes(s.name));
      setScripts(list);
      setPicked(new Set(list.filter((s) => FIRST.includes(s.name)).map((s) => s.run)));
    });
    return () => {
      live = false;
    };
  }, [open, canAct, sid, invite, lane, scripts]);
  /** The newest result of each command since this round of checks began. */
  const results = useMemo(() => {
    const out = new Map<string, Ran>();
    for (const e of events) if (e.seq > started && e.body.type === "folder.ran") out.set(e.body.command, { command: e.body.command, ok: !e.body.isError, output: e.body.output, seq: e.seq });
    return out;
  }, [events, started]);
  const chosen = (scripts ?? []).filter((s) => picked.has(s.run));
  const failed = chosen.filter((s) => results.get(s.run) && !results.get(s.run)!.ok);
  const passed = chosen.filter((s) => results.get(s.run)?.ok);
  const checking = !!current;

  const runChecks = async () => {
    setStarted(events.at(-1)?.seq ?? 0);
    setSkipped(false);
    for (const s of chosen) {
      setCurrent(s.run);
      const r = await send({ type: "folder.run", command: s.run, lane });
      // A refusal (not the driver, plan-only) stops the round: nothing after it would be let through either.
      if (!r.ok) {
        setError(r.error ?? "That check couldn't run.");
        break;
      }
    }
    setCurrent("");
  };

  // 3. Commit.
  const [message, setMessage] = useState("");
  const [drafting, setDrafting] = useState(false);
  const onBranch = engine?.branch && !BRANCHY.test(engine.branch) ? engine.branch : "";
  const [branch, setBranch] = useState(onBranch);
  const [remote, setRemote] = useState<Remote | null>(null);
  useEffect(() => {
    if (!open || !files.length) return;
    let live = true;
    setDrafting(true);
    fetch(`/api/sessions/${encodeURIComponent(sid)}/commit-message?invite=${encodeURIComponent(invite)}&lane=${encodeURIComponent(lane)}`)
      .then((r) => r.json() as Promise<{ message?: string; branch?: string; remote?: Remote }>)
      .then((d) => {
        if (!live) return;
        setRemote(d.remote ?? {});
        setMessage((m) => m || d.message || "");
        setBranch((b) => b || (onBranch ? "" : (d.branch ?? "")));
      })
      // No answer is "no remote known", not "checking…" for good.
      .catch(() => live && setRemote({}))
      .finally(() => live && setDrafting(false));
    return () => {
      live = false;
    };
  }, [open, sid, invite, lane, onBranch, files.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // 4. Push, and the pull request.
  const hasRemote = canAct && !!remote?.url;
  // Why a push isn't offered, when it isn't: no machine, still asking, or nowhere to push to.
  const pushNote = !online ? "Commits in this folder. Connect a computer to push." : remote === null ? "Checking where this pushes to…" : !remote.url ? "No remote, so the commit stays on this computer." : "";
  const [push, setPush] = useState(true);
  const [pr, setPr] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fetched, setFetched] = useState("");

  const commit = async () => {
    setBusy(true);
    setError("");
    const r = await send({
      type: "folder.commit",
      quiet: true,
      message,
      lane,
      ...(branch.trim() && branch.trim() !== engine?.branch ? { branch: branch.trim() } : {}),
      // Only the files listed, so nothing else in the folder (the person's own unfinished work) is swept in: a rename's old
      // path with it, and the files past the 80 shown, which the change set names without their patches.
      only: commitPaths(taking, state.diffs[lane]?.more),
      push: hasRemote && (push || (pr && !!remote?.github)),
      pr: hasRemote && pr && !!remote?.github,
    });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "Couldn't commit. Check git's message in the Terminal tab, then try again.");
    setStep(4);
  };

  // What the commit did, read from the log it was recorded in.
  const landed = [...events].reverse().find((e) => e.seq > base.current && e.body.type === "folder.committed");
  const done = landed?.body.type === "folder.committed" ? landed.body : null;
  const prUrl = done?.prUrl ?? [...events].reverse().map((e) => (e.body.type === "folder.committed" ? e.body.prUrl : undefined)).find(Boolean);

  const pullReview = async () => {
    setFetched("Asking GitHub…");
    const r = await send({ type: "pr.feedback", lane });
    setFetched(r.ok ? "Review comments are with the agent." : (r.error ?? "Couldn't read the review. Make sure gh is signed in on the connected machine, then try again."));
  };
  // The failed checks' logs, read through gh and handed over; green or still running is said as such.
  const fixChecks = async () => {
    setFetched("Reading the checks…");
    const r = await send({ type: "pr.checks", lane });
    setFetched(r.ok ? "The failing checks are with the agent." : (r.error ?? "Couldn't read the checks. Make sure gh is signed in on the connected machine, then try again."));
  };

  if (!files.length && !done) return null;

  const blocked = !may ? "Only the driver or an owner can commit." : running ? "Wait for the run to finish." : plan ? "This computer is in Plan mode, so nothing can be committed from it. Its host can change that in the session header." : "";
  const canCommit = !blocked && !busy && !!message.trim() && taking.length > 0;

  const mark = (n: number, ok: boolean) => (
    <span className={`sf-mark ${ok ? "ok" : step === n ? "now" : ""}`}>{ok ? <Icon name="check" size={11} /> : n}</span>
  );

  return (
    <section className={`ship-flow ${open ? "open" : ""} ${done ? "done" : "ready"}`} aria-label="Ship these changes">
      <button type="button" className="sf-bar" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="sf-lead" aria-hidden="true">
          <Icon name={done ? "check" : "commit"} size={16} />
        </span>
        <span className="sf-bar-text">
          <span className="sf-bar-main">
            {done ? (
              <>Committed{done.pushed ? " and pushed" : ""}</>
            ) : (
              <>
                {taking.length} file{taking.length === 1 ? "" : "s"} ready to commit
              </>
            )}
          </span>
          <span className="sf-bar-sub" title={done ? `${done.sha.slice(0, 7)} on ${done.branch || "this branch"}` : `+${adds} −${dels} · ${running ? "the agent is still working" : "review, check and commit them"}`}>
            {done ? (
              <>
                {done.sha.slice(0, 7)} on {done.branch || "this branch"}
              </>
            ) : (
              <>
                <span className="diff-add">+{adds}</span> <span className="diff-del">−{dels}</span>
                <span className="sf-bar-dot"> · </span>
                {running ? "the agent is still working" : "review, check and commit them"}
              </>
            )}
          </span>
        </span>
        <span className="sf-bar-go">
          {done ? (prUrl ? "Pull request" : "Details") : "Review & commit"} <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
        </span>
      </button>

      {open && (
        <div className="sf-body">
          {done ? (
            <div className="sf-done">
              <p>
                <b>{done.message.split("\n")[0]}</b>
                <span className="muted small">
                  {" "}
                  {done.sha.slice(0, 7)} on {done.branch || "this branch"} · {done.files} file{done.files === 1 ? "" : "s"}
                </span>
              </p>
              {done.error && <p className="error small">{done.error}</p>}
              {prUrl ? (
                <div className="sf-actions">
                  <button type="button" className="btn ghost small" onClick={() => void pullReview()}>
                    Pull in review comments
                  </button>
                  <button type="button" className="btn ghost small" onClick={() => void fixChecks()}>
                    Fix the failing checks
                  </button>
                  {may && !/\/compare\//.test(prUrl) && (
                    <button
                      type="button"
                      className={`btn small ${state.shepherd?.prUrl === prUrl ? "ghost" : ""}`}
                      title="Friday watches the pull request, hands red checks and new review comments to the agent, and pushes the fixes until it merges"
                      onClick={async () => {
                        const r = await send({ type: "pr.shepherd", on: state.shepherd?.prUrl !== prUrl, lane });
                        if (!r.ok) setFetched(r.error ?? "Couldn't hand the pull request over.");
                      }}
                    >
                      {state.shepherd?.prUrl === prUrl ? "Stop seeing it through" : "See it through to merge"}
                    </button>
                  )}
                  <a className="btn primary small" href={prUrl} target="_blank" rel="noreferrer">
                    <Icon name="gitPullRequest" size={13} /> {done.prCreated === false ? "Open the pull request page" : "Open the pull request"}
                  </a>
                </div>
              ) : (
                !done.pushed && <p className="muted small">It's committed on this computer. {hasRemote ? "Push it from the Git menu when you're ready." : "There is no remote to push to from here."}</p>
              )}
              {fetched && <p className="muted small">{fetched}</p>}
            </div>
          ) : (
            <>
              {/* 1 · Review */}
              <div className={`sf-step ${step === 1 ? "on" : ""}`}>
                <button type="button" className="sf-step-head" onClick={() => setStep(1)}>
                  {mark(1, step > 1)}
                  <span>Review the diff</span>
                  <em>
                    {taking.length} of {files.length} included
                  </em>
                </button>
                {step === 1 && (
                  <div className="sf-step-body">
                    <div className="ship-files">
                      {files.map((f) => (
                        <label key={f.path} className={`ship-file ${leave.has(f.path) ? "out" : ""}`}>
                          <input
                            type="checkbox"
                            checked={!leave.has(f.path)}
                            onChange={(e) =>
                              setLeave((all) => {
                                const next = new Set(all);
                                if (e.target.checked) next.delete(f.path);
                                else next.add(f.path);
                                return next;
                              })
                            }
                          />
                          {/* Cut short from the left (direction: rtl), so the whole path is in the tooltip; <bdi> keeps a leading dot where it belongs. */}
                          <span className="ship-file-path" title={f.path}>
                            <bdi>{f.path}</bdi>
                          </span>
                          <span className="ship-file-counts">
                            {f.additions > 0 && <span className="diff-add">+{f.additions}</span>}
                            {f.deletions > 0 && <span className="diff-del">−{f.deletions}</span>}
                          </span>
                        </label>
                      ))}
                    </div>
                    {leave.size > 0 && <p className="muted small">The {leave.size} left out stay in the folder, uncommitted.</p>}
                    <div className="sf-actions">
                      <button type="button" className="btn primary small" disabled={!taking.length} onClick={() => setStep(2)}>
                        Next: checks
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* 2 · Checks */}
              <div className={`sf-step ${step === 2 ? "on" : ""}`}>
                <button type="button" className="sf-step-head" onClick={() => setStep(2)}>
                  {mark(2, step > 2 && (skipped || (chosen.length > 0 && passed.length === chosen.length)))}
                  <span>Run the checks</span>
                  <em className={failed.length ? "bad" : ""}>
                    {checking ? "running…" : failed.length ? `${failed.length} failed` : passed.length && passed.length === chosen.length ? "all passed" : skipped ? "skipped" : ""}
                  </em>
                </button>
                {step === 2 && (
                  <div className="sf-step-body">
                    {!canAct ? (
                      <p className="muted small">{plan ? "This computer is in Plan mode, so nothing runs there until its host changes that in the session header." : "Connect a computer to run checks here. You can still commit."}</p>
                    ) : scripts === null ? (
                      <p className="muted small">Looking for this project's checks…</p>
                    ) : scripts.length === 0 ? (
                      <p className="muted small">No test, lint or typecheck script found in this folder.</p>
                    ) : (
                      <ul className="sf-checks">
                        {scripts.map((s) => {
                          const r = results.get(s.run);
                          const now = current === s.run;
                          return (
                            <li key={s.run} className={r ? (r.ok ? "pass" : "fail") : ""}>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={picked.has(s.run)}
                                  disabled={checking}
                                  onChange={(e) =>
                                    setPicked((all) => {
                                      const next = new Set(all);
                                      if (e.target.checked) next.add(s.run);
                                      else next.delete(s.run);
                                      return next;
                                    })
                                  }
                                />
                                <code>{s.run}</code>
                              </label>
                              <span className="sf-result">
                                {now ? <span className="spinner tiny" /> : r ? <Icon name={r.ok ? "check" : "x"} size={12} /> : null}
                                {r && (
                                  <button type="button" className="link-btn" onClick={() => setShown(shown === s.run ? null : s.run)}>
                                    {shown === s.run ? "Hide output" : "Output"}
                                  </button>
                                )}
                              </span>
                              {shown === s.run && r && <pre className="cmd-out">{r.output.slice(-6000)}</pre>}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <div className="sf-actions">
                      {canAct && chosen.length > 0 && (
                        <button type="button" className="btn small" disabled={checking || !may || running} onClick={() => void runChecks()}>
                          {checking ? "Running…" : failed.length || passed.length ? "Run again" : `Run ${chosen.length} check${chosen.length === 1 ? "" : "s"}`}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn primary small"
                        disabled={checking}
                        onClick={() => {
                          if (!passed.length && !failed.length) setSkipped(true);
                          setStep(3);
                        }}
                      >
                        {passed.length || failed.length ? "Next: commit" : "Skip checks"}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* 3 · Commit */}
              <div className={`sf-step ${step === 3 ? "on" : ""}`}>
                <button type="button" className="sf-step-head" onClick={() => setStep(3)}>
                  {mark(3, false)}
                  <span>Commit</span>
                  <em>{branch.trim() || engine?.branch || ""}</em>
                </button>
                {step === 3 && (
                  <div className="sf-step-body">
                    {failed.length > 0 && (
                      <p className="sf-warn">
                        <Icon name="shield" size={12} /> {failed.map((s) => s.run).join(", ")} failed. You can still commit; it is your call.
                      </p>
                    )}
                    <label className="field">
                      Message
                      <textarea
                        // Reached by "Next": the message is what this step is for, so typing starts here.
                        autoFocus
                        rows={4}
                        value={message}
                        placeholder={drafting ? "Writing a message from the diff…" : "What changed, and why"}
                        onChange={(e) => setMessage(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canCommit) void commit();
                        }}
                      />
                    </label>
                    <label className="field">
                      Branch
                      <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={engine?.branch ?? "current branch"} spellCheck={false} />
                      <em className="muted small">{branch.trim() && branch.trim() !== engine?.branch ? "Created if it doesn't exist, and switched to." : "Commits to the branch the folder is on."}</em>
                    </label>
                    {hasRemote ? (
                      <div className="ship-options">
                        <label className="check-row">
                          <input type="checkbox" checked={push || pr} disabled={pr && !!remote?.github} onChange={(e) => setPush(e.target.checked)} />
                          Push to {remote?.github ?? "origin"}
                        </label>
                        {remote?.github && (
                          <label className="check-row">
                            <input type="checkbox" checked={pr} onChange={(e) => setPr(e.target.checked)} />
                            Open a pull request
                          </label>
                        )}
                      </div>
                    ) : (
                      pushNote && <p className="muted small">{pushNote}</p>
                    )}
                    {(error || blocked) && (
                      <p className="error small" role="alert">
                        {error || blocked}
                      </p>
                    )}
                    <div className="sf-actions">
                      <button type="button" className="btn primary" disabled={!canCommit} onClick={() => void commit()}>
                        {busy ? "Committing…" : hasRemote && pr && remote?.github ? "Commit and open PR" : hasRemote && push ? "Commit and push" : "Commit"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
