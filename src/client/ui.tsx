import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Avatar, Icon, type IconName } from "./icons.js";

/**
 * Every floating surface currently open: menus, popovers, dialogs.
 *
 * Opening one closes the others, so two never sit on top of each other. The
 * exception is nesting: a menu opened from inside a panel must not close the
 * panel it came from. Menus render in a portal, so containment is judged by the
 * trigger that opened them, not by the DOM position of the menu itself.
 */
interface Floating {
  el: () => HTMLElement | null;
  close: () => void;
}
const openSurfaces = new Set<Floating>();

function claimSurface(self: Floating, trigger: HTMLElement | null): () => void {
  for (const other of [...openSurfaces]) {
    if (other === self) continue;
    // Keep whatever contains the thing that opened this one.
    if (trigger && other.el()?.contains(trigger)) continue;
    openSurfaces.delete(other);
    other.close();
  }
  openSurfaces.add(self);
  return () => openSurfaces.delete(self);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** What Tab can land on inside an element, in order, skipping anything not drawn. */
const focusablesIn = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.getClientRects().length > 0);

/**
 * Close something on outside click or Escape, and close anything else that was
 * open. `trigger` is the element that opened it, when that element lives inside
 * another surface which should stay open. `trap: false` lets Tab leave (a menu
 * closes instead of cycling; a modal cycles).
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void, trigger?: HTMLElement | null, opts: { trap?: boolean } = {}) {
  const close = useRef(onClose);
  close.current = onClose;
  // What had the focus when this first rendered: read during render, because a field inside with autoFocus takes the
  // focus as it mounts, before any effect runs, and the opener would then be lost (focus fell to the page on close).
  const before = useRef<Element | null | undefined>(undefined);
  if (before.current === undefined) before.current = document.activeElement;

  useEffect(() => {
    const self: Floating = { el: () => ref.current, close: () => close.current() };
    return claimSurface(self, trigger ?? null);
    // Runs once per mount: a surface claims the screen when it opens.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Keyboard focus follows the surface: in when it opens (unless something inside asked for it first), kept inside while
   * it is open, and back on whatever opened it when it closes. Without this a dialog opened from the keyboard left focus
   * on the page behind it, and the agent picker's sixteen choices could not be reached by Tab at all.
   */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const trap = opts.trap !== false;
    const opener = trigger ?? (before.current instanceof HTMLElement && !el.contains(before.current) ? before.current : null);
    const timer = setTimeout(() => {
      if (el.contains(document.activeElement)) return;
      const first = focusablesIn(el)[0];
      if (first) first.focus();
      else {
        if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
        el.focus();
      }
    }, 0);
    const keep = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !trap) return;
      const list = focusablesIn(el);
      if (!list.length) return;
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === el)) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && at === last) (e.preventDefault(), first.focus());
    };
    el.addEventListener("keydown", keep);
    return () => {
      clearTimeout(timer);
      el.removeEventListener("keydown", keep);
      // Only when focus has nowhere better to be: somebody who clicked elsewhere to close this keeps what they clicked.
      const now = document.activeElement;
      if (opener?.isConnected && (!now || now === document.body || el.contains(now))) opener.focus();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const at = e.target as Node;
      // The button that opened this is not "outside" it. Closing on its
      // mousedown left its own click to toggle an already-closed surface back
      // open, so pressing it a second time appeared to do nothing at all.
      if (trigger?.contains(at)) return;
      // A card a dialog opens (the folder picker) is portaled outside it, but belongs to it.
      if ((at as Element).closest?.("[data-owned-floating]")) return;
      if (ref.current && !ref.current.contains(at)) close.current();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [ref, trigger]);
}

/**
 * Where a floating card goes so that all of it is on screen.
 *
 * Cards opened downward from a control near the bottom of the window — which
 * is most of them, because the composer lives there — ran past the edge, and
 * the rows nobody could reach were the ones being looked for. So: below when
 * there is room for it, above when there is more room there, and never taller
 * than the space it was given. The height is returned rather than left to CSS
 * because only the caller knows how much room its trigger left behind.
 */
export function placeCard(
  anchor: DOMRect | undefined,
  wide: number,
  opts: { want?: number; min?: number; gap?: number; prefer?: "above" | "below"; beside?: boolean } = {},
): { left: number; width: number; maxHeight: number; top?: number; bottom?: number } {
  const { want = 520, min = 200, gap = 6, prefer, beside } = opts;
  const edge = 8;
  // Never wider than the window: a card wider than a narrow window has its right edge cut off, whatever left it is given.
  const width = Math.min(wide, innerWidth - 2 * edge);
  const top0 = anchor?.top ?? 60;
  const bottom0 = anchor?.bottom ?? 60;
  const left0 = anchor?.left ?? edge;

  const room = { below: innerHeight - bottom0 - gap - edge, above: top0 - gap - edge };
  // A preference is honoured while the side it asks for can hold the minimum;
  // past that it still flips, because a panel that opens where it was told
  // and is too short to use is worse than one that opens the other way.
  const down =
    prefer === "above"
      ? room.above < min && room.below > room.above
      : prefer === "below"
        ? room.below >= min || room.below >= room.above
        : room.below >= Math.min(want, min) || room.below >= room.above;
  const maxHeight = Math.max(min, Math.min(want, down ? room.below : room.above));
  // Beside: for a trigger in a narrow strip down the side of the window, where
  // opening over it or under it would cover the strip itself. The card starts
  // where the trigger ends, level with it on whichever edge has the room.
  if (beside && anchor) {
    // Clear of the strip itself: a trigger sits inside it with room to spare, so
    // its own edge is not the strip's, and a card starting there overlaps the rule.
    const x = Math.max(edge, Math.min(anchor.right + gap + 10, innerWidth - width - edge));
    // Heights are measured from the window's edge, so "level with the bottom of
    // the trigger" is that edge minus where the trigger ends.
    if (down) return { left: x, top: Math.max(edge, top0), width, maxHeight: Math.max(min, Math.min(want, innerHeight - top0 - edge)) };
    return { left: x, bottom: Math.max(edge, innerHeight - bottom0), width, maxHeight: Math.max(min, Math.min(want, bottom0 - edge)) };
  }
  const left = Math.max(edge, Math.min(left0, innerWidth - width - edge));
  // Opening upwards is pinned by its bottom edge, not by a top computed from
  // maxHeight. maxHeight is a ceiling the card is usually well under, so a top
  // measured off it leaves the card floating that whole difference above the
  // thing it belongs to — which is what a short menu over a tall allowance did.
  if (down) return { left, top: bottom0 + gap, width, maxHeight };
  return { left, bottom: Math.max(edge, innerHeight - top0 + gap), width, maxHeight };
}

/** The same ceiling the model picker uses, so the two read as one family. */
const MENU_MAX = 440;

export interface MenuAction {
  icon: IconName;
  /** What it does, said to a screen reader and in its tooltip: "Stop localhost:3111". */
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

/** A menu row, with its own button at the end when it has one: two buttons side by side, since one can't hold the other. */
function MenuRow({ action, onClose, children }: { action?: MenuAction; onClose: () => void; children: ReactNode }) {
  if (!action) return <>{children}</>;
  return (
    <div className="menu-row">
      {children}
      <button
        type="button"
        className="menu-row-action"
        title={action.label}
        aria-label={action.label}
        disabled={action.disabled}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
          action.onSelect();
        }}
      >
        <Icon name={action.icon} size={12} />
      </button>
    </div>
  );
}

export type MenuItem =
  | { heading: string }
  /** Who this menu is about: a name and a line under it, for an account menu's first row. */
  | { who: { name: string; id?: string; sub: string; /** A second line under the name, in smaller type. */ line?: string } }
  /** Anything that is not a choice: a chart, a note. Never highlighted and never closes the menu. */
  | { node: ReactNode; /** About how tall it is, so the menu is sized to hold it. */ height?: number }
  | { label: string; /** A tooltip for the row, for what does not fit beside the name. */ title?: string; icon?: IconName; /** A mark of its own, for what no named icon can be: a company's logo. */ mark?: ReactNode; onSelect: () => void; danger?: boolean; checked?: boolean; disabled?: boolean; /** Greyed but still pressable: something offered that isn't part of what you have (Friday Code on Solo opens "Start a team"). */ dim?: boolean; hint?: string; /** A second line under the label, for what a choice means. */ sub?: string; /** A green dot after the label: something is happening here. */ live?: boolean; /** A button of its own at the row's end, for what can be done to the thing without choosing it: stopping a server. */ action?: MenuAction }
  | false
  | null
  | undefined;

/** A "⋯" button with a menu rendered in a portal, so scroll containers can't clip it. */
export function MenuButton({
  items,
  label = "More actions",
  className = "",
  icon = "more",
  text,
  mark,
  caret = "chevronDown",
  children,
  above,
  beside,
  compact,
  end,
  width,
  maxHeight,
  onOpenChange,
}: {
  /** A mark before a pill's text, for a value that is somebody's product. */
  mark?: ReactNode;
  /** The pill's trailing mark: a chevron, or the up-and-down one for a picker. */
  caret?: IconName;
  /** A narrower, tighter menu, for a short list of short names. */
  compact?: boolean;
  /** An exact width, for a menu that belongs to something of a known size. */
  width?: number;
  /** The tallest the menu may be; a longer list scrolls inside it. */
  maxHeight?: number;
  /** Line the menu up with the button's right edge and open leftwards, for a button near the window's edge. */
  end?: boolean;
  items: () => MenuItem[];
  label?: string;
  className?: string;
  icon?: IconName;
  /** Render a labelled pill trigger (e.g. a setting's current value) instead of an icon button. */
  text?: string;
  /** Trigger content, when the whole thing should be clickable rather than just an icon. */
  children?: ReactNode;
  /** Open above the trigger instead of letting it pick a side by available room. */
  above?: boolean;
  /** Open to the side of the trigger, for one in a strip down the window's edge. */
  beside?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const set = (r: DOMRect | null) => {
    setAnchor(r);
    onOpenChange?.(!!r);
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`${children ? "" : text ? "menu-pill" : "icon-btn tiny"} ${anchor ? "on" : ""} ${className}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          set(anchor ? null : btn.current!.getBoundingClientRect());
        }}
      >
        {children ?? (
          text ? (
            <>
              {mark && <span className="menu-pill-mark">{mark}</span>}
              <span>{text}</span>
              <Icon name={caret} size={13} className="menu-pill-caret" />
            </>
          ) : (
            <Icon name={icon} size={15} />
          )
        )}
      </button>
      {anchor && (
        <MenuPopup anchor={anchor} above={above} beside={beside} compact={compact} end={end} width={width} {...(maxHeight ? { maxHeight } : {})} trigger={btn.current} items={items().filter(Boolean) as Exclude<MenuItem, false | null | undefined>[]} onClose={() => set(null)} />
      )}
    </>
  );
}

/**
 * The same menu, opened where the pointer was: for a right-click.
 *
 * A row that already has a "⋯" button has a menu, and making somebody go and
 * find the button to reach it is a habit borrowed from touch screens. This is
 * that menu with a point for an anchor instead of a button, so it is placed,
 * dismissed and claimed against other floating things exactly as the button's
 * is — there is only one implementation of what a menu does.
 */
export function ContextMenu({ at, items, onClose, compact, end, width }: { at: { x: number; y: number }; items: () => MenuItem[]; onClose: () => void; compact?: boolean; /** Line the menu's right edge up with the point and open leftwards, for a point near the window's right edge. */ end?: boolean; /** An exact width, so an end-aligned menu lands where it should. */ width?: number }) {
  return <MenuPopup anchor={new DOMRect(at.x, at.y, 0, 0)} items={items().filter(Boolean) as Exclude<MenuItem, false | null | undefined>[]} onClose={onClose} compact={compact} {...(end ? { end } : {})} {...(width ? { width } : {})} />;
}

function MenuPopup({ anchor, items, onClose, above, beside, compact, end, trigger, width: fixed, maxHeight: cap }: { /** The tallest the menu may be: a long list scrolls inside it. */ maxHeight?: number; anchor: DOMRect; items: Exclude<MenuItem, false | null | undefined>[]; onClose: () => void; above?: boolean; beside?: boolean; compact?: boolean; end?: boolean; trigger?: HTMLElement | null; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose, trigger, { trap: false });


  useEffect(() => {
    const away = () => onClose();
    window.addEventListener("resize", away);
    return () => window.removeEventListener("resize", away);
  }, [onClose]);
  // A menu is as wide as its longest hint needs, because a hint that wraps
  // four times is a hint nobody reads. Height is estimated from the same
  // thing, or a menu opening upwards would be placed against the wrong edge.
  const hint = (it: MenuItem) => (it && typeof it === "object" && "hint" in it ? (it.hint ?? "") : "");
  // Words beside a name squeeze it until it is cut off, so they go on a line below it. A key shortcut stays on the right: it is short and it is a key.
  // A sequence of single keys ("g d") is a shortcut too, drawn a keycap each.
  const isKey = (h: string) => h.length <= 2 || /^\S( \S)+$/.test(h) || /[⌘⇧⌥⌃↵⏎]|^(ctrl|cmd|alt|shift|esc|enter|tab)\b/i.test(h);
  const below = (it: MenuItem) => (hint(it) && !isKey(hint(it)) ? hint(it) : "");
  // The blank where an icon would go only earns its space when something in
  // this menu actually has one; otherwise every label sits indented from the
  // heading above it for no reason.
  const anyIcon = items.some((it) => !!it && typeof it === "object" && (("icon" in it && !!it.icon) || ("mark" in it && !!it.mark)));
  // Same for the tick: a menu that ticks anything keeps the column on every
  // row, so the ticks line up rather than each trailing its own hint.
  const anyLive = items.some((it) => !!it && typeof it === "object" && "live" in it && !!it.live);
  const anyCheck = items.some((it) => !!it && typeof it === "object" && "checked" in it);
  // Sized to the widest label-plus-hint, not the widest hint: they share a
  // row, and a menu measured on half of it is a menu whose hints wrap.
  const label = (it: MenuItem) => (it && typeof it === "object" && "label" in it ? it.label : "");
  const longest = Math.max(0, ...items.map((it) => (below(it) ? Math.max(label(it).length, below(it).length) : label(it).length + hint(it).length)));
  // Two-line rows say what a choice means under its name, and read best a little wider than a name alone.
  const anySub = items.some((it) => !!it && typeof it === "object" && (("sub" in it && !!it.sub) || !!below(it)));
  const width = fixed ?? (anySub ? 312 : compact
    ? Math.min(220, Math.max(128, Math.round(longest * 7 + (anyIcon ? 30 : 0) + (anyCheck ? 22 : 0) + 26)))
    : longest > 46 ? 352 : longest > 36 ? 320 : longest > 26 ? 288 : longest > 18 ? 260 : 232);
  // Tall enough for what is in it, and no taller than the model picker — a
  // workspace with twenty agents in it should get a list that scrolls, not a
  // menu the height of the window. placeCard does the rest: which side has
  // the room, and how much of it there is.
  // A line under a name wraps when it is long, and each wrapped line is another 16px: counting only the first left the menu too short and scrolling.
  const underLen = (it: MenuItem) => (it && typeof it === "object" && "sub" in it && it.sub ? it.sub.length : below(it).length);
  const perLine = Math.max(24, Math.floor((width - 76) / 6.3));
  const estHeight = items.reduce((h, it) => h + ("node" in it ? (it.height ?? 64) : "who" in it ? 62 : "heading" in it ? 30 : underLen(it) ? 52 + 16 * (Math.ceil(underLen(it) / perLine) - 1) : 34), 12);
  const place = placeCard(anchor, width, { want: Math.min(estHeight, cap ?? MENU_MAX), min: 180, gap: 4, ...(above ? { prefer: "above" as const } : {}), ...(beside ? { beside } : {}) });
  return createPortal(
    <div
      ref={ref}
      className={compact ? "menu compact" : "menu"}
      role="menu"
      // A menu opened from inside a card belongs to that card. It is drawn on the page, outside it, so without this a press on
      // one of its rows reads as a press outside the card, and the card closes before the row has been chosen.
      data-owned-floating=""
      style={{ top: place.top, bottom: place.bottom, left: end ? Math.max(8, anchor.right - place.width) : place.left, width: place.width, maxHeight: cap ? Math.min(cap, place.maxHeight ?? cap) : place.maxHeight }}
      // A portal is still inside the tree it was rendered from as far as React
      // events go, so a click on the gap between two items, or on a heading,
      // would otherwise reach the row underneath and open it. And a right-click
      // on the menu is not a request for the row's menu again, a pixel over.
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      // Arrow keys walk the rows, as a menu does; Tab closes it and hands focus back to the button that opened it.
      onKeyDown={(e) => {
        const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])')];
        if (!rows.length) return;
        const i = rows.indexOf(document.activeElement as HTMLButtonElement);
        const go = (n: number) => (e.preventDefault(), rows[(n + rows.length) % rows.length]!.focus());
        if (e.key === "ArrowDown") go(i + 1);
        else if (e.key === "ArrowUp") go(i - 1);
        else if (e.key === "Home") go(0);
        else if (e.key === "End") go(rows.length - 1);
        else if (e.key === "Tab") (e.preventDefault(), onClose());
      }}
    >
      {items.map((it, i) =>
        "heading" in it ? (
          <div key={i} className="menu-heading">
            {it.heading}
          </div>
        ) : "node" in it ? (
          <div key={i} className="menu-node">
            {it.node}
          </div>
        ) : "who" in it ? (
          <div key={i} className="menu-who">
            <Avatar name={it.who.name} id={it.who.id} size={34} />
            <span className="menu-who-text">
              <span className="menu-who-name">{it.who.name}</span>
              <span className="menu-who-sub">{it.who.sub}</span>
              {it.who.line && <span className="menu-who-line">{it.who.line}</span>}
            </span>
          </div>
        ) : (
          <MenuRow key={i} onClose={onClose} {...(it.action ? { action: it.action } : {})}>
          <button
            role="menuitem"
            className={`menu-item ${it.danger ? "danger" : ""} ${it.dim ? "dim" : ""}`}
            disabled={it.disabled}
            {...(it.title ? { title: it.title } : {})}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
              it.onSelect();
            }}
          >
            {it.mark ? <span className="menu-mark">{it.mark}</span> : it.icon ? <Icon name={it.icon} size={14} /> : anyIcon ? <span className="menu-spacer" /> : null}
            <span className="menu-label">
              {it.label}
              {(it.sub || below(it)) && <span className="menu-sub">{[it.sub, below(it)].filter(Boolean).join(" · ")}</span>}
            </span>
            {/* Working shows in the tick's column, so the dots line up with the ticks; on the ticked row the tick takes that place and the dot steps in beside the name. */}
            {it.live && it.checked && <span className="menu-live" title="Working" />}
            {it.hint && !below(it) && (/^\S( \S)+$/.test(it.hint) ? <span className="menu-keys">{it.hint.split(" ").map((k, i) => <kbd key={i} className="key">{k}</kbd>)}</span> : <kbd>{it.hint}</kbd>)}
            {it.checked ? <Icon name="check" size={13} className="menu-check" /> : it.live ? <span className="menu-live slot" title="Working" /> : anyCheck || anyLive ? <span className="menu-tick" /> : null}
          </button>
          </MenuRow>
        ),
      )}
    </div>,
    document.body,
  );
}

/** Single-line inline rename: Enter or blur saves, Escape cancels. */
export function InlineEdit({
  value,
  onSave,
  onCancel,
  className = "",
  maxLength = 80,
  label = "New name",
  placeholder,
}: {
  value: string;
  onSave: (v: string) => void;
  onCancel: () => void;
  className?: string;
  maxLength?: number;
  label?: string;
  placeholder?: string;
}) {
  const [v, setV] = useState(value);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const t = v.trim();
    if (save && t && t !== value) onSave(t);
    else onCancel();
  };
  return (
    <input
      className={`inline-edit ${className}`}
      aria-label={label}
      placeholder={placeholder}
      autoFocus
      value={v}
      maxLength={maxLength}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

/** The row that opens and closes the tools folded away in a list (see splitTools). */
export function MoreTools({ open, count, onToggle, className = "" }: { open: boolean; count: number; onToggle: () => void; className?: string }) {
  if (!count) return null;
  return (
    <button type="button" className={`more-tools ${className}`} aria-expanded={open} onClick={onToggle}>
      <span>{open ? "Fewer coding tools" : `${count} more coding tool${count === 1 ? "" : "s"}`}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ transform: open ? "rotate(180deg)" : undefined }}>
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, className = "" }: { value: T; options: [T, string][]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={`segmented ${className}`} role="radiogroup">
      {options.map(([v, label]) => (
        <button key={v} type="button" role="radio" aria-checked={v === value} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * A hint that appears on hover, and on keyboard focus.
 *
 * `title` is the browser's own, which is slow, unstyled and invisible to a
 * keyboard. This is the same idea said properly: one span, the text in a data
 * attribute, and CSS does the rest.
 */
const HINT_WIDTH = 260;

export function Hint({ text, children, className = "" }: { text: string; children?: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ x: number; y: number; below: boolean } | null>(null);

  // Measured from the trigger and drawn in a portal at fixed coordinates. As an
  // absolutely-positioned ::after it was clipped the moment it reached the edge
  // of a scrolling panel — which, in a settings dialog, is most of the time.
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const half = HINT_WIDTH / 2 + 8;
    const below = r.top < 130;
    setAt({
      x: Math.min(Math.max(r.left + r.width / 2, half), innerWidth - half),
      y: below ? r.bottom + 8 : r.top - 8,
      below,
    });
  };
  const hide = () => setAt(null);

  useEffect(() => {
    if (!at) return;
    // Anything that moves the trigger invalidates the position; closing is
    // simpler and less wrong than chasing it.
    addEventListener("scroll", hide, true);
    addEventListener("resize", hide);
    return () => {
      removeEventListener("scroll", hide, true);
      removeEventListener("resize", hide);
    };
  }, [at]);

  return (
    <>
      <span
        ref={ref}
        className={`hint ${className}`}
        tabIndex={0}
        role="note"
        aria-label={text}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children ?? <Icon name="help" size={12} />}
      </span>
      {at &&
        createPortal(
          <span className={`hint-bubble ${at.below ? "below" : "above"}`} style={{ left: at.x, top: at.y, width: HINT_WIDTH }} role="tooltip">
            {text}
          </span>,
          document.body,
        )}
    </>
  );
}

/** A day's bar in a usage chart, as a share of the busiest day: of the column less its label (14px) and the gap above it (6px). */
export const barHeight = (share: number): string => `calc(${share.toFixed(4)} * (100% - 20px))`;

export function relTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

export const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
};

/** What a confirmation needs to describe the thing it is about to do. */
export interface Confirmation {
  title: string;
  /** What actually happens, in the user's terms. Not a restatement of the title. */
  body?: string;
  /** The verb on the button: "Remove", "Delete", "Cancel run". */
  action: string;
  /** Destructive by default; set false for a merely significant action. */
  danger?: boolean;
  /**
   * A line of text to give, such as a new name: the field is filled with `value`, and what is typed goes to onConfirm. With
   * `match`, it is what must be typed (a team's name, to delete it): the button works only once it is, spaces around it aside.
   */
  input?: { label: string; value: string; maxLength?: number; match?: string };
  /** May return a promise: the dialog then stays open, its buttons disabled, until it settles, and shows why if it fails. */
  onConfirm: (value: string) => void | Promise<unknown>;
}

/**
 * One confirmation dialog for the whole app, replacing window.confirm().
 *
 * The native dialog can't say what is lost, can't be styled, and on some
 * platforms doesn't look like it belongs to the page at all. Since these
 * interrupt someone mid-task to ask about something irreversible, they are worth
 * the few lines: the title names the thing, the body names the consequence, and
 * Cancel holds focus so the dangerous button is never one stray Return away.
 */
export function ConfirmDialog({ confirmation, onClose }: { confirmation: Confirmation; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  // Opened by pressing something, and that something may sit inside a dialog of its own: asking "remove this?" from inside
  // a dialog must not close the dialog that is asking, and with it the question.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState(confirmation.input?.value ?? "");
  const field = useRef<HTMLInputElement>(null);
  // Escape or a press outside must not close it mid-way: the work carries on either way, and its failure would have nowhere to show.
  useDismiss(ref, () => !busy && onClose(), opener);
  // A question holds focus on Cancel, so the dangerous button is never one stray Return away; a field takes it, selected, to type over.
  useEffect(() => (confirmation.input ? field.current?.select() : cancel.current?.focus()), []); // eslint-disable-line react-hooks/exhaustive-deps

  // A dialog that closed the moment it was pressed said "done" for work that had not started, and said nothing at all when it failed.
  const unmatched = !!confirmation.input && (confirmation.input.match !== undefined ? text.trim() !== confirmation.input.match.trim() : !text.trim());
  const go = async () => {
    if (unmatched) return;
    const run = confirmation.onConfirm(text.trim());
    if (!(run instanceof Promise)) return onClose();
    setBusy(true);
    setError("");
    try {
      await run;
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return createPortal(
    <div className="overlay">
      <div className={`modal confirm ${confirmation.danger === false ? "" : "danger"}`} ref={ref} data-owned-floating role="alertdialog" aria-label={confirmation.title}>
        <div className="confirm-head">
          <span className="confirm-icon">
            <Icon name={confirmation.input && confirmation.input.match === undefined ? "pencil" : confirmation.danger === false ? "help" : "trash"} size={17} />
          </span>
          <h2>{confirmation.title}</h2>
        </div>
        {confirmation.body && <p className="confirm-body">{confirmation.body}</p>}
        {confirmation.input && (
          <input
            ref={field}
            className="confirm-input"
            aria-label={confirmation.input.label}
            value={text}
            maxLength={confirmation.input.maxLength ?? 80}
            placeholder={confirmation.input.match}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void go())}
          />
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="confirm-actions">
          <button ref={cancel} className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={confirmation.danger === false ? "btn primary" : "btn destructive"} onClick={() => void go()} disabled={busy || unmatched}>
            {confirmation.action}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Ask before doing something irreversible.
 *
 *   const [ask, confirmUI] = useConfirm();
 *   ask({ title: "Remove Stripe?", body: "…", action: "Remove", onConfirm: () => … });
 *   return <>{confirmUI}…</>;
 */
export function useConfirm(): [(c: Confirmation) => void, ReactNode] {
  const [pending, setPending] = useState<Confirmation | null>(null);
  return [setPending, pending ? <ConfirmDialog confirmation={pending} onClose={() => setPending(null)} /> : null];
}

/**
 * Draws its children in the desktop window's top band, beside the window's own buttons, instead of on the page below.
 *
 * The band is a strip the length of the window with nothing in it but those buttons. A control that belongs in the corner
 * of a page goes there rather than leaving the strip empty and pushing the page down. In a browser there is no band, so
 * the children are simply drawn where they were written.
 */
let bandSeen = false;
/**
 * Whether the desktop window's stylesheet has given the page a top band (--band). Reading a custom property makes the
 * browser work out the whole page's style there and then, which pages asked for as they opened. So a browser, which never
 * has a band, never asks, and the window asks until the band is there; it stays for the life of the page once it is.
 */
export function inBand(): boolean {
  if (!bandSeen && (window.fridayDesktop || /\bElectron\//.test(navigator.userAgent))) {
    bandSeen = getComputedStyle(document.documentElement).getPropertyValue("--band").trim() !== "";
  }
  return bandSeen;
}

export function InBand({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = document.getElementById("band-slot");
    if (!inBand() || !el || document.documentElement.dataset.band === "session") return;
    document.documentElement.dataset.band = "page";
    setSlot(el);
    return () => {
      if (document.documentElement.dataset.band === "page") delete document.documentElement.dataset.band;
    };
  }, []);
  return slot ? createPortal(children, slot) : <>{children}</>;
}

// ── loading ─────────────────────────────────────────────────────────
//
// What is coming, in its own shape, while it comes: a blank space or a spinner says only "wait", and the page jumps when
// the real thing lands. These hold the room the content will take, so nothing moves when it arrives.

/** One placeholder block. Width and height in any CSS length; it shimmers unless motion is reduced. */
export function Skeleton({ w = "100%", h = 12, r, className = "" }: { w?: number | string; h?: number | string; r?: number | string; className?: string }) {
  return <span className={`sk ${className}`} aria-hidden style={{ width: w, height: h, ...(r !== undefined ? { borderRadius: r } : {}) }} />;
}

/** A few lines of text: the last one shorter, as a paragraph's is. */
export function SkeletonLines({ lines = 3, gap = 10 }: { lines?: number; gap?: number }) {
  return (
    <div className="sk-lines" style={{ gap }} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} w={i === lines - 1 && lines > 1 ? "62%" : "100%"} />
      ))}
    </div>
  );
}

/** Cards in a grid, for a page of tiles (skills, agents, the board). */
export function SkeletonCards({ count = 6, h = 112, min = 240 }: { count?: number; h?: number; min?: number }) {
  return (
    <div className="sk-cards" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="sk-card" style={{ height: h }}>
          <Skeleton w="45%" h={13} />
          <SkeletonLines lines={2} gap={8} />
        </div>
      ))}
    </div>
  );
}

/** Rows of a list or table: a mark, a name and a figure at the end. */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="sk-rows" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sk-row">
          <Skeleton w={18} h={18} r={6} />
          <Skeleton w={`${38 + ((i * 17) % 30)}%`} />
          <Skeleton w={56} className="sk-end" />
        </div>
      ))}
    </div>
  );
}

/**
 * A session while its code or its history loads: the session's own shape (its header, a few turns, the box to write in),
 * so it fills in rather than appears. Here and not in SessionView, so the app can show it before that screen's code arrives.
 */
export function SessionSkeleton() {
  return (
    <div className="sk-session" role="status" aria-label="Opening the session">
      <div className="sk-session-bar">
        <Skeleton w={200} h={16} r={6} />
        <Skeleton w={90} h={12} />
        <Skeleton w={150} h={28} r={8} className="sk-end" />
      </div>
      <div className="sk-session-feed">
        <div className="sk-turn mine">
          <div className="sk-turn-body">
            <Skeleton w="100%" h={40} r={14} />
          </div>
        </div>
        {[0, 1].map((i) => (
          <div key={i} className="sk-turn">
            <Skeleton w={26} h={26} r={13} />
            <div className="sk-turn-body">
              <Skeleton w={120} h={13} />
              <SkeletonLines lines={i ? 2 : 3} />
              <Skeleton w="58%" h={34} r={10} />
            </div>
          </div>
        ))}
      </div>
      <div className="sk-session-box" />
    </div>
  );
}

/** A full page while its code or its data loads: the title, then what pages here are made of. */
export function PageSkeleton({ label = "Loading" }: { label?: string }) {
  return (
    <div className="page conns-page" role="status" aria-label={label}>
      <div className="page-inner">
        <div className="sk-head">
          <Skeleton w={160} h={24} r={7} />
          <Skeleton w={280} h={12} />
        </div>
        <SkeletonCards count={6} />
      </div>
    </div>
  );
}

/**
 * What couldn't be copied, shown to copy by hand: selected, in a field that can't be changed (Arun, 2026-10-24: UX gaps). A copy
 * that failed said so for a moment and the link was gone with it; the desktop app has no prompt() to fall back on.
 */
export function ShownText({ text, label = "Copy this yourself" }: { text: string; label?: string }) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, [text]);
  const select = () => ref.current?.select();
  return text.includes("\n") ? (
    <textarea ref={ref} className="shown-text" readOnly value={text} aria-label={label} rows={Math.min(5, text.split("\n").length)} onFocus={select} />
  ) : (
    <input ref={ref} className="shown-text" readOnly value={text} aria-label={label} onFocus={select} />
  );
}
