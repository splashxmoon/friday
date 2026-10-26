import type { Attachment } from "../types.js";
import type { Identity, RecentSession } from "./storage.js";

/**
 * Where a quick prompt (desktop/quick.ts, QuickPrompt.tsx) goes once Friday's window has it: into the session that is open,
 * with its snapshot as an attachment; or, with no session open, into a new one named after the words. The page's own routes
 * do the work (files, instruct, sessions), so a quick prompt is an ordinary message by the time anyone reads it.
 */

export interface QuickMessage {
  text: string;
  snapshot?: { data: string; mimeType: string; width: number; height: number };
}

/** A session's name from the words: the first line, cut to fit. */
export function quickTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return (line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line) || "Quick prompt";
}

/** The message's words, with something to say about the picture when there were no words. */
export function quickText(m: QuickMessage): string {
  if (m.text.trim()) return m.text.trim();
  return m.snapshot ? "Look at this screenshot of my screen and fix what's wrong in it." : "";
}

const bytes = (b64: string): Uint8Array<ArrayBuffer> => {
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

/** The snapshot as one of the session's files. */
async function attach(sid: string, invite: string, s: NonNullable<QuickMessage["snapshot"]>): Promise<Attachment> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/files?invite=${encodeURIComponent(invite)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": s.mimeType, "X-File-Name": encodeURIComponent(`screen-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.png`) },
    body: new Blob([bytes(s.data)], { type: s.mimeType }),
  });
  const j = (await r.json().catch(() => ({}))) as { file?: Attachment; error?: string };
  if (!r.ok || !j.file) throw new Error(j.error ?? "The snapshot couldn't be attached.");
  return j.file;
}

/** Into this session. */
export async function sendQuickTo(sid: string, invite: string, m: QuickMessage): Promise<void> {
  const attachments = m.snapshot ? [await attach(sid, invite, m.snapshot)] : [];
  const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/instruct?invite=${encodeURIComponent(invite)}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: quickText(m), ...(attachments.length ? { attachments } : {}) }),
  });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't send that.");
}

/** Into a new session, named after the words; the page opens it. */
export async function startQuick(identity: Identity, m: QuickMessage): Promise<RecentSession> {
  const r = await fetch("/api/sessions", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: identity.id, name: identity.name, title: quickTitle(quickText(m)), kind: "code" }),
  });
  const j = (await r.json().catch(() => ({}))) as { sessionId?: string; invites?: Record<string, string>; error?: string };
  if (!r.ok || !j.sessionId || !j.invites?.editor) throw new Error(j.error ?? "Couldn't start a session.");
  const invite = j.invites.owner ?? j.invites.editor;
  await sendQuickTo(j.sessionId, invite, m);
  return { sid: j.sessionId, title: quickTitle(quickText(m)), invite, role: "owner", openedAt: Date.now() };
}
