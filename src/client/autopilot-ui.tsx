import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AUTOPILOT_DEFAULTS, AUTOPILOT_MAX, type AutopilotSettings, type PilotEntry, type PilotPrRecord } from "../autopilot.js";
import { ENGINE_NAMES, type EngineTool } from "../types.js";
import { EngineMark } from "./BrandMarks.js";
import { api } from "./api.js";
import { Icon, type IconName } from "./icons.js";
import type { Identity } from "./storage.js";
import { floating, MenuButton, placeCard, relTime, Segmented, useDismiss } from "./ui.js";
import "./autopilot.css";

/**
 * Pull request autopilot on Code Review (autopilot.ts; Arun, 2026-11-19, mocked as m1 and then "Yes, build #1"): its switch over
 * the Yours list with what it may do, each pull request's row saying what autopilot is doing on it, and in the pane what it did,
 * in order. One copy of the state for the page, read again every 15 seconds while anything shows it.
 */

type Snapshot = { settings: AutopilotSettings; prs: Map<string, PilotPrRecord>; off?: string };
let snap: Snapshot | null = null;
let version = 0;
const subs = new Set<() => void>();
const tell = () => {
  version++;
  for (const f of subs) f();
};
const take = (r: { settings?: AutopilotSettings; prs?: PilotPrRecord[] }) => {
  snap = { settings: { ...AUTOPILOT_DEFAULTS, ...(r.settings ?? snap?.settings ?? {}) }, prs: new Map((r.prs ?? [...(snap?.prs.values() ?? [])]).map((p) => [p.url, p])) };
  tell();
};
let who: Identity | null = null;
const read = () =>
  who
    ? api<{ settings: AutopilotSettings; prs: PilotPrRecord[] }>(who, "/api/autopilot").then(take, (e: Error) => {
        // An edition without it (Friday Team's hosted app) says so once and is left alone.
        snap = { settings: { ...AUTOPILOT_DEFAULTS }, prs: new Map(), off: e.message };
        tell();
      })
    : Promise.resolve();
let timer: ReturnType<typeof setInterval> | null = null;
let quietTicks = 0;

/** Autopilot's state for the page, kept fresh while something on it shows it. */
export function useAutopilot(identity: Identity): Snapshot | null {
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => version,
  );
  useEffect(() => {
    who = identity;
    if (!snap) void read();
    // Every five seconds while it is fixing or watching one, so its rows move as it works; every fifteen otherwise.
    timer ??= setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const busy = [...(snap?.prs.values() ?? [])].some((p) => p.state === "working" || p.state === "watching");
      if (busy || ++quietTicks >= 3) (quietTicks = 0), void read();
    }, 5_000);
    return () => {
      // The last one gone stops the reading.
      queueMicrotask(() => {
        if (!subs.size && timer) (clearInterval(timer), (timer = null));
      });
    };
  }, [identity]);
  return snap;
}

/** Restarted, or left alone and let back: what the server said went wrong, if anything, for the bar to say. */
export const restartPilot = async (identity: Identity, url: string): Promise<string> => {
  try {
    take(await api<{ settings: AutopilotSettings; prs: PilotPrRecord[] }>(identity, "/api/autopilot/restart", { method: "POST", body: JSON.stringify({ url }) }));
    return "";
  } catch (e) {
    void read();
    return (e as Error).message;
  }
};
/** Off the list: one finished pull request, or (null) every finished one. */
export const forgetPilots = async (identity: Identity, url: string | null) =>
  take(await api<{ settings: AutopilotSettings; prs: PilotPrRecord[] }>(identity, "/api/autopilot/forget", { method: "POST", body: JSON.stringify(url ? { url } : { finished: true }) }));
const skipPilot = async (identity: Identity, url: string, skip: boolean) => take(await api<{ settings: AutopilotSettings; prs: PilotPrRecord[] }>(identity, "/api/autopilot/skip", { method: "POST", body: JSON.stringify({ url, skip }) }));

const patch = async (identity: Identity, body: Partial<AutopilotSettings>) => {
  if (snap) take({ settings: { ...snap.settings, ...body } });
  take(await api<{ settings: AutopilotSettings; prs: PilotPrRecord[] }>(identity, "/api/autopilot", { method: "PATCH", body: JSON.stringify(body) }));
};
export const stopPilot = async (identity: Identity, url: string) => take(await api<{ prs: PilotPrRecord[] }>(identity, "/api/autopilot/stop", { method: "POST", body: JSON.stringify({ url }) }));
const lookNow = async (identity: Identity) => take(await api<{ prs: PilotPrRecord[] }>(identity, "/api/autopilot/look", { method: "POST" }));

const MAY: { key: "checks" | "comments" | "conflicts"; label: string; sub: string; icon: IconName }[] = [
  { key: "checks", label: "Fix failing checks", sub: "Reads the log, fixes it, pushes", icon: "flask" },
  { key: "comments", label: "Answer review comments", sub: "Changes the code a reviewer asked for", icon: "message" },
  { key: "conflicts", label: "Resolve conflicts", sub: "Merges the base in and settles them", icon: "gitMerge" },
];

/** How many at once, in the settings menu: read live, so a press shows at once while the menu stays open. */
function AtOnce({ identity }: { identity: Identity }) {
  const s = useAutopilot(identity);
  return (
    <div className="ap-menu-seg">
      <Segmented value={String(s?.settings.max ?? AUTOPILOT_DEFAULTS.max)} options={AUTOPILOT_MAX.map((n) => [String(n), String(n)] as [string, string])} onChange={(v) => void patch(identity, { max: Number(v) })} />
    </div>
  );
}

/** Its runs worth a row: what it's on now, then ones stopped in the last three days and done in the last day. */
const RANK: Record<PilotPrRecord["state"], number> = { working: 0, watching: 1, stopped: 2, done: 3 };
function runsOf(prs: Map<string, PilotPrRecord>, now: number): PilotPrRecord[] {
  return [...prs.values()]
    .filter((p) => p.state === "working" || p.state === "watching" || (p.state === "stopped" && now - p.updated < 3 * 86_400_000) || (p.state === "done" && now - p.updated < 86_400_000))
    .sort((x, y) => RANK[x.state] - RANK[y.state] || y.updated - x.updated);
}
const STATE_WORD: Record<PilotPrRecord["state"], string> = { working: "Fixing", watching: "Watching", stopped: "Stopped", done: "Done" };
/** How long it has been on it: since it last started or restarted. */
const onFor = (r: PilotPrRecord, now: number) => {
  const from = r.log.findLast((e) => e.kind === "started" || e.kind === "restarted")?.at;
  if (!from) return "";
  const m = Math.max(0, Math.round((now - from) / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

/**
 * Over the Yours list (Arun, 2026-11-19: "design this better.... also add svg icons to the dropdown too"; 2026-11-20: "add more
 * controls over the auto pilot, like restart and stuff and make it dynamic and actually good"): a tile, Autopilot and whether it's
 * on, what it's doing as counts, a look now, what it may do and its switch; under them each pull request it is on or was lately,
 * live, with what it last did and its controls (open its session, restart, stop, leave it alone).
 */
export function AutopilotBar({ identity, tools = [], onOpen }: { identity: Identity; /** This computer's ready coding tools, for "which agent". */ tools?: EngineTool[]; onOpen?: (sid: string, invite?: string) => void }) {
  const s = useAutopilot(identity);
  const [all, setAll] = useState(false);
  const [note, setNote] = useState("");
  const [looking, setLooking] = useState(false);
  if (!s || s.off) return null;
  const now = Date.now();
  const on = s.settings.on;
  const busy = [...s.prs.values()].filter((p) => p.state === "working").length;
  const watching = [...s.prs.values()].filter((p) => p.state === "watching").length;
  const stopped = [...s.prs.values()].filter((p) => p.state === "stopped" && now - p.updated < 3 * 86_400_000).length;
  const may = MAY.filter((m) => s.settings[m.key]);
  // What it's on now, always; the finished ones folded under their count until opened, and cleared from there (Arun, 2026-11-20:
  // "make the autopilot thing dynamic and remove it too... so it doesnt clog the page").
  const runs = runsOf(s.prs, now);
  const liveRuns = runs.filter((r) => r.state === "working" || r.state === "watching");
  const finished = runs.filter((r) => r.state === "stopped" || r.state === "done");
  const shown = all ? runs : liveRuns;
  const say = (p: Promise<string | void>) => void p.then((m) => setNote(m || ""), (e: Error) => setNote(e.message));
  const look = () => {
    setLooking(true);
    void lookNow(identity)
      .then(() => setNote(""), (e: Error) => setNote(e.message))
      .finally(() => setLooking(false));
  };
  const toolName = (t: string) => (t === "auto" ? "Best for the task" : (ENGINE_NAMES as Record<string, string>)[t] ?? t);
  return (
    <div className="ap-wrap" data-on={on || undefined}>
      {/* No tile before its name (Arun, 2026-11-20: "get rid of this"): what it's doing is said by its counts. */}
      <div className="ap-bar" data-on={on || undefined}>
        <div className="ap-bar-text">
          <span className="ap-title">
            <b>Autopilot</b>
            <span className="ap-pill">{on ? "On" : "Off"}</span>
          </span>
          {on ? (
            busy || watching || stopped ? (
              <span className="ap-stats">
                {busy > 0 && (
                  <span className="ap-stat" data-tone="working">
                    <i aria-hidden="true" />
                    {busy} fixing
                  </span>
                )}
                {watching > 0 && (
                  <span className="ap-stat" data-tone="watching">
                    <i aria-hidden="true" />
                    {watching} watching
                  </span>
                )}
                {stopped > 0 && (
                  <span className="ap-stat" data-tone="stopped">
                    <i aria-hidden="true" />
                    {stopped} stopped
                  </span>
                )}
                <span className="ap-stat ap-stat-quiet">
                  up to {s.settings.max} at once · {toolName(s.settings.tool)}
                </span>
              </span>
            ) : (
              <span className="ap-line">{may.length ? `Watching your pull requests, up to ${s.settings.max} at once. Asks you before merging.` : "Pick what it may do."}</span>
            )
          ) : (
            <span className="ap-line">Fixes red checks, review comments and conflicts on your pull requests. Never merges.</span>
          )}
        </div>
        {on && (
          <button type="button" className="ap-icon-btn" aria-label="Look at my pull requests now" title="Look at my pull requests now" disabled={looking} onClick={look}>
            {looking ? <span className="spinner tiny" aria-hidden="true" /> : <Icon name="refresh" size={14} />}
          </button>
        )}
        <MenuButton
          label="Autopilot settings"
          icon="settings"
          end
          className="ap-menu-btn"
          items={() => [
            { heading: "It may" },
            ...MAY.map((m) => ({ label: m.label, sub: m.sub, icon: m.icon, checked: s.settings[m.key], onSelect: () => void patch(identity, { [m.key]: !s.settings[m.key] }) })),
            { heading: "Pull requests at once" },
            {
              node: <AtOnce identity={identity} />,
              height: 40,
            },
            { heading: "Who fixes them" },
            { label: "Best for the task", sub: "Picked for each fix", icon: "zap" as IconName, checked: s.settings.tool === "auto", onSelect: () => void patch(identity, { tool: "auto" }) },
            ...tools.map((t) => ({ label: ENGINE_NAMES[t], mark: <EngineMark tool={t} size={14} />, checked: s.settings.tool === t, onSelect: () => void patch(identity, { tool: t }) })),
            { heading: "When one is done" },
            { label: "Close its session", sub: "Once the pull request merges or closes", icon: "check" as IconName, checked: s.settings.closeWhenDone, onSelect: () => void patch(identity, { closeWhenDone: !s.settings.closeWhenDone }) },
            { label: "Merging is always yours", sub: "It asks you every time", icon: "shield" as IconName, disabled: true, onSelect: () => {} },
          ]}
        />
        <button type="button" role="switch" aria-checked={on} aria-label="Pull request autopilot" className="ap-switch" onClick={() => void patch(identity, { on: !on })}>
          <i aria-hidden="true" />
        </button>
      </div>
      {note && (
        <p className="ap-note" role="status">
          {note}
        </p>
      )}
      {runs.length > 0 && (
        <ul className="ap-runs" aria-label="What autopilot is on">
          {shown.map((r) => {
            const last = r.log.at(-1);
            const live = r.state === "working" || r.state === "watching";
            const left = s.settings.skip.includes(r.url);
            const time = live ? onFor(r, now) : last && Number.isFinite(last.at) ? relTime(last.at) : "";
            return (
              <li key={r.url} className="ap-run" data-state={r.state}>
                <span className="ap-run-dot" aria-hidden="true" />
                <div className="ap-run-body">
                  <span className="ap-run-top">
                    <span className="ap-run-title" title={`${r.repo} #${r.number}: ${r.title}`}>
                      <b>#{r.number}</b> {r.title}
                    </span>
                    {time && (
                      <time className="ap-run-time" title={live ? "How long it has been on it" : "When it last did something"}>
                        {time}
                      </time>
                    )}
                  </span>
                  <span className="ap-run-line">
                    <span className="ap-run-state">{STATE_WORD[r.state]}</span>
                    {last && <span className="ap-run-last" title={last.text}>{last.text}</span>}
                  </span>
                </div>
                <MenuButton
                  label={`Autopilot on #${r.number}`}
                  icon="more"
                  end
                  className="ap-run-more"
                  items={() => [
                    ...(r.sid && onOpen ? [{ label: "Open its session", icon: "arrowUpRight" as IconName, onSelect: () => onOpen(r.sid!, r.invite) }] : []),
                    { label: "Restart", sub: "Starts a fresh session on what it needs now", icon: "refresh" as IconName, onSelect: () => say(restartPilot(identity, r.url)) },
                    ...(live ? [{ label: "Stop", sub: "It stops watching; its session stays", icon: "stop" as IconName, onSelect: () => say(stopPilot(identity, r.url)) }] : []),
                    left
                      ? { label: "Let autopilot work on it", icon: "play" as IconName, onSelect: () => say(skipPilot(identity, r.url, false)) }
                      : { label: "Leave this one alone", sub: "Autopilot won't start on it again", icon: "hand" as IconName, onSelect: () => say(skipPilot(identity, r.url, true)) },
                    { label: "Open on GitHub", icon: "external" as IconName, onSelect: () => void window.open(r.url, "_blank", "noopener") },
                    ...(!live ? [{ label: "Remove from the list", icon: "x" as IconName, onSelect: () => say(forgetPilots(identity, r.url)) }] : []),
                  ]}
                />
              </li>
            );
          })}
          {finished.length > 0 && (
            <li className="ap-runs-more">
              <button type="button" className="ap-link" aria-expanded={all} onClick={() => setAll(!all)}>
                <Icon name="chevronDown" size={12} />
                {all ? "Hide finished" : `${finished.length} finished`}
              </button>
              <span className="ap-grow" />
              <button type="button" className="ap-link" title="Take the stopped and done ones off this list" onClick={() => say(forgetPilots(identity, null))}>
                <Icon name="x" size={12} /> Clear finished
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** What a row says while autopilot has a pull request, or null to say what it would anyway. */
export function pilotWords(rec: PilotPrRecord | undefined): { text: string; tone: "working" | "watching" | "stopped" | "done" } | null {
  if (!rec) return null;
  if (rec.state === "working") return { text: "Autopilot fixing", tone: "working" };
  if (rec.state === "watching") return { text: "Autopilot pushed a fix", tone: "watching" };
  if (rec.state === "stopped" && Date.now() - rec.updated < 3 * 86_400_000) return { text: "Autopilot stopped", tone: "stopped" };
  return null;
}

const ICONS: Record<PilotEntry["kind"], IconName> = {
  started: "play",
  restarted: "refresh",
  tidied: "check",
  checks: "x",
  comments: "chat",
  conflicts: "gitMerge",
  pushed: "gitCommit",
  merged: "gitMerge",
  closed: "x",
  stopped: "hand",
  skipped: "hand",
};

/** In the pane: what autopilot did on this pull request, oldest first, and its session to open or stop. */
export function PilotTimeline({ identity, url, onOpen }: { identity: Identity; url: string; onOpen?: (sid: string, invite?: string) => void }) {
  const s = useAutopilot(identity);
  const [note, setNote] = useState("");
  const [whole, setWhole] = useState(false);
  const rec = s?.prs.get(url);
  if (!rec || !rec.log.length) return null;
  const live = rec.state === "working" || rec.state === "watching";
  return (
    <section className="ap-tl" aria-label="What autopilot did">
      {note && (
        <p className="ap-note" role="status">
          {note}
        </p>
      )}
      <div className="ap-tl-head">
        <h3>What autopilot did</h3>
        <span className="ap-tl-state" data-state={rec.state}>
          {rec.state === "working" ? "Fixing" : rec.state === "watching" ? "Watching" : rec.state === "done" ? "Done" : "Stopped"}
        </span>
        <span className="ap-grow" />
        {/* Each with its icon (Arun, 2026-11-20: "use svg icons for this.... like the open its session restart etc"). */}
        {rec.sid && onOpen && (
          <button type="button" className="ap-link" onClick={() => onOpen(rec.sid!, rec.invite)}>
            <Icon name="arrowUpRight" size={13} />
            Open its session
          </button>
        )}
        <button type="button" className="ap-link" onClick={() => void restartPilot(identity, url).then(setNote)}>
          <Icon name="refresh" size={13} />
          Restart
        </button>
        {live ? (
          <button type="button" className="ap-link" onClick={() => void stopPilot(identity, url)}>
            <Icon name="stop" size={13} />
            Stop
          </button>
        ) : (
          <button type="button" className="ap-link" title="Take it off autopilot's list" onClick={() => void forgetPilots(identity, url)}>
            <Icon name="x" size={13} />
            Clear
          </button>
        )}
      </div>
      <ol className="ap-tl-list">
        {/* The latest four, the rest a press away: a long log took the pane over (Arun, 2026-11-20). */}
        {(whole ? rec.log : rec.log.slice(-4)).map((e, i) => (
          <li key={i} data-kind={e.kind}>
            {/* An entry without a time it can read (written before that was checked) is drawn without one, not the page lost. */}
            {Number.isFinite(e.at) ? (
              <time dateTime={new Date(e.at).toISOString()} title={new Date(e.at).toLocaleString()}>
                {relTime(e.at)}
              </time>
            ) : (
              <time />
            )}
            <span className="ap-tl-ic" aria-hidden="true">
              <Icon name={ICONS[e.kind]} size={13} />
            </span>
            <span className="ap-tl-text">
              {e.text}
              {e.sha && <code>{e.sha.slice(0, 7)}</code>}
            </span>
          </li>
        ))}
      </ol>
      {rec.log.length > 4 && (
        <button type="button" className="ap-link ap-tl-more" aria-expanded={whole} onClick={() => setWhole(!whole)}>
          {whole ? "Show the latest" : `Show all ${rec.log.length} steps`}
        </button>
      )}
    </section>
  );
}

/**
 * Autopilot in Code Review's header (Arun, 2026-11-20: "a complete redesign of the code review page ... better autopilot placement"):
 * one button saying whether it's on and what it's doing ("Autopilot · 2 fixing"), a dot that moves while it fixes; pressed, its
 * card opens under it with the switch, settings and each pull request it's on (AutopilotBar).
 */
export function AutopilotButton({ identity, tools = [], onOpen }: { identity: Identity; tools?: EngineTool[]; onOpen?: (sid: string, invite?: string) => void }) {
  const s = useAutopilot(identity);
  const btn = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<DOMRect | null>(null);
  if (!s || s.off) return null;
  const on = s.settings.on;
  const prs = [...s.prs.values()];
  const fixing = prs.filter((p) => p.state === "working").length;
  const watching = prs.filter((p) => p.state === "watching").length;
  const stopped = prs.filter((p) => p.state === "stopped" && Date.now() - p.updated < 3 * 86_400_000).length;
  const word = !on ? "Off" : fixing ? `${fixing} fixing` : watching ? `${watching} watching` : stopped ? `${stopped} stopped` : "On";
  const state = !on ? "off" : fixing ? "working" : stopped && !watching ? "stopped" : "on";
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="ap-head-btn"
        data-state={state}
        aria-haspopup="dialog"
        aria-expanded={!!at}
        aria-label={`Autopilot: ${word}`}
        onClick={() => setAt(at ? null : (btn.current?.getBoundingClientRect() ?? null))}
      >
        <i className="ap-head-dot" aria-hidden="true" />
        <span className="ap-head-name">Autopilot</span>
        <span className="ap-head-word">{word}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {at && <AutopilotCard identity={identity} tools={tools} anchor={at} trigger={btn.current} onClose={() => setAt(null)} {...(onOpen ? { onOpen: (sid: string, invite?: string) => (setAt(null), onOpen(sid, invite)) } : {})} />}
    </>
  );
}

function AutopilotCard({ identity, tools, anchor, trigger, onClose, onOpen }: { identity: Identity; tools: EngineTool[]; anchor: DOMRect; trigger: HTMLElement | null; onClose: () => void; onOpen?: (sid: string, invite?: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose, trigger, { trap: false });
  const pos = placeCard(anchor, 420, { end: true, want: 560, min: 220, prefer: "below" });
  return floating(
    <div ref={ref} className="ap-pop" role="dialog" aria-label="Autopilot" style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight }}>
      <AutopilotBar identity={identity} tools={tools} {...(onOpen ? { onOpen } : {})} />
    </div>,
  );
}
