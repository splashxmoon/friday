import { useEffect, useMemo, useRef, useState } from "react";
import { driverOf, runOf, type SessionState } from "../session/projection.js";
import type { Member, SessionEvent } from "../types.js";
import { Icon } from "./icons.js";
import { commitPaths } from "../shepherd.js";
import { scriptsIn, type Script } from "./Problems.js";
import type { Send } from "./useSession.js";
import { Check } from "./ui.js";

/**
 * From the changes to a pull request, docked at the foot of the Changes panel (Arun, 2026-11-03: the Changes panel "like this",
 * after Conductor's checks and Claude Code's Changes card): the project's checks as one card, each with its state and, when it
 * failed, the agent asked to fix it; under it the commit message whole and one button, Commit, Commit and push, or Commit and
 * open PR. Which files go in, the branch and where it pushes are under Details. Nothing runs until somebody presses it, and a
 * failing check is advice, not a gate.
 *
 * The message is drafted by a model, so it is drafted when somebody starts to commit (the box is pressed), not each time the
 * panel shows.
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
  // Somebody started to commit (the message box pressed): the message is drafted and where it pushes is asked, once.
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(false);

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
    if (scripts || !canAct || !files.length) return;
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
  }, [canAct, sid, invite, lane, scripts, files.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const go = hasRemote && pr && remote?.github ? "Commit & open PR" : hasRemote && push ? "Commit & push" : "Commit";
  // A failed check handed to the agent with what it said, as a person would paste it.
  const fixIt = async (c: Script) => {
    const out = results.get(c.run)?.output.slice(-4000) ?? "";
    const r = await send({ type: "instruct", lane, text: `The check \`${c.run}\` failed after your changes. Fix what it reports, then run it again.\n\nWhat it said:\n\`\`\`\n${out}\n\`\`\`` });
    if (!r.ok) setError(r.error ?? "Couldn't hand that to the agent.");
  };
  const needs = failed.length;
  const checksSay = checking ? "running…" : needs ? `${needs} need${needs === 1 ? "s" : ""} you` : chosen.length && passed.length === chosen.length ? "all passed" : "not run yet";

  if (done)
    return (
      <section className="ship-dock" aria-label="Ship these changes">
        <div className="sd-done">
          <span className="sd-mk ok" aria-hidden="true">
            <Icon name="check" size={10} />
          </span>
          <span className="sd-done-text">
            <b>{done.message.split("\n")[0]}</b>
            <em>
              {done.sha.slice(0, 7)} on {done.branch || "this branch"} · {done.files} file{done.files === 1 ? "" : "s"}
              {done.pushed ? " · pushed" : ""}
            </em>
          </span>
        </div>
        {done.error && <p className="error small">{done.error}</p>}
        {prUrl ? (
          <div className="sd-row">
            <button type="button" className="sd-act" onClick={() => void pullReview()}>
              Pull in review comments
            </button>
            <button type="button" className="sd-act" onClick={() => void fixChecks()}>
              Fix failing checks
            </button>
            {may && !/\/compare\//.test(prUrl) && (
              <button
                type="button"
                className="sd-act"
                title="Friday watches the pull request, hands red checks and new review comments to the agent, and pushes the fixes until it merges"
                onClick={async () => {
                  const r = await send({ type: "pr.shepherd", on: state.shepherd?.prUrl !== prUrl, lane });
                  if (!r.ok) setFetched(r.error ?? "Couldn't hand the pull request over.");
                }}
              >
                {state.shepherd?.prUrl === prUrl ? "Stop seeing it through" : "See it through to merge"}
              </button>
            )}
            <a className="sd-go" href={prUrl} target="_blank" rel="noreferrer">
              <Icon name="gitPullRequest" size={13} /> {done.prCreated === false ? "Open the PR page" : "Open the PR"}
            </a>
          </div>
        ) : (
          !done.pushed && <p className="sd-note">It's committed on this computer. {hasRemote ? "Push it from the Git panel when you're ready." : "There is no remote to push to from here."}</p>
        )}
        {fetched && <p className="sd-note">{fetched}</p>}
      </section>
    );

  return (
    <section className="ship-dock" aria-label="Ship these changes">
      {canAct && !!scripts?.length && (
        <div className="sd-checks">
          <div className="sd-checks-head">
            <b>Checks</b>
            <span className={needs ? "bad" : ""}>· {checksSay}</span>
            {chosen.length > 0 && (
              <button type="button" className="sd-act" disabled={checking || !may || running} onClick={() => void runChecks()}>
                {checking ? <span className="spinner tiny" /> : null}
                {checking ? "Running" : failed.length || passed.length ? "Run again" : "Run"}
              </button>
            )}
          </div>
          {scripts.map((c) => {
            const r = results.get(c.run);
            const on = picked.has(c.run);
            const now = current === c.run;
            return (
              <div key={c.run} className={`sd-chk${on ? "" : " off"}`}>
                <button
                  type="button"
                  className={`sd-mk${now ? " run" : r ? (r.ok ? " ok" : " bad") : ""}`}
                  aria-pressed={on}
                  disabled={checking}
                  title={on ? "Left out of the next run" : "Run it with the others"}
                  aria-label={on ? `Leave ${c.name} out` : `Run ${c.name}`}
                  onClick={() =>
                    setPicked((all) => {
                      const next = new Set(all);
                      if (next.has(c.run)) next.delete(c.run);
                      else next.add(c.run);
                      return next;
                    })
                  }
                >
                  {now ? null : r ? <Icon name={r.ok ? "check" : "x"} size={9} /> : null}
                </button>
                <button type="button" className="sd-chk-t" disabled={!r} onClick={() => setShown(shown === c.run ? null : c.run)} title={r ? (shown === c.run ? "Hide what it said" : "What it said") : c.run}>
                  {c.name} <em>· {now ? "running…" : r ? (r.ok ? "passed" : "failed") : c.run}</em>
                </button>
                {r && !r.ok && may && (
                  <button type="button" className="sd-act" onClick={() => void fixIt(c)}>
                    Fix it
                  </button>
                )}
                {shown === c.run && r && <pre className="cmd-out sd-out">{r.output.slice(-6000)}</pre>}
              </div>
            );
          })}
        </div>
      )}

      <div className="sd-commit">
        <textarea
          className="sd-msg"
          rows={3}
          value={message}
          aria-label="Commit message"
          placeholder={drafting ? "Writing a message from the changes…" : "Commit message"}
          onFocus={() => setOpen(true)}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canCommit) void commit();
          }}
        />
        <div className="sd-row">
          <button type="button" className="sd-where" aria-expanded={details} onClick={() => setDetails((v) => !v)} title="Which files go in, the branch, and where it pushes">
            {taking.length === files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : `${taking.length} of ${files.length} files`}
            {(branch.trim() || engine?.branch) && <> · {branch.trim() || engine?.branch}</>}
            <Icon name={details ? "chevronDown" : "chevronRight"} size={12} />
          </button>
          <button
            type="button"
            className="sd-go"
            disabled={!canCommit}
            title={!message.trim() ? "Write a message first" : blocked || undefined}
            onClick={() => (message.trim() ? void commit() : setOpen(true))}
          >
            {busy ? "Committing…" : go} <kbd>⌘↵</kbd>
          </button>
        </div>
        {details && (
          <div className="sd-details">
            <div className="ship-files">
              {files.map((f) => (
                <label key={f.path} className={`ship-file ${leave.has(f.path) ? "out" : ""}`}>
                  <Check
                    checked={!leave.has(f.path)}
                    onChange={(on) =>
                      setLeave((all) => {
                        const next = new Set(all);
                        if (on) next.delete(f.path);
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
            {leave.size > 0 && <p className="sd-note">The {leave.size} left out stay in the folder, uncommitted.</p>}
            <label className="field">
              Branch
              <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={engine?.branch ?? "current branch"} spellCheck={false} />
              <em className="muted small">{branch.trim() && branch.trim() !== engine?.branch ? "Created if it doesn't exist, and switched to." : "Commits to the branch the folder is on."}</em>
            </label>
            {hasRemote ? (
              <div className="ship-options">
                <label className="check-row">
                  <Check checked={push || pr} disabled={pr && !!remote?.github} onChange={(on) => setPush(on)} />
                  Push to {remote?.github ?? "origin"}
                </label>
                {remote?.github && (
                  <label className="check-row">
                    <Check checked={pr} onChange={(on) => setPr(on)} />
                    Open a pull request
                  </label>
                )}
              </div>
            ) : (
              pushNote && <p className="sd-note">{pushNote}</p>
            )}
          </div>
        )}
        {error ? (
          <p className="error small" role="alert">
            {error}
          </p>
        ) : (
          blocked && message.trim() && <p className="sd-note">{blocked}</p>
        )}
      </div>
    </section>
  );
}
