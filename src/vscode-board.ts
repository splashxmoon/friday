/**
 * One task board across Code and Agents (Arun, 2026-11-20, the Code<->Agents list: "the IDE's Tasks view and Friday's board list
 * Code chats AND the Agents sessions working in this folder, each saying where it lives").
 *
 * Pure on purpose, shared by the server (which merges the two lists for the IDE's Tasks view, /api/vscode/tasks) and the page
 * (which says which Agents sessions are in the IDE's folder, and which Code chats the Agents board lists), so the rule is one.
 */

/** Where a task lives: one of Code's own chats, or an Agents session. */
export type TaskWhere = "code" | "agents";

/** The least a task row carries, from either side. */
export interface TaskRow {
  sid: string;
  title: string;
  folder: string;
  tool: string;
  at: number;
  /** An Agents session opened in Code as a linked tab (code-chats.ts): still Agents' own. */
  linked?: boolean;
}

/** A folder compared as Code compares them: one slash style, no trailing slash, any case on a Windows drive or a share. */
export function dirKey(folder: string): string {
  const f = String(folder ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return /^([a-z]:\/|\/\/)/i.test(f) || /^[a-z]:$/i.test(f) ? f.toLowerCase() : f;
}
export const sameDir = (a: string, b: string): boolean => !!a && !!b && dirKey(a) === dirKey(b);

/** What of a session in Agents' list the board needs: its repos, as the sidebar remembers them (storage.ts RepoUse). */
export interface ListedSession {
  sid: string;
  title: string;
  alias?: string;
  openedAt: number;
  repos?: { path?: string; worktree?: boolean; cwd?: string }[];
}

/**
 * The Agents sessions working in a folder: it is the session's folder, or the folder its worktree is a copy of (a session that
 * works in a worktree of the IDE's folder is working on this project). Newest first, never one of Code's own chats, and `skip`
 * (the sessions Code already lists, a linked tab) is left out so no task shows twice.
 */
export function agentsInFolder(list: ListedSession[], root: string | null | undefined, isCodeChat: (sid: string) => boolean, skip: ReadonlySet<string> = new Set()): TaskRow[] {
  if (!root) return [];
  return list
    .filter((r) => !isCodeChat(r.sid) && !skip.has(r.sid))
    .filter((r) => (r.repos ?? []).some((x) => (x.path && sameDir(x.path, root)) || (x.cwd && sameDir(x.cwd, root))))
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, 50)
    .map((r) => ({ sid: r.sid, title: r.alias || r.title || "Untitled", folder: root, tool: "", at: r.openedAt }));
}

/**
 * The IDE's Tasks list: Code's own first, then Agents' (each group in the order it came), every row saying where it lives. A
 * linked tab (an Agents session opened in Code) is Agents' own, so it says "agents" with `linked`; a session in both lists shows
 * once, as Code has it.
 */
export function mergeTasks<C extends TaskRow, A extends TaskRow>(code: C[], agents: A[]): ((C | A) & { where: TaskWhere })[] {
  const seen = new Set<string>();
  const out: ((C | A) & { where: TaskWhere })[] = [];
  for (const c of code) {
    if (seen.has(c.sid)) continue;
    seen.add(c.sid);
    out.push({ ...c, where: c.linked ? "agents" : "code" });
  }
  for (const a of agents) {
    if (seen.has(a.sid)) continue;
    seen.add(a.sid);
    out.push({ ...a, where: "agents" });
  }
  return out;
}

/**
 * The Code chats Agents' board lists: Code's own chats (not a linked tab, which Agents already lists as its own) in a folder the
 * board knows, that is a folder Agents' sessions work in or the one Code has open. Newest first, at most `max`.
 */
export function codeForBoard<C extends { sid: string; folder: string; at: number; linked?: boolean }>(chats: C[], agentFolders: string[], root: string | null | undefined, max = 20): C[] {
  const known = new Set([...agentFolders, ...(root ? [root] : [])].map(dirKey));
  return chats
    .filter((c) => !c.linked && known.has(dirKey(c.folder)))
    .sort((a, b) => b.at - a.at)
    .slice(0, max);
}
