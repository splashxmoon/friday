/**
 * Code, Friday's built-in IDE (Arun, 2026-11-19: "I want to add an actual ide within Friday, like devin has... everything that
 * VScode and devin have... make it a toggle for switching back and forth with our current ADE to the IDE", mocked in
 * ~/Desktop/Friday Work HQ/product/designs/2026-11-19-ide and approved: "Yes, build it").
 *
 * The contract between the page (src/client/ide/*) and this computer's runner (src/runner/ide.ts, src/runner/ide-git.ts),
 * shared by both sides. Every op is called from the page as `hostApi(identity, "/api/runner/ide.<name>", { method: "POST",
 * body: JSON.stringify(params) })` and dispatched by src/runner/ide-ops.ts. Every op takes `root`: the absolute path of the
 * folder the IDE has open (a session's folder, or one the person opened). Every `path` is relative to it, with "/" separators,
 * and never leaves it.
 */

/** What the runner says when the folder is not there, kept in one place: the page's restore check tells a missing folder from a runner that isn't answering by it. */
export const IDE_FOLDER_MISSING = "The folder does not exist";
export const IDE_FOLDER_GONE = "The folder is gone";
export const isFolderMissing = (message: string): boolean => message.startsWith(IDE_FOLDER_MISSING) || message.startsWith(IDE_FOLDER_GONE);

/** A file or folder in a listing. */
export interface IdeEntry {
  name: string;
  /** Relative to root, "/"-separated. */
  path: string;
  kind: "file" | "dir" | "link";
  size: number;
  /** Ignored by git (.gitignore): shown dimmed, and left out of quick open and search. */
  ignored: boolean;
  /** A symbolic link. `kind` is then what it points to ("dir" or "file") when that is inside the folder, or "link" when it leads nowhere or outside. */
  link?: boolean;
}

export interface IdeListParams { root: string; dir: string }
/** `truncated`: the folder has more than 5000 entries and only the first are listed. */
export interface IdeListResult { entries: IdeEntry[]; truncated?: boolean }
/** Several folders in one call (the tree re-listing what is open after a change), a few at a time. A folder that can't be listed is left out of `results`. */
export interface IdeListManyParams { root: string; dirs: string[] }
export interface IdeListManyResult { results: Record<string, IdeListResult> }

export interface IdeReadParams { root: string; path: string }
export interface IdeReadResult {
  /** The text, "" when binary or too big. */
  text: string;
  /** Not text: shown as "binary file" (or an image preview by the page when it is one). */
  binary: boolean;
  /** Over 5 MB: not opened. */
  tooBig: boolean;
  size: number;
  /** Modified time in ms: sent back with a write so a change made meanwhile (an agent's) isn't overwritten. */
  mtime: number;
  /** The file's line endings, kept on save (the most common one when the file mixes them). */
  eol: "lf" | "crlf";
  /** The file mixes line endings: on save each line keeps its own, so a one-line edit stays a one-line diff. */
  mixedEol?: boolean;
  /** "utf8", or "latin1" when the bytes are not valid UTF-8: the file is shown as Latin-1 (every byte one character) and saved byte for byte, so nothing is corrupted. Send it back with write. Missing means "utf8". */
  encoding?: "utf8" | "latin1";
}

export interface IdeWriteParams {
  root: string;
  path: string;
  text: string;
  /** The mtime it was read at; omitted to write regardless. */
  mtime?: number;
  /** The size it was read at: with `mtime`, catches a change made in the same clock tick on disks with coarse timestamps. */
  size?: number;
  eol?: "lf" | "crlf";
  /** What read said. "latin1" refuses text with characters outside Latin-1 instead of damaging the file. */
  encoding?: "utf8" | "latin1";
}
/** `conflict`: the file changed on disk since `mtime`; nothing was written. */
export interface IdeWriteResult { mtime: number; size?: number; conflict?: boolean }

export interface IdeCreateParams { root: string; path: string; kind: "file" | "dir" }
export interface IdeRenameParams { root: string; from: string; to: string }
/** Deleted things go to Friday's trash folder (~/.friday/trash/ide/...), never gone for good. */
export interface IdeDeleteParams { root: string; path: string }
export interface IdeOkResult { ok: true; trashed?: string }

/** Every file under root for quick open (⌘P): git's files and untracked ones not ignored, 50 000 at most. */
export interface IdeFilesParams { root: string }
export interface IdeFilesResult { files: string[]; truncated: boolean }

/** Modified times, to notice files changed on disk (by an agent, a formatter, git) while they're open. */
export interface IdeStatsParams { root: string; paths: string[] }
export interface IdeStatsResult { stats: Record<string, { mtime: number; size: number } | null> }

export interface IdeSearchParams {
  root: string;
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  /** Globs, comma-separated: "src/**, *.ts". */
  include?: string;
  exclude?: string;
  /** 2000 matches at most by default. */
  max?: number;
}
export interface IdeSearchMatch { line: number; /** 0-based column of the match start, in the line. */ col: number; length: number; /** The line's text, 400 chars at most. */ text: string }
export interface IdeSearchFile { path: string; matches: IdeSearchMatch[] }
/** `truncated`: stopped at the match cap or at the time limit. `cancelled`: a newer search of the same folder replaced this one; its result is empty and to be ignored. */
export interface IdeSearchResult { files: IdeSearchFile[]; total: number; truncated: boolean; cancelled?: boolean }

/**
 * Replace every match of a search in the given files (every file the search covers when `paths` is omitted: pass the paths of
 * the shown results when the search was cut at its cap, or more will change than the person saw).
 * Each file is copied to the trash folder before it is rewritten.
 */
export interface IdeReplaceParams extends IdeSearchParams {
  replacement: string;
  paths?: string[];
  /** Files to leave alone (the ones with unsaved edits in the editor). */
  skipPaths?: string[];
}
export interface IdeReplaceResult {
  files: number;
  replaced: number;
  /** The folder holding the originals of every rewritten file. */
  trashed?: string;
  /** Files that were not rewritten, and why ("not UTF-8", "changed on disk", an error). Everything else was. */
  failed?: { path: string; reason: string }[];
  /** The time limit hit before every file was done. */
  truncated?: boolean;
}

// ── Git (src/runner/ide-git.ts) ─────────────────────────────────────────────────

export type IdeGitCode = "M" | "A" | "D" | "R" | "U" | "?" | "C";
export interface IdeGitFile {
  path: string;
  /** For a rename: where it came from. */
  from?: string;
  /** Staged change, if any. */
  index: IdeGitCode | null;
  /** Unstaged change, if any ("?" untracked, "U" conflicted). */
  work: IdeGitCode | null;
}
/** `untracked: "normal"` lists an untracked folder as one entry ("dir/") instead of every file in it: the cheap form for polling a big repository. */
export interface IdeGitStatusParams { root: string; untracked?: "all" | "normal" }
export interface IdeGitStatusResult {
  /** Not a repository: the source control view says so and offers to make one. */
  repo: boolean;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: IdeGitFile[];
}

/** Both sides of a file's change: HEAD (or the index, for an unstaged change of a staged file) and now. */
export interface IdeGitDiffParams { root: string; path: string; staged?: boolean }
export interface IdeGitDiffResult { original: string; modified: string; binary: boolean }

export interface IdeGitPathsParams { root: string; paths: string[] }
export interface IdeGitCommitParams { root: string; message: string; /** Stage everything changed first, as VS Code does when nothing is staged. */ all?: boolean }
export interface IdeGitCommitResult { sha: string }
// A commit takes only what is staged under `root`; when staged changes exist elsewhere in the repository it refuses and says so.
export interface IdeGitBranchesParams { root: string }
export interface IdeGitBranchesResult { current: string; local: string[]; remote: string[] }
export interface IdeGitCheckoutParams { root: string; branch: string; create?: boolean }
export interface IdeGitSyncParams { root: string; /** push, pull, or fetch */ action: "push" | "pull" | "fetch" }
export interface IdeGitSyncResult { ok: true; output: string }
/** One file's last commits, for the Timeline view. */
export interface IdeGitLogParams { root: string; path?: string; max?: number }
export interface IdeGitLogResult { commits: { sha: string; subject: string; author: string; at: number }[] }

/** Every op the page may call, by name (after "ide."), with its params and result. */
export interface IdeOps {
  list: [IdeListParams, IdeListResult];
  listMany: [IdeListManyParams, IdeListManyResult];
  read: [IdeReadParams, IdeReadResult];
  write: [IdeWriteParams, IdeWriteResult];
  create: [IdeCreateParams, IdeOkResult];
  rename: [IdeRenameParams, IdeOkResult];
  delete: [IdeDeleteParams, IdeOkResult];
  files: [IdeFilesParams, IdeFilesResult];
  stats: [IdeStatsParams, IdeStatsResult];
  search: [IdeSearchParams, IdeSearchResult];
  replace: [IdeReplaceParams, IdeReplaceResult];
  "git.status": [IdeGitStatusParams, IdeGitStatusResult];
  "git.diff": [IdeGitDiffParams, IdeGitDiffResult];
  "git.stage": [IdeGitPathsParams, IdeOkResult];
  "git.unstage": [IdeGitPathsParams, IdeOkResult];
  /** Throws away unstaged changes to tracked files (asked first on the page); the working copy of each file, tracked or not, goes to the trash first (`trashed`). */
  "git.discard": [IdeGitPathsParams, IdeOkResult];
  "git.commit": [IdeGitCommitParams, IdeGitCommitResult];
  "git.branches": [IdeGitBranchesParams, IdeGitBranchesResult];
  "git.checkout": [IdeGitCheckoutParams, IdeOkResult];
  "git.sync": [IdeGitSyncParams, IdeGitSyncResult];
  "git.log": [IdeGitLogParams, IdeGitLogResult];
  "git.init": [IdeGitStatusParams, IdeOkResult];
}
export type IdeOpName = keyof IdeOps;
