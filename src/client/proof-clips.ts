/**
 * Proof clips, on or off (Arun, 2026-11-21: "i want this proof clips to be very advanced.... and can be toggled on or off"). One setting
 * for the person, kept by Friday (GET/PUT /api/proof-clips) so the preview check's card and the clips Friday records by itself after
 * Tonight's work both follow it:
 * - on: record a clip at all (off, the preview check still takes its pictures);
 * - auto: pre-approved, Friday makes proof by itself after work nobody watched; off (the default since 2026-11-22, Devin's way), it is
 *   offered under finished work (Test it) and made when pressed;
 * - before: also record the page as it was, from a copy of the code before the change (a second dev server, so a minute longer);
 * - phone: also record it at a phone's width;
 * - pr: put the clip in the pull request's description (as a GIF kept on a branch of the repository named friday-proof).
 */
import { useEffect, useState } from "react";
import { api } from "./api.js";
import type { Identity } from "./storage.js";

export interface ProofClips {
  on: boolean;
  auto: boolean;
  before: boolean;
  phone: boolean;
  pr: boolean;
}

export const PROOF_CLIPS_DEFAULT: ProofClips = { on: true, auto: false, before: false, phone: false, pr: true };

let current: ProofClips | null = null;
const listeners = new Set<(p: ProofClips) => void>();
let asking: Promise<void> | null = null;

/** The setting, read once and shared by every place that shows it; null while the first read is out. */
export function useProofClips(identity: Identity): ProofClips | null {
  const [p, setP] = useState<ProofClips | null>(current);
  useEffect(() => {
    listeners.add(setP);
    // Asked again until one read succeeds: a read made before the person is known (no id yet) fails, and keeping its default would
    // show the switches wrong until a restart.
    if (!current && identity.id && !asking)
      asking = api<ProofClips>(identity, "/api/proof-clips")
        .then(
          (r) => ((current = { ...PROOF_CLIPS_DEFAULT, ...r }), listeners.forEach((l) => l(current!))),
          () => listeners.forEach((l) => l(PROOF_CLIPS_DEFAULT)),
        )
        .finally(() => (asking = null));
    return () => void listeners.delete(setP);
  }, [identity.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return p;
}

/** Change it: shown at once everywhere, kept by Friday behind it (put back as it was if Friday refuses). */
export async function setProofClips(identity: Identity, change: Partial<ProofClips>): Promise<void> {
  const was = current ?? PROOF_CLIPS_DEFAULT;
  current = { ...was, ...change };
  listeners.forEach((l) => l(current!));
  try {
    current = { ...PROOF_CLIPS_DEFAULT, ...(await api<ProofClips>(identity, "/api/proof-clips", { method: "PUT", body: JSON.stringify(current) })) };
  } catch (e) {
    current = was;
    throw e;
  } finally {
    listeners.forEach((l) => l(current!));
  }
}

/** A clip the preview check recorded, said in the session's log (proof.clip): the chat, the phone, Today and the pull request show it. */
export async function postProofClip(sid: string, invite: string, clip: { page: string; file: string; durationMs: number; marks?: { atMs: number; label: string }[]; before?: string; phone?: string; gif?: string; gifBefore?: string; mp4?: string; mp4Before?: string; mp4Phone?: string; lane?: string }): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/proof-clip?${new URLSearchParams({ invite })}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(clip) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "The clip couldn't be kept in the chat.");
}

/** How one session takes clips (app.ts /api/sessions/:id/proof-clips): its mode, what Settings say, and whether it has its own word. */
export type ClipMode = "auto" | "ask" | "off";
export interface SessionClips {
  mode: ClipMode;
  settings: ClipMode;
  own: boolean;
}
const sessionUrl = (sid: string, invite: string, tail = "proof-clips") => `/api/sessions/${encodeURIComponent(sid)}/${tail}?${new URLSearchParams({ invite })}`;
async function ask<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? "That didn't go through.");
  return body;
}
export const sessionClips = (sid: string, invite: string) => ask<SessionClips>(sessionUrl(sid, invite));
/** Set this session's own mode, or "settings" to go back to what Settings say. */
export const setSessionClips = (sid: string, invite: string, mode: ClipMode | "settings") =>
  ask<SessionClips>(sessionUrl(sid, invite), { method: "PUT", body: JSON.stringify({ mode }) }).then((r) => (modes.set(sid, { at: Date.now(), mode: r.mode }), r));
/** Record a proof clip of a lane's finished work now; it comes back in the chat as a proof.clip. */
export const recordProofClip = (sid: string, invite: string, lane: string) => ask<{ ok: true }>(sessionUrl(sid, invite, "proof-clip/record"), { method: "POST", body: JSON.stringify({ lane }) });
/** Test it: the tests a lane's finished work ran (or the project's own) and a proof clip when it changed a page, each in the chat. */
export const testWork = (sid: string, invite: string, lane: string) => ask<{ ok: true }>(sessionUrl(sid, invite, "proof/test"), { method: "POST", body: JSON.stringify({ lane }) });
export const CLIP_MODE_WORDS: Record<ClipMode, string> = { auto: "Pre-approved", ask: "When I ask", off: "Off" };

const modes = new Map<string, { at: number; mode: ClipMode }>();
/** This session's clip mode, read once a minute at most and shared by every finished run on screen; null until read. */
export function useClipMode(sid: string, invite: string): ClipMode | null {
  const [m, setM] = useState<ClipMode | null>(modes.get(sid)?.mode ?? null);
  useEffect(() => {
    const kept = modes.get(sid);
    if (kept && Date.now() - kept.at < 60_000) return void setM(kept.mode);
    if (!invite) return;
    let live = true;
    void sessionClips(sid, invite).then(
      (r) => (modes.set(sid, { at: Date.now(), mode: r.mode }), live && setM(r.mode)),
      () => {},
    );
    return () => void (live = false);
  }, [sid, invite]);
  return m;
}
