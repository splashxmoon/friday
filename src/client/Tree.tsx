import { FileIcon } from "./fileIcons.js";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyEvent } from "react";
import { FileDiff } from "@/components/agents/file-diff";
import { driverOf, type SessionState } from "../session/projection.js";
import type { DiffFile, Member, SessionEvent } from "../types.js";
import { MAIN_LANE } from "../types.js";
import { agentNameFor, patchLines } from "./Activity.js";
import { argsOf } from "./args.js";
import { CodeEditor, CodeReader, QuickOpen } from "./Editor.js";
import type { Send } from "./useSession.js";
import { Icon } from "./icons.js";
import { ContextMenu, relTime } from "./ui.js";
import { useFocus } from "./focusStore.js";
import { unnumbered } from "../project-rules.js";

/**
 * The folder, as everyone in the room sees it.
 *
 * A coding session has one thing everybody wants to look at and nobody can:
 * the code. The diff says what changed but not where it sits; the terminal
 * says what ran but not what it touched. This is the tree itself, read live
 * from the machine through the same bridge the agents read it through — with
 * the session's own knowledge drawn on top of it: what changed, by how much,
 * who changed it, and what somebody is in the middle of right now.
 *
 * The point is that it stays a file tree. Everything extra is a mark on a row
 * you would have been looking at anyway, and one click opens the diff in
 * place. Nobody has to learn a second thing.
 */

/** How recent a touch has to be to read as "right now" rather than history. */
const LIVE_MS = 3 * 60_000;
/** Tool names that mean somebody is working in a file, across every agent. */
const WRITES = new Set(["write", "edit", "write_file", "edit_file"]);
const READS = new Set(["read", "read_file"]);

interface Touch {
  by: string;
  ts: number;
  writing: boolean;
}

export interface TreeFacts {
  /** Every path the machine reported, in the order it reported them. */
  paths: string[];
  changed: Map<string, { file: DiffFile; lane: string }>;
  touched: Map<string, Touch>;
  where: { host: string; cwd: string; branch?: string } | null;
}

/** One row of the rendered tree: a folder or a file, already flattened. */
interface Row {
  path: string;
  name: string;
  depth: number;
  dir: boolean;
  /** Folders: what is inside, so a collapsed folder can still say "3 changed". */
  changed: number;
}

/**
 * Where you left the tree: which folders were open, which files were open, and
 * which one you were looking at. Per session and in this browser only — it is
 * how you like to read the folder, not a fact the room shares.
 */
const treeKey = (sid: string) => `mpa.tree.${sid}`;
function readLayout(sid: string): { open: string[]; tabs: string[]; pick: string | null } {
  try {
    const v = JSON.parse(localStorage.getItem(treeKey(sid)) || "null");
    const list = (x: unknown) => (Array.isArray(x) ? x.filter((p): p is string => typeof p === "string").slice(0, 200) : []);
    return { open: list(v?.open), tabs: list(v?.tabs).slice(0, 12), pick: typeof v?.pick === "string" ? v.pick : null };
  } catch {
    return { open: [], tabs: [], pick: null };
  }
}

export function TreePanel({
  state,
  events,
  sid,
  invite,
  bare = false,
  onClose,
  send,
  me,
  jump,
  lane,
}: {
  state: SessionState;
  events: SessionEvent[];
  sid: string;
  invite: string;
  /** The agent whose folder this shows, when the session has several (the active column of a split chat). */
  lane?: string;
  bare?: boolean;
  onClose: () => void;
  /** Present when the viewer may edit: saving is a command like any other. */
  send?: Send;
  me?: Member;
  /** A file somebody asked for from elsewhere — an error row, usually. */
  jump?: { path: string; line?: number; at: number } | null;
}) {
  const [paths, setPaths] = useState<string[] | null>(() => treeCache.get(sid) ?? null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const saved = useMemo(() => readLayout(sid), [sid]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(saved.open));
  const [tabs, setTabs] = useState<string[]>(saved.tabs);
  const [pick, setPick] = useState<string | null>(saved.pick && saved.tabs.includes(saved.pick) ? saved.pick : null);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; dir: boolean } | null>(null);
  const rowsEl = useRef<HTMLDivElement>(null);
  // Which file this person has in front of them, for the teammates who might be following. Nothing while the panel is closed.
  const focus = useFocus();
  useEffect(() => {
    focus.here(pick ? { path: pick } : {}, "tree");
    return () => focus.here({}, "tree");
  }, [pick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    try {
      localStorage.setItem(treeKey(sid), JSON.stringify({ open: [...open].slice(0, 200), tabs, pick }));
    } catch {
      // Private mode: the tree just opens the way it did the first time.
    }
  }, [sid, open, tabs, pick]);
  // Unsaved work, kept here rather than in the editor: switching tabs unmounts
  // the editor, and a draft that dies with it is a draft nobody trusts.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [quick, setQuick] = useState(false);
  // Asked from the palette ("Open a file…"): the same opener ⌘P brings up.
  useEffect(() => {
    const on = () => setQuick(true);
    addEventListener("friday:quick-open", on);
    return () => removeEventListener("friday:quick-open", on);
  }, []);

  const openFile = useCallback((path: string) => {
    setTabs((t) => (t.includes(path) ? t : [...t, path]));
    setPick(path);
  }, []);

  const closeFile = (path: string) => {
    const left = tabs.filter((x) => x !== path);
    setTabs(left);
    setDrafts((all) => {
      const rest = { ...all };
      delete rest[path];
      return rest;
    });
    setPick((cur) => (cur !== path ? cur : (left.at(-1) ?? null)));
  };

  // Opened as the folder has it: an answer often names a file by itself ("train.py") when it lives a folder or two down.
  // Each ask once: the effect runs again whenever a tree kept in the workbench is shown, and must not take you back to it.
  const jumpTo = jump && paths ? resolvePath(paths, jump.path) : null;
  const jumped = useRef(0);
  useEffect(() => {
    if (!jump || !paths || jumped.current === jump.at) return;
    jumped.current = jump.at;
    openFile(resolvePath(paths, jump.path));
  }, [jump, !!paths, openFile]); // eslint-disable-line react-hooks/exhaustive-deps

  // A tree of a few hundred files is a slow way to reach the one whose name
  // you already know.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setQuick((v) => !v);
      }
      if (e.key === "Escape") setQuick(false);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  // A viewer reads secret-hidden text, which must never be saved back over the file.
  const canEdit = !!send && !!me && me.role !== "viewer" && (me.role === "owner" || driverOf(state, MAIN_LANE)?.id === me.id || !driverOf(state, MAIN_LANE));
  // A machine, or a folder somebody uploaded — either is a folder to show.
  const engine = state.engines[lane ?? MAIN_LANE] ?? state.engines[MAIN_LANE] ?? Object.values(state.engines)[0] ?? null;
  const where = engine ? { cwd: engine.cwd, branch: engine.branch } : state.upload ? { cwd: state.upload.name } : null;

  const load = () => {
    setLoading(true);
    setErr("");
    fetch(`/api/sessions/${encodeURIComponent(sid)}/repo?op=tree&invite=${encodeURIComponent(invite)}${lane ? `&lane=${encodeURIComponent(lane)}` : ""}`)
      .then((r) => r.json() as Promise<{ output?: string; error?: string; stale?: { at: number; reason: string } }>)
      .then((r) => {
        if (r.error) throw new Error(r.error);
        // A sentence ("the machine isn't connected") is not a listing: keep
        // what is already on screen instead of replacing it with nothing.
        if (!/^\d+ files under /.test(r.output ?? "")) {
          if (!treeCache.has(sid)) setErr(r.output ?? "Couldn't read the folder. Check the machine is still connected.");
          return;
        }
        const next = parseTree(r.output ?? "");
        treeCache.set(sid, next);
        setPaths(next);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  // Once per session view, and again when a machine arrives: before that there
  // is nothing on the other end of the read.
  useEffect(() => {
    if (where) load();
  }, [sid, lane, !!engine, state.upload?.files]); // eslint-disable-line react-hooks/exhaustive-deps

  const facts = useFacts(state, events, paths ?? []);
  // Opened where the work is. A tree that starts fully collapsed makes you
  // hunt for the change you came to look at; one that starts fully expanded is
  // a thousand rows. The folders holding changes, and nothing else.
  // Once for each listing and each count of changes: shown again from the workbench, the folders somebody closed stay closed.
  const expanded = useRef<{ paths: string[] | null; n: number }>({ paths: null, n: 0 });
  useEffect(() => {
    if (!paths || !facts.changed.size) return;
    if (expanded.current.paths === paths && expanded.current.n === facts.changed.size) return;
    expanded.current = { paths, n: facts.changed.size };
    setOpen((s) => {
      const next = new Set(s);
      for (const p of facts.changed.keys()) {
        const parts = p.split("/");
        for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      }
      return next;
    });
  }, [paths, facts.changed.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => flatten(paths ?? [], facts, { q: q.trim().toLowerCase(), onlyChanged, open }), [paths, facts, q, onlyChanged, open]);
  const changedCount = facts.changed.size;

  /** Arrow keys walk the rows the way they do in every file tree. */
  const onRowKey = (e: ReactKeyEvent) => {
    const rowsNow = [...(rowsEl.current?.querySelectorAll<HTMLElement>(".tree-row") ?? [])];
    const i = rowsNow.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const cur = rowsNow[i]!;
    const path = cur.dataset.path ?? "";
    const isDir = cur.classList.contains("dir");
    const go = (n: number) => {
      e.preventDefault();
      rowsNow[Math.max(0, Math.min(rowsNow.length - 1, n))]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(rowsNow.length - 1);
    else if (e.key === "ArrowRight" && isDir) {
      e.preventDefault();
      if (!open.has(path)) toggle(path);
      else go(i + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (isDir && open.has(path)) toggle(path);
      else {
        // Up to the folder this sits in.
        const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        const at = rowsNow.findIndex((r) => r.dataset.path === parent);
        if (at >= 0) go(at);
      }
    }
  };

  const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});

  const toggle = (dir: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  const body = (
    <>
      <div className="tree-bar">
        <span className="tree-find">
          <Icon name="search" size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a file" aria-label="Find a file" spellCheck={false} />
          {q && (
            <button type="button" className="icon-btn tiny" aria-label="Clear" onClick={() => setQ("")}>
              <Icon name="x" size={11} />
            </button>
          )}
        </span>
        <button
          type="button"
          className={`tree-toggle ${onlyChanged ? "on" : ""}`}
          aria-pressed={onlyChanged}
          disabled={!changedCount}
          title={changedCount ? "Show only what has changed" : "Nothing has changed yet"}
          onClick={() => setOnlyChanged((v) => !v)}
        >
          Changed{changedCount ? ` · ${changedCount}` : ""}
        </button>
        <button type="button" className="icon-btn tiny" title="Collapse every folder" aria-label="Collapse all folders" onClick={() => setOpen(new Set())} disabled={!open.size}>
          <Icon name="collapseAll" size={13} />
        </button>
        <button type="button" className="icon-btn tiny" title="Read the folder again" aria-label="Refresh" onClick={load} disabled={loading || !where}>
          <Icon name="refresh" size={13} />
        </button>
      </div>

      <div className={`tree-split ${pick ? "open" : ""}`}>
      <div className="doc-scroll tree-scroll">
        {!where ? (
          <p className="muted small">
            No folder yet. Attach one with the folder button in the composer and it appears here as a working copy — or connect a machine from the session header to work in a checkout on it.
          </p>
        ) : err ? (
          <p className="error small">{err}</p>
        ) : !paths ? (
          <p className="muted small">Reading the folder…</p>
        ) : !rows.length ? (
          <p className="muted small">{q || onlyChanged ? "Nothing here matches." : "The folder came back empty."}</p>
        ) : (
          <div className="tree-rows" role="tree" aria-label="Files in the folder" ref={rowsEl} onKeyDown={onRowKey}>
            {rows.map((r) => {
              const change = facts.changed.get(r.path);
              const touch = facts.touched.get(r.path);
              const live = touch && Date.now() - touch.ts < LIVE_MS;
              return (
                <div key={r.path} className="tree-item">
                  <button
                    type="button"
                    role="treeitem"
                    aria-expanded={r.dir ? open.has(r.path) : undefined}
                    aria-selected={pick === r.path}
                    className={`tree-row ${r.dir ? "dir" : ""} ${pick === r.path ? "on" : ""} ${change ? `ch-${change.file.status}` : ""}`}
                    style={{ ["--depth" as string]: r.depth }}
                    data-path={r.path}
                    onClick={() => (r.dir ? toggle(r.path) : openFile(r.path))}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, path: r.path, dir: r.dir });
                    }}
                  >
                    {r.dir ? <Icon name={open.has(r.path) ? "chevronDown" : "chevronRight"} size={13} className="tree-caret" /> : <FileIcon path={r.path} size={14} className="tree-caret" />}
                    <span className="tree-name">{r.name}</span>
                    {change && (
                      <span className="tree-counts">
                        {change.file.additions > 0 && <span className="add">+{change.file.additions}</span>}
                        {change.file.deletions > 0 && <span className="del">−{change.file.deletions}</span>}
                      </span>
                    )}
                    {r.dir && !open.has(r.path) && r.changed > 0 && <span className="tree-badge">{r.changed}</span>}
                    {touch && (
                      <span className={`tree-who ${live ? "live" : ""}`} title={`${touch.by} ${touch.writing ? "edited" : "read"} this ${relTime(touch.ts)} ago`}>
                        {live && <span className="tree-dot" />}
                        {firstName(touch.by)}
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {pick && (
        <div className="tree-editor-pane">
          <div className="tree-tabs" role="tablist" aria-label="Open files">
            {tabs.map((t) => (
              <span key={t} className={`tree-tab ${pick === t ? "on" : ""}`}>
                <button type="button" role="tab" aria-selected={pick === t} className="tree-tab-name" title={t} onClick={() => setPick(t)}>
                  {t.split("/").pop()}
                  {drafts[t] !== undefined && <span className="tree-tab-dot" aria-label="Unsaved" />}
                </button>
                <button type="button" className="tree-tab-x" aria-label={`Close ${t}`} onClick={() => closeFile(t)}>
                  <Icon name="x" size={10} />
                </button>
              </span>
            ))}
          </div>
          <FileView
            key={`${lane ?? ""}|${pick}`}
            path={pick}
            change={facts.changed.get(pick)}
            state={state}
            sid={sid}
            invite={invite}
            {...(lane ? { lane } : {})}
            send={send}
            canEdit={canEdit}
            viewer={me?.role === "viewer"}
            {...(jumpTo === pick && jump?.line ? { line: jump.line } : {})}
            draft={drafts[pick]}
            onDraft={(d) =>
              setDrafts((all) => {
                const next = { ...all };
                if (d === undefined) delete next[pick];
                else next[pick] = d;
                return next;
              })
            }
          />
        </div>
      )}

      </div>

      {menu && (
        <ContextMenu
          at={menu}
          onClose={() => setMenu(null)}
          items={() => [
            !menu.dir && { label: "Open", icon: "file", onSelect: () => openFile(menu.path) },
            menu.dir && { label: open.has(menu.path) ? "Collapse" : "Expand", icon: "chevronRight", onSelect: () => toggle(menu.path) },
            { label: "Copy path", icon: "copy", hint: "from the folder", onSelect: () => copy(menu.path) },
            !!where?.cwd && {
              label: "Copy full path",
              icon: "copy",
              // In the machine's own separator, so it pastes into its own terminal.
              onSelect: () => {
                const sep = where.cwd.includes("\\") ? "\\" : "/";
                copy(`${where.cwd.replace(/[\\/]+$/, "")}${sep}${sep === "/" ? menu.path : menu.path.split("/").join(sep)}`);
              },
            },
          ]}
        />
      )}

      {quick && paths && <QuickOpen paths={paths} onPick={(f) => (openFile(f), setQuick(false))} onClose={() => setQuick(false)} />}
    </>
  );

  if (bare) return body;
  return (
    <aside className="doc-panel" aria-label="Tree">
      <div className="doc-head">
        <Icon name="folderOpen" size={15} />
        <span className="doc-title">Tree</span>
        <span className="doc-count">{treeHeadline(where, paths, changedCount)}</span>
        <span className="doc-actions">
          <button className="icon-btn tiny" title="Close" aria-label="Close the tree" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </span>
      </div>
      {body}
    </aside>
  );
}

/** What the head says: where this is, and how much of it has moved. */
export function treeHeadline(where: { cwd: string; branch?: string } | null, paths: string[] | null, changed: number): string {
  if (!where) return "no folder yet";
  const name = where.cwd.split(/[\\/]/).filter(Boolean).pop() ?? where.cwd;
  const size = paths ? `${paths.length} files` : "reading…";
  return `${name}${where.branch ? ` · ${where.branch}` : ""} · ${size}${changed ? ` · ${changed} changed` : ""}`;
}

/**
 * One file, opened in place — and editable.
 *
 * Every file opens as the file itself, changed or not: the Diff panel is where changes are read as changes, so the tree is the
 * place to read the code whole. A changed file has a way to its diff from here. Files are read from the machine on demand,
 * since the tree lists a few hundred and fetching them all to show one would be absurd.
 *
 * Saving goes through the session, not around it: the same folder channel the
 * agent writes through, recorded in the log, so the room sees a person edit a
 * file the way it sees an agent edit one.
 */
function FileView({
  path,
  change,
  state,
  sid,
  invite,
  lane,
  send,
  canEdit,
  viewer,
  line,
  draft,
  onDraft,
}: {
  path: string;
  change?: { file: DiffFile; lane: string };
  state: SessionState;
  sid: string;
  invite: string;
  lane?: string;
  send?: Send;
  canEdit?: boolean;
  /** Viewers get the numbered, secret-hidden read: the server refuses them raw bytes. */
  viewer?: boolean;
  /** A line to put the cursor on, when the file was opened from an error. */
  line?: number;
  /** This file's unsaved text, held by the panel so tabs can be switched. */
  draft?: string;
  onDraft: (text: string | undefined) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState(true);

  // Another file starts fresh. Said while drawing: an effect would also run each time a kept Tree is shown again.
  const [viewOf, setViewOf] = useState(path);
  if (viewOf !== path) {
    setViewOf(path);
    setEditing(true);
    setText(null);
    setErr("");
  }

  // The bytes, not the numbered rendering: an editor has to write back what it read.
  useEffect(() => {
    if (change && !editing) return;
    let live = true;
    fetch(`/api/sessions/${encodeURIComponent(sid)}/repo?op=read${viewer ? "" : "&raw=1"}&path=${encodeURIComponent(path)}&invite=${encodeURIComponent(invite)}${lane ? `&lane=${encodeURIComponent(lane)}` : ""}`)
      .then((r) => r.json() as Promise<{ output?: string; error?: string }>)
      .then((r) => live && (r.error ? setErr(r.error) : setText(viewer ? unnumbered(r.output ?? "") : (r.output ?? ""))))
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [path, editing, !!change, sid, invite]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = draft !== undefined && draft !== text;
  const save = async () => {
    if (!send || draft === undefined || saving) return;
    setSaving(true);
    setErr("");
    const r = await send({ type: "folder.write", path, content: draft, quiet: true });
    setSaving(false);
    if (!r.ok) return setErr(r.error ?? "Couldn't save that file. Check the machine is still connected, then try again.");
    setText(draft);
    onDraft(undefined);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (change && !editing) {
    return (
      <div className="tree-open">
        <p className="muted small tree-open-by">
          Changed by {agentNameFor(state, change.lane)}
          {change.file.truncated ? " · diff cut short" : ""}
          {canEdit && (
            <button type="button" className="link-btn tree-edit" onClick={() => setEditing(true)}>
              Show the whole file
            </button>
          )}
        </p>
        <FileDiff file={<span className="diff-path">{path}</span>} lines={patchLines(change.file.patch)} status="complete" defaultOpen maxHeight={420} copyText={change.file.patch} />
      </div>
    );
  }

  const value = draft ?? text ?? "";
  return (
    <div className="tree-open">
      {err && <p className="error small">{err}</p>}
      {text === null && !err ? (
        <p className="muted small">Reading…</p>
      ) : text === null ? (
        // Nothing was read, so there is nothing to edit or save: only the reason, and the diff when there is one.
        change ? (
          <button type="button" className="rsp-text-btn" onClick={() => setEditing(false)}>
            Show the diff instead
          </button>
        ) : null
      ) : canEdit && send ? (
        <>
          <CodeEditor path={path} value={value} line={line} onChange={onDraft} onSave={() => void save()} />
          <div className="tree-edit-bar">
            <span className="muted small">{dirty ? "Unsaved changes · ⌘S" : saved ? "Saved" : "Saved on this machine"}</span>
            {change && (
              <button type="button" className="rsp-text-btn" onClick={() => setEditing(false)}>
                Show the diff
              </button>
            )}
            <button type="button" className="rsp-text-btn" disabled={!dirty || saving} onClick={() => onDraft(undefined)}>
              Revert
            </button>
            <button type="button" className="btn primary small" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      ) : (
        <>
          <CodeReader path={path} value={value} />
          {change && (
            <div className="tree-edit-bar">
              <span className="muted small">Changed by {agentNameFor(state, change.lane)}</span>
              <button type="button" className="rsp-text-btn" onClick={() => setEditing(false)}>
                Show the diff
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The three things the session knows about the paths the machine listed. */
function useFacts(state: SessionState, events: SessionEvent[], paths: string[]): TreeFacts {
  // Once per listing, not per event: each path an agent names is looked up in it.
  const known = useMemo(() => new Set(paths), [paths]);
  return useMemo(() => {
    const changed = new Map<string, { file: DiffFile; lane: string }>();
    for (const [lane, d] of Object.entries(state.diffs)) for (const f of d.files) changed.set(f.path, { file: f, lane });

    // Who last had their hands in a file, from the tool calls in the log. A
    // write outranks a read at the same moment: "Ada is editing this" is the
    // useful fact, and "Ada looked at it" is the one it replaces.
    const touched = new Map<string, Touch>();
    for (const e of events) {
      if (e.body.type !== "agent.message") continue;
      for (const c of e.body.toolCalls) {
        const writing = WRITES.has(c.name);
        if (!writing && !READS.has(c.name)) continue;
        // Parsed once per call (argsOf keeps them): the whole log is read again on every event, and a call never changes.
        const p = String(argsOf(c).path ?? "");
        // Some CLIs report an absolute path; the tree is relative to the root.
        for (const one of p.split(",").map((x) => x.trim())) {
          const rel = relativise(one, known);
          if (!rel) continue;
          const prev = touched.get(rel);
          if (prev && prev.ts > e.ts && (prev.writing || !writing)) continue;
          touched.set(rel, { by: e.actor.name, ts: e.ts, writing: writing || (prev?.writing ?? false) });
        }
      }
    }

    const e = state.engines[MAIN_LANE] ?? Object.values(state.engines)[0];
    return { paths, changed, touched, where: e ? { host: e.hostName, cwd: e.cwd, branch: e.branch } : null };
  }, [state, events, paths, known]);
}

/** "(no files)" and the trailing note are prose, not paths. */
/** The last listing each session showed, so returning to it draws the tree at once. */
const treeCache = new Map<string, string[]>();

export function parseTree(output: string): string[] {
  return output
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("[") && l !== "(no files)" && !l.endsWith(":"));
}

/**
 * A path as the tree knows it.
 *
 * An agent may say `/Users/ada/app/src/x.ts`, `./src/x.ts` or `src/x.ts` for
 * the same file. Matching by suffix against what the machine listed is both
 * simpler and more forgiving than trying to reconstruct the root.
 *
 * The longest tail of it that was listed wins: the whole path, then without its first folder, and so on. Each is one
 * lookup in the set, where checking every listed path against the end of it was a scan of the repo per path per event.
 */
export function relativise(p: string, paths: ReadonlySet<string> | string[]): string | null {
  if (!p) return null;
  const known = Array.isArray(paths) ? new Set(paths) : paths;
  let tail = p.replace(/^\.\//, "").replace(/\\/g, "/");
  for (;;) {
    if (known.has(tail)) return tail;
    const cut = tail.indexOf("/");
    if (cut === -1) return null;
    tail = tail.slice(cut + 1);
  }
}

/** Paths to rows: folders first, each level alphabetical, only what is open. */
/**
 * The file in the folder a path means: itself when it is there, else the one file whose path ends with it (the shortest of
 * several, the one nearest the top). A path that matches nothing is kept, and opening it says there is no such file.
 */
export function resolvePath(paths: string[], want: string): string {
  if (paths.includes(want)) return want;
  const tail = `/${want}`;
  return paths.filter((p) => p.endsWith(tail)).sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)[0] ?? want;
}

export function flatten(paths: string[], facts: TreeFacts, opts: { q: string; onlyChanged: boolean; open: Set<string> }): Row[] {
  const { q, onlyChanged, open } = opts;
  const keep = paths.filter((p) => (!q || p.toLowerCase().includes(q)) && (!onlyChanged || facts.changed.has(p)));
  if (!keep.length) return [];

  // Searching or filtering is a different question — "where is this file" —
  // and answering it with a tree the person has to unfold is a worse answer.
  if (q || onlyChanged) {
    return [...keep].sort().map((p) => ({ path: p, name: p, depth: 0, dir: false, changed: 0 }));
  }

  const dirs = new Map<string, number>();
  for (const p of keep) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      dirs.set(d, (dirs.get(d) ?? 0) + (facts.changed.has(p) ? 1 : 0));
    }
  }

  const rows: Row[] = [];
  // Visible means every folder above it is open — the row itself being a
  // closed folder is what stops its own children, one level further down.
  const visible = (p: string) => {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) if (!open.has(parts.slice(0, i).join("/"))) return false;
    return true;
  };
  const entries = [...new Set([...dirs.keys(), ...keep])].sort((a, b) => compare(a, b, dirs));
  for (const p of entries) {
    const dir = dirs.has(p);
    if (!visible(p)) continue;
    rows.push({ path: p, name: p.split("/").pop()!, depth: p.split("/").length - 1, dir, changed: dirs.get(p) ?? 0 });
  }
  return rows;
}

/**
 * Folders before files at each level, then alphabetical, like every file tree.
 *
 * A path is a folder at the point they diverge if it has more segments below
 * that point — or if the listing knows it as one, which is how `src/util` (a
 * folder with a row of its own) sorts above `src/app.ts`.
 */
function compare(a: string, b: string, dirs: Map<string, number>): number {
  const as = a.split("/");
  const bs = b.split("/");
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    if (as[i] === bs[i]) continue;
    const at = (parts: string[]) => i < parts.length - 1 || dirs.has(parts.slice(0, i + 1).join("/"));
    if (at(as) !== at(bs)) return at(as) ? -1 : 1;
    return as[i]!.localeCompare(bs[i]!);
  }
  return as.length - bs.length;
}

const firstName = (n: string) => n.split(/[\s']/)[0] ?? n;
