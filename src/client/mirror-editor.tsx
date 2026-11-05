/**
 * Editing a file with CodeMirror (Editor.tsx CodeEditor): a chunk of its own, loaded when a file is opened, so the session screen
 * doesn't wait on CodeMirror (~150 KB packed) to draw.
 */
import { useEffect, useRef } from "react";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { crosshairCursor, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { readTheme } from "./theme.js";
import { currentTheme, type Theme } from "./storage.js";

export default function MirrorEditor({
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
          // Long lines wrap at the panel's edge, as Claude's file panel does: a narrow panel read code by scrolling sideways (Arun,
          // 2026-11-03: "show the code without having to horizontally scroll").
          EditorView.lineWrapping,
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
