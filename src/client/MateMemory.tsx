import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { PencilIcon, PlusIcon, RefreshCwIcon, SearchIcon, XIcon } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { api } from "./api.js";
import type { Identity } from "./storage.js";
import { timeOf } from "./team-status.js";

/**
 * A crew mate's memory (Arun, 2026-11-15: "make the memories side panel page more advanced and better designed"): what it keeps
 * between conversations, its MEMORY.md, as notes rather than a box of text. Each note is a row, grouped under the file's own
 * headings, edited where it stands and taken away with its ×; a note of your own goes in from the top; a search narrows them; a
 * meter says how much of the page it reads with every message is used. Every change is kept at once, and one made meanwhile by the
 * crew mate is never written over unasked. The file as text is a switch away, for anything the notes don't show.
 */
const PAGE = 6000;

/** A line of the file, or a note with the lines that carry it on. */
type Block = { kind: "heading" | "note" | "other" | "blank"; raw: string; text: string };

/** The file as blocks: headings, notes (a bullet and its indented lines after it), anything else as it is. */
export function parseMemory(text: string): Block[] {
  const out: Block[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const last = out.at(-1);
    if (last?.kind === "note" && /^\s{2,}\S/.test(line)) {
      last.raw += `\n${line}`;
      last.text += ` ${line.trim()}`;
      continue;
    }
    if (!line.trim()) out.push({ kind: "blank", raw: line, text: "" });
    else if (/^#{1,6}\s/.test(line)) out.push({ kind: "heading", raw: line, text: line.replace(/^#+\s*/, "").trim() });
    else if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) out.push({ kind: "note", raw: line, text: line.replace(/^\s*([-*+]|\d+[.)])\s+/, "").trim() });
    else out.push({ kind: "note", raw: line, text: line.trim() });
  }
  return out;
}
const join = (blocks: Block[]) => blocks.map((b) => b.raw).join("\n");
/** A note as the file keeps it: a bullet, one line. */
const asNote = (t: string): Block => ({ kind: "note", raw: `- ${t.replace(/\s+/g, " ").trim()}`, text: t.replace(/\s+/g, " ").trim() });
const plain = (t: string) => t.replace(/\*\*|__|`/g, "");

export function MateMemory({ identity, id, name }: { identity: Identity; id: string; name: string }) {
  const [text, setText] = useState<string | null>(null);
  const [mtime, setMtime] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"notes" | "text">("notes");
  const [raw, setRaw] = useState("");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setText(null);
    setErr("");
    void api<{ text: string; mtime?: number | null }>(identity, `/api/teammates/${id}/memory`)
      .then((r) => live && (setText(r.text), setRaw(r.text), setMtime(r.mtime ?? null), setStale(false)))
      .catch((e: Error) => live && setErr(`Couldn't read ${name}'s memory: ${e.message}`));
    return () => void (live = false);
  }, [identity.id, id, n]); // eslint-disable-line react-hooks/exhaustive-deps
  const blocks = useMemo(() => parseMemory(text ?? ""), [text]);
  /** Kept at once; its change meanwhile is never written over without asking (409). */
  const keep = async (next: string, force = false): Promise<boolean> => {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`/api/teammates/${id}/memory`, { method: "PUT", credentials: "same-origin", body: JSON.stringify({ text: next, ...(force ? {} : { mtime }) }), headers: { "Content-Type": "application/json" } });
      const r = (await res.json().catch(() => ({}))) as { mtime?: number | null; error?: string };
      if (res.status === 409) return (setStale(true), false);
      if (!res.ok) throw new Error(r.error ?? "That didn't save. Try again.");
      setText(next);
      setRaw(next);
      setMtime(r.mtime ?? Date.now());
      setStale(false);
      return true;
    } catch (x) {
      setErr((x as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const put = (i: number, b: Block | null) => keep(join(b ? blocks.map((x, j) => (j === i ? b : x)) : blocks.filter((_, j) => j !== i)));
  const add = async () => {
    const t = adding.trim();
    if (!t) return;
    // At the end, after any blank lines it ends with.
    const body = (text ?? "").replace(/\s+$/, "");
    if (await keep(`${body}${body ? "\n" : ""}- ${t.replace(/\s+/g, " ")}\n`)) setAdding("");
  };
  const notes = blocks.filter((b) => b.kind === "note").length;
  const used = (text ?? "").length;
  const share = Math.min(1, used / PAGE);
  const shown = q.trim() ? blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.kind === "note" && b.text.toLowerCase().includes(q.trim().toLowerCase())) : blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.kind !== "blank");
  return (
    <div className="mm">
      <div className="mm-head">
        <div className="mm-meter" title={`${used.toLocaleString()} of about ${PAGE.toLocaleString()} characters read with every message`}>
          <span className="mm-meter-words">
            <b>{text === null ? "…" : `${notes} ${notes === 1 ? "note" : "notes"}`}</b>
            <span>{text === null ? "" : used > PAGE ? "Over a page: it reads the newest part" : `${Math.round(share * 100)}% of a page`}</span>
          </span>
          <span className="mm-meter-bar" aria-hidden="true">
            <i style={{ width: `${Math.round(share * 100)}%` }} data-over={used > PAGE ? "" : undefined} />
          </span>
        </div>
        <div className="rt-seg mm-mode" role="radiogroup" aria-label="Show as">
          <button type="button" role="radio" aria-checked={mode === "notes"} className="rt-seg-opt" onClick={() => setMode("notes")}>
            Notes
          </button>
          <button type="button" role="radio" aria-checked={mode === "text"} className="rt-seg-opt" onClick={() => (setRaw(text ?? ""), setMode("text"))}>
            Text
          </button>
        </div>
      </div>
      {mtime && <p className="mm-when">Updated {timeOf(mtime)}</p>}
      {stale && (
        <p className="mm-stale" role="alert">
          {name} changed its memory since you opened it.
          <button type="button" className="tm-link" onClick={() => setN((x) => x + 1)}>
            <RefreshCwIcon className="size-3" /> Reload
          </button>
        </p>
      )}
      {err && (
        <p className="msd-err" role="alert">
          {err}
        </p>
      )}
      {mode === "text" ? (
        <div className="mm-text">
          <Textarea aria-label={`${name}'s memory as text`} value={raw} rows={16} disabled={text === null} onChange={(e) => setRaw(e.target.value)} />
          <div className="mm-text-foot">
            <span>{raw !== text ? "Not saved yet" : "Saved"}</span>
            <button type="button" className="mm-btn" disabled={busy || raw === text} onClick={() => void keep(raw)}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mm-add">
            <PlusIcon aria-hidden="true" />
            <input
              value={adding}
              maxLength={600}
              placeholder={`Something ${name} should remember`}
              aria-label={`Add a note to ${name}'s memory`}
              disabled={text === null || busy}
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && (e.preventDefault(), void add())}
            />
            {adding.trim() && (
              <button type="button" className="mm-btn" disabled={busy} onClick={() => void add()}>
                Add
              </button>
            )}
          </div>
          {notes > 6 && (
            <label className="mm-search">
              <SearchIcon aria-hidden="true" />
              <input value={q} placeholder="Search its memory" aria-label="Search its memory" onChange={(e) => setQ(e.target.value)} />
            </label>
          )}
          {text !== null && !notes ? (
            <div className="mm-empty">
              <p className="mm-empty-title">Nothing remembered yet</p>
              <p>{name} adds what it learns as it works: how you like things, where things are, what didn't work. Add your own above.</p>
            </div>
          ) : (
            <ul className="mm-list">
              {shown.map(({ b, i }) =>
                b.kind === "heading" ? (
                  <li key={i} className="mm-heading">
                    {plain(b.text)}
                  </li>
                ) : b.kind === "other" ? null : (
                  <MemoryNote key={`${i}:${b.raw}`} block={b} editing={editing === i} busy={busy} onEdit={() => setEditing(i)} onDone={() => setEditing(null)} onSave={(t) => put(i, t.trim() ? asNote(t) : null).then((ok) => ok && setEditing(null))} onRemove={() => void put(i, null)} />
                ),
              )}
              {q.trim() && !shown.length && <li className="mm-none">Nothing about “{q.trim()}”.</li>}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function MemoryNote({ block, editing, busy, onEdit, onDone, onSave, onRemove }: { block: Block; editing: boolean; busy: boolean; onEdit: () => void; onDone: () => void; onSave: (t: string) => void; onRemove: () => void }) {
  const [t, setT] = useState(block.text);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) (setT(block.text), requestAnimationFrame(() => box.current?.focus()));
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") (e.preventDefault(), onDone());
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), onSave(t));
  };
  if (editing)
    return (
      <li className="mm-note mm-note-edit">
        <textarea ref={box} value={t} rows={Math.min(6, Math.max(2, Math.ceil(t.length / 48)))} aria-label="The note" onChange={(e) => setT(e.target.value)} onKeyDown={keys} />
        <span className="mm-note-acts">
          <button type="button" className="mm-btn ghost" onClick={onDone}>
            Cancel
          </button>
          <button type="button" className="mm-btn" disabled={busy} onClick={() => onSave(t)}>
            Save
          </button>
        </span>
      </li>
    );
  return (
    <li className="mm-note">
      <button type="button" className="mm-note-text" onClick={onEdit} title="Edit">
        {plain(block.text)}
      </button>
      <span className="mm-note-tools">
        <button type="button" className="mm-icon" aria-label="Edit this note" title="Edit" onClick={onEdit}>
          <PencilIcon aria-hidden="true" />
        </button>
        <button type="button" className="mm-icon" aria-label="Forget this note" title="Forget" disabled={busy} onClick={onRemove}>
          <XIcon aria-hidden="true" />
        </button>
      </span>
    </li>
  );
}
