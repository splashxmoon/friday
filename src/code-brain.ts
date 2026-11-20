import type { BrainEntry } from "./brain.js";
import { repoKeyOf } from "./repo-key.js";
import { githubSlug } from "./runner/git.js";

/**
 * One brain for Code and Agents (Arun, 2026-11-20, wave 5: "what the agents learn about a repo (how to run it, its quirks, decisions)
 * is kept and given to every tool, in Code and Agents alike, one shared brain").
 *
 * A Code chat is a session like any other underneath, so its finished runs already teach the project brain through learnFromRun and
 * its coding tools are briefed by briefFor, under the repo key the folder gives (repo-key.ts). Nothing in Code is kept apart from
 * that. What this file adds is the label: which side of Friday a lesson was learned in, so the IDE's Memory view and Agents' memory
 * page can say "Code" or "Agents" beside where it came from, and the pieces the IDE's view needs to find its repo from a folder.
 */
export type Surface = "code" | "agents";

/** Which side a session is on: Code's chats are the ones the page told the server about (/api/vscode/tasks), the rest are Agents'. */
export function surfaceOf(codeSids: Iterable<{ sid: string; linked?: boolean }>, sid: string): Surface {
  for (const t of codeSids) if (t.sid === sid && !t.linked) return "code";
  return "agents";
}

/**
 * What a run saved, set against what the repo's brain held before it: one row per lesson that is new or changed, with the text it
 * replaced when it only brought an older one up to date. A lesson saved word for word again says nothing new.
 */
export function remembered(before: BrainEntry[], saved: BrainEntry[]): { entry: string; kind: string; text: string; was?: { text: string; kind: string } }[] {
  const out: { entry: string; kind: string; text: string; was?: { text: string; kind: string } }[] = [];
  for (const e of saved) {
    const had = before.find((b) => b.id === e.id);
    if (had && had.text === e.text && had.kind === e.kind && !had.retired) continue;
    out.push({ entry: e.id, kind: e.kind, text: e.text, ...(had ? { was: { text: had.text, kind: had.kind } } : {}) });
  }
  return out;
}

/**
 * The repo the IDE's open folder belongs to, as the brain keys it: the folder's git remote (the extension reads it) when it has
 * one, else its name, the same way a session's folder is keyed, so Code and Agents land on one repo.
 */
export function repoOfFolder(folder: string, remote?: string | null): { key: string; name: string } | null {
  const url = (remote ?? "").trim();
  // The GitHub slug is found the way the runner finds it for a session (githubSlug), so www. and the like land on the same key.
  return repoKeyOf(url ? { url, github: githubSlug(url) } : null, folder);
}
