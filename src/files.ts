import { randomBytes } from "node:crypto";
import path from "node:path";
import { blobStore, type Blobs } from "./blobs.js";
import type { Attachment } from "./types.js";

/**
 * Session attachments on local disk: data/uploads/<sid>/<id> plus a JSON
 * sidecar. Files are addressed per session, so an id from one session can't
 * be read through another.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_CHARS = 60_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface StoredFile extends Attachment {
  uploadedBy: string;
  ts: number;
}

const SAFE_ID = /^[\w-]{6,40}$/;

/**
 * A display name that can carry a folder's shape without escaping it.
 *
 * Uploading a folder sends each file as "src/agent/tools.ts", and that path is
 * the useful part: it is how the agent knows where the file sits. It is only
 * shown and sent to the model, never used to open anything (the bytes live
 * under a random id), but it is still stripped of anything that reads as an
 * escape, so it cannot lie about where it came from.
 */
export function safeName(raw: string): string {
  const parts = raw
    .replace(/\\/g, "/")
    .replace(/^[a-zA-Z]:/, "")
    .split("/")
    .map((p) => p.replace(/[\x00-\x1f]/g, "_").trim())
    .filter((p) => p && p !== "." && p !== "..");
  return parts.join("/").slice(-120) || "file";
}

export class FileStore {
  private blobs: Blobs;
  constructor(root: string, blobs?: Blobs) {
    this.blobs = blobs ?? blobStore(root);
  }

  /** A deleted session's files gone (account-delete.ts). */
  async removeSession(sid: string): Promise<void> {
    if (/^[\w-]+$/.test(sid)) await this.blobs.removeAll?.(sid);
  }

  /** Where this deployment is keeping files, for the startup line. */
  get kind() {
    return this.blobs.kind;
  }

  private key(sid: string, id: string) {
    if (!/^[\w-]+$/.test(sid)) throw new Error("bad session id");
    return `${sid}/${id}`;
  }

  async save(sid: string, file: { name: string; type: string; data: Buffer; uploadedBy: string }): Promise<StoredFile> {
    const id = randomBytes(9).toString("base64url");
    const meta: StoredFile = {
      id,
      name: safeName(file.name),
      type: (file.type || "application/octet-stream").slice(0, 100),
      size: file.data.length,
      uploadedBy: file.uploadedBy,
      ts: Date.now(),
    };
    await this.blobs.put(this.key(sid, id), file.data, meta.type);
    await this.blobs.put(this.key(sid, `${id}.json`), Buffer.from(JSON.stringify(meta)), "application/json");
    return meta;
  }

  async get(sid: string, id: string): Promise<{ meta: StoredFile; data: Buffer } | null> {
    if (!SAFE_ID.test(id)) return null;
    try {
      const metaRaw = await this.blobs.get(this.key(sid, `${id}.json`));
      const data = await this.blobs.get(this.key(sid, id));
      if (!metaRaw || !data) return null;
      return { meta: JSON.parse(metaRaw.toString("utf8")) as StoredFile, data };
    } catch {
      return null;
    }
  }
}

// ── turning attachments into model input ─────────────────────────────

export type ResolvedFile =
  | { kind: "text"; name: string; type: string; size: number; text: string; truncated: boolean }
  | { kind: "image" | "pdf"; name: string; type: string; size: number; dataUrl: string }
  | { kind: "binary" | "missing" | "too_large"; name: string; type: string; size: number };

export { ACCEPT_ATTR, isTextLike, isUsableFile } from "./file-kinds.js";
import { isTextLike } from "./file-kinds.js";

/**
 * The bytes, not the name.
 *
 * Names are a guess, and since a file with an unfamiliar extension is now
 * assumed to be text, the guess is wrong in the direction that puts mojibake
 * in a model's context. A NUL byte in the first few kilobytes is what git
 * uses to call something binary, and it is right about everything that
 * matters here.
 */
export function looksBinary(data: Buffer): boolean {
  return data.subarray(0, 8192).includes(0);
}

export async function resolveAttachments(store: FileStore, sid: string, atts: Attachment[]): Promise<Map<string, ResolvedFile>> {
  const out = new Map<string, ResolvedFile>();
  for (const a of atts) {
    if (out.has(a.id)) continue;
    const f = await store.get(sid, a.id);
    if (!f) {
      out.set(a.id, { kind: "missing", name: a.name, type: a.type, size: a.size });
      continue;
    }
    const { meta, data } = f;
    const base = { name: meta.name, type: meta.type, size: meta.size };
    if (isTextLike(meta.name, meta.type) && !looksBinary(data)) {
      const text = data.toString("utf8");
      out.set(a.id, { kind: "text", ...base, text: text.slice(0, MAX_INLINE_CHARS), truncated: text.length > MAX_INLINE_CHARS });
    } else if (/^image\/(png|jpe?g|gif|webp)$/.test(meta.type)) {
      out.set(
        a.id,
        meta.size > MAX_IMAGE_BYTES ? { kind: "too_large", ...base } : { kind: "image", ...base, dataUrl: `data:${meta.type};base64,${data.toString("base64")}` },
      );
    } else if (meta.type === "application/pdf" || /\.pdf$/i.test(meta.name)) {
      out.set(a.id, { kind: "pdf", ...base, dataUrl: `data:application/pdf;base64,${data.toString("base64")}` });
    } else {
      out.set(a.id, { kind: "binary", ...base });
    }
  }
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
