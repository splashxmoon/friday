/**
 * A picture's address through the session (work-files.ts shownFile), kept apart from LiveBlock so the panels that only need the
 * address (DiffView, ChatPictures) don't bring the live drawings into the first load.
 */

/** The session the chat being drawn is, for a page whose address doesn't say (SessionView sets it). */
export const pictureSession: { sid: string; invite: string } = { sid: "", invite: "" };

/** A picture's address on this computer, as the session serves it; null for one on the web (or Friday's own). */
export function localPicture(src: string): string | null {
  const q = new URLSearchParams(location.search);
  const sid = q.get("session") || pictureSession.sid;
  const invite = q.get("invite") || pictureSession.invite;
  if (!sid || !invite || /^(https?:|data:|blob:)/i.test(src) || src.startsWith("/api/")) return null;
  const at = `/api/sessions/${encodeURIComponent(sid)}/work/file?invite=${encodeURIComponent(invite)}`;
  const file = src.replace(/^file:\/\//i, "");
  if (file.startsWith("/") || /^[a-z]:[\\/]/i.test(file) || file.startsWith("~/")) return `${at}&abs=${encodeURIComponent(decodeURI(file))}`;
  return `${at}&path=${encodeURIComponent(decodeURI(file.replace(/^\.\//, "")))}`;
}

/** A file a side panel can show as a picture rather than read as text (work-files.ts serves these). */
export const PICTURE_FILE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
/** A video the chat and the side panels play (work-files.ts serves it with ranges, so it can be skipped through). */
export const VIDEO_FILE = /\.(mp4|mov|webm|m4v)$/i;
/** A video by its address too (the session's work/file?…&path=demo.mp4). */
export const isVideo = (name: string) => VIDEO_FILE.test(name) || /\.(mp4|mov|webm|m4v)(?:$|[?&#])/i.test(decodeURIComponent(name));
