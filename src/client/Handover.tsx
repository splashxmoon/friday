import { useMemo, useRef, useState } from "react";
import { leftOff, type LeftOffSection, type RichItem } from "../left-off.js";
import type { SessionState } from "../session/projection.js";
import type { SessionEvent } from "../types.js";
import { isLocal } from "./edition.js";
import { Icon } from "./icons.js";
import { useDismiss } from "./ui.js";
import type { Send } from "./useSession.js";

/**
 * "Where we left off", laid out to be glanced at.
 *
 * Three tiers, top to bottom: how things stand (one line, a tone, a few numbers), the one thing to do first, then the
 * facts in short labelled blocks side by side — where each agent is beside what changed, the task beside who is here —
 * so a person picking the session up finds what they are asking for without reading everything above it.
 *
 * It is read out of the session's log, so it is there at once and the same for everybody. It can be copied to wherever
 * the next person is, or kept with the session, where the agent has it among what it has saved and the next run starts
 * from it.
 */

/** The order the blocks are read in. "Start with" is the callout, not a block. */
const ORDER = ["Still open", "Where it stands", "What changed", "Decided along the way", "The task", "People"];
/** Blocks that stand alone on their line; the rest pair up. */
const FULL = new Set(["Still open", "Decided along the way", "The task"]);
const ICON: Record<string, "hand" | "play" | "gitBranch" | "check" | "message" | "users"> = {
  "Still open": "hand",
  "Where it stands": "play",
  "What changed": "gitBranch",
  "Decided along the way": "check",
  "The task": "message",
  People: "users",
};

/** A section's lines: the structured ones where there are some, otherwise the plain text. */
const rows = (c: LeftOffSection): RichItem[] => c.rich ?? c.items.map((title) => ({ title }));

export function HandoverDialog({ state, events, send, canSave, onClose }: { state: SessionState; events: SessionEvent[]; send: Send; canSave: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const note = useMemo(() => leftOff(state, events), [state, events]);
  const kept = state.memory.find((m) => m.key === "left-off");
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<"saving" | "saved" | "">("");
  const [err, setErr] = useState("");
  const [kept2, setKept2] = useState<"" | "saving" | "saved">("");
  /** This session as a starting point: its first ask, the agent it ran, and the commands allowed in advance. */
  const saveTemplate = async () => {
    const ask = events.find((e) => e.body.type === "instruction" && e.actor.kind === "human" && !e.body.text.startsWith("[session]"));
    if (!ask || ask.body.type !== "instruction") return setErr("Nothing was asked in this session yet.");
    setKept2("saving");
    try {
      const r = await fetch("/api/templates", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: state.title.slice(0, 40), prompt: ask.body.text, agentId: state.options.agent?.id, allow: state.options.allow ?? [] }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't save it.");
      setKept2("saved");
    } catch (e) {
      setKept2("");
      setErr((e as Error).message);
    }
  };
  const sections = ORDER.map((label) => note.sections.find((s) => s.label === label)).filter((s): s is LeftOffSection => !!s);
  const start = note.sections.find((s) => s.label === "Start with");
  // Two short blocks share a row; a short block with no partner beside it takes the row, rather than leaving half of it empty.
  const spans: ("full" | "half")[] = sections.map(() => "full");
  let waiting = -1;
  sections.forEach((c, i) => {
    if (FULL.has(c.label)) return void (waiting = -1);
    if (waiting >= 0) (spans[waiting] = "half"), (spans[i] = "half"), (waiting = -1);
    else waiting = i;
  });
  const empty = note.status.tone === "empty" && sections.length === 0 && !start;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(note.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setErr("Couldn't reach the clipboard.");
    }
  };
  const save = async () => {
    setSaved("saving");
    const r = await send({ type: "handover.save", text: note.markdown, quiet: true });
    if (!r.ok) {
      setSaved("");
      return setErr(r.error ?? "Couldn't save that. Try again.");
    }
    setSaved("saved");
  };

  return (
    <div className="overlay">
      <div className="modal handover" role="dialog" aria-modal="true" aria-label="Where we left off" ref={ref}>
        <header className="ho-head">
          <div className="ho-head-text">
            <h2>Where we left off</h2>
            <p className="ho-sub" title={note.title}>
              {note.title}
            </p>
          </div>
          <button type="button" className="icon-btn tiny" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </header>

        <div className="ho-scroll">
          {empty ? (
            <p className="ho-empty">Nothing has happened in this session yet. Once an agent starts working, this fills in.</p>
          ) : (
            <>
              {/* Tier one: how things stand, in one look. The dot carries the tone; the words carry the fact. */}
              <div className={`ho-status tone-${note.status.tone}`}>
                <span className="ho-status-dot" aria-hidden="true" />
                <div className="ho-status-text">
                  <b>{note.status.line}</b>
                  {note.status.stats.length > 0 && (
                    <ul className="ho-stats" aria-label="At a glance">
                      {note.status.stats.map((x) => (
                        <li key={x.label}>
                          <span className="ho-stat-n">{x.value}</span> {x.label}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {/* Tier two: the one thing to do first. */}
              {start && (
                <section className="ho-next" aria-label="Start with">
                  <span className="ho-next-mark" aria-hidden="true">
                    <Icon name="arrowRight" size={14} />
                  </span>
                  <div className="ho-next-text">
                    <span className="ho-label">Start with</span>
                    {rows(start).map((it, i) => (
                      <p key={i}>
                        {it.title}
                        {it.sub && <span className="ho-item-sub">{it.sub}</span>}
                      </p>
                    ))}
                  </div>
                </section>
              )}

              {/* Tier three: the facts, in blocks that sit beside each other where they are short. */}
              <div className="ho-grid">
                {sections.map((c, i) => (
                  <section key={c.label} className={`ho-block ${spans[i] === "full" ? "full" : ""}`}>
                    <h3 className="ho-label">
                      <Icon name={ICON[c.label] ?? "list"} size={12} />
                      {c.label}
                      {/* How many rows the block holds, so a long one can be judged before it is scrolled. */}
                      {(c.label === "What changed" || c.label === "Where it stands") && rows(c).filter((r) => c.label !== "What changed" || r.file).length > 1 && (
                        <span className="ho-count">{rows(c).filter((r) => c.label !== "What changed" || r.file).length}</span>
                      )}
                    </h3>
                    <ul className={c.label === "What changed" || c.label === "Where it stands" ? "ho-scroll" : ""}>
                      {rows(c).map((it, i) =>
                        it.file ? (
                          // A file: the path with its name standing out, and the numbers in colour at the end.
                          <li key={i} className={`ho-file ${it.tone ? `tone-${it.tone}` : ""}`} title={it.title}>
                            <span className="ho-file-path">
                              {it.title.includes("/") && <span className="ho-file-dir">{it.title.slice(0, it.title.lastIndexOf("/") + 1)}</span>}
                              <b>{it.title.slice(it.title.lastIndexOf("/") + 1)}</b>
                            </span>
                            <span className="ho-file-nums">
                              {it.file.status === "new" && <span className="ho-file-tag new">new</span>}
                              {it.file.status === "deleted" && <span className="ho-file-tag gone">deleted</span>}
                              {it.file.add > 0 && <span className="diff-add">+{it.file.add}</span>}
                              {it.file.del > 0 && <span className="diff-del">−{it.file.del}</span>}
                            </span>
                          </li>
                        ) : (
                          <li key={i} className={it.tone ? `tone-${it.tone}` : ""}>
                            <span className="ho-item-title">{it.title}</span>
                            {it.sub && <span className="ho-item-sub">{it.sub}</span>}
                          </li>
                        ),
                      )}
                    </ul>
                  </section>
                ))}
              </div>
            </>
          )}
        </div>

        {err && (
          <p role="alert" className="cmds-err ho-err">
            {err}
          </p>
        )}
        <footer className="ho-foot">
          <span className="ho-state">{saved === "saved" ? "Kept with the session. The agent starts from it." : kept && !saved ? "An earlier note is kept with this session." : "Written from the session's log."}</span>
          {!isLocal() && (
            <button type="button" className="btn ghost small" title="Keep this session's first ask, its agent and its allowed commands as a one-press start on the new-session page" disabled={kept2 === "saving"} onClick={() => void saveTemplate()}>
              {kept2 === "saved" ? "Saved as a starting point" : "Save as a starting point"}
            </button>
          )}
          <button type="button" className="btn ghost small" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy as text"}
          </button>
          {canSave && (
            <button type="button" className="btn primary small" disabled={saved === "saving" || empty} title="The agent reads it at the start of its next run" onClick={() => void save()}>
              Keep with the session
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
