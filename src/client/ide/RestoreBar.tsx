import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import type { Identity } from "../storage.js";
import type { AskLane } from "../Activity.js";
import { ENGINE_NAMES, type EngineTool } from "../../types.js";
import { CARRY_ON_TEXT, type CutOff } from "../../ide-restore.js";
import { showCodeChat, type CodeChat } from "./code-chats.js";
import "./restore.css";

/**
 * A coding tool that was at work when Friday closed (Arun, 2026-11-19, wave 4: "Claude Code was working on X when Friday closed ·
 * Carry on / Leave it"): a slim bar over the column's chat. The server says which of Code's chats were cut off (/api/vscode/tasks,
 * `cut`, read from the session by ide-restore.ts); "Carry on" sends the tool a message to finish what it was doing, "Leave it" lets
 * it be, and the bar is not shown for that run again. Of several cut off in the folder, the one on screen is offered first.
 */
const LEFT = "friday.code.left";

/** The runs left alone, by session and the seq of the run's end: kept, so "Leave it" holds through the next launch. */
type Left = Record<string, number>;
function readLeft(): Left {
  try {
    return JSON.parse(localStorage.getItem(LEFT) || "{}") as Left;
  } catch {
    return {};
  }
}
const isLeft = (all: Left, sid: string, cut: CutOff): boolean => all[sid] === cut.sinceSeq;
function leave(sid: string, cut: CutOff) {
  const all = { ...readLeft(), [sid]: cut.sinceSeq };
  const keep = Object.fromEntries(Object.entries(all).slice(-100));
  try {
    localStorage.setItem(LEFT, JSON.stringify(keep));
  } catch {
    // A preference: the bar comes back next launch.
  }
}

export function RestoreBar({ identity, tabs, shown, toolOf }: { identity: Identity | null; tabs: CodeChat[]; shown: string | undefined; toolOf: (c: CodeChat) => string }) {
  const [cuts, setCuts] = useState<Record<string, CutOff>>({});
  const [left, setLeft] = useState(readLeft);
  const [note, setNote] = useState<{ sid: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ids = tabs.map((t) => t.sid).join(",");
  // Looked at once the column is up, and again for a while: the reap that marks a run cut off waits out the old server's lease.
  const looks = useRef(0);
  useEffect(() => {
    if (!identity || !ids) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    let seen = false;
    const look = async () => {
      try {
        const r = await api<{ tasks: { sid: string; cut?: CutOff }[] }>(identity, "/api/vscode/tasks");
        if (stop) return;
        const next: Record<string, CutOff> = {};
        for (const x of r.tasks) if (x.cut) next[x.sid] = x.cut;
        setCuts((p) => (JSON.stringify(p) === JSON.stringify(next) ? p : next));
        seen = Object.keys(next).length > 0;
      } catch {
        // A moment away: what is shown stands.
      }
      // Every few seconds for the first minute (the reap that marks a run cut off waits out the old server's lease), then only while
      // something is cut off (another window may answer it). With nothing cut once the launch is over, it stops asking.
      if (!stop && (seen || looks.current < 12)) t = setTimeout(look, ++looks.current < 12 ? 5000 : 20000);
    };
    void look();
    return () => ((stop = true), clearTimeout(t));
  }, [identity, ids]);

  const mine = tabs.filter((c) => cuts[c.sid] && !isLeft(left, c.sid, cuts[c.sid]!));
  const chat = mine.find((c) => c.sid === shown) ?? mine[0];
  if (!chat) return note && tabs.some((c) => c.sid === note.sid) ? <div className="rb" role="status"><span className="rb-text">{note.text}</span></div> : null;
  const cut = cuts[chat.sid]!;
  const tool = toolOf(chat) as EngineTool | "";
  const who = tool ? ENGINE_NAMES[tool] : "An agent";
  const what = (chat.title || "Untitled").replace(/\s+/g, " ").trim();
  const more = mine.length - 1;

  // The chat is shown first (its session screen is the one that takes the message), and the event tried again for a few seconds:
  // its screen may not be drawn yet (the column is lazy).
  const toSession = (kind: string, detail: Record<string, unknown> & { handled?: boolean }, done: (r: { ok: boolean; error?: string }) => void) => {
    if (chat.sid !== shown) showCodeChat(chat.folder, chat.sid);
    let tries = 0;
    const send = () => {
      window.dispatchEvent(new CustomEvent(kind, { detail }));
      if (!detail.handled && ++tries < 30) setTimeout(send, 200);
      else if (!detail.handled) done({ ok: false, error: "Open the chat to do that" });
    };
    send();
  };
  const finish = (r: { ok: boolean; error?: string }) => {
    setBusy(null);
    if (r.ok) (leave(chat.sid, cut), setLeft(readLeft()));
    else setNote({ sid: chat.sid, text: r.error || "That didn't work" });
  };

  const carryOn = () => {
    setBusy(chat.sid);
    setNote(null);
    // The turn the close cut is already back in the tool's queue and runs when the tool is: Carry on only brings the tool back. Sent a
    // message as well, it did the turn again from the top and was told to carry on behind it (review, 2026-11-19). A cut with nothing
    // queued has nothing to resume by itself, so it is told.
    if (cut.queued > 0) {
      toSession("friday:reconnect-lane", { sid: chat.sid, lane: cut.lane, reply: finish }, finish);
      return;
    }
    const ask: AskLane = { lane: cut.lane, sid: chat.sid, text: CARRY_ON_TEXT, reply: finish };
    toSession("friday:ask-lane", ask as unknown as Record<string, unknown> & { handled?: boolean }, finish);
  };
  // Really leaves it: the cut run is cancelled, which empties its queue, so the turn is not given to the tool when it is next back.
  const leaveIt = () => {
    setBusy(chat.sid);
    setNote(null);
    toSession("friday:stop-lane", { sid: chat.sid, lane: cut.lane, reply: finish } as Record<string, unknown> & { handled?: boolean }, finish);
  };

  return (
    <div className="rb" role="group" aria-label="Work cut off when Friday closed">
      <span className="rb-dot" aria-hidden="true" />
      <span className="rb-text" title={`${who} was working on “${what}” when Friday closed`}>
        <b>{who}</b> was working on <span className="rb-what">{what}</span> when Friday closed
        {more > 0 && <span className="rb-more" title="More chats here were cut off too"> · +{more} more</span>}
      </span>
      <span className="rb-acts">
        <button type="button" className="rb-btn rb-go" disabled={busy === chat.sid} onClick={carryOn}>{busy === chat.sid ? "Sending…" : "Carry on"}</button>
        <button type="button" className="rb-btn" disabled={busy === chat.sid} onClick={leaveIt}>Leave it</button>
      </span>
    </div>
  );
}
