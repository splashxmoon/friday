import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.js";

/**
 * ⌘F in a session's chat (Arun, 2026-11-03, after Orca's find bar): what the chat shows, found as you type, the matches lit
 * where they are and stepped through with Enter and Shift+Enter, kept up to date as replies stream in. Only what is on screen
 * is searched, so a match is always somewhere you can see once it's scrolled to: a folded step's insides aren't, and with the
 * chat filtered to one agent, only that agent's messages are. Escape closes it and puts focus back where it was.
 *
 * The matches are painted with the CSS Custom Highlight API, so the chat's own elements are never touched or re-rendered.
 * The terminal and the editor keep their own ⌘F.
 */

const ALL = "chat-find";
const NOW = "chat-find-current";
/** Enough to be useful, few enough that a common letter in a long session stays quick. */
const MOST = 1000;

type Highlights = { set: (name: string, h: unknown) => void; delete: (name: string) => void };
const highlights = (): Highlights | null => (typeof CSS !== "undefined" && "highlights" in CSS ? (CSS as unknown as { highlights: Highlights }).highlights : null);
const Highlight = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

/** The text of a chat that is shown, as ranges matching `needle` (any case). */
export function findIn(root: HTMLElement, needle: string): Range[] {
  const n = needle.toLowerCase();
  const out: Range[] = [];
  if (!n) return out;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (t) => {
      const p = t.parentElement;
      if (!p || !t.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
      if (p.closest("script, style, textarea, [hidden], [aria-hidden='true'], .chat-find")) return NodeFilter.FILTER_REJECT;
      // Not drawn (inside a fold, display: none): nothing a match could be scrolled to.
      if (!p.getClientRects().length) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let t = walk.nextNode(); t && out.length < MOST; t = walk.nextNode()) {
    const s = t.nodeValue!.toLowerCase();
    for (let i = s.indexOf(n); i !== -1 && out.length < MOST; i = s.indexOf(n, i + n.length)) {
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + n.length);
      out.push(r);
    }
  }
  return out;
}

/**
 * Mounted in each chat column (Activity.tsx, beside the message box): ⌘F opens the one whose column has focus, or the main one
 * when focus is nowhere in particular.
 */
export function ChatFind({ primary }: { primary: boolean }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const column = () => anchor.current?.closest(".composer-dock")?.parentElement ?? null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== "f") return;
      const col = column();
      const focus = document.activeElement;
      // The terminal and the editor find in themselves.
      if (focus?.closest(".xterm, .cm-editor, .monaco-editor")) return;
      const mine = !!col && !!focus && col.contains(focus);
      // Focus in no chat at all (the sidebar, the page): the main chat's.
      const nowhere = !focus || focus === document.body || (!focus.closest("[data-scroll-root]") && !focus.closest(".composer-dock"));
      if (!mine && !(primary && nowhere)) return;
      if (!col?.querySelector("[data-scroll-root]")) return;
      e.preventDefault();
      if (open) document.querySelector<HTMLInputElement>(".chat-find input")?.select();
      else {
        // The whole chat, not only its newest items (Activity.tsx FEED_WINDOW): the search covers the day, as before.
        dispatchEvent(new CustomEvent("friday:feed-from", { detail: 0 }));
        setOpen(true);
      }
    };
    // Caught on the way down: the message box's own keys stop it on the way back up.
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [primary, open]);
  return <span ref={anchor} hidden>{open && <FindBar column={column} onClose={() => setOpen(false)} />}</span>;
}

function FindBar({ column, onClose }: { column: () => HTMLElement | null; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [count, setCount] = useState(0);
  const [at, setAt] = useState(0);
  // Bumped by every search, so the lit matches follow the chat even when their number stays the same.
  const [found, setFound] = useState(0);
  const ranges = useRef<Range[]>([]);
  const searched = useRef("");
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  const [place, setPlace] = useState<{ top: number; right: number } | null>(null);
  const scroller = () => column()?.querySelector<HTMLElement>("[data-scroll-root]") ?? null;

  // Over the chat's top right corner, wherever the column is.
  useLayoutEffect(() => {
    const put = () => {
      const r = scroller()?.getBoundingClientRect();
      if (r) setPlace({ top: r.top + 10, right: Math.max(8, innerWidth - r.right + 18) });
    };
    put();
    addEventListener("resize", put);
    return () => removeEventListener("resize", put);
  }, []);

  // Focused once it is drawn: the first render has no place yet, and so no field.
  const placed = !!place;
  useEffect(() => {
    if (placed) input.current?.focus();
  }, [placed]);
  useEffect(() => {
    return () => {
      highlights()?.delete(ALL);
      highlights()?.delete(NOW);
    };
  }, []);

  const search = useCallback(() => {
    const root = scroller()?.firstElementChild as HTMLElement | null;
    ranges.current = root ? findIn(root, q.trim()) : [];
    setCount(ranges.current.length);
    setFound((n) => n + 1);
    // A new search starts at its first match, in view; the same one again, after the chat changed, stays where it was.
    const fresh = searched.current !== q;
    searched.current = q;
    if (fresh) ranges.current[0]?.startContainer.parentElement?.scrollIntoView({ block: "center" });
    setAt((a) => (fresh ? 0 : Math.min(a, Math.max(0, ranges.current.length - 1))));
  }, [q]);

  // Again as the chat changes (a reply streaming in, a step folding): what it shows now is what's found.
  useEffect(() => {
    const t = setTimeout(search, 60);
    const root = scroller()?.firstElementChild;
    let later: ReturnType<typeof setTimeout> | undefined;
    const mo = new MutationObserver(() => {
      clearTimeout(later);
      later = setTimeout(search, 150);
    });
    if (root) mo.observe(root, { childList: true, subtree: true, characterData: true });
    return () => (clearTimeout(t), clearTimeout(later), mo.disconnect());
  }, [search]);

  // Lit: every match, and the one you're on more strongly.
  useEffect(() => {
    const h = highlights();
    if (!h || !Highlight) return;
    const all = ranges.current;
    if (!all.length) return void (h.delete(ALL), h.delete(NOW));
    h.set(ALL, new Highlight(...all));
    h.set(NOW, new Highlight(all[at]!));
  }, [found, at]);

  const go = (step: number) => {
    const all = ranges.current;
    if (!all.length) return;
    const next = (at + step + all.length) % all.length;
    setAt(next);
    all[next]!.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const close = () => {
    onClose();
    // Back to the field it was opened from; from anywhere else (the chat itself, a code block scrolled in it, nowhere), to this
    // chat's message box, where the next thing is typed (Arun's e2e pass, 2026-11-04: Esc left focus on a code block).
    const was = back.current;
    if (was instanceof HTMLElement && was.isConnected && /^(INPUT|TEXTAREA)$/.test(was.tagName)) return was.focus();
    column()?.querySelector<HTMLTextAreaElement>(".composer-dock textarea")?.focus();
  };

  if (!place) return null;
  return createPortal(
    <div className="chat-find" role="search" aria-label="Find in this chat" style={{ top: place.top, right: place.right }}>
      <Icon name="search" size={14} />
      <input
        ref={input}
        value={q}
        placeholder="Find in chat"
        aria-label="Find in this chat"
        spellCheck={false}
        onChange={(e) => setQ(e.currentTarget.value)}
        onKeyDown={(e) => {
          // Escape here closes the find, and nothing else: not the agent's turn, not the panel behind it.
          if (e.key === "Escape") return void (e.preventDefault(), e.stopPropagation(), close());
          if (e.key === "Enter") (e.preventDefault(), go(e.shiftKey ? -1 : 1));
        }}
      />
      <span className="chat-find-n" aria-live="polite">
        {!q.trim() ? "" : count ? `${at + 1} of ${count >= MOST ? `${MOST}+` : count}` : "No matches"}
      </span>
      <button type="button" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={!count} onClick={() => go(-1)}>
        <Icon name="chevronUp" size={14} />
      </button>
      <button type="button" aria-label="Next match" title="Next (Enter)" disabled={!count} onClick={() => go(1)}>
        <Icon name="chevronDown" size={14} />
      </button>
      <button type="button" aria-label="Close find" title="Close (Esc)" onClick={close}>
        <Icon name="x" size={14} />
      </button>
    </div>,
    document.body,
  );
}
