import { FolderGit2Icon, FolderIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FolderInfo } from "../runner/workspace.js";
import type { FolderBranch } from "./Branches.js";
import { spareBranch } from "./branch-names.js";
import { Icon } from "./icons.js";
import type { Identity } from "./storage.js";
import { placeCard, useDismiss } from "./ui.js";
import { folderName, useExtraDirs } from "./Workspace.js";

/**
 * The box's folder pill, and the menu it opens (Arun, 2026-11-04, design A of three: everything in the box's footer, "also make
 * sure you can select existing branches too"). One place for where the work happens, in the order it is decided:
 *  - Works in: the folder, the other folders it may work in (each with its ×), and adding one.
 *  - Branch, for a repository: its branches to work on (the folder's own first, the rest found by typing when there are many,
 *    origin's only then), or a new branch from the one chosen, named in the field under it.
 *  - Change folder…, the picker it had before.
 * The pill says the folder, then the branch when it isn't the folder's own, then how many other folders: "hi-15 · new branch +1".
 */

export interface BranchChoice {
  /** The repository's branches, when they can be picked; without them only the one it lands on is offered. */
  branches: FolderBranch[] | null;
  /** The branch the folder is on now. */
  current?: string;
  /** Where the work lands without a new branch: the conversation's or the pull request's branch, the one picked, or the folder's. */
  lands?: string;
  /** Picked by somebody: "" is the folder's own. As the base of a new branch too. */
  pick: string;
  onPick: (name: string) => void;
  newBranch: boolean;
  onNew: (on: boolean) => void;
  name: string;
  onName: (name: string) => void;
  suggestion: string;
  /** A pull request's own branch: the work goes there, nothing to choose. */
  fixed?: string;
}

/** Past this many of its own branches, the list is found by typing instead of shown whole. */
const SHOWN = 6;

export function FolderPill({ identity, folder, dirs, onDirs, branch, onChangeFolder }: { identity: Identity; folder: FolderInfo; dirs: string[] | null; onDirs: (d: string[]) => void; branch: BranchChoice | null; onChangeFolder: (from: HTMLElement) => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const extra = useExtraDirs(identity, folder.path, dirs, onDirs);
  const on = branch && !branch.fixed ? (branch.newBranch ? "new branch" : branch.pick && branch.pick !== branch.current ? branch.pick : "") : "";
  const more = extra.dirs.length;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`menu-pill agent-pill cw-drop cw-folder${open ? " on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Folder: ${folderName(folder)}${on ? `, ${on}` : ""}${more ? `, and ${more} more` : ""}. Change where it works`}
        title={folder.path}
        onClick={() => setOpen((v) => !v)}
      >
        {folder.isRepo ? <FolderGit2Icon className="size-3.5 shrink-0" /> : <FolderIcon className="size-3.5 shrink-0" />}
        <span className="cw-drop-text">{folderName(folder)}</span>
        {on && <span className="cw-drop-sub">· {on}</span>}
        {more > 0 && <span className="cw-drop-sub">+{more}</span>}
        <Icon name="chevronDown" size={12} className="menu-pill-caret" />
      </button>
      {open && <FolderMenuCard folder={folder} extra={extra} branch={branch} trigger={btn.current} onChangeFolder={() => (setOpen(false), btn.current && onChangeFolder(btn.current))} onClose={() => setOpen(false)} />}
    </>
  );
}

function FolderMenuCard({ folder, extra, branch, trigger, onChangeFolder, onClose }: { folder: FolderInfo; extra: ReturnType<typeof useExtraDirs>; branch: BranchChoice | null; trigger: HTMLElement | null; onChangeFolder: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose, trigger);
  const desktop = typeof window !== "undefined" ? window.fridayDesktop : undefined;
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const nameField = useRef<HTMLInputElement>(null);
  // The name field takes the keys once a new branch is chosen here, not as the menu opens: focused then, it scrolled the menu
  // down to itself and hid the folder rows at its top.
  const wasNew = useRef(branch?.newBranch);
  useEffect(() => {
    if (branch?.newBranch && !wasNew.current) nameField.current?.focus({ preventScroll: true });
    wasNew.current = branch?.newBranch;
  }, [branch?.newBranch]);
  const addFolder = async (p: string) => {
    if (await extra.add(p)) (setPath(""), setTyping(false));
  };
  const leaf = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

  // The branches: its own, the folder's first; origin's only when typed for; all of them found by typing past SHOWN.
  // Never Friday's spare branches, kept ready for new sessions (audit CODE-16 A); the folder's own, whatever it is.
  const all = branch?.branches ? branch.branches.filter((b) => !spareBranch(b.name) || b.name === branch.current) : null;
  const typed = q.trim().toLowerCase();
  const local = (all ?? []).filter((b) => !b.remote);
  // The folder's own first, then the ones it can move to, then those checked out in another folder (only a base for a new one).
  const ordered = [...local.filter((b) => b.name === branch?.current), ...local.filter((b) => b.name !== branch?.current && !b.elsewhere), ...local.filter((b) => b.name !== branch?.current && !!b.elsewhere)];
  const finding = !!all && all.length > SHOWN;
  const hits = typed ? (all ?? []).filter((b) => b.name.toLowerCase().includes(typed)) : ordered.slice(0, SHOWN);
  const chosen = branch ? branch.pick || branch.current || branch.lands || "" : "";
  const base = chosen || "the current branch";
  // Checked out in another folder: git won't put this one on it too. As the place a new branch starts, it is fine.
  const blocked = (b: FolderBranch) => !!b.elsewhere && b.name !== branch?.current;
  const workOn = (b: FolderBranch) => {
    if (!branch) return;
    if (blocked(b)) return setErr(`“${b.name}” is checked out in ${leaf(b.elsewhere!)}. Git keeps a branch in one folder at a time: work on it there, or start a new branch from it here.`);
    setErr("");
    branch.onPick(b.name === branch.current ? "" : b.name);
    branch.onNew(false);
  };

  const place = placeCard(trigger?.getBoundingClientRect(), 300, { want: 320, min: 200, prefer: "above" });
  return createPortal(
    <div ref={ref} className="fmenu surface" role="dialog" aria-label="Where it works" style={{ ...place, position: "fixed", right: "auto" }} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())}>
      <div className="fmenu-scroll">
        <p className="fmenu-head">Works in</p>
        <div className="fmenu-row on" title={folder.path}>
          {folder.isRepo ? <FolderGit2Icon className="size-3.5 shrink-0" /> : <FolderIcon className="size-3.5 shrink-0" />}
          <span className="fmenu-name">{folderName(folder)}</span>
          <Icon name="check" size={13} className="fmenu-check" />
        </div>
        {extra.dirs.map((d) => (
          <div key={d} className="fmenu-row" title={d}>
            <FolderIcon className="size-3.5 shrink-0" />
            <span className="fmenu-name">{leaf(d)}</span>
            <button type="button" className="fmenu-x" aria-label={`Stop working in ${leaf(d)}`} onClick={() => extra.remove(d)}>
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
        {typing ? (
          <div className="fmenu-field">
            <input
              autoFocus
              value={path}
              placeholder="Path to another folder"
              spellCheck={false}
              aria-label="Another folder it may work in"
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.preventDefault(), void addFolder(path));
                else if (e.key === "Escape") (e.stopPropagation(), setTyping(false), setPath(""));
              }}
            />
          </div>
        ) : (
          extra.dirs.length < 8 && (
            <button
              type="button"
              className="fmenu-row"
              onClick={async () => {
                // The desktop app's own folder chooser; in a browser the path is typed.
                if (!desktop) return setTyping(true);
                const p = await desktop.pickFolder();
                if (p) await addFolder(p);
              }}
            >
              <Icon name="plus" size={13} />
              <span className="fmenu-name">Add another folder</span>
            </button>
          )
        )}
        {extra.err && <p role="alert" className="fmenu-err">{extra.err}</p>}

        {branch && folder.isRepo && (
          <>
            <hr />
            <p className="fmenu-head">Branch</p>
            {branch.fixed ? (
              <div className="fmenu-row on" title="The pull request's own branch">
                <Icon name="gitBranch" size={13} />
                <span className="fmenu-name mono">{branch.fixed}</span>
                <span className="fmenu-note">the pull request's</span>
              </div>
            ) : (
              <>
                {finding && (
                  <div className="fmenu-find">
                    <Icon name="search" size={13} />
                    <input value={q} spellCheck={false} placeholder={`Find a branch (${all!.length})`} aria-label="Find a branch" onChange={(e) => (setQ(e.target.value), setErr(""))} />
                  </div>
                )}
                {all
                  ? hits.map((b) => {
                      const sel = !branch.newBranch && b.name === chosen;
                      return (
                        <button key={`${b.remote ? "o" : "h"}:${b.name}`} type="button" className={`fmenu-row${sel ? " on" : ""}`} aria-pressed={sel} aria-disabled={blocked(b) || undefined} title={blocked(b) ? `Checked out in ${b.elsewhere}: git keeps a branch in one folder at a time` : b.remote ? `${b.name}, as origin had it when this folder last fetched` : `Work on ${b.name}`} onClick={() => workOn(b)}>
                          <Icon name="gitBranch" size={13} />
                          <span className="fmenu-name mono">{b.name}</span>
                          {b.name === branch.current && <span className="fmenu-note">current</span>}
                          {b.remote && <span className="fmenu-note">origin</span>}
                          {blocked(b) && <span className="fmenu-note">in {leaf(b.elsewhere!)}</span>}
                          {sel && <Icon name="check" size={13} className="fmenu-check" />}
                        </button>
                      );
                    })
                  : (
                    <button type="button" className={`fmenu-row${branch.newBranch ? "" : " on"}`} aria-pressed={!branch.newBranch} onClick={() => branch.onNew(false)}>
                      <Icon name="gitBranch" size={13} />
                      <span className="fmenu-name">
                        Work on <span className="mono">{branch.lands || "its branch"}</span>
                      </span>
                      {!branch.newBranch && <Icon name="check" size={13} className="fmenu-check" />}
                    </button>
                  )}
                {all && typed && !hits.length && <p className="fmenu-note-line">No branch matches “{q.trim()}”.</p>}
                {all && !typed && finding && local.length > SHOWN && <p className="fmenu-note-line">{local.length - SHOWN} more: type to find one.</p>}
                <button type="button" className={`fmenu-row${branch.newBranch ? " on" : ""}`} aria-pressed={branch.newBranch} onClick={() => (setErr(""), branch.onNew(true))}>
                  <Icon name="plus" size={13} />
                  <span className="fmenu-name">
                    New branch from <span className="mono">{base}</span>
                  </span>
                  {branch.newBranch && <Icon name="check" size={13} className="fmenu-check" />}
                </button>
                {branch.newBranch && (
                  <div className="fmenu-field">
                    <input ref={nameField} className="mono" value={branch.name} placeholder={branch.suggestion} spellCheck={false} aria-label="New branch name" title="Leave it empty to use the suggested name" onChange={(e) => branch.onName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), onClose())} />
                  </div>
                )}
                {err && <p role="alert" className="fmenu-err">{err}</p>}
              </>
            )}
          </>
        )}
      </div>
      <div className="fmenu-foot">
        <button type="button" className="fmenu-row" onClick={onChangeFolder}>
          <Icon name="folderOpen" size={13} />
          <span className="fmenu-name">Change folder…</span>
        </button>
      </div>
    </div>,
    document.body,
  );
}
