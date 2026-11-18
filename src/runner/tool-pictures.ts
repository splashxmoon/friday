import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { shotsDir } from "../work-files.js";

/**
 * Pictures a coding tool's step gave back (a screenshot from an MCP tool, Claude Code reading a PNG, Friday's preview_screenshot),
 * shown in the chat with the step (Arun, 2026-11-18: "allow for the coding tools and stuff to send images in the chat too").
 *
 * Their bytes never go in the session's log: each is kept as a file in Friday's screenshots folder on the computer the tool runs on,
 * the folder the session already serves pictures from (work-files.ts shownFile), and the step's result names it by its path.
 */
export type Picture = { data: string; mimeType: string };

const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };
/** At most this many from one step, each at most this big: a step that answers with fifty frames shows the first few. */
export const PICTURES_PER_STEP = 6;
const PICTURE_MAX = 20 * 1024 * 1024;

/**
 * The pictures in a tool's answer, in each shape the tools send one: the Messages API's (`{type: "image", source: {type: "base64",
 * media_type, data}}`, Claude Code), MCP's (`{type: "image", data, mimeType}`, Codex's MCP results), and ACP's wrapping of either
 * (`{type: "content", content: …}`). Anything else in it is left alone.
 */
export function picturesIn(content: unknown, depth = 0): Picture[] {
  if (!content || depth > 3) return [];
  if (Array.isArray(content)) return content.flatMap((c) => picturesIn(c, depth + 1)).slice(0, PICTURES_PER_STEP);
  if (typeof content !== "object") return [];
  const c = content as Record<string, any>;
  if (c.type === "image") {
    const src = c.source && typeof c.source === "object" ? c.source : c;
    const mimeType = String(src.media_type ?? src.mimeType ?? "").toLowerCase();
    const data = typeof src.data === "string" ? src.data : "";
    return TYPES[mimeType] && data && (src.type === undefined || src.type === "base64" || src === c) ? [{ data, mimeType }] : [];
  }
  if (c.type === "content" && c.content) return picturesIn(c.content, depth + 1);
  // An MCP tool's result as Codex hands it: `{ content: [...] }`.
  if (Array.isArray(c.content)) return picturesIn(c.content, depth + 1);
  return [];
}

/** The same answer with each picture's bytes taken out, for the words a step's output keeps (Codex logs its MCP result as JSON). */
export function withoutPictures(content: unknown, depth = 0): unknown {
  if (!content || depth > 3 || typeof content !== "object") return content;
  if (Array.isArray(content)) return content.map((c) => withoutPictures(c, depth + 1));
  const c = content as Record<string, any>;
  if (c.type === "image") return { type: "image", mimeType: String(c.source?.media_type ?? c.mimeType ?? "") };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) out[k] = withoutPictures(v, depth + 1);
  return out;
}

let pruned = false;

/**
 * Each picture as a file in Friday's screenshots folder, named by what is in it (the same screenshot twice is one file), and the
 * paths. One that can't be kept is left out; nothing here stops the step. A tool's pictures older than 30 days are cleared once
 * per run of the runner, so the folder doesn't grow for ever (a picture gone says so in the chat, LiveImage).
 */
export function keepPictures(pictures: readonly Picture[], dir = shotsDir()): string[] {
  const kept: string[] = [];
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return kept;
  }
  if (!pruned) {
    pruned = true;
    try {
      const old = Date.now() - 30 * 24 * 3600_000;
      for (const f of readdirSync(dir)) if (f.startsWith("tool-") && statSync(path.join(dir, f)).mtimeMs < old) unlinkSync(path.join(dir, f));
    } catch {
      // Cleared next time.
    }
  }
  for (const p of pictures.slice(0, PICTURES_PER_STEP)) {
    const ext = TYPES[p.mimeType];
    if (!ext) continue;
    const bytes = Buffer.from(p.data, "base64");
    if (!bytes.length || bytes.length > PICTURE_MAX) continue;
    const file = path.join(dir, `tool-${createHash("sha256").update(bytes).digest("hex").slice(0, 20)}.${ext}`);
    try {
      writeFileSync(file, bytes);
      kept.push(file);
    } catch {
      // Not kept: the step's words still go.
    }
  }
  return kept;
}
