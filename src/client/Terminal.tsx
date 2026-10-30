// xterm styles the grid it draws; the panel styles everything around it.

/**
 * Where shells come from: the desktop app's own (window.fridayDesktop.terminal), or the hosted Friday's way to a shell on another
 * machine of yours (remoteTerminal.ts). The local edition has the desktop app's only.
 */
const shells: { api: () => NonNullable<Window["fridayDesktop"]>["terminal"] | undefined; onDrop: (fn: () => void) => () => void } = {
  api: () => (typeof window === "undefined" ? undefined : window.fridayDesktop?.terminal),
  onDrop: () => () => {},
};
import "@xterm/xterm/css/xterm.css";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ToolResult, ToolResultOutput } from "@/components/agents/tool-result";
import { engineName, MAIN_LANE, type EngineTool, type SessionEvent } from "../types.js";
import { EngineMark } from "./BrandMarks.js";
import type { Send } from "./useSession.js";
import { Icon } from "./icons.js";
import { joinPath, openIn, preferredEditor } from "./openIn.js";
import { problemsIn, scriptsIn, type Problem, type Script } from "./Problems.js";
import { relTime } from "./ui.js";
import { commandFailed } from "../receipt.js";
import { openSettings } from "./openSettings.js";
import { connectThisComputer } from "./local.js";
import { isLocal } from "./edition.js";

/**
 * Every command this session has run, in order.
 *
 * A coding session's real history is the terminal: what was run, what it
 * printed, what failed. The feed shows each command where it happened; this
 * panel is the same commands end to end, for the "what has this thing actually
 * done to my machine?" question.
 */

export interface CommandRow {
  id: string;
  command: string;
  by: string;
  lane: string;
  ts: number;
  /** When the result came back, so a finished command can say how long it took. */
  endTs?: number;
  output?: string;
  isError?: boolean;
  interrupted?: boolean;
}

/**
 * The two names the same act goes by.
 *
 * A CLI runs `shell`; Friday's own agent, working in a folder someone lent the
 * session, runs `run_command`. Both take a `command` and both land on the same
 * machine, so the terminal shows both — it is a record of what was run here,
 * not of which agent happened to run it.
 */
const SHELL_TOOLS = new Set(["shell", "run_command"]);

/** Shell calls paired with their results, oldest first. */
export function commandsIn(events: SessionEvent[]): CommandRow[] {
  const rows: CommandRow[] = [];
  const byId = new Map<string, CommandRow>();
  for (const e of events) {
    const b = e.body;
    if (b.type === "agent.message") {
      for (const c of b.toolCalls) {
        if (!SHELL_TOOLS.has(c.name)) continue;
        let command = "";
        try {
          command = String((JSON.parse(c.arguments || "{}") as { command?: unknown }).command ?? "");
        } catch {
          command = c.arguments;
        }
        const row: CommandRow = { id: c.id, command, by: e.actor.name, lane: e.lane ?? MAIN_LANE, ts: e.ts };
        byId.set(c.id, row);
        rows.push(row);
      }
    } else if (b.type === "folder.ran") {
      // A person at the keyboard: one event carries the command and its output.
      rows.push({ id: `ran-${e.seq}`, command: b.command, by: e.actor.name, lane: e.lane ?? MAIN_LANE, ts: e.ts, output: b.output, isError: b.isError });
    } else if (b.type === "tool.result") {
      const row = byId.get(b.callId);
      if (!row) continue;
      // A command that never ran (waiting on a person, told no) is not a row; the yes runs it again as a new call.
      if (commandFailed(b) === null) {
        rows.splice(rows.indexOf(row), 1);
        byId.delete(b.callId);
        continue;
      }
      row.output = b.output;
      row.endTs = e.ts;
      row.isError = b.isError;
      row.interrupted = b.interrupted;
    }
  }
  return rows;
}

/** "4s", "2m 14s": how long a command ran. */
const took = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`);

/**
 * Every command, newest first, with what it printed.
 *
 * Pointing at one from the Tasks list opens it here and scrolls to it. A
 * command still running says so: its output arrives when it ends, not line by
 * line, so the honest thing to show is that it is going.
 */
function CommandLog({ rows, focus }: { rows: CommandRow[]; focus?: { id: string; at: number } | null }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const refs = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    if (!focus) return;
    setOpen((o) => new Set([...o, focus.id]));
    const t = setTimeout(() => refs.current.get(focus.id)?.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
    return () => clearTimeout(t);
  }, [focus?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rows.length) {
    return (
      <div className="doc-scroll term-scroll">
        <p className="muted small">Nothing has been run in this session yet. Commands the agents run, and ones you run yourself, are listed here with what they printed.</p>
      </div>
    );
  }
  return (
    <div className="doc-scroll cmdlog">
      {rows.map((c) => {
        const running = c.output === undefined;
        const shown = running || open.has(c.id) || c.id === focus?.id;
        const state = running ? "running" : c.isError ? "error" : "done";
        return (
          <section
            key={c.id}
            ref={(el) => {
              if (el) refs.current.set(c.id, el);
            }}
            className={`cmd ${state} ${c.id === focus?.id ? "focus" : ""}`}
          >
            <button type="button" className="cmd-head" aria-expanded={shown} onClick={() => setOpen((o) => (o.has(c.id) ? new Set([...o].filter((x) => x !== c.id)) : new Set([...o, c.id])))}>
              <span className="cmd-mark">{running ? <span className="spinner tiny" /> : <Icon name={c.isError ? "x" : "check"} size={12} />}</span>
              <span className="cmd-line">{c.command}</span>
              <span className="cmd-meta">
                {c.by} · {relTime(c.ts)}
                {c.endTs ? ` · ${took(c.endTs - c.ts)}` : ""}
              </span>
            </button>
            {shown && (
              <pre className="cmd-out">
                {running ? "Running… what it prints shows here when it finishes." : (c.output ?? "").trim() ? (c.output ?? "").slice(-20_000) : "(no output)"}
              </pre>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function TerminalPanel({
  events,
  onClose,
  bare = false,
  send,
  canRun,
  cwd,
  sid,
  invite,
  onOpenFile,
  focus,
}: {
  events: SessionEvent[];
  /** A command to show, from somewhere that pointed at it (the Tasks list). `at` makes pointing twice at the same one count. */
  focus?: { id: string; at: number } | null;
  onClose: () => void;
  bare?: boolean;
  /** Present when the viewer may run something themselves. */
  send?: Send;
  canRun?: boolean;
  /** Where a shell should start: the folder this session is working in. */
  cwd?: string;
  /** Needed to read the project's own files, and to open what an error points at. */
  sid?: string;
  invite?: string;
  onOpenFile?: (path: string, line?: number) => void;
}) {
  const shell = !!shells.api();
  // Several shells, because one is never enough: a dev server holds one for as
  // long as it runs, and the next thing you want to type needs somewhere to go.
  // They are this session's, kept until closed: shutting the panel or going to another session and back used to give you
  // new, empty tabs while the old shells went on running where nobody could see them.
  const place = sid ?? cwd ?? "here";
  const [terms, setTerms] = useState<string[]>(() => savedTabs(place)?.ids ?? [newId()]);
  const [at, setAt] = useState(() => savedTabs(place)?.at ?? 0);
  // Another session in the same panel: its own tabs, read before anything is saved under its name.
  const [tabsOf, setTabsOf] = useState(place);
  if (tabsOf !== place) {
    const s = savedTabs(place);
    setTabsOf(place);
    setTerms(s?.ids ?? [newId()]);
    setAt(s?.at ?? 0);
  }
  useEffect(() => {
    if (tabsOf === place) saveTabs(place, terms, at);
  }, [place, tabsOf, terms, at]);
  const [out, setOut] = useState<Record<string, string>>({});
  const [copiedOut, setCopiedOut] = useState(false);
  const active = terms[Math.min(at, terms.length - 1)];


  // Two ways to look: a shell to type in, and what has been run, with what it
  // printed. Pointing at a command from the Tasks list lands on the second.
  const rows = useMemo(() => [...commandsIn(events)].reverse(), [events]);

  const add = () => {
    setTerms((t) => [...t, newId()]);
    setAt(terms.length);
  };

  const close = (id: string) => {
    shells.api()?.kill(id);
    forgetScreen(id);
    setOut(({ [id]: _gone, ...rest }) => rest);
    setTerms((t) => {
      const left = t.filter((x) => x !== id);
      // Closing the last one leaves a fresh shell rather than an empty panel.
      const next = left.length ? left : [newId()];
      setAt((i) => Math.min(i, next.length - 1));
      return next;
    });
  };

  const commands = <CommandLog rows={rows} focus={focus} />;

  const body = !shell ? (
    <>
      {/* The local edition in a browser has no way to a shell but the desktop app: "Connect this computer" answered nothing there,
          so it says where the terminal is instead (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"). */}
      {!window.fridayDesktop && isLocal() ? (
        <p className="muted small term-note">A live terminal opens here in Friday’s desktop app. What has been run here is below.</p>
      ) : (
        <p className="muted small term-note">
          {window.fridayDesktop
            ? "A live terminal opens here once this computer is connected in Settings › Computer & coding tools."
            : "A live terminal opens in the desktop app, or here through a computer you've connected in Settings › Computer & coding tools."}{" "}
          {/* The way to it, not only where it is (Arun, 2026-10-24: UX gaps). */}
          <button type="button" className="link-btn" onClick={() => (window.fridayDesktop ? openSettings("computer") : connectThisComputer())}>
            {window.fridayDesktop ? "Open it" : "Connect this computer"}
          </button>
          . What has been run here is below.
        </p>
      )}
      {commands}
    </>
  ) : (
    <>
      <div className="term-sides" role="tablist" aria-label="Terminal">
        {terms.map((id, i) => (
          <span key={id} className={`term-side ${i === at ? "on" : ""}`}>
            <button
              type="button"
              role="tab"
              aria-selected={i === at}
              className="term-side-name"
              onClick={() => {
                setAt(i);
              }}
            >
              <Icon name="terminalSquare" size={14} />
              Terminal <span className="term-side-n">{i + 1}</span>
            </button>
            {terms.length > 1 && (
              <button type="button" className="term-side-x" aria-label={`Close terminal ${i + 1}`} onClick={() => close(id)}>
                <Icon name="x" size={10} />
              </button>
            )}
          </span>
        ))}
        <button
          type="button"
          className="icon-btn tiny term-add"
          title="Another terminal"
          aria-label="Another terminal"
          onClick={add}
        >
          <Icon name="plus" size={13} />
        </button>
        {/* What the shell has printed lately, for pasting into a message or a bug report. */}
        <button
          type="button"
          className="icon-btn tiny term-copy"
          title={copiedOut ? "Copied" : "Copy recent output"}
          aria-label={copiedOut ? "Output copied" : "Copy recent output"}
          disabled={!active || !(out[active] ?? "").trim()}
          onClick={() => {
            void navigator.clipboard.writeText((active && out[active]) || "").then(
              () => {
                setCopiedOut(true);
                setTimeout(() => setCopiedOut(false), 1500);
              },
              () => {},
            );
          }}
        >
          <Icon name={copiedOut ? "check" : "copy"} size={13} />
        </button>
      </div>
      <div className="term-view">
      <Problems output={active ? (out[active] ?? "") : ""} cwd={cwd} onOpen={onOpenFile} />
      {/* Every shell stays mounted: unmounting one kills it, and a terminal
          that dies when you look at another is not a terminal. */}
      {terms.map((id, i) => (
        <div key={id} className={`term-side-pane ${i === at ? "" : "away"}`}>
          <LocalShell id={id} cwd={cwd} onOutput={(text) => setOut((all) => ({ ...all, [id]: text }))} {...(onOpenFile ? { onOpenFile } : {})} />
        </div>
      ))}
      </div>
    </>
  );

  if (bare) return body;
  return (
    <aside className="doc-panel" aria-label="Terminal">
      <div className="doc-head">
        <Icon name="box" size={15} />
        <span className="doc-title">Terminal</span>
        <span className="doc-actions">
          <button className="icon-btn tiny" title="Close" aria-label="Close the terminal" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </span>
      </div>
      {body}
    </aside>
  );
}

/** Distinct per panel and per session, since the main process keys shells by it. */
let seq = 0;
const newId = () => `t${Date.now().toString(36)}-${seq++}`;

/** A session's terminal tabs, and which one was showing. */
const TABS = (place: string) => `friday.terms.${place}`;
export function savedTabs(place: string): { ids: string[]; at: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(TABS(place)) ?? "null") as { ids?: unknown; at?: unknown } | null;
    const ids = Array.isArray(v?.ids) ? v.ids.filter((x): x is string => typeof x === "string" && /^[\w-]{1,40}$/.test(x)) : [];
    return ids.length ? { ids, at: Math.min(Math.max(0, Number(v?.at) || 0), ids.length - 1) } : null;
  } catch {
    return null;
  }
}
export function saveTabs(place: string, ids: string[], at: number): void {
  try {
    localStorage.setItem(TABS(place), JSON.stringify({ ids, at }));
  } catch {
    // Not kept: the tabs are still there until the window closes.
  }
}

/**
 * What each tab's screen showed, kept until the tab is closed: in memory for the panel opened again, and the tail of it on
 * disk for after a restart, when the shell itself is gone and a new one starts under it.
 */
const SCREEN = (id: string) => `friday.term.${id}`;
const KEEP_HERE = 256_000;
const KEEP_ON_DISK = 64_000;
const screens = new Map<string, string>();
function screenOf(id: string): string {
  const here = screens.get(id);
  if (here !== undefined) return here;
  try {
    return localStorage.getItem(SCREEN(id)) ?? "";
  } catch {
    return "";
  }
}
function keepScreen(id: string, text: string): void {
  screens.set(id, text.slice(-KEEP_HERE));
}
function storeScreen(id: string): void {
  // A tab closed a moment ago is forgotten for good: its shell's unmounting otherwise wrote an empty entry back.
  if (!screens.has(id)) return;
  try {
    localStorage.setItem(SCREEN(id), (screens.get(id) ?? "").slice(-KEEP_ON_DISK));
  } catch {
    // Full: what is in memory still covers the panel being opened again.
  }
}
function forgetScreen(id: string): void {
  screens.delete(id);
  try {
    localStorage.removeItem(SCREEN(id));
  } catch {
    // Nothing kept.
  }
}

/**
 * A shell on this computer, inside the panel.
 *
 * A pty in the desktop app, where the prompt redraws, colours work and
 * something interactive can hold the screen. It replaced a transcript of what
 * the agents had already run and a box that could ask for one command at a
 * time — neither of which is a terminal, and both of which were in the way of
 * the one thing people open this panel to do.
 *
 * xterm arrives on its own chunk, because the browser build has no shell to
 * draw and shouldn't carry the code for one.
 */
/** `run`: a line typed into a new shell once it starts (a coding tool on its conversation, laneTerminal); not into one it finds still running. */
function LocalShell({ id, cwd, run, onOutput, onOpenFile }: { id: string; cwd?: string; run?: string; onOutput: (text: string) => void; onOpenFile?: (path: string, line?: number) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState("");
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const opener = useRef(onOpenFile);
  opener.current = onOpenFile;
  // ⌘F: find in what the shell printed, its scrollback included (Emdash, Superset and cmux all have it).
  const [finding, setFinding] = useState(false);
  // What this shell has printed, for the problems list to read. Kept in a ref
  // and reported on a timer: a state update per chunk would re-render the
  // panel on every character a build prints.
  const printed = useRef("");
  const told = useRef(onOutput);
  told.current = onOutput;

  useEffect(() => {
    const api = shells.api();
    const el = host.current;
    if (!api || !el) return;
    let dead = false;
    const stop: (() => void)[] = [];

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (dead) return;
      const term = new Terminal({
        fontFamily: '"Geist Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        fontSize: 13,
        cursorBlink: true,
        scrollback: 10_000,
        // A wheel step moves three lines, and ⌥ with it a page's worth: one line a step felt stuck in a long output and in a tool
        // that draws its own screen (Arun, 2026-10-30: "scrolling in native terminal feels slow").
        scrollSensitivity: 3,
        fastScrollSensitivity: 12,
        theme: themeFrom(el),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      fit.fit();
      termRef.current = term;
      stop.push(() => ((termRef.current = null), term.dispose()));
      // Whether there is anything to scroll back to: a tool drawing its whole screen in place (Claude Code's own, the alternate
      // screen) has none, and a scrollbar there was a thumb the screen's height, read as a stray line (Arun's screenshot).
      const scrollable = () => (el.dataset.scrollable = term.buffer?.active?.type === "normal" && term.buffer.active.length > term.rows ? "1" : "0");
      scrollable();
      for (const d of [term.buffer?.onBufferChange?.(scrollable), term.onWriteParsed?.(scrollable), term.onResize?.(scrollable)]) if (d) stop.push(() => d.dispose());
      // ⌘F (Ctrl+Shift+F off a Mac, where Ctrl+F is the shell's own) finds in the output rather than going to the shell.
      term.attachCustomKeyEventHandler((e) => {
        const mac = /Mac/.test(navigator.platform);
        if (e.type === "keydown" && e.key.toLowerCase() === "f" && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey)) {
          e.preventDefault();
          setFinding(true);
          return false;
        }
        return true;
      });
      // A file the output names (a stack trace, a compiler's error, ls) is a link: pressed, it opens in the session's files at
      // its line; ⌘-pressed, in your own editor (openIn.ts), as in an answer.
      const links = term.registerLinkProvider({
          provideLinks(y, done) {
            const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
            const found: import("@xterm/xterm").ILink[] = [];
            for (const m of line.matchAll(FILE_IN_OUTPUT)) {
              const file = m[1]!;
              const at = Number(m[2] ?? m[4] ?? 0) || undefined;
              const shown = m[0].slice(m[0].indexOf(file));
              const start = (m.index ?? 0) + m[0].indexOf(file);
              found.push({
                // Columns count from 1, and the end is the link's last column.
                range: { start: { x: start + 1, y }, end: { x: start + shown.length, y } },
                text: shown,
                decorations: { underline: true, pointerCursor: true },
                activate: (ev) => {
                  if ((ev.metaKey || ev.ctrlKey) && cwd && window.fridayDesktop?.openIn)
                    return void preferredEditor().then((ed) => ed && openIn(ed, joinPath(cwd, file), at));
                  // The session's files are named from its folder: an absolute path inside it is opened by its part in there.
                  const base = cwd?.replace(/[\\/]+$/, "");
                  opener.current?.(base && file.startsWith(`${base}/`) ? file.slice(base.length + 1) : file.replace(/^\.\//, ""), at);
                },
              });
            }
            done(found.length ? found : undefined);
          },
        });
      stop.push(() => links.dispose());
      // Held until what the screen showed before is drawn, so the old screen comes first and the new output after it.
      let drawn = false;
      const early: string[] = [];
      let screen = screenOf(id);
      // Something printed since the last beat: a shell sitting quiet (or put away with nothing running) costs nothing.
      let dirty = false;
      stop.push(
        api.onData((which, d) => {
          if (which !== id) return;
          screen = (screen + d).slice(-KEEP_HERE);
          keepScreen(id, screen);
          if (drawn) term.write(d);
          else early.push(d);
          // Only the tail matters: an error worth opening was printed by the
          // thing that just ran, and a whole build log is megabytes.
          printed.current = (printed.current + d).slice(-60_000);
          dirty = true;
        }),
      );
      stop.push(
        api.onExit((which, code) => {
          if (which === id) term.write(`\r\n\x1b[2m[the shell exited (${code})]\x1b[0m\r\n`);
        }),
      );
      const beat = setInterval(() => {
        if (!dirty) return;
        dirty = false;
        told.current(printed.current);
        storeScreen(id);
      }, 1200);
      stop.push(() => (clearInterval(beat), storeScreen(id)));
      term.onData((d) => api.write(id, d));

      // The shell's idea of the window has to follow the panel's, which moves
      // whenever the workbench is resized or a tab changes what is beside it.
      const ro = new ResizeObserver(() => {
        // Put away (display: none) it has no size, and fitting to that would tell the shell it is a column wide.
        if (!el.clientWidth) return;
        fit.fit();
        api.resize(id, term.cols, term.rows);
      });
      ro.observe(el);
      stop.push(() => ro.disconnect());

      // xterm paints its own canvas, so it does not inherit anything: when the
      // app changes theme the grid keeps the colours it was built with, and
      // the shell ends up light on a dark panel or the other way round.
      const watch = new MutationObserver(() => (term.options.theme = themeFrom(el)));
      watch.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
      stop.push(() => watch.disconnect());

      // The connection to the computer dropped, and this tab's shell with it: a new one, tried again until the computer answers.
      let retry: ReturnType<typeof setTimeout> | undefined;
      const again = async () => {
        if (dead) return;
        const r = await api.start({ id, cols: term.cols, rows: term.rows, ...(cwd ? { cwd } : {}) });
        if (dead) return;
        if (!r.ok) return void (retry = setTimeout(() => void again(), 3000));
        setErr("");
        term.write(`\r\n\x1b[2m[the connection to the computer dropped: a new shell]\x1b[0m\r\n`);
      };
      stop.push(shells.onDrop(() => (clearTimeout(retry), (retry = setTimeout(() => void again(), 1000)))));
      stop.push(() => clearTimeout(retry));

      const before = screen;
      const r = await api.start({ id, cols: term.cols, rows: term.rows, ...(cwd ? { cwd } : {}) });
      if (dead) return;
      if (!r.ok) return setErr(r.error ?? "Couldn't start a shell. Check the computer is connected and set to Auto.");
      // The screen as it was: the running shell's own record when it is still there (it has everything, a reload included),
      // else what this tab kept, under a new shell after a restart. Then whatever arrived meanwhile.
      const old = r.resumed && typeof r.replay === "string" ? r.replay : before;
      if (old) term.write(old);
      if (r.resumed) {
        screen = (old + early.join("")).slice(-KEEP_HERE);
        keepScreen(id, screen);
        dirty = true;
        term.write(`\r\n\x1b[2m[back in ${r.cwd ?? "this shell"}]\x1b[0m\r\n`);
      } else if (old) {
        // Then a screenful of blank lines, so the old screen and the note are in the scrollback before the new shell starts:
        // Windows' console clears the visible screen as it starts, and xterm drops what that clears.
        term.write(`\r\n\x1b[2m[a new shell: the one above ended when Friday closed]\x1b[0m\r\n${"\r\n".repeat(term.rows)}`);
      }
      for (const d of early) term.write(d);
      drawn = true;
      if (run && !r.resumed) api.write(id, `${run}\r`);
      term.focus();
    })();

    return () => {
      dead = true;
      for (const f of stop) f();
    };
  }, [id, cwd, run]);

  return (
    <div className="term-shell">
      {err && <p className="error small term-shell-err">{err}</p>}
      {finding && <FindBar term={termRef} onClose={() => (setFinding(false), termRef.current?.focus())} />}
      <div ref={host} className="term-shell-host" />
    </div>
  );
}

/** A file named in a shell's output, with its line: `src/a.ts:12:3`, `./b.py:4`, `C:\x\y.cs(12,3)`, or a bare `name.ext`. */
const FILE_IN_OUTPUT = /(?:^|[\s'"(\[=])((?:[A-Za-z]:[\\/]|\.{1,2}\/|\/|~\/)?(?:[\w@.+-]+[\\/])*[\w@+-][\w@.+-]*\.[A-Za-z][\w]{0,7})(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))?(?=$|[\s'"),:\]])/g;

/** Every place the text is in the shell's buffer, scrollback included, top to bottom. */
function matchesIn(term: import("@xterm/xterm").Terminal, query: string): { row: number; col: number }[] {
  const q = query.toLowerCase();
  const out: { row: number; col: number }[] = [];
  if (!q) return out;
  const buf = term.buffer.active;
  for (let row = 0; row < buf.length && out.length < 1000; row++) {
    const text = buf.getLine(row)?.translateToString(true).toLowerCase() ?? "";
    for (let col = text.indexOf(q); col !== -1; col = text.indexOf(q, col + q.length)) out.push({ row, col });
  }
  return out;
}

function FindBar({ term, onClose }: { term: { current: import("@xterm/xterm").Terminal | null }; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ row: number; col: number }[]>([]);
  const [at, setAt] = useState(-1);
  const show = (list: { row: number; col: number }[], i: number) => {
    const t = term.current;
    const h = list[i];
    if (!t || !h) return;
    t.select(h.col, h.row, q.length);
    t.scrollToLine(Math.max(0, h.row - Math.floor(t.rows / 2)));
  };
  const search = (query: string) => {
    setQ(query);
    const t = term.current;
    const list = t ? matchesIn(t, query) : [];
    setHits(list);
    // The newest first: what you look for is usually what was just printed.
    const i = list.length - 1;
    setAt(i);
    if (i >= 0) show(list, i);
    else t?.clearSelection();
  };
  const step = (by: number) => {
    if (!hits.length) return;
    const i = (at + by + hits.length) % hits.length;
    setAt(i);
    show(hits, i);
  };
  return (
    <div className="term-find" role="search">
      <Icon name="search" size={13} />
      <input
        autoFocus
        value={q}
        placeholder="Find in the output"
        aria-label="Find in the terminal's output"
        onChange={(e) => search(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") (e.preventDefault(), onClose());
          else if (e.key === "Enter") (e.preventDefault(), step(e.shiftKey ? 1 : -1));
        }}
      />
      <span className="term-find-count">{q ? (hits.length ? `${at + 1} of ${hits.length}` : "None") : ""}</span>
      <button type="button" className="icon-btn tiny" aria-label="Earlier match" title="Earlier (Enter)" disabled={!hits.length} onClick={() => step(-1)}>
        <Icon name="chevronUp" size={13} />
      </button>
      <button type="button" className="icon-btn tiny" aria-label="Later match" title="Later (⇧Enter)" disabled={!hits.length} onClick={() => step(1)}>
        <Icon name="chevronDown" size={13} />
      </button>
      <button type="button" className="icon-btn tiny" aria-label="Close find" onClick={onClose}>
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}

/**
 * The project's own commands, as buttons.
 *
 * Every repository already says what it can be asked to do — in its
 * package.json, its Makefile, its Cargo.toml — and typing `npm run test` for
 * the hundredth time is the app declining to read it. Only the handful anyone
 * actually runs: a package with forty scripts is a list nobody scans.
 */
function RunBar({ sid, invite, onRun, disabled }: { sid: string; invite: string; onRun: (command: string) => void; disabled: boolean }) {
  const [scripts, setScripts] = useState<Script[] | null>(null);

  useEffect(() => {
    let live = true;
    const read = (path: string) =>
      fetch(`/api/sessions/${encodeURIComponent(sid)}/repo?op=read&raw=1&path=${encodeURIComponent(path)}&invite=${encodeURIComponent(invite)}`)
        .then((r) => r.json() as Promise<{ output?: string; error?: string }>)
        .then((r) => (r.error ? null : { path, text: r.output ?? "" }))
        .catch(() => null);
    void Promise.all(["package.json", "Makefile", "Cargo.toml", "pyproject.toml"].map(read)).then((found) => {
      if (live) setScripts(scriptsIn(found.filter((f): f is { path: string; text: string } => !!f)));
    });
    return () => {
      live = false;
    };
  }, [sid, invite]);

  if (!scripts?.length) return null;
  return (
    <div className="run-bar">
      <span className="run-bar-label">Run</span>
      {scripts.map((s) => (
        <button
          key={s.run}
          type="button"
          className="run-chip"
          disabled={disabled}
          // Typed into the shell rather than run behind it, so what happens is
          // where you would have typed it yourself — including the output.
          title={disabled ? "No shell to run it in" : s.command}
          onClick={() => onRun(s.run)}
        >
          <Icon name="play" size={11} />
          {s.name}
        </button>
      ))}
    </div>
  );
}

/**
 * What the shell said was wrong, as places rather than sentences.
 *
 * Read from the tail of this terminal's own output, so it follows whatever you
 * last ran in it — a list that accumulated everything ever run would be a list
 * of things already fixed, and the question is always what is broken now.
 */
function Problems({ output, cwd, onOpen }: { output: string; cwd?: string; onOpen?: (path: string, line?: number) => void }) {
  const [shut, setShut] = useState(false);
  const found = useMemo(() => (output ? problemsIn(output, cwd ?? "") : []), [output, cwd]);
  useEffect(() => setShut(false), [found.length]);
  if (!found.length || shut) return null;

  const errors = found.filter((p) => p.severity === "error").length;
  return (
    <div className="problems">
      <div className="problems-head">
        <Icon name="shield" size={12} />
        {errors ? `${errors} error${errors === 1 ? "" : "s"}` : `${found.length} warning${found.length === 1 ? "" : "s"}`} in this terminal
        <button type="button" className="icon-btn tiny problems-x" aria-label="Hide" onClick={() => setShut(true)}>
          <Icon name="x" size={11} />
        </button>
      </div>
      <div className="problems-list">
        {found.slice(0, 40).map((p: Problem, i) => (
          <button key={`${p.path}-${p.line}-${i}`} type="button" className={`problem ${p.severity}`} disabled={!onOpen} onClick={() => onOpen?.(p.path, p.line)}>
            <span className="problem-where">
              {p.path}:{p.line}
            </span>
            <span className="problem-what">{p.message}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The sixteen terminal colours, deep enough to read on white (each still the hue a program asked for). */
const LIGHT_ANSI = {
  black: "#1f1f24",
  red: "#b42318",
  green: "#1d7a3a",
  yellow: "#8a5a00",
  blue: "#1d5fbf",
  magenta: "#8b3fa8",
  cyan: "#0b6e82",
  white: "#55555e",
  brightBlack: "#5f5f68",
  brightRed: "#c4321f",
  brightGreen: "#237f42",
  brightYellow: "#7a5000",
  brightBlue: "#2563c9",
  brightMagenta: "#9a3fb5",
  brightCyan: "#0a7389",
  brightWhite: "#3a3a41",
};

/**
 * The panel's colours, as xterm can use them.
 *
 * Resolved off a real element rather than read from the custom properties:
 * a variable can hold anything CSS understands and xterm only parses a few
 * forms, so the browser is asked to compute it first. Getting this wrong is
 * silent — xterm keeps its own default and the grid sits in a black rectangle
 * inside a white panel.
 */
/** Any colour the browser can paint, as rgba(): drawn on one pixel and read back. */
function asRgba(colour: string): string | null {
  try {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.canvas.width = ctx.canvas.height = 1;
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${Math.round((a! / 255) * 100) / 100})`;
  } catch {
    return null;
  }
}

function themeFrom(el: HTMLElement): { background: string; foreground: string; cursor: string; selectionBackground: string; [colour: string]: string } {
  const probe = document.createElement("span");
  probe.style.display = "none";
  el.appendChild(probe);
  const read = (value: string, fallback: string) => {
    probe.style.color = "";
    probe.style.color = value;
    const out = getComputedStyle(probe).color;
    if (!probe.style.color) return fallback;
    // A mix (a theme's derived colours, color-mix) computes as color(srgb …), which xterm doesn't read: as rgba, through a pixel.
    return /^rgba?\(/.test(out) ? out : (asRgba(out) ?? fallback);
  };
  const theme = {
    background: read("var(--code-bg)", "#181818"),
    foreground: read("var(--ink)", "#ededed"),
    cursor: read("var(--violet)", "#ededed"),
    selectionBackground: read("var(--hover-strong)", "#3a3a5c"),
    // What Find selected shows while its box has the keys, rather than vanishing with the focus.
    selectionInactiveBackground: read("color-mix(in srgb, var(--amber) 38%, transparent)", "#7a5a1a"),
  };
  probe.remove();
  // On a light terminal the shells' own colours were made for a dark one: PowerShell's yellow command and grey arguments
  // were close to unreadable on white. Deeper versions of the same hues there; a dark terminal keeps xterm's.
  const [r = 0, g = 0, b = 0] = (theme.background.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  if ((r * 299 + g * 587 + b * 114) / 1000 > 160) return { ...theme, ...LIGHT_ANSI };
  return theme;
}

// ── The lane's own coding tool in a terminal (runner/terminal-line.ts) ──────────

/** The tools whose own screen can carry on a lane's conversation (terminal-line.ts TERMINAL_TOOLS). */
export const TERMINAL_TOOLS = new Set<string>(["claude", "codex"]);

/** One screen per lane, the same across reloads, so the desktop app's shell is found again rather than started twice. */
export const toolShellId = (sid: string, lane: string) => `tool-${sid}-${lane}`;

/** Whether this window can draw a real shell: the desktop app's own, or (in the hosted Friday) one on a connected computer. */
export const hasShells = () => !!shells.api();

/** The line each lane's screen was opened with, kept for the screen to start with, however it comes to be drawn. */
const opened = new Map<string, { line: string; cwd: string }>();

/** Takes the lane to a terminal: its turns held, and the line that carries its conversation on (POST /api/sessions/:sid/terminal). */
export async function openLaneTerminal(sid: string, invite: string, lane: string): Promise<{ line: string; cwd: string } | { error: string }> {
  try {
    // Given up on after half a minute: a view waiting on an answer that never comes said "Opening…" for ever.
    const r = await fetch(`/api/sessions/${sid}/terminal?invite=${encodeURIComponent(invite)}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lane, open: true }), signal: AbortSignal.timeout(30_000) });
    const b = (await r.json().catch(() => ({}))) as { line?: string; cwd?: string; error?: string };
    if (!r.ok || !b.line) return { error: b.error ?? "That agent's computer didn't answer. Try again." };
    const got = { line: b.line, cwd: b.cwd ?? "" };
    opened.set(`${sid}|${lane}`, got);
    return got;
  } catch {
    return { error: "Couldn't reach Friday. Try again." };
  }
}

/**
 * A lane's own screen started ahead, before anyone looks at it (Arun, 2026-10-30: "fast loading of the native terminal… should
 * be already auto loaded for instant feedback"): taken to the terminal, its shell started and its tool typed into it, so that
 * by the time its tab is opened the tool is up and the view only draws what it already said. Nothing twice: a lane on its
 * way, or with its screen running already, is left as it is.
 */
/** Screens on their way, by `sid|lane`: a second ask for one waits on the first and hears how it went, rather than nothing. */
const warming = new Map<string, Promise<{ error: string } | null>>();
export function warmLaneTerminal(sid: string, invite: string, lane: string): Promise<{ error: string } | null> {
  const key = `${sid}|${lane}`;
  const api = shells.api();
  if (!api) return Promise.resolve({ error: "This window has no terminal: open Friday's desktop app." });
  const going = warming.get(key);
  if (going) return going;
  const run = (async () => {
    try {
      // Always asked, never taken from what an earlier open left: handed back since, the lane would run its screen without its
      // turns held, and the view would wait for an open the server never heard of (Arun's screenshot: "Opening Claude Code…").
      const r = await openLaneTerminal(sid, invite, lane);
      if ("error" in r) return r;
      const id = toolShellId(sid, lane);
      const s = await api.start({ id, cols: 120, rows: 36, ...(r.cwd ? { cwd: r.cwd } : {}) });
      if (s.ok && !s.resumed) api.write(id, `${r.line}\r`);
      return s.ok ? null : { error: s.error ?? "Couldn't start a shell." };
    } catch (e) {
      return { error: (e as Error).message || "Couldn't open it." };
    } finally {
      warming.delete(key);
    }
  })();
  warming.set(key, run);
  return run;
}

/** Back to Friday: the tool's screen closed, and the lane takes its turns again, from where the terminal left its conversation. */
export async function handBack(sid: string, invite: string, lane: string): Promise<void> {
  opened.delete(`${sid}|${lane}`);
  shells.api()?.kill(toolShellId(sid, lane));
  forgetScreen(toolShellId(sid, lane));
  await fetch(`/api/sessions/${sid}/terminal?invite=${encodeURIComponent(invite)}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lane, open: false }) }).catch(() => {});
}

/** Over the chat's box while the lane is out in a terminal: why nothing it is sent runs yet, and the one press that gives it back. */
export function InTerminalNote({ sid, invite, lane, tool, mine }: { sid: string; invite: string; lane: string; tool: EngineTool | undefined; mine: boolean }) {
  const [busy, setBusy] = useState(false);
  const name = engineName(tool);
  return (
    <div className="in-terminal-note" role="status">
      <Icon name="terminalSquare" size={14} />
      <span className="small">{mine ? `${name} is open in your terminal. What you send here waits until you hand it back.` : `${name} is open in its host's terminal. What's sent here waits until they hand it back.`}</span>
      {mine && (
        <button type="button" className="link-btn small" disabled={busy} onClick={() => (setBusy(true), void handBack(sid, invite, lane).finally(() => setBusy(false)))}>
          Hand back to Friday
        </button>
      )}
    </div>
  );
}

/**
 * Chat or terminal: one switch for every agent, in every session, until it is switched back (Arun, 2026-10-30: "make sure the
 * terminal view toggle works as a on off switch for all of the coding tabs"). Shared by every chat on screen (split columns
 * included) and kept in this browser.
 */
const TUI_KEY = "friday.tui";
let tuiOn = (() => {
  try {
    return localStorage.getItem(TUI_KEY) === "1";
  } catch {
    return false;
  }
})();
const tuiWatchers = new Set<() => void>();
export const tuiIsOn = () => tuiOn;
/**
 * Agents shown in Friday's own TUI rather than their tool's, by `sid|lane`: sent back to it by their person (for good), or their
 * tool's screen couldn't open just now (its computer reconnecting), for half a minute before it is tried again.
 */
const fridayView = new Map<string, number>();
export const friday = (sid: string, lane: string) => {
  const until = fridayView.get(`${sid}|${lane}`);
  return until !== undefined && until > Date.now();
};
/** The view switched on: every agent goes to its tool's own screen again, whatever was chosen before (Arun, 2026-10-30: "switching
 * between GUI coding tool lane to terminal it should always load on native"). */
export const nativeAgain = () => fridayView.clear();
export const preferFriday = (sid: string, lane: string, on: boolean | "briefly") =>
  void (on ? fridayView.set(`${sid}|${lane}`, on === "briefly" ? Date.now() + 30_000 : Infinity) : fridayView.delete(`${sid}|${lane}`));
export function setTuiOn(on: boolean): void {
  if (on) nativeAgain();
  tuiOn = on;
  try {
    on ? localStorage.setItem(TUI_KEY, "1") : localStorage.removeItem(TUI_KEY);
  } catch {
    // Private browsing: kept for as long as the page is open.
  }
  tuiWatchers.forEach((f) => f());
}
export function useTuiView(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (f) => (tuiWatchers.add(f), () => void tuiWatchers.delete(f)),
    () => tuiOn,
  );
  return [on, setTuiOn];
}

/**
 * Chat or terminal for every agent: one small mark beside the agent tabs, lit while the terminal view is on (Arun, 2026-10-30:
 * "DESIGN THIS VERY SUBTLE AND SHOULDNT TAKE UP SO MUCH SPACE").
 */
export function ViewToggle({ on, name, onToggle, size = 14, className = "" }: { on: boolean; name: string; onToggle: () => void; size?: number; className?: string }) {
  return (
    <button type="button" className={`view-toggle${on ? " on" : ""}${className ? ` ${className}` : ""}`} aria-pressed={on} aria-label={on ? "Terminal view on: back to chat" : `Terminal view, for ${name} and every agent`} data-tip={on ? "Terminal view on · back to chat" : "Terminal view"} onClick={onToggle}>
      <Icon name="terminalSquare" size={size} />
    </button>
  );
}

/** The agent's coding tool in its own screen, in place of the chat: a real shell in the agent's folder, its tool on the conversation. */
export function LaneTui({ sid, invite, lane, tool, title, onBack }: { sid: string; invite: string; lane: string; tool: EngineTool; /** The agent's own name, when it isn't its tool's ("Reviewer"). */ title?: string; /** Back to Friday's own view of it, handed back. */ onBack: () => void }) {
  const key = `${sid}|${lane}`;
  // Its own agent's line only: kept from another agent, it started that agent's tool in this one's screen.
  const [had, setRun] = useState(() => ({ key, run: opened.get(key) ?? null }));
  const run = had.key === key ? had.run : (opened.get(key) ?? null);
  const [err, setErr] = useState("");
  // Drawn without having been opened here (a reload, another window): asked again, which holds nothing twice and starts no
  // second tool, since a screen still running is found again by its id.
  useEffect(() => {
    if (run) return;
    let gone = false;
    void openLaneTerminal(sid, invite, lane).then((r) => !gone && ("error" in r ? setErr(r.error) : setRun({ key, run: r })));
    return () => void (gone = true);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = engineName(tool);
  const where = run?.cwd.replace(/^\/(Users|home)\/[^/]+/, "~") ?? "";
  return (
    <div className="lane-tui">
      <div className="lane-tui-head">
        <EngineMark tool={tool} size={14} />
        <span className="lane-tui-name">{title && title !== name ? `${title} · ${name}` : name}</span>
        {where && <span className="lane-tui-where" title={run!.cwd}>{where}</span>}
        <span className="lane-tui-note">Friday holds its turns while you're here</span>
        <button type="button" className="ftui-link" onClick={onBack} title="Hand it back to Friday, in Friday's terminal view">
          ← friday
        </button>
      </div>
      {err ? <p className="error small lane-tui-err">{err}</p> : run ? <LocalShell id={toolShellId(sid, lane)} cwd={run.cwd} run={run.line} onOutput={() => {}} /> : <p className="muted small lane-tui-err">Opening {name}…</p>}
    </div>
  );
}
