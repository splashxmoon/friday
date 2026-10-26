import { useEffect, useState } from "react";
import { ContextMenu } from "./ui.js";

/**
 * Cut, copy and paste on a right-click, in the desktop app (Arun, 2026-10-24: "fix not being able to use right click stuff like
 * copy and paste for the input chats for the new session page and the coding sessions").
 *
 * The app's window draws no menu of its own on a right-click (Electron shows none unless asked to), so a right-click in the
 * message box, or on words picked out of an answer, did nothing. This is that menu, from the page: in a field, Cut, Copy, Paste
 * and Select all; on picked words anywhere else, Copy. Each edit goes through the page's own editing commands, so it can be
 * undone and the field hears it as typing. In a browser, which has its own menu, nothing here runs. A right-click something
 * else answers for itself (a message's own menu, an agent's tab) is left to it.
 */

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLElement;
type Open = { x: number; y: number; field: Field | null; picked: string; range: [number, number] | Range | null; editable: boolean };

const TYPED = "textarea, input:is(:not([type]), [type=text], [type=search], [type=url], [type=email], [type=tel], [type=number], [type=password]), [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']";
const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const key = (k: string) => (mac ? `⌘${k}` : `Ctrl+${k}`);

function isInput(f: Field): f is HTMLInputElement | HTMLTextAreaElement {
  return f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement;
}

/** Puts the field's caret or selection back where it was when the menu opened, and the focus in it. */
function restore(o: Open): void {
  const f = o.field;
  if (!f) return;
  f.focus();
  if (isInput(f) && Array.isArray(o.range)) f.setSelectionRange(o.range[0], o.range[1]);
  else if (o.range instanceof Range) {
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(o.range);
  }
}

export function TextMenu() {
  const [open, setOpen] = useState<Open | null>(null);
  useEffect(() => {
    // Only where nothing else draws one: the desktop app.
    if (!window.fridayDesktop) return;
    const on = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as Element | null;
      const field = (t?.closest?.(TYPED) as Field | null) ?? null;
      const sel = window.getSelection();
      let picked = "";
      let range: Open["range"] = null;
      if (field && isInput(field)) {
        const a = field.selectionStart ?? 0;
        const b = field.selectionEnd ?? a;
        picked = field.value.slice(a, b);
        range = [a, b];
      } else {
        picked = sel && !sel.isCollapsed ? sel.toString() : "";
        range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      }
      // Not in a field and nothing picked: nothing to offer, and the page's own menus (or none) stand.
      if (!field && !picked.trim()) return;
      e.preventDefault();
      const editable = !!field && !(isInput(field) && (field.readOnly || field.disabled));
      setOpen({ x: e.clientX, y: e.clientY, field, picked, range, editable });
    };
    document.addEventListener("contextmenu", on);
    return () => document.removeEventListener("contextmenu", on);
  }, []);
  if (!open) return null;

  const copy = async (o: Open) => {
    try {
      await navigator.clipboard.writeText(o.picked);
    } catch {
      restore(o);
      document.execCommand("copy");
    }
  };
  const cut = async (o: Open) => {
    await copy(o);
    restore(o);
    document.execCommand("delete");
  };
  const paste = async (o: Open) => {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    restore(o);
    if (text) document.execCommand("insertText", false, text);
  };
  const selectAll = (o: Open) => {
    const f = o.field;
    if (!f) return;
    f.focus();
    if (isInput(f)) f.select();
    else document.execCommand("selectAll");
  };

  const o = open;
  const has = !!o.picked;
  return (
    <ContextMenu
      at={{ x: o.x, y: o.y }}
      compact
      onClose={() => setOpen(null)}
      items={() =>
        o.field
          ? [
              { label: "Cut", icon: "scissors" as const, hint: key("X"), disabled: !has || !o.editable, onSelect: () => void cut(o) },
              { label: "Copy", icon: "copy" as const, hint: key("C"), disabled: !has, onSelect: () => void copy(o) },
              { label: "Paste", icon: "clipboard" as const, hint: key("V"), disabled: !o.editable, onSelect: () => void paste(o) },
              { label: "Select all", hint: key("A"), onSelect: () => selectAll(o) },
            ]
          : [{ label: "Copy", icon: "copy" as const, hint: key("C"), onSelect: () => void copy(o) }]
      }
    />
  );
}
