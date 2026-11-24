/**
 * Today on Home (src/today.ts, src/found-work.ts; Arun, 2026-11-21: "1. Speed baseline, Today with Tonight, and proof clips.", spec 10 A).
 * Three parts, each shown only when it has something:
 * - Last night: what the night's queue did, the most pressing first (a question, a failure), each one press from its chat.
 * - Found for you: work Friday found in the repos you've been in (an issue assigned to you, CI broken or flaky on main, a package with a
 *   known vulnerability, a TODO you left weeks ago), each with Start and Tonight, and × to put it away for good.
 * - Tonight: what is queued to start tonight, when, about how long it takes, and whether the coding tool's limits have room.
 *
 * Tonight is Run later at 1 AM (later.ts): it starts only while Friday is running, and a task whose time passed while it wasn't is
 * shown as missed, never started late on a surprise. Start and Tonight use the coding tool, mode and account picked in the box above.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fileUrl } from "./api.js";
import { Lightbox } from "./Lightbox.js";
import { recordProofClip } from "./proof-clips.js";
import { Icon, type IconName } from "./icons.js";
import type { Identity } from "./storage.js";
import { preferredAccount } from "./Accounts.js";
import { useToolLimits } from "./toolLimits.js";
import { cancelLater, queueLater, runLaterNow, zoneName } from "./ide/later.js";
import type { LaterBox } from "./ide/RunLater.js";
import { describeAt, isNightAt, tonightAt } from "../later.js";
import { aboutMinutes, type FoundItem, type FoundKind } from "../found-work.js";
import { fitLine, type FitWindow, type LandedRow, type LandedState, type Today as TodayData } from "../today.js";
import { ENGINE_NAMES, type EngineMode, type EngineTool } from "../types.js";
import type { Limits } from "../runner/limits.js";
import "./today.css";

const KIND_ICON: Record<FoundKind, IconName> = { broken: "x", advisory: "shield", issue: "flag", flaky: "refresh", todo: "pencil" };
const STATE_WORDS: Record<LandedState, string> = {
  working: "Still working",
  needs: "Needs you",
  ready: "Ready to commit",
  pr: "Pull request open",
  merged: "Merged",
  nothing: "Finished, nothing changed",
  failed: "Didn't finish",
  gone: "Its chat was deleted",
};
const base = (folder: string) => folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const open = (sid?: string, invite?: string) => sid && invite && dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid, invite } }));

/** A tool's limit windows as Today reads them (fitLine), from the limits the rail already reads. */
function windowsOf(l: Limits | null | "none", tool: EngineTool): FitWindow[] {
  if (!l || l === "none") return [];
  if (tool === "claude") return (l.claudeWindows ?? []).filter((w) => w.kind === "five_hour" || w.kind === "seven_day").map((w) => ({ minutes: w.kind === "five_hour" ? 300 : 10080, used: w.utilization === null ? null : w.utilization * 100, resetsAt: w.resetsAt }));
  if (tool === "codex") return (l.codexWindows ?? []).map((w) => ({ minutes: w.windowMinutes ?? 0, used: w.usedPercent, resetsAt: w.resetsAt }));
  return [];
}

function landedFacts(r: LandedRow): string {
  const bits = [STATE_WORDS[r.state]];
  if (r.files) bits.push(`+${r.additions ?? 0} −${r.deletions ?? 0} · ${r.files} file${r.files === 1 ? "" : "s"}`);
  if (r.checks) bits.push(r.checks.ok ? "tests pass" : "tests fail");
  if (r.review) bits.push(r.review.ok ? "reviewed" : "review found issues");
  if (r.note && (r.state === "failed" || r.state === "needs")) bits.push(r.note);
  return bits.join(" · ");
}

export function Today({ identity, tool, mode, fullAccess, model, box = {} }: { identity: Identity; tool: EngineTool | ""; mode: EngineMode; fullAccess: boolean; model: string; box?: LaterBox }) {
  const [data, setData] = useState<TodayData | null>(null);
  const [looking, setLooking] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [big, setBig] = useState<{ src: string; alt: string; file: string }[] | null>(null);
  const gone = useRef(false);
  const limits = useToolLimits(identity);
  const tz = zoneName();

  const read = useCallback(
    (fresh = false) => {
      if (fresh) setLooking(true);
      return api<TodayData>(identity, `/api/today${fresh ? "?fresh=1" : ""}`)
        .then((r) => !gone.current && setData(r), () => {})
        .finally(() => !gone.current && setLooking(false));
    },
    [identity.id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    gone.current = false;
    void read();
    const t = setInterval(() => document.visibilityState === "visible" && void read(), 60_000);
    const back = () => document.visibilityState === "visible" && void read();
    document.addEventListener("visibilitychange", back);
    return () => ((gone.current = true), clearInterval(t), document.removeEventListener("visibilitychange", back));
  }, [read]);

  if (!data) return null;
  const { landed, found, tonight } = data;
  const why = !tool ? "Pick a coding tool in the box above first." : "";

  /** Queue a found row: at a time (Tonight), or now and opened (Start). The row goes from Found once it is queued. */
  const take = async (f: FoundItem, now: boolean) => {
    if (why || busy) return;
    setBusy(f.id);
    setErr("");
    try {
      const ac = box.account || preferredAccount(tool as EngineTool, box.accounts);
      const account = ac !== "default" && box.accounts?.some((x) => x.id === ac) ? ac : "";
      const effort = box.effort && box.levels?.includes(box.effort) ? box.effort : null;
      const at = now ? Date.now() : (tonight[0]?.at ?? tonightAt(Date.now(), tz, 1));
      const { task } = await queueLater(identity, {
        folder: f.folder,
        ask: f.ask,
        tool: tool as EngineTool,
        mode,
        fullAccess,
        title: f.issue ? `#${f.issue.number} ${f.issue.title}` : f.title,
        ...(model ? { model } : {}),
        ...(account ? { account } : {}),
        ...(effort ? { effort } : {}),
        ...(f.issue ? { issue: f.issue } : {}),
        at,
      });
      await api(identity, "/api/today/skip", { method: "POST", body: JSON.stringify({ id: f.id, task: task.id, size: f.size }) });
      if (now) {
        const r = await runLaterNow(identity, task.id).catch((e: Error) => e);
        const t = r instanceof Error ? null : (r as { task?: { sid?: string; invite?: string; note?: string; status?: string } }).task;
        if (r instanceof Error || t?.status === "failed") setErr((r instanceof Error ? r.message : t?.note) || "It didn't start.");
        else open(t?.sid, t?.invite);
      }
      await read();
    } catch (e) {
      setErr((e as Error).message || "It couldn't be queued.");
    } finally {
      setBusy("");
    }
  };
  const putAway = async (f: FoundItem) => {
    setData((d) => d && { ...d, found: d.found.filter((x) => x.id !== f.id) });
    await api(identity, "/api/today/skip", { method: "POST", body: JSON.stringify({ id: f.id }) }).catch(() => {});
  };
  const unqueue = async (id: string) => {
    setBusy(id);
    setErr("");
    try {
      await cancelLater(identity, id);
      await read();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const minutes = tonight.reduce((n, t) => n + t.minutes, 0);
  const tools = [...new Set(tonight.map((t) => t.tool))];
  const fits = tonight.length ? tools.map((t) => fitLine(ENGINE_NAMES[t], windowsOf(limits, t), tonight[0]!.at, clock)).filter(Boolean).join(". ") : "";
  if (!landed.length && !found.length && !tonight.length) return null;

  return (
    <section className="td-card" aria-label="Today">
      {landed.length > 0 && (
        <>
          <div className="td-head">
            <h2>{landed.every((r) => isNightAt(r.startedAt, tz)) ? "Last night" : "From your queue"}</h2>
            <span className="td-count">{landed.length}</span>
          </div>
          <ul className="td-list">
            {landed.map((r) => (
              <li key={r.task} className="td-row" data-state={r.state}>
                {r.clip?.file && r.sid && r.invite ? (
                  <ClipThumb
                    src={fileUrl(r.sid, r.invite, r.clip.file)}
                    page={r.clip.page ?? "/"}
                    seconds={Math.max(1, Math.round((r.clip.durationMs ?? 0) / 1000))}
                    onOpen={(src, alt) =>
                      setBig([
                        { src, alt: `After · ${alt}`, file: "after.webm" },
                        ...(r.clip?.before ? [{ src: fileUrl(r.sid!, r.invite!, r.clip.before), alt: `Before · ${alt}`, file: "before.webm" }] : []),
                        ...(r.clip?.phone ? [{ src: fileUrl(r.sid!, r.invite!, r.clip.phone), alt: `At a phone's width · ${alt}`, file: "phone.webm" }] : []),
                      ])
                    }
                  />
                ) : (
                  <span className="td-dot" aria-hidden="true">
                    {r.state === "ready" || r.state === "merged" || r.state === "pr" ? <Icon name="check" size={10} /> : null}
                  </span>
                )}
                <span className="td-text">
                  <span className="td-title">{r.title}</span>
                  <span className="td-meta" title={r.clip?.failed ? `No clip: ${r.clip.failed}` : undefined}>
                    {base(r.folder)} · {landedFacts(r)}
                    {r.clip?.making ? " · recording a clip…" : ""}
                    {r.clip?.marks?.[0] ? ` · ${r.clip.marks[0].label}` : ""}
                  </span>
                </span>
                {r.clipable && r.sid && r.invite && !r.clip?.making && (
                  <button
                    type="button"
                    className="td-x shown"
                    aria-label={`Record a proof clip of ${r.title}`}
                    title="Record a proof clip: Friday walks the page this changed and says what was changed"
                    disabled={busy === `clip-${r.task}`}
                    onClick={() => {
                      setBusy(`clip-${r.task}`);
                      void recordProofClip(r.sid!, r.invite!, "main").then(
                        () => (setBusy(""), void read()),
                        (e: Error) => (setBusy(""), setErr(e.message)),
                      );
                    }}
                  >
                    <Icon name="play" size={12} />
                  </button>
                )}
                {r.pr && !r.pr.merged ? (
                  <a className="td-go" href={r.pr.url} target="_blank" rel="noreferrer">
                    See the pull request
                  </a>
                ) : r.sid && r.invite && r.state !== "gone" ? (
                  <button type="button" className={r.state === "needs" ? "td-go primary" : "td-go"} onClick={() => open(r.sid, r.invite)}>
                    {r.state === "needs" ? "Answer" : r.state === "ready" ? "Review" : "Open"}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Only when there is something to offer (Arun, 2026-11-22: "honestly get rid of this", of the "Nothing needs doing in…" line): no
          heading or empty line while Friday looks, or when it found nothing. */}
      {found.length > 0 && (
        <>
        <div className="td-head">
          <h2>Found for you</h2>
          <span className="td-count">{found.length}</span>
          <button type="button" className="td-link" disabled={looking} onClick={() => void read(true)}>
            {looking ? "Looking…" : "Look again"}
          </button>
        </div>
        <ul className="td-list">
          {found.map((f) => (
            <li key={f.id} className="td-row td-found" data-kind={f.kind}>
              <span className="td-kind" aria-hidden="true">
                <Icon name={KIND_ICON[f.kind]} size={13} />
              </span>
              <span className="td-text">
                <span className="td-title">
                  {f.url ? (
                    <a href={f.url} target="_blank" rel="noreferrer" title="Open on GitHub">
                      {f.title}
                    </a>
                  ) : (
                    f.title
                  )}
                </span>
                <span className="td-meta">
                  {f.repo.split("/").pop()} · {f.why}
                </span>
              </span>
              <span className="td-size" title={`About ${aboutMinutes(f.minutes).replace("about ", "")} for an agent`}>
                {f.size}
              </span>
              <span className="td-acts">
                <button type="button" className="td-go" disabled={!!why || !!busy} title={why || undefined} onClick={() => void take(f, false)}>
                  Tonight
                </button>
                <button type="button" className="td-go primary" disabled={!!why || !!busy} title={why || undefined} onClick={() => void take(f, true)}>
                  {busy === f.id ? "Starting…" : "Start"}
                </button>
                <button type="button" className="td-x" aria-label={`Put away: ${f.title}`} title="Put away" onClick={() => void putAway(f)}>
                  <Icon name="x" size={12} />
                </button>
              </span>
            </li>
          ))}
        </ul>
        </>
      )}

      {tonight.length > 0 && (
        <>
          <div className="td-head">
            <h2>Tonight</h2>
            <span className="td-count">
              {describeAt(tonight[0]!.at, Date.now(), tz).replace(/^tonight at /i, "")} · {aboutMinutes(minutes)} of agent time
            </span>
          </div>
          <ul className="td-list">
            {tonight.map((t) => (
              <li key={t.id} className="td-row td-night">
                <span className="td-kind" aria-hidden="true">
                  <Icon name="clock" size={13} />
                </span>
                <span className="td-text">
                  <span className="td-title">{t.title}</span>
                  <span className="td-meta">
                    {base(t.folder)} · {ENGINE_NAMES[t.tool]} · {clock(t.at)}
                  </span>
                </span>
                <button type="button" className="td-x shown" aria-label={`Don't run tonight: ${t.title}`} title="Don't run it" disabled={busy === t.id} onClick={() => void unqueue(t.id)}>
                  <Icon name="x" size={12} />
                </button>
              </li>
            ))}
          </ul>
          <p className="td-note">{[fits, "Starts only while Friday is running; your computer is kept awake for it."].filter(Boolean).join(". ")}</p>
        </>
      )}
      {big && <Lightbox items={big} onClose={() => setBig(null)} />}
      {err && (
        <p role="alert" className="td-err">
          {err}
        </p>
      )}
    </section>
  );
}

/** A night's proof clip as the row's lead: a few seconds of the page it changed, playing quietly; opens large. Still under reduced motion. */
function ClipThumb({ src, page, seconds, onOpen }: { src: string; page: string; seconds: number; onOpen: (src: string, alt: string) => void }) {
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const alt = `A ${seconds}-second clip of ${page === "/" ? "the home page" : page}`;
  return (
    <button type="button" className="td-clip" aria-label={`Play large: ${alt}`} onClick={() => onOpen(src, alt)}>
      <video src={src} muted loop playsInline autoPlay={!still} preload={still ? "metadata" : "auto"} aria-hidden="true" />
      <span className="td-clip-cap">{seconds}s</span>
    </button>
  );
}
