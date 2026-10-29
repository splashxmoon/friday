/**
 * A pass for a page an agent made, shown working in a Work session's reader (client/WorkPanels.tsx PageFrame), to load its own
 * pictures, video and sound from the folder: in place of the session's invite, which the page's scripts could read off its own
 * pictures' addresses and send anywhere, and which lets whoever holds it act in the session. The pass is good for one session,
 * one of its folders and the folder under it the page needs, for an hour; it reads pictures, video and sound and nothing else,
 * and it is no invite (Arun, 2026-10-28: "iron everything and ensure we are good… focusing on UI and UX and any logic errors").
 *
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";

/** How long a pass is good for: a page left open longer is drawn again with a new one when it is next opened. */
export const FRAME_TTL_MS = 60 * 60 * 1000;

/** Signed apart from invites: the same secret, never the same message, so neither can stand for the other. */
const mac = (secret: string, payload: string) => createHmac("sha256", secret).update(`work-frame.${payload}`).digest("base64url");

export interface FrameScope {
  sid: string;
  root: number;
  dir: string;
}

/** A folder under a session's folder as a pass names it: `outputs/site`, never `..`, `/x` or `a//b`; "" is the folder itself. */
export function frameDir(dir: string): string | null {
  const d = dir.replace(/^\/+|\/+$/g, "");
  if (!d) return "";
  if (d.includes("\\") || d.includes("\0") || d.split("/").some((bit) => !bit || bit === "." || bit === "..")) return null;
  return d;
}

export function signFrame(secret: string, s: FrameScope, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ k: "work-frame", sid: s.sid, root: s.root, dir: s.dir, exp: now + FRAME_TTL_MS })).toString("base64url");
  return `${payload}.${mac(secret, payload)}`;
}

/** The scope a pass grants in this session, or null: altered, for another session, or past its hour. */
export function verifyFrame(secret: string, token: string | null | undefined, sid: string, now = Date.now()): Omit<FrameScope, "sid"> | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const want = Buffer.from(mac(secret, payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const v = JSON.parse(Buffer.from(payload, "base64url").toString()) as Partial<FrameScope & { k: string; exp: number }>;
    if (v.k !== "work-frame" || v.sid !== sid || typeof v.root !== "number" || typeof v.dir !== "string" || typeof v.exp !== "number" || v.exp <= now) return null;
    const dir = frameDir(v.dir);
    return dir === null ? null : { root: v.root, dir };
  } catch {
    return null;
  }
}

/** What a pass reads: pictures, video and sound, which is all a page's frame may load from Friday (its img-src and media-src). */
const MEDIA = /\.(png|jpe?g|gif|webp|svg|avif|mp4|mov|webm|m4v|mp3|wav|m4a|ogg)$/i;

/** Whether a path from the folder's top is one the pass reads: inside its folder (never out of it by `..`), and a picture or sound. */
export function inFrame(dir: string, rel: string): boolean {
  if (!rel || rel.includes("\0") || path.posix.isAbsolute(rel) || !MEDIA.test(rel)) return false;
  const p = path.posix.normalize(rel);
  if (p === ".." || p.startsWith("../")) return false;
  return !dir || p.startsWith(`${dir}/`);
}
