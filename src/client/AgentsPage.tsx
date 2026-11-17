import { useEffect, useMemo, useState } from "react";
import { PlusIcon } from "lucide-react";
import type { Attention } from "../attention.js";
import type { TeamBrief } from "../types.js";
import { api } from "./api.js";
import { Icon } from "./icons.js";
import type { Identity, RecentSession } from "./storage.js";
import { readSince } from "./team-api.js";
import type { TeammateView } from "../teammates.js";
import { Face, MateRing, mateStatus, newTeammate, openRoom, openTeammate, ownOf, RoomDialog, roomNow, roomsOf, RoomFaces, useTeam, type RoomView } from "./Teammates.js";
import { plainLine } from "./team-room.js";
import { withCode } from "./Attention.js";
import { freeLine, roleWord } from "./team-status.js";
import { plainRisk } from "../plain-risk.js";
import { mateItems } from "./mate-menu.js";
import { MenuButton, useConfirm } from "./ui.js";
import "./agents-page.css";

/**
 * The Agents page: the Crew's home once it has teammates (Arun, 2026-11-11, option 2A of the Crew overhaul, after OpenBot and
 * Oh My Hermes). What needs you first, answered right there and stepped through with ⌘J; then the crew, one row each with its
 * role and what it is doing now; the rooms; and what finished today. It replaces opening straight into the Crew room.
 */
export default function AgentsPage({ identity, onOpen, needs = [] }: { identity: Identity; onOpen: (r: RecentSession) => void; /** What waits on you (Attention.tsx), the crew's own shown here. */ needs?: Attention[] }) {
  const t = useTeam(identity);
  const [ask, confirmUI] = useConfirm();
  const [rooming, setRooming] = useState(false);
  const [brief, setBrief] = useState<TeamBrief | null>(null);
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const mates = t ? ownOf(t) : [];
  // The crew's own waits: its sessions (the Crew room and its rooms).
  const sids = useMemo(() => new Set(t ? [t.sid, ...(t.rooms ?? []).map((r) => r.sid)] : []), [t]);
  const waits = needs.filter((n) => sids.has(n.sid) && (n.kind === "approval" || n.kind === "question" || n.kind === "ask" || n.kind === "stopped"));
  const one = waits[Math.min(at, Math.max(0, waits.length - 1))];
  const waitName = one ? (mates.find((m) => m.lane === one.lane)?.name ?? one.agent ?? "A crew mate") : "";
  const plain = one?.approval && one.items?.length ? plainRisk(one.items) : null;
  useEffect(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    void readSince(identity, start.getTime()).then((b) => b && setBrief(b));
  }, [identity, t?.news]);
  // ⌘J steps to the next thing that needs you, as Oh My Hermes does.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "j" || waits.length < 2) return;
      e.preventDefault();
      setAt((i) => (i + 1) % waits.length);
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [waits.length]);
  if (!t) return null;

  const mateOf = (lane?: string): TeammateView | undefined => mates.find((m) => m.lane === lane) ?? mates.find((m) => lane?.endsWith(m.lane));
  const inviteOf = (sid: string) => (sid === t.sid ? t.invite : (t.rooms ?? []).find((r) => r.sid === sid)?.invite ?? "");
  const answer = async (w: Attention, approve: boolean, task = false) => {
    if (!w.approval) return;
    setBusy(approve ? "yes" : "no");
    setNote("");
    try {
      await api(identity, `/api/sessions/${w.sid}/answer?invite=${encodeURIComponent(inviteOf(w.sid))}`, { method: "POST", body: JSON.stringify({ lane: w.lane, id: w.approval, approve, ...(task ? { task: true } : {}) }), headers: { "Content-Type": "application/json" } });
    } catch (e) {
      setNote((e as Error).message || "That didn't go through. Open it and answer there.");
    } finally {
      setBusy("");
    }
  };
  const openWait = (w: Attention) => {
    const m = mateOf(w.lane);
    if (w.sid === t.sid) openTeammate(t, m?.lane ?? null, onOpen);
    else onOpen({ sid: w.sid, invite: inviteOf(w.sid), title: w.title, role: "owner", openedAt: Date.now() });
  };
  const order = [...mates].sort((a, b) => rank(a) - rank(b) || (b.lastAt ?? 0) - (a.lastAt ?? 0));
  const done = (brief?.done ?? []).slice(-6).reverse();

  return (
    <div className="ap ap-page">
      <header className="ap-head">
        <h1>Agents</h1>
        <span className="ap-count">{mates.length} on your crew</span>
        <span className="ap-head-acts">
          {/* No Away here (Arun, 2026-11-15: "get rid of the away until morning stuff on this page"): it is a room's, in its profile. */}
          <button type="button" className="ap-btn" onClick={newTeammate}>
            <PlusIcon aria-hidden="true" /> New agent
          </button>
        </span>
      </header>

      <div className="ap-body">
        {one && (
          <section className="ap-needs" aria-label="Needs you" aria-live="polite">
            <Face seed={mateOf(one.lane)?.look ?? mateOf(one.lane)?.name ?? one.agent ?? "?"} size={30} status="waiting" />
            <div className="ap-needs-text">
              <div className="ap-needs-line">
                {/* Its name once, then what it wants in plain words, as its card says it (plain-risk.ts): "wants to publish a package to npm". */}
                <b>{waitName}</b> {plain ? `wants to ${plain.does}` : withCode(one.text.startsWith(`${waitName} `) ? one.text.slice(waitName.length + 1) : one.text)}
              </div>
              {plain ? (
                <div className="ap-needs-why">
                  {withCode(`\`${one.items![0]}\`${one.items!.length > 1 ? ` and ${one.items!.length - 1} more` : ""}`)}
                  {plain.risk ? ` · ${plain.risk}` : ""}
                </div>
              ) : (
                one.detail && <div className="ap-needs-why">{withCode(one.detail)}</div>
              )}
              {note && <div className="ap-needs-why ap-err">{note}</div>}
            </div>
            <span className="ap-needs-acts">
              <button type="button" className="ap-btn ap-quiet" onClick={() => openWait(one)}>
                Open
              </button>
              {one.approval && (
                <>
                  <button type="button" className="ap-btn" disabled={!!busy} onClick={() => void answer(one, false)}>
                    Deny
                  </button>
                  {/* As the chat's card offers it: commands like this one, without asking, until the task is done. */}
                  {/* Only where it does what it says (taskAllowApplies): the host of its computer, in a session they own. */}
                  {one.forTask && (
                    <button type="button" className="ap-btn" disabled={!!busy} onClick={() => void answer(one, true, true)} title="Let it run commands like this without asking until it next stops">
                      Allow for this task
                    </button>
                  )}
                  <button type="button" className="ap-btn ap-primary" disabled={!!busy} onClick={() => void answer(one, true)}>
                    Allow once
                  </button>
                </>
              )}
              {!one.approval && (
                <button type="button" className="ap-btn ap-primary" onClick={() => openWait(one)}>
                  {/* What the press does, by what waits: a stopped run is looked at (its chat offers Retry), a question answered. */}
                  {one.kind === "stopped" ? "See why" : "Answer"}
                </button>
              )}
            </span>
            {waits.length > 1 && (
              <button type="button" className="ap-needs-step" onClick={() => setAt((i) => (i + 1) % waits.length)} aria-label={`Next: ${Math.min(at, waits.length - 1) + 1} of ${waits.length}`}>
                {Math.min(at, waits.length - 1) + 1} of {waits.length} <kbd>⌘J</kbd>
              </button>
            )}
          </section>
        )}

        <section aria-labelledby="ap-crew">
          <h2 id="ap-crew" className="ap-label">
            Your crew
          </h2>
          <ul className="ap-list">
            {order.map((m) => {
              const s = mateStatus(m);
              const line = freeLine(m, s);
              const chip = roleWord(m.role ?? "");
              return (
                <li key={m.id} className="ap-row">
                  <button type="button" className="ap-row-main" onClick={() => openTeammate(t, m.lane, onOpen)}>
                    <Face seed={m.look ?? m.name} size={34} status={m.status} lead={t.lead === m.lane} />
                    <span className="ap-row-text">
                      <span className="ap-row-name">
                        <b>{m.name}</b>
                        <MateRing status={m.status} />
                        {chip && <span className="ap-chip">{chip}</span>}
                      </span>
                      <span className={`ap-row-line s-${s.state}`}>{line}</span>
                    </span>
                    {m.lastAt ? <span className="ap-when">{ago(m.lastAt)}</span> : null}
                  </button>
                  <button type="button" className="ap-btn ap-quiet ap-row-msg" onClick={() => openTeammate(t, m.lane, onOpen)}>
                    Message
                  </button>
                  <MenuButton className="ap-row-more" label={`More for ${m.name}`} items={() => mateItems({ identity, team: t, mate: m, ask })} />
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-labelledby="ap-rooms">
          <h2 id="ap-rooms" className="ap-label">
            Rooms
          </h2>
          <div className="ap-rooms">
            {roomsOf(t).map((r: RoomView) => {
              // Who is at work in it, or that it needs you, as the sidebar's row says (Teammates.tsx roomNow).
              const now = roomNow(r, mates);
              return (
                <button key={r.id} type="button" className="ap-room" data-tone={now.state?.tone} onClick={() => openRoom(r, onOpen)}>
                  <RoomFaces seeds={now.seeds.slice(0, 3)} states={now.states.slice(0, 3)} size={22} />
                  <span className="ap-room-text">
                    <b>
                      {r.name}
                      {now.ring && <MateRing status={now.ring} title={now.state?.word} />}
                    </b>
                    <span>{plainLine(now.line)}</span>
                  </span>
                </button>
              );
            })}
            <button type="button" className="ap-room ap-room-new" onClick={() => setRooming(true)}>
              <Icon name="plus" size={15} /> New room for a project
            </button>
          </div>
        </section>

        {done.length > 0 && (
          <section aria-labelledby="ap-done">
            <h2 id="ap-done" className="ap-label">
              Finished today
            </h2>
            <ul className="ap-done">
              {done.map((d, i) => {
                const m = mateOf(d.lane);
                return (
                  <li key={`${d.lane}-${d.seq ?? i}`}>
                    <Face seed={m?.look ?? d.name} size={20} />
                    <span className="ap-done-title">{d.title}</span>
                    <span className="ap-done-meta">
                      {d.name}
                      {d.files?.length ? ` · ${d.files.length} file${d.files.length === 1 ? "" : "s"}` : ""}
                      {d.pr ? " · a pull request" : ""}
                    </span>
                    <Icon name="check" size={15} className="ap-done-check" />
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
      {rooming && <RoomDialog identity={identity} team={t} editing={null} onClose={() => setRooming(false)} onMade={(r) => openRoom(r, onOpen)} />}
      {confirmUI}
    </div>
  );
}

/** Who needs you first, then who works, then the rest. */
const rank = (m: TeammateView) => (m.status === "waiting" ? 0 : m.status === "stopped" ? 1 : m.status === "working" ? 2 : 3);

/** How long ago, short: "now", "2m", "3h", "Tue". */
function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(ts).toLocaleDateString([], { weekday: "short" });
}
