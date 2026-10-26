import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.js";
import type { Send } from "./useSession.js";
import { placeCard, useDismiss } from "./ui.js";

interface Branch {
  name: string;
  ahead: number;
  behind: number;
  /** The other folder (a worktree) this branch is checked out in: git won't put this one on it too. */
  elsewhere?: string;
}

/** When each session's folder was last asked its branch, so the pills on a page don't each ask. */
const asked = new Map<string, number>();

const branchesUrl = (sid: string, invite: string, lane: string) =>
  `/api/sessions/${encodeURIComponent(sid)}/repo?op=branches&invite=${encodeURIComponent(invite)}&lane=${encodeURIComponent(lane)}`;

/**
 * Which branch the folder is on, and a way to move it.
 *
 * The branch was already written in the files panel's header, as text — which
 * meant the one thing you most often want to do about it, change it, was a
 * trip to a terminal. It is the same fact, made pressable.
 *
 * Switching goes through the session like every other change to the folder, so
 * the room sees it: a branch that changes under a teammate without a word is
 * how two people end up reading different code in the same session.
 */
export function BranchButton({ sid, invite, send, lane, branch, idle = true }: { sid: string; invite: string; send: Send; lane: string; branch?: string; /** No run going: an agent may just have switched. */ idle?: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);

  /**
   * The branch the folder is on now, asked of the folder itself.
   *
   * The name came from when the agent attached, so an agent's own `git switch`, or one in a terminal, left the pill naming a
   * branch the files were no longer on (Arun, 2026-10-24: "make this fully functional"). It asks when the session opens, when
   * a run ends and when the window comes back into focus; the server records a move it finds, so the whole room's pill follows.
   */
  useEffect(() => {
    if (!idle) return;
    const key = `${sid}:${lane}`;
    const ask = () => {
      // Shared by every pill on the page (the header's and the status bar's), so one folder is asked once.
      if (Date.now() - (asked.get(key) ?? 0) < 20_000) return;
      asked.set(key, Date.now());
      void fetch(branchesUrl(sid, invite, lane)).catch(() => {});
    };
    ask();
    const onFocus = () => document.visibilityState === "visible" && ask();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [sid, invite, lane, idle]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`branch-pill ${open ? "on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        // The name is cut short with an ellipsis in a narrow header, so the whole of it is in the tooltip.
        title={branch || "Which branch this folder is on"}
        // Named even when a narrow bar shows only its icon.
        aria-label={`Branch: ${branch || "no branch"}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="gitBranch" size={12} />
        <span className="branch-name">{branch || "no branch"}</span>
        <Icon name="chevronsUpDown" size={12} />
      </button>
      {open && <BranchCard sid={sid} invite={invite} send={send} lane={lane} current={branch} trigger={btn.current} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The list of branches with a box to find one or name a new one; also what the Git menu's "New branch…" opens. */
export function BranchCard({
  sid,
  invite,
  send,
  lane,
  current,
  trigger,
  onClose,
}: {
  sid: string;
  invite: string;
  send: Send;
  lane: string;
  current?: string;
  trigger: HTMLElement | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose, trigger);
  const [list, setList] = useState<Branch[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  // What the folder says it is on, which outranks the name the session last heard.
  const [on, setOn] = useState(current);

  useEffect(() => {
    let live = true;
    fetch(branchesUrl(sid, invite, lane))
      .then((r) => r.json() as Promise<{ output?: string; error?: string }>)
      .then((r) => {
        if (!live) return;
        if (r.error) return setErr(r.error);
        /**
         * The folder answers in JSON when it can answer at all.
         *
         * When it can't — no machine connected, an older server that doesn't
         * know this question — it answers in a sentence, and parsing that as
         * JSON turned an explanation somebody could act on into "Unexpected
         * non-whitespace character after JSON at position 3". The sentence is
         * the better error, so it is the one shown.
         */
        const out = (r.output ?? "").trim();
        let parsed: { branches?: Branch[]; current?: string; error?: string };
        try {
          parsed = JSON.parse(out || "{}") as { branches?: Branch[]; current?: string; error?: string };
        } catch {
          return setErr(out.slice(0, 300) || "The folder didn't answer.");
        }
        if (parsed.error) return setErr(parsed.error);
        if (parsed.current) setOn(parsed.current);
        setList(parsed.branches ?? []);
      })
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [sid, invite, lane]);

  const go = async (name: string, create = false) => {
    setBusy(name);
    setErr("");
    const r = await send({ type: "folder.switch", branch: name, create, lane, quiet: true });
    setBusy("");
    if (!r.ok) return setErr(r.error ?? "Couldn't switch branch. Commit or discard the folder's changes first, then try again.");
    onClose();
  };

  const typed = q.trim();
  const hits = (list ?? []).filter((b) => !typed || b.name.toLowerCase().includes(typed.toLowerCase()));
  // A name nothing matches is a branch you are asking for, not a search that failed.
  const isNew = !!typed && !(list ?? []).some((b) => b.name === typed);

  // On the page itself, placed under its button: inside the header, whose rows clip what overflows them, everything under
  // the search box was cut off and no branch could be picked from the list.
  const place = placeCard(trigger?.getBoundingClientRect(), 300, { want: 360, min: 160, prefer: "below" });
  return createPortal(
    <div ref={ref} className="branch-card surface" role="dialog" aria-label="Branches" style={{ ...place, position: "fixed", right: "auto", marginTop: 0 }}>
      <div className="branch-find">
        <Icon name="search" size={13} />
        <input
          autoFocus
          value={q}
          spellCheck={false}
          placeholder="Find or name a branch"
          aria-label="Find or name a branch"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (isNew) void go(typed, true);
            else if (hits[0]) void go(hits[0].name);
          }}
        />
      </div>
      <div className="branch-list">
        {err && <p role="alert" className="error small branch-note">{err}</p>}
        {list === null && !err && <p className="muted small branch-note">Reading the branches…</p>}
        {isNew && (
          <button type="button" className="branch-row" disabled={!!busy} onClick={() => void go(typed, true)}>
            {busy === typed ? <span className="spinner" /> : <Icon name="plus" size={13} />}
            <span className="branch-name">Start “{typed}” from here</span>
          </button>
        )}
        {hits.map((b) => (
          <button
            key={b.name}
            type="button"
            className={`branch-row ${b.name === on ? "on" : ""}`}
            disabled={!!busy || b.name === on}
            // Checked out in another folder: git won't switch this one onto it, so it says where it is instead. Greyed but not
            // disabled, so the pointer still gets the reason.
            aria-disabled={b.elsewhere && b.name !== on ? true : undefined}
            title={b.elsewhere ? `Checked out in ${b.elsewhere}: git keeps a branch in one folder at a time` : b.name}
            onClick={() => (b.elsewhere ? setErr(`“${b.name}” is checked out in ${b.elsewhere}. Git keeps a branch in one folder at a time: work on it there, or start a new branch from it here.`) : void go(b.name))}
          >
            {busy === b.name ? <span className="spinner" /> : <Icon name={b.name === on ? "check" : "gitBranch"} size={13} />}
            <span className="branch-name">{b.name}</span>
            {b.elsewhere && b.name !== on && <span className="branch-elsewhere">in {b.elsewhere.split(/[\\/]/).filter(Boolean).pop()}</span>}
            {(b.ahead > 0 || b.behind > 0) && (
              <span className="branch-track">
                {b.ahead > 0 && `↑${b.ahead}`}
                {b.behind > 0 && `↓${b.behind}`}
              </span>
            )}
          </button>
        ))}
        {list?.length === 0 && !isNew && <p className="muted small branch-note">This folder has no branches yet.</p>}
      </div>
      <p className="branch-foot muted small">Uncommitted work stays where it is; git refuses the switch if it would be overwritten.</p>
    </div>,
    document.body,
  );
}

/** A branch of a folder not yet in a session, as the runner lists it (describe `branches`). */
export interface FolderBranch {
  name: string;
  /** The other folder (a worktree) it is checked out in. */
  elsewhere?: string;
  /** Only origin has it, as this checkout last fetched. */
  remote?: true;
}

/** How a picked branch is named to git: origin's own for one only origin has. */
export const branchRef = (b: FolderBranch | undefined, name: string): string => (b?.remote ? `origin/${name}` : name);

/**
 * Which branch a new session works on, picked before it starts (Arun, 2026-10-25: "make sure they can change the branch they
 * want to work on"). The same pill and card as the session's own branch button, but nothing moves here: the pick goes with the
 * start, and the runner puts the folder on it (or starts the new branch from it) once the session is the folder's.
 * `asBase`: picking where a new branch starts, so a branch checked out in another folder is fine to start from.
 */
export function FolderBranchPick({ branches, current, value, onChange, asBase = false }: { branches: FolderBranch[]; /** What the folder is on now. */ current?: string; /** The pick; "" is the folder's own. */ value: string; onChange: (name: string) => void; asBase?: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const shown = value || current || "";
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`branch-pill fcard-branch ${open ? "on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={asBase ? `The new branch starts from ${shown || "the current branch"}` : `The work happens on ${shown || "the current branch"}`}
        aria-label={`${asBase ? "Start from" : "Work on"} branch: ${shown || "current"}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="gitBranch" size={12} />
        <span className="branch-name">{shown || "current branch"}</span>
        <Icon name="chevronsUpDown" size={12} />
      </button>
      {open && <FolderBranchCard branches={branches} current={current} value={shown} asBase={asBase} trigger={btn.current} onPick={(n) => (onChange(n === current ? "" : n), setOpen(false))} onClose={() => setOpen(false)} />}
    </>
  );
}

function FolderBranchCard({ branches, current, value, asBase, trigger, onPick, onClose }: { branches: FolderBranch[]; current?: string; value: string; asBase: boolean; trigger: HTMLElement | null; onPick: (name: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose, trigger);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const typed = q.trim().toLowerCase();
  const hits = branches.filter((b) => !typed || b.name.toLowerCase().includes(typed));
  const here = hits.filter((b) => !b.remote);
  const origin = hits.filter((b) => b.remote);
  // Checked out in another folder: git won't put this one on it too. As the place a new branch starts, it is fine.
  const blocked = (b: FolderBranch) => !asBase && !!b.elsewhere && b.name !== current;
  const pick = (b: FolderBranch) => (blocked(b) ? setErr(`“${b.name}” is checked out in ${b.elsewhere}. Git keeps a branch in one folder at a time: work on it there, or start a new branch from it here.`) : onPick(b.name));
  const row = (b: FolderBranch) => (
    <button
      key={`${b.remote ? "o" : "h"}:${b.name}`}
      type="button"
      className={`branch-row ${b.name === value ? "on" : ""}`}
      aria-disabled={blocked(b) ? true : undefined}
      title={blocked(b) ? `Checked out in ${b.elsewhere}: git keeps a branch in one folder at a time` : b.remote ? `${b.name}, as origin had it when this folder last fetched` : b.name}
      onClick={() => pick(b)}
    >
      <Icon name={b.name === value ? "check" : "gitBranch"} size={13} />
      <span className="branch-name">{b.name}</span>
      {b.name === current && <span className="branch-elsewhere">current</span>}
      {blocked(b) && <span className="branch-elsewhere">in {b.elsewhere!.split(/[\\/]/).filter(Boolean).pop()}</span>}
    </button>
  );
  const place = placeCard(trigger?.getBoundingClientRect(), 300, { want: 360, min: 160, prefer: "below" });
  return createPortal(
    <div ref={ref} className="branch-card surface" role="dialog" aria-label={asBase ? "Start the new branch from" : "Branch to work on"} style={{ ...place, position: "fixed", right: "auto", marginTop: 0 }}>
      <div className="branch-find">
        <Icon name="search" size={13} />
        <input
          autoFocus
          value={q}
          spellCheck={false}
          placeholder="Find a branch"
          aria-label="Find a branch"
          onChange={(e) => (setQ(e.target.value), setErr(""))}
          onKeyDown={(e) => {
            if (e.key === "Escape") return onClose();
            if (e.key !== "Enter") return;
            e.preventDefault();
            const first = [...here, ...origin][0];
            if (first) pick(first);
          }}
        />
      </div>
      <div className="branch-list">
        {err && <p role="alert" className="error small branch-note">{err}</p>}
        {here.map(row)}
        {origin.length > 0 && <p className="muted small branch-head">On origin</p>}
        {origin.map(row)}
        {!hits.length && <p className="muted small branch-note">No branch matches “{q.trim()}”.</p>}
      </div>
      <p className="branch-foot muted small">{asBase ? "The new branch starts from this one." : "The folder moves to this branch as the session starts. A folder with uncommitted changes stays where it is."}</p>
    </div>,
    document.body,
  );
}
