import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AgentCodeLine, useAgentCodeTokens, type AgentCodeLanguage } from "@/components/agents/agent-code";
import { pathOf } from "../answer-format.js";
import { codeFile, fenceAgrees } from "./code-file.js";
import { FileIcon } from "../fileIcons.js";
import { useIdeRoot } from "./mode.js";

/**
 * A fenced block of code as it reads in Code's chat column (Arun, 2026-11-19: "we may need to redesign the layout of the agent
 * responses and stuff in the agent chat too to make it more streamlined for code"): mono, tight, a header with the file (or the
 * language) and two plain actions, Copy and, where the block names a file, "Open in file"; a long block is cut short with "Show all".
 * Agents' own block (AnswerParts AnswerCode) is unchanged; this one is drawn only inside IdeChatContext.
 */

/** Lines in a block before it is cut short, and how many of them show then. */
const COLLAPSE_AT = 14;
const COLLAPSED_LINES = 10;

/**
 * The file the sentence just above a block names ("In `src/cart.ts`:"), read off the page: the last file chip in the paragraph
 * before it, when that ends in a colon, sits in the same run of markdown (not a list item or the line above the answer) and the
 * block's language is that file's kind ("After changing `src/cart.ts`, run:" over a bash block names nothing).
 */
function fileAbove(el: HTMLElement | null, language: string): { path: string; line?: number } | null {
  let at: HTMLElement | null = el;
  // Out of the renderer's own wrappers only: a block that is first in its list item or quote has nothing of its own above it.
  for (let i = 0; i < 3 && at && !at.previousElementSibling; i++) {
    const up: HTMLElement | null = at.parentElement;
    if (!up || /^(LI|BLOCKQUOTE|UL|OL)$/.test(up.tagName) || up.matches(".rsp-answer, .rsp-say, .md, [data-lane]")) return null;
    at = up;
  }
  const prev = at?.previousElementSibling as HTMLElement | null | undefined;
  if (!prev || prev.tagName !== "P" || !/:\s*$/.test(prev.textContent ?? "")) return null;
  const chips = prev.querySelectorAll<HTMLElement>(".file-chip code");
  const text = chips[chips.length - 1]?.textContent;
  const f = text ? pathOf(text) : null;
  return f && fenceAgrees(language, f.path) ? f : null;
}

export function ColumnCode({ code, fence, lang, incomplete }: { code: string; fence: string; lang: (fence: string) => AgentCodeLanguage; incomplete: boolean }) {
  const ideRoot = useIdeRoot();
  const named = codeFile(fence, code, ideRoot);
  const root = useRef<HTMLDivElement>(null);
  const [above, setAbove] = useState<{ path: string; line?: number } | null>(null);
  useLayoutEffect(() => {
    const f = fileAbove(root.current, named.lang);
    setAbove((a) => (a?.path === f?.path && a?.line === f?.line ? a : f));
  });
  const file = named.file ?? above;
  const language = lang(named.lang);
  const settled = incomplete ? code.slice(0, code.lastIndexOf("\n") + 1) : code;
  const tokens = useAgentCodeTokens(settled, settled ? language : "text");
  const writing = incomplete && !code.endsWith("\n");
  const lines = code.replace(/\n+$/, "").split("\n");
  const long = !incomplete && lines.length > COLLAPSE_AT;
  const [all, setAll] = useState(false);
  const shown = long && !all ? lines.slice(0, COLLAPSED_LINES) : lines;
  const [copied, setCopied] = useState(false);
  const t = useRef(0);
  useEffect(() => () => clearTimeout(t.current), []);
  const copy = () =>
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      clearTimeout(t.current);
      t.current = window.setTimeout(() => setCopied(false), 1500);
    });
  const open = (e: { currentTarget: EventTarget }) => {
    if (!file) return;
    // Whose message it is in: a path is in that agent's folder, not the session's (as a file chip in the words does).
    const said = (e.currentTarget as HTMLElement).closest?.<HTMLElement>("[data-lane]")?.dataset.lane;
    window.dispatchEvent(new CustomEvent("friday:open-file", { detail: { path: file.path, line: file.line ?? 1, ...(said && said !== "main" ? { lane: said } : {}) }, cancelable: true }));
  };
  const name = named.lang || "code";
  return (
    <div ref={root} className={`ans-code ans-col${long && !all ? " cut" : ""}`} data-streamdown="code-block" data-language={name}>
      <div className="ans-code-head">
        {file && (
          <span className="ans-code-file" title={file.path}>
            <FileIcon path={file.path} size={13} />
            {/* Its name, not its folders (the column is narrow); the whole path is the tooltip. */}
            <span>{file.path.split(/[\\/]/).pop()}</span>
          </span>
        )}
        {(!file || named.lang) && <span className="ans-code-lang">{name}</span>}
        {!incomplete && (
          <span className="ans-code-acts">
            <button type="button" className="ans-code-act" aria-label="Copy the code" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
            {file && (
              <button type="button" className="ans-code-act" aria-label={`Open ${file.path} in the editor`} onClick={open}>
                Open in file
              </button>
            )}
          </span>
        )}
      </div>
      <pre className="ans-code-body" tabIndex={0} aria-label={`${name} code`}>
        <code>
          {shown.map((l, i) => (
            <span key={i}>
              <AgentCodeLine code={l} tokens={writing && i === lines.length - 1 ? undefined : tokens?.[i]} />
              {i < shown.length - 1 ? "\n" : null}
            </span>
          ))}
        </code>
      </pre>
      {long && (
        <button type="button" className="ans-code-more" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}
