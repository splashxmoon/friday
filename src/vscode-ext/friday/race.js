"use strict";
// Race in Code (Arun, 2026-11-19, wave 2: "Race the tools: the same ask to two or three coding tools at once, compare, keep the
// best"): each racer works in a checkout of its own, outside the folder the IDE has open. "Compare" in the chat column asks for Review
// changes on that checkout: its repository is opened beside the folder's, and its changes are read against the branch it forked from.
const path = require("node:path");

/** What the request may carry (the runner has cleaned it, but the file is only a file): a folder, a base branch, a tab's name. */
function reviewArgOf(v) {
  if (!v || typeof v !== "object" || typeof v.dir !== "string" || !v.dir || !path.isAbsolute(v.dir)) return null;
  return {
    dir: v.dir,
    base: typeof v.base === "string" ? v.base : "",
    label: typeof v.label === "string" ? v.label : "",
    // The session's own pull request: its branch, and that only its base will do (no fallback branch stands in for it).
    ...(typeof v.head === "string" && v.head ? { head: v.head } : {}),
    ...(v.strict === true ? { strict: true } : {}),
  };
}

/**
 * The repository a review opens on: the racer's checkout when one is named (opened if git has not met it; a checkout outside the
 * workspace is not among api.repositories), else the folder's own. Null when there is none.
 */
async function repoFor(vscode, api, arg) {
  const racer = reviewArgOf(arg);
  // A folder was named but cannot be used: none, not the workspace's own (that would show the wrong diff as if it were the racer's).
  if (!racer) return arg === undefined || arg === null ? api.repositories[0] || null : null;
  const uri = vscode.Uri.file(racer.dir);
  const same = (r) => path.resolve(r.rootUri.fsPath) === path.resolve(racer.dir);
  const known = api.repositories.find(same);
  if (known) return known;
  if (typeof api.openRepository !== "function") return null;
  try {
    return (await api.openRepository(uri)) || null;
  } catch {
    return null;
  }
}

/** The branches to compare against, the racer's fork point first (the folder's branch is in the same repository), then the usual. */
function baseCandidates(arg) {
  const racer = reviewArgOf(arg);
  if (racer && racer.strict && racer.base) return [racer.base];
  return [...(racer && racer.base ? [racer.base] : []), "origin/HEAD", "origin/main", "origin/master", "main", "master"];
}

/** The diff's tab: "Race · Claude Code" for a racer (the IDE adds "(2 files)" itself), "<branch> · 2 files" as ever for the folder's own. */
function reviewTitle(arg, head, n) {
  const racer = reviewArgOf(arg);
  if (racer && racer.label) return racer.label;
  return `${head || "This branch"} · ${n} file${n === 1 ? "" : "s"}`;
}

/** What a git status code of the IDE's git says about a file: "added" (new in this change), "deleted", or "" for the rest. */
function sideOf(status) {
  if (status === 1 || status === 7 || status === 9) return "added"; // INDEX_ADDED, UNTRACKED, INTENT_TO_ADD
  if (status === 2 || status === 6) return "deleted"; // INDEX_DELETED, DELETED
  return "";
}

module.exports = { sideOf, reviewArgOf, repoFor, baseCandidates, reviewTitle };
