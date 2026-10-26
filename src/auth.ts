import { createHmac, timingSafeEqual } from "node:crypto";
import type { Role } from "./types.js";

// Prototype auth: a role-carrying invite link, HMAC-signed so it can't be
// edited from viewer to owner. Editor/viewer links carry a version so an
// owner can replace a leaked link. Identity (userId + display name) is
// self-asserted by the browser. Swap in real accounts before any real use.

export interface Invite {
  sid: string;
  role: Role;
  v: number;
}

export function signInvite(secret: string, sid: string, role: Role, v = 1): string {
  const payload = Buffer.from(JSON.stringify({ sid, role, v })).toString("base64url");
  return `${payload}.${mac(secret, payload)}`;
}

export function verifyInvite(secret: string, token: string | null | undefined): Invite | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(mac(secret, payload));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  try {
    const v = JSON.parse(Buffer.from(payload, "base64url").toString()) as Partial<Invite>;
    if (typeof v.sid !== "string" || !["owner", "editor", "viewer"].includes(v.role as string)) return null;
    return { sid: v.sid, role: v.role as Role, v: typeof v.v === "number" ? v.v : 1 };
  } catch {
    return null;
  }
}

/**
 * A link to a session as a recording. Signed like an invite and refused by verifyInvite, so it can never be used to
 * join; it carries the viewer link's version, so turning that link off or replacing it ends every replay link too.
 */
export function signReplay(secret: string, sid: string, v: number): string {
  const payload = Buffer.from(JSON.stringify({ sid, role: "replay", v })).toString("base64url");
  return `${payload}.${mac(secret, payload)}`;
}

export function verifyReplay(secret: string, token: string | null | undefined): { sid: string; v: number } | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(mac(secret, payload));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  try {
    const v = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sid?: unknown; role?: unknown; v?: unknown };
    if (typeof v.sid !== "string" || v.role !== "replay") return null;
    return { sid: v.sid, v: typeof v.v === "number" ? v.v : 1 };
  } catch {
    return null;
  }
}

function mac(secret: string, payload: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

// ── who you are, in a cookie ──────────────────────────────────────────

export const SESSION_COOKIE = "friday_session";
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

/**
 * A signed statement that this browser belongs to an account.
 *
 * Same HMAC as an invite, different payload and a different purpose: an invite
 * says "this link may open that session", a session cookie says "this is who
 * you are". It carries only the account id — name, email and everything else
 * are read from the store, so changing them never means reissuing a cookie.
 */
export function signSession(secret: string, accountId: string, issuedAt = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ uid: accountId, iat: issuedAt })).toString("base64url");
  return `${payload}.${mac(secret, payload)}`;
}

export function verifySession(secret: string, token: string | null | undefined): { uid: string; iat: number } | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(mac(secret, payload));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  try {
    const v = JSON.parse(Buffer.from(payload, "base64url").toString()) as { uid?: unknown; iat?: unknown };
    if (typeof v.uid !== "string" || !v.uid || typeof v.iat !== "number") return null;
    // An old cookie is not a valid one: signing out everywhere has to mean something.
    if (Date.now() - v.iat > SESSION_MAX_AGE_S * 1000) return null;
    return { uid: v.uid, iat: v.iat };
  } catch {
    return null;
  }
}

/** Cookies off a request header, without a dependency to parse four lines. */
export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * `secure` only when the connection really is https: setting it on plain http
 * makes the cookie silently vanish, which looks exactly like broken sign-in.
 * SameSite=Lax so following an invite link from mail or chat still arrives
 * signed in, while a cross-site POST does not.
 */
export function sessionCookie(value: string, opts: { secure: boolean; maxAge?: number }): string {
  const bits = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${opts.maxAge ?? SESSION_MAX_AGE_S}`,
  ];
  if (opts.secure) bits.push("Secure");
  return bits.join("; ");
}

export const clearSessionCookie = (secure: boolean) => sessionCookie("", { secure, maxAge: 0 });

/**
 * Permission for a runner to act as one person, in one session.
 *
 * A runner is a process on someone's laptop, not a browser, so it has no
 * cookie. It used to name itself with `?userId=`, which meant anyone holding
 * an invite link could attach a coding agent under a colleague's name. This
 * token is minted by the server for the person who asked for it and is only
 * good for the session it names.
 */
export function signActor(secret: string, sid: string, uid: string): string {
  const payload = Buffer.from(JSON.stringify({ sid, uid, t: Date.now() })).toString("base64url");
  return `${payload}.${mac(secret, payload)}`;
}

export function verifyActor(secret: string, token: string | null | undefined, sid: string): { uid: string; t: number } | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(mac(secret, payload));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  try {
    const v = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sid?: unknown; uid?: unknown; t?: unknown };
    if (typeof v.uid !== "string" || !v.uid || v.sid !== sid) return null;
    // When it was minted: a token from before the account ended its sessions is refused (app.ts, the runner socket).
    return { uid: v.uid, t: typeof v.t === "number" ? v.t : 0 };
  } catch {
    return null;
  }
}
