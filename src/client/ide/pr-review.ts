import { hostApi } from "../local.js";
import type { Identity } from "../storage.js";
import type { EngineTool } from "../../types.js";
import { sameFolder } from "./code-chats.js";
import { joinPath } from "../openIn.js";
import { getIdeRoot, getMode, openInCode, setIdeRoot, setMode } from "./mode.js";

/**
 * "Review in the IDE" (Arun, 2026-11-19, wave 3: "Review your teammates' pull requests in the IDE: their branch checked out on the side,
 * the diff in the editor, comments where the lines are, and an agent's first pass"). From Code Review, and from a Needs you row that
 * asks for a review: the runner checks the pull request's head out in a copy of its own (never over the person's checkout), Code opens
 * that copy as its folder, and once the IDE has drawn on it, asks it for the multi-file diff of the pull request (VsCodeView takes
 * `takePrReviewWanted`). The comments, the agent's first pass and Submit review are the IDE's own (extension pr-review.js).
 */

export interface PrToReview {
  url: string;
  title?: string;
}

interface Opened {
  dir: string;
  base: string;
  label: string;
}

/** What the IDE is to open once it has drawn on `root`: the diff of the pull request's checkout against its base. */
let wanted: { root: string; base: string; label: string; head?: string; strict?: boolean; at: number } | null = null;
const FOR_MS = 60_000;
const EVENT = "friday:pr-review";

export const takePrReviewWanted = (root: string): { dir: string; base: string; label: string; head?: string; strict?: boolean } | null => {
  const w = wanted;
  if (!w) return null;
  if (Date.now() - w.at > FOR_MS) {
    wanted = null;
    return null;
  }
  if (!sameFolder(w.root, root)) return null;
  wanted = null;
  return { dir: w.root, base: w.base, label: w.label, ...(w.head ? { head: w.head } : {}), ...(w.strict ? { strict: true } : {}) };
};

/** Check the pull request out and open it in Code. Rejects with the reason (no copy of the repository here, no `gh`, not signed in). */
export async function reviewInIde(identity: Identity, pr: PrToReview, tool?: EngineTool): Promise<void> {
  const opened = await hostApi<Opened>(identity, "/api/runner/pr.ide", {
    method: "POST",
    body: JSON.stringify({ url: pr.url, title: pr.title ?? "", ...(getIdeRoot() ? { folder: getIdeRoot() } : {}), ...(tool ? { tool } : {}) }),
  });
  wanted = { root: opened.dir, base: opened.base, label: opened.label, at: Date.now() };
  setIdeRoot(opened.dir);
  setMode("code");
  // Already on that folder (a second look): the frame is there to ask.
  window.dispatchEvent(new Event(EVENT));
}

export const PR_REVIEW_EVENT = EVENT;

/**
 * "Review in the IDE" on the session's own pull request (Arun, 2026-11-20, Code and Agents wired together: "Review in the IDE from
 * anywhere"): its folder already is the pull request's branch, so nothing is checked out. Code opens on that folder with the session
 * as a linked tab, and once the IDE has drawn on it, the diff of the branch against the pull request's base opens (the same
 * multi-file diff as a teammate's pull request, VsCodeView takes `takePrReviewWanted`).
 */
export function reviewOwnPrInIde(pr: { folder: string; base?: string; head?: string; label?: string }): void {
  // Linking the session sets the folder (App's friday:code-session-root), on the pull request's own folder when that isn't the
  // session's main one (a teammate's or a race lane's), so the chat's tab is in the column Code opens on. Said again, as a fallback, for a
  // session App can't place.
  if (getMode() === "agents") window.dispatchEvent(new CustomEvent("friday:code-session-root", { detail: { review: false, folder: pr.folder } }));
  const here = getIdeRoot();
  if (!here || !sameFolder(here, pr.folder)) setIdeRoot(pr.folder);
  // The base as GitHub has it: the local branch of that name may be behind. `strict`: if that ref isn't here, the IDE says so rather
  // than comparing with some other branch under the pull request's name; `head`: it says when the folder has left the branch.
  wanted = { root: pr.folder, base: pr.base ? (pr.base.startsWith("origin/") ? pr.base : `origin/${pr.base}`) : "", label: pr.label ?? "Pull request", ...(pr.head ? { head: pr.head } : {}), strict: !!pr.base, at: Date.now() };
  setMode("code");
  window.dispatchEvent(new Event(EVENT));
}

/**
 * One file of a teammate's pull request, opened in the IDE (the guided tour's "Open in the IDE"): the pull request's head is checked out in
 * a copy of its own, as Review in the IDE does, and Code opens that copy with the file at its line.
 */
export async function openPrFileInIde(identity: Identity, pr: PrToReview, file: { path: string; line?: number }, tool?: EngineTool): Promise<void> {
  const opened = await hostApi<Opened>(identity, "/api/runner/pr.ide", {
    method: "POST",
    body: JSON.stringify({ url: pr.url, title: pr.title ?? "", ...(getIdeRoot() ? { folder: getIdeRoot() } : {}), ...(tool ? { tool } : {}) }),
  });
  openInCode(joinPath(opened.dir, file.path), file.line, { folder: opened.dir });
}
