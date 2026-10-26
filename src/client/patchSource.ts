import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { DiffFile } from "../types.js";

/**
 * The session a change set's patches are fetched from (session/patches.ts): a page opening a session is sent the older change
 * sets by name and counts only, and a file's text comes when its card is opened.
 */
export const PatchSource = createContext<{ sid: string; invite: string } | null>(null);

/** Change sets already fetched, by session and seq: each is the same for good, so it is asked for once. */
const fetched = new Map<string, Promise<DiffFile[]>>();

function changeSet(sid: string, invite: string, seq: number): Promise<DiffFile[]> {
  const key = `${sid}:${seq}`;
  let p = fetched.get(key);
  if (!p) {
    p = fetch(`/api/sessions/${encodeURIComponent(sid)}/diff?seq=${seq}&invite=${encodeURIComponent(invite)}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? (r.json() as Promise<{ files: DiffFile[] }>) : Promise.reject(new Error(String(r.status)))))
      .then((j) => j.files);
    // A failed fetch is tried again the next time the card is opened.
    p.catch(() => fetched.delete(key));
    fetched.set(key, p);
  }
  return p;
}

/**
 * `files` with the text of those left on the server filled in, once `open` (a folded card asks for nothing: a long session has
 * a hundred of them). Until it has come, those files are as they were, with no patch to draw.
 */
export function useFullFiles(files: DiffFile[], open = true): { files: DiffFile[]; loading: boolean } {
  const src = useContext(PatchSource);
  const seqs = useMemo(() => [...new Set(files.flatMap((f) => (f.later ? [f.later] : [])))], [files]);
  const [got, setGot] = useState<Map<number, DiffFile[]>>(() => new Map());
  const want = open && !!src && seqs.some((q) => !got.has(q));
  useEffect(() => {
    if (!want || !src) return;
    let on = true;
    void Promise.all(seqs.map((q) => changeSet(src.sid, src.invite, q).then((fs) => [q, fs] as const)))
      .then((all) => on && setGot((m) => new Map([...m, ...all])))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [want, src?.sid, src?.invite, seqs.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const full = useMemo(
    () =>
      !seqs.length
        ? files
        : files.map((f) => {
            const whole = f.later ? got.get(f.later)?.find((x) => x.path === f.path && !!x.patch) : undefined;
            if (!whole) return f;
            const { later: _, ...rest } = f;
            return { ...rest, patch: whole.patch };
          }),
    [files, got, seqs],
  );
  return { files: full, loading: want };
}
