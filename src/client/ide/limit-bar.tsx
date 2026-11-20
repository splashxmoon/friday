import { useEffect, useState } from "react";
import type { LimitBar as Bar } from "../../ide-routing.js";
import type { TaskRouting } from "../../ide-routing-task.js";
import { api } from "../api.js";
import type { Identity } from "../storage.js";
import { handOnAsk } from "./hand-on.js";
import "./restore.css";
import "./routing.css";

/**
 * The slim bar over a running Code chat when its tool is heading for its limit (Arun, 2026-11-20, wave 5: "Claude Code may hit its
 * limit in ~20 min · Hand on to Codex now / Later"), and the line once it did run out and Friday handed the work on. What to say is
 * the server's (/api/vscode/tasks, ide-routing-task.ts, read from the session and the plan's burn rate); a press on Hand on goes to
 * the chat's screen as friday:hand-on (hand-on.ts). Later puts the bar away for twenty minutes, and it comes back if the limit is
 * still near.
 */
const LATER = "friday.code.later";
const LATER_MS = 20 * 60_000;

type Row = TaskRouting & { sid: string };
type Later = Record<string, number>;
function readLater(): Later {
  try {
    return JSON.parse(localStorage.getItem(LATER) || "{}") as Later;
  } catch {
    return {};
  }
}
function putLater(sid: string, until: number) {
  const all = Object.fromEntries(Object.entries({ ...readLater(), [sid]: until }).filter(([, t]) => t > Date.now()).slice(-50));
  try {
    localStorage.setItem(LATER, JSON.stringify(all));
  } catch {
    // The bar comes back at the next look.
  }
}
/** The "carried on" lines already read, so each shows once. */
const SEEN = "friday.code.handedSeen";
function seen(sid: string): number {
  try {
    return (JSON.parse(localStorage.getItem(SEEN) || "{}") as Record<string, number>)[sid] ?? 0;
  } catch {
    return 0;
  }
}
function markSeen(sid: string, seq: number) {
  try {
    const all = { ...(JSON.parse(localStorage.getItem(SEEN) || "{}") as Record<string, number>), [sid]: seq };
    localStorage.setItem(SEEN, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-100))));
  } catch {
    // Shown again next launch.
  }
}

export default function LimitBar({ identity, sid }: { identity: Identity | null; sid: string | null }) {
  const [row, setRow] = useState<Row | null>(null);
  const [later, setLater] = useState<Later>(readLater);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [gone, setGone] = useState(0);
  // The tool that took the work, once it has: the bar is not the question any more, only the answer, until the next look.
  const [handed, setHanded] = useState("");
  // Looked at while a chat is shown: often enough that a prediction is in the column before the limit, not so often it costs.
  useEffect(() => {
    setRow(null);
    setNote("");
    setBusy(false);
    setHanded("");
    if (!identity || !sid) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      try {
        // Only this chat's routing is asked for (?sid=): the list without it carries the tool's window and nothing read from a log.
        const r = await api<{ tasks: Row[] }>(identity, `/api/vscode/tasks?sid=${encodeURIComponent(sid)}`);
        if (stop) return;
        const mine = r.tasks.find((x) => x.sid === sid) ?? null;
        setRow((p) => (JSON.stringify(p) === JSON.stringify(mine) ? p : mine));
      } catch {
        // A moment away: what is shown stands.
      }
      if (!stop) t = setTimeout(look, 15_000);
    };
    void look();
    return () => ((stop = true), clearTimeout(t));
  }, [identity, sid]);

  if (!sid || !row) return note ? <div className="rb" role="status"><span className="rb-text">{note}</span></div> : null;
  if (row.handed && row.handed.seq > Math.max(seen(sid), gone)) {
    const h = row.handed;
    return (
      <div className="rb rt-bar" role="status">
        <i className="rb-dot rt-bar-dot" aria-hidden />
        <span className="rb-text">{h.text}</span>
        <span className="rb-acts">
          <button type="button" className="rb-btn" onClick={() => (markSeen(sid, h.seq), setGone(h.seq))}>Got it</button>
        </span>
      </div>
    );
  }
  if (handed)
    return (
      <div className="rb rt-bar" role="status" aria-label="Usage limit">
        <i className="rb-dot rt-bar-dot" aria-hidden />
        <span className="rb-text">{`Handed on to ${handed}.`}</span>
      </div>
    );
  const bar: Bar | undefined = row.bar;
  if (!bar || !row.lane || (later[sid] ?? 0) > Date.now()) return note ? <div className="rb" role="status"><span className="rb-text">{note}</span></div> : null;
  const [first, ...rest] = bar.to;
  const handOn = (to: Bar["to"][number]) => {
    setBusy(true);
    setNote("");
    const taken = handOnAsk({
      sid,
      from: row.lane!,
      tool: to.tool,
      ...(to.lane ? { to: to.lane } : {}),
      reply: (r) => {
        setBusy(false);
        if (r.ok) (setHanded(to.name), setTimeout(() => setHanded(""), 15_000));
        else setNote(r.error || `Couldn't hand that to ${to.name}.`);
      },
    });
    if (!taken) {
      setBusy(false);
      setNote("Open the chat to hand it on.");
    }
  };
  return (
    <div className="rb rt-bar" role="status" aria-label="Usage limit">
      <i className="rb-dot rt-bar-dot" aria-hidden />
      <span className="rb-text" title={bar.out ? bar.full : `${bar.full} (${bar.used}% of its ${bar.window} used)`}>{bar.text}</span>
      {note && <span className="rb-text rt-note" role="alert">{note}</span>}
      <span className="rb-acts">
        {first && (
          <button type="button" className="rb-btn rb-go" disabled={busy} title={`Stop ${bar.name} here and give the work to ${first.name}, with everything done so far`} onClick={() => handOn(first)}>
            {busy ? "Handing on…" : bar.out ? `Hand on to ${first.name}` : `Hand on to ${first.name} now`}
          </button>
        )}
        {rest[0] && (
          <button type="button" className="rb-btn" disabled={busy} title={`Give the work to ${rest[0].name} instead`} onClick={() => handOn(rest[0]!)}>
            {`or ${rest[0].name}`}
          </button>
        )}
        <button type="button" className="rb-btn" disabled={busy} title="Ask again in twenty minutes" onClick={() => (putLater(sid, Date.now() + LATER_MS), setLater(readLater()))}>Later</button>
      </span>
    </div>
  );
}
