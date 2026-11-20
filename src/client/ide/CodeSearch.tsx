import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../icons.js";
import { loadRecents, type Identity } from "../storage.js";
import { relTime, useDismiss } from "../ui.js";
import { isCodeChat, sameFolder, showCodeChat, useCodeChats } from "./code-chats.js";
import { IS_MAC } from "./util.js";
import { ideIsUp } from "./ide-up.js";
import { setIdeRoot } from "./mode.js";
import { flatRows, foundNow, mergeSearch, type SearchFound, type SearchRow } from "./search-rank.js";
import { cachedFiles, listingState, loadFiles } from "./search-files.js";
import "./code-search.css";

/**
 * One search for Code, opened by the window bar's pill (Arun, 2026-11-20: "One search: the window bar's search finds files and
 * symbols in the IDE's folder AND Code chats AND Agents sessions, in one list"). As you type: the folder's files, Code chats,
 * Agents sessions (their titles at once, what was said in them once the typing stops), then "Search symbols" and "Search text in
 * files", which hand the words to the IDE's own. Up and down move, Enter opens, ⌘Enter opens a file beside the one in the editor.
 * Ranking and merging are search-rank.ts; the folder's list is kept by search-files.ts.
 */

const base = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/** Text with some of its letters marked: `at` are indices in the whole path, `from` is where this piece starts in it. */
function Marked({ text, at, from }: { text: string; at: number[]; from: number }) {
  const out: ReactNode[] = [];
  let run = "";
  let marked = false;
  const set = new Set(at);
  const flush = (k: number) => {
    if (!run) return;
    out.push(marked ? <mark key={k}>{run}</mark> : run);
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const m = set.has(from + i);
    if (m !== marked) (flush(i), (marked = m));
    run += text[i];
  }
  flush(text.length);
  return <>{out}</>;
}

type Found = { sid: string; title: string; invite: string; at: number; titleMatch: boolean; hits: { snippet: string; who: string; by: string }[] };

export function CodeSearch({ identity, folder, onClose }: { identity: Identity; folder: string | null; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [files, setFiles] = useState<string[]>(() => (folder ? (cachedFiles(folder) ?? []) : []));
  const [listing, setListing] = useState(!!folder);
  // The server's hits are kept with the words they were found for: under other words they are not shown.
  const [foundFor, setFound] = useState<{ q: string; rows: SearchFound[] }>({ q: "", rows: [] });
  const [note, setNote] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, onClose);
  const chats = useCodeChats();
  // Agents' own list: what Code keeps apart (code-chats.ts) is left out.
  const sessions = useMemo(() => loadRecents().filter((r) => !isCodeChat(r.sid)).map((r) => ({ sid: r.sid, title: r.alias || r.title, at: r.openedAt })), []);

  // The folder's files: what was kept shows at once, and a fresh listing replaces it when it arrives.
  useEffect(() => {
    if (!folder) return void setListing(false);
    let live = true;
    void loadFiles(identity, folder).then((f) => {
      if (!live) return;
      setFiles(f);
      setListing(false);
      const st = listingState(folder);
      setNote(st.failed ? "Couldn't read the folder's files." : st.truncated ? "Showing the first 50,000 files." : "");
    });
    return () => void (live = false);
  }, [identity, folder]);

  // What was said in sessions, from the server once the typing stops, as the sessions' own search does.
  const query = q.trim();
  useEffect(() => {
    if (query.length < 3) return void setFound({ q: "", rows: [] });
    let live = true;
    const t = setTimeout(() => {
      fetch(`/api/sessions/search?${new URLSearchParams({ q: query, from: "any", kind: "any", sort: "best" })}`, { credentials: "same-origin" })
        .then(async (r) => ((await r.json().catch(() => ({}))) as { results?: Found[] }).results ?? [])
        .then((rs) => live && setFound({ q: query, rows: rs.map((r) => ({ sid: r.sid, title: r.title, at: r.at, invite: r.invite, titleMatch: r.titleMatch, ...(r.hits[0] ? { snippet: r.hits[0].snippet, who: r.hits[0].by === "me" ? "You" : r.hits[0].who.split(/\s+/)[0] } : {}) })) }))
        .catch(() => live && setFound({ q: "", rows: [] }));
    }, 260);
    return () => (live = false, clearTimeout(t));
  }, [query]);

  // A chat taken off Code's history is still Code's (code-chats.ts): not offered as an Agents session.
  const found = useMemo(() => foundNow(foundFor, query, chats, isCodeChat), [foundFor, query, chats]);
  const up = ideIsUp();
  const groups = useMemo(
    () => mergeSearch({ query, files, chats, sessions, found, ide: up, folder, same: sameFolder }),
    [query, files, chats, sessions, found, up, folder],
  );
  const rows = useMemo(() => flatRows(groups), [groups]);
  useEffect(() => setAt(0), [query]);
  const chosen = rows[Math.min(at, rows.length - 1)];
  useEffect(() => {
    if (chosen) list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(chosen.key)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [chosen]);

  const open = (r: SearchRow, beside = false) => {
    onClose();
    const ev = (name: string, detail: unknown) => window.dispatchEvent(new CustomEvent(name, { detail }));
    // A file opens in the IDE (VsCodeView), which takes the keyboard, beside the editor's own column when asked.
    if (r.kind === "file") ev("friday:ide-open", { path: r.path, focus: true, ...(beside ? { side: true } : {}), ...(r.line ? { line: r.line } : {}) });
    else if (r.kind === "chat") {
      // A chat of another folder takes the IDE there first, as the palette's "Open a Code chat" does.
      if (!folder || !sameFolder(r.folder, folder)) setIdeRoot(r.folder);
      showCodeChat(r.folder, r.sid);
      ev("friday:ide-action", { id: `chat:${r.sid}` });
    } else if (r.kind === "session") {
      const mine = loadRecents().find((x) => x.sid === r.sid);
      const invite = mine?.invite ?? r.invite;
      if (invite) ev("friday:code-to-agents", { sid: r.sid, invite, title: "", open: true });
    } else ev("friday:vsc-command", { name: r.kind === "symbols" ? "searchSymbols" : "searchText", arg: r.query });
  };

  const on = (key: string) => (chosen?.key === key ? " on" : "");
  const hover = (key: string) => () => setAt(rows.findIndex((r) => r.key === key));
  const icon = (r: SearchRow): IconName => (r.kind === "file" ? "file" : r.kind === "chat" ? "chat" : r.kind === "session" ? "message" : r.kind === "symbols" ? "code" : "search");

  return (
    <div className="quick-back" role="presentation" onMouseDown={onClose}>
      <div
        ref={box}
        className="quick srch cs"
        role="dialog"
        aria-modal="true"
        aria-label="Search files, chats and sessions"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setAt((i) => Math.min(i + 1, rows.length - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setAt((i) => Math.max(i - 1, 0)));
          else if (e.key === "Escape") onClose();
          else if (e.key === "Enter" && chosen) (e.preventDefault(), open(chosen, e.metaKey || e.ctrlKey));
        }}
      >
        <div className="srch-find">
          <Icon name="search" size={16} />
          <input autoFocus value={q} spellCheck={false} placeholder={folder ? `Search ${base(folder)}, chats and sessions` : "Search chats and sessions"} aria-label="Search" aria-controls="cs-results" onChange={(e) => setQ(e.target.value)} />
          {listing && <span className="srch-spin" aria-label="Reading the folder" />}
          <kbd className="srch-esc">Esc</kbd>
        </div>
        <div className="srch-body" id="cs-results" ref={list}>
          {/* Only the hand-offs left: nothing here matches, and the IDE's own searches go further (symbols, text inside files). */}
          {query && groups.every((g) => g.id === "ide") && (
            <p className="srch-note" role="status">
              Nothing matches “{query}” in {folder ? "the folder, " : ""}chats or sessions. The IDE can look inside files:
            </p>
          )}
          {groups.map((g) => (
            <section key={g.id} className="srch-group" aria-label={g.label}>
              <h3>{g.label}</h3>
              {g.rows.map((r) => (
                <button key={r.key} data-key={r.key} type="button" className={`srch-row cs-row${on(r.key)}`} onMouseEnter={hover(r.key)} onClick={(e) => open(r, e.metaKey || e.ctrlKey)}>
                  <Icon name={icon(r)} size={15} />
                  {r.kind === "file" ? (
                    <>
                      <span className="srch-title">
                        <Marked text={r.name} at={r.marks} from={r.path.length - r.name.length} />
                      </span>
                      {r.dir && (
                        <span className="cs-dir">
                          <Marked text={r.dir} at={r.marks} from={0} />
                        </span>
                      )}
                      {r.line && <span className="srch-when">:{r.line}</span>}
                    </>
                  ) : r.kind === "chat" || r.kind === "session" ? (
                    <>
                      <span className="srch-title">{r.title}</span>
                      {r.snippet && <span className="cs-dir">{r.snippet}</span>}
                      {r.kind === "chat" && !r.here && <span className="cs-dir cs-folder">{base(r.folder)}</span>}
                      <span className="srch-when">{relTime(r.at)}</span>
                    </>
                  ) : (
                    <>
                      <span className="srch-title cs-ide">{r.kind === "symbols" ? "Search symbols in the IDE" : "Search text in files"}</span>
                      <span className="cs-dir cs-q">“{r.query}”</span>
                      <kbd className="cs-go">↵</kbd>
                    </>
                  )}
                </button>
              ))}
            </section>
          ))}
          {note && !listing && <p className="srch-note" role="status">{note}</p>}
          {rows.length === 0 && (
            <p className="srch-note">{query ? `Nothing matches “${query}”.` : folder ? "Type a file name, a chat or a session." : "Open a folder to search its files. Chats and sessions are searched meanwhile."}</p>
          )}
        </div>
        <div className="srch-foot" aria-hidden>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> to open
          </span>
          {rows.some((r) => r.kind === "file") && (
            <span>
              <kbd>{IS_MAC ? "⌘" : "Ctrl"}</kbd>
              <kbd>↵</kbd> beside
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

