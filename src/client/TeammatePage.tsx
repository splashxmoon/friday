/**
 * A teammate's own chat as their page (Arun, 2026-10-28: the critique's "a teammate's chat becomes a profile page with tabs: Chat ·
 * Activity · Results · Memory · Settings"): at the top who they are (their face, role, access, what they run on, their backup and
 * what they spent today) and where they work; under it the tabs. Chat is the conversation below; the others take its place
 * (teammates.css hides the feed after a page on another tab).
 *
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { FileIcon, FolderGit2Icon, GitPullRequestIcon, PlusIcon, RefreshCwIcon, ShieldIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ENGINE_NAMES, type EngineTool } from "../types.js";
import { EngineMark, FridayMark } from "./BrandMarks.js";
import { elapsed, useNow } from "./presence.js";
import { api } from "./api.js";
import { focusAgent } from "./agentFocus.js";
import type { Identity } from "./storage.js";
import { readActivity, type ActivityRun } from "./team-api.js";
import { plainLine } from "./team-room.js";
import { ACCESS, timeOf } from "./team-status.js";
import { describeCheckIn } from "../teammate-checkins.js";
import { base, Face, foldersOf, markOf, mateOn, mateStatus, modelLabel, refreshTeam, short, TeammateDialog, TeammateFolderCard, toolName, useTeamNow, workingSinceOf, type Team } from "./Teammates.js";

export type MateTab = "chat" | "activity" | "results" | "memory" | "settings";
const TABS: { id: MateTab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "activity", label: "Activity" },
  { id: "results", label: "Results" },
  { id: "memory", label: "Memory" },
  { id: "settings", label: "Settings" },
];

/** Which tab each teammate's page is on, for this visit: back on Chat when the page is next opened fresh. */
const tabs = new Map<string, MateTab>();
const watchers = new Set<() => void>();
let tabsVersion = 0;
export const setMateTab = (lane: string, tab: MateTab) => (tabs.set(lane, tab), tabsVersion++, watchers.forEach((f) => f()));
const useMateTab = (lane: string): MateTab => {
  useSyncExternalStore(
    (f) => (watchers.add(f), () => void watchers.delete(f)),
    () => tabsVersion,
  );
  return tabs.get(lane) ?? "chat";
};

/** "40m", "1h 5m": minutes as the page says them. */
// Under half a minute is "<1m", never "0m" (2026-10-28 QA).
const mins = (n: number) => (n < 0.5 ? "<1m" : n < 60 ? `${Math.round(n)}m` : `${Math.floor(n / 60)}h${Math.round(n % 60) ? ` ${Math.round(n % 60)}m` : ""}`);

export function TeammatePage({ lane, identity, notify, branch }: { lane: string; identity?: Identity; notify?: (m: string) => void; branch?: string }) {
  const t = useTeamNow();
  const m = mateOn(lane);
  const tab = useMateTab(lane);
  const [giving, setGiving] = useState(false);
  const addBtn = useRef<HTMLButtonElement>(null);
  const [roleOpen, setRoleOpen] = useState(false);
  const now = useNow();
  if (!m || !t) return null;
  const s = mateStatus(m);
  const lead = t.lead === m.lane;
  const access = ACCESS[m.mode ?? "full"];
  const today = m.usage?.today;
  const backup = m.tool === "friday" ? null : ENGINE_NAMES[m.backup ?? (m.tool === "claude" ? "codex" : "claude")];
  const longRole = (m.role?.length ?? 0) > 180 || (m.role ?? "").split("\n").length > 3;
  return (
    <div className="tm-page" data-tab={tab}>
      <header className="tm-head">
        <Face seed={m.look ?? m.name} size={56} status={m.status} lead={lead} />
        <div className="tm-head-text">
          <h2 className="tm-head-name">
            {m.name}
            {lead && <span className="tm-head-lead">Leads the crew</span>}
          </h2>
          {/* The live line under the name, in body size (DIRECTION.md §8), with how long it has been at it. */}
          <span className={`tm-head-status s-${s.state}`}>
            {s.line}
            {workingSinceOf(m) !== null && <span className="tm-head-elapsed"> · {elapsed(workingSinceOf(m)!, now)}</span>}
          </span>
          {m.role && (
            <p className={`tm-head-role${longRole && !roleOpen ? " clamped" : ""}`}>
              {m.role}
              {longRole && (
                <button type="button" className="tm-head-more" onClick={() => setRoleOpen(!roleOpen)}>
                  {roleOpen ? "Less" : "More"}
                </button>
              )}
            </p>
          )}
          {/* What they may do and run on, as facts in a row: buttons where a press changes it (Settings), plain text otherwise
              (Arun, 2026-10-28: the critique's "chips that are links look different from buttons"). */}
          <dl className="tm-facts">
            <div>
              <dt>Access</dt>
              <dd>
                <button type="button" className="tm-fact-btn" data-mode={m.mode ?? "full"} onClick={() => setMateTab(lane, "settings")} title={`${access.blurb} Change it in Settings.`}>
                  <ShieldIcon className="size-3" />
                  {access.label}
                </button>
              </dd>
            </div>
            <div>
              <dt>Runs on</dt>
              <dd title={m.model === "auto" ? "Smart routing: Friday picks the model for each message, from how hard it reads and how much of your limits is left." : undefined}>
                {/* The coding tool's mark is said here, once, not on the face (DIRECTION.md §6). */}
                {markOf(m.tool) ? <EngineMark tool={markOf(m.tool) as EngineTool} size={12} /> : <FridayMark size={12} />}
                {toolName(m.tool)} · {modelLabel(m.tool, m.model)}
              </dd>
            </div>
            {backup && (
              <div>
                <dt>Backup</dt>
                <dd>{backup}</dd>
              </div>
            )}
            {today && (
              <div>
                <dt>Today</dt>
                <dd>{today.turns ? `${today.turns} turn${today.turns === 1 ? "" : "s"}${today.minutes >= 1 ? ` · ${mins(today.minutes)}` : ""}` : "No turns yet"}</dd>
              </div>
            )}
          </dl>
          {m.held && identity && (
            <p className="tm-head-held">
              On hold: they wait until you lift it.{" "}
              <button type="button" className="tm-link" onClick={() => void api(identity, "/api/teammates/lift", { method: "POST", body: JSON.stringify({ id: m.id }), headers: { "Content-Type": "application/json" } }).then(() => refreshTeam(identity)).catch((e: Error) => notify?.(e.message))}>
                Lift the hold
              </button>
            </p>
          )}
          <div className="tm-head-where" aria-label="Where they work">
            <span className="tm-where-label">Works in</span>
            <span className="tm-chip own" title={`Their own folder, for their notes: ${m.folder}`}>
              <FolderGit2Icon className="size-3" />
              {base(m.folder)}
              <small>notes</small>
            </span>
            {foldersOf(m).map((d, i) => (
              <span key={d} className="tm-chip" title={d}>
                <FolderGit2Icon className="size-3" />
                <b>{base(d)}</b>
                {i === 0 && branch && <span className="tm-chip-branch">{branch}</span>}
                {identity && (
                  <button type="button" aria-label={`Stop ${m.name} working in ${short(d)}`} title="Take it away" onClick={() => void api(identity, `/api/teammates/${m.id}`, { method: "PATCH", body: JSON.stringify({ projects: foldersOf(m).filter((x) => x !== d) }), headers: { "Content-Type": "application/json" } }).then(() => refreshTeam(identity)).catch(() => {})}>
                    <XIcon className="size-3" />
                  </button>
                )}
              </span>
            ))}
            {identity && (
              <button type="button" ref={addBtn} className="tm-chip add" onClick={() => setGiving(true)}>
                <PlusIcon className="size-3" />
                Folder or repo
              </button>
            )}
            {giving && identity && <TeammateFolderCard identity={identity} lane={lane} trigger={addBtn.current} onClose={() => setGiving(false)} notify={notify ?? (() => {})} />}
          </div>
        </div>
      </header>
      <div className="tm-tabs" role="tablist" aria-label={`${m.name}'s page`}>
        {TABS.map((x) => (
          <button key={x.id} type="button" role="tab" id={`tm-tab-${x.id}`} aria-selected={tab === x.id} aria-controls={x.id === "chat" ? undefined : `tm-panel-${x.id}`} className="tm-tab" onClick={() => setMateTab(lane, x.id)}>
            {x.label}
          </button>
        ))}
      </div>
      {tab !== "chat" && identity && (
        <section className="tm-panel" id={`tm-panel-${tab}`} role="tabpanel" aria-labelledby={`tm-tab-${tab}`}>
          {tab === "activity" && <ActivityTab identity={identity} id={m.id} lane={lane} />}
          {tab === "results" && <ResultsTab identity={identity} id={m.id} lane={lane} />}
          {tab === "memory" && <MemoryEditor identity={identity} id={m.id} name={m.name} />}
          {tab === "settings" && (
            <>
              <TeammateDialog inline identity={identity} editing={m} onClose={() => {}} />
              {(m.checkins?.length ?? 0) > 0 && <p className="tm-sub tm-panel-note">{m.checkins!.map((c) => `${describeCheckIn(c)}: ${c.text}`).join(" · ")}</p>}
            </>
          )}
        </section>
      )}
    </div>
  );
}

/** Their runs over the last week, read once per visit to the tab; null while it is read, or when the server can't say. */
function useRuns(identity: Identity, id: string): { runs: ActivityRun[] | null; failed: boolean } {
  const [runs, setRuns] = useState<ActivityRun[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void readActivity(identity, id, 7).then((r) => {
      if (!live) return;
      if (r) setRuns(r.runs);
      else setFailed(true);
    });
    return () => void (live = false);
  }, [identity.id, id]); // eslint-disable-line react-hooks/exhaustive-deps
  return { runs, failed };
}

/** Opens where a run was: its room's chat, or theirs in the Team room, on Chat. */
function openRun(t: Team | null, r: ActivityRun, lane: string) {
  const room = t?.rooms?.find((x) => x.sid === r.sid);
  if (room) dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: room.sid, invite: room.invite } }));
  setMateTab(lane, "chat");
  focusAgent(r.sid, r.lane);
}

const dayOf = (ts: number) => {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
};

const OUTCOME: Record<string, string> = { done: "Finished", waiting: "Needs you", error: "Stopped on an error", running: "Working", stopped: "Was stopped" };

function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="tm-skel" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} style={{ width: `${86 - i * 14}%` }} />
      ))}
    </div>
  );
}

function ActivityTab({ identity, id, lane }: { identity: Identity; id: string; lane: string }) {
  const t = useTeamNow();
  const { runs, failed } = useRuns(identity, id);
  const days = useMemo(() => {
    const out = new Map<string, ActivityRun[]>();
    for (const r of runs ?? []) out.set(dayOf(r.startedAt), [...(out.get(dayOf(r.startedAt)) ?? []), r]);
    return [...out];
  }, [runs]);
  if (failed) return <p className="tm-panel-empty">Their activity shows here once this Friday is updated.</p>;
  if (!runs) return <Skeleton rows={4} />;
  if (!runs.length) return <p className="tm-panel-empty">Nothing in the last seven days. What they work on, anywhere, shows here.</p>;
  return (
    <div className="tm-act-days">
      {days.map(([day, list]) => (
        <section key={day} className="tm-day-group">
          <h4 className="tm-day-head">{day}</h4>
          <ul className="tm-runs">
            {list.map((r) => (
              <li key={`${r.sid}:${r.startedAt}`}>
                <button type="button" className="tm-run" data-outcome={r.outcome} onClick={() => openRun(t, r, lane)}>
                  <span className="tm-run-time">{new Date(r.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                  <span className="tm-run-main">
                    {/* Narrated, as Linear's activity log reads (DIRECTION.md §9.3): "Finished in Crew room · 3m · 1 file". */}
                    <span className="tm-run-meta">
                      <b className="tm-run-word">{OUTCOME[r.outcome] ?? r.outcome}</b>
                      {["done", "running", "stopped"].includes(r.outcome) ? " in " : " · "}
                      {r.room ?? "Crew room"}
                      {r.endedAt ? ` · ${mins((r.endedAt - r.startedAt) / 60_000)}` : ""}
                      {r.files.length ? ` · ${r.files.length} file${r.files.length === 1 ? "" : "s"}` : ""}
                    </span>
                    {/* Its words as a line, their markdown gone (2026-10-28 QA: fences, ** and table pipes showed as typed). */}
                    {r.said && <span className="tm-run-said">{plainLine(r.said)}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Pull requests named in what they said: GitHub's /pull/N links. */
const prsIn = (text: string) => [...new Set(text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? [])];

function ResultsTab({ identity, id, lane }: { identity: Identity; id: string; lane: string }) {
  const t = useTeamNow();
  const { runs, failed } = useRuns(identity, id);
  const files = useMemo(() => {
    const seen = new Map<string, ActivityRun>();
    for (const r of runs ?? []) for (const f of r.files) if (!seen.has(f)) seen.set(f, r);
    return [...seen];
  }, [runs]);
  const prs = useMemo(() => (runs ?? []).flatMap((r) => prsIn(r.said).map((u) => ({ u, r }))), [runs]);
  if (failed) return <p className="tm-panel-empty">Their results show here once this Friday is updated.</p>;
  if (!runs) return <Skeleton rows={3} />;
  if (!files.length && !prs.length) return <p className="tm-panel-empty">No files changed or pull requests in the last seven days.</p>;
  return (
    <div className="tm-results">
      {prs.length > 0 && (
        <section>
          <h4 className="tm-day-head">Pull requests</h4>
          <ul className="tm-result-list">
            {prs.map(({ u, r }) => (
              <li key={u}>
                <a className="tm-result" href={u} target="_blank" rel="noreferrer">
                  <GitPullRequestIcon className="size-3.5" />
                  <span className="tm-result-name">PR #{/\/pull\/(\d+)/.exec(u)![1]}</span>
                  <span className="tm-result-where">{u.replace(/^https:\/\/github\.com\//, "").replace(/\/pull\/\d+$/, "")}</span>
                  <span className="tm-result-when">{timeOf(r.startedAt)}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {files.length > 0 && (
        <section>
          <h4 className="tm-day-head">Files changed · {files.length}</h4>
          <ul className="tm-result-list">
            {files.slice(0, 60).map(([f, r]) => (
              <li key={f}>
                <button type="button" className="tm-result" onClick={() => openRun(t, r, lane)} title={f}>
                  <FileIcon className="size-3.5" />
                  <span className="tm-result-name">{base(f)}</span>
                  <span className="tm-result-where">{short(f.split("/").slice(0, -1).join("/") || ".")}</span>
                  <span className="tm-result-when">
                    {r.room ?? "Crew room"} · {timeOf(r.startedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * Their memory (MEMORY.md), read and changed in place: when it was last written, and never saved over a change made since it was
 * read (Arun, 2026-10-28: the logic audit's "a failed GET leaves the text null and Save disabled; send the loaded text's mtime
 * with the PUT; the server returns 409 on a change, and the dialog then offers a reload").
 */
/**
 * An edit to a teammate's memory not saved yet, kept for this page's life by whom it is for: switching to Settings and back, or to
 * another teammate, dropped it without a word (QA, 2026-10-28; Arun: "TEST EVERYTHING… EVERY INTERACTION"). Back on Memory it is
 * in the box again, said so, with a way to drop it.
 */
const memoryDrafts = new Map<string, string>();

export function MemoryEditor({ identity, id, name }: { identity: Identity; id: string; name: string }) {
  const [text, setText] = useState<string | null>(null);
  const [kept, setKept] = useState(false);
  const [mtime, setMtime] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setText(null);
    setErr("");
    void api<{ text: string; mtime?: number | null }>(identity, `/api/teammates/${id}/memory`)
      .then((r) => {
        if (!live) return;
        const draft = memoryDrafts.get(id);
        setMtime(r.mtime ?? null);
        setStale(false);
        // Its unsaved edit, put back, unless it is what is saved now anyway.
        if (draft !== undefined && draft !== r.text) (setText(draft), setDirty(true), setKept(true));
        else (memoryDrafts.delete(id), setText(r.text), setDirty(false), setKept(false));
      })
      // Not read: nothing to save over it with, so the box stays shut (an empty one saved would wipe what they remember).
      .catch((e: Error) => live && setErr(`Couldn't read ${name}'s memory: ${e.message}`));
    return () => void (live = false);
  }, [identity.id, id, n]); // eslint-disable-line react-hooks/exhaustive-deps
  // Unsaved, it is kept as it is typed, and closing the window asks first.
  useEffect(() => {
    if (text === null) return;
    if (!dirty) return void memoryDrafts.delete(id);
    memoryDrafts.set(id, text);
    const unload = (e: BeforeUnloadEvent) => (e.preventDefault(), (e.returnValue = ""));
    addEventListener("beforeunload", unload);
    return () => removeEventListener("beforeunload", unload);
  }, [dirty, text, id]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (text === null) return;
    setBusy(true);
    setErr("");
    try {
      // Fetched here, not through api(): a 409 is an answer to act on (its text changed since it was read), not an error to show.
      const res = await fetch(`/api/teammates/${id}/memory`, { method: "PUT", credentials: "same-origin", body: JSON.stringify({ text, ...(stale ? {} : { mtime }) }), headers: { "Content-Type": "application/json" } });
      const r = (await res.json().catch(() => ({}))) as { text?: string; mtime?: number | null; error?: string };
      if (res.status === 409) return setStale(true);
      if (!res.ok) throw new Error(r.error ?? "Couldn't save their memory. Try again.");
      setMtime(r.mtime ?? Date.now());
      setStale(false);
      setDirty(false);
      setKept(false);
      memoryDrafts.delete(id);
      setSaved(true);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="tm-memory-form" onSubmit={(e) => void save(e)}>
      <div className="tm-memory-head">
        <p>What they keep between conversations, read with every message they get. They add to it as they learn; change anything here.</p>
        <span className="tm-sub">{text === null ? "" : mtime ? `Last updated ${timeOf(mtime)}` : text ? "" : "Empty so far"}</span>
      </div>
      <Textarea
        className="tm-memory"
        aria-label={`${name}'s memory`}
        value={text ?? ""}
        disabled={text === null}
        rows={14}
        placeholder={text === null ? (err ? "" : "Reading…") : "Nothing yet. They write here what they'll want next time: how you like things, where things are, what didn't work."}
        onChange={(e) => (setText(e.target.value), setDirty(true), setSaved(false))}
      />
      {kept && dirty && (
        <p className="tm-note" role="status">
          Your edit from before isn't saved yet: it's in the box.
          <button type="button" className="tm-link" onClick={() => (memoryDrafts.delete(id), setKept(false), setN((x) => x + 1))}>
            Drop it
          </button>
        </p>
      )}
      {stale && (
        <p className="tm-note" role="alert">
          {name} changed their memory since you opened it. Reload to see theirs (your edit is lost), or save to replace it with yours.
          <button type="button" className="tm-link" onClick={() => setN((x) => x + 1)}>
            <RefreshCwIcon className="size-3" /> Reload
          </button>
        </p>
      )}
      {err && (
        <p role="alert" className="tm-err">
          {err}{" "}
          <button type="button" className="tm-link" onClick={() => setN((x) => x + 1)}>
            Try again
          </button>
        </p>
      )}
      <div className="tm-inline-foot">
        {saved && !dirty && (
          <span className="tm-saved" role="status">
            Saved
          </span>
        )}
        <Button type="submit" disabled={busy || text === null || !dirty}>
          {busy ? "Saving…" : stale ? "Save mine anyway" : "Save memory"}
        </Button>
      </div>
    </form>
  );
}
