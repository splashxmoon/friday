import { useEffect, useMemo, useRef, useState } from "react";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { crosshairCursor, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { readTheme } from "./theme.js";
import { AgentCodeLine, useAgentCodeTokens, type AgentCodeToken } from "@/components/agents/agent-code";
import { languageFor } from "./DiffView.js";
import { Icon } from "./icons.js";
import { currentTheme, type Theme } from "./storage.js";

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

/**
 * The numbers down the left.
 *
 * Its own column rather than text in the lines, because a number that can be
 * selected ends up in whatever you paste — and in the editor it would end up
 * in the file.
 */
function Gutter({ count, from = 1 }: { count: number; from?: number }) {
  return (
    <div className="code-gutter" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span key={i}>{from + i}</span>
      ))}
    </div>
  );
}

function Painted({ lines }: { lines: { line: string; tokens?: AgentCodeToken[] }[] }) {
  return (
    <>
      {lines.map((l, i) => (
        <span key={i} className="code-line">
          <AgentCodeLine code={l.line} tokens={l.tokens} />
          {"\n"}
        </span>
      ))}
    </>
  );
}

/** A file shown, not edited: the same colours, without the textarea on top. */
export function CodeReader({ path, value }: { path: string; value: string }) {
  const lines = useLines(path, value);
  return (
    <div className="code-wrap code-read">
      <Gutter count={lines.length} />
      <pre className="tree-file code-layer">
        <Painted lines={lines} />
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
  return <MirrorEditor {...props} />;
}

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

function MirrorEditor({
  path,
  value,
  line,
  onChange,
  onSave,
}: {
  path: string;
  value: string;
  line?: number;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const went = useRef("");
  // The latest handlers, read from inside CodeMirror's own callbacks without rebuilding the editor.
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };
  const language = useRef(new Compartment());
  const look = useRef(new Compartment());

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const v = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          indentUnit.of("  "),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          keymap.of([
            { key: "Mod-s", run: () => (handlers.current.onSave(), true) },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          language.current.of([]),
          look.current.of(lookFor(currentTheme())),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    // The look follows the app's: html.dark is toggled by the theme switch (storage.ts setTheme).
    const watch = new MutationObserver(() => v.dispatch({ effects: look.current.reconfigure(lookFor(currentTheme())) }));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      watch.disconnect();
      v.destroy();
      view.current = null;
    };
    // Built once; the text and the file are kept in step below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Another file, or the text changed outside (a save that reformatted it, an agent's edit): the editor takes it, without
  // echoing it back as a change of its own.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const now = v.state.doc.toString();
    if (now !== value) v.dispatch({ changes: { from: 0, to: now.length, insert: value } });
  }, [value]);

  // The language for the file's name, loaded when first needed and kept for the next file in it.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    let gone = false;
    const desc = LanguageDescription.matchFilename(languages, path.split(/[\\/]/).pop() ?? path);
    if (!desc) return void v.dispatch({ effects: language.current.reconfigure([]) });
    void desc.load().then((support) => !gone && view.current === v && v.dispatch({ effects: language.current.reconfigure(support) }));
    return () => void (gone = true);
  }, [path]);

  // Once, per file and line asked for: moving the cursor again on every keystroke would fight whoever is typing.
  useEffect(() => {
    const v = view.current;
    const key = `${path}:${line}`;
    if (!v || !line || !value || went.current === key) return;
    went.current = key;
    const n = Math.min(line, v.state.doc.lines);
    const pos = v.state.doc.line(n).from;
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    v.focus();
  }, [path, line, value]);

  return <div ref={host} className="code-wrap code-cm" aria-label={`Edit ${path}`} />;
}

/** Friday's colours for the editor, light or dark: the chrome from the app's own variables, the syntax from GitHub's high-contrast palettes, as the diffs are. */
function lookFor(theme: Theme): Extension {
  const dark = theme === "dark";
  const chrome = EditorView.theme(
    {
      "&": { height: "100%", backgroundColor: "var(--code-bg)", color: "var(--ink)", fontSize: "12.5px" },
      ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55", overflow: "auto" },
      ".cm-content": { padding: "10px 0", caretColor: "var(--ink)" },
      ".cm-line": { padding: "0 12px" },
      "&.cm-focused": { outline: "none" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--violet-soft)" },
      ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--ink) 4%, transparent)" },
      ".cm-gutters": { backgroundColor: "var(--code-bg)", color: "var(--faint)", borderRight: "1px solid var(--border)", minWidth: "4ch" },
      ".cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--ink) 6%, transparent)", color: "var(--ink-2)" },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 10px" },
      ".cm-foldGutter .cm-gutterElement": { padding: "0 4px 0 0", color: "var(--faint)" },
      ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--violet) 18%, transparent)", outline: "1px solid color-mix(in srgb, var(--violet) 40%, transparent)" },
      ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--violet) 14%, transparent)" },
      ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--amber, #f59e0b) 30%, transparent)", outline: "1px solid color-mix(in srgb, var(--amber, #f59e0b) 60%, transparent)" },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--amber, #f59e0b) 55%, transparent)" },
      ".cm-panels": { backgroundColor: "var(--card)", color: "var(--ink)", borderBottom: "1px solid var(--border)", fontFamily: "var(--font)", fontSize: "12.5px" },
      ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)", borderBottom: "none" },
      ".cm-panel.cm-search": { padding: "6px 8px" },
      ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": { fontFamily: "var(--font)", fontSize: "12px", color: "var(--ink)" },
      ".cm-panel.cm-search input": { border: "1px solid var(--border)", borderRadius: "6px", background: "var(--bg)", padding: "2px 6px" },
      ".cm-panel.cm-search button": { border: "1px solid var(--border)", borderRadius: "6px", background: "var(--card-2, var(--hover))", padding: "2px 8px", backgroundImage: "none" },
      ".cm-tooltip": { backgroundColor: "var(--card)", color: "var(--ink)", border: "1px solid var(--border)", borderRadius: "8px", fontFamily: "var(--font)" },
      ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--violet-soft)", color: "var(--ink)" },
      ".cm-foldPlaceholder": { backgroundColor: "var(--hover)", border: "1px solid var(--border)", color: "var(--text-muted)" },
    },
    { dark },
  );
  // GitHub's high-contrast palettes, light and dark, which is what colours the diffs (agent-code.tsx).
  // An imported theme's own token colours, where it gave them (theme.ts); GitHub's palettes for the rest.
  const own = readTheme()?.tokens ?? {};
  const c = Object.assign({}, dark
    ? { keyword: "#ff9492", string: "#addcff", comment: "#bdc4cc", number: "#91cbff", fn: "#dbb7ff", variable: "#ffb757", tag: "#72f088", type: "#ffb757", attr: "#91cbff", punct: "#d9dee3", meta: "#72f088", invalid: "#ff6a69" }
    : { keyword: "#cf222e", string: "#0a3069", comment: "#59636e", number: "#0550ae", fn: "#6639ba", variable: "#953800", tag: "#116329", type: "#953800", attr: "#0550ae", punct: "#1f2328", meta: "#116329", invalid: "#82071e" }, own);
  const syntax = HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.moduleKeyword, t.operator], color: c.keyword },
    { tag: [t.string, t.special(t.string), t.regexp, t.escape], color: c.string },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: c.comment, fontStyle: "italic" },
    { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.constant(t.name), t.standard(t.name)], color: c.number },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: c.fn },
    { tag: [t.variableName, t.definition(t.variableName), t.propertyName, t.definition(t.propertyName), t.labelName], color: c.variable },
    { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName), t.definition(t.className)], color: c.type },
    { tag: [t.tagName, t.angleBracket], color: c.tag },
    { tag: [t.attributeName, t.attributeValue], color: c.attr },
    { tag: [t.punctuation, t.bracket, t.separator, t.paren, t.squareBracket, t.brace], color: c.punct },
    { tag: [t.meta, t.annotation, t.processingInstruction, t.macroName], color: c.meta },
    { tag: t.heading, fontWeight: "600" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strong, fontWeight: "600" },
    { tag: t.link, textDecoration: "underline" },
    { tag: t.invalid, color: c.invalid },
  ]);
  return [chrome, syntaxHighlighting(syntax)];
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
