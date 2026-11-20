import { useEffect, useState } from "react";
import { FileIcon } from "./fileIcons.js";
import { Icon } from "./icons.js";
import { ideHint } from "./ide/mode.js";

/**
 * What a crew mate made, as files attached to its message (Arun, 2026-11-15: "make the agent responses in crew and crew rooms feel
 * like responses like short ... NOT FULL WORK FLOW THINGS THAT ARE LIKE IN THE CODING SESSIONS, THE CHAT NEEDS TO FEEL CLEAN AND
 * SIMPLE"): a card each, its name and what it is, opening beside the chat, as a chat app shows an attachment.
 */

export interface MadeFile {
  /** As the lane's folder has it (from its diff), or whole (from the call that wrote it). */
  path: string;
  status: "added" | "modified";
  additions?: number;
  deletions?: number;
  /** Lines written, from the call that wrote it when no diff says. */
  lines?: number;
  /** Its size on disk, for a file found by the name it was given in the message (useNamedFiles). */
  size?: number;
}

/**
 * The files a message names in backticks: a name with an extension and no spaces ("`launch-post.md`", "`notes/plan.md:12`"), not a
 * command, a link or a word in code.
 */
export function namedPaths(texts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of texts)
    for (const m of t.matchAll(/`([^`\s]+)`/g)) {
      const p = m[1]!.replace(/:\d+(?:[-–]\d+)?$/, "");
      // An extension starts with a letter: "v1.2" and "0.2.26" are versions, "2026-11-16-post.md" a file.
      if (/:\/\//.test(p) || !/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(p)) continue;
      out.add(p);
    }
  return [...out].slice(0, 12);
}

type Named = { asked: string; path: string; size: number; changed: number };
const namedCache = new Map<string, Named[]>();

/**
 * The files a crew mate named in its message that it made or changed in its turn (changed since it started), found among the crew's
 * folders by the server (app.ts crew-files): its document shows as a file however it was written, by a command or a patch as much as
 * by a write step (Arun, 2026-11-15: Juno's post, drafted with commands, showed no file). Asked once a turn is over, and kept.
 */
export function useNamedFiles(sid: string, invite: string, lane: string, paths: readonly string[], since: number | undefined, on: boolean): MadeFile[] {
  const key = `${sid}|${lane}|${since ?? 0}|${paths.join("\n")}`;
  const [got, setGot] = useState<Named[] | null>(() => namedCache.get(key) ?? null);
  useEffect(() => {
    if (!on || !paths.length) return setGot(null);
    const kept = namedCache.get(key);
    if (kept) return setGot(kept);
    let live = true;
    const q = new URLSearchParams({ invite, lane });
    for (const p of paths) q.append("path", p);
    fetch(`/api/sessions/${encodeURIComponent(sid)}/crew-files?${q}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ files?: Named[] }>) : { files: [] }))
      .then((b) => {
        namedCache.set(key, b.files ?? []);
        if (live) setGot(b.files ?? []);
      })
      .catch(() => {});
    return () => void (live = false);
  }, [key, on]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!on || !got) return [];
  return got.filter((f) => since === undefined || f.changed >= since - 5_000).map((f) => ({ path: f.path, status: "added" as const, size: f.size }));
}

/** The files named in its message, after those its diff and its write steps gave, each once. */
export function withNamed(made: readonly MadeFile[], named: readonly MadeFile[]): MadeFile[] {
  const same = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
  return [...made, ...named.filter((n) => !OWN.test(n.path) && !made.some((m) => same(m.path, n.path)))];
}

const sizeOf = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** A crew mate's own bookkeeping, never shown as something it made: its memory, its notes, a tool's own folder. */
const OWN = /(^|[\\/])(MEMORY\.md|NOTES?\.md)$|(^|[\\/])\.(friday|claude|codex|git|cursor)[\\/]/i;

/**
 * The files of a turn, once each: its folder's diff first (what is there now), then whatever it wrote outside that folder, by the
 * call that wrote it. One named both ways (a whole path ending in the diff's) is the diff's.
 */
export function madeFilesOf(diff: readonly { path: string; status?: string; additions: number; deletions: number }[], wrote: readonly { path: string; lines: number }[]): MadeFile[] {
  const out: MadeFile[] = [];
  const same = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
  for (const f of diff) {
    if (OWN.test(f.path) || f.status === "deleted") continue;
    out.push({ path: f.path, status: f.status === "added" ? "added" : "modified", additions: f.additions, deletions: f.deletions });
  }
  for (const w of wrote) {
    if (OWN.test(w.path) || out.some((o) => same(o.path, w.path))) continue;
    out.push({ path: w.path, status: "added", lines: w.lines });
  }
  return out;
}

const KINDS: [RegExp, string][] = [
  [/\.(md|markdown|mdx)$/i, "Markdown"],
  [/\.txt$/i, "Text"],
  [/\.csv$/i, "Spreadsheet"],
  [/\.(xlsx|xls|numbers)$/i, "Spreadsheet"],
  [/\.(docx?|pages|rtf)$/i, "Document"],
  [/\.(pptx?|key)$/i, "Slides"],
  [/\.pdf$/i, "PDF"],
  [/\.html?$/i, "Web page"],
  [/\.(png|jpe?g|gif|webp|svg|avif)$/i, "Image"],
  [/\.(mp4|mov|webm)$/i, "Video"],
  [/\.(json|ya?ml|toml)$/i, "Data"],
  [/\.(ts|tsx|js|jsx|mjs|py|rb|go|rs|swift|kt|java|c|cpp|h|cs|php|sh|sql|css|scss)$/i, "Code"],
];
export const kindOf = (path: string) => KINDS.find(([re]) => re.test(path))?.[1] ?? "File";

function metaOf(f: MadeFile): string {
  const kind = kindOf(f.path);
  if (f.status === "modified") return `${kind} · edited${f.additions || f.deletions ? ` +${f.additions ?? 0} −${f.deletions ?? 0}` : ""}`;
  if (f.size !== undefined) return `${kind} · ${sizeOf(f.size)}`;
  const n = f.lines ?? f.additions ?? 0;
  return n ? `${kind} · ${n} line${n === 1 ? "" : "s"}` : kind;
}

const SHOWN = 3;

export function MadeFiles({ files, lane, onMore }: { files: readonly MadeFile[]; lane: string; onMore?: () => void }) {
  if (!files.length) return null;
  const open = (path: string) => dispatchEvent(new CustomEvent("friday:open-file", { detail: { path, lane }, cancelable: true }));
  return (
    <div className="mf" role="list" aria-label="Files it made">
      {files.slice(0, SHOWN).map((f) => {
        const name = f.path.split(/[\\/]/).pop() ?? f.path;
        return (
          <button key={f.path} type="button" role="listitem" className="mf-card" title={`Open ${f.path}${ideHint()}`} onClick={() => open(f.path)}>
            <span className="mf-tile" aria-hidden="true">
              <FileIcon path={f.path} size={18} />
            </span>
            <span className="mf-text">
              <span className="mf-name">{name}</span>
              <span className="mf-meta">{metaOf(f)}</span>
            </span>
            <span className="mf-go" aria-hidden="true">
              <Icon name="panelRight" size={14} />
            </span>
          </button>
        );
      })}
      {files.length > SHOWN && (
        <button type="button" className="mf-more" onClick={onMore ?? (() => open(files[SHOWN]!.path))}>
          {files.length - SHOWN} more file{files.length - SHOWN === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}
