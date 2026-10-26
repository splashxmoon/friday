import type { Attachment } from "../types.js";
import type { Identity } from "./storage.js";
import type { WorkspaceUsage } from "./workspace-types.js";

/**
 * A JSON API call as the signed-in account.
 *
 * Who you are rides in the session cookie, which the browser attaches and
 * script cannot read or forge. The `identity` argument is kept only because
 * every call site passes it and several still need the id locally; nothing
 * about it reaches the server.
 */
export async function api<T>(_identity: Identity, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...init.headers },
  }).catch((e: unknown) => {
    throw e instanceof TypeError ? new TypeError("Couldn't reach Friday. Check your connection and try again.") : e;
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? failureText(res.status));
  return body as T;
}

let workspacesOut: Promise<{ workspaces: WorkspaceUsage[]; current: string }> | null = null;
/**
 * The workspaces you are in. Settings, the session's usage panel and the Solo/Team switch each ask as they open, often at
 * the same moment; while one request is out, they all wait on it rather than sending three.
 */
export function listWorkspaces(identity: Identity): Promise<{ workspaces: WorkspaceUsage[]; current: string }> {
  workspacesOut ??= api<{ workspaces: WorkspaceUsage[]; current: string }>(identity, "/api/workspaces").finally(() => {
    workspacesOut = null;
  });
  return workspacesOut;
}

/** What a failed request means to the person, when the server didn't say: a status code is not an instruction. */
export function failureText(status: number): string {
  if (status === 401) return "You're signed out. Sign in and try again.";
  if (status === 403) return "You don't have access to that.";
  if (status === 404) return "That isn't there any more. Reload and try again.";
  if (status === 413) return "That's too large to send.";
  if (status === 429) return "Too many requests at once. Wait a moment and try again.";
  if (status >= 500) return "The server hit a problem. Try again in a moment.";
  return "That didn't go through. Try again.";
}

/** Upload one attachment (from a data:/blob: URL) to the session's file store. */
export async function uploadFile(sid: string, invite: string, _userId: string, file: { url: string; mediaType?: string; filename?: string }): Promise<Attachment> {
  const blob = await (await fetch(file.url)).blob();
  const qs = new URLSearchParams({ invite });
  const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/files?${qs}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": file.mediaType || blob.type || "application/octet-stream",
      "x-file-name": encodeURIComponent(file.filename || "file"),
    },
    body: blob,
  });
  const body = (await res.json().catch(() => ({}))) as { file?: Attachment; error?: string };
  if (!res.ok || !body.file) throw new Error(body.error ?? `Couldn't upload ${file.filename ?? "file"}`);
  return body.file;
}

export const fileUrl = (sid: string, invite: string, id: string) =>
  `/api/sessions/${encodeURIComponent(sid)}/files/${encodeURIComponent(id)}?invite=${encodeURIComponent(invite)}`;

/** Something the page saw happen in a session, for product analytics (src/analytics.ts): only these few, by name and id. */
export function tell(event: "link_copied" | "invite_nudge_shown" | "invite_nudge_used", sid: string): void {
  void fetch("/api/telemetry", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, sid }) }).catch(() => {});
}
