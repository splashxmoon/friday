import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EngineMark } from "../BrandMarks.js";
import { Icon } from "../icons.js";
import type { Identity } from "../storage.js";
import { useDismiss } from "../ui.js";
import { ENGINE_NAMES, type EngineTool } from "../../types.js";
import { RACE_MAX, RACE_MIN, defaultRacers, racerNames, toggleRacer } from "./race.js";
import { startRace, type RaceBox } from "./race-start.js";
import "./race.css";

// Run later (RunLater.tsx) rides in this chunk: the same box, the same moment it shows, and no chunk of its own in the first load.
export { RunLater } from "./RunLater.js";

/**
 * "Race" beside Send in Code's box (Arun, 2026-11-19, wave 2: "Race the tools: the same ask to two or three coding tools at once,
 * compare, keep the best"): the tools they have signed in, two or three ticked, and the words already in the box go to each, every
 * one in a copy of the folder of its own. What comes back is the race card in the chat (race-column.tsx). The box's other picks come
 * along (race-start.ts RaceBox); what a race cannot carry (attached files, a folder that is not in git) turns it off, with the reason.
 */
export function RaceButton({ identity, ready, current, folder, ask, box, attached = 0, isRepo = true, disabled, onBusy, onStarted }: { identity: Identity; ready: EngineTool[]; current: EngineTool | ""; folder: string; ask: string; box: RaceBox; attached?: number; isRepo?: boolean; disabled?: boolean; onBusy?: (busy: boolean) => void; onStarted: (sid: string, invite: string, tool: EngineTool) => void }) {
  const [open, setOpen] = useState(false);
  const trig = useRef<HTMLButtonElement>(null);
  const [picked, setPicked] = useState<EngineTool[]>(() => defaultRacers(ready, current));
  const touched = useRef(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  // Until they choose, the picks follow what is signed in (the computer answers one tool at a time).
  useEffect(() => {
    if (!touched.current) setPicked(defaultRacers(ready, current));
  }, [ready.join(","), current]); // eslint-disable-line react-hooks/exhaustive-deps

  const enough = ready.length >= RACE_MIN;
  // Words go to each racer; files do not (they would have to be sent to every copy), and a copy is a git worktree.
  const can = enough && picked.length >= RACE_MIN && !!ask.trim() && !busy && !attached && isRepo;
  const why = !enough
    ? "Racing needs two coding tools that are signed in on this computer."
    : !isRepo
      ? "Racing needs the folder to be in git, so each tool can work in a copy of it."
      : attached
        ? "Take the attached files off first: a race sends the words only."
        : !ask.trim()
          ? "Write the ask in the box first: the same words go to each."
          : picked.length < RACE_MIN
            ? "Pick at least two."
            : "";

  const go = async () => {
    if (!can) return;
    setBusy(true);
    // The box is locked while the copies are made, so the same ask cannot also start a chat of its own.
    onBusy?.(true);
    setErr("");
    try {
      const { sid, invite } = await startRace(identity, folder, picked, ask, box, setNote);
      setOpen(false);
      onStarted(sid, invite, picked[0]!);
    } catch (e) {
      setErr((e as Error).message || "The race didn't start.");
    } finally {
      setBusy(false);
      setNote("");
      onBusy?.(false);
    }
  };

  return (
    <>
      <button ref={trig} type="button" className={`race-trig${open ? " on" : ""}`} aria-label="Race the tools" aria-haspopup="dialog" aria-expanded={open} title="Race the tools: send this to two or three coding tools and keep the best" disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <Icon name="zap" size={16} />
      </button>
      {open && <RacePop trig={trig.current} ready={ready} current={current} picked={picked} busy={busy} note={note} err={err} can={can} why={why} onToggle={(t) => ((touched.current = true), setPicked((p) => toggleRacer(p, t)))} onGo={() => void go()} onClose={() => !busy && setOpen(false)} />}
    </>
  );
}

/** The list of tools, over the button: mounted only while open (useDismiss claims the screen once per mount). */
function RacePop({ trig, ready, current, picked, busy, note, err, can, why, onToggle, onGo, onClose }: { trig: HTMLElement | null; ready: EngineTool[]; current: EngineTool | ""; picked: EngineTool[]; busy: boolean; note: string; err: string; can: boolean; why: string; onToggle: (t: EngineTool) => void; onGo: () => void; onClose: () => void }) {
  const pop = useRef<HTMLDivElement>(null);
  useDismiss(pop, onClose, trig);
  const [at, setAt] = useState<{ right: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (!trig) return;
    const r = trig.getBoundingClientRect();
    setAt({ right: Math.max(12, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 8 });
  }, [trig]);
  if (!at) return null;
  return createPortal(
    <div ref={pop} className="race-pop" role="dialog" aria-label="Race the tools" style={{ right: at.right, bottom: at.bottom }}>
      <h3>Race the tools</h3>
      <p>The same ask goes to each, in its own copy of the folder as of your last commit. Compare what comes back and keep the best.</p>
      <ul className="race-pop-list" role="group" aria-label="Tools to race">
        {ready.map((t) => {
          const on = picked.includes(t);
          return (
            <li key={t}>
              <button type="button" role="checkbox" aria-checked={on} className="race-opt" disabled={busy || (!on && picked.length >= RACE_MAX)} onClick={() => onToggle(t)}>
                <span className="box">{on && <Icon name="check" size={11} />}</span>
                <EngineMark tool={t} size={15} />
                <span className="name">{ENGINE_NAMES[t]}</span>
                {t === current && <span className="hint">in the box</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn primary small race-go" disabled={!can} onClick={onGo}>
        {busy ? note || "Starting…" : can ? `Race ${racerNames(picked)}` : "Start the race"}
      </button>
      {(err || why) && <p className="race-why">{err || why}</p>}
    </div>,
    document.body,
  );
}
