/**
 * What the team did while the person was gone, as one card (Arun, 2026-10-28: the critique's "Since you left" and the morning
 * brief): at the top of the Team room, from GET /api/teammates/since, one line per teammate with what it finished and its files,
 * what failed and what it asks, each a press from its message; and the morning brief (team.brief) drawn the same way where it
 * was posted. Also the news a teammate an agent made brings (teammate.proposed: Keep or Remove) and holds being lifted.
 *
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangleIcon, CheckIcon, FileIcon, GitPullRequestIcon, LightbulbIcon, MessageCircleQuestionIcon, UserPlusIcon, XIcon } from "lucide-react";
import type { SessionEvent } from "../types.js";
import { api } from "./api.js";
import { focusAgent } from "./agentFocus.js";
import { ALL } from "./agentNav.js";
import type { Identity } from "./storage.js";
import { briefEmpty, plainError, readSince, type Brief } from "./team-api.js";
import { plainLine } from "./team-room.js";
import { timeOf } from "./team-status.js";
import { base, Face, mateOn, refreshTeam, useTeamNow, type Team } from "./Teammates.js";

/** When the person last had the Team room open, by session, on this computer: "since you left" starts there. */
const LEFT = "friday.team.left";
const leftAll = (): Record<string, number> => {
  try {
    return JSON.parse(localStorage.getItem(LEFT) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
};
const noteLeft = (sid: string) => {
  try {
    localStorage.setItem(LEFT, JSON.stringify({ ...leftAll(), [sid]: Date.now() }));
  } catch {
    // A mark: losing it shows the last stretch again, nothing more.
  }
};

/** Shorter than this away, there is no "since you left" to tell. */
const GONE_MS = 10 * 60_000;

/** Scrolls the room to a message and lets it flash once; one in another room opens that room there. */
function jump(t: Team | null, sid: string, seq: number | undefined, lane: string, here: string) {
  if (sid !== here) {
    const r = t?.rooms?.find((x) => x.sid === sid);
    if (r) dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: r.sid, invite: r.invite } }));
    focusAgent(sid, ALL);
  }
  if (seq === undefined) return void focusAgent(sid, lane);
  setTimeout(() => {
    let best: HTMLElement | null = null;
    let at = -1;
    for (const el of document.querySelectorAll<HTMLElement>("[data-seq]")) {
      const n = Number(el.dataset.seq);
      if (n <= seq && n > at) (best = el), (at = n);
    }
    if (!best) return;
    // Its top in view, not its middle, and the message itself lit for a moment: it landed mid-message with nothing to say which
    // one it was (QA, 2026-10-28; Arun: "TEST EVERYTHING… EVERY INTERACTION").
    best.style.scrollMarginTop = "72px";
    best.scrollIntoView({ block: best.offsetHeight > innerHeight * 0.5 ? "start" : "center", behavior: "smooth" });
    best.classList.remove("tm-jumped");
    void best.offsetWidth;
    best.classList.add("tm-jumped");
    setTimeout(() => best!.classList.remove("tm-jumped"), 2200);
  }, sid !== here ? 600 : 0);
}

/** A brief's lines gathered by teammate, in the order they first appear: who did what, at a glance. */
function byMate(b: Brief) {
  const out = new Map<string, { lane: string; name: string; done: Brief["done"]; failed: Brief["failed"]; waiting: Brief["waiting"]; assumptions: Brief["assumptions"]; usage?: Brief["usage"][number] }>();
  const of = (lane: string, name: string) => out.get(lane) ?? out.set(lane, { lane, name, done: [], failed: [], waiting: [], assumptions: [] }).get(lane)!;
  for (const x of b.waiting) of(x.lane, x.name).waiting.push(x);
  for (const x of b.failed) of(x.lane, x.name).failed.push(x);
  for (const x of b.done) of(x.lane, x.name).done.push(x);
  for (const x of b.assumptions) of(x.lane, x.name).assumptions.push(x);
  for (const u of b.usage) if (out.has(u.lane)) out.get(u.lane)!.usage = u;
  return [...out.values()];
}

const minutes = (n: number) => (n < 1 ? "under a minute" : n < 60 ? `${Math.round(n)}m` : `${Math.floor(n / 60)}h${Math.round(n % 60) ? ` ${Math.round(n % 60)}m` : ""}`);

/** The brief's body: one block per teammate, its lines each a press from where they were said. */
export function BriefBody({ brief, sid, compact }: { brief: Brief; sid: string; compact?: boolean }) {
  const t = useTeamNow();
  const mates = byMate(brief);
  // Said in one of the rooms, not here: which, after the line.
  const where = (at?: string) => {
    const r = at && at !== sid ? t?.rooms?.find((x) => x.sid === at) : null;
    return r ? <span className="tm-brief-room"> · {r.name}</span> : null;
  };
  const turns = brief.usage.reduce((n, u) => n + u.turns, 0);
  const mins = brief.usage.reduce((n, u) => n + u.minutes, 0);
  const line = (key: string, icon: ReactNode, tone: string, text: ReactNode, onClick?: () => void, extra?: ReactNode) => (
    <li key={key} className="tm-brief-line" data-tone={tone}>
      <span className="tm-brief-ic" aria-hidden="true">
        {icon}
      </span>
      <span className="tm-brief-what">
        {onClick ? (
          <button type="button" className="tm-brief-go" onClick={onClick}>
            {text}
          </button>
        ) : (
          text
        )}
        {extra}
      </span>
    </li>
  );
  return (
    <>
      <ul className="tm-brief-mates">
        {mates.map((g) => {
          const m = mateOn(g.lane);
          return (
            <li key={g.lane} className="tm-brief-mate">
              <span className="tm-brief-face">{m ? <Face seed={m.look ?? m.name} size={26} /> : null}</span>
              <div className="tm-brief-col">
                <div className="tm-brief-name">
                  <b>{m?.name ?? g.name}</b>
                  {g.usage && !compact && (
                    <span>
                      {g.usage.turns} turn{g.usage.turns === 1 ? "" : "s"}
                      {g.usage.minutes >= 1 ? ` · ${minutes(g.usage.minutes)}` : ""}
                    </span>
                  )}
                </div>
                <ul className="tm-brief-lines">
                  {g.waiting.map((x) => line(`w${x.seq}`, <MessageCircleQuestionIcon className="size-3.5" />, "waiting", <>Asks: {plainLine(x.text)}{where(x.sid)}</>, () => jump(t, x.sid ?? sid, x.seq, x.lane, sid)))}
                  {g.failed.map((x, i) => line(`f${i}`, <AlertTriangleIcon className="size-3.5" />, "failed", <>Didn't finish: {plainLine(x.title)}{where(x.sid)} <span className="tm-brief-why">{plainError(x.why)}</span></>, x.seq !== undefined ? () => jump(t, x.sid ?? sid, x.seq, x.lane, sid) : () => jump(t, x.sid ?? sid, undefined, x.lane, sid)))}
                  {g.done.map((x, i) =>
                    line(
                      `d${i}`,
                      <CheckIcon className="size-3.5" />,
                      "done",
                      <>
                        {plainLine(x.title)}
                        {where(x.sid)}
                      </>,
                      () => jump(t, x.sid ?? sid, x.seq, x.lane, sid),
                      (x.files?.length || x.pr) && (
                        <span className="tm-brief-files">
                          {x.pr && (
                            <a className="tm-brief-file pr" href={x.pr} target="_blank" rel="noreferrer">
                              <GitPullRequestIcon className="size-3" />
                              {/\/pull\/(\d+)/.exec(x.pr)?.[1] ? `PR #${/\/pull\/(\d+)/.exec(x.pr)![1]}` : "Pull request"}
                            </a>
                          )}
                          {(x.files ?? []).slice(0, 4).map((f) => (
                            <span key={f} className="tm-brief-file" title={f}>
                              <FileIcon className="size-3" />
                              {base(f)}
                            </span>
                          ))}
                          {(x.files?.length ?? 0) > 4 && <span className="tm-brief-more">+{x.files!.length - 4}</span>}
                        </span>
                      ),
                    ),
                  )}
                  {g.assumptions.map((x) => line(`a${x.seq}`, <LightbulbIcon className="size-3.5" />, "assumed", <>Assumed: {plainLine(x.text)}{where(x.sid)}</>, () => jump(t, x.sid ?? sid, x.seq, x.lane, sid)))}
                </ul>
              </div>
            </li>
          );
        })}
      </ul>
      {turns > 0 && (
        <p className="tm-brief-usage">
          {turns} turn{turns === 1 ? "" : "s"} across the crew{mins >= 1 ? `, ${minutes(mins)} at work` : ""}
        </p>
      )}
    </>
  );
}

/** The morning brief, where the server posted it in the Team room (team.brief). */
export function BriefCard({ ev, stamp, sid }: { ev: SessionEvent; stamp: ReactNode; sid: string }) {
  if (ev.body.type !== "team.brief") return null;
  const b = ev.body as unknown as Brief;
  const n = { done: b.done.length, needs: b.waiting.length, failed: b.failed.length, assumed: b.assumptions.length };
  // A team workflow's run (team-workflows.ts): headed with its name and how it ended, what it came to under it.
  const flow = b.workflow;
  return (
    <section className="tm-brief" aria-label={flow ? `${flow.name}: how the run went` : "Morning brief"} data-workflow={flow ? flow.status : undefined}>
      <header className="tm-brief-head">
        <div>
          <h3>{flow ? `${flow.name} · ${flow.status === "done" ? "finished" : "didn't finish"}` : "While you were away"}</h3>
          <p>
            {timeOf(b.since)} – {timeOf(b.until)}
          </p>
        </div>
        <span className="tt-stamp">{stamp}</span>
      </header>
      {!briefEmpty(b) && (
        <div className="tm-brief-sum" role="list">
          {n.done > 0 && (
            <span role="listitem" data-tone="done">
              <b>{n.done}</b> done
            </span>
          )}
          {n.needs > 0 && (
            <span role="listitem" data-tone="waiting">
              <b>{n.needs}</b> need{n.needs === 1 ? "s" : ""} you
            </span>
          )}
          {n.failed > 0 && (
            <span role="listitem" data-tone="failed">
              <b>{n.failed}</b> didn't finish
            </span>
          )}
          {n.assumed > 0 && (
            <span role="listitem" data-tone="assumed">
              <b>{n.assumed}</b> assumed
            </span>
          )}
        </div>
      )}
      {briefEmpty(b) ? <p className="tm-brief-quiet">{flow ? "None of its steps finished." : "Nothing to report: the crew had no work while you were away."}</p> : <BriefBody brief={b} sid={sid} />}
      {flow?.result && <WorkflowResult text={flow.result} />}
    </section>
  );
}

/** What a workflow's run came to: its last steps' reports, folded to a few lines until opened. */
function WorkflowResult({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tm-brief-result" data-open={open ? "true" : undefined}>
      <p>{text.replace(/^## /gm, "")}</p>
      {text.length > 320 && (
        <button type="button" className="tm-brief-go" onClick={() => setOpen((x) => !x)}>
          {open ? "Show less" : "Show all of it"}
        </button>
      )}
    </div>
  );
}

/**
 * At the top of the Team room: what happened since the person last had it open, if they were gone a while and anything did.
 * Nothing to tell (or an older server without /since): `fallback`, the team at a glance.
 */
export function SinceYouLeft({ sid, identity, fallback }: { sid: string; identity?: Identity; fallback: ReactNode }) {
  const t = useTeamNow();
  // When they left, read once as the room opens; from then on, this visit is what "left" means next time.
  const from = useRef<number | null>(null);
  if (from.current === null) from.current = leftAll()[sid] ?? 0;
  const [brief, setBrief] = useState<Brief | null>(null);
  const [shut, setShut] = useState(false);
  useEffect(() => {
    const away = () => document.visibilityState === "hidden" && noteLeft(sid);
    document.addEventListener("visibilitychange", away);
    addEventListener("pagehide", away);
    const tick = setInterval(() => document.visibilityState === "visible" && noteLeft(sid), 60_000);
    return () => (noteLeft(sid), document.removeEventListener("visibilitychange", away), removeEventListener("pagehide", away), clearInterval(tick));
  }, [sid]);
  useEffect(() => {
    const at = from.current ?? 0;
    if (!identity || !at || Date.now() - at < GONE_MS) return;
    let live = true;
    void readSince(identity, at).then((b) => live && setBrief(b));
    return () => void (live = false);
  }, [identity?.id, sid]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!brief || briefEmpty(brief) || shut) return <>{fallback}</>;
  return (
    <section className="tm-brief tm-since" aria-label="Since you left">
      <header className="tm-brief-head">
        <div>
          <h3>Since you left</h3>
          <p>{timeOf(from.current!)}</p>
        </div>
        <button type="button" className="tm-brief-x" aria-label="Done reading: show the crew" title="Done reading" onClick={() => setShut(true)}>
          <XIcon className="size-4" />
        </button>
      </header>
      <BriefBody brief={brief} sid={sid} />
    </section>
  );
}

/**
 * A teammate an agent added, for the person to keep or take off (teammate.proposed): it works meanwhile, so nothing waits on the
 * answer (Arun, 2026-10-28: the critique's "Access, visible").
 */
export function ProposedMate({ ev, stamp, identity }: { ev: SessionEvent; stamp: ReactNode; identity?: Identity }) {
  const t = useTeamNow();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [keptHere, setKept] = useState(() => ev.body.type === "teammate.proposed" && keptAll().includes(ev.body.id));
  if (ev.body.type !== "teammate.proposed") return null;
  const b = ev.body;
  const m = t?.teammates.find((x) => x.id === b.id);
  // Kept on the server (madeBy cleared) or on this computer.
  const kept = keptHere || (!!m && !m.madeBy);
  const by = mateOn(b.madeBy.lane);
  return (
    <div className="tm-proposed" data-gone={!m ? "true" : undefined}>
      <span className="tm-proposed-face">{m ? <Face seed={m.look ?? m.name} size={30} /> : <UserPlusIcon className="size-4" />}</span>
      <div className="tm-proposed-text">
        <p>
          <b>{by?.name ?? b.madeBy.name}</b> added <b>{b.name}</b> to the crew.
          {m ? (m.role ? ` ${m.role.split("\n")[0]}` : "") : " Since removed."}
        </p>
        {m && !kept && <p className="tm-sub">They work meanwhile. Keep them, or take them out of the crew.</p>}
        {m && kept && <p className="tm-sub">Kept in the crew.</p>}
        {err && (
          <p className="tm-err" role="alert">
            {err}
          </p>
        )}
      </div>
      {m && !kept && identity && (
        <span className="tm-proposed-acts">
          <button
            type="button"
            className="tm-banner-btn"
            disabled={busy}
            onClick={() => {
              keep(b.id);
              setKept(true);
              // Kept on the server too, so the question clears everywhere (PATCH keep clears madeBy); kept here either way.
              void api(identity, `/api/teammates/${b.id}`, { method: "PATCH", body: JSON.stringify({ keep: true }), headers: { "Content-Type": "application/json" } })
                .then(() => refreshTeam(identity))
                .catch(() => {});
            }}
          >
            Keep
          </button>
          <button
            type="button"
            className="tm-banner-btn danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void api(identity, `/api/teammates/${b.id}`, { method: "DELETE" })
                .then(() => refreshTeam(identity))
                .catch((e: Error) => setErr(e.message))
                .finally(() => setBusy(false));
            }}
          >
            Remove
          </button>
        </span>
      )}
      <span className="tt-stamp">{stamp}</span>
    </div>
  );
}

/** The teammates an agent made that the person kept, on this computer: their card stops asking. */
const KEPT = "friday.team.kept";
const keptAll = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(KEPT) ?? "[]") as string[];
  } catch {
    return [];
  }
};
const keep = (id: string) => {
  try {
    localStorage.setItem(KEPT, JSON.stringify([...keptAll(), id].slice(-50)));
  } catch {
    // A mark: losing it asks again, nothing more.
  }
};

/** Holds lifted (holds.lifted): one quiet line. */
export function HoldsLifted({ ev, stamp }: { ev: SessionEvent; stamp: ReactNode }) {
  if (ev.body.type !== "holds.lifted") return null;
  const names = (ev.body.lanes ?? []).map((l) => mateOn(l)?.name).filter(Boolean);
  return (
    <div className="tt-event">
      <span className="tt-event-face" />
      <span className="tt-event-text">
        {names.length ? `${names.join(", ")} ${names.length === 1 ? "is" : "are"} no longer on hold.` : "Every hold on the crew is lifted."}
        {ev.body.why ? ` ${ev.body.why}` : ""}
      </span>
      <span className="tt-stamp">{stamp}</span>
    </div>
  );
}
