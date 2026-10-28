import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SearchHit } from "../session-search.js";
import { Icon, type IconName } from "./icons.js";
import type { RecentSession } from "./storage.js";
import { MenuButton, relTime, useDismiss } from "./ui.js";

/**
 * Search, in its own window: sessions by their titles and by everything said in them.
 *
 * Opened from the sidebar's search button or ⌘⇧F. Titles you know match as you type, from this computer; what was said is
 * asked of the server once the typing stops (GET /api/sessions/search: only sessions you are in now). Narrowed by who said it,
 * what kind of message, and when; ranked by how well it matches, or newest first. Every word must be there, "quotes" keep
 * a phrase together. Up and down move, Enter opens: a session at its top, a message at that message.
 */

type From = "any" | "me" | "people" | "agents";
type Kind = "any" | "asked" | "answer" | "comment";
type Sort = "best" | "recent";
type Result = { sid: string; title: string; role: RecentSession["role"]; invite: string; hits: SearchHit[]; titleMatch: boolean; at: number };

const FROM: Record<From, string> = { any: "Anyone", me: "You", people: "Teammates", agents: "Agents" };
const KIND: Record<Kind, string> = { any: "Every message", asked: "Asked and suggested", answer: "Agent answers", comment: "Review comments" };
const DAYS: [number, string][] = [
  [0, "Any time"],
  [1, "Today"],
  [7, "Past week"],
  [30, "Past month"],
  [90, "Past 3 months"],
];
const KIND_ICON: Record<SearchHit["kind"], IconName> = { asked: "user", answer: "agent", comment: "message" };

/** Once the session's feed is on screen, scroll to the message and let it flash, as the catch-up's jump does. */
export function jumpWhenShown(sid: string, seq: number, within = 8000): void {
  const started = Date.now();
  // Only once the address is the session being opened, and a moment after: until then the feed on screen is the one left.
  let arrived = 0;
  const tryJump = () => {
    if (new URLSearchParams(location.search).get("session") !== sid) {
      if (Date.now() - started < within) setTimeout(tryJump, 150);
      return;
    }
    arrived ||= Date.now();
    if (Date.now() - arrived < 300) return void setTimeout(tryJump, 150);
    let best: HTMLElement | null = null;
    let bestSeq = 0;
    for (const el of document.querySelectorAll<HTMLElement>("[data-seq]")) {
      const n = Number(el.dataset.seq);
      if (n <= seq && n > bestSeq) [best, bestSeq] = [el, n];
    }
    if (best && bestSeq > 0) {
      best.scrollIntoView({ block: "center", behavior: "smooth" });
      best.classList.add("jump-flash");
      setTimeout(() => best!.classList.remove("jump-flash"), 1400);
      return;
    }
    if (Date.now() - started < within) setTimeout(tryJump, 150);
  };
  setTimeout(tryJump, 150);
}

/** The text with each found term marked. */
function Marked({ text, marks }: { text: string; marks: [number, number][] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  marks.forEach(([a, z], i) => {
    if (a > at) parts.push(text.slice(at, a));
    parts.push(<mark key={i}>{text.slice(a, z)}</mark>);
    at = z;
  });
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/** A title with each term marked, found the same way the server finds them. */
function markTitle(title: string, q: string): [number, number][] {
  const terms = q.toLowerCase().match(/"[^"]+"|\S{2,}/g)?.map((t) => t.replace(/"/g, "").trim()).filter(Boolean) ?? [];
  const low = title.toLowerCase();
  const out: [number, number][] = [];
  for (const t of terms) for (let i = low.indexOf(t); i >= 0; i = low.indexOf(t, i + t.length)) out.push([i, i + t.length]);
  out.sort((a, b) => a[0] - b[0]);
  return out.filter((m, i) => i === 0 || m[0] >= out[i - 1]![1]);
}

type Row = { key: string; sid: string; seq?: number; open: () => void };

export function SearchModal({ recents, onOpen, onClose }: { recents: RecentSession[]; onOpen: (r: RecentSession) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [from, setFrom] = useState<From>("any");
  const [kind, setKind] = useState<Kind>("any");
  const [days, setDays] = useState(0);
  const [sort, setSort] = useState<Sort>("best");
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // Back to typing once a filter is picked, so Enter opens what is chosen and the next word goes in the box.
  useEffect(() => {
    const t = setTimeout(() => field.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [from, kind, days, sort]);
  const query = q.trim();
  const narrowed = from !== "any" || kind !== "any" || days > 0;

  useEffect(() => {
    if (query.length < 3) {
      setResults(null);
      setBusy(false);
      return;
    }
    let live = true;
    setBusy(true);
    const t = setTimeout(() => {
      const p = new URLSearchParams({ q: query, from, kind, sort, ...(days ? { days: String(days) } : {}) });
      fetch(`/api/sessions/search?${p}`, { credentials: "same-origin" })
        .then(async (r) => {
          const b = (await r.json().catch(() => ({}))) as { results?: Result[]; error?: string };
          if (!live) return;
          setError(r.ok ? "" : (b.error ?? "Search didn't answer. Try again."));
          setResults(r.ok ? (b.results ?? []) : []);
        })
        .catch(() => live && (setError("Search didn't answer. Check your connection and try again."), setResults([])))
        .finally(() => live && setBusy(false));
    }, 260);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, from, kind, days, sort]);

  // Your own titles and names for them, matched here as you type: no waiting for the server to find a session you named.
  const named = useMemo(() => {
    if (!query) return [...recents].sort((a, b) => b.openedAt - a.openedAt).slice(0, 8);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return recents.filter((r) => terms.every((t) => `${r.alias ?? ""} ${r.title}`.toLowerCase().includes(t.replace(/"/g, "")))).slice(0, 6);
  }, [recents, query]);

  const open = (r: Result | RecentSession, seq?: number) => {
    onClose();
    onOpen(recents.find((x) => x.sid === r.sid) ?? { sid: r.sid, title: r.title, invite: r.invite, role: r.role, openedAt: Date.now() });
    if (seq) jumpWhenShown(r.sid, seq);
  };

  // Sessions found by what was said, without the ones already shown by their title.
  const shownByName = new Set(narrowed ? [] : named.map((r) => r.sid));
  const found = (results ?? []).filter((r) => r.hits.length || !shownByName.has(r.sid));
  const nameRows = narrowed ? [] : named;

  const rows: Row[] = [
    ...nameRows.map((r) => ({ key: `n:${r.sid}`, sid: r.sid, open: () => open(r) })),
    ...found.flatMap((r) => [{ key: `s:${r.sid}`, sid: r.sid, open: () => open(r) }, ...r.hits.map((h) => ({ key: `h:${r.sid}:${h.seq}`, sid: r.sid, seq: h.seq, open: () => open(r, h.seq) }))]),
  ];
  useEffect(() => setAt(0), [query, from, kind, days, sort, results]);
  const chosen = rows[Math.min(at, rows.length - 1)];
  useEffect(() => {
    if (chosen) list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(chosen.key)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [chosen]);
  const on = (key: string) => (chosen?.key === key ? " on" : "");
  const hover = (key: string) => () => setAt(rows.findIndex((r) => r.key === key));

  const clear = () => (setFrom("any"), setKind("any"), setDays(0));
  // Tab kept inside, one dialog at a time, and the focus back where it was on close (2026-10-27 audit), as every other dialog.
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, onClose);

  return (
    <div className="quick-back" role="presentation" onMouseDown={onClose}>
      <div
        ref={box}
        className="quick srch"
        role="dialog"
        aria-modal="true"
        aria-label="Search sessions"
        onMouseDown={(e) => e.stopPropagation()}
        // Here rather than on the field: after a filter is picked, the arrows still move through the results.
        onKeyDown={(e) => {
          // A filter menu sits in a portal, so its keys come up through here too: they are the menu's, Esc included (it closes
          // the menu, not the window and the query with it).
          if ((e.target as HTMLElement).closest(".menu, [role='menu']")) return;
          if (e.key === "ArrowDown") (e.preventDefault(), setAt((i) => Math.min(i + 1, rows.length - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setAt((i) => Math.max(i - 1, 0)));
          else if (e.key === "Escape") onClose();
          else if (e.key === "Enter" && chosen && (e.target as HTMLElement).tagName === "INPUT") (e.preventDefault(), chosen.open());
        }}
      >
        <div className="srch-find">
          <Icon name="search" size={16} />
          <input
            ref={field}
            autoFocus
            value={q}
            spellCheck={false}
            placeholder="Search sessions and everything said in them"
            aria-label="Search"
            aria-controls="srch-results"
            onChange={(e) => setQ(e.target.value)}
          />
          {busy && <span className="srch-spin" aria-label="Searching" />}
          <kbd className="srch-esc">Esc</kbd>
        </div>

        <div className="srch-filters" role="toolbar" aria-label="Filters">
          <MenuButton
            className={`srch-chip${from !== "any" ? " set" : ""}`}
            label="Who said it"
            icon="user"
            text={from === "any" ? "From anyone" : `From ${FROM[from].toLowerCase()}`}
            caret="chevronDown"
            width={200}
            items={() => [{ heading: "Said by" }, ...(Object.keys(FROM) as From[]).map((k) => ({ label: FROM[k], checked: from === k, onSelect: () => setFrom(k) }))]}
          />
          <MenuButton
            className={`srch-chip${kind !== "any" ? " set" : ""}`}
            label="Kind of message"
            icon="message"
            text={KIND[kind]}
            caret="chevronDown"
            width={220}
            items={() => [{ heading: "Messages" }, ...(Object.keys(KIND) as Kind[]).map((k) => ({ label: KIND[k], checked: kind === k, onSelect: () => setKind(k) }))]}
          />
          <MenuButton
            className={`srch-chip${days ? " set" : ""}`}
            label="When"
            icon="clock"
            text={DAYS.find(([d]) => d === days)?.[1] ?? "Any time"}
            caret="chevronDown"
            width={180}
            items={() => [{ heading: "When" }, ...DAYS.map(([d, l]) => ({ label: l, checked: days === d, onSelect: () => setDays(d) }))]}
          />
          {narrowed && (
            <button type="button" className="srch-clear" onClick={clear}>
              Clear filters
            </button>
          )}
          <span className="srch-sort">
            <MenuButton
              className="srch-chip quiet"
              label="Order"
              icon="list"
              text={sort === "best" ? "Best match" : "Newest first"}
              caret="chevronsUpDown"
              width={180}
              end
              items={() => [
                { heading: "Order" },
                { label: "Best match", checked: sort === "best", onSelect: () => setSort("best") },
                { label: "Newest first", checked: sort === "recent", onSelect: () => setSort("recent") },
              ]}
            />
          </span>
        </div>

        <span className="sr-only" role="status">
          {query.length >= 3 && results !== null && !busy && found.length === 0 && nameRows.length === 0 ? error || `Nothing matches ${query}` : ""}
        </span>
        <div className="srch-body" id="srch-results" ref={list}>
          {nameRows.length > 0 && (
            <section className="srch-group" aria-label={query ? "Sessions by title" : "Recent sessions"}>
              <h3>{query ? "Titles" : "Recent"}</h3>
              {nameRows.map((r) => {
                const key = `n:${r.sid}`;
                const title = r.alias || r.title || "Untitled session";
                return (
                  <button key={key} data-key={key} type="button" className={`srch-row${on(key)}`} title={title} onMouseEnter={hover(key)} onClick={() => open(r)}>
                    <Icon name="chat" size={15} />
                    <span className="srch-title">
                      <Marked text={title} marks={query ? markTitle(title, query) : []} />
                    </span>
                    <span className="srch-when">{relTime(r.openedAt)}</span>
                  </button>
                );
              })}
            </section>
          )}

          {query.length >= 3 && results !== null && found.length > 0 && (
            <section className="srch-group" aria-label="Found in messages">
              <h3>
                In messages <span className="srch-count">{found.length === 20 ? "20+" : found.length}</span>
              </h3>
              {found.map((r) => {
                const key = `s:${r.sid}`;
                const title = r.title || "Untitled session";
                return (
                  <div key={r.sid} className="srch-session">
                    <button data-key={key} type="button" className={`srch-row srch-head${on(key)}`} title={title} onMouseEnter={hover(key)} onClick={() => open(r)}>
                      <Icon name="chat" size={15} />
                      <span className="srch-title">
                        <Marked text={title} marks={r.titleMatch ? markTitle(title, query) : []} />
                      </span>
                      <span className="srch-when">{relTime(r.at)}</span>
                    </button>
                    {r.hits.map((h) => {
                      const hk = `h:${r.sid}:${h.seq}`;
                      return (
                        <button key={hk} data-key={hk} type="button" className={`srch-row srch-hit${on(hk)}`} onMouseEnter={hover(hk)} onClick={() => open(r, h.seq)}>
                          <Icon name={KIND_ICON[h.kind]} size={13} />
                          <span className="srch-snip">
                            <span className="srch-who">{h.by === "me" ? "You" : h.by === "agents" ? h.who : h.who.split(/\s+/)[0]}</span> <Marked text={h.snippet} marks={h.marks} />
                          </span>
                          <span className="srch-when">{relTime(h.at)}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </section>
          )}

          {query.length > 0 && query.length < 3 && nameRows.length === 0 && <p className="srch-note">Keep typing: messages are searched from three letters.</p>}
          {query.length >= 3 && results !== null && !busy && found.length === 0 && nameRows.length === 0 && (
            <div className="srch-empty">
              <p className="srch-empty-title">{error || `Nothing matches “${query}”`}</p>
              {!error && <p className="srch-note">{narrowed ? "Try clearing the filters, or fewer words." : "Every word has to be there. Try fewer words, or another spelling."}</p>}
              {narrowed && !error && (
                <button type="button" className="btn ghost small" onClick={clear}>
                  Clear filters
                </button>
              )}
            </div>
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
          <span>
            <kbd>"</kbd>quotes<kbd>"</kbd> for an exact phrase
          </span>
        </div>
      </div>
    </div>
  );
}
