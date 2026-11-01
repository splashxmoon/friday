/**
 * The daily brief and standup on the page (daily-brief.ts): a section on the home screen with the latest scheduled brief, a panel
 * that /brief, its notification and opening Friday after a long gap bring up, and its times. Its lines are the Away brief's
 * (TeamBrief.tsx, teammates.css .tm-brief-*), each a press from the session or room it is about; a teammate's line wears its face.
 */
import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangleIcon, ArrowRightIcon, CheckIcon, ClockIcon, GitMergeIcon, GitPullRequestIcon, HandIcon, ShieldCheckIcon } from "lucide-react";
import type { BriefSettings, BriefWhere, DailyBrief } from "../daily-brief.js";
import { shortTokens } from "../tool-usage.js";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { api } from "./api.js";
import { focusAgent } from "./agentFocus.js";
import { notificationsOn } from "./prefs.js";
import type { Identity } from "./storage.js";
import { Face } from "./Teammates.js";
import { Switch } from "./ui.js";
import "./daily-brief.css";

/** Away this long, opening Friday brings the brief of the stretch (daily-brief.ts LONG_GAP_MS). */
const LONG_GAP_MS = 6 * 3600_000;
/** A scheduled brief stays on the home screen this long. */
const SHOWN_MS = 14 * 3600_000;
const POLL_MS = 5 * 60_000;
const ACTIVE = "friday.brief.active";
const TOLD = "friday.brief.told";
const SHUT = "friday.brief.shut";
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // A mark: losing it tells a brief again, nothing more.
  }
};

// ── The latest scheduled brief, shared by the home section and the panel ─────────────────────────────────────────────────
let latest: { brief: DailyBrief | null; settings: BriefSettings | null } = { brief: null, settings: null };
const listeners = new Set<() => void>();
const setLatest = (l: typeof latest) => ((latest = l), listeners.forEach((f) => f()));
function useLatest() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    listeners.add(f);
    return () => void listeners.delete(f);
  }, []);
  return latest;
}

/** Opens the panel: on demand ("/brief"), or with a brief already in hand. */
export const openBrief = (brief?: DailyBrief) => dispatchEvent(new CustomEvent("friday:brief", { detail: brief ? { brief } : {} }));

const TITLE: Record<DailyBrief["kind"], string> = { morning: "Morning brief", evening: "Evening wrap-up", now: "Your brief" };
const clock = (t: number, zone: string) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: zone }).format(t);
const dayWord = (t: number, zone: string) => new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: zone }).format(t);
/** "Since 18:00", or "Since Fri 18:00" when that was another day. */
const sinceWord = (b: DailyBrief) => `Since ${b.until - b.since > 20 * 3600_000 ? `${dayWord(b.since, b.tz)} ` : ""}${clock(b.since, b.tz)}`;

function open(b: DailyBrief, w: BriefWhere | undefined) {
  if (!w?.sid) return;
  // The panel goes as the session opens.
  dispatchEvent(new Event("friday:brief-close"));
  dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: w.sid, ...(b.invites?.[w.sid] ? { invite: b.invites[w.sid] } : {}) } }));
  if (w.lane) setTimeout(() => focusAgent(w.sid, w.lane!), 300);
}

/** One line: its icon (or the teammate's face), who, what, where, and what goes with it. */
function Line({ tone, icon, face, who, text, where, extra, onClick }: { tone: string; icon: ReactNode; face?: { name: string; look?: string }; who?: string; text: ReactNode; where?: string; extra?: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      {who && <b className="db-who">{who}</b>} {text}
      {where && <span className="tm-brief-room"> · {where}</span>}
    </>
  );
  return (
    <li className="tm-brief-line" data-tone={tone}>
      <span className="tm-brief-ic db-ic" aria-hidden="true">
        {face ? <Face seed={face.look ?? face.name} size={18} /> : icon}
      </span>
      <span className="tm-brief-what">
        {onClick ? (
          <button type="button" className="tm-brief-go" onClick={onClick}>
            {body}
          </button>
        ) : (
          <span>{body}</span>
        )}
        {extra}
      </span>
    </li>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="db-section">
      <h4>
        {title}
        {count !== undefined && <span className="db-count">{count}</span>}
      </h4>
      <ul className="tm-brief-lines">{children}</ul>
    </section>
  );
}

/** How a plan line reads after its who. */
const VERB: Record<DailyBrief["plan"][number]["source"], (at?: string) => string> = {
  running: () => "is on ",
  board: () => "is on ",
  queued: () => "has next: ",
  checkin: (at) => (at === "every hour" ? "checks in every hour: " : `checks in at ${at}: `),
  wake: (at) => `picks up at ${at}: `,
  left: () => "",
  goal: () => "",
};

const more = (n: number, shown: number) => (n > shown ? <li className="db-more">+{n - shown} more</li> : null);

/** The brief itself: done, at risk, today's plan, decisions waiting and usage. `max` shortens each list (the home screen's). */
export function BriefView({ brief: b, max = 12 }: { brief: DailyBrief; max?: number }) {
  // The session or room it was in; the Crew's own room goes unsaid.
  const where = (w?: BriefWhere) => (w && w.kind !== "crew" ? w.title : undefined);
  return (
    <div className="db-body">
      {b.done.length > 0 && (
        <Section title="Done" count={b.done.length}>
          {b.done.slice(0, max).map((d, i) => (
            <Line
              key={`d${i}`}
              tone="done"
              icon={d.pr?.state === "merged" ? <GitMergeIcon className="size-3.5" /> : <CheckIcon className="size-3.5" />}
              {...(d.mate ? { face: d.mate } : {})}
              who={d.who}
              text={d.text}
              {...((w) => (w && w !== d.text ? { where: w } : {}))(where(d.where))}
              onClick={() => open(b, d.where)}
              extra={
                (d.pr || d.proof || d.files || d.turns) && (
                  <span className="tm-brief-files">
                    {d.pr && (
                      <a className="tm-brief-file pr" href={d.pr.url} target="_blank" rel="noreferrer">
                        {d.pr.state === "merged" ? <GitMergeIcon className="size-3" /> : <GitPullRequestIcon className="size-3" />}
                        {/\/pull\/(\d+)/.exec(d.pr.url)?.[1] ? `#${/\/pull\/(\d+)/.exec(d.pr.url)![1]}` : "PR"} {d.pr.state}
                      </a>
                    )}
                    {d.proof && (
                      <span className="tm-brief-file db-proof" title="Its check passed">
                        <ShieldCheckIcon className="size-3" />
                        {d.proof}
                      </span>
                    )}
                    {!!d.files && <span className="db-meta">{d.files} file{d.files === 1 ? "" : "s"}</span>}
                    {!!d.turns && <span className="db-meta">{d.turns} turns</span>}
                  </span>
                )
              }
            />
          ))}
          {more(b.done.length, max)}
        </Section>
      )}
      {b.risk.length > 0 && (
        <Section title="At risk" count={b.risk.length}>
          {b.risk.slice(0, max).map((r, i) => (
            <Line key={`r${i}`} tone={r.kind === "usage" ? "assumed" : "failed"} icon={<AlertTriangleIcon className="size-3.5" />} {...(r.mate ? { face: r.mate } : {})} {...(r.who ? { who: r.who } : {})} text={r.text} {...(r.where ? { onClick: () => open(b, r.where) } : {})} />
          ))}
          {more(b.risk.length, max)}
        </Section>
      )}
      {b.plan.length > 0 && (
        <Section title="Today's plan">
          {b.plan.slice(0, max).map((p, i) => (
            <Line
              key={`p${i}`}
              tone="plan"
              icon={p.at ? <ClockIcon className="size-3.5" /> : <ArrowRightIcon className="size-3.5" />}
              {...(p.mate ? { face: p.mate } : {})}
              who={p.who}
              text={`${VERB[p.source](p.at)}${p.text}`}
              {...((w) => (w && p.source !== "left" && p.source !== "checkin" ? { where: w } : {}))(where(p.where))}
              {...(p.where ? { onClick: () => open(b, p.where) } : {})}
            />
          ))}
          {more(b.plan.length, max)}
        </Section>
      )}
      {b.decisions.count > 0 && (
        <Section title="Decisions waiting" count={b.decisions.count}>
          {b.decisions.top.map((x) => (
            <Line key={`${x.sid}:${x.seq}`} tone="waiting" icon={<HandIcon className="size-3.5" />} {...(x.agent ? { who: x.agent } : {})} text={x.text} where={x.title} onClick={() => open(b, { sid: x.sid, title: x.title, kind: "code", ...(x.lane ? { lane: x.lane } : {}) })} />
          ))}
          {b.decisions.count > b.decisions.top.length && <li className="db-more">+{b.decisions.count - b.decisions.top.length} more in Needs you</li>}
        </Section>
      )}
      {b.usage.length > 0 && (
        <section className="db-section">
          <h4>Usage today</h4>
          <ul className="db-usage">
            {b.usage.map((u) => (
              <li key={u.tool}>
                <b>{u.name}</b>
                <span className="db-tokens">{u.tokens ? `${shortTokens(u.tokens)} tokens` : "no tokens yet"}</span>
                {u.windows.map((w) => (
                  <span key={w.label} className="db-window" data-high={w.used >= 80 ? "true" : undefined} title={w.resetsAt ? `Resets ${clock(w.resetsAt * 1000, b.tz)}` : undefined}>
                    {w.label} {w.used}%
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** On the home screen: the latest scheduled brief while it is fresh, until it is put away. */
export function DailyBriefCard() {
  const { brief } = useLatest();
  const [shut, setShut] = useState(read(SHUT));
  if (!brief || brief.kind === "now" || shut === brief.id || Date.now() - brief.until > SHOWN_MS) return null;
  return (
    <section className="db-card" aria-label={TITLE[brief.kind]}>
      <div className="ha-head">
        <h2>{TITLE[brief.kind]}</h2>
        <span className="db-range">{sinceWord(brief)}</span>
        <button type="button" className="ha-link" onClick={() => openBrief(brief)}>
          Open
        </button>
        <button type="button" className="ha-link db-x" onClick={() => (write(SHUT, brief.id), setShut(brief.id))}>
          Put away
        </button>
      </div>
      <p className="db-headline">{brief.headline}</p>
      <BriefView brief={brief} max={3} />
    </section>
  );
}

/** Its times: morning and evening, each on or off, in the person's own zone. */
function Schedule({ identity, settings, onChange }: { identity: Identity; settings: BriefSettings; onChange: (s: BriefSettings) => void }) {
  const [err, setErr] = useState("");
  const save = (patch: Partial<BriefSettings>) =>
    api<{ settings: BriefSettings }>(identity, "/api/brief/settings", { method: "PUT", body: JSON.stringify(patch) })
      .then((r) => (setErr(""), onChange(r.settings), setLatest({ ...latest, settings: r.settings })))
      .catch((e: Error) => setErr(e.message));
  const row = (kind: "morning" | "evening", label: string, fallback: string) => (
    <div className="db-time">
      <Switch on={!!settings[kind]} onChange={(on) => void save({ [kind]: on ? fallback : null })} label={`${label} brief`} />
      <span className="db-time-label">{label}</span>
      <input type="time" value={settings[kind] ?? fallback} disabled={!settings[kind]} onChange={(e) => e.target.value && void save({ [kind]: e.target.value })} aria-label={`${label} brief time`} />
    </div>
  );
  return (
    <footer className="db-schedule">
      {row("morning", "Morning", "08:30")}
      {row("evening", "Evening", "18:00")}
      <p className="db-zone">
        In {settings.tz.replace(/_/g, " ")}
        {settings.tz !== tz() && (
          <button type="button" className="link-btn" onClick={() => void save({ tz: tz() })}>
            Use {tz().replace(/_/g, " ")}
          </button>
        )}
      </p>
      {err && <p className="error small">{err}</p>}
    </footer>
  );
}

/**
 * Mounted once (App.tsx): keeps the latest scheduled brief, says a new one as a notification (or a quiet note while the window
 * is in front), opens the panel for /brief, and brings the brief of the stretch when Friday is opened after a long gap.
 */
export function DailyBriefHost({ identity }: { identity: Identity }) {
  const [panel, setPanel] = useState<{ brief: DailyBrief | null; since?: number; loading?: boolean } | null>(null);
  const [note, setNote] = useState<DailyBrief | null>(null);
  const [settings, setSettings] = useState<BriefSettings | null>(null);

  useEffect(() => {
    let gone = false;
    const lastActive = Number(read(ACTIVE)) || 0;
    const active = () => document.visibilityState === "visible" && write(ACTIVE, String(Date.now()));
    const poll = async (first = false) => {
      const r = await api<{ brief: DailyBrief | null; settings: BriefSettings }>(identity, `/api/brief/latest?tz=${encodeURIComponent(tz())}`).catch(() => null);
      if (!r || gone) return;
      setLatest(r);
      setSettings(r.settings);
      const b = r.brief;
      // A scheduled brief not yet said on this device, and still fresh: said once.
      if (b && b.kind !== "now" && read(TOLD) !== b.id && Date.now() - b.until < 3 * 3600_000) {
        write(TOLD, b.id);
        if (document.visibilityState !== "visible" && notificationsOn() && typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            const n = new Notification(TITLE[b.kind], { body: b.headline, tag: `brief:${b.id}` });
            n.onclick = () => (window.focus(), n.close(), openBrief(b));
          } catch {
            // A courtesy: the home screen has it either way.
          }
        } else if (!first) setNote(b);
      }
      // Back after a long gap: the brief of the stretch, unless a scheduled one made since already covers it.
      if (first && lastActive && Date.now() - lastActive >= LONG_GAP_MS) {
        if (b && b.until > lastActive) return void setPanel({ brief: b });
        const gap = await api<{ brief: DailyBrief | null }>(identity, `/api/brief?since=${lastActive}&tz=${encodeURIComponent(tz())}`).catch(() => null);
        if (!gone && gap?.brief) setPanel({ brief: gap.brief, since: lastActive });
      }
    };
    void poll(true).then(active);
    const every = setInterval(() => (void poll(), active()), POLL_MS);
    const seen = () => (document.visibilityState === "visible" ? void poll() : write(ACTIVE, String(Date.now())));
    document.addEventListener("visibilitychange", seen);
    addEventListener("pagehide", seen);
    // /brief, or a brief handed over (the notification, the home section's Open).
    const ask = (e: Event) => {
      const given = (e as CustomEvent<{ brief?: DailyBrief }>).detail?.brief;
      if (given) return void setPanel({ brief: given });
      setPanel({ brief: null, loading: true });
      void api<{ brief: DailyBrief | null; since: number; settings: BriefSettings }>(identity, `/api/brief?tz=${encodeURIComponent(tz())}`)
        .then((r) => !gone && (setPanel({ brief: r.brief, since: r.since }), setSettings(r.settings)))
        .catch(() => !gone && setPanel({ brief: null }));
    };
    addEventListener("friday:brief", ask);
    const close = () => setPanel(null);
    addEventListener("friday:brief-close", close);
    return () => {
      removeEventListener("friday:brief-close", close);
      gone = true;
      clearInterval(every);
      document.removeEventListener("visibilitychange", seen);
      removeEventListener("pagehide", seen);
      removeEventListener("friday:brief", ask);
    };
  }, [identity]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 15_000);
    return () => clearTimeout(t);
  }, [note]);

  const b = panel?.brief ?? null;
  const zone = b?.tz ?? settings?.tz ?? tz();
  return (
    <>
      {note && !panel && (
        <div className="db-note" role="status">
          <span>
            <b>{TITLE[note.kind]}</b> {note.headline}
          </span>
          <button type="button" className="btn small" onClick={() => (setNote(null), openBrief(note))}>
            Open
          </button>
        </div>
      )}
      <Sheet open={!!panel} onOpenChange={(o) => !o && setPanel(null)}>
        {/* Focus on the panel itself, not its first control: the Enter that sent /brief lifts on a switch otherwise. */}
        <SheetContent side="right" className="db-sheet" tabIndex={-1} onOpenAutoFocus={(e) => (e.preventDefault(), (e.currentTarget as HTMLElement).focus())}>
          <header className="db-sheet-head">
            <SheetTitle>{b ? TITLE[b.kind] : "Your brief"}</SheetTitle>
            <SheetDescription>{b ? `${sinceWord(b)} · ${b.headline}` : panel?.loading ? "Reading your sessions…" : panel?.since ? `Nothing new since ${clock(panel.since, zone)}.` : "Nothing new today."}</SheetDescription>
          </header>
          <div className="db-sheet-body">{b ? <BriefView brief={b} /> : !panel?.loading && <p className="tm-brief-quiet">No work finished, nothing at risk and nothing waiting on you.</p>}</div>
          {settings && <Schedule identity={identity} settings={settings} onChange={setSettings} />}
        </SheetContent>
      </Sheet>
    </>
  );
}
