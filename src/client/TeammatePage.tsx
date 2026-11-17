/**
 * A teammate's own chat as their page (Arun, 2026-10-28: the critique's "a teammate's chat becomes a profile page with tabs: Chat ·
 * Activity · Results · Memory · Settings"): at the top who they are (their face, role, access, what they run on, their backup and
 * what they spent today) and where they work; under it the tabs. Chat is the conversation below; the others take its place
 * (teammates.css hides the feed after a page on another tab).
 *
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, FileIcon, PencilIcon, FolderGit2Icon, GitPullRequestIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { ENGINE_NAMES, type EngineTool } from "../types.js";
import { EngineMark, FridayMark } from "./BrandMarks.js";
import { elapsed, useNow } from "./presence.js";
import { api } from "./api.js";
import { focusAgent } from "./agentFocus.js";
import type { Identity } from "./storage.js";
import { readActivity, type ActivityRun } from "./team-api.js";
import { ProofToggle } from "./ProofCard.js";
import { plainLine } from "./team-room.js";
import { ACCESS, freeLine, roleWord, timeOf } from "./team-status.js";
import { shortTokens } from "../tool-usage.js";
import { fallbacksOf, MAX_BACKUPS, type Fallback } from "../teammate-backups.js";
import { ENGINE_TOOLS } from "../types.js";
import { installedOn } from "./local.js";
import { isLocal } from "./edition.js";
import { describeCheckIn } from "../teammate-checkins.js";
import { SkillsPanel, usable, useSkills } from "./CrewSkills.js";
import { askRemove } from "./mate-menu.js";
import { SpendPage } from "./SpendPage.js";
import { DecisionsPage } from "./DecisionsPage.js";
import { MateRoutines } from "./MateRoutines.js";
import { MateMemory } from "./MateMemory.js";
import { Icon } from "./icons.js";
import { MenuButton, Switch, useConfirm, type MenuItem } from "./ui.js";
import { base, Face, foldersOf, markOf, mateOn, mateStatus, MATE_CATS, modelLabel, mateThreads, MateRing, refreshTeam, setFolders, teamNow, TeammatePicker, short, TeammateFolderCard, TeammateForm, toolName, useTeamNow, workingSinceOf, type MateCat, type RoomView, type Team } from "./Teammates.js";

import { setMateTab, useMateTab, type MateTab } from "./mate-tab.js";
export { setMateTab, useMateTab, type MateTab };
const TABS: { id: MateTab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "activity", label: "Activity" },
  { id: "results", label: "Results" },
  { id: "skills", label: "Skills" },
  { id: "memory", label: "Memory" },
];

/** The category its Settings panel opens on, when something asked for one (the Access fact opens Access). */
let nextCat: MateCat = "profile";
/** A crew mate's Settings panel, opened on a category (Arun, 2026-11-13: "a settings button in the header that opens a side panel"). */
export const openMateSettings = (lane: string, cat: MateCat = "profile") => ((nextCat = cat), setMateTab(lane, "settings"));

/** What a settings row opens: one of its categories, or its memory or skills, as a page of the panel. */
type MatePage = MateCat | "memory" | "skills" | "look" | "activity" | "results" | "fallbacks" | "spend" | "decisions";
const PAGE_LABEL: Record<MatePage, string> = { ...Object.fromEntries(MATE_CATS.map((c) => [c.id, c.label])), memory: "Memory", skills: "Skills", look: "Face", activity: "Activity", results: "Results", fallbacks: "Fallbacks", spend: "Spend", decisions: "Decisions" } as Record<MatePage, string>;

/**
 * A crew mate's settings, as a tab of its chat's side panel (Arun, 2026-11-13: "make the settings panel work like this"), laid out
 * as the reference he sent (2026-11-15: "i kinda want our agent settings thing to be designed like this too"): its face at the top
 * with a pencil to change it, its name and instructions written in place and kept when you leave the field, then grouped rows,
 * Brain, Knows, Does and Rules, each with an icon, what it is set to now and a chevron, opening as a page of the panel with Back.
 */
export function MateSettingsBody({ identity, lane }: { identity: Identity; lane: string }) {
  const m = mateOn(lane);
  const t = useTeamNow();
  const skills = useSkills();
  const [open, setOpen] = useState<MatePage | null>(nextCat === "profile" ? null : nextCat);
  const [ask, confirmUI] = useConfirm();
  useEffect(() => void (nextCat = "profile"), []);
  if (!m) return null;
  let computer = null as { label: string; connected: boolean } | null;
  const dirs = foldersOf(m);
  const mine = skills ? skills.filter((s) => !s.proposed && !s.revises && usable(s, m.id, t?.teammates ?? [])).length : null;
  const s = mateStatus(m);
  const today = m.usage?.today;
  const first = m.checkins?.[0];
  // Its settings in categories, each a row with what it is set to now (Arun, 2026-11-15: "get rid of this grid layout thing, add
  // back the categories").
  type Row = { id: MatePage; label: string; icon: ReactElement; now?: string; mark?: ReactElement };
  const groups: { name: string; rows: Row[] }[] = [
    {
      name: "Brain",
      rows: [
        { id: "tool", label: "Model", icon: <Icon name="bulb" size={16} />, ...(m.tool === "friday" ? {} : { mark: <EngineMark tool={m.tool} size={13} /> }), now: `${toolName(m.tool)} · ${modelLabel(m.tool, m.model)}` },
        ...(m.tool === "friday" ? [] : [{ id: "fallbacks" as const, label: "Fallbacks", icon: <Icon name="handoff" size={16} />, ...(fallbacksOf(m)[0] ? { mark: <EngineMark tool={fallbacksOf(m)[0]!.tool} size={13} /> } : {}), now: `${m.onLimit === "ask" ? "Ask first · " : ""}${fallbacksOf(m).map((f) => (f.model ? modelLabel(f.tool, f.model) : ENGINE_NAMES[f.tool])).join(", then ")}` }]),
      ],
    },
    {
      name: "Knows",
      rows: [
        { id: "memory", label: "Memory", icon: <Icon name="memory" size={16} /> },
        { id: "skills", label: "Skills", icon: <Icon name="skills" size={16} />, ...(mine === null ? {} : { now: mine ? `${mine} it can use` : "None yet" }) },
      ],
    },
    {
      name: "Does",
      rows: [
        { id: "activity", label: "Activity", icon: <Icon name="chart" size={16} />, ...(today?.turns ? { now: `${today.turns} ${today.turns === 1 ? "turn" : "turns"} today` } : {}) },
        { id: "results", label: "Results", icon: <Icon name="flag" size={16} /> },
        { id: "checkins", label: "Routines", icon: <Icon name="clock" size={16} />, now: m.checkins?.length ? `${m.checkins.filter((c) => !c.off).length} on${m.checkins.some((c) => c.off) ? ` · ${m.checkins.filter((c) => c.off).length} off` : ""}` : "None" },
        // Every token it used, by kind, model, day and run, at list price (SpendPage.tsx).
        { id: "spend", label: "Spend", icon: <Icon name="chart" size={16} />, ...(today?.tokens ? { now: `${shortTokens(today.tokens)} tokens today` } : {}) },
        { id: "budget", label: "Budget and hours", icon: <Icon name="usage" size={16} />, now: m.budget?.tokens ? `${shortTokens(m.budget.tokens)} tokens a day` : m.budget?.usd ? `$${m.budget.usd} a day` : "No caps" },
      ],
    },
    {
      name: "Rules",
      rows: [
        { id: "access", label: "Access", icon: <Icon name="shield" size={16} />, now: ACCESS[m.mode ?? "full"].label },
        // What it may do on its own now, and every go-ahead it asked (DecisionsPage.tsx).
        { id: "decisions", label: "Decisions", icon: <Icon name="check" size={16} />, ...(m.trust?.length ? { now: `${m.trust.length} on its own` } : {}) },
        { id: "where", label: "Folders", icon: <Icon name="folder" size={16} />, now: dirs.length ? `Its own and ${dirs.length} more` : "Its own" },
        { id: "computer", label: "Computer", icon: <Icon name="server" size={16} />, now: computer ? `${computer.label}${computer.connected ? "" : " · not connected"}` : "This computer" },
      ],
    },
  ];
  // A category opens as a page of the panel, with the way back to the list (Arun, 2026-11-13: "dont make these dropdowns but
  // instead it will be the side panel like a new page with a back button").
  if (open)
    return (
      <section className="msd" aria-label={`${m.name}'s profile`}>
        {/* Just "Back", its highlight its own size (Arun, 2026-11-13: "the hover highlight shouldnt be full width ... say back"). */}
        <button type="button" className="msd-back" onClick={() => setOpen(null)} aria-label="Back to the profile">
          <ChevronLeftIcon aria-hidden="true" />
          Back
        </button>
        <div className="msd-page" key={open} aria-label={PAGE_LABEL[open]}>
          {open === "where" ? <MateFolders identity={identity} lane={lane} /> : open === "checkins" ? <MateRoutines identity={identity} lane={lane} /> : open === "fallbacks" ? <MateFallbacks identity={identity} lane={lane} /> : open === "activity" ? <ActivityTab identity={identity} id={m.id} lane={lane} /> : open === "results" ? <ResultsTab identity={identity} id={m.id} lane={lane} /> : open === "memory" ? <MateMemory identity={identity} id={m.id} name={m.name} /> : open === "skills" ? <SkillsPanel mate={m} /> : open === "spend" ? <SpendPage identity={identity} query={`mate=${encodeURIComponent(m.id)}`} who={m.name} /> : open === "decisions" ? <DecisionsPage identity={identity} id={m.id} name={m.name} /> : <TeammateForm inline only={open} identity={identity} editing={m} />}
        </div>
      </section>
    );
  return (
    <section className="msd msd-home" aria-label={`${m.name}'s profile`}>
      <MateWords key={m.id} identity={identity} lane={lane} onFace={() => setOpen("look")} status={s.line} />
      {groups.map((g) => (
        <div key={g.name} className="msd-group">
          <h3 className="msd-group-name">{g.name}</h3>
          <ul className="msd-rows">
            {g.rows.map((r) => (
              <li key={r.label}>
                <button type="button" className="msd-row" onClick={() => setOpen(r.id)}>
                  <span className="msd-row-icon" aria-hidden="true">{r.icon}</span>
                  <span className="msd-row-label">{r.label}</span>
                  {r.now && (
                    <span className="msd-row-now">
                      {r.mark && <span className="msd-row-mark">{r.mark}</span>}
                      <span className="msd-row-now-t">{r.now}</span>
                    </span>
                  )}
                  <ChevronRightIcon className="msd-row-chev" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <button type="button" className="msd-remove" onClick={() => askRemove({ identity, mate: m, ask })}>
        Remove {m.name} from the crew
      </button>
      {confirmUI}
    </section>
  );
}

/**
 * Its name and its instructions, written in place at the top of its settings: each kept when you leave its field (or press Enter
 * in the name), with what went wrong said under it and the field put back.
 */
function MateWords({ identity, lane, onFace, status }: { identity: Identity; lane: string; onFace: () => void; status: string }) {
  const m = mateOn(lane)!;
  const [name, setName] = useState(m.name);
  const [role, setRole] = useState(m.role ?? "");
  const [err, setErr] = useState<{ field: "name" | "role"; text: string } | null>(null);
  const [kept, setKept] = useState<"name" | "role" | null>(null);
  const uid = useId();
  const keep = async (field: "name" | "role", value: string) => {
    const was = field === "name" ? m.name : (m.role ?? "");
    if (value.trim() === was.trim()) return;
    if (field === "name" && !value.trim()) return setName(m.name);
    setErr(null);
    try {
      await api(identity, `/api/teammates/${m.id}`, { method: "PATCH", body: JSON.stringify({ [field]: value.trim() }), headers: { "Content-Type": "application/json" } });
      await refreshTeam(identity);
      setKept(field);
      setTimeout(() => setKept((k) => (k === field ? null : k)), 1800);
    } catch (e) {
      setErr({ field, text: (e as Error).message || "That didn't save. Try again." });
      if (field === "name") setName(m.name);
      else setRole(m.role ?? "");
    }
  };
  const word = roleWord(m.role ?? "");
  return (
    <>
      <div className="msd-id">
        <button type="button" className="msd-id-face" onClick={onFace} aria-label={`Change ${m.name}'s face`} title="Change its face">
          <Face seed={m.look ?? m.name} size={52} />
          <span className="msd-id-pencil" aria-hidden="true">
            <PencilIcon />
          </span>
        </button>
        <div className="msd-id-text">
          {/* The name reads as a heading and is edited where it stands. */}
          <input
            className="msd-id-name"
            value={name}
            maxLength={40}
            aria-label="Name"
            aria-invalid={err?.field === "name"}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void keep("name", name)}
            onKeyDown={(e) => {
              if (e.key === "Escape") (setName(m.name), e.currentTarget.blur());
              if (e.key === "Enter" && !e.nativeEvent.isComposing) (e.preventDefault(), e.currentTarget.blur());
            }}
          />
          <span className="msd-id-line">
            {kept === "name" ? (
              <em role="status">Saved</em>
            ) : (
              <>
                {word && <b>{word}</b>}
                <span title={status}>{status}</span>
              </>
            )}
          </span>
        </div>
      </div>
      {err?.field === "name" && <small className="msd-err" role="alert">{err.text}</small>}
      <div className="msd-field">
        <label htmlFor={`${uid}-role`}>
          What {m.name} does{kept === "role" && <em role="status"> · Saved</em>}
        </label>
        <Textarea id={`${uid}-role`} value={role} maxLength={4000} rows={3} placeholder="Keeps an eye on competitors, writes the weekly update, and takes the busywork I hand over." onChange={(e) => setRole(e.target.value)} onBlur={() => void keep("role", role)} aria-invalid={err?.field === "role"} />
        {err?.field === "role" ? <small className="msd-err" role="alert">{err.text}</small> : <small>Read with every message it gets. Kept when you click away.</small>}
      </div>
    </>
  );
}

/**
 * What a crew mate goes on with when its tool runs out of usage (Arun, 2026-11-15: "add function to ask before switching to another
 * model/tool and add orders of fallbacks ... like claude to codex as a fall back for codex, yk like open code"): whether it switches
 * on its own or asks you first, and its fallbacks in order, each moved up or down or taken away, with the tools this computer has
 * to add. Kept as you change it; it goes back to its own tool when that limit lifts.
 */
function MateFallbacks({ identity, lane }: { identity: Identity; lane: string }) {
  const m = mateOn(lane);
  const installed = installedOn(identity);
  const [err, setErr] = useState("");
  if (!m || m.tool === "friday") return null;
  const own = (m.switched?.from ?? m.tool) as EngineTool;
  const chain = fallbacksOf(m);
  const keep = (body: Record<string, unknown>) => (setErr(""), void api(identity, `/api/teammates/${m.id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }).then(() => refreshTeam(identity)).catch((e: Error) => setErr(e.message || "That didn't save. Try again.")));
  const put = (next: Fallback[]) => keep({ backups: next });
  const move = (i: number, by: number) => {
    const next = [...chain];
    const [x] = next.splice(i, 1);
    next.splice(i + by, 0, x!);
    put(next);
  };
  // One fallback's tool, model or effort changed in its picker: a new tool keeps the model only if that tool has it.
  const change = (i: number, f: Fallback) => put(chain.map((x, j) => (j === i ? f : x)));
  const more = ENGINE_TOOLS.filter((x) => x !== own && !chain.some((f) => f.tool === x) && (!installed || installed(x)));
  return (
    <div className="mfb">
      <p className="mfb-lead">When {ENGINE_NAMES[own]} runs out of usage, {m.name} carries on with its fallbacks in this order, each on the model and effort set here, and goes back to {ENGINE_NAMES[own]} when its limit lifts.</p>
      <div className="mfb-toggle">
        <span className="mfb-toggle-text">
          <b>Ask me before switching</b>
          <span>{m.onLimit === "ask" ? "It waits, and its chat asks you to switch or to wait." : "Off: it switches on its own, and its chat says so."}</span>
        </span>
        <Switch label="Ask me before switching" on={m.onLimit === "ask"} onChange={(on) => keep({ onLimit: on ? "ask" : "" })} />
      </div>
      <ol className="mfb-list" aria-label="Fallbacks, in order">
        <li className="mfb-own">
          <EngineMark tool={own} size={15} />
          <span className="mfb-n">{ENGINE_NAMES[own]}</span>
          <span className="mfb-tag">Its own</span>
        </li>
        {chain.map((f, i) => (
          <li key={f.tool}>
            <span className="mfb-i">{i + 1}</span>
            <span className="mfb-pick">
              <TeammatePicker
                identity={identity}
                tool={f.tool}
                model={f.model ?? ""}
                effort={f.effort ?? null}
                onEffort={(effort) => change(i, { ...f, ...(effort ? { effort } : { effort: undefined }) })}
                onChange={(tool, model) =>
                  tool === "friday" ? setErr("A fallback is one of your coding tools: your own models can't stand in for one.") : tool !== f.tool && chain.some((x) => x.tool === tool) ? setErr(`${ENGINE_NAMES[tool]} is a fallback already: move it instead.`) : change(i, { tool, ...(model ? { model } : {}), ...(tool === f.tool && f.effort ? { effort: f.effort } : {}) })
                }
              />
            </span>
            <span className="mfb-acts">
              <button type="button" className="mfb-btn" aria-label={`Move ${ENGINE_NAMES[f.tool]} up`} title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUpIcon aria-hidden="true" />
              </button>
              <button type="button" className="mfb-btn" aria-label={`Move ${ENGINE_NAMES[f.tool]} down`} title="Move down" disabled={i === chain.length - 1} onClick={() => move(i, 1)}>
                <ArrowDownIcon aria-hidden="true" />
              </button>
              <button type="button" className="mfb-btn" aria-label={`Take ${ENGINE_NAMES[f.tool]} away`} title="Take away" disabled={chain.length === 1} onClick={() => put(chain.filter((x) => x.tool !== f.tool))}>
                <XIcon aria-hidden="true" />
              </button>
            </span>
          </li>
        ))}
      </ol>
      {chain.length < MAX_BACKUPS && more.length > 0 && (
        <MenuButton className="mfb-add" label="Add a fallback" items={() => more.map((x): MenuItem => ({ label: ENGINE_NAMES[x], mark: <EngineMark tool={x} size={15} />, onSelect: () => put([...chain, { tool: x }]) }))}>
          <PlusIcon aria-hidden="true" />
          Add a fallback
        </MenuButton>
      )}
      {err && (
        <p className="msd-err" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

/**
 * A switch that waits on you (Teammate.switchAsk), at the foot of the crew mate's chat it ran out in: switch to its fallback now, or
 * wait for its own tool, whose turn goes again when the limit lifts.
 */
export function MateSwitchAsk({ identity, lane, sid }: { identity: Identity; lane: string; sid: string }) {
  const m = mateOn(lane);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ask = m?.switchAsk;
  if (!m || !ask || ask.sid !== sid || ask.lane !== lane) return null;
  const answer = (go: boolean) => {
    setBusy(true);
    setErr("");
    void api(identity, `/api/teammates/${m.id}/switch`, { method: "POST", body: JSON.stringify({ go }), headers: { "Content-Type": "application/json" } })
      .then(() => refreshTeam(identity))
      .catch((e: Error) => setErr(e.message || "That didn't work. Try again."))
      .finally(() => setBusy(false));
  };
  const back = ask.resetsAt ? new Date(ask.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  return (
    <div className="mt-ask" role="group" aria-label={`${m.name} ran out of usage`}>
      <p>
        <b>{ENGINE_NAMES[ask.from]} is out of usage{back ? ` until ${back}` : ""}.</b> Switch {m.name} to {ENGINE_NAMES[ask.to]} to carry on, or wait for {ENGINE_NAMES[ask.from]}?
      </p>
      <div className="mt-ask-acts">
        <Button size="sm" disabled={busy} onClick={() => answer(true)}>
          Switch to {ENGINE_NAMES[ask.to]}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => answer(false)}>
          Wait
        </Button>
      </div>
      {err && (
        <p className="msd-err" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

/**
 * Where a crew mate works, as the folder and repo picker sessions use (Arun, 2026-11-13: "add a open to work in ... like what we
 * have for the folder, repo, git picker"): its own folder, each folder or repo it works in with a ×, and Open to add another.
 */
function MateFolders({ identity, lane }: { identity: Identity; lane: string }) {
  const m = mateOn(lane);
  const btn = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  if (!m) return null;
  const say = (text: string) => dispatchEvent(new CustomEvent("friday:notice", { detail: text }));
  const dirs = foldersOf(m);
  return (
    <div className="msd-folders">
      <div className="msd-folder" title={m.folder}>
        <FolderGit2Icon className="size-3.5" aria-hidden="true" />
        <span className="msd-folder-name">Its own folder</span>
        <small>{short(m.folder)}</small>
      </div>
      {dirs.map((d) => (
        <div key={d} className="msd-folder" title={d}>
          <FolderGit2Icon className="size-3.5" aria-hidden="true" />
          <span className="msd-folder-name">{base(d)}</span>
          <small>{short(d)}</small>
          <button type="button" className="msd-folder-x" aria-label={`Stop ${m.name} working in ${short(d)}`} title="Take it away" onClick={() => void setFolders(identity, m, dirs.filter((x) => x !== d)).catch((e: Error) => say(e.message))}>
            <XIcon className="size-3" />
          </button>
        </div>
      ))}
      <button type="button" ref={btn} className="msd-open" onClick={() => setPicking(true)}>
        <PlusIcon className="size-3.5" aria-hidden="true" />
        Open a folder or repo
      </button>
      {picking && <TeammateFolderCard identity={identity} lane={lane} trigger={btn.current} onClose={() => setPicking(false)} notify={say} />}
    </div>
  );
}

/** A new thread with a crew mate, opened: its session made, the crew read again, and the thread focused on it. */
export async function startThread(identity: Identity, mateId: string, then?: (id: string) => void): Promise<void> {
  const got = await api<Team & { room?: string }>(identity, "/api/teammates/rooms", { method: "POST", body: JSON.stringify({ thread: mateId }), headers: { "Content-Type": "application/json" } });
  await refreshTeam(identity);
  const made = got.rooms?.find((x) => x.id === got.room);
  if (made) (then?.(made.id), openThread(made, mateId));
}

/** A crew mate's thread, or its main chat (no thread), opened on that crew mate. */
function openThread(r: RoomView | null, mateId: string) {
  const t = teamNow();
  const m = t?.teammates.find((x) => x.id === mateId);
  if (!t || !m) return;
  const [sid, invite, lane] = r ? [r.sid, r.invite, r.lanes[mateId]!] : [t.sid, t.invite, m.lane];
  focusAgent(sid, lane);
  dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid, invite } }));
}

/** Which of a crew mate's threads are open as tabs, by id, kept on this computer; with none kept, its newest three. */
const OPEN_KEY = (mate: string) => `friday.threads.open.${mate}`;
const openListeners = new Set<() => void>();
function readOpen(mate: string): string[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY(mate)) ?? "null") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}
function writeOpen(mate: string, ids: string[]) {
  try {
    localStorage.setItem(OPEN_KEY(mate), JSON.stringify(ids.slice(-12)));
  } catch {
    /* this window only */
  }
  openListeners.forEach((l) => l());
}
function useOpenThreads(mate: string, threads: RoomView[]): string[] {
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    openListeners.add(on);
    return () => void openListeners.delete(on);
  }, []);
  const kept = readOpen(mate);
  const ids = new Set(threads.map((r) => r.id));
  return kept ? kept.filter((id) => ids.has(id)) : threads.slice(0, 3).map((r) => r.id).reverse();
}
const openTab = (mate: string, id: string, now: string[]) => (now.includes(id) ? undefined : writeOpen(mate, [...now, id]));

/**
 * A crew mate's chat's title, in the window's header (Arun, 2026-11-15: "move the threads and stuff to the header ... the agent
 * name left side with the mascot too"; "rather than being a dropdown why dont we make it like a row instead where you can click or
 * close it etc then we have a dropdown for like deleting a thread"): its face and name, then its threads as a row of tabs, Main
 * first, each closed with its ×, and + for a new one. A closed thread is kept: the menu at the row's end lists every thread, and
 * renames or removes the one you are in.
 */
export function MateTitle({ identity, lane, notify }: { identity: Identity; lane: string; notify?: (m: string) => void }) {
  const t = useTeamNow();
  const m = mateOn(lane);
  const [ask, confirmUI] = useConfirm();
  const threads = t && m ? mateThreads(t, m.id) : [];
  const openIds = useOpenThreads(m?.id ?? "", threads);
  const here = m && lane !== m.lane ? (threads.find((r) => r.lanes[m.id] === lane) ?? null) : null;
  // The thread you are in is always a tab: one opened from elsewhere joins the row.
  useEffect(() => {
    if (m && here) openTab(m.id, here.id, openIds);
  }, [m?.id, here?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!t || !m) return null;
  const say = (text: string) => (notify ? notify(text) : dispatchEvent(new CustomEvent("friday:notice", { detail: text })));
  const fresh = () =>
    void startThread(identity, m.id, (id) => openTab(m.id, id, readOpen(m.id) ?? openIds)).catch((e: Error) => say(e.message || "That thread didn't start. Try again."));
  const tabs = openIds.map((id) => threads.find((r) => r.id === id)).filter((r): r is RoomView => !!r);
  if (here && !tabs.includes(here)) tabs.push(here);
  const close = (r: RoomView) => {
    const at = tabs.indexOf(r);
    writeOpen(m.id, openIds.filter((id) => id !== r.id));
    // Closing the one you are in: its neighbour takes its place, or Main.
    if (here?.id === r.id) openThread(tabs[at + 1] ?? tabs[at - 1] ?? null, m.id);
  };
  const s = mateStatus(m);
  const items = (): MenuItem[] => [
    { heading: "Threads" },
    { label: "Main chat", icon: "chat", checked: !here, onSelect: () => openThread(null, m.id) },
    ...threads.slice(0, 20).map((r): MenuItem => ({ label: r.name, icon: "chat", checked: here?.id === r.id, ...(r.working ? { live: true } : {}), onSelect: () => (openTab(m.id, r.id, openIds), openThread(r, m.id)) })),
    { label: "Start a new thread", icon: "plus", onSelect: fresh },
    ...(here
      ? [
          { heading: here.name },
          {
            label: "Rename…",
            icon: "pencil" as const,
            onSelect: () =>
              ask({
                title: "Rename thread",
                action: "Rename",
                danger: false,
                icon: "pencil",
                input: { label: "Thread name", value: here.name, maxLength: 60 },
                onConfirm: (name) => {
                  const n = name.replace(/\s+/g, " ").trim();
                  if (!n) return Promise.reject(new Error("Give it a name."));
                  return api(identity, `/api/teammates/rooms/${here.id}`, { method: "PATCH", body: JSON.stringify({ name: n }), headers: { "Content-Type": "application/json" } }).then(() => void refreshTeam(identity));
                },
              }),
          },
          {
            label: "Delete thread…",
            icon: "trash" as const,
            danger: true,
            onSelect: () =>
              ask({
                title: `Delete “${here.name}”?`,
                body: `The thread and its conversation with ${m.name} go for good. Anything ${m.name} made or changed stays where it is.`,
                action: "Delete thread",
                onConfirm: () =>
                  api(identity, `/api/teammates/rooms/${here.id}`, { method: "DELETE" })
                    .then(() => refreshTeam(identity))
                    .then(() => (writeOpen(m.id, openIds.filter((id) => id !== here.id)), openThread(null, m.id))),
              }),
          },
        ]
      : []),
  ];
  return (
    <div className="mt-title">
      <span className="mt-face" title={`${m.name} · ${freeLine(m, s)}`}>
        <Face seed={m.look ?? m.name} size={22} status={m.status} lead={t.lead === m.lane} />
      </span>
      <h1 className="mt-name">{m.name}</h1>
      <MateRing status={m.status} title={freeLine(m, s)} />
      <div className="mt-tabs" role="tablist" aria-label={`${m.name}'s threads`}>
        <button type="button" role="tab" aria-selected={!here} className="mt-tab" onClick={() => here && openThread(null, m.id)}>
          <span className="mt-tab-name">Main</span>
        </button>
        {tabs.map((r) => (
          <div key={r.id} className="mt-tab" role="tab" aria-selected={here?.id === r.id} data-working={r.working ? "" : undefined}>
            <button type="button" className="mt-tab-open" title={r.name} onClick={() => here?.id !== r.id && openThread(r, m.id)}>
              {r.working ? <span className="mt-tab-dot" aria-label="working" /> : null}
              <span className="mt-tab-name">{r.name}</span>
            </button>
            <button type="button" className="mt-tab-x" aria-label={`Close ${r.name}`} title="Close: it stays in the threads menu" onClick={() => close(r)}>
              <XIcon aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="mt-tab-new" aria-label={`New thread with ${m.name}`} title={`New thread with ${m.name}`} onClick={fresh}>
        <PlusIcon aria-hidden="true" />
      </button>
      <MenuButton className="mt-more" label={`${m.name}'s threads`} items={items} width={260}>
        <ChevronDownIcon aria-hidden="true" />
      </MenuButton>
      {confirmUI}
    </div>
  );
}

/**
 * The top of a crew mate's chat (Arun, 2026-11-15: "make this feel like more of a chat than so much info"): nothing over a chat
 * under way but a hold to lift; an empty one says who you are talking to, its face, name and what it does, and how to begin.
 */
export function MateHello({ lane, identity, notify, empty }: { lane: string; identity?: Identity; notify?: (m: string) => void; empty: boolean }) {
  const m = mateOn(lane);
  if (!m) return null;
  let mine = true;
  const about = (m.role ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";
  return (
    <>
      {m.held && identity && mine && (
        <p className="mt-held">
          On hold: {m.name} waits until you lift it.
          <button type="button" className="tm-link" onClick={() => void api(identity, "/api/teammates/lift", { method: "POST", body: JSON.stringify({ id: m.id }), headers: { "Content-Type": "application/json" } }).then(() => refreshTeam(identity)).catch((e: Error) => notify?.(e.message))}>
            Lift the hold
          </button>
        </p>
      )}
      {empty && (
        <div className="mt-hello">
          <Face seed={m.look ?? m.name} size={64} status={m.status} />
          <h2>{m.name}</h2>
          {about && <p className="mt-hello-about">{about}</p>}
          {m.status === "offline" ? (
            <p className="mt-hello-off">{m.name} is offline: its coding tool isn't running. What you write waits until it's back. Right-click {m.name} in the sidebar to restart it.</p>
          ) : (
            <p className="mt-hello-how">Ask {m.name} to research something, write it up, plan the work or build it. Start a new thread for each thing you hand over.</p>
          )}
        </div>
      )}
    </>
  );
}

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
  // Theirs to change: every teammate here; on the hosted service, only its keeper's (CrewHosted.tsx).
  let mine = true;
  let keeper = null as string | null;
  // The computer it runs on, as its keeper's Crew names it: their desktop app's, or one of their always-on machines.
  let computer = null as { label: string; connected: boolean } | null;
  const tabs = (
    <div className="tm-tabs" role="tablist" aria-label={`${m.name}'s page`}>
      {/* Someone else's memory and settings are its keeper's alone (hosted-crew.ts). */}
      {TABS.filter((x) => mine || x.id !== "memory").map((x) => (
        <button key={x.id} type="button" role="tab" id={`tm-tab-${x.id}`} aria-selected={tab === x.id} aria-controls={x.id === "chat" ? undefined : `tm-panel-${x.id}`} className="tm-tab" onClick={() => setMateTab(lane, x.id)}>
          {x.label}
        </button>
      ))}
    </div>
  );
  const panel = tab !== "chat" && tab !== "settings" && identity && (
    <section className="tm-panel" id={`tm-panel-${tab}`} role="tabpanel" aria-labelledby={`tm-tab-${tab}`}>
      {tab === "activity" && <ActivityTab identity={identity} id={m.id} lane={lane} />}
      {tab === "results" && <ResultsTab identity={identity} id={m.id} lane={lane} />}
      {tab === "skills" && <SkillsPanel mate={m} />}
      {tab === "memory" && mine && <MemoryEditor identity={identity} id={m.id} name={m.name} />}
    </section>
  );
  // In the open-source build, one line (Arun, 2026-11-11, option 3A of the Crew overhaul): who, their role in a word, what they're
  // doing and where, and the tabs at its end. What they may do and run on is in Settings, and the composer says what they run on.
  if (isLocal()) {
    const chip = lead ? "Lead" : roleWord(m.role ?? "");
    const repos = foldersOf(m);
    return (
      <div className="tm-page tm-slim" data-tab={tab}>
        <header className="tm-slim-head">
          <Face seed={m.look ?? m.name} size={30} status={m.status} lead={lead} />
          <h2 className="tm-slim-name">{m.name}</h2>
          {chip && <span className="tm-slim-chip">{chip}</span>}
          <span className="tm-slim-meta" title={m.role ?? ""}>
            <span className={`tm-slim-status s-${s.state}`}>
              {freeLine(m, s)}
              {workingSinceOf(m) !== null && ` · ${elapsed(workingSinceOf(m)!, now)}`}
            </span>
            {repos.length > 0 && (
              <span title={repos.join("\n")}>
                {" "}
                · in {repos.map(base).join(", ")}
                {branch ? ` · ${branch}` : ""}
              </span>
            )}
          </span>
          {identity && mine && (
            <button type="button" ref={addBtn} className="tm-slim-add" onClick={() => setGiving(true)} title="Give them a folder or repo to work in">
              <PlusIcon className="size-3" />
              {repos.length ? "Folder" : "Folder or repo"}
            </button>
          )}
          {giving && identity && <TeammateFolderCard identity={identity} lane={lane} trigger={addBtn.current} onClose={() => setGiving(false)} notify={notify ?? (() => {})} />}
          {tabs}
        </header>
        {m.held && identity && mine && (
          <p className="tm-head-held tm-slim-held">
            On hold: they wait until you lift it.{" "}
            <button type="button" className="tm-link" onClick={() => void api(identity, "/api/teammates/lift", { method: "POST", body: JSON.stringify({ id: m.id }), headers: { "Content-Type": "application/json" } }).then(() => refreshTeam(identity)).catch((e: Error) => notify?.(e.message))}>
              Lift the hold
            </button>
          </p>
        )}
        {panel}
      </div>
    );
  }
  return (
    <div className="tm-page" data-tab={tab}>
      <header className="tm-head">
        <Face seed={m.look ?? m.name} size={56} status={m.status} lead={lead} />
        <div className="tm-head-text">
          <h2 className="tm-head-name">
            {m.name}
            {/* "Lead", not the role's own first words again (audit CREW-25). */}
            {lead && <span className="tm-head-lead">Lead</span>}
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
          {/* No facts here (Arun, 2026-11-13: "get rid of this"): what it may do, runs on and works in is in its Settings, in the
              header's gear. */}
          {m.held && identity && mine && (
            <p className="tm-head-held">
              On hold: they wait until you lift it.{" "}
              <button type="button" className="tm-link" onClick={() => void api(identity, "/api/teammates/lift", { method: "POST", body: JSON.stringify({ id: m.id }), headers: { "Content-Type": "application/json" } }).then(() => refreshTeam(identity)).catch((e: Error) => notify?.(e.message))}>
                Lift the hold
              </button>
            </p>
          )}
        </div>
      </header>
      {tabs}
      {panel}
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
  // Work they handed in, each with its proof (team-proof.ts): what shows it worked, before the files.
  const handed = useMemo(() => (runs ?? []).filter((r) => r.proof).slice(0, 30), [runs]);
  if (failed) return <p className="tm-panel-empty">Their results show here once this Friday is updated.</p>;
  if (!runs) return <Skeleton rows={3} />;
  if (!files.length && !prs.length && !handed.length) return <p className="tm-panel-empty">No files changed or pull requests in the last seven days.</p>;
  return (
    <div className="tm-results">
      {handed.length > 0 && (
        <section>
          <h4 className="tm-day-head">Handed in · {handed.length}</h4>
          <ul className="tm-result-list">
            {handed.map((r) => (
              <li key={`${r.sid}:${r.startedAt}`} className="pf-handed">
                <span className="pf-handed-title">
                  <span title={r.proof!.title}>{plainLine(r.proof!.title || r.said.split("\n")[0] || "Its work")}</span>
                  <span className="pf-num">
                    {r.room ?? "Crew room"} · {timeOf(r.startedAt)}
                  </span>
                </span>
                <ProofToggle proof={r.proof!} />
              </li>
            ))}
          </ul>
        </section>
      )}
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
        {/* Over a page, they read only its newest page (teammates.ts memoryText): said here, where it can be tidied. */}
        {text !== null && text.length > 6000 && (
          <span className="tm-memory-over" role="status">
            Over a page ({text.length.toLocaleString()} characters): they read only the newest part. Tidy it to keep what matters in sight.
          </span>
        )}
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
