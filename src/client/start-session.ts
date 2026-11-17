import type { EngineMode, EngineTool } from "../types.js";
import { api } from "./api.js";
import { hostApi } from "./local.js";
import { titleFrom } from "./quick-send.js";
import { MODE_KEY } from "./StartControls.js";
import type { Identity } from "./storage.js";

/** The mode the new-session page last had: what a session started elsewhere runs at too. */
export const lastMode = (): EngineMode => {
  try {
    const kept = localStorage.getItem(MODE_KEY);
    return kept === "plan" || kept === "edits" || kept === "full" ? kept : "full";
  } catch {
    return "full";
  }
};

/**
 * A coding session started in a folder on this computer, the way the new-session page starts one (Code.tsx submit): the session,
 * its coding tool in the folder (or in a worktree of its own), then the task, when there is one. Made and then not started, it is
 * taken away again. Shared by a project's New thread (threads.tsx) and the menu bar's New task (TrayPanel.tsx).
 */
export async function startSession(identity: Identity, o: { path: string; tool: EngineTool; text: string; worktree?: boolean; /** Its copy on this branch (a new one from `base`), fetched first when `fetch` (a pull request's). */ aside?: { branch: string; base?: string; fetch?: boolean }; /** Named this, rather than after its first words (an issue's "#12 Title"). */ title?: string }): Promise<{ sid: string; invite: string; title: string }> {
  const text = o.text.trim();
  const title = o.title ? titleFrom(o.title) : text ? titleFrom(text) : "New thread";
  let made = "";
  try {
    const r = await api<{ sessionId: string; invites: Record<string, string> }>(identity, "/api/sessions", { method: "POST", body: JSON.stringify({ userId: identity.id, name: identity.name, title, kind: "code", goal: "", engine: o.tool }) });
    made = r.sessionId;
    const invite = r.invites.owner!;
    const mode = lastMode();
    await hostApi(identity, "/api/runner/start", { method: "POST", body: JSON.stringify({ sid: made, invite, tool: o.tool, cwd: o.path, mode, handMode: mode, ...(o.worktree || o.aside ? { worktree: "lane", copyName: o.tool, ...(o.aside ? { aside: o.aside } : {}) } : {}) }) });
    if (text) await api(identity, `/api/sessions/${encodeURIComponent(made)}/instruct?invite=${encodeURIComponent(invite)}`, { method: "POST", body: JSON.stringify({ text }) });
    return { sid: made, invite, title };
  } catch (e) {
    if (made) void api(identity, "/api/sessions/mine/forget", { method: "POST", body: JSON.stringify({ sid: made }) }).catch(() => {});
    throw e;
  }
}
