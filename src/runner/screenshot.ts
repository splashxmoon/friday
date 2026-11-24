import { randomUUID } from "node:crypto";
import type { MeshAnswer } from "./friday-mcp.js";

/**
 * preview_screenshot's picture (agent-mesh.ts), taken by the desktop app this runner runs under (desktop/capture.ts), in an
 * offscreen window of the app's own process: nothing opens, and no second app shows in the Dock, as each headless Chrome a coding
 * tool launched to look at its page did (Arun, 2026-10-19). The runner itself runs as plain Node (ELECTRON_RUN_AS_NODE) and can't
 * draw a page, so it asks the app over the channel the app started it with, and says so by FRIDAY_SHOTS. A runner started any
 * other way (linked from a terminal, an always-on machine) has no app to ask, and isn't offered the tool.
 */
const viaDesktop = process.env.FRIDAY_SHOTS === "1" && typeof process.send === "function";
/** A desktop app that also records proof clips says so by FRIDAY_CLIPS; an older one would never answer the ask. */
const clipsViaDesktop = viaDesktop && process.env.FRIDAY_CLIPS === "1";
// Not passed on to the coding tools and their commands.
delete process.env.FRIDAY_SHOTS;
delete process.env.FRIDAY_CLIPS;

/**
 * The open-source desktop app runs Friday's server, and so this runner, in its own process (src/local/desktop.ts), where there is no
 * channel to ask: it hands over its capture and recorder instead (src/desktop-capture.ts). Without this its preview checks said
 * "Screenshots are taken by the Friday desktop app" inside the desktop app (Arun, 2026-11-21: "not working....").
 */
type InProcess = {
  capture: (shot: Shot) => Promise<{ data?: string; mimeType?: string; width?: number; height?: number; cut?: boolean; errors?: string[]; error?: string }>;
  clip: (ask: Parameters<typeof clipViaDesktop>[0]) => Promise<{ data?: string; mimeType?: string; width?: number; height?: number; durationMs?: number; marks?: { atMs: number; label: string }[]; errors?: string[]; stops?: number[]; error?: string }>;
};
let inProcess: InProcess | null = null;
export function useInProcessCapture(p: InProcess | null): void {
  inProcess = p;
}

export const canScreenshot = (): boolean => viaDesktop || !!inProcess;
export const canClipViaDesktop = (): boolean => clipsViaDesktop || !!inProcess;

/** What to capture: a page on this machine, at this size (agent-mesh.ts's PreviewCapture). */
export interface Shot {
  url: string;
  width: number;
  height: number;
  fullPage: boolean;
  /** Also say what the page logged as errors while it loaded (a preview check, preview-check.ts). A shell that doesn't know says none. */
  console?: boolean;
}

export interface Done {
  kind?: string;
  id: string;
  data?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  cut?: boolean;
  error?: string;
  /** The page's console errors, from a shell that was asked for them (desktop/capture.ts). */
  errors?: string[];
  /** A clip's length, its captions with their times, and where it scrolled to (clip.done). */
  durationMs?: number;
  marks?: { atMs: number; label: string }[];
  stops?: number[];
  /** The same walk as an animated GIF, base64 (clip.done). */
  gif?: string;
  /** The same walk as H.264 in a fast-start MP4, base64, when the desktop app can record one (clip.done). */
  mp4?: string;
}

const waits = new Map<string, (d: Done) => void>();
let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  process.on("message", (m: unknown) => {
    const d = m as Done | null;
    if ((d?.kind === "capture.done" || d?.kind === "clip.done") && typeof d.id === "string") waits.get(d.id)?.(d);
  });
  // Listening mustn't keep the runner going once everything else has stopped (a quit drains it rather than exiting).
  process.channel?.unref();
}

/** The shell's own answer to one capture: the picture and what the page logged, or what went wrong. Never rejects. */
export function capture(shot: Shot, signal?: AbortSignal): Promise<Done> {
  if (inProcess && !viaDesktop) return withStop(inProcess.capture(shot).then((r) => (r.data ? { id: "", ...r } : { id: "", error: r.error || "The screenshot couldn't be taken." })), signal, 45_000, "The page didn't load and draw within 45 seconds.");
  if (!viaDesktop) return Promise.resolve({ id: "", error: "Screenshots are taken by the Friday desktop app, and this runner isn't running in it." });
  listen();
  return new Promise((resolve) => {
    const id = randomUUID();
    const done = (d: Done) => {
      waits.delete(id);
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve(d.data ? d : { id, error: d.error || "The screenshot couldn't be taken." });
    };
    const stop = () => done({ id, error: "Stopped." });
    const timer = setTimeout(() => done({ id, error: "The page didn't load and draw within 45 seconds." }), 45_000);
    waits.set(id, done);
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop);
    process.send!({ kind: "capture", id, ...shot }, (e: Error | null) => e && done({ id, error: `The desktop app couldn't be asked: ${e.message}` }));
  });
}

/** The page as an image for the tool that asked, or what went wrong. Never rejects. */
export async function screenshot(shot: Shot, signal?: AbortSignal): Promise<MeshAnswer> {
  const d = await capture(shot, signal);
  if (!d.data) return { output: d.error || "The screenshot couldn't be taken.", isError: true };
  const size = d.width && d.height ? `${d.width}×${d.height}` : `${shot.width} wide`;
  return {
    content: [
      { type: "image", data: d.data, mimeType: d.mimeType || "image/png" },
      { type: "text", text: `${shot.url}, ${size}${shot.fullPage ? (d.cut ? `, the page down to ${d.height}px (it goes on below)` : ", the whole page") : ""}. Only you see this; show_preview shows the page to the people here.` },
    ],
  };
}

/**
 * A proof clip of a page on this computer, recorded by the desktop app (desktop/capture.ts recordClip; Arun, 2026-11-21: "1. Speed
 * baseline, Today with Tonight, and proof clips."): a walk through the words the change added (or to the scroll stops, or top to
 * bottom), as WebM, with its captions' times and the console's errors. Never rejects.
 */
export function clipViaDesktop(ask: { url: string; width: number; height: number; targets?: { text: string }[]; stops?: number[]; badge?: string }, signal?: AbortSignal): Promise<Done> {
  if (inProcess && !clipsViaDesktop) return withStop(inProcess.clip(ask).then((r) => (r.data ? { id: "", ...r } : { id: "", error: r.error || "The clip couldn't be made." })), signal, 90_000, "The clip wasn't made within 90 seconds.");
  if (!clipsViaDesktop) return Promise.resolve({ id: "", error: "Clips are recorded by a newer Friday desktop app." });
  listen();
  return new Promise((resolve) => {
    const id = randomUUID();
    const done = (d: Done) => {
      waits.delete(id);
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve(d.data ? d : { id, error: d.error || "The clip couldn't be made." });
    };
    const stop = () => done({ id, error: "Stopped." });
    // The page's load (30 seconds at most), the walk (about 7) and the making, up to three times when it comes out too heavy.
    const timer = setTimeout(() => done({ id, error: "The clip wasn't made within 90 seconds." }), 90_000);
    waits.set(id, done);
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop);
    process.send!({ kind: "clip", id, ...ask }, (e: Error | null) => e && done({ id, error: `The desktop app couldn't be asked: ${e.message}` }));
  });
}

/** An in-process capture with the same stop and time limit the asked one has. */
function withStop(p: Promise<Done>, signal: AbortSignal | undefined, ms: number, late: string): Promise<Done> {
  if (signal?.aborted) return Promise.resolve({ id: "", error: "Stopped." });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ id: "", error: late }), ms);
    const stop = () => (clearTimeout(timer), resolve({ id: "", error: "Stopped." }));
    signal?.addEventListener("abort", stop, { once: true });
    void p.then((d) => (clearTimeout(timer), signal?.removeEventListener("abort", stop), resolve(d)));
  });
}
