import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SECTIONS } from "./Settings.js";
import { Avatar, Icon, type IconName } from "./icons.js";
import type { RecentSession } from "./storage.js";
import { shortcut } from "./Shortcuts.js";
import { useDismiss } from "./ui.js";
import { openWorkflows } from "./team-workflow-view.js";
import { choosePlace } from "./WorkMode.js";

export interface Action {
  id: string;
  label: string;
  hint?: string;
  icon?: IconName;
  /** The person this row is about, drawn as their avatar instead of an icon. */
  who?: { id: string; name: string };
  group: string;
  run: () => void;
}

// Grouped, the way the search window and every menu here read: a heading per kind, in the order the kinds first came.
// Matching is on what a row says (its label and hint), never its group: "set" used to find every session through "Sessions".
export function paletteGroups(actions: Action[], q: string): { group: string; items: Action[] }[] {
  const needle = q.trim().toLowerCase();
  // Letters scattered through a long title match nearly anything ("set" is in "tidy up the login code"), so when some row
  // holds the words themselves or their first letters, only those are shown; the scattered kind is for when nothing does.
  const close = (hay: string) => hay.includes(needle) || initials(hay).startsWith(needle.replace(/\s+/g, ""));
  const all = needle
    ? actions.map((a) => ({ a, hay: `${a.label} ${a.hint ?? ""}`.toLowerCase() })).map((x) => ({ ...x, score: fuzzy(x.hay, needle) + (close(x.hay) ? 100 : 0) })).filter((x) => x.score > 0)
    : [];
  const anyClose = all.some((x) => x.score >= 100);
  const scored = needle
    ? all
        .filter((x) => !anyClose || x.score >= 100)
        .sort((x, y) => y.score - x.score)
        .slice(0, 40)
    : actions.slice(0, 60).map((a) => ({ a, score: 0 }));
  const out: { group: string; items: Action[] }[] = [];
  for (const { a } of scored) {
    const g = out.find((x) => x.group === a.group);
    if (g) g.items.push(a);
    else out.push({ group: a.group, items: [a] });
  }
  return out;
}

/**
 * Everything the app can do, from the keyboard.
 *
 * A product grows places faster than it grows room for buttons, and the answer
 * everywhere else is the same one: one key, type what you want. It is worth
 * more than a menu because it takes what you already call the thing — the name
 * of the session, of the person — rather than where somebody filed it.
 *
 * Matching is the same forgiving kind the file opener uses: the letters in
 * order, not necessarily together, so "revch" finds "Review a change".
 */
export function Palette({ actions, onClose, onNew }: { actions: Action[]; onClose: () => void; /** Start a session with what was typed: offered under the matches once a few words are in, and alone when nothing matches. */ onNew?: (q: string) => void }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);

  const groups = useMemo(() => {
    const g = paletteGroups(actions, q);
    // ⌘K used to go straight to a new session: a task typed here still gets one, as the last row (the first when nothing else matches).
    if (onNew && q.trim().length >= 2) g.push({ group: "Start", items: [{ id: "new-with", label: `New session: “${q.trim()}”`, icon: "plus", group: "Start", run: () => onNew(q.trim()) }] });
    return g;
  }, [actions, q, onNew]);
  const flat = groups.flatMap((g) => g.items);

  useEffect(() => setAt(0), [q]);
  const chosen = flat[Math.min(at, flat.length - 1)];
  const optionId = (a: Action) => `pal-${a.id}`;
  useEffect(() => {
    if (chosen) document.getElementById(optionId(chosen))?.scrollIntoView({ block: "nearest" });
  }, [chosen]);
  const run = (a: Action) => {
    onClose();
    a.run();
  };
  // A dialog like the others: Tab stays in it, Escape closes it from anywhere in it, search can't open over it, and the focus goes
  // back where it was (2026-10-27 audit: Tab walked out to the page behind, and ⌘⇧F opened a second dialog on top).
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, onClose);

  return (
    <div className="quick-back" role="presentation" onMouseDown={onClose}>
      <div ref={box} className="quick srch palette" role="dialog" aria-modal="true" aria-label="What do you want to do?" onMouseDown={(e) => e.stopPropagation()}>
        <div className="srch-find">
          <Icon name="zap" size={16} />
          <input
            autoFocus
            value={q}
            spellCheck={false}
            placeholder="What do you want to do?"
            aria-label="What do you want to do?"
            role="combobox"
            aria-expanded="true"
            aria-controls="pal-list"
            aria-activedescendant={chosen ? optionId(chosen) : undefined}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              // Round from the last to the first and back, as every menu here goes (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
              if (e.key === "ArrowDown" && flat.length) (e.preventDefault(), setAt((i) => (Math.min(i, flat.length - 1) + 1) % flat.length));
              if (e.key === "ArrowUp" && flat.length) (e.preventDefault(), setAt((i) => (Math.min(i, flat.length - 1) - 1 + flat.length) % flat.length));
              if (e.key === "Escape") onClose();
              if (e.key === "Enter" && chosen) (e.preventDefault(), run(chosen));
            }}
          />
          <kbd className="srch-esc">Esc</kbd>
        </div>
        <span className="sr-only" role="status">
          {flat.length === 0 && q.trim() ? `Nothing matches ${q.trim()}` : ""}
        </span>
        <div className="srch-body" id="pal-list" role="listbox" aria-label="Actions">
          {flat.length === 0 ? (
            <div className="srch-empty">
              <p className="srch-empty-title">Nothing matches “{q}”</p>
              <p className="srch-note">Try another word, or search what was said in your sessions with {shortcut("⌘⇧F")}.</p>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.group} className="srch-group" role="group" aria-label={g.group}>
                <h3>{g.group}</h3>
                {g.items.map((a) => (
                  <div
                    key={a.id}
                    id={optionId(a)}
                    role="option"
                    aria-selected={a === chosen}
                    className={`srch-row${a === chosen ? " on" : ""}`}
                    title={a.label}
                    onMouseEnter={() => setAt(flat.indexOf(a))}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => run(a)}
                  >
                    {a.who ? <Avatar name={a.who.name} id={a.who.id} size={18} /> : <Icon name={a.icon ?? "chevronRight"} size={15} />}
                    <span className="srch-title">{marked(a.label, q)}</span>
                    {a.hint && <kbd className="pal-key">{a.hint}</kbd>}
                  </div>
                ))}
              </section>
            ))
          )}
        </div>
        <div className="srch-foot" aria-hidden>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> to run
          </span>
          <span>
            <kbd>Esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The order the palette shows with nothing typed: a new session and the search first, the sessions you were in, then what the
 * open session offers, then the rest of the app. Reaching a session is what people do most, and a new one is what ⌘K meant.
 */
export function paletteOrder(session: Action[], base: Action[]): Action[] {
  const first = base.filter((a) => a.group === "Session");
  const recents = base.filter((a) => a.group === "Sessions");
  const rest = base.filter((a) => a.group !== "Session" && a.group !== "Sessions");
  return [...first, ...recents, ...session, ...rest];
}

/**
 * Where the typed letters are in a row's name: the words together where they are, else each letter in order, as the matching
 * finds them. Shown marked, as the search window marks what it found (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
 */
export function matchSpans(label: string, q: string): [number, number][] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const hay = label.toLowerCase();
  const at = hay.indexOf(needle);
  if (at >= 0) return [[at, at + needle.length]];
  const out: [number, number][] = [];
  let i = 0;
  for (const ch of needle.replace(/\s+/g, "")) {
    const found = hay.indexOf(ch, i);
    if (found < 0) return [];
    const last = out[out.length - 1];
    if (last && last[1] === found) last[1] = found + 1;
    else out.push([found, found + 1]);
    i = found + 1;
  }
  return out;
}

function marked(label: string, q: string): ReactNode {
  const spans = matchSpans(label, q);
  if (!spans.length) return label;
  const parts: ReactNode[] = [];
  let from = 0;
  spans.forEach(([a, z], i) => {
    if (a > from) parts.push(label.slice(from, a));
    parts.push(<mark key={i}>{label.slice(a, z)}</mark>);
    from = z;
  });
  if (from < label.length) parts.push(label.slice(from));
  return parts;
}

/** The first letter of each word: "Code Review" is "cr". */
const initials = (hay: string) =>
  hay
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("");

/** Letters in order, scoring a run of them together above the same letters scattered. */
function fuzzy(hay: string, needle: string): number {
  let i = 0;
  let score = 0;
  let run = 0;
  for (const ch of needle) {
    const found = hay.indexOf(ch, i);
    if (found < 0) return 0;
    run = found === i ? run + 1 : 0;
    score += 1 + run;
    i = found + 1;
  }
  return score;
}

/**
 * The rows that exist wherever you are.
 *
 * Sessions come first among them because reaching one is the thing people do
 * most, and they are the rows a menu could never hold.
 */
export function baseActions(p: {
  recents: RecentSession[];
  open: (r: RecentSession) => void;
  newSession: () => void;
  goto: (where: "connections" | "agents" | "automations" | "people" | "board" | "review" | "usage" | "settings") => void;
  toggleSidebar: () => void;
  showShortcuts: () => void;
  search?: () => void;
  look?: (l: "light" | "dark") => void;
  /** People and Connections are Team's: on Solo they aren't offered here, as they aren't on the rail. */
  team?: boolean;
  /** The library's first steps, from anywhere: each goes to its page and opens the same thing its button there does. */
  newAgent?: () => void;
  invite?: () => void;
  /** The open-source edition: no Saved agents page to go to. */
  local?: boolean;
}): Action[] {
  return [
    { id: "new", label: "New session", hint: "↵", icon: "plus", group: "Session", run: p.newSession },
    ...(p.search ? [{ id: "search", label: "Search sessions and what was said", hint: shortcut("⌘⇧F"), icon: "search" as const, group: "Session", run: p.search }] : []),
    ...(p.newAgent ? [{ id: "new-agent", label: "New agent", icon: "agent" as const, group: "Create", run: p.newAgent }] : []),
    ...(p.invite && p.team !== false ? [{ id: "invite", label: "Invite someone by email", icon: "mail" as const, group: "Create", run: p.invite }] : []),
    { id: "board", label: "Agent Board", icon: "board", group: "Go to", run: () => p.goto("board") },
    { id: "review", label: "Code Review", icon: "gitPullRequest", group: "Go to", run: () => p.goto("review") },
    { id: "automations", label: "Automations", icon: "zap", group: "Go to", run: () => p.goto("automations") },
    { id: "workflows", label: "Crew workflows", icon: "zap", group: "Go to", run: openWorkflows },
    // The sidebar's Code, Work and Crew from the keyboard (Arun, 2026-10-28: "iron everything and ensure we are good").
    { id: "place-code", label: "Switch to Code", icon: "code", group: "Go to", run: () => choosePlace("code") },
    { id: "place-work", label: "Switch to Work", icon: "pencil", group: "Go to", run: () => choosePlace("work") },
    { id: "place-team", label: "Switch to Crew", icon: "users", group: "Go to", run: () => choosePlace("team") },
    ...(p.local ? [] : [{ id: "agents", label: "Saved agents", icon: "agent" as const, group: "Go to", run: () => p.goto("agents") }]),
    { id: "usage", label: "Usage", icon: "usage", group: "Go to", run: () => p.goto("usage") },
    ...(p.team === false
      ? []
      : [
          { id: "people", label: "People", icon: "users" as const, group: "Go to", run: () => p.goto("people") },
        ]),
    { id: "settings", label: "Settings", icon: "settings", group: "Go to", run: () => p.goto("settings") },
    // Every Settings section by name, so "appearance" or "shortcuts" lands on its page without a second search.
    ...SECTIONS.map((s) => ({ id: `settings-${s.id}`, label: `Settings · ${s.label}`, icon: "settings" as const, group: "Go to", run: () => dispatchEvent(new CustomEvent("friday:settings", { detail: { tab: s.id } })) })),
    // The waiting cards come last in the Tab order (after the page); this goes straight to the first one.
    ...(typeof document !== "undefined" && document.querySelector(".wy-toasts .wy-open, .wy-pill")
      ? [{ id: "waiting", label: "Go to what is waiting on you", icon: "hand" as const, group: "Go to", run: () => requestAnimationFrame(() => document.querySelector<HTMLElement>(".wy-toasts .wy-open, .wy-pill")?.focus()) }]
      : []),
    { id: "sidebar", label: "Show or hide the sidebar", hint: shortcut("⌘B"), icon: "panel", group: "View", run: p.toggleSidebar },
    ...(p.look
      ? [
          { id: "look-light", label: "Use the light look", icon: "sun" as const, group: "View", run: () => p.look!("light") },
          { id: "look-dark", label: "Use the dark look", icon: "moon" as const, group: "View", run: () => p.look!("dark") },
        ]
      : []),
    { id: "keys", label: "Keyboard shortcuts", hint: "?", icon: "keyboard", group: "View", run: p.showShortcuts },
    ...p.recents.slice(0, 20).map((r) => ({
      id: `session-${r.sid}`,
      label: r.title || "Untitled session",
      icon: "message" as const,
      group: "Sessions",
      run: () => p.open(r),
    })),
  ];
}
