// "Keep this going" in the app (Code and Crew, connected, ported to the open-source edition from Friday Teams e4d637ea, 1584f368,
// 773e15e7, 75d5712d, 7afa7b97, f0721afd, b3c206f2, cd68a6b5, 1452f28c and d9efb667, keep-going.tsx): the one line the session
// keeps for a hand-off to a crew mate or a crew room. Loaded with the first such line (Activity.tsx); what "@" in the box offers
// and the run's action are in crew-at.tsx, what opens the sheet in crew-carry-open.tsx, the sheet in CrewCarrySheet.tsx.
import { useEffect, useState } from "react";
import { kgPath, openBring } from "./crew-carry-open.js";
import { carryReq as workReq } from "./crew-carry-req.js";
import { handedLive, handedSub, progressLine, resultLine } from "../crew-carry-rules.js";
import type { Handed, SessionState } from "../session/projection.js";
import type { SessionEvent } from "../types.js";
import { Avatar, Icon } from "./icons.js";
import { Face, useTeamNow } from "./Teammates.js";
import { roomsOut } from "./crew-at.js";
import { loadRecents } from "./storage.js";
import "./crew-carry.css";

const notice = (text: string) => dispatchEvent(new CustomEvent("friday:notice", { detail: text }));
const first = (n: string) => n.split(/\s+/)[0] || n;

type RoomNow = { state: "working" | "waiting" | "done" | "stopped" | "queued" | "unknown"; line: string; said: string; working: string[]; at: number | null; crew?: { name: string; look?: string; working: boolean; lead: boolean }[] };

/**
 * What this session handed to the crew, in the agent status's list (StatusBar.tsx): each crew mate's job and each room, how it
 * stands, and a press to open it (Arun, 2026-11-13: "show the current agents working in the coding session, plus any work that was
 * handed off in a crew or crew room"). Loaded when that list first opens.
 */
export function HandedRows({ state, events, onPick }: { state: SessionState; events: readonly SessionEvent[]; onPick: () => void }) {
  const invite = loadRecents().find((r) => r.sid === state.id)?.invite ?? "";
  const jobs = Object.values(state.handed ?? {}).sort((a, b) => b.at - a.at).slice(0, 6);
  const rooms = roomsOut(events).slice(0, 4);
  const [now, setNow] = useState<Record<string, RoomNow>>({});
  useEffect(() => {
    if (!invite) return;
    let live = true;
    for (const r of rooms) void workReq<RoomNow>(kgPath(state.id, invite, "", `&roomStatus=${encodeURIComponent(r.body.room)}`)).then((x) => live && setNow((n) => ({ ...n, [r.body.room]: x })), () => {});
    return () => void (live = false);
  }, [state.id, invite, rooms.map((r) => r.body.room).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!jobs.length && !rooms.length) return null;
  const openJob = (job: string) => void workReq<{ sid: string; invite: string }>(kgPath(state.id, invite, `/${job}`)).then((o) => dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: o.sid, invite: o.invite } })), (e: Error) => notice(e.message));
  const openRoom = (room: string) => void workReq<{ sid: string; invite: string }>(kgPath(state.id, invite, "", `&room=${encodeURIComponent(room)}`)).then((o) => dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: o.sid, invite: o.invite } })), (e: Error) => notice(e.message));
  return (
    <>
      <p className="stb-pop-head">With the crew</p>
      <ul className="stb-pop-list">
        {jobs.map((h) => (
          <li key={h.job}>
            <button type="button" className="stb-pop-row" onClick={() => (onPick(), openJob(h.job))}>
              <span className="stb-pop-mark">
                <Avatar name={h.mateName} id={h.mate} size={16} />
              </span>
              <span className="stb-pop-main">
                <span className="stb-pop-name">{h.mateName}</span>
              </span>
              <span className="stb-pop-word">{progressLine(h, Date.now()).replace(new RegExp(`^${h.mateName}\\s+`), "")}</span>
            </button>
          </li>
        ))}
        {rooms.map((r) => (
          <li key={r.body.room}>
            <button type="button" className="stb-pop-row" onClick={() => (onPick(), openRoom(r.body.room))}>
              <span className="stb-pop-mark">
                <Icon name="users" size={13} />
              </span>
              <span className="stb-pop-main">
                <span className="stb-pop-name">{r.body.roomName}</span>
              </span>
              <span className="stb-pop-word">{now[r.body.room]?.line ?? "Open the room"}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * "You handed this to the room Payments": said once, then kept up under it (Arun, 2026-11-13: "add status update on the handed
 * this to the room ... like who was working, status on whether it is done or not"): who in the room is working now, and whether
 * the work it was handed is done, read every 20 seconds until it is. With a way into the room for someone in it.
 */
export function RoomHandedLine({ by, me, roomName, room, to, carried, sid, invite, stamp, brought = false }: { by: { id: string; name: string }; me: string; roomName: string; room: string; to: string; carried: string[]; sid: string; invite: string; stamp: React.ReactNode; /** Its work already brought in here. */ brought?: boolean }) {
  const [now, setNow] = useState<RoomNow | null>(null);
  const settled = now?.state === "done" || now?.state === "stopped" || now?.state === "unknown";
  useEffect(() => {
    if (settled) return;
    let live = true;
    // A read that fails settles too: "Checking the room…" must never be the last word.
    const read = () => void workReq<RoomNow>(kgPath(sid, invite, "", `&roomStatus=${encodeURIComponent(room)}`)).then((r) => live && setNow(r), () => live && setNow((n) => n ?? { state: "unknown", line: "Open the room to see how it stands", said: "", working: [], at: null }));
    read();
    const t = setInterval(read, 20_000);
    return () => ((live = false), clearInterval(t));
  }, [sid, invite, room, settled]);
  const go = () =>
    void workReq<{ sid: string; name: string; invite: string }>(kgPath(sid, invite, "", `&room=${encodeURIComponent(room)}`)).then(
      (o) => dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: o.sid, invite: o.invite } })),
      (e: Error) => notice(e.message),
    );
  const live = now?.state === "working" || now?.state === "waiting";
  const crew = now?.crew ?? [];
  const lead = crew.find((c) => c.lead) ?? crew[0];
  // Its crew as faces, the one it went to first (Arun, 2026-11-13: "design this better, like show the crew mascots and fix spacing"):
  // who took it, how it stands as a chip, what came back on one line, and what to do with it under that.
  return (
    <div className="kg-line kg-room" data-state={now?.state === "working" ? "running" : now?.state === "waiting" ? "input" : now?.state} title={[`${first(to)} takes it there`, ...carried].join(" · ")}>
      <div className="kg-room-face" aria-hidden="true">
        {lead ? <Face seed={lead.look ?? lead.name} size={30} status={lead.working ? "working" : "idle"} /> : <Icon name="users" size={16} />}
      </div>
      <div className="kg-room-main">
        <div className="kg-room-top">
          <span className="kg-said">
            {by.id === me ? "You" : first(by.name)} handed this to <b>{roomName}</b>
          </span>
          <span className="kg-stamp">{stamp}</span>
        </div>
        <div className="kg-room-meta">
          <span className="kg-room-chip" data-state={now?.state ?? "unknown"} role="status">
            {(live || now?.state === "queued") && <i aria-hidden="true" />}
            {now ? now.line : "Checking…"}
          </span>
          {crew.length > 1 && (
            <span className="kg-room-crew" title={crew.map((c) => `${c.name}${c.working ? " (working)" : ""}`).join(", ")}>
              {crew.slice(0, 5).map((c) => (
                <span key={c.name} className="kg-room-crew-face" data-working={c.working || undefined}>
                  <Face seed={c.look ?? c.name} size={18} />
                </span>
              ))}
            </span>
          )}
        </div>
        {(now?.state === "done" || now?.state === "stopped") && now.said && (
          <p className="kg-room-said" title={now.said}>
            {now.said}
          </p>
        )}
        {/* On the right, the way in first and the main thing last (Arun, 2026-11-13). */}
        <div className="kg-room-acts">
          <button type="button" className="kg-link" onClick={go}>
            Open room
          </button>
          {brought && <span className="kg-room-brought">Brought in</span>}
          {now?.state === "done" && !brought && (
            <button type="button" className="kg-bring" onClick={() => openBring({ sid, invite, from: `room:${room}`, name: roomName })}>
              Bring it in
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── The session's line ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * "Ada handed this to Kit": said once, then the one line under it keeps up with the job (working, x of y done, how long), and its
 * result comes back here when it is done. Stop (or Take back, for its person) is a tap from this line. A rule's hand-off says the
 * rule, which can be turned off from here.
 */
export function HandedLine({ h, me, sid, invite, stamp }: { h: Handed; me: string; sid: string; invite: string; stamp: React.ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  const mateLook = useTeamNow()?.teammates.find((x) => x.id === h.mate)?.look;
  const live = handedLive(h);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [live]);
  const [busy, setBusy] = useState(false);
  const mine = h.by.id === me;
  const act = (how: "back" | "stopped") => {
    setBusy(true);
    void workReq(kgPath(sid, invite, `/${h.job}/back`), { method: "POST", body: JSON.stringify({ how }) }).then(
      () => setBusy(false),
      (e: Error) => (setBusy(false), notice(e.message)),
    );
  };
  // Where its crew mate works on it: its lane in this session, on this computer (crew-carry.ts).
  const openJob = () =>
    void workReq<{ sid: string; lane: string }>(kgPath(sid, invite, `/${h.job}`)).then(
      (o) => dispatchEvent(new CustomEvent("friday:focus-lane", { detail: { lane: o.lane } })),
      (e: Error) => notice(e.message),
    );
  const sub = handedSub(h);
  return (
    <div className="kg-line" data-state={h.back ?? h.state}>
      <div className="kg-head">
        {/* The crew mate it went to, as its face (Arun, 2026-11-13: "show the crew mascots"). */}
        <span className="kg-mate-face" aria-hidden="true">
          <Face seed={mateLook ?? h.mateName} size={20} status={live ? "working" : "idle"} />
        </span>
        <span className="kg-said">
          {mine ? "You" : first(h.by.name)} handed this to <b>{h.mateName}</b>
        </span>
        <span className="kg-stamp">{stamp}</span>
      </div>
      {sub && <div className="kg-sub">{sub}</div>}
      <div className="kg-status" role="status">
        {live && <i className="kg-dot" aria-hidden="true" />}
        <span>{progressLine(h, now, me)}</span>
        {live && mine && (
          <button type="button" className="kg-link" disabled={busy} onClick={() => act("stopped")}>
            Stop
          </button>
        )}
        <button type="button" className="kg-link" onClick={openJob}>
          Open
        </button>
      </div>
      {h.state === "done" && h.result && !h.back && (
        <div className="kg-result">
          <Avatar name={h.mateName} id={h.mate} size={18} />
          <div className="kg-result-main">
            <b>Done. Ready for your review.</b>
            {h.result.said && <p>{h.result.said.split(/\n\n/)[0]!.slice(0, 400)}</p>}
            {resultLine(h.result) && <span className="kg-diff">{resultLine(h.result)}</span>}
            <span className="kg-result-acts">
              {/* Its work into this session, for this session's agent to merge and carry on (Arun, 2026-11-13: "how do i send over
                  the work done between like crew to the coding session"). */}
              <button type="button" className="kg-bring" onClick={() => openBring({ sid, invite, from: `mate:${h.mate}`, name: h.mateName })}>
                Bring it in
              </button>
              {h.result.prs[0] && (
                <a className="kg-link" href={h.result.prs[0]} target="_blank" rel="noreferrer">
                  Pull request
                </a>
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}


// ── Finished work ready to come in ───────────────────────────────────────────────────────────────────────────────────────

type Ready = { key: string; at: number; relation: string; skip?: string; files?: string[]; who?: { name: string; look?: string } };
const seenKey = (sid: string) => `friday:bring-seen:${sid}`;

/**
 * Finished crew work this session can take, said once over the box (Friday Teams ffdd8820; Arun, 2026-11-13: "make it easy to bring
 * in new work from the crew rooms and crewmates"): who finished, and one press for a look at all of it together, ticked and checked
 * for clashes before anything comes in. Gone once it is brought in or put away, back when there is newer work. Read every minute
 * while the page is in sight, and right after something is brought in. Its look is all here and in crew-carry.css (.kg-ready).
 */
export function BringReady({ sid, invite }: { sid: string; invite: string }) {
  const [ready, setReady] = useState<Ready[]>([]);
  const [seen, setSeen] = useState(() => {
    try {
      return Number(localStorage.getItem(seenKey(sid))) || 0;
    } catch {
      return 0;
    }
  });
  useEffect(() => {
    let live = true;
    const look = () => {
      if (document.hidden) return;
      void workReq<{ pieces: Ready[] }>(kgPath(sid, invite, "", "&bringFrom=all")).then((p) => live && setReady(p.pieces.filter((x) => !x.skip && x.relation !== "other" && Date.now() - x.at < 3 * 86_400_000)), () => {});
    };
    look();
    const t = setInterval(look, 60_000);
    addEventListener("friday:bring-done", look);
    addEventListener("visibilitychange", look);
    return () => ((live = false), clearInterval(t), removeEventListener("friday:bring-done", look), removeEventListener("visibilitychange", look));
  }, [sid, invite]);
  const fresh = ready.filter((x) => x.at > seen);
  if (!fresh.length) return null;
  const who = [...new Map(fresh.filter((x) => x.who).map((x) => [x.who!.name, x.who!])).values()];
  const names = who.length > 2 ? `${first(who[0]!.name)}, ${first(who[1]!.name)} and ${who.length - 2} more` : new Intl.ListFormat("en", { type: "conjunction" }).format(who.map((w) => first(w.name)));
  const handed = fresh.some((x) => x.relation === "handed");
  const away = () => {
    const at = Math.max(...fresh.map((x) => x.at));
    setSeen(at);
    try {
      localStorage.setItem(seenKey(sid), String(at));
    } catch {
      /* this page only */
    }
  };
  const files = new Set(fresh.flatMap((x) => x.files ?? [])).size;
  // A tray tucked behind the top of the box, its curve the box's own (Arun, 2026-11-14: "make it like a curved section above the
  // input box with the ability to dismiss or bring in"): who finished, what it comes to, Dismiss and Bring it in. Only finished work
  // is ever here.
  return (
    <div className="kg-ready" role="status">
      <span className="kg-ready-faces" aria-hidden="true">
        {who.slice(0, 3).map((w) => (
          <Face key={w.name} seed={w.look ?? w.name} size={20} />
        ))}
      </span>
      <span className="kg-ready-text">
        <b>{names || "Your crew"}</b> {handed ? "finished what you handed off" : `finished ${fresh.length === 1 ? "work" : `${fresh.length} pieces`} you can bring in`}
        {files > 0 && <span className="kg-ready-meta"> · {files === 1 ? "1 file" : `${files} files`}</span>}
      </span>
      <button type="button" className="kg-ready-x" onClick={away}>
        Dismiss
      </button>
      <button type="button" className="kg-ready-go" onClick={() => openBring({ sid, invite, from: "all", name: "your crew" })}>
        {fresh.length === 1 ? "Bring it in" : `Bring in ${fresh.length}`}
      </button>
    </div>
  );
}
