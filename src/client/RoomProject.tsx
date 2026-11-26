import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon, FolderGit2Icon, FolderIcon, GitBranchIcon, XIcon } from "lucide-react";
import { BranchPicker, RepoPicker, type RepoChoice } from "./Workspace.js";
import { api } from "./api.js";
import type { Identity } from "./storage.js";
import { folderName, isFolderPath, repoKey, type MemberRepo, type RoomProject } from "../room-project.js";
import { projectText } from "./room-project-text.js";
import "./room-project.css";

/**
 * A room's Project (splashxmoon/friday-code#24): the repo its work is on, and the branch that work starts from. Chosen in the folder
 * picker refined for repos (Workspace.tsx RepoPicker): the crew's repos, this computer's, GitHub's, an address typed as it is, or a
 * folder whose remote names it. Any address is taken, since a new room, or another computer, may not have the repo yet. Or a folder
 * itself (Arun, 2026-11-17: "also add support for folders too"): the crew on this computer works in it as it is, with no branch.
 */

export type RepoSuggestion = { repo: string; name: string; folders: { path: string; who: string }[] };
export type ProjectMember = { id: string; name: string; repo?: MemberRepo };

/** The repos found in the crew's folders on this computer, once per field. */
export function useRepoSuggestions(identity: Identity): RepoSuggestion[] {
  const [list, setList] = useState<RepoSuggestion[]>([]);
  useEffect(() => {
    let live = true;
    api<{ repos: RepoSuggestion[] }>(identity, "/api/teammates/repos")
      .then((r) => live && setList(r.repos ?? []))
      .catch(() => undefined);
    return () => void (live = false);
  }, [identity]);
  return list;
}

/** A repo as it is shown: owner/repo, and its host when it isn't GitHub. A folder by its last part. */
function shown(repo: string): { name: string; host: string; folder?: true } {
  if (isFolderPath(repo)) return { name: folderName(repo), host: "", folder: true };
  const k = repoKey(repo);
  if (!k) return { name: repo, host: "" };
  const [host, ...rest] = (/^https?:\/\//i.test(repo) ? repo.replace(/^https?:\/\//i, "").replace(/\.git$/i, "") : k).split("/");
  return { name: rest.join("/") || repo, host: host!.toLowerCase() === "github.com" ? "" : host! };
}

/**
 * The repo picker, opened from `from`: an address is used as it is; a folder is read for its remote first (nothing stored or
 * cloned), and is the project itself when it has none, or when it was picked as a folder. `card` is the picker to render while
 * open; `current` is marked in it.
 */
export function useRepoPicker(identity: Identity, onRepo: (repo: string) => void, current?: string): { open: (from: HTMLElement | null) => void; card: ReactNode; err: string; clear: () => void } {
  const crew = useRepoSuggestions(identity);
  const [at, setAt] = useState<HTMLElement | null>(null);
  const [err, setErr] = useState("");
  const choose = async (c: RepoChoice) => {
    setErr("");
    if ("repo" in c) return onRepo(c.repo);
    if ("folder" in c) return onRepo(c.folder);
    try {
      const r = await api<{ project: RoomProject }>(identity, "/api/teammates/repo-of", { method: "POST", body: JSON.stringify({ dir: c.dir, ...(c.orFolder ? { folder: true } : {}) }), headers: { "Content-Type": "application/json" } });
      onRepo(r.project.repo);
    } catch (e) {
      setErr((e as Error).message || "Couldn't read that folder's repo.");
    }
  };
  const card = at ? <RepoPicker identity={identity} trigger={at} crew={crew} {...(current ? { current } : {})} onPick={(c) => void choose(c)} onClose={() => setAt(null)} /> : null;
  return { open: (from) => (setErr(""), setAt(from)), card, err, clear: () => setErr("") };
}

/** The branch picker for `repo`, opened from `from`: "" picked is the repo's default. `card` is the picker to render while open. */
function useBranchPicker(identity: Identity, repo: string, current: string, onBranch: (b: string) => void): { open: (from: HTMLElement | null) => void; card: ReactNode } {
  const [at, setAt] = useState<HTMLElement | null>(null);
  const card = at && repo ? <BranchPicker identity={identity} trigger={at} repo={repo} current={current} onPick={onBranch} onClose={() => setAt(null)} /> : null;
  return { open: setAt, card };
}

/** The room dialog's Project field: the repo, chosen in the picker, and the branch beside it. The dialog never changes height. */
export function ProjectField({ identity, repo, branch, onRepo, onBranch, err }: { identity: Identity; repo: string; branch: string; onRepo: (v: string) => void; onBranch: (v: string) => void; err?: string }) {
  const btn = useRef<HTMLButtonElement>(null);
  const branchBtn = useRef<HTMLButtonElement>(null);
  // A repo picked again keeps its branch only when it is the same repo.
  const picker = useRepoPicker(identity, (r) => (repoKey(r) !== repoKey(repo) && onBranch(""), onRepo(projectText({ repo: r }))), repo.trim() || undefined);
  const branches = useBranchPicker(identity, repo.trim(), branch, onBranch);
  const problem = err || picker.err;
  const s = repo.trim() ? shown(/^[\w.-]+\/[\w.-]+$/.test(repo.trim()) ? `https://github.com/${repo.trim()}` : repo.trim()) : null;
  const Lead = s?.folder ? FolderIcon : FolderGit2Icon;
  return (
    <div className="tm-field rpj">
      <span id="rpj-label">
        Project <em className="rpj-opt">Optional</em>
      </span>
      <div className="rpj-inputs" role="group" aria-labelledby="rpj-label">
        <div className="rpj-repo-box">
          <button ref={btn} type="button" className={`rpj-trigger${s ? " set" : ""}`} title={s?.folder ? repo.trim() : undefined} aria-haspopup="dialog" aria-invalid={!!problem} aria-describedby={problem ? "rpj-err" : undefined} onClick={() => picker.open(btn.current)}>
            <Lead className="rpj-lead" aria-hidden="true" />
            <span className="rpj-trigger-text">{s ? s.name : "Choose a repo or folder…"}</span>
            {(s?.host || s?.folder) && <span className="rpj-trigger-host">{s.folder ? "Folder" : s.host}</span>}
            {!s && <ChevronDownIcon className="rpj-chev" aria-hidden="true" />}
          </button>
          {s && (
            <button type="button" className="rpj-clear" aria-label="No project" title="No project" onClick={() => (onRepo(""), onBranch(""), picker.clear())}>
              <XIcon aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="rpj-branch-box">
          <button ref={branchBtn} type="button" className={`rpj-trigger${branch ? " set" : ""}`} aria-haspopup="dialog" aria-label={s?.folder ? "No branch: the crew works in the folder as it is" : `Branch: ${branch || "the repo's default"}`} title={s?.folder ? "A folder has no branch: the crew works in it as it is" : undefined} disabled={!s || s.folder} onClick={() => branches.open(branchBtn.current)}>
            <GitBranchIcon className="rpj-lead" aria-hidden="true" />
            <span className="rpj-trigger-text">{s?.folder ? "No branch" : branch || "Default"}</span>
            {!branch && !s?.folder && <ChevronDownIcon className="rpj-chev" aria-hidden="true" />}
          </button>
          {branch && (
            <button type="button" className="rpj-clear" aria-label="The repo's default branch" title="Back to the repo's default branch" onClick={() => onBranch("")}>
              <XIcon aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {picker.card}
      {branches.card}
      {problem && (
        <span id="rpj-err" role="alert" className="tm-err">
          {problem}
        </span>
      )}
    </div>
  );
}

/**
 * The room profile's Project, as rows like its Folders (Arun, 2026-11-17: "redesign this better"): set, the repo (pressed, the
 * picker to change it; its ×, No project) and its branch changed in place; not set, one row that opens the picker. Each change saves
 * as it is made: there's no Save to press.
 */
export function ProjectRows({ identity, project, onSave }: { identity: Identity; project: RoomProject | null; /** Saves it (null: No project); an error to show, or null. */ onSave: (p: { repo: string; branch?: string } | null) => Promise<string | null> }) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const row = useRef<HTMLButtonElement>(null);
  const branchRow = useRef<HTMLButtonElement>(null);
  const save = async (p: { repo: string; branch?: string } | null) => {
    setBusy(true);
    setErr("");
    const e = await onSave(p);
    setBusy(false);
    if (e) setErr(e);
  };
  // A repo picked: the branch goes with it only when it is the same repo again.
  const picker = useRepoPicker(identity, (repo) => void save({ repo, ...(project && repoKey(project.repo) === repoKey(repo) && project.branch ? { branch: project.branch } : {}) }), project?.repo);
  const problem = err || picker.err;
  const branches = useBranchPicker(identity, project?.repo ?? "", project?.branch ?? "", (b) => project && b !== (project.branch ?? "") && void save({ repo: project.repo, ...(b ? { branch: b } : {}) }));
  const s = project ? shown(project.repo) : null;
  const Lead = s?.folder ? FolderIcon : FolderGit2Icon;
  return (
    <div className="msd-group rpj-rows" aria-busy={busy}>
      <h3 className="msd-group-name">Project</h3>
      <ul className="msd-rows">
        {project && s ? (
          <>
            <li className="rf-own rpj-set">
              <button ref={row} type="button" className="msd-row" disabled={busy} title={`${project.repo}\nChoose another repo or folder`} aria-haspopup="dialog" onClick={() => picker.open(row.current)}>
                <span className="msd-row-icon" aria-hidden="true">
                  <Lead />
                </span>
                <span className="msd-row-label rpj-name">{s.name}</span>
                <span className="msd-row-now">{s.folder ? "Folder" : s.host || "GitHub"}</span>
                <ChevronDownIcon className="msd-row-chev" aria-hidden="true" />
              </button>
              <button type="button" className="rf-x" aria-label="Take the project off this room" title="No project" onClick={() => void save(null)}>
                <XIcon aria-hidden="true" />
              </button>
            </li>
            {!s.folder && <li className="rf-own">
              <button ref={branchRow} type="button" className="msd-row" disabled={busy} aria-haspopup="dialog" onClick={() => branches.open(branchRow.current)}>
                <span className="msd-row-icon" aria-hidden="true">
                  <GitBranchIcon />
                </span>
                <span className="msd-row-label">Branch</span>
                <span className={`msd-row-now${project.branch ? " rpj-branch-now" : ""}`}>{project.branch || "Repo's default"}</span>
                <ChevronDownIcon className="msd-row-chev" aria-hidden="true" />
              </button>
              {project.branch && (
                <button type="button" className="rf-x" aria-label="Back to the repo's default branch" title="Back to the repo's default branch" onClick={() => void save({ repo: project.repo })}>
                  <XIcon aria-hidden="true" />
                </button>
              )}
            </li>}
          </>
        ) : (
          <li>
            <button ref={row} type="button" className="msd-row rp-add" disabled={busy} aria-haspopup="dialog" onClick={() => picker.open(row.current)}>
              <span className="msd-row-icon" aria-hidden="true">
                <FolderGit2Icon />
              </span>
              <span className="msd-row-label">Choose the repo or folder</span>
              <span className="msd-row-now">No project</span>
              <ChevronDownIcon className="msd-row-chev" aria-hidden="true" />
            </button>
          </li>
        )}
      </ul>
      {picker.card}
      {branches.card}
      {problem ? (
        <small className="rf-note msd-err" role="alert">
          {problem}
        </small>
      ) : (
        <small className="rf-note">{s?.folder ? "The crew on this computer works in this folder itself, as it is: no copy, no branch." : `${project ? "" : "The repo or folder this room's work is on. "}Each crew mate works in its own copy of a repo: nothing is cloned, and no one's branch is switched.`}</small>
      )}
    </div>
  );
}
