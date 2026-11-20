import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EngineMark } from "../BrandMarks.js";
import { Icon } from "../icons.js";
import type { Identity } from "../storage.js";
import { useDismiss } from "../ui.js";
import { preferredAccount } from "../Accounts.js";
import { ENGINE_NAMES, type EngineEffort, type EngineMode, type EngineTool } from "../../types.js";
import { withIssue, withPr, type Issue, type Pr } from "../../github-issue.js";
import { countdown, describeAt, inAnHour, LATER_MAX_AHEAD_LABEL, pickedToUtc, tonightAt, utcToPicked } from "../../later.js";
import { cancelLater, queueLater, runLaterNow, useLater, zoneName, type LaterView } from "./later.js";
import "./later.css";

/**
 * "Run later" beside Send in Code's box (Arun, 2026-11-20: "Tonight from the IDE: queue a task from Code to run overnight (or at a
 * time), with the results waiting in the morning"): Tonight at 1 AM, In 1 hour, or a time picked. The words in the box, the folder, the
 * tool and what it may do are kept with the time (src/later.ts); Friday starts it then as a chat of Code's, if Friday is running, and
 * says so here, plainly. Below the choices, the Later list: what waits, with Cancel, and what was missed, with Run now.
 */
/** What the box holds that a task carries with it, as the box has it: the account picked (or the tool's preferred one), the effort, and an issue or pull request. */
export interface LaterBox {
  account?: string;
  accounts?: Parameters<typeof preferredAccount>[1];
  effort?: EngineEffort | null;
  levels?: readonly EngineEffort[];
  issue?: Issue | null;
  pr?: Pr | null;
}

export function RunLater({ identity, folder, goal, tool, mode, fullAccess, model, box = {}, attached = 0, disabled, onQueued }: { identity: Identity; folder: string; goal: string; tool: EngineTool | ""; mode: EngineMode; fullAccess: boolean; model: string; box?: LaterBox; attached?: number; disabled?: boolean; onQueued: () => void }) {
  const [open, setOpen] = useState(false);
  // The words as a normal send would carry them: with the issue or pull request the box holds, folded in.
  const ask = box.issue ? withIssue(goal, box.issue) : box.pr ? withPr(goal, box.pr) : goal.trim();
  const trig = useRef<HTMLButtonElement>(null);
  // Looked at while the box is shown (the count on the button), and again as the popover opens.
  const { tasks, reload } = useLater(identity, true);
  const waiting = tasks.filter((t) => t.status === "queued").length;
  const attention = tasks.filter((t) => t.status === "missed" || t.status === "failed").length;
  const label = waiting ? `Run later, ${waiting} waiting` : "Run later";
  return (
    <>
      <button ref={trig} type="button" className={`later-trig${open ? " on" : ""}${waiting || attention ? " has" : ""}`} aria-label={label} aria-haspopup="dialog" aria-expanded={open} title={waiting ? `Run later: ${waiting} task${waiting === 1 ? "" : "s"} waiting. Friday has to be open and this computer awake then.` : "Run later: tonight, or at a time. Friday has to be open and this computer awake then."} disabled={disabled} onClick={() => (setOpen((o) => !o), reload())}>
        <Icon name="moon" size={16} />
        {(waiting > 0 || attention > 0) && <span className="later-dot" aria-hidden="true">{waiting || attention}</span>}
      </button>
      {open && <LaterPop trig={trig.current} identity={identity} folder={folder} ask={ask} tool={tool} mode={mode} fullAccess={fullAccess} model={model} box={box} attached={attached} tasks={tasks} reload={reload} onQueued={() => (setOpen(false), onQueued(), reload())} onClose={() => setOpen(false)} />}
    </>
  );
}

function folderName(f: string): string {
  return f.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || f;
}

function LaterPop({ trig, identity, folder, ask, tool, mode, fullAccess, model, box, attached, tasks, reload, onQueued, onClose }: { trig: HTMLElement | null; identity: Identity; folder: string; ask: string; tool: EngineTool | ""; mode: EngineMode; fullAccess: boolean; model: string; box: LaterBox; attached: number; tasks: LaterView[]; reload: () => void; onQueued: () => void; onClose: () => void }) {
  const pop = useRef<HTMLDivElement>(null);
  useDismiss(pop, onClose, trig);
  const [at, setAt] = useState<{ right: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (!trig) return;
    const r = trig.getBoundingClientRect();
    setAt({ right: Math.max(12, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 8 });
  }, [trig]);
  const tz = zoneName();
  const [now] = useState(() => Date.now());
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState(() => utcToPicked(tonightAt(now, tz, 7), tz));
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const why = !folder ? "Open a folder first: a task runs in it." : !tool ? "Pick a coding tool in the box first." : !ask.trim() ? "Write what it should do in the box first." : attached ? "Take the attached files off first: a task sent for later carries the words only." : "";
  const go = async (when: number | null) => {
    if (why || busy) return;
    if (when === null) return setErr("Pick a time.");
    setBusy("queue");
    setErr("");
    try {
      // The account is the one picked, else the tool's preferred one; the tool's own sign-in ("default") sends none.
      const ac = box.account || preferredAccount(tool as EngineTool, box.accounts);
      const account = ac !== "default" && box.accounts?.some((x) => x.id === ac) ? ac : "";
      const effort = box.effort && box.levels?.includes(box.effort) ? box.effort : null;
      await queueLater(identity, {
        folder,
        ask: ask.trim(),
        tool: tool as EngineTool,
        mode,
        fullAccess,
        ...(model ? { model } : {}),
        ...(account ? { account } : {}),
        ...(effort ? { effort } : {}),
        // The issue or pull request the box held links the chat as a normal start's is.
        ...(box.issue ? { issue: { url: box.issue.url, repo: box.issue.repo, number: box.issue.number, title: box.issue.title }, title: `#${box.issue.number} ${box.issue.title}`.trim() } : box.pr ? { pr: { url: box.pr.url, repo: box.pr.repo, number: box.pr.number, title: box.pr.title, head: box.pr.head }, title: `#${box.pr.number} ${box.pr.title}`.trim() } : {}),
        at: when,
      });
      onQueued();
    } catch (e) {
      setErr((e as Error).message || "It couldn't be queued.");
      setBusy("");
    }
  };
  const act = async (id: string, what: "cancel" | "run") => {
    setBusy(id);
    setErr("");
    try {
      await (what === "cancel" ? cancelLater(identity, id) : runLaterNow(identity, id));
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const tonight = tonightAt(now, tz);
  const hour = inAnHour(now);
  const pickedAt = pickedToUtc(picked, tz);
  const pickedWhy = pickedAt === null ? "Pick a date and time." : pickedAt < now + 60_000 ? "Pick a time that hasn't gone by." : pickedAt > now + 31 * 24 * 3600_000 ? `Pick a time ${LATER_MAX_AHEAD_LABEL}.` : "";
  const heed = mode === "edits" ? "Manual: it stops at its first go-ahead and waits for you." : mode === "plan" ? "Plan: it reads and proposes, and changes nothing." : "";
  const list = tasks.filter((t) => t.status !== "running");
  if (!at) return null;
  return createPortal(
    <div ref={pop} className="later-pop" role="dialog" aria-label="Run later" style={{ right: at.right, bottom: at.bottom }}>
      <h3>Run later</h3>
      <p>Friday starts it then as a new chat, in this folder, with this tool. <b>Only if Friday is open and this computer awake at that time</b>: Friday keeps it from idle sleep, but a closed lid still sleeps it, and nothing runs while Friday is closed.</p>
      <ul className="later-opts" aria-label="When">
        <li>
          <button type="button" className="later-opt" disabled={!!why || !!busy} onClick={() => void go(tonight)}>
            <Icon name="moon" size={14} />
            <span className="name">Tonight at 1 AM</span>
            <span className="hint">{countdown(tonight, now)}</span>
          </button>
        </li>
        <li>
          <button type="button" className="later-opt" disabled={!!why || !!busy} onClick={() => void go(hour)}>
            <Icon name="clock" size={14} />
            <span className="name">In 1 hour</span>
            <span className="hint">{describeAt(hour, now, tz)}</span>
          </button>
        </li>
        <li>
          <button type="button" className={`later-opt${picking ? " on" : ""}`} disabled={!!busy} aria-expanded={picking} onClick={() => setPicking((p) => !p)}>
            <Icon name="pencil" size={14} />
            <span className="name">Pick a time…</span>
          </button>
          {picking && (
            <div className="later-pick">
              <input type="datetime-local" aria-label="Date and time" value={picked} onChange={(e) => setPicked(e.target.value)} />
              <button type="button" className="btn primary small" disabled={!!why || !!busy || !!pickedWhy} onClick={() => void go(pickedAt)}>
                {busy === "queue" ? "Queuing…" : "Queue"}
              </button>
              {pickedWhy ? <span className="later-small">{pickedWhy}</span> : <span className="later-small">{describeAt(pickedAt!, now, tz)} · {tz.replace(/_/g, " ")}</span>}
            </div>
          )}
        </li>
      </ul>
      {(err || why) && <p className="later-why">{err || why}</p>}
      {!why && !err && heed && <p className="later-why">{heed}</p>}
      <h4>Later{list.length ? ` · ${list.length}` : ""}</h4>
      {list.length === 0 ? (
        <p className="later-empty">Nothing waiting. What you queue shows here, and starts as a chat in Code's history.</p>
      ) : (
        <ul className="later-list" aria-label="Waiting tasks">
          {list.map((t) => (
            <li key={t.id} className={`later-row${t.status === "queued" ? "" : " bad"}`}>
              <span className="later-mark"><EngineMark tool={t.tool} size={14} /></span>
              <span className="later-main">
                <span className="later-title">{t.title}</span>
                <span className="later-facts">
                  <span className="when">{t.status === "queued" ? describeAt(t.at, now, tz) : t.status === "missed" ? `Missed ${describeAt(t.at, now, tz)}` : t.status === "starting" ? "Starting…" : "Didn't start"}</span>
                  <span>{ENGINE_NAMES[t.tool]} · {folderName(t.folder)}</span>
                </span>
                {t.note && t.status !== "queued" && <span className="later-facts">{t.note}</span>}
              </span>
              <span className="later-acts">
                {t.status !== "queued" && t.status !== "starting" && (
                  <button type="button" className="later-btn" disabled={busy === t.id} title="Start it now" onClick={() => void act(t.id, "run")}>Run now</button>
                )}
                {t.status !== "starting" && (
                  <button type="button" className="later-x" disabled={busy === t.id} aria-label={t.status === "queued" ? `Cancel “${t.title}”` : `Dismiss “${t.title}”`} title={t.status === "queued" ? "Cancel" : "Dismiss"} onClick={() => void act(t.id, "cancel")}>
                    <Icon name="x" size={12} />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body,
  );
}
