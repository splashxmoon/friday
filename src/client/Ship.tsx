import { FileIcon } from "./fileIcons.js";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { driverOf, runOf, type SessionState } from "../session/projection.js";
import type { DiffFile, Member } from "../types.js";
import { Icon } from "./icons.js";
import { splitPath } from "./diff-lines.js";
import { Segmented, useDismiss } from "./ui.js";
import type { Send } from "./useSession.js";
import type { Receipt } from "../receipt.js";
import { commitPaths } from "../shepherd.js";

/**
 * Ship what the session made: commit, push, open a pull request.
 *
 * One dialog with the message already written from the diff, because the last
 * step of every coding run used to be leaving the room for a terminal. The
 * message is a suggestion and the fields are all editable; nothing is committed
 * until someone presses the button.
 *
 * Pushing and opening a pull request use the host machine's own git login, so
 * they are only offered where the computer allows running commands, and only
 * where there is a remote to push to.
 */

export function ShipButton({ state, me, sid, invite, send, lane }: { state: SessionState; me: Member; sid: string; invite: string; send: Send; lane: string }) {
  const [open, setOpen] = useState(false);
  const may = me.role === "owner" || driverOf(state, lane)?.id === me.id;
  const running = runOf(state, lane).status === "running";
  if (!state.diffs[lane]?.files.length) return null;
  return (
    <>
      <button
        type="button"
        className="btn primary small ship-btn"
        disabled={!may || running}
        title={running ? "Wait for the run to finish" : may ? "Commit these changes" : "Only the driver or an owner can commit"}
        onClick={() => setOpen(true)}
      >
        <Icon name="check" size={13} /> Commit
      </button>
      {open && <ShipDialog state={state} sid={sid} invite={invite} send={send} lane={lane} onClose={() => setOpen(false)} />}
    </>
  );
}

/** What the receipt says about this change, as ticks and crosses. A cross blocks the commit until somebody says "do it anyway". */
export function shipChecks(receipt: Receipt | undefined, pr: boolean, message: string): { ok: boolean; hard: boolean; text: string }[] {
  if (!receipt) return [];
  const bad = receipt.flags.filter((f) => f.level === "bad");
  const warn = receipt.flags.filter((f) => f.level === "warn");
  return [
    receipt.tests === "pass" ? { ok: true, hard: false, text: "Tests ran and passed" } : receipt.tests === "fail" ? { ok: false, hard: true, text: "The last test run failed" } : { ok: false, hard: false, text: "No tests ran" },
    bad.length ? { ok: false, hard: true, text: bad.map((f) => f.text).join("; ") } : { ok: true, hard: false, text: "No test switched off or deleted" },
    ...warn.map((f) => ({ ok: false, hard: false, text: f.text })),
    ...(pr ? [message.trim() ? { ok: true, hard: false, text: "The pull request has a title" } : { ok: false, hard: true, text: "The pull request needs a title: the commit message" }] : []),
  ];
}

export function ShipDialog({ state, sid, invite, send, lane, onClose, receipt, dir }: { state: SessionState; sid: string; invite: string; send: Send; lane: string; onClose: () => void; /** The run's receipt, for the checklist. */ receipt?: Receipt; /** Commit in one of the folders the agent also works in (the Git panel's pick), not the lane's own. */ dir?: string }) {
  const ref = useRef<HTMLFormElement>(null);
  useDismiss(ref, onClose);
  const engine = state.engines[lane] ?? Object.values(state.engines)[0];
  // A folder that was uploaded has no remote, and a machine in Plan mode is look-only; neither is offered something that
  // fails. Manual and Auto both push on a person's press.
  const canPush = !!engine?.online && engine.mode !== "plan";
  const onBranch = engine?.branch && !/^(main|master|trunk|develop)$/.test(engine.branch) ? engine.branch : "";
  const files = (state.diffs[lane]?.files ?? []).filter((f) => (dir ? f.repo === dir : !f.repo));

  const [message, setMessage] = useState("");
  const [drafting, setDrafting] = useState(true);
  const [branch, setBranch] = useState(onBranch);
  // Unknown until the folder says where it pushes to; no remote means nothing to tick.
  const [remote, setRemote] = useState<{ url?: string; github?: string | null } | null>(null);
  const hasRemote = canPush && !!remote?.url;
  /**
   * Where the commit goes, as one choice: kept here, pushed, or pushed with a pull request.
   *
   * It was two checkboxes, whose four combinations included one that can't be (a pull request without the push), and a
   * slow or failed look at the remote left both unticked. Now it is three options, the furthest one the remote allows
   * chosen once the folder says where it pushes to.
   */
  const [dest, setDest] = useState<Dest>("here");
  const pr = dest === "pr" || dest === "stack";
  // Stacking: the folder is on a branch with an open pull request, and the new branch's pull request is opened onto it (stack.ts).
  const stackable = !!onBranch && !!state.pr?.url && !state.pr.merged && !!engine?.branch;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Which files go in. Everything, until somebody says otherwise — a run
  // usually touches more than the one thing worth recording, and "commit
  // everything" makes you clean up afterwards instead of choosing up front.
  const [leave, setLeave] = useState<Set<string>>(new Set());
  /** The checklist said no and somebody said yes anyway. */
  const [anyway, setAnyway] = useState(false);
  const checks = shipChecks(receipt, pr, message);
  const hard = checks.filter((c) => c.hard && !c.ok);
  const blocked = hard.length > 0 && !anyway;
  const taking = files.filter((f) => !leave.has(f.path));

  useEffect(() => {
    let live = true;
    fetch(`/api/sessions/${encodeURIComponent(sid)}/commit-message?invite=${encodeURIComponent(invite)}&lane=${encodeURIComponent(lane)}`)
      .then((r) => r.json() as Promise<{ message?: string; branch?: string; remote?: { url?: string; github?: string | null } }>)
      .then((d) => {
        if (!live) return;
        setRemote(d.remote ?? {});
        setDest(canPush && d.remote?.url ? (d.remote.github ? "pr" : "push") : "here");
        setMessage((m) => m || d.message || "");
        setBranch((b) => b || (onBranch ? "" : (d.branch ?? "")));
      })
      // No answer is "no remote known", not "checking…" for good.
      .catch(() => live && setRemote({}))
      .finally(() => live && setDrafting(false));
    return () => {
      live = false;
    };
  }, [sid, invite, lane, onBranch, canPush]);

  const submit = async () => {
    setBusy(true);
    setError("");
    const r = await send({
      type: "folder.commit",
      quiet: true,
      message,
      lane,
      ...(branch.trim() && branch.trim() !== engine?.branch ? { branch: branch.trim() } : {}),
    ...(dest === "stack" && engine?.branch ? { base: engine.branch } : {}),
    ...(dir ? { dir } : {}),
      // Only the files listed, so nothing else in the folder (the person's own unfinished work) is swept in: a rename's old
      // path with it, and the files past the 80 shown, which the change set names without their patches.
      only: commitPaths(taking, state.diffs[lane]?.more),
      // Only where there is somewhere to push to: a choice left from before the folder answered is not a push.
      push: hasRemote && dest !== "here",
      pr: hasRemote && pr && !!remote?.github,
    });
    if (!r.ok) {
      setError(r.error ?? "Couldn't commit. Check git's message in the Terminal tab, then try again.");
      setBusy(false);
      return;
    }
    onClose();
  };

  const adds = taking.reduce((n, f) => n + f.additions, 0);
  const dels = taking.reduce((n, f) => n + f.deletions, 0);
  const all = taking.length === files.length;
  const subject = message.split("\n")[0]!.trim();
  const target = branch.trim() || engine?.branch || "";
  const options: [Dest, string][] = [["here", "Keep it here"], ...(hasRemote ? [["push", "Push"] as [Dest, string]] : []), ...(hasRemote && remote?.github ? [["pr", "Push and open PR"] as [Dest, string]] : []), ...(hasRemote && remote?.github && stackable ? [["stack", "Stack a PR"] as [Dest, string]] : [])];
  const stackNeedsBranch = dest === "stack" && (!branch.trim() || branch.trim() === engine?.branch);
  const ready = !busy && !!subject && taking.length > 0 && !blocked && !stackNeedsBranch;

  // On the page's body, not inside the review card: the card sits in the conversation's scrolling column, where a fixed
  // overlay was pinned to the column (so it moved as the conversation scrolled) and the conversation scrolled behind it.
  return createPortal(
    <div className="overlay ship-overlay">
      <form
        ref={ref}
        className="modal ship-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Commit changes"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void submit();
        }}
      >
        <div className="pop-head">
          <div className="ship-title">
            <h2>Commit changes</h2>
            <p className="ship-where">
              {target && (
                <span className="ship-branch" title={target}>
                  <Icon name="gitBranch" size={12} />
                  <span>{target}</span>
                </span>
              )}
              {engine && <span>{engine.hostName}'s machine</span>}
            </p>
          </div>
          <button type="button" className="icon-btn tiny" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>

        <section className="ship-sec" aria-label="Files">
          <div className="ship-sec-head">
            <span className="ship-label">
              Files <b>{all ? files.length : `${taking.length} of ${files.length}`}</b>
            </span>
            <span className="ship-sum">
              <span className="diff-add">+{adds}</span> <span className="diff-del">−{dels}</span>
            </span>
            {files.length > 1 && (
              <button type="button" className="link-btn" onClick={() => setLeave(all ? new Set(files.map((f) => f.path)) : new Set())}>
                {all ? "Clear" : "Select all"}
              </button>
            )}
          </div>
          <div className="ship-files">
            {files.map((f) => {
              const { dir, name } = splitPath(f.path);
              const out = leave.has(f.path);
              return (
                <label key={f.path} className={`ship-file ${out ? "out" : ""}`} title={f.path}>
                  <input
                    type="checkbox"
                    checked={!out}
                    onChange={(e) =>
                      setLeave((had) => {
                        const next = new Set(had);
                        if (e.target.checked) next.delete(f.path);
                        else next.add(f.path);
                        return next;
                      })
                    }
                  />
                  <FileIcon path={f.path} size={14} />
                  <span className="ship-file-name">{name}</span>
                  {dir && <span className="ship-file-dir">{dir.replace(/\/$/, "")}</span>}
                  <span className={`dv-badge ${f.status}`} aria-label={STATUS[f.status]}>
                    {STATUS[f.status][0]}
                  </span>
                  <span className="ship-file-counts">
                    {f.additions > 0 && <span className="diff-add">+{f.additions}</span>}
                    {f.deletions > 0 && <span className="diff-del">−{f.deletions}</span>}
                  </span>
                </label>
              );
            })}
          </div>
          {leave.size > 0 && <p className="ship-note">The {leave.size} left out stay in the folder, uncommitted.</p>}
        </section>

        <label className="field ship-sec">
          <span className="ship-label-row">
            <span className="ship-label">Message</span>
            {/* The subject is what a log and a pull request title show: past 72 it is cut there. */}
            <span className={`ship-count ${subject.length > 72 ? "over" : ""}`}>{subject.length}/72</span>
          </span>
          <textarea
            rows={4}
            value={message}
            placeholder={drafting ? "Writing a message from the diff…" : "What changed, and why"}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ref.current?.requestSubmit();
            }}
            autoFocus
          />
        </label>

        <label className="field ship-sec">
          <span className="ship-label">Branch</span>
          <span className="ship-input">
            <Icon name="gitBranch" size={13} />
            <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={engine?.branch ?? "current branch"} spellCheck={false} />
          </span>
          <span className="ship-note">{branch.trim() && branch.trim() !== engine?.branch ? "A new branch, made from where the folder is, and switched to." : "The branch the folder is on."}</span>
        </label>

        <div className="field ship-sec">
          <span className="ship-label">Then</span>
          {hasRemote ? (
            <Segmented value={dest} options={options} onChange={setDest} className="full" />
          ) : (
            <p className="ship-note">
              {!engine?.online
                ? "It stays on this computer. Connect a computer to push and open pull requests."
                : !canPush
                  ? "It stays on this computer: it is in Plan mode, so nothing can be pushed from it."
                  : remote
                    ? "It stays on this computer: this repository has no remote to push to."
                    : "Checking where this repository pushes to…"}
            </p>
          )}
          {hasRemote && <p className="ship-note">{dest === "stack" ? `A new branch from ${engine?.branch ?? "this one"}, pushed, with a pull request onto ${engine?.branch ?? "it"} rather than ${remote?.github ? "main" : "the default branch"}: the second step of a stack, read on its own and merged after the first.` : dest === "here" ? "Committed on this computer only. Push it later from the Git menu." : dest === "push" ? `Pushed to ${remote?.github ?? "origin"}.` : `Pushed to ${remote?.github}, and a pull request opened for it.`}</p>}
        </div>

        {hard.length > 0 && (
          <div className="ship-warn" role="alert">
            <Icon name="shield" size={14} />
            <div className="ship-warn-text">
              {hard.map((c) => (
                <p key={c.text}>{c.text}.</p>
              ))}
              <label className="check-row">
                <input type="checkbox" checked={anyway} onChange={(e) => setAnyway(e.target.checked)} />
                Commit anyway
              </label>
            </div>
          </div>
        )}
        {error && (
          <p className="error ship-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!ready} title={blocked ? "Tick “Commit anyway” to go ahead" : !subject ? "Write a message first" : undefined}>
            {busy ? "Committing…" : !hasRemote || dest === "here" ? "Commit" : dest === "push" ? "Commit and push" : dest === "stack" ? "Commit and stack PR" : "Commit and open PR"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

type Dest = "here" | "push" | "pr" | "stack";
const STATUS: Record<DiffFile["status"], string> = { added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed" };
