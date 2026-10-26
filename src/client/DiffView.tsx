import { FileIcon } from "./fileIcons.js";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import styles from "@/components/aicss/FileDiff.module.css";
import { AgentCodeLine, useAgentCodeTokens, type AgentCodeLanguage, type AgentCodeToken } from "@/components/agents/agent-code";
import { Checkbox } from "@/components/motion/checkbox";
import { Icon } from "./icons.js";
import { watchersOf } from "../focus.js";
import { diffHere, useFocus } from "./focusStore.js";
import { takesShowDiff } from "./focusDiff.js";
import { splitPath, splitRows, wordMarks } from "./diff-lines.js";

/**
 * The highlighter's language for a path.
 *
 * By extension, and by filename where the name is the only clue — a Dockerfile
 * and a Makefile have no extension to read. Anything not listed is shown plain
 * rather than guessed at: a wrong grammar colours code as if it were something
 * else, which is worse than no colour at all.
 */
const BY_EXTENSION: Record<string, AgentCodeLanguage> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx", jsx: "tsx", js: "tsx", mjs: "tsx", cjs: "tsx",
  json: "json", jsonc: "json", json5: "json",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  py: "python", pyi: "python",
  rb: "ruby", rake: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  swift: "swift",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp",
  php: "php",
  css: "css", scss: "css", less: "css",
  html: "html", htm: "html", vue: "html", svelte: "html",
  xml: "xml", svg: "xml",
  sql: "sql",
  yml: "yaml", yaml: "yaml",
  toml: "toml",
  md: "markdown", mdx: "markdown", markdown: "markdown",
  patch: "diff", diff: "diff",
};

const BY_NAME: Record<string, AgentCodeLanguage> = {
  dockerfile: "bash",
  makefile: "bash",
  ".env": "bash",
  ".gitignore": "bash",
  ".bashrc": "bash",
  ".zshrc": "bash",
};

export function languageFor(path: string): AgentCodeLanguage {
  const name = path.toLowerCase().split(/[\\/]/).pop() ?? "";
  if (BY_NAME[name]) return BY_NAME[name];
  const ext = name.includes(".") ? (name.split(".").at(-1) ?? "") : "";
  return BY_EXTENSION[ext] ?? "text";
}

/**
 * One file's change, drawn the aicss way: a hairline header with the path and
 * its counts, a gutter of old and new line numbers, and a bar down the left of
 * every added or removed line. Folds on its header, and a line can be
 * commented on from its gutter. Unified, or old and new side by side, with the
 * part of an edited line that changed marked in both.
 */

export interface DiffLine {
  id: string;
  type?: "added" | "removed" | "context";
  oldLine?: number;
  newLine?: number;
  content: string;
}

export type DiffMode = "unified" | "split";
export type FileChange = "added" | "modified" | "deleted" | "renamed";

const BADGE: Record<FileChange, [string, string]> = { added: ["A", "Added"], modified: ["M", "Modified"], deleted: ["D", "Deleted"], renamed: ["R", "Renamed"] };

export function DiffView({
  path,
  status,
  change,
  lines,
  defaultOpen = true,
  maxHeight = 420,
  onComment,
  annotations,
  copyText,
  contended,
  risks = [],
  viewed,
  onViewed,
  expand,
  mode = "unified",
  marked,
  by,
  note,
}: {
  path: string;
  /** Said after the path when there is something to say about the change itself ("cut short"). */
  status?: string;
  /** Added, modified, deleted or renamed: the letter at the start of its header. */
  change?: FileChange;
  /** Another lane has changed this file too, in this many words. */
  contended?: string;
  /** Why this file deserves a careful look (code-review.ts reviewOrder), as chips on its header. */
  risks?: string[];
  lines: DiffLine[];
  defaultOpen?: boolean;
  maxHeight?: number;
  /** A note on a line; with `range`, on a block of lines ending at it (shift-click from an earlier line). */
  onComment?: (line: DiffLine, range?: DiffLine[]) => void;
  annotations?: Record<string, ReactNode>;
  /** Lines a note is about, marked along their edge. */
  marked?: ReadonlySet<string>;
  /** Who wrote an added line by hand (attribution.ts), or null for the agent's: a pencil in its gutter. */
  by?: (line: DiffLine) => string | null;
  /** A word on the change itself for the header ("2 lines by hand (Ada)"). */
  note?: string;
  copyText?: string;
  /** Reviewed already: shown ticked, and folded away when it becomes so. */
  viewed?: boolean;
  /** Present when there is a list of files to work through; the box is shown only then. */
  onViewed?: (v: boolean) => void;
  /** "Expand all" and "Collapse all", as a counter so pressing the same one twice still works. */
  expand?: { open: boolean; n: number };
  /** One column, or old and new side by side. */
  mode?: DiffMode;
}) {
  const [open, setOpen] = useState(defaultOpen && !viewed);
  // Who else is on a line of this file, and where this person's pointer is. Said to the room as it moves.
  const focus = useFocus();
  const says = diffHere(focus.here, path);
  const root = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);
  // Asked for by name (a warning that another session is changing this file): opened, brought into view and lit for a moment.
  // Only the copy in the Diff panel answers: the one in the chat is not where somebody went to look.
  useEffect(() => {
    const on = (e: Event) => {
      if (!takesShowDiff(e, path, root.current)) return;
      setOpen(true);
      requestAnimationFrame(() => root.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
      setFlash(true);
      setTimeout(() => setFlash(false), 2000);
    };
    window.addEventListener("friday:show-diff", on);
    return () => window.removeEventListener("friday:show-diff", on);
  }, [path]);
  // Hidden or gone, this diff says nothing about where this person is: the tree's file shows again, or nowhere.
  useEffect(() => says.gone, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [copied, setCopied] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  // Each press once, and each tick once: these effects run again whenever a Diff panel kept in the workbench is shown, and
  // that must not fold back up what somebody opened since.
  const pressed = useRef(0);
  useEffect(() => {
    if (!expand || expand.n <= 0 || expand.n === pressed.current) return;
    pressed.current = expand.n;
    setOpen(expand.open);
  }, [expand?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  // Ticking a file off puts it away: that is what "I have read this" means.
  const wasViewed = useRef(!!viewed);
  useEffect(() => {
    if (viewed && !wasViewed.current) setOpen(false);
    wasViewed.current = !!viewed;
  }, [viewed]);
  const added = lines.filter((l) => l.type === "added").length;
  const removed = lines.filter((l) => l.type === "removed").length;
  // Syntax colours, so a diff reads as code and not as a wall of one colour.
  // Tokenised once for the whole file; each row takes its own line's tokens.
  const language = languageFor(path);
  const tokens = useAgentCodeTokens(open && language !== "text" ? lines.map((l) => l.content).join("\n") : "", language);
  const at = useMemo(() => new Map(lines.map((l, i) => [l.id, i])), [lines]);
  const marks = useMemo(() => (open ? wordMarks(lines) : new Map<string, [number, number]>()), [open, lines]);
  const rows = useMemo(() => (open && mode === "split" ? splitRows(lines) : []), [open, mode, lines]);
  const { dir, name } = splitPath(path);

  const copy = async (text: string, done: (v: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(text);
      done(true);
      setTimeout(() => done(false), 1500);
    } catch {
      // Clipboard refused; nothing else to do.
    }
  };
  const code = (l: DiffLine) => <Code code={l.content} tokens={tokens?.[at.get(l.id) ?? -1]} mark={marks.get(l.id)} />;
  const here = (l: DiffLine) => says.row(l.newLine ?? l.oldLine ?? 0);
  // The last line a note was started on: a shift-click on another line makes the note about the block between them.
  const anchor = useRef<string | null>(null);
  const commentButton = (l: DiffLine) =>
    onComment && (
      <button
        type="button"
        className="rsp-row-comment"
        aria-label={`Note on line ${l.newLine ?? l.oldLine}`}
        title="Add a note for the agent on this line · shift-click another line to make it a range"
        onClick={(e) => {
          const a = anchor.current !== null ? at.get(anchor.current) : undefined;
          const b = at.get(l.id);
          if (e.shiftKey && a !== undefined && b !== undefined && a !== b) {
            const [s, t] = a < b ? [a, b] : [b, a];
            const range = lines.slice(s, t + 1).filter((x) => x.oldLine !== undefined || x.newLine !== undefined);
            anchor.current = null;
            onComment(range.at(-1)!, range);
            return;
          }
          anchor.current = l.id;
          onComment(l);
        }}
      >
        +
      </button>
    );
  const noted = (l: DiffLine) => `${marked?.has(l.id) ? " rsp-noted" : ""}${by?.(l) ? " rsp-by-hand" : ""}`;
  const handTitle = (l: DiffLine) => {
    const who = by?.(l);
    return who ? { title: who === "hand" ? "Written by hand, not by the agent" : `Written by hand by ${who}` } : {};
  };

  return (
    <div ref={root} data-path={path} className={`${styles.diff} rsp-diff ${open ? "" : "rsp-diff-closed"} ${viewed ? "rsp-diff-viewed" : ""} ${flash ? "rsp-diff-flash" : ""}`}>
      <div className="rsp-diff-top">
        {onViewed && (
          // The whole strip beside the file is the target, not just the box in it:
          // a 14px square is a small thing to aim at, and this is pressed forty
          // times in a long review.
          <div
            className="rsp-viewed"
            data-uicheck-ok="small-target"
            title={viewed ? "Mark as not reviewed (v)" : "Mark as reviewed (v)"}
            onClick={(e) => {
              if (!(e.target as HTMLElement).closest("button")) onViewed(!viewed);
            }}
          >
            <Checkbox checked={!!viewed} onCheckedChange={onViewed} aria-label={`${path} reviewed`} />
          </div>
        )}
        <button type="button" className={`${styles.diffHead} rsp-diff-head`} aria-expanded={open} title={path} onClick={() => setOpen(!open)}>
          <span className={`${styles.diffFileWrap} dv-file`}>
            <span className={`rsp-caret side ${open ? "open" : ""}`} aria-hidden />
            {/* The file's own mark, as the editor shows it; then the name, what a reader looks for; the folder after it, faint,
                and the first thing to give way. */}
            <FileIcon path={path} size={16} />
            <span className={`${styles.diffFile} dv-name`}>{name}</span>
            {dir && <span className="dv-dir">{dir.replace(/\/$/, "")}</span>}
            {status && <span className="rsp-diff-status">{status}</span>}
            {/* On the header, because the collision is about the file rather
                than about any line in it — and because this is the moment
                somebody is deciding whether to trust the change. */}
            {note && (
              <span className="rsp-diff-risk rsp-diff-hand" title="Added lines that a person wrote or changed by hand, not the agent">
                {note}
              </span>
            )}
            {risks.map((r) => (
              <span key={r} className="rsp-diff-risk">
                {r}
              </span>
            ))}
            {contended && (
              <span className="rsp-diff-contended" title={contended}>
                <Icon name="users" size={11} />
                {contended}
              </span>
            )}
          </span>
          {/* What happened to it, as a letter at the end of the row, where the editor's changes view puts it. */}
          {change && (
            <span className={`dv-badge ${change}`} title={BADGE[change][1]} aria-label={BADGE[change][1]}>
              {BADGE[change][0]}
            </span>
          )}
          <span className={`${styles.diffStat} dv-stat`}>
            <span className={`${styles.add} rsp-add`}>+{added}</span>
            <span className={`${styles.del} rsp-del`}>-{removed}</span>
            <ChangeBar adds={added} dels={removed} />
          </span>
        </button>
        <span className="dv-actions">
          {change !== "deleted" && (
            <button type="button" className="icon-btn tiny rsp-path-copy" title="Open in the tree" aria-label={`Open ${path} in the tree`} onClick={() => window.dispatchEvent(new CustomEvent("friday:open-file", { detail: { path } }))}>
              <Icon name="folderOpen" size={12} />
            </button>
          )}
          <button type="button" className="icon-btn tiny rsp-path-copy" title={pathCopied ? "Copied" : "Copy the path"} aria-label={pathCopied ? "Path copied" : `Copy the path of ${path}`} onClick={() => void copy(path, setPathCopied)}>
            <Icon name={pathCopied ? "check" : "copy"} size={12} />
          </button>
        </span>
      </div>
      {open && (
        <>
          <div className={`${styles.diffBody} ${mode === "split" ? "dv-split-body" : ""}`} style={{ maxHeight, overflowY: "auto" }}>
            {mode === "split" ? (
              <div className="dv-split">
                {rows.map((r, i) => {
                  if ("hunk" in r)
                    return (
                      <div key={r.hunk.id} className="dv-hunk">
                        {r.hunk.content}
                      </div>
                    );
                  const same = r.left === r.right;
                  return (
                    <div key={`${r.left?.id ?? ""}-${r.right?.id ?? ""}-${i}`}>
                      <div className="dv-srow">
                        {(["left", "right"] as const).map((side) => {
                          const l = r[side];
                          if (!l) return <div key={side} className="dv-cell empty" aria-hidden />;
                          const kind = same ? "ctx" : l.type === "added" ? "add" : "del";
                          const n = side === "left" ? l.oldLine : l.newLine;
                          return (
                            <div key={side} className={`dv-cell ${kind}${noted(l)}`} {...here(l)} {...handTitle(l)}>
                              <span className="dv-ln">
                                {(side === "right" || l.type === "removed") && commentButton(l)}
                                {n ?? ""}
                              </span>
                              <code>{code(l)}</code>
                              {side === "right" && <Watchers who={watchersOf(focus.others, path, l.newLine ?? l.oldLine ?? 0)} />}
                            </div>
                          );
                        })}
                      </div>
                      {r.left && annotations?.[r.left.id]}
                      {r.right && !same && annotations?.[r.right.id]}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className={styles.diffLines}>
                {lines.map((l) => {
                  // Hunk headers ("@@ … @@") carry no line number and nothing to comment on.
                  const hunk = l.oldLine === undefined && l.newLine === undefined;
                  const kind = l.type === "added" ? "add" : l.type === "removed" ? "del" : "ctx";
                  return (
                    <div key={l.id}>
                      <div className={`${styles.diffRow} ${styles[kind]} ${hunk ? "rsp-hunk" : ""} rsp-row rsp-line ${kind}${noted(l)}`} {...(hunk ? {} : here(l))} {...handTitle(l)}>
                        <span className={`${styles.ln} ${styles.old} rsp-ln-old`}>
                          {!hunk && commentButton(l)}
                          {l.oldLine ?? ""}
                        </span>
                        <span className={`${styles.ln} ${styles.new} rsp-ln-new`}>{l.newLine ?? ""}</span>
                        <span className={`${styles.sign} rsp-sign`}>{l.type === "added" ? "+" : l.type === "removed" ? "-" : ""}</span>
                        <code>{hunk ? l.content : code(l)}</code>
                        {!hunk && <Watchers who={watchersOf(focus.others, path, l.newLine ?? l.oldLine ?? 0)} />}
                      </div>
                      {annotations?.[l.id]}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {copyText && (
            <div className="rsp-diff-foot">
              <button type="button" className="icon-btn tiny" aria-label={copied ? "Patch copied" : "Copy patch"} title={copied ? "Copied" : "Copy patch"} onClick={() => void copy(copyText, setCopied)}>
                <Icon name={copied ? "check" : "copy"} size={13} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * A line of code, coloured, with the part that changed marked. The highlighter's tokens are cut where the mark starts and ends,
 * so the line keeps its colours and the mark sits on top of them.
 */
function Code({ code, tokens, mark }: { code: string; tokens?: AgentCodeToken[] | undefined; mark?: [number, number] | undefined }) {
  if (!mark) return <AgentCodeLine code={code} tokens={tokens} />;
  const parts: { content: string; light?: string | undefined; dark?: string | undefined }[] = tokens ?? [{ content: code }];
  const out: ReactNode[] = [];
  let at = 0;
  parts.forEach((t, k) => {
    const s = at;
    const e = at + t.content.length;
    at = e;
    const c1 = Math.min(Math.max(mark[0], s), e);
    const c2 = Math.min(Math.max(mark[1], c1), e);
    const style = { "--agent-code-light": t.light ?? "currentColor", "--agent-code-dark": t.dark ?? t.light ?? "currentColor" } as CSSProperties;
    const pieces: [number, number, boolean][] = [
      [s, c1, false],
      [c1, c2, true],
      [c2, e, false],
    ];
    pieces.forEach(([a, b, marked], j) => {
      if (b <= a) return;
      out.push(
        <span key={`${k}-${j}`} style={style} className={`text-[var(--agent-code-light)] dark:text-[var(--agent-code-dark)]${marked ? " dv-word" : ""}`}>
          {t.content.slice(a - s, b - s)}
        </span>,
      );
    });
  });
  return <span>{out}</span>;
}

/** Five squares, green for what was added and red for what was taken out, the way a reader weighs a file at a glance. */
export function ChangeBar({ adds, dels }: { adds: number; dels: number }) {
  const total = adds + dels;
  // Each side gets at least one square when it has any lines at all.
  const green = !total ? 0 : Math.min(dels ? 4 : 5, Math.max(adds ? 1 : 0, Math.round((adds / total) * 5)));
  const red = dels ? 5 - green : 0;
  return (
    <span className="dv-bar" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <i key={i} className={i < green ? "a" : i < green + red ? "d" : ""} />
      ))}
    </span>
  );
}

/** Small marks at the end of a line for the people who are reading it right now. */
function Watchers({ who }: { who: { id: string; name: string }[] }) {
  if (!who.length) return null;
  return (
    <span className="rsp-watchers" aria-label={`${who.map((w) => w.name).join(", ")} ${who.length === 1 ? "is" : "are"} reading this line`}>
      {who.slice(0, 3).map((w) => (
        <span key={w.id} className="rsp-watcher" title={`${w.name} is reading this`} style={{ ["--w" as string]: `var(--c-${hue(w.id)})` }}>
          {w.name.trim().slice(0, 1).toUpperCase()}
        </span>
      ))}
      {who.length > 3 && <span className="rsp-watcher more">+{who.length - 3}</span>}
    </span>
  );
}

/** One of a few steady hues per person, so the same face is the same colour everywhere in a diff. */
function hue(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 6;
}
