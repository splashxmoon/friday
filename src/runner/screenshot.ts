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
// Not passed on to the coding tools and their commands.
delete process.env.FRIDAY_SHOTS;

export const canScreenshot = (): boolean => viaDesktop;

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
}

const waits = new Map<string, (d: Done) => void>();
let listening = false;
function listen(): void {
  if (listening) return;
  listening = true;
  process.on("message", (m: unknown) => {
    const d = m as Done | null;
    if (d?.kind === "capture.done" && typeof d.id === "string") waits.get(d.id)?.(d);
  });
  // Listening mustn't keep the runner going once everything else has stopped (a quit drains it rather than exiting).
  process.channel?.unref();
}

/** The shell's own answer to one capture: the picture and what the page logged, or what went wrong. Never rejects. */
export function capture(shot: Shot, signal?: AbortSignal): Promise<Done> {
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
