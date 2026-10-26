import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { ToolCommand } from "../types.js";
import { Icon, type IconName } from "./icons.js";

/**
 * `/` for a command and `@` for a file, in the session composer.
 *
 * The two things people type most in a coding session are the same few asks
 * ("run the tests and fix what fails") and the paths of files. Both are typing
 * that the product can do for them, and both are discovered the way every
 * editor already taught people: type the character, see the list.
 *
 * A command is just words. Picking one writes a well-formed instruction into
 * the box, where it can be read and edited before it is sent — nothing
 * happens that the room can't see in the message itself.
 */

export interface SlashCommand {
  name: string;
  hint: string;
  icon: IconName;
  /** What goes in the box. A trailing space leaves the caret ready for the rest of the sentence. */
  text: string;
}

/** Whether this is a Mac, for writing shortcuts the way this keyboard labels them. */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const ON_PC: Record<string, string> = { "⌘": "Ctrl", "⇧": "Shift", "⌥": "Alt", "⌃": "Ctrl" };
/** One key as this keyboard names it: ⌘ on a Mac, Ctrl everywhere else. */
export const keyLabel = (k: string): string => (IS_MAC ? k : (ON_PC[k] ?? k));
/** A whole shortcut, as written in a hint: "⌘⇧P" stays on a Mac and is "Ctrl+Shift+P" everywhere else. */
export const shortcut = (s: string): string => (IS_MAC ? s : [...s].map((c) => (ON_PC[c] ? `${ON_PC[c]}+` : c)).join("").replace(/\+$/, ""));

/** Every key the app answers to, for the ? list and the Shortcuts tab in Settings. */
/** Every key that does something, grouped by where it works, so a row no longer has to say "Code Review:" or "in a session". */
export const SHORTCUTS: { title: string; keys: [string[], string][] }[] = [
  {
    title: "Anywhere",
    keys: [
      [["⌘", "K"], "Sessions, agents, files and everything the app can do"],
      [["⌘", "⇧", "P"], "The same, as editors bind it"],
      [["⌘", "⇧", "F"], "Search sessions and everything said in them"],
      [["⌘", "B"], "Show or hide the sidebar"],
      [["⌘", "⌥", "1", "–", "9"], "Go to a session in the sidebar, counting from the top"],
      [["⌃", "Tab"], "Back to the session you were in before (⇧ goes the other way)"],
      [["⌘", "⇧", "U"], "Next session that's waiting on you"],
      [["⌘", "⇧", "Space"], "Quick prompt from anywhere on your computer, with a snapshot of the screen (desktop app)"],
      [["Esc"], "Close menus and dialogs"],
      [["?"], "Show this list"],
    ],
  },
  {
    title: "In a session",
    keys: [
      [["⌘", "P"], "Open a file"],
      [["⌘", "Click"], "On a file in an answer: open it in your own editor, at its line (desktop app)"],
      [["⌘", "S"], "Save the file you are editing"],
      [["⌘", "."], "Show or hide the document"],
      [["⌘", "1"], "Tasks"],
      [["⌘", "2"], "Diff"],
      [["⌘", "3"], "Terminal"],
      [["⌘", "4"], "Preview"],
    ],
  },
  {
    title: "Message box",
    keys: [
      [["/"], "Jump to the message box"],
      [["/", "…"], "A ready-made ask"],
      [["@", "…"], "Mention a person (tells them)"],
      [["#", "…"], "Point to a file"],
      [["↑"], "In an empty box, bring back what you asked before"],
      [["↵"], "Send"],
      [["⇧", "↵"], "New line"],
    ],
  },
  {
    title: "Code Review",
    keys: [
      [["J", "/", "K"], "Next or previous pull request"],
      [["O"], "Open or close the selected one"],
      [["R"], "Have your agents review it"],
      [["A"], "Approve it, when it's waiting on you"],
      [["M"], "Merge it, when it's ready"],
      [["G"], "Open it on GitHub"],
      [["1", "–", "4"], "Switch tabs"],
    ],
  },
];

/** The list, as the "?" sheet and Settings › Shortcuts both show it: one source, so the two can't drift apart. */
export function ShortcutList() {
  return (
    <div className="kbd-groups">
      {SHORTCUTS.map((g) => (
        <section key={g.title} className="kbd-group" aria-labelledby={`kbd-${g.title.replace(/\W+/g, "-")}`}>
          <h3 className="kbd-group-title" id={`kbd-${g.title.replace(/\W+/g, "-")}`}>
            {g.title}
          </h3>
          <ul className="kbd-list">
            {g.keys.map(([keys, what]) => (
              <li key={what}>
                <span>{what}</span>
                <span className="keys">
                  {keys.map((k, i) =>
                    k === "/" && i > 0 && i < keys.length - 1 ? (
                      <span key={i} className="kbd-sep">/</span>
                    ) : k === "–" ? (
                      <span key={i} className="kbd-sep">–</span>
                    ) : (
                      <kbd key={i}>{keyLabel(k)}</kbd>
                    ),
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export const COMMANDS: SlashCommand[] = [
  { name: "test", icon: "check", hint: "Run the tests, fix what fails", text: "Run the project's tests. If anything fails, find the cause, fix it, and run them again until they pass. Say what you changed and why." },
  { name: "fix", icon: "search", hint: "Find the cause and fix it", text: "Find the root cause of this and fix it, then check the fix works: " },
  { name: "review", icon: "eye", hint: "Review the changes so far", text: "Review the changes made in this session for bugs, security problems and anything that doesn't fit how this codebase does things. List each finding with file:line and how serious it is. Don't change anything yet." },
  { name: "plan", icon: "list", hint: "Plan before changing anything", text: "Before changing anything, read the relevant code and write a short plan: which files change, how, and what could break. Wait for a go-ahead. The task: " },
  { name: "explain", icon: "help", hint: "How does this work?", text: "Explain how this works, citing the files and lines that matter: " },
  { name: "tests", icon: "flask", hint: "Write tests for something", text: "Write tests for this, following the test setup the project already uses, and run them: " },
  { name: "lint", icon: "shield", hint: "Typecheck and lint, fix errors", text: "Run the project's typechecker and linter and fix every error they report. Don't silence rules to make them pass." },
  { name: "commit-msg", icon: "pencil", hint: "Summarise the changes for a commit", text: "Summarise everything changed in this session as a commit message: an imperative subject under 65 characters, a blank line, then what changed and why." },
];

/**
 * One command per connected MCP.
 *
 * A connection is only useful if the agent thinks to reach for it, and the
 * agent thinks to reach for it if the instruction names it. Typing `/gmail`
 * writes that sentence, so the connection is discoverable from the box rather
 * than from the settings page it was added on.
 *
 * Only the ones that are on and answering: offering a connection that is
 * disabled or erroring writes an instruction the agent cannot carry out.
 */
export function mcpCommands(connections: { name: string; enabled: boolean; status: { state: string; tools: { name: string }[] } }[]): SlashCommand[] {
  return connections
    .filter((c) => c.enabled && c.status.state === "connected")
    .map((c) => {
      const tools = c.status.tools.length;
      return {
        name: c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        icon: "plug" as IconName,
        hint: tools ? `${c.name} · ${tools} tool${tools === 1 ? "" : "s"}` : c.name,
        text: `Use the ${c.name} connection to `,
      };
    })
    .filter((c) => c.name);
}

/** A command the team or you saved, as the composer lists it: it says whose it is, so a shared one is not mistaken for a built-in. */
export function savedCommands(list: { name: string; hint: string; text: string; scope: "personal" | "workspace" }[]): SlashCommand[] {
  return list.map((c) => ({ name: c.name, icon: "zap" as IconName, hint: `${c.scope === "workspace" ? "Team" : "Yours"} · ${c.hint}`, text: c.text }));
}

export interface SavedCommandRow {
  id: string;
  name: string;
  hint: string;
  text: string;
  scope: "personal" | "workspace";
  ownerId: string;
  ownerName: string;
}

/** The commands this person can run, read once and again whenever the manager changes them. */
export function useSavedCommands(): { commands: SavedCommandRow[]; reload: () => void } {
  const [commands, setCommands] = useState<SavedCommandRow[]>([]);
  const load = () =>
    fetch("/api/commands")
      .then((r) => (r.ok ? (r.json() as Promise<{ commands: SavedCommandRow[] }>) : { commands: [] }))
      .then((d) => setCommands(d.commands))
      .catch(() => {});
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener("friday:commands", on);
    return () => window.removeEventListener("friday:commands", on);
  }, []);
  return { commands, reload: () => void load() };
}

type Open = { kind: "command" | "file" | "person"; query: string; start: number };

/** What the caret is in the middle of typing, if it is a command or a mention. */
export function tokenAt(text: string, caret: number): Open | null {
  const before = text.slice(0, caret);
  // Colons and dots too: Claude Code's plugin commands ("/ponytail:audit") and Codex's prompts ("/prompts:fix").
  const cmd = before.match(/^\/([\w:.-]*)$/);
  if (cmd) return { kind: "command", query: cmd[1]!.toLowerCase(), start: 0 };
  // "@" is for people and "#" for files, so naming a teammate never opens the folder (Arun, 2026-10-21).
  const at = before.match(/(^|\s)@([\w.'-]*)$/);
  if (at) return { kind: "person", query: at[2]!.toLowerCase(), start: caret - at[2]!.length - 1 };
  const hash = before.match(/(^|\s)#([\w./\\-]*)$/);
  if (hash) return { kind: "file", query: hash[2]!.toLowerCase(), start: caret - hash[2]!.length - 1 };
  return null;
}

/**
 * Files that match what was typed, best first.
 *
 * The file name matching beats the folder matching, and a shorter path beats a
 * longer one: typing `app` should offer `src/app.ts` before
 * `src/components/apparel/list.tsx`.
 */
export function rankFiles(files: string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  if (!q) return files.slice(0, limit);
  const scored: [number, string][] = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let score = -1;
    if (base.startsWith(q)) score = 0;
    else if (base.includes(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    else if (subsequence(lower, q)) score = 3;
    if (score >= 0) scored.push([score * 1000 + f.length, f]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, f]) => f);
}

function subsequence(text: string, q: string): boolean {
  let i = 0;
  for (const ch of text) if (ch === q[i] && ++i === q.length) return true;
  return false;
}

/** Set a textarea's value the way typing would, so React's onChange sees it. */
function setValue(el: HTMLTextAreaElement, value: string, caret: number) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  el.setSelectionRange(caret, caret);
}

/** The last command list each lane's tool gave, for this tab; and per tool across visits, so a new page has one to show at once. */
const cmdsHere = new Map<string, ToolCommand[]>();
const CMDS_KEY = (tool: string) => `friday.cmds.${tool}`;
function knownCmds(sid: string, lane: string, tool: string): { lane: string; list: ToolCommand[] } | null {
  const here = cmdsHere.get(`${sid}|${lane}`);
  if (here) return { lane, list: here };
  try {
    const saved = JSON.parse(localStorage.getItem(CMDS_KEY(tool)) ?? "null") as ToolCommand[] | null;
    return Array.isArray(saved) && saved.every((c) => typeof c?.name === "string" && typeof c?.insert === "string") ? { lane, list: saved } : null;
  } catch {
    return null;
  }
}
function keepCmds(sid: string, lane: string, tool: string, list: ToolCommand[]): void {
  cmdsHere.set(`${sid}|${lane}`, list);
  try {
    localStorage.setItem(CMDS_KEY(tool), JSON.stringify(list.slice(0, 200)));
  } catch {
    // Not kept for next time: this tab still has it.
  }
}

export function useShortcuts({
  textarea,
  sid,
  invite,
  commands,
  files: filesEnabled,
  connections = [],
  saved = [],
  onManage,
  lane = "main",
  tool,
  people = [],
}: {
  /** The other people in the session: "@" offers them before files, and naming one tells them (mentions.ts). */
  people?: { id: string; name: string; online?: boolean }[];
  /** The lane the box writes to. */
  lane?: string;
  /** The coding tool that lane runs (Claude Code, Codex, Cursor): its own commands are offered, not Friday's. */
  tool?: string;
  saved?: SlashCommand[];
  /** Open the place where commands are made and deleted. */
  onManage?: () => void;
  textarea: RefObject<HTMLTextAreaElement | null>;
  sid: string;
  invite: string;
  commands: boolean;
  files: boolean;
  /** Connected MCPs, each of which becomes a command of its own. */
  connections?: { name: string; enabled: boolean; status: { state: string; tools: { name: string }[] } }[];
}) {
  const [open, setOpen] = useState<Open | null>(null);
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState<string[] | null>(null);
  const fetched = useRef(0);
  /**
   * The tool's own commands. Asked of its machine (the server, then the runner, then back) only once "/" was typed, they took
   * a second or more to arrive and the list said "Asking …" every time. Now asked as soon as the lane is open and kept: the
   * last list shows at once, from this tab or from the last visit, and a fresh one replaces it quietly.
   */
  const [toolCmds, setToolCmds] = useState<{ lane: string; list: ToolCommand[] } | null>(() => (tool ? knownCmds(sid, lane, tool) : null));
  const askedCmds = useRef({ at: 0, lane: "" });
  useEffect(() => {
    if (!tool) return;
    const known = knownCmds(sid, lane, tool);
    if (known && toolCmds?.lane !== lane) setToolCmds(known);
    // Asked again sooner while it has none: Claude Code gives its list a few seconds after it starts.
    if (askedCmds.current.lane === lane && Date.now() - askedCmds.current.at < (toolCmds?.list.length ? 60_000 : 5_000)) return;
    askedCmds.current = { at: Date.now(), lane };
    fetch(`/api/sessions/${encodeURIComponent(sid)}/repo?op=commands&lane=${encodeURIComponent(lane)}&invite=${encodeURIComponent(invite)}`)
      .then((r) => r.json() as Promise<{ output?: string }>)
      .then((d) => {
        const list = (JSON.parse(d.output ?? "{}") as { commands?: ToolCommand[] }).commands;
        const fresh = { lane, list: Array.isArray(list) ? list : [] };
        // An empty answer (the tool not started yet) doesn't wipe a list it gave before.
        if (fresh.list.length || !known) setToolCmds(fresh);
        if (fresh.list.length) keepCmds(sid, lane, tool, fresh.list);
      })
      .catch(() => setToolCmds((c) => c ?? { lane, list: [] }));
  }, [open?.kind, tool, lane, sid, invite]); // eslint-disable-line react-hooks/exhaustive-deps
  const own = toolCmds?.lane === lane ? toolCmds.list : null;

  // The folder can change under a run, so the list is fetched again when it is
  // more than half a minute old — not on every keystroke.
  useEffect(() => {
    if (open?.kind !== "file" || !filesEnabled || Date.now() - fetched.current < 30_000) return;
    fetched.current = Date.now();
    fetch(`/api/sessions/${encodeURIComponent(sid)}/repo?op=tree&invite=${encodeURIComponent(invite)}`)
      .then((r) => r.json() as Promise<{ output?: string }>)
      .then((d) => setFiles((d.output ?? "").split("\n").slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith("["))))
      .catch(() => setFiles([]));
  }, [open?.kind, filesEnabled, sid, invite]);

  const write = (insert: string) => {
    const el = textarea.current;
    if (!el) return;
    setValue(el, insert + el.value.slice(el.selectionStart), insert.length);
    setOpen(null);
  };
  const items: { key: string; label: string; hint?: string; icon: IconName; pick: () => void }[] =
    open?.kind === "command" && commands && tool
      ? // A coding tool's lane: the team's own commands, then the tool's (Claude Code runs its own; Codex's and Cursor's prompt
        // files and skills are expanded as their terminals would). Friday's built-in asks are for Friday's agents.
        [
          ...saved.filter((c) => c.name.startsWith(open.query)).map((c) => ({ key: `saved:${c.name}`, label: `/${c.name}`, hint: c.hint, icon: c.icon, pick: () => write(c.text) })),
          ...(own ?? [])
            .filter((c) => c.name.toLowerCase().startsWith(open.query))
            // In the order a person scans for one: Claude Code lists its built-in ones after every skill and plugin.
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, 80)
            .map((c) => ({ key: `tool:${c.name}`, label: c.insert.trim(), hint: c.hint ? `${c.hint} · ${c.description}` : c.description, icon: (c.insert.startsWith("$") ? "skills" : "terminal") as IconName, pick: () => write(c.insert) })),
        ]
      : open?.kind === "command" && commands
      ? // The built-in asks first, then a command for each connection: the
        // eight are the same every time and worth learning; the connections
        // are this workspace's own.
        [...saved, ...COMMANDS, ...mcpCommands(connections)].filter((c) => c.name.startsWith(open.query)).map((c) => ({
          key: c.name,
          label: `/${c.name}`,
          hint: c.hint,
          icon: c.icon,
          pick: () => {
            const el = textarea.current;
            if (!el) return;
            setValue(el, c.text + el.value.slice(el.selectionStart), c.text.length);
            setOpen(null);
          },
        }))
      : open?.kind === "person" && people.length
        ? [
          ...people
            .filter((p) => !open.query || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(open.query.toLowerCase())) || p.name.toLowerCase().startsWith(open.query.toLowerCase()))
            .slice(0, 6)
            .map((p) => ({
              key: `person:${p.id}`,
              label: p.name,
              hint: p.online ? "Here now · tells them" : "Tells them",
              icon: "user" as IconName,
              pick: () => {
                const el = textarea.current;
                if (!el) return;
                const head = `${el.value.slice(0, open.start)}@${p.name} `;
                setValue(el, head + el.value.slice(el.selectionStart), head.length);
                setOpen(null);
              },
            })),
        ]
      : open?.kind === "file" && filesEnabled
        ? [
          ...rankFiles(files ?? [], open.query).map((f) => ({
            key: f,
            label: f.slice(f.lastIndexOf("/") + 1),
            hint: f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "",
            icon: "file" as IconName,
            pick: () => {
              const el = textarea.current;
              if (!el) return;
              // The path in backticks: every agent reads it as a file, and it can't be taken for a person.
              const head = `${el.value.slice(0, open.start)}\`${f}\` `;
              setValue(el, head + el.value.slice(el.selectionStart), head.length);
              setOpen(null);
            },
          })),
        ]
        : [];

  /** Call after every change and caret move. */
  const sync = () => {
    const el = textarea.current;
    if (!el) return;
    const t = tokenAt(el.value, el.selectionStart);
    setOpen(t && (t.kind === "command" ? commands : t.kind === "person" ? people.length > 0 : filesEnabled) ? t : null);
    setActive(0);
  };

  /** Returns true when the key was used by the list, so the composer should not act on it. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    // Enter while an input method is composing confirms the characters, not a pick from the list.
    if (!open || e.nativeEvent.isComposing) return false;
    // Escape closes the list even while it is empty or still asking for its commands.
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(null);
      return true;
    }
    // The caret moving sideways may leave the word the list was for: look again once it has moved.
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      setTimeout(sync, 0);
      return false;
    }
    if (!items.length) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      items[Math.min(active, items.length - 1)]!.pick();
      return true;
    }
    return false;
  };

  const popover =
    open && (items.length > 0 || (open.kind === "file" && filesEnabled && files === null) || (open.kind === "command" && commands && !!tool)) ? (
      <div className="shortcut-pop" role="listbox" aria-label={open.kind === "command" ? "Commands" : open.kind === "person" ? "People" : "Files"}>
        <div className="shortcut-head">{open.kind === "command" ? (tool ? `${tool} commands` : "Commands") : open.kind === "person" ? "People here" : "Files in the folder"}</div>
        {open.kind === "file" && filesEnabled && files === null && <div className="shortcut-empty">Reading the folder…</div>}
        {open.kind === "command" && tool && own === null && <div className="shortcut-empty">Asking {tool} for its commands…</div>}
        {open.kind === "command" && tool && own !== null && !items.length && (
          <div className="shortcut-empty">
            {open.query
              ? `${tool} has no command starting with “${open.query}”.`
              : tool === "Claude Code"
                ? "Claude Code lists its commands when it starts, at your first message, and they show here from then on. A command typed now is sent as typed."
                : tool === "Codex" || tool === "Cursor"
                  ? `${tool}'s built-in commands only work in its own terminal. Its ${tool === "Codex" ? "prompts (~/.codex/prompts) and skills" : "commands (.cursor/commands) and skills"} show up here.`
                  : `${tool} lists its commands once it has run here. One typed now is sent to it as typed.`}
          </div>
        )}
        {items.map((it, i) => (
          <button
            key={it.key}
            type="button"
            role="option"
            aria-selected={i === active}
            className={`shortcut-item ${i === active ? "on" : ""}`}
            // Mouse down, not click: a click blurs the textarea first and the caret is lost.
            onMouseDown={(e) => {
              e.preventDefault();
              it.pick();
            }}
            onMouseEnter={() => setActive(i)}
          >
            <Icon name={it.icon} size={13} />
            <span className="shortcut-label">{it.label}</span>
            {it.hint && <span className="shortcut-hint">{it.hint}</span>}
          </button>
        ))}
        {open.kind === "command" && onManage && (
          <button type="button" className="shortcut-manage" onMouseDown={(e) => (e.preventDefault(), setOpen(null), onManage())}>
            <Icon name="plus" size={12} /> Save your own command
          </button>
        )}
      </div>
    ) : null;

  return { popover, onKeyDown, sync, close: () => setOpen(null) };
}
