import { memo, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import remarkMath from "remark-math";
import type { Pluggable } from "unified";
import { defaultRehypePlugins, defaultRemarkPlugins, parseMarkdownIntoBlocks, useIsCodeFenceIncomplete, type Components } from "streamdown";
import { AgentCodeLine, useAgentCodeTokens, type AgentCodeLanguage } from "@/components/agents/agent-code";
import { pathOf, rehypeAnswer, rehypeFileChips, rehypeFileLinks } from "./answer-format.js";
import { languageFor } from "./DiffView.js";
import { FileIcon } from "./fileIcons.js";
import { Icon } from "./icons.js";
import { IS_MAC } from "./Shortcuts.js";
import { LiveBlock, LiveImage } from "./LiveBlock.js";
import { localPicture } from "./LiveBlock.js";
import { chipLabel, titlesChanged, titlesNow } from "./work-outputs.js";

/**
 * The parts an agent's answer is drawn with in the chat: a file it names is a chip that opens the file, a code block has its
 * language and a copy button and is coloured once it is complete, and ```html, ```svg and ```mermaid are drawn live.
 */

const LIVE = new Set(["html", "svg", "mermaid"]);
const NAMED = new Set<string>(["bash", "c", "cpp", "csharp", "css", "diff", "go", "html", "java", "json", "kotlin", "markdown", "php", "python", "ruby", "rust", "sql", "swift", "toml", "tsx", "typescript", "xml", "yaml"]);
const ALIAS: Record<string, AgentCodeLanguage> = { sh: "bash", shell: "bash", shellscript: "bash", zsh: "bash", console: "bash", terminal: "bash", powershell: "bash", ps1: "bash", javascript: "tsx", golang: "go", "c++": "cpp", "c#": "csharp", jsonc: "json", patch: "diff" };

/** The highlighter's grammar for a fence's language, or plain text for one it doesn't know. */
export const codeLanguage = (lang: string): AgentCodeLanguage => {
  const l = lang.toLowerCase();
  return NAMED.has(l) ? (l as AgentCodeLanguage) : (ALIAS[l] ?? (l ? languageFor(`x.${l}`) : "text"));
};

/** The text of a code element's children, as the renderer hands them over. */
const textOf = (c: ReactNode): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map(textOf).join("") : c && typeof c === "object" && "props" in c ? textOf((c.props as { children?: ReactNode }).children) : "";

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const t = useRef(0);
  useEffect(() => () => clearTimeout(t.current), []);
  return [
    copied,
    () =>
      void navigator.clipboard?.writeText(text).then(() => {
        setCopied(true);
        clearTimeout(t.current);
        t.current = window.setTimeout(() => setCopied(false), 1500);
      }),
  ] as const;
}

/**
 * A file the answer names: pressed, it opens in the session's file view; where there is none (a replay), it copies the path.
 * ⌘-pressed (Ctrl elsewhere) in the desktop app, it opens in your own editor at its line instead.
 */
function FileChip({ text, path, line }: { text: string; path: string; line?: number }) {
  const [copied, copy] = useCopy(path);
  useSyncExternalStore(titlesChanged, titlesNow, titlesNow); // its title as the rail learns it, not as it was when first drawn
  const open = (e: { metaKey: boolean; ctrlKey: boolean; currentTarget: EventTarget }) => {
    const outside = e.metaKey || e.ctrlKey;
    // Whose message it is in: a path is in that agent's folder (a Crew teammate's own, another agent's copy), not the session's.
    const said = (e.currentTarget as HTMLElement).closest?.<HTMLElement>("[data-lane]")?.dataset.lane;
    const lane = said && said !== "main" ? said : undefined;
    // The session view takes the event and says so; nobody taking it means there is no file view here.
    const taken = !window.dispatchEvent(new CustomEvent("friday:open-file", { detail: { path, line, outside, ...(lane ? { lane } : {}) }, cancelable: true }));
    if (!taken) copy();
  };
  return (
    <button type="button" className="file-chip" onClick={open} title={copied ? "Path copied" : `Open ${path}${line ? ` at line ${line}` : ""}${window.fridayDesktop?.openIn ? ` · ${IS_MAC ? "⌘" : "Ctrl"}-click for your editor` : ""}`} aria-label={`Open ${text}`}>
      <FileIcon path={path} size={14} />
      <code>{text}</code>
      {/* The piece by its title, in the page's own type, where the session shows titles in place of paths (the 2026-10-28 critique). */}
      {/* No space after it on its line: inside the button it was a gap before the full stop that followed ("playbook ."). */}
      <span className="file-chip-title">{chipLabel(text, path)}</span>
    </button>
  );
}

/** A fenced block of code: its language, a copy button, and colour once the agent has finished writing it. */
function AnswerCode({ code, language, incomplete }: { code: string; language: string; incomplete: boolean }) {
  const lang = codeLanguage(language);
  // Coloured a line at a time as it streams (Arun, 2026-10-20: "smoother… the text doesn't flicker"): every finished line
  // takes its colour as the next begins, and only the line being written is plain, so a block never turns from plain to
  // coloured all at once when it ends. Whole lines only, so a colour never lags the text inside a line; the highlighter keeps
  // the lines it has while it colours the next, and its cache makes the finished block draw coloured the moment it moves.
  const settled = incomplete ? code.slice(0, code.lastIndexOf("\n") + 1) : code;
  const tokens = useAgentCodeTokens(settled, settled ? lang : "text");
  const writing = incomplete && !code.endsWith("\n");
  const [copied, copy] = useCopy(code);
  const lines = code.replace(/\n+$/, "").split("\n");
  return (
    <div className="ans-code" data-streamdown="code-block" data-language={language || undefined}>
      <div className="ans-code-head">
        <span className="ans-code-lang">{language || "code"}</span>
        {!incomplete && (
          <button type="button" className="icon-btn tiny" title={copied ? "Copied" : "Copy the code"} aria-label="Copy the code" onClick={copy}>
            <Icon name={copied ? "check" : "copy"} size={13} />
          </button>
        )}
      </div>
      {/* Focusable, so a long line can be scrolled to from the keyboard. */}
      <pre className="ans-code-body" tabIndex={0} aria-label={`${language || "Code"} code`}>
        <code>
          {lines.map((l, i) => (
            <span key={i}>
              <AgentCodeLine code={l} tokens={writing && i === lines.length - 1 ? undefined : tokens?.[i]} />
              {i < lines.length - 1 ? "\n" : null}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

/** Whether a picture or video named in an answer shows under its name, when a build turns it on (MediaChip). */
const chips = { on: false };
/**
 * A picture or video named in the answer shows under its name, a block of its own, so the full stop the sentence ends with right
 * after the name fell under the picture and opened the next line (". The research is in …", 2026-10-27 design review). Where
 * they show, the one mark of punctuation straight after a picture's or video's name is left out: the picture closes the sentence.
 */
export const mediaText = (md: string): string => (chips.on ? md.replace(/(`[^`\n]+\.(?:png|jpe?g|gif|webp|avif|svg|mp4|mov|webm|m4v)`)[.,;:](?=\s|$)/gi, "$1") : md);

/** A picture or video an agent names in its answer: the name, and the thing itself under it, from this computer. */
const MEDIA = /\.(png|jpe?g|gif|webp|avif|svg|mp4|mov|webm|m4v)$/i;
chips.on = true;
function MediaChip({ text, path }: { text: string; path: string }) {
  const src = localPicture(path);
  const video = /\.(mp4|mov|webm|m4v)$/i.test(path);
  // A video still being written is asked for again twice before it is said to be missing (LiveImage does the same for pictures).
  const [tries, setTries] = useState(0);
  const [gone, setGone] = useState(false);
  const at = src && tries ? `${src}&try=${tries}` : src;
  return (
    <span className="chat-media">
      {/* Its name, not its whole path: a long folder path broke across two lines over the picture. The path is in the tooltip. */}
      <FileChip text={text.split("/").pop() || text} path={path} />
      {at && !gone && <span className="chat-media-view">{video ? <video key={tries} src={`${at}#t=0.1`} controls preload="metadata" playsInline onError={() => (tries < 2 ? void window.setTimeout(() => setTries((n) => n + 1), 1500 * (tries + 1)) : setGone(true))} /> : <LiveImage src={src!} alt={text} />}</span>}
      {gone && (
        <span className="chat-media-gone">
          This video isn't on this computer, or isn't finished yet.{" "}
          <button type="button" className="link-btn" onClick={() => (setGone(false), setTries((n) => n + 1))}>
            Try again
          </button>
        </span>
      )}
    </span>
  );
}

type CodeProps = { node?: unknown; className?: string; children?: ReactNode; "data-block"?: string; /** A link to a file, by its words (rehypeFileChips). */ "data-file-link"?: string };

function Code({ node: _node, className, children, ...rest }: CodeProps) {
  const incomplete = useIsCodeFenceIncomplete();
  // The renderer marks a fenced block's code with data-block; without it this is code inside a sentence.
  if (!("data-block" in rest)) {
    const text = textOf(children);
    // A link to a file: its chip, with the link's words (answer-format.ts rehypeFileLinks).
    const linked = rest["data-file-link"];
    if (linked !== undefined && MEDIA.test(text)) return <MediaChip text={linked} path={text} />;
    if (linked !== undefined) return <FileChip text={linked} path={text} />;
    const file = pathOf(text);
    if (file && MEDIA.test(file.path)) return <MediaChip text={text} path={file.path} />;
    if (file) return <FileChip text={text} {...file} />;
    return (
      <code className={className} data-streamdown="inline-code">
        {children}
      </code>
    );
  }
  const language = className?.match(/language-(\S+)/)?.[1] ?? "";
  const code = textOf(children);
  if (MEDIA.test(code.trim()) && !/\s/.test(code.trim())) return <MediaChip text={code.trim()} path={code.trim()} />;
  if (LIVE.has(language.toLowerCase())) return <LiveBlock code={code} language={language} isIncomplete={incomplete} />;
  return <AnswerCode code={code} language={language} incomplete={incomplete} />;
}

// Re-drawn only when what it shows changes: the tree node is new on every parse of its block, its content isn't.
const AnswerCodeTag = memo(Code, (a, b) => a.className === b.className && textOf(a.children) === textOf(b.children) && "data-block" in a === "data-block" in b && a["data-file-link"] === b["data-file-link"]);

/**
 * KaTeX, loaded the first time an answer has maths in it rather than with the feed: 340 KB of script that most sessions never
 * use, on the way to every session screen (engineering/perf/load.md). An answer with maths isn't drawn until it is here
 * (MessageResponse asks with useKatex), so an equation never shows as its source first. Asked for, too, once the page has
 * loaded and the browser is idle, so an answer that streams maths later rarely waits.
 */
type RehypeKatex = typeof import("rehype-katex").default;
let katex: RehypeKatex | null = null;
let katexLoad: Promise<void> | null = null;
const katexSubs = new Set<() => void>();
export function loadKatex(): Promise<void> {
  katexLoad ??= import("rehype-katex").then((m) => {
    katex = m.default;
    for (const f of katexSubs) f();
  });
  return katexLoad;
}
/** Whether a text has maths for KaTeX in it, as remark-math reads it here: $$…$$ (no single dollars) or a ```math fence. */
export const hasMath = (md: string) => md.includes("$$") || /^\s*(```|~~~)\s*math\b/m.test(md);
/** True once KaTeX is here; `needed` starts loading it. */
export function useKatex(needed: boolean): boolean {
  const ready = useSyncExternalStore(
    (cb) => (katexSubs.add(cb), () => void katexSubs.delete(cb)),
    () => katex !== null,
    () => katex !== null,
  );
  useEffect(() => {
    if (needed && !ready) void loadKatex().catch(() => {});
  }, [needed, ready]);
  return ready;
}
/** rehype-katex, once loaded; nothing before (no answer with maths is drawn before then). */
function rehypeKatexOnDemand(options: Parameters<RehypeKatex>[0]) {
  let run: ReturnType<RehypeKatex> | null = null;
  return (tree: Parameters<ReturnType<RehypeKatex>>[0], file: Parameters<ReturnType<RehypeKatex>>[1]) => {
    if (!katex) return;
    run ??= katex(options);
    return run(tree, file);
  };
}
if (typeof window !== "undefined") {
  const idle = () => (window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 200)))(() => void loadKatex().catch(() => {}));
  if (document.readyState === "complete") idle();
  else window.addEventListener("load", idle, { once: true });
}

/**
 * Maths, typeset (Arun, 2026-10-20: "better math formats"): $$…$$ on its own lines is an equation, $$…$$ inside a sentence is
 * inline. A single $ stays a dollar sign, so "$5 or $10" is never read as maths. KaTeX runs after the sanitiser, which keeps
 * what it reads (code.language-math), and what it makes is markup of its own, never the agent's.
 */
const REMARK: Pluggable[] = [...Object.values(defaultRemarkPlugins), [remarkMath, { singleDollarTextMath: false }]];
// Links to files are carried past the sanitiser and the hardener and made chips after them; whatever the hardener still refuses is
// its words alone, never "[blocked]" (answer-format.ts rehypeFileLinks; Arun, 2026-10-29).
const { raw, sanitize, harden, ...otherRehype } = defaultRehypePlugins as Record<string, Pluggable>;
const hardened: Pluggable = Array.isArray(harden) ? [harden[0], { ...(harden[1] as object), linkBlockPolicy: "text-only" }] : harden!;
const REHYPE: Pluggable[] = [raw!, rehypeFileLinks, sanitize!, hardened, ...Object.values(otherRehype), [rehypeKatexOnDemand, { throwOnError: false, strict: false }], rehypeFileChips, rehypeAnswer];
const COMPONENTS = { img: LiveImage, code: AnswerCodeTag } as Components;

/**
 * LaTeX as the coding tools write it, in the form the parser reads: \[ … \] (which Markdown would print as "[ … ]") becomes an
 * equation, and \( … \) inline maths. Code is left as written, fenced or inline, since a backslash bracket there is code.
 */
export function mathText(md: string): string {
  if (!md.includes("\\[") && !md.includes("\\(")) return md;
  return md
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => `\n$$\n${m.trim()}\n$$\n`).replace(/\\\(([\s\S]+?)\\\)/g, (_, m: string) => `$$${m.trim()}$$`),
    )
    .join("");
}

/** What an answer is rendered with: spread onto MessageResponse. Constant, so the renderer's memo holds. */
export const ANSWER = { components: COMPONENTS, remarkPlugins: REMARK, rehypePlugins: REHYPE, tableMaxHeight: 520, math: true } as const;

/** Streamdown keeps an answer with a footnote in it as one block; so does everything here. */
const FOOTNOTE = /\[\^[\w-]{1,200}\]/;

/**
 * Where a streamed answer can be cut so the part before it is finished: the furthest block boundary at or after `from` (itself
 * such a boundary) that has a blank line before it and a block after it whose first line has been written and isn't indented.
 * Only Streamdown's own block boundaries, so never inside a ``` fence, a list or a table: a fence still open is one block to the
 * end, and a blank line followed by "2." or an indented line is still the list until that line is whole.
 */
export function cutAt(md: string, from = 0): number {
  const blocks = parseMarkdownIntoBlocks(md.slice(from));
  let at = from;
  let cut = from;
  for (const b of blocks.slice(0, -1)) {
    at += b.length;
    if (md.startsWith("\n\n", at - 2) && md.indexOf("\n", at) > at && !/[ \t]/.test(md[at]!)) cut = at;
  }
  return cut;
}

/**
 * Cuts one streaming answer into its finished pieces and the part still being written, a frame at a time: only what came
 * after the last cut is read again, and a finished piece is never read again. Re-reading a 20KB answer every frame took
 * longer than the frame. The cuts are Streamdown's own block boundaries, so the pieces draw the blocks the whole text would.
 * One per answer: it remembers the answer it last saw. `done` is the same array until a piece is added.
 */
export function streamSplitter(): (md: string) => { done: string[]; tail: string } {
  let done: string[] = [];
  let prefix = "";
  return (md) => {
    // Something other than more of the same answer: started again. One with a footnote Streamdown keeps whole, so it is too.
    if (!md.startsWith(prefix) || FOOTNOTE.test(md)) (done = []), (prefix = "");
    if (!FOOTNOTE.test(md)) {
      const cut = cutAt(md, prefix.length);
      if (cut > prefix.length) (done = [...done, md.slice(prefix.length, cut)]), (prefix = md.slice(0, cut));
    }
    return { done, tail: md.slice(prefix.length) };
  };
}
