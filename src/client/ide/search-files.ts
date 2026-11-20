import { ide } from "./api.js";
import type { Identity } from "../storage.js";

/**
 * The folder's file list for Friday's one search, kept per folder so the window opens with it already there (Arun, 2026-11-20:
 * "results within ~50 ms for files on a 20k-file repo (cache the listing per folder, refresh on focus)"). The runner's list is
 * git's files and untracked ones not ignored (ide.files); it is asked once when Code shows a folder, again when the window gets
 * focus back (files change while you were elsewhere) and each time the search opens if it is a while old.
 */
interface Entry { files: string[]; at: number; asking?: Promise<string[]>; /** The runner did not answer the last time. */ failed?: boolean; /** More files than the runner lists (it stops at 50 000). */ truncated?: boolean }
const cache = new Map<string, Entry>();
/** A listing this young is used as it is when the search opens. */
const FRESH_MS = 8000;

export const cachedFiles = (root: string): string[] | null => cache.get(root)?.files ?? null;
/** How the last listing went, for one quiet line in the window: not read at all, or cut short. */
export const listingState = (root: string): { failed: boolean; truncated: boolean } => {
  const e = cache.get(root);
  return { failed: !!e?.failed && !e.files.length, truncated: !!e?.truncated };
};

/** Ask the runner for the folder's files (once at a time), unless the one kept is young. `force`: always ask. */
export function loadFiles(identity: Identity, root: string, force = false): Promise<string[]> {
  const e = cache.get(root);
  if (e?.asking) return e.asking;
  if (e && !force && Date.now() - e.at < FRESH_MS) return Promise.resolve(e.files);
  const asking = ide(identity, "files", { root }).then(
    (r) => {
      cache.set(root, { files: r.files, at: Date.now(), truncated: r.truncated });
      return r.files;
    },
    () => {
      // The runner didn't answer: what was kept stands, and the next open asks again.
      const kept = cache.get(root);
      cache.set(root, { files: kept?.files ?? [], at: 0, failed: true, ...(kept?.truncated ? { truncated: true } : {}) });
      return kept?.files ?? [];
    },
  );
  cache.set(root, { files: e?.files ?? [], at: e?.at ?? 0, asking, ...(e?.truncated ? { truncated: true } : {}) });
  return asking;
}

/**
 * Asks again when the window gets focus back, for the folder Code shows, but not when the kept listing is young (loadFiles keeps it
 * for FRESH_MS) and not when focus only comes back from the IDE's frame: that happens at every click in the chat column or the
 * window bar, and a listing is two git runs and up to 50 000 paths over the wire.
 */
export function refreshOnFocus(identity: Identity, root: () => string | null): () => void {
  let fromFrame = false;
  const off = () => void (fromFrame = document.activeElement instanceof HTMLIFrameElement);
  const on = () => {
    if (fromFrame) return void (fromFrame = false);
    const r = root();
    if (r) void loadFiles(identity, r);
  };
  window.addEventListener("blur", off);
  window.addEventListener("focus", on);
  return () => (window.removeEventListener("blur", off), window.removeEventListener("focus", on));
}
