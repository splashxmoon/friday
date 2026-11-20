import { useEffect, useState } from "react";
import { agentsInFolder, type TaskRow } from "../../vscode-board.js";
import { loadRecents } from "../storage.js";
import { isCodeChat, linkCodeChat, loadCodeChats } from "./code-chats.js";
import { folderOf, setIdeRoot } from "./mode.js";

/**
 * The Agents sessions working in the IDE's folder, for its Tasks view (Arun, 2026-11-20: "the IDE's Tasks view and Friday's board
 * list Code chats AND the Agents sessions working in this folder, each saying where it lives"). Read from Agents' list, which
 * changes in App's own state and says nothing to here: so a slow look, and one whenever the window is shown again (as the palette's
 * feed does, palette-run.ts).
 */
export function useAgentsHere(root: string | null, active: boolean): TaskRow[] {
  const [rows, setRows] = useState<TaskRow[]>([]);
  useEffect(() => {
    if (!active || !root) return void setRows([]);
    let last = "";
    const look = () => {
      if (document.hidden) return;
      // Sessions Code already lists (a linked tab) show once, from Code's side.
      const skip = new Set(loadCodeChats().map((c) => c.sid));
      const next = agentsInFolder(loadRecents(), root, isCodeChat, skip);
      const text = JSON.stringify(next);
      if (text === last) return;
      last = text;
      setRows(next);
    };
    look();
    const timer = window.setInterval(look, 5000);
    document.addEventListener("visibilitychange", look);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", look);
    };
  }, [root, active]);
  return rows;
}

/**
 * An Agents session picked on the IDE's Tasks view: opened in Agents, or, with `inCode`, as a linked tab in Code's column (the same
 * as "Open in Code" on the session, App's linkSession). The invite comes from this page's own list, never from what came back through
 * the IDE. Returns whether the session was one of Agents' here.
 */
export function openAgentsTask(sid: string, inCode: boolean, root: string | null): boolean {
  const r = loadRecents().find((x) => x.sid === sid && !isCodeChat(x.sid));
  if (!r) return false;
  // One rule with App's linkSession ("Open in Code" on the session): the link sits under the session's own folder (a worktree's, when
  // it works in one), so a later Open in Code from Agents finds it there and the tab never jumps folders.
  const folder = folderOf(r) ?? root;
  if (inCode && folder) {
    setIdeRoot(folder);
    linkCodeChat({ sid: r.sid, invite: r.invite, folder, title: r.alias || r.title || "Untitled" });
  } else window.dispatchEvent(new CustomEvent("friday:code-to-agents", { detail: { sid: r.sid, invite: r.invite, title: "", open: true } }));
  return true;
}
