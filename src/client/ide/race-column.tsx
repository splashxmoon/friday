import { useRef, useState } from "react";
import { EngineMark } from "../BrandMarks.js";
import { Icon } from "../icons.js";
import { RACE_PREFIX, discardRacer, useRaceRows } from "../Race.js";
import type { Identity } from "../storage.js";
import type { Send } from "../useSession.js";
import { MAIN_LANE, type Member, type SessionEvent } from "../../types.js";
import type { SessionState } from "../../session/projection.js";
import { compareDetail, keptNote, keptShort, raceFacts } from "./race.js";
import "./race.css";

const STATE: Record<string, string> = { idle: "Finished", running: "Working", paused: "Paused", waiting_for_human: "Needs you", error: "Stopped" };

/**
 * A race in Code's column (Arun, 2026-11-19, wave 2: "Race the tools"): Agents' race card is three columns side by side, which a
 * column of 280-640px cannot hold, so each racer is a row here: its tool, its state, what it changed, whether its tests passed,
 * how long it took. Compare opens that racer's own diff in the IDE; Keep brings its changes into the folder and puts every racer's
 * copy away. The racing itself, the scoring and the copies are Race.tsx's.
 */
export function RaceColumn({ state, me, events, identity, sid, send }: { state: SessionState; me: Member; events: SessionEvent[]; identity: Identity; sid: string; invite: string; send: Send }) {
  const { rows, attempts, scored } = useRaceRows(state, events);
  const [busy, setBusy] = useState(false);
  // What came of Keep, said where the race was: it is gone from the column once the copies are, so this has to outlive it.
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const owner = me.role === "owner";
  // The log as it is now, for Keep to read the answer from after it has waited.
  const log = useRef(events);
  log.current = events;
  const working = rows.some((r) => r.run.status === "running");
  const base = state.engines[MAIN_LANE]?.branch;
  const nameOf = (r: (typeof rows)[number]) => r.name.slice(RACE_PREFIX.length);
  const toolName = (r: (typeof rows)[number]) => nameOf(r).replace(/^[A-Z] · /, "");

  const discard = (lane: string) => discardRacer(identity, sid, send, state.engines[lane]?.cwd, lane);

  /** Keep: the racer's changes go into the folder first (nothing is lost if that fails), then every copy is put away. */
  const keep = async (lane: string) => {
    const r = rows.find((x) => x.id === lane);
    if (!r) return;
    setBusy(true);
    setNote(null);
    try {
      const before = log.current.at(-1)?.seq ?? 0;
      const done = await send({ type: "folder.apply", lane });
      // Nothing new is a copy whose changes are in the folder already (brought over from the IDE, say): what Keep is for is done.
      const already = !done.ok && /nothing new to bring over/i.test(done.error ?? "");
      if (!done.ok && !already) {
        setNote({ text: done.error || "Couldn't bring the changes into the folder.", bad: true });
        return;
      }
      // What it brought over is in the log a moment after the answer: files and any conflicts, as the folder has them.
      let applied: SessionEvent | undefined;
      for (let i = 0; i < 15 && !applied && !already; i++) {
        applied = log.current.find((e) => e.seq > before && e.body.type === "folder.applied");
        if (!applied) await new Promise((res) => setTimeout(res, 100));
      }
      const body = applied?.body.type === "folder.applied" ? applied.body : null;
      const files = body?.files ?? r.files.length;
      const conflicts = body?.conflicts?.length ?? 0;
      await Promise.all(rows.map((x) => discard(x.id)));
      // The log says what came over ("You brought 1 file into app"); this says what that line does not: which tool, and that the rest
      // are gone. Without that line (or with conflicts to settle) it says the count itself.
      setNote({ text: body && !conflicts ? keptShort(toolName(r)) : already ? keptShort(toolName(r)) : keptNote(toolName(r), files, conflicts) });
    } finally {
      setBusy(false);
    }
  };

  /** Compare: the IDE opens that racer's checkout. The window event is answered by the IDE's page (VsCodeView.tsx); with none listening, or the IDE refusing, the card says so. */
  const compare = (cwd: string, tool: string) => {
    setNote(null);
    const detail = { ...compareDetail(cwd, base, tool), handled: false, failed: (why: string) => setNote({ text: why, bad: true }) };
    window.dispatchEvent(new CustomEvent("friday:vsc-review", { detail }));
    if (!detail.handled) setNote({ text: "Friday IDE isn't open, so there is nothing to compare in. Open it, then try again.", bad: true });
  };

  const end = async () => {
    setBusy(true);
    try {
      await Promise.all(rows.map((r) => discard(r.id)));
      // Whatever was brought over from a copy by hand stays: the note says only what this did.
      setNote({ text: "Race ended. The copies are gone." });
    } finally {
      setBusy(false);
    }
  };

  if (rows.length < 2) {
    return note ? (
      <div className={`rcol-note${note.bad ? " bad" : ""}`} role="status">
        <Icon name={note.bad ? "x" : "check"} size={13} />
        <span>{note.text}</span>
        <button type="button" className="rcol-note-x" aria-label="Dismiss" onClick={() => setNote(null)}>
          <Icon name="x" size={11} />
        </button>
      </div>
    ) : null;
  }

  return (
    <section className="rcol" aria-label="Race">
      <header className="rcol-head">
        <span className="rcol-title">
          <Icon name="zap" size={13} /> Race
        </span>
        <span className="rcol-sub">{working ? `${rows.length} tools, one ask` : "All finished. Compare, then keep one."}</span>
        {owner && (
          <button type="button" className="rcol-end" disabled={busy} onClick={() => void end()} title="Throw every copy away and leave the folder as it was">
            End race
          </button>
        )}
      </header>
      {note?.bad && (
        <div className="rcol-note bad" role="alert">
          <Icon name="x" size={13} />
          <span>{note.text}</span>
        </div>
      )}
      <ul className="rcol-rows">
        {rows.map((r) => {
          const a = attempts?.find((x) => x.id === r.id);
          const running = r.run.status === "running";
          const bad = r.receipt.flags.some((f) => f.level === "bad");
          const leans = scored?.lean === r.id;
          const facts = raceFacts({ files: r.files.length, added: r.files.reduce((n, f) => n + f.additions, 0), removed: r.files.reduce((n, f) => n + f.deletions, 0), tests: r.receipt.tests, seconds: a?.seconds ?? 0, tokens: a?.tokens ?? null, working: running });
          const cwd = state.engines[r.id]?.cwd;
          const tool = state.engines[r.id]?.tool ?? "";
          return (
            <li key={r.id} className={`rcol-row${leans ? " lean" : ""}${bad ? " bad" : ""}`}>
              <div className="rcol-who">
                <span className="rcol-mark" aria-hidden="true">
                  <EngineMark tool={tool} size={14} />
                </span>
                <b className="rcol-name" title={nameOf(r)}>
                  {toolName(r)}
                </b>
                {leans ? (
                  <span className="rcol-chip lean">
                    <Icon name="check" size={10} /> Leans this way
                  </span>
                ) : (
                  <span className={`rcol-chip ${r.run.status}`}>{running && <i className="rcol-dot" />}{STATE[r.run.status] ?? r.run.status}</span>
                )}
              </div>
              <div className="rcol-facts">
                {facts.map((f, i) => (
                  <span key={i} className={f === "Tests passed" ? "ok" : f === "Tests failed" ? "bad" : ""}>
                    {f}
                  </span>
                ))}
              </div>
              {r.receipt.flags.filter((f) => f.level === "bad").map((f) => (
                <div key={f.text} className="rcol-flag">
                  <Icon name="x" size={12} /> {f.text}
                </div>
              ))}
              <div className="rcol-acts">
                <button
                  type="button"
                  className="rcol-btn"
                  disabled={!cwd || !r.files.length}
                  title={r.files.length ? `Open ${toolName(r)}'s changes in the IDE's own diff` : "Nothing changed yet"}
                  onClick={() => compare(cwd!, toolName(r))}
                >
                  <Icon name="columns" size={13} /> Compare
                </button>
                <button
                  type="button"
                  className="rcol-btn primary"
                  disabled={!owner || busy || running || !r.files.length}
                  title={!owner ? "Only an owner can choose" : running ? "Let it finish first" : !r.files.length ? "It changed nothing, so there is nothing to keep" : `Bring ${toolName(r)}'s changes into the folder and throw the others away`}
                  onClick={() => void keep(r.id)}
                >
                  <Icon name="check" size={13} /> {bad ? "Keep anyway" : "Keep"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {scored && !working && <p className={`rcol-verdict${scored.lean ? " leans" : ""}`}>{scored.why}</p>}
    </section>
  );
}
