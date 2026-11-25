import type { Attachment } from "../types.js";
import type { Identity } from "./storage.js";
import type { WorkspaceUsage } from "./workspace-types.js";

/** A call's options, and how long to wait for its answer (ms; 0 waits for ever). */
export type ApiInit = RequestInit & { timeout?: number };

/** A call Friday didn't answer in time: its message is said as it is ("Friday didn't answer in 20 s…"). */
export class ApiTimeout extends Error {
  override name = "Timeout";
}

/**
 * How long a call waits for its answer when it doesn't say (spec 13; Arun, 2026-11-24: "Go all out and fix these problems"):
 * without one, a server that took a request and never answered left its spinner turning for good. A read waits 20 s; a read
 * through to a computer (`/api/runner/`) 35 s, past the server's own 30 s wait on it, so the server's words come back rather
 * than ours. A write may be doing real work (a draft, an import, a merge) and waits 2 minutes; a write to a computer, where a
 * clone or a review can take ten, has the server's own limit, and none here.
 */
export function waitFor(path: string, method = "GET"): number {
  const read = method === "GET" || method === "HEAD";
  const computer = path.startsWith("/api/runner/");
  if (read) return computer ? 35_000 : 20_000;
  return computer ? 0 : 120_000;
}

/** What a call that ran out of time says: for a write, that it may still have happened. */
export function timeoutText(ms: number, read: boolean): string {
  const s = ms >= 120_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} s`;
  return read ? `Friday didn't answer in ${s}. Try again in a moment.` : `Friday didn't answer in ${s}. It may still finish, so check before trying again.`;
}

const unreachable = (e: unknown) => (e instanceof TypeError ? new TypeError("Couldn't reach Friday. Check your connection and try again.") : e);

/**
 * A JSON API call as the signed-in account.
 *
 * Who you are rides in the session cookie, which the browser attaches and
 * script cannot read or forge. The `identity` argument is kept only because
 * every call site passes it and several still need the id locally; nothing
 * about it reaches the server.
 *
 * It ends: after `timeout` (waitFor's default), with an ApiTimeout saying so; a call that brings its own `signal` (a long poll,
 * a deadline of its own) keeps to that instead. A read that couldn't reach the server at all is asked once more, quietly, a
 * moment later: a dropped connection as the network changes, or the server restarting, is usually gone by then. Writes are
 * never asked twice, since the first may have landed.
 */
export async function api<T>(_identity: Identity, path: string, init: ApiInit = {}): Promise<T> {
  const { timeout, ...rest } = init;
  const method = (rest.method ?? "GET").toUpperCase();
  const read = method === "GET" || method === "HEAD";
  const ms = rest.signal ? 0 : (timeout ?? waitFor(path, method));
  const once = async () => {
    const ctl = ms > 0 ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), ms) : undefined;
    try {
      const res = await fetch(path, {
        ...rest,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...rest.headers },
        ...(ctl ? { signal: ctl.signal } : {}),
      });
      // The body is part of the answer: one that stops coming is timed too.
      const body: unknown = await res.json().catch((e: unknown) => {
        if (ctl?.signal.aborted) throw e;
        return {};
      });
      return { res, body };
    } catch (e) {
      if (ctl?.signal.aborted) throw new ApiTimeout(timeoutText(ms, read));
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
  let got: Awaited<ReturnType<typeof once>>;
  try {
    got = await once();
  } catch (e) {
    if (!read || !(e instanceof TypeError) || rest.signal?.aborted) throw unreachable(e);
    await new Promise((r) => setTimeout(r, 400));
    got = await once().catch((again: unknown) => {
      throw unreachable(again);
    });
  }
  const { res, body } = got;
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
