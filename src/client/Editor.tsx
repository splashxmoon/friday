import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { AgentCodeLine, useAgentCodeTokens, type AgentCodeToken } from "@/components/agents/agent-code";
import { languageFor } from "./DiffView.js";
import { Icon } from "./icons.js";

/**
 * Reading and writing a file, with the colours the rest of the app already uses.
 *
 * There is no editor library here on purpose. A textarea is the only thing
 * that gets selection, undo, IME and every keyboard the platform has for free,
 * and the whole of what it lacks is colour — so the colour is painted behind
 * it by the same highlighter that draws every diff, and the textarea sits on
 * top with transparent text. The two only stay aligned while they share their
 * font, padding and line height exactly, which is what `.code-layer` is for.
 */

/** Long files are the ones where colour costs most and matters least. */
const MAX_HIGHLIGHT = 120_000;

function useLines(path: string, value: string) {
  const language = languageFor(path);
  // Coloured once typing pauses: the whole file is worked out again each time, and doing it on every keystroke is what made
  // typing in a big file lag. Another file is coloured at once.
  const [settled, setSettled] = useState({ path, value });
  useEffect(() => {
    const t = setTimeout(() => setSettled({ path, value }), 150);
    return () => clearTimeout(t);
  }, [path, value]);
  const code = settled.path === path ? settled.value : value;
  const tokens = useAgentCodeTokens(language !== "text" && code.length <= MAX_HIGHLIGHT ? code : "", language);
  // The colours can be for the text as it was a moment ago, so the text itself decides how many lines there are, and each line
  // takes colours worked out for exactly its text: its own if it is unchanged, else any line that read the same (a line pushed
  // down by a new one above it). An edited line is drawn plain until the colours catch up, never as it read before.
  return useMemo(() => paintLines(value, tokens), [value, tokens]);
}

/**
 * Each line of the text with its colours, matched without a line's \r: a file with Windows line endings is coloured without
 * them, and when none of its lines matched the whole file was drawn plain.
 */
export function paintLines(value: string, tokens: AgentCodeToken[][] | null | undefined): { line: string; tokens?: AgentCodeToken[] }[] {
  const bare = (s: string) => (s.endsWith("\r") ? s.slice(0, -1) : s);
  const texts = (tokens ?? []).map((t) => bare(t.map((x) => x.content).join("")));
  const byText = new Map<string, AgentCodeToken[]>();
  texts.forEach((text, i) => byText.set(text, tokens![i]!));
  return value.split("\n").map((line, i) => ({ line, tokens: texts[i] === bare(line) ? tokens![i] : byText.get(bare(line)) }));
}

/** A file shown, not edited: the same colours, without the textarea on top. */
export function CodeReader({ path, value }: { path: string; value: string }) {
  const lines = useLines(path, value);
  // Editing is a press away from reading: its editor is fetched now (CodeEditor).
  useEffect(() => void loadMirror().catch(() => {}), []);
  // Each line with its own number, so a long one wraps at the panel's edge and its number stays beside where it starts (Arun,
  // 2026-11-03: "show the code without having to horizontally scroll"). The numbers are never selected with the code.
  return (
    <div className="code-wrap code-read">
      <pre className="tree-file code-layer code-wrapped">
        {lines.map((l, i) => (
          <span key={i} className="code-line">
            <span className="code-ln" aria-hidden="true">
              {i + 1}
            </span>
            <span className="code-text">
              <AgentCodeLine code={l.line} tokens={l.tokens} />
            </span>
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

/**
 * Editing a file: CodeMirror (Arun, 2026-10-25: a real editor, as every tool of this kind has one). Syntax colour for the
 * language the file is in, loaded as it is needed; line numbers, folding, bracket matching, auto-indent, closing brackets,
 * find and replace (⌘F), several cursors (⌥-click), undo. The same props as the textarea it replaces, so the Files panel is
 * untouched. Colours follow Friday's light and dark looks, and change with them.
 */
/** A browser, as against the tests' stand-in DOM, which has no layout for CodeMirror to measure: there a plain box stands in. */
const REAL_DOM = typeof HTMLElement === "function" && typeof requestAnimationFrame === "function";

export function CodeEditor(props: {
  path: string;
  value: string;
  /** Put the cursor here when the file opens — where an error said to look. */
  line?: number;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  if (!REAL_DOM) return <PlainEditor {...props} />;
  // CodeMirror (~150 KB packed) loads with the first file opened, not with the session screen; the plain box holds the file
  // (and anything typed) for the moment it takes. Viewing a file asks for it already (CodeReader).
  return (
    <Suspense fallback={<PlainEditor {...props} />}>
      <MirrorEditor {...props} />
    </Suspense>
  );
}
/** CodeMirror and Friday's editor on it (mirror-editor.tsx), asked for when a file is shown or edited. */
export const loadMirror = () => import("./mirror-editor.js");
const MirrorEditor = lazy(loadMirror);

/** The editor where CodeMirror can't run: a controlled box with the same class and props the tests drive. */
function PlainEditor({ path, value, onChange, onSave }: { path: string; value: string; line?: number; onChange: (v: string) => void; onSave: () => void }) {
  return (
    <div className="code-wrap">
      <textarea
        className="code-layer code-input"
        value={value}
        spellCheck={false}
        aria-label={`Edit ${path}`}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave();
          }
        }}
      />
    </div>
  );
}

/**
 * Open a file by typing its name.
 *
 * Matching is on the path with the letters in order but not necessarily
 * together, because "clttsx" is how people reach `client/Terminal.tsx` — and
 * a match nearer the end of the path wins, since that is the part you typed.
 */
export function QuickOpen({ paths, onPick, onClose }: { paths: string[]; onPick: (path: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);

  const hits = useMemo(() => {
    const files = paths.filter((p) => !p.endsWith("/"));
    const needle = q.trim().toLowerCase();
    if (!needle) return files.slice(0, 30);
    const scored: { path: string; score: number }[] = [];
    for (const path of files) {
      const hay = path.toLowerCase();
      let i = 0;
      let last = -1;
      for (const ch of needle) {
        const found = hay.indexOf(ch, i);
        if (found < 0) {
          last = -1;
          break;
        }
        i = found + 1;
        last = found;
      }
      // The name matters more than the folders above it, so a hit that lands
      // in the last segment sorts above one spread across the whole path.
      if (last >= 0) scored.push({ path, score: last - hay.lastIndexOf("/") });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
      .slice(0, 30)
      .map((x) => x.path);
  }, [paths, q]);

  useEffect(() => setAt(0), [q]);

  return (
    <div className="quick-back" role="dialog" aria-modal="true" aria-label="Open a file" onMouseDown={onClose}>
      <div className="quick" onMouseDown={(e) => e.stopPropagation()}>
        <div className="quick-find">
          <Icon name="search" size={14} />
          <input
            autoFocus
            value={q}
            spellCheck={false}
            placeholder="Open a file"
            aria-label="Open a file"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setAt((i) => Math.min(i + 1, hits.length - 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setAt((i) => Math.max(i - 1, 0)));
              if (e.key === "Enter" && hits[at]) (e.preventDefault(), onPick(hits[at]));
              if (e.key === "Escape") onClose();
            }}
          />
        </div>
        <div className="quick-hits">
          {hits.length === 0 ? (
            <p className="muted small quick-empty">Nothing matches “{q}”.</p>
          ) : (
            hits.map((p, i) => (
              <button key={p} type="button" className={`quick-hit ${i === at ? "on" : ""}`} onMouseEnter={() => setAt(i)} onClick={() => onPick(p)}>
                <span className="quick-name">{p.split("/").pop()}</span>
                <span className="quick-path">{p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
