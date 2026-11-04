/**
 * Team workflows: the Team's automations page, drawn as a workflow (Arun, 2026-10-28: "make the automation for the teams
 * platform different it can be like a workflow automation design like we did with the agent tab page a while ago").
 *
 * The list: a card for each workflow, its trigger, its steps as a row of the teammates' faces, its last and next run, and on/off.
 * The builder, in the Agent Studio's language: a dotted canvas you can pan and zoom, the trigger's card on the left, the steps'
 * cards in columns (one after another left to right, side by side stacked), the outcomes' card on the right, dashed wires between
 * them; a "+" between columns and under each column adds a step; a card pressed (or Enter on it) opens its settings beside the
 * canvas; a ready check says what is missing. Narrower than the canvas needs, it is a list of the steps, top to bottom.
 *
 * Its own code, not the Agent Studio's (that is the paid edition's): the same look, taken from the tray tokens.
 *
 */
import { AutomationsSwitch } from "./AutomationsSwitch.js";
import { holdLeave } from "./leave-guard.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BellRingIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  CheckIcon,
  CornerUpLeftIcon,
  FileTextIcon,
  FlagIcon,
  FolderIcon,
  GitPullRequestIcon,
  HandIcon,
  HistoryIcon,
  MessageCircleQuestionIcon,
  LayoutGridIcon,
  LayoutTemplateIcon,
  MessageSquareTextIcon,
  MinusIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  ScanIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UsersIcon,
  WebhookIcon,
  WorkflowIcon,
  XIcon,
  ZapIcon,
  type LucideIcon,
  LightbulbIcon,
} from "lucide-react";
import type { AgentSchedule } from "../agents.js";
import type { BoardStatus } from "../session/projection.js";
import {
  BLANK_LIMITS,
  BLANK_OUTCOMES,
  columnsOf,
  afterFix,
  connectionsOf,
  fixSteps,
  ifNotOf,
  ifNotTo,
  sendsOn,
  DEFAULT_TRIES,
  isGate,
  MAX_TRIES,
  FIRST_STEP,
  fromTemplate,
  LEAD,
  MAX_STEPS,
  packSteps,
  scheduleShort,
  stepTitle,
  TEAM_ROOM,
  WORKFLOW_TEMPLATES,
  workflowChecks,
  type StepKind,
  type TriggerKind,
  type Workflow,
  type WorkflowCheck,
  type WorkflowLayout,
  type WorkflowRun,
  type WorkflowRunStep,
  type WorkflowStep,
  type WorkflowPort,
  type WorkflowTemplate,
  type WorkflowTrigger,
  type WorkflowView,
} from "../team-workflow-model.js";
import type { TeammateView } from "../teammates.js";
import { api } from "./api.js";
import type { Identity } from "./storage.js";
import { TaskMark, type TaskMarkState } from "./TaskMark.js";
import { isTyping, relTime, useConfirm } from "./ui.js";
import { history } from "./undo-stack.js";
import { base, Face, mateStatus, refreshTeam, useTeam, type Team } from "./Teammates.js";
import { useMachine } from "./local.js";
import { canRoute } from "./RouteWhy.js";
import { EngineMark } from "./BrandMarks.js";
import { ENGINE_NAMES, type EngineTool } from "../types.js";
import { isLocal } from "./edition.js";
import { timeOf } from "./team-status.js";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/dass";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem,
  SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dot, PageTabs, Tip, type DotState } from "@/components/dass/page-bits";
import { StepSkill } from "./CrewSkills.js";
import { WorkflowAsks } from "./WorkflowAsks.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import "./workflows.css";

type Draft = Omit<Workflow, "id" | "created" | "updated">;
const JSON_BODY = { "Content-Type": "application/json" };

/**
 * A workflow someone else in the workspace made, as the hosted service sends it (hosted-workflows.ts: the same /api/workflows, each
 * workflow with its `owner` and whether it is `mine`): theirs to change and run, yours to look at.
 */
const theirs = (w: WorkflowView | null | undefined): { id: string; name: string } | null => ((w as { mine?: boolean } | null)?.mine === false ? ((w as { owner?: { id: string; name: string } }).owner ?? { id: "", name: "someone else" }) : null);

const TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS = [1, 2, 3, 4, 5];
const uid = () => Math.random().toString(36).slice(2, 10);

const blank = (): Draft => ({ name: "", on: true, room: TEAM_ROOM, trigger: { kind: "manual" }, steps: [], outcomes: { ...BLANK_OUTCOMES }, limits: { ...BLANK_LIMITS }, ask: "" });
const draftOf = (w: WorkflowView): Draft => ({ name: w.name, on: w.on, room: w.room, trigger: w.trigger, steps: w.steps, outcomes: w.outcomes, limits: w.limits, ask: w.ask ?? "", ...(w.layout ? { layout: w.layout } : {}) });
const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

const RUN_WORD: Record<WorkflowRun["status"], string> = { running: "Running", waiting: "Waiting", asking: "Needs your OK", done: "Done", stopped: "Stopped", failed: "Didn't finish", skipped: "Skipped" };
const runMark = (s: WorkflowRun["status"]): TaskMarkState => (s === "running" ? "working" : s === "done" ? "done" : s === "failed" ? "blocked" : s === "asking" ? "review" : "open");
/** A run under way: going, waiting for its board, or waiting for your OK. */
const underWay = (r: WorkflowRun | undefined): r is WorkflowRun => !!r && (r.status === "running" || r.status === "waiting" || r.status === "asking");
/** Where a run under way is, in a few words: its steps counted out of the workflow's, not only those posted so far. */
const liveWords = (r: WorkflowRun, steps: readonly WorkflowStep[]) => {
  const n = (id?: string) => packSteps(steps).findIndex((x) => x.id === id) + 1;
  if (r.status === "asking") return `Waiting for your OK at step ${n(r.asking?.step) || ""}`.trim();
  if (r.status === "waiting") return r.note ?? "Waiting for the room's board";
  return `Running in the ${r.roomName.replace(/^the /, "")} · ${r.steps.filter((x) => x.status === "done").length} of ${steps.length || r.steps.length} done`;
};
const STEP_WORD: Record<BoardStatus, string> = { open: "Waiting its turn", claimed: "Working", review: "Being checked", done: "Done", blocked: "Stuck", cancelled: "Dropped" };
const stepMark = (s: BoardStatus): TaskMarkState => (s === "claimed" ? "working" : s === "review" ? "review" : s === "done" ? "done" : s === "blocked" ? "blocked" : "open");

const TRIGGER_ICON: Record<TriggerKind, LucideIcon> = { schedule: ClockIcon, webhook: WebhookIcon, teammate: UsersIcon, board: WorkflowIcon, manual: PlayIcon };

/**
 * A time as its schedule says it, in the schedule's own zone and 24-hour clock, as the trigger line does: "Fri 16:00". When that
 * zone's clock isn't the person's, their own time after it: "Fri 16:00 (12:00 PM your time)".
 */
function whenIn(ts: number, tz: string): string {
  const said = (zone: string, h23: boolean) => {
    const day = (t: number) => new Date(t).toLocaleDateString("en-CA", { timeZone: zone });
    // "today at 08:30", "tomorrow at 08:30", "Sat at 08:30": read as words after "Next:" (QA, 2026-10-28: "Next Tomorrow 08:30").
    const d = day(ts) === day(Date.now()) ? "today at" : day(ts) === day(Date.now() + 86_400_000) ? "tomorrow at" : `${new Date(ts).toLocaleDateString([], { weekday: "short", timeZone: zone })} at`;
    const clock = new Date(ts).toLocaleTimeString([], h23 ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone } : { hour: "numeric", minute: "2-digit", timeZone: zone });
    return { d, clock };
  };
  const there = said(tz, true);
  const mine = said(TZ, true);
  if (there.d === mine.d && there.clock === mine.clock) return `${there.d} ${there.clock}`;
  const local = said(TZ, false);
  return `${there.d} ${there.clock} (${local.d === there.d ? "" : `${local.d} `}${local.clock} your time)`;
}

/**
 * The team's names for what a workflow says: a teammate by id (or the lead), a room by id. `pick`: the teammates a step or a
 * trigger may name, where not all of them (the hosted service's: your own, and any on a key its keeper shares).
 */
function useNames(team: Team | null, pick?: (id: string) => boolean) {
  return useMemo(() => {
    const mates = team?.teammates ?? [];
    const rooms = team?.rooms ?? [];
    const leadLane = (room: string) => (room === TEAM_ROOM ? (team?.lead ?? null) : (rooms.find((r) => r.id === room)?.lead ?? null));
    const onLane = (lane: string): TeammateView | null => mates.find((m) => m.lane === lane) ?? ((id) => mates.find((m) => m.id === id) ?? null)(rooms.map((r) => Object.entries(r.lanes).find(([, l]) => l === lane)?.[0]).find(Boolean));
    return {
      mates,
      rooms,
      /** The teammates a trigger, or a template's steps, name: your own, on the hosted service (a step may name anyone's: asked of its keeper). */
      pickable: pick ? mates.filter((m) => pick(m.id)) : mates,
      /** Whose a teammate is, on the hosted service, when it isn't yours: its keeper's name. */
      keeperOf: (id: string): string | null => (pick && !pick(id) ? ((mates.find((m) => m.id === id) as { keeper?: { name: string } } | undefined)?.keeper?.name ?? "someone else") : null),
      /** Whether a teammate may be named here: null where any may. */
      pick: pick ?? null,
      mate: (id: string): TeammateView | null => mates.find((m) => m.id === id) ?? null,
      /** Who "the lead" is in a room now. */
      lead: (room: string): TeammateView | null => ((l) => (l ? onLane(l) : null))(leadLane(room)),
      // On the hosted service the Crew room is your own Crew, with your teammates (each person has one).
      room: (id: string) => (id === TEAM_ROOM ? (pick ? "your Crew" : "Crew room") : (rooms.find((r) => r.id === id)?.name ?? "")),
      /** Who may be picked for a step in a room: everyone in the Team room, a room's members in a room. */
      inRoom: (room: string, id: string) => room === TEAM_ROOM || !!rooms.find((r) => r.id === room)?.lanes[id],
    };
  }, [team, pick]);
}
type Names = ReturnType<typeof useNames>;

/** What starts it, in a few words, for a card or a chip. */
function triggerShort(t: WorkflowTrigger, n: Names): string {
  if (t.kind === "schedule") return scheduleShort(t.schedule);
  if (t.kind === "webhook") return "Webhook";
  if (t.kind === "teammate") return `${n.mate(t.mate)?.name ?? "A teammate"} finishes ${t.on === "task" ? "a task" : "a turn"}`;
  if (t.kind === "board") return `A board in ${n.room(t.room) || "a room"} finishes`;
  // When it runs, in words, never the button's name beside "Use →" (audit CREW-41, 2026-11-04).
  return "When you start it";
}

function triggerLong(t: WorkflowTrigger, n: Names): string {
  if (t.kind === "schedule") {
    const s = t.schedule;
    if (s.every === "hourly") return "Every hour, on the hour";
    const d = [...s.days].sort();
    const when = s.every === "daily" || d.length === 7 ? "Every day" : d.join() === WEEKDAYS.join() ? "Every weekday" : d.map((x) => DAYS[x]).join(", ");
    return `${when} at ${s.at}`;
  }
  if (t.kind === "webhook") return "When its webhook is called";
  if (t.kind === "teammate") return `When ${n.mate(t.mate)?.name ?? "a teammate"} finishes ${t.on === "task" ? "a board task" : "a turn"}`;
  if (t.kind === "board") return `When a board in ${n.room(t.room) || "a room"} finishes`;
  return "When you press Run now";
}

// ── the page ─────────────────────────────────────────────────────────

/**
 * The crew as the page needs it: the open-source edition's (useTeam), or on the hosted service the same /api/teammates read here,
 * while the hosted app's own team store doesn't read it yet.
 */
function useCrewTeam(identity: Identity): Team | null {
  const shared = useTeam(identity);
  const [read, setRead] = useState<Team | null>(null);
  const need = !isLocal() && !shared;
  useEffect(() => {
    if (!need) return;
    const get = () => void api<Team>(identity, "/api/teammates").then(setRead, () => {});
    get();
    const t = setInterval(() => document.visibilityState === "visible" && get(), 5000);
    return () => clearInterval(t);
  }, [identity, need]);
  return shared ?? read;
}

export function TeamWorkflowsPage({ identity, onCoding }: { identity: Identity; /** Across to the coding tools' own automations. */ onCoding: () => void }) {
  const team = useCrewTeam(identity);
  // On the hosted service a step or a trigger names your own teammates, or one on a key its keeper shares: anyone else's on its
  // own plan takes its keeper's work only (own-plan.ts). The open-source edition's teammates are all the person's.
  const pick = useMemo(() => {
    const mates = (team?.teammates ?? []) as (TeammateView & { mine?: boolean; onKey?: boolean })[];
    if (!mates.some((m) => m.mine !== undefined)) return undefined;
    const can = new Set(mates.filter((m) => m.mine || m.onKey).map((m) => m.id));
    return (id: string) => can.has(id);
  }, [team]);
  const names = useNames(team, pick);
  const [list, setList] = useState<WorkflowView[] | null>(null);
  const [failed, setFailed] = useState("");
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft; fresh?: boolean } | null>(null);
  const [busy, setBusy] = useState("");
  const [ask, confirmUI] = useConfirm();
  /** A workflow whose Run now asks for something first. */
  const [asking, setAsking] = useState<WorkflowView | null>(null);

  const load = useCallback(async () => {
    try {
      const got = await api<{ workflows: WorkflowView[] }>(identity, "/api/workflows");
      setList(got.workflows.sort((a, b) => b.created - a.created));
      setFailed("");
    } catch (e) {
      setFailed((e as Error).message);
    }
  }, [identity]);
  useEffect(() => {
    void load();
    // A run moves on by itself (its steps, then done): read again while the page is in sight, oftener while one runs.
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 5000);
    return () => clearInterval(t);
  }, [load]);
  // Its own name in the tab, however it was reached (the Team room's header goes there without the app's navigate).
  useEffect(() => void (document.title = "Crew workflows · Friday"), []);
  // The sidebar's Automations, pressed in the builder, is the way back to the list.
  useEffect(() => {
    const again = (e: Event) => (e as CustomEvent).detail === "automations" && setEditing(null);
    addEventListener("friday:same-page", again);
    return () => removeEventListener("friday:same-page", again);
  }, []);

  const runNow = async (w: WorkflowView, input?: string) => {
    if (w.ask?.trim() && input === undefined) return setAsking(w);
    setBusy(w.id);
    try {
      await api(identity, `/api/workflows/${w.id}/run`, { method: "POST", body: JSON.stringify(input ? { input } : {}), headers: JSON_BODY });
      await load();
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const setOn = async (w: WorkflowView, on: boolean) => {
    setList((l) => l?.map((x) => (x.id === w.id ? { ...x, on } : x)) ?? l);
    await api(identity, `/api/workflows/${w.id}`, { method: "PATCH", body: JSON.stringify({ on }), headers: JSON_BODY }).catch((e) => setFailed((e as Error).message));
    void load();
  };
  const startFrom = (t: WorkflowTemplate | null) =>
    setEditing({ id: null, fresh: true, draft: t ? { ...blank(), ...fromTemplate(t, names.pickable.map((m) => ({ id: m.id, name: m.name, role: m.role }))) } : blank() });

  if (editing) {
    const view = editing.id ? (list?.find((w) => w.id === editing.id) ?? null) : null;
    return (
      <>
        {confirmUI}
        <Builder
          key={editing.id ?? "new"}
          identity={identity}
          team={team}
          names={names}
          id={editing.id}
          initial={editing.draft}
          view={view}
          fresh={!!editing.fresh}
          others={(list ?? []).filter((w) => w.id !== editing.id && !theirs(w))}
          ask={ask}
          onBack={() => (setEditing(null), void load())}
          onSaved={(v) => (setList((l) => [v, ...(l ?? []).filter((x) => x.id !== v.id)]), setEditing({ id: v.id, draft: draftOf(v) }))}
          onRan={() => void load()}
          onDeleted={() => (setEditing(null), void load())}
        />
      </>
    );
  }

  return (
    <div className="page conns-page automations-page wf-page px-6! max-[640px]:px-4!">
      <div className="page-inner">
        {confirmUI}
        {asking && <RunAsk name={asking.name} ask={asking.ask ?? ""} onClose={() => setAsking(null)} onRun={(input) => (setAsking(null), void runNow(asking, input))} />}
        {/* Untitled on screen like every page (Arun, 2026-10-19: "get rid of all of these header text"): the title is the tab's. */}
        <div className="auto-head">
          <AutomationsSwitch view="workflows" onView={onCoding} />
          <PageHeader
            title="Crew workflows"
            className="mb-0"
            actions={
              <Button size="sm" className="h-8 px-3 text-[13px]" onClick={() => startFrom(null)}>
                <PlusIcon /> New workflow
              </Button>
            }
          />
        </div>
        {failed && (
          <p role="alert" className="mb-4 rounded-lg border border-[var(--border)] px-3 py-2 text-[13px] text-[var(--red)]">
            {failed}
          </p>
        )}
        <WorkflowAsks identity={identity} onAnswered={() => void load()} />
        {list === null ? (
          <div className="wf-grid">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[172px] rounded-2xl" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <Intro />
        ) : (
          <ul className="wf-grid" aria-label="Your crew's workflows">
            {list.map((w) => (
              <WorkflowCard key={w.id} w={w} names={names} busy={busy === w.id} onEdit={() => setEditing({ id: w.id, draft: draftOf(w) })} onRun={() => void runNow(w)} onToggle={(on) => void setOn(w, on)} />
            ))}
          </ul>
        )}
        <section className="mt-9" aria-labelledby="wf-templates">
          <h2 id="wf-templates" className="wf-tpl-head">
            {list?.length ? "Start another from a template" : "Start from a template"}
          </h2>
          <ul className="wf-tpl-list">
            {WORKFLOW_TEMPLATES.map((t) => (
              <TemplateTile key={t.id} t={t} names={names} onUse={() => startFrom(t)} />
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

/**
 * Before there are any: a workflow drawn as what it is, trigger to outcome. Made from the header's one New workflow, as Automations'
 * intro is (final pass, 2026-10-29: one primary button a screen, DIRECTION.md §2).
 */
function Intro() {
  const parts: [LucideIcon, string, string][] = [
    [ClockIcon, "When", "Every Friday at 16:00"],
    [UsersIcon, "Researcher", "Reads the week's merges"],
    [FileTextIcon, "Writer", "Drafts the changelog"],
    [BellRingIcon, "Then", "A brief in the room"],
  ];
  return (
    <div className="auto-intro wf-intro">
      <div className="flex min-w-0 flex-col justify-center gap-3">
        <h2 className="text-[20px] leading-tight font-semibold tracking-[-0.01em]">Hand your crew work that runs itself</h2>
        <p className="max-w-[440px] text-[14px] leading-relaxed text-[var(--text-muted)]">
          A workflow is a trigger, then steps, then what happens after. A step is a teammate and what it does; a check sends the work back until it passes; your OK waits for you. Press New workflow and describe it, or start from a template.
        </p>
      </div>
      <ol className="wf-intro-flow" aria-label="An example">
        {parts.map(([Icon, label, text], i) => (
          <li key={label}>
            <span className="wf-intro-node">
              <Icon className="size-3.5" />
              <span className="wf-intro-label">{label}</span>
              <span className="wf-intro-text">{text}</span>
            </span>
            {i < parts.length - 1 && <ArrowRightIcon className="wf-intro-arrow size-3.5" aria-hidden="true" />}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Describe it, and Friday drafts it (POST /api/workflows/draft): who does what, the checks and your OKs, the trigger, opened in
 * the builder to look over before it is saved. The quickest way in; templates and the builder stay for the rest.
 */
function DraftBox({ identity, over, onDraft, onClose }: { identity: Identity; /** Steps are there already: the draft takes their place. */ over: boolean; onDraft: (d: Partial<Draft>) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    if (text.trim().length < 8 || busy) return;
    setBusy(true);
    setError("");
    try {
      const got = await api<{ draft: Partial<Draft> }>(identity, "/api/workflows/draft", { method: "POST", body: JSON.stringify({ text, tz: TZ }), headers: JSON_BODY });
      onDraft(got.draft);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    // One line until something is typed: "Describe it instead…" and Draft it beside it (audit CREW-36, 2026-11-04).
    <form className={cn("wf-draft", !text && !busy && !error && "line")} onSubmit={(e) => (e.preventDefault(), void go())}>
      <LightbulbIcon className="wf-draft-mark size-4" aria-hidden="true" />
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => (e.key === "Escape" ? (e.preventDefault(), onClose()) : e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (e.preventDefault(), void go()))}
        autoFocus
        placeholder="Describe it instead…"
        title="Every weekday at 9, Ada runs the tests, Kit fixes what fails until they pass, and I OK the pull request."
        aria-label="Describe a workflow"
        rows={text ? 2 : 1}
        maxLength={2000}
        disabled={busy}
        className="wf-draft-box"
      />
      <div className="wf-draft-foot">
        <span className={error ? "wf-draft-note bad" : "wf-draft-note"} role={error ? "alert" : undefined}>
          {error || (busy ? "Drafting it with your coding tool…" : over ? "Friday drafts it in place of these steps. Nothing is saved until you save." : "Friday drafts it here. You look it over before it's saved.")}
        </span>
        <Button type="submit" size="sm" className="h-8 px-3 text-[13px]" disabled={busy || text.trim().length < 8}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {busy ? "Drafting…" : "Draft it"}
        </Button>
      </div>
    </form>
  );
}

/** Run now, for a workflow that asks for something first: its question, the answer handed to its first steps. */
function RunAsk({ name, ask, onRun, onClose }: { name: string; ask: string; onRun: (input: string) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Run {name}</DialogTitle>
          <DialogDescription>{ask}</DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim() && onRun(text.trim())}
          aria-label={ask}
          className="min-h-[96px] text-[13px] md:text-[13px]"
          maxLength={8000}
        />
        <DialogFooter>
          <Button variant="ghost" size="sm" className="h-8 px-3 text-[13px]" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" className="h-8 px-3 text-[13px]" disabled={!text.trim()} onClick={() => onRun(text.trim())}>
            <PlayIcon /> Run it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Who does what, in order, in words: "Juno and Kit, then Nova, then the lead". */
function stepsLine(steps: WorkflowStep[], n: Names): string {
  const who = (s: WorkflowStep) => (s.kind === "approve" ? "your OK" : s.kind === "check" ? `a check by ${s.mate === LEAD ? "the lead" : (n.mate(s.mate)?.name ?? "someone")}` : s.mate === LEAD ? "the lead" : (n.mate(s.mate)?.name ?? "someone to pick"));
  const cols = columnsOf(steps).map((c) => {
    const names = [...new Set(c.map(who))];
    return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]!;
  });
  return cols.length ? cols.join(", then ").replace(/^the lead/, "The lead") : "";
}

/** A workflow's steps as faces: one column after another, side by side stacked. */
function StepFaces({ steps, room, names, size = 22, run }: { steps: WorkflowStep[]; room: string; names: Names; size?: number; /** A run under way: its steps being done wear the working ring (DIRECTION.md §9.9). */ run?: WorkflowRun | null }) {
  const cols = columnsOf(steps);
  if (!cols.length) return <span className="text-[12px] text-[var(--text-muted)]">No steps yet</span>;
  return (
    <span className="wf-faces" aria-label={`${steps.length} step${steps.length === 1 ? "" : "s"}`}>
      {cols.map((col, i) => (
        <span key={i} className="wf-faces-col">
          {i > 0 && <ChevronRightIcon className="wf-faces-sep size-3" aria-hidden="true" />}
          <span className="wf-faces-stack">
            {col.map((s) => {
              if (isGate(s))
                return (
                  <span key={s.id} className="wf-face-gate" style={{ width: size, height: size }} title={s.kind === "approve" ? `Your OK: ${s.does.split("\n")[0]}` : `Check: ${s.does.split("\n")[0]}`}>
                    {s.kind === "approve" ? <HandIcon /> : <ShieldCheckIcon />}
                  </span>
                );
              const m = s.mate === LEAD ? names.lead(room) : names.mate(s.mate);
              return m ? (
                <span key={s.id} title={`${s.mate === LEAD ? `The lead (${m.name})` : m.name}: ${s.does.split("\n")[0]}`}>
                  <Face seed={m.look ?? m.name} size={size} lead={s.mate === LEAD} {...(run && ["claimed", "review"].includes(run.steps.find((x) => x.step === s.id)?.status ?? "") ? { status: "working" as const } : {})} />
                </span>
              ) : (
                <span key={s.id} className="wf-face-none" style={{ width: size, height: size }} title="No teammate picked" />
              );
            })}
          </span>
        </span>
      ))}
    </span>
  );
}

function WorkflowCard({ w, names, busy, onEdit, onRun, onToggle }: { w: WorkflowView; names: Names; busy: boolean; onEdit: () => void; onRun: () => void; onToggle: (on: boolean) => void }) {
  const last = w.runs[0];
  const live = underWay(last) ? last : null;
  const Icon = TRIGGER_ICON[w.trigger.kind];
  const owner = theirs(w);
  return (
    // The whole card opens it, as a card does; its own controls keep their presses (QA, 2026-10-28: only the title opened it).
    // Its chain as faces (24px, ringed while their step runs), the schedule as meta, and the switch the one control; a run
    // under way says what it is doing under the title (Arun, 2026-10-29: "so clean and beautiful…"; DIRECTION.md §9.9). Run now
    // is there under the pointer or the keyboard only, not a second control at rest.
    <li className={cn("wf-card", !w.on && "off", live && "live")} onClick={(e) => !(e.target as HTMLElement).closest("button, a, input, [role=switch]") && onEdit()}>
      <div className="wf-card-head">
        <button type="button" className="wf-card-open" onClick={onEdit} aria-label={`Edit ${w.name}`}>
          <span className="wf-card-name">{w.name}</span>
        </button>
        {!owner && (
          <Tip label="Run it now">
            <Button variant="ghost" size="icon-sm" className="wf-card-ctl wf-card-run" aria-label={`Run ${w.name} now`} disabled={busy} onClick={onRun}>
              <PlayIcon />
            </Button>
          </Tip>
        )}
        <Switch className="wf-card-ctl" checked={w.on} disabled={!!owner} onCheckedChange={onToggle} aria-label={owner ? `${w.name} is ${owner.name}'s, ${w.on ? "on" : "off"}` : w.on ? `Turn ${w.name} off` : `Turn ${w.name} on`} />
      </div>
      {live ? (
        <span className="wf-card-live" role="status">
          <span className={live.status === "asking" ? "wf-card-asking" : "tm-live-text"}>{liveWords(live, w.steps)}</span>
        </span>
      ) : (
        <span className="wf-card-when">
          <Icon className="size-3.5" aria-hidden="true" />
          <span className="truncate">{triggerShort(w.trigger, names)}</span>
          <span className="wf-card-room">· {owner && w.room === TEAM_ROOM ? `${owner.name}'s Crew` : names.room(w.room) || "a room that's gone"}</span>
          {owner && w.room !== TEAM_ROOM && <span className="wf-card-room">· {owner.name}'s</span>}
        </span>
      )}
      <span className="wf-card-steps">
        <StepFaces steps={w.steps} room={w.room} names={names} size={24} run={live} />
        <span className="wf-card-who">{stepsLine(w.steps, names)}</span>
      </span>
      <div className="wf-card-foot">
        {/* While it runs the line under the title says so: the foot says only when it started, not "Running" again. */}
        {live ? (
          <span className="wf-card-last">Started {relTime(live.at) === "now" ? "just now" : `${relTime(live.at)} ago`}</span>
        ) : last ? (
          <span className="wf-card-last" title={last.note || RUN_WORD[last.status]}>
            <TaskMark state={runMark(last.status)} />
            {RUN_WORD[last.status]} · {relTime(last.at) === "now" ? "just now" : `${relTime(last.at)} ago`}
          </span>
        ) : (
          <span className="wf-card-last muted">Hasn't run yet</span>
        )}
        {w.next && w.trigger.kind === "schedule" && <span className="wf-card-next" title={new Date(w.next).toLocaleString()}>Next: {whenIn(w.next, w.trigger.schedule.tz)}</span>}
      </div>
    </li>
  );
}

/** A template as a row (DIRECTION.md §9.9): its name, what it does, who does it and when, and "Use" there on hover or focus. */
function TemplateTile({ t, names, onUse }: { t: WorkflowTemplate; names: Names; onUse: () => void }) {
  const made = useMemo(() => fromTemplate(t, names.pickable.map((m) => ({ id: m.id, name: m.name, role: m.role }))), [t, names]);
  return (
    <li>
      <button type="button" className="wf-tpl-row" onClick={onUse}>
        <span className="wf-tpl-text">
          <span className="wf-tpl-name">{t.name}</span>
          <span className="wf-tpl-blurb">{t.blurb}</span>
        </span>
        <StepFaces steps={made.steps} room={TEAM_ROOM} names={names} size={20} />
        <span className="wf-tpl-when">{triggerShort(made.trigger, names)}</span>
        <span className="wf-tpl-use">
          Use <ArrowRightIcon className="size-3.5" />
        </span>
      </button>
    </li>
  );
}

// ── the builder ──────────────────────────────────────────────────────

type Sel = "trigger" | "outcomes" | string | null;

function Builder({
  identity,
  team,
  names,
  id,
  initial,
  view,
  fresh,
  others,
  ask,
  onBack,
  onSaved,
  onRan,
  onDeleted,
}: {
  identity: Identity;
  team: Team | null;
  names: Names;
  id: string | null;
  initial: Draft;
  view: WorkflowView | null;
  fresh: boolean;
  others: WorkflowView[];
  ask: ReturnType<typeof useConfirm>[0];
  onBack: () => void;
  onSaved: (v: WorkflowView) => void;
  onRan: () => void;
  onDeleted: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [saved, setSaved] = useState<Draft>(initial);
  const [sel, setSel] = useState<Sel>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  // The templates closed on load, a new workflow's too: opened from the button in the head (Arun, 2026-11-03: "have the template
  // side panel thing in the workflow page be closed by default on load").
  const [side, setSide] = useState(false);
  // Describe it, and Friday drafts it, here on the canvas it fills (Arun, 2026-11-02: "add this into the workflow page… instead of
  // in the automations page"): open on a new one, a button away on one with steps.
  const [describing, setDescribing] = useState(fresh && !initial.steps.length);
  // A new workflow says what is left in neutral words until it is first saved or run: red before anything was typed read as
  // mistakes (audit CREW-36, 2026-11-04).
  const [tried, setTried] = useState(!fresh);
  /** Run now asking its question first. */
  const [asking, setAsking] = useState(false);
  /** Someone else's (the hosted service's): looked at here, changed and run by them. */
  const owner = theirs(view);
  const dirty = !owner && (!id || !sameDraft(d, saved));
  const steps = useMemo(() => packSteps(d.steps), [d.steps]);
  const checks = useMemo(
    () => [
      ...workflowChecks({ ...d, id: id ?? "" }, { mates: names.mates, rooms: names.rooms.map((r) => ({ id: r.id, name: r.name, members: Object.keys(r.lanes) })), workflows: others.map((w) => ({ id: w.id, name: w.name })) }),
      // On the hosted service, someone else's teammate on its own plan takes its keeper's work only (own-plan.ts).
      ...(names.pick && !owner
        ? packSteps(d.steps).flatMap((s, i): WorkflowCheck[] => {
            const m = s.mate && s.mate !== LEAD && !names.pick!(s.mate) ? names.mate(s.mate) : null;
            const k = m ? names.keeperOf(m.id) : null;
            return m ? [{ level: "warn", text: `${m.name} is ${k}'s, on their own plan: step ${i + 1} is asked of ${k}, and the run waits for them to take it on`, on: s.id }] : [];
          })
        : []),
    ].sort((a, b) => (a.level === b.level ? 0 : a.level === "fix" ? -1 : 1)),
    [d, id, names, others, owner],
  );
  const fixes = checks.filter((c) => c.level === "fix");
  const live = underWay(view?.runs[0]) ? view.runs[0] : null;

  const set = (change: Partial<Draft>) => setD((x) => ({ ...x, ...change }));
  const setStep = (sid: string, change: Partial<WorkflowStep>) => setD((x) => ({ ...x, steps: x.steps.map((s) => (s.id === sid ? { ...s, ...change } : s)) }));
  /**
   * A new step: in a column of its own at `col` (the rest move along), or beside the steps of column `col`. A check or your OK
   * sends the work back to the last step before it that does work, when there is one.
   */
  /**
   * A fix step for a check or your OK (design A, Arun 2026-11-04): drawn under it, run only when it doesn't pass, then the work
   * goes back to what it checks. Who does it is asked next, in its settings.
   */
  const addFix = (gate: string) => {
    if (steps.length >= MAX_STEPS) return setError(`A workflow has up to ${MAX_STEPS} steps.`);
    const id = uid();
    setD((x) => {
      const g = x.steps.find((t) => t.id === gate);
      if (!g) return x;
      // Back afterwards to where the check sent it before, when that was an earlier step: the choice made a moment ago stays.
      const was = ifNotOf(g);
      const back = was && x.steps.findIndex((t) => t.id === was) < x.steps.indexOf(g) && !isGate(x.steps.find((t) => t.id === was)!) ? was : undefined;
      const all = [...x.steps, { id, fixFor: gate, mate: g.fixBy && g.fixBy !== LEAD ? g.fixBy : "", does: "", owns: [], col: Math.max(...x.steps.map((t) => t.col)) + 1, ...(back ? { next: back } : {}) }];
      return { ...x, steps: packSteps(all.map((t) => (t.id === gate ? { ...t, ...ifNotTo(all, t, id) } : t))) };
    });
    setSel(id);
  };
  const addStep = (col: number, alongside: boolean, kind: StepKind = "do") => {
    if (steps.length >= MAX_STEPS) return setError(`A workflow has up to ${MAX_STEPS} steps.`);
    const before = steps.filter((x) => x.col < col && !isGate(x)).at(-1);
    const gate = kind === "do" ? {} : { kind, ifNot: before ? ("back" as const) : ("stop" as const), ...(before ? { back: before.id } : {}), tries: DEFAULT_TRIES };
    const s: WorkflowStep = { id: uid(), mate: kind === "check" ? LEAD : "", does: kind === "approve" ? "Is this ready to go on?" : "", owns: [], col: alongside && kind === "do" ? col : col - 0.5, ...gate };
    setD((x) => ({ ...x, steps: packSteps([...x.steps, s]) }));
    setSel(s.id);
  };
  const removeStep = (sid: string) => {
    // A check or OK that sent the work back to it now stops instead.
    setD((x) => ({ ...x, steps: packSteps(x.steps.filter((s) => s.id !== sid).map((s) => (s.back === sid ? { ...s, ifNot: "stop" as const, back: undefined } : s))) }));
    setSel(null);
  };
  /** A step one column earlier or later: beside the steps there, or a column of its own past either end. */
  const moveStep = (sid: string, by: -1 | 1) =>
    setD((x) => {
      const cur = packSteps(x.steps);
      const s = cur.find((y) => y.id === sid)!;
      const alone = cur.filter((y) => y.col === s.col).length === 1;
      // Alone in its column, it joins the next one over; with company, it takes a column of its own just beside.
      const col = alone ? s.col + by : s.col + by * 0.5;
      return { ...x, steps: packSteps(cur.map((y) => (y.id === sid ? { ...y, col } : y))) };
    });

  /**
   * A card dragged and dropped (Arun, 2026-11-02: "be able to drag invidual cards too"): onto a column, it runs alongside the
   * steps there; into the space between two, it takes a column of its own there. The drawing is how it runs, so moving a card
   * moves the step, as Earlier and Later do.
   */
  const moveTo = (sid: string, col: number, alongside: boolean) =>
    setD((x) => {
      const cur = packSteps(x.steps);
      return { ...x, steps: packSteps(cur.map((y) => (y.id === sid ? { ...y, col: alongside ? col : col - 0.5 } : y))) };
    });

  const save = async (): Promise<WorkflowView | null> => {
    setTried(true);
    setSaving(true);
    setError("");
    try {
      const body = JSON.stringify({ ...d, name: d.name.trim() || "Untitled workflow" });
      const got = id
        ? await api<{ workflow: WorkflowView }>(identity, `/api/workflows/${id}`, { method: "PATCH", body, headers: JSON_BODY })
        : await api<{ workflow: WorkflowView }>(identity, "/api/workflows", { method: "POST", body, headers: JSON_BODY });
      setSaved(draftOf(got.workflow));
      setD(draftOf(got.workflow));
      onSaved(got.workflow);
      return got.workflow;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setSaving(false);
    }
  };
  /** A check pressed: to its card, or a first step made when there is none. */
  const goTo = (on: string) => (on === FIRST_STEP ? addStep(0, false) : setSel(on));
  const runNow = async (input?: string) => {
    setTried(true);
    if (fixes.length) return goTo(fixes[0]!.on);
    if (d.ask?.trim() && input === undefined) return setAsking(true);
    setRunning(true);
    try {
      const w = dirty ? await save() : view;
      if (!w) return;
      const { run } = await api<{ run: WorkflowRun }>(identity, `/api/workflows/${w.id}/run`, { method: "POST", body: JSON.stringify(input ? { input } : {}), headers: JSON_BODY });
      // Said with the way out: a run skipped for a busy board can be set to wait for it instead.
      if (run.status === "skipped") setError(`Skipped: ${run.note ?? "it couldn't start."}${/board|still going/.test(run.note ?? "") ? " To have runs wait for the board instead, turn off “Skip a run while one is still going” in its trigger." : ""}`);
      else if (run.status === "failed") setError(`It didn't start: ${run.note ?? "something went wrong."}`);
      else if (run.status === "waiting") setError(run.note ?? "It waits for the room's board to be free.");
      onRan();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  // What leaving would lose, asked the same way by the Back arrow and by every other way out: the sidebar, a toast, the palette,
  // the browser's Back, Code or Work, closing the window (leave-guard.ts; QA, 2026-10-28: only the arrow asked, and a new
  // workflow went without a word).
  const unsaved = owner ? false : id ? dirty : !!(d.steps.length || d.name.trim());
  const askLeave = (go: () => void) =>
    id
      ? ask({ title: "Leave without saving?", body: "Your changes to this workflow are lost.", action: "Leave", onConfirm: go })
      : ask({ title: "Leave this new workflow?", body: "It hasn't been saved, so it's lost.", action: "Leave", onConfirm: go });
  const askRef = useRef(askLeave);
  askRef.current = askLeave;
  useEffect(() => (unsaved ? holdLeave((go) => askRef.current(go)) : undefined), [unsaved]);
  const back = () => (unsaved ? askLeave(onBack) : onBack());
  const remove = () =>
    ask({
      title: `Delete ${d.name || "this workflow"}?`,
      body: "It stops running and its run history goes. Boards it already posted stay in their rooms.",
      action: "Delete workflow",
      onConfirm: async () => {
        await api(identity, `/api/workflows/${id}`, { method: "DELETE" });
        onDeleted();
      },
    });
  // ⌘S saves. ⌘Z and ⌘⇧Z (Ctrl on Windows and Linux) undo and redo a change to the steps, a wire dragged or a step added, when
  // nothing is being typed: the canvas had no undo, so ⌘Z went to the browser, which emptied the Name field instead (2026-11-04
  // retest). In a field, they stay the field's own.
  const saveRef = useRef(save);
  saveRef.current = save;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const undoSteps = useRef({ now: d.steps, back: false, h: history<Draft["steps"]>() });
  if (undoSteps.current.now !== d.steps) {
    if (!undoSteps.current.back) undoSteps.current.h.changed(undoSteps.current.now);
    undoSteps.current = { ...undoSteps.current, now: d.steps, back: false };
  }
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!ownerRef.current) void saveRef.current();
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z" && !isTyping(e.target) && !ownerRef.current) {
        e.preventDefault();
        const s = undoSteps.current;
        const to = e.shiftKey ? s.h.redo(s.now) : s.h.undo(s.now);
        if (to === undefined) return;
        s.back = true;
        setD((x) => ({ ...x, steps: to }));
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);

  /** A draft from what you said: in place of the steps there, asked first, as a template is. */
  const useDraft = (got: Partial<Draft>) => {
    const apply = () => (setD((x) => ({ ...x, ...got, name: x.name.trim() && id ? x.name : got.name || x.name })), setSel(null), setDescribing(false));
    if (d.steps.length) ask({ title: "Replace the steps with this draft?", body: "Its steps, trigger and outcomes take the place of these. Nothing is saved until you save.", action: "Replace", danger: false, onConfirm: apply });
    else apply();
  };

  const useTemplate = (t: WorkflowTemplate) => {
    const apply = () => (setD((x) => ({ ...x, ...fromTemplate(t, names.pickable.map((m) => ({ id: m.id, name: m.name, role: m.role }))), name: x.name.trim() && id ? x.name : t.name })), setSel(null));
    if (d.steps.length) ask({ title: `Replace the steps with “${t.name}”?`, body: "Its steps, trigger and outcomes take the place of these. Nothing is saved until you save.", action: "Replace", danger: false, onConfirm: apply });
    else apply();
  };

  return (
    <div className={cn("ag-studio wf-studio", side && "with-side")}>
      {asking && <RunAsk name={d.name || "it"} ask={d.ask ?? ""} onClose={() => setAsking(false)} onRun={(input) => (setAsking(false), void runNow(input))} />}
      <header className="wf-head">
        <Tip label="Back to the workflows">
          <Button variant="ghost" size="icon-sm" aria-label="Back to the workflows" onClick={back}>
            <ArrowLeftIcon />
          </Button>
        </Tip>
        <h1 className="sr-only">{id ? d.name : "New workflow"}</h1>
        <Input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Name it, like “Weekly changelog”" aria-label="Name" maxLength={80} className="wf-name" />
        <label className="wf-on">
          <Switch checked={d.on} disabled={!!owner} onCheckedChange={(on) => set({ on })} aria-label={d.on ? "On: its trigger starts it" : "Off: only Run now starts it"} />
          <span>{d.on ? "On" : "Off"}</span>
        </label>
        <div className="wf-head-tools">
          {!owner && (
            <Tip label={describing ? "Hide the description box" : "Describe it, and Friday drafts it"}>
              <Button variant="ghost" size="icon-sm" aria-label={describing ? "Hide the description box" : "Describe it, and Friday drafts it"} aria-pressed={describing} onClick={() => setDescribing((x) => !x)}>
                <MessageSquareTextIcon />
              </Button>
            </Tip>
          )}
          <Tip label={side ? "Hide the templates" : "Start from a template"}>
            <Button variant="ghost" size="icon-sm" aria-label={side ? "Hide the templates" : "Start from a template"} aria-pressed={side} onClick={() => setSide((x) => !x)}>
              <LayoutTemplateIcon />
            </Button>
          </Tip>
          <ReadyChip checks={checks} quiet={!tried} onPick={(c) => goTo(c.on)} />
          {id && <RunsButton identity={identity} id={id} runs={view?.runs ?? []} team={team} onRan={onRan} />}
          {owner ? (
            // Someone else's: theirs to change and run, said where the buttons would be.
            <span className="wf-owner" title={`Only ${owner.name} changes or runs it`}>
              {owner.name}'s
            </span>
          ) : null}
          {id && !owner && (
            <Tip label="Delete this workflow">
              <Button variant="ghost" size="icon-sm" aria-label="Delete this workflow" className="text-[var(--text-muted)]" onClick={remove}>
                <Trash2Icon />
              </Button>
            </Tip>
          )}
          {!owner && (
            <>
              <Button variant="outline" size="sm" className="h-8 border-[var(--border)] bg-[var(--bg)] px-3 text-[13px] shadow-none" disabled={running || saving} onClick={() => void runNow()} title={fixes.length ? fixes[0]!.text : dirty ? "Saves it, then runs it" : "Run it now"}>
                <PlayIcon /> {running ? "Starting…" : "Run now"}
              </Button>
              <Button size="sm" className="h-8 px-3 text-[13px]" disabled={saving || (!dirty && !!id)} onClick={() => void save()}>
                {saving ? "Saving…" : id ? (dirty ? "Save" : "Saved") : "Create"}
              </Button>
            </>
          )}
        </div>
      </header>
      {side && <TemplatePanel names={names} onUse={useTemplate} onClose={() => setSide(false)} />}
      <section className={cn("wf-canvas-wrap", !tried && "quiet")} aria-label="How this workflow runs">
        {error && (
          <p role="alert" className="wf-error">
            {error}
            <button type="button" aria-label="Dismiss" onClick={() => setError("")}>
              <XIcon className="size-3.5" />
            </button>
          </p>
        )}
        {live && <LiveLine run={live} steps={steps} />}
        {describing && !owner && !live && (
          <div className="wf-draft-float">
            <DraftBox identity={identity} over={d.steps.length > 0} onDraft={useDraft} onClose={() => setDescribing(false)} />
          </div>
        )}
        {live?.status === "asking" && id && (
          <div className="wf-asks-float">
            <WorkflowAsksFor identity={identity} id={id} onAnswered={onRan} />
          </div>
        )}
        <Canvas d={d} steps={steps} names={names} others={others} sel={sel} live={live} checks={checks} onPick={setSel} onAdd={addStep} onMove={owner ? undefined : moveTo} onLayout={owner ? undefined : (layout) => set({ layout })} onConnect={owner || live ? undefined : (source, port, target) => setStep(source, port === "otherwise" ? ifNotTo(steps, steps.find((x) => x.id === source)!, target) : { next: target })} />
        {sel && (
          <Inspector
            key={sel}
            identity={identity}
            sel={sel}
            d={d}
            steps={steps}
            names={names}
            others={others}
            hookUrl={view?.trigger.kind === "webhook" ? view.trigger.url : undefined}
            onClose={() => {
              const was = sel;
              setSel(null);
              requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-wf-node="${was}"]`)?.focus());
            }}
            set={set}
            setStep={setStep}
            moveStep={moveStep}
            removeStep={removeStep}
            addFix={addFix}
          />
        )}
      </section>
    </div>
  );
}

/** This workflow's runs waiting for your OK, over its canvas. */
function WorkflowAsksFor({ identity, id, onAnswered }: { identity: Identity; id: string; onAnswered: () => void }) {
  return <WorkflowAsks identity={identity} workflow={id} onAnswered={onAnswered} />;
}

/** While a run goes: where, and how far it has got. */
function LiveLine({ run, steps }: { run: WorkflowRun; steps: WorkflowStep[] }) {
  return (
    // One live line, no dot: the faces of the steps under way wear the ring (DIRECTION.md §8).
    <p className="wf-live" role="status">
      <span className={run.status === "running" ? "tm-live-text" : undefined}>
        {liveWords(run, steps)}
        {run.status === "running" && run.note ? ` · ${run.note}` : ""}
        {/* A step asked of another keeper waits on them (the hosted service's): said here, as its card does. */}
        {run.status === "running" && ((k) => (k ? ` · waiting on ${k}` : ""))(run.steps.find((x) => x.asked?.status === "open" && x.status === "open")?.asked?.keeper)}
      </span>
    </p>
  );
}

function TemplatePanel({ names, onUse, onClose }: { names: Names; onUse: (t: WorkflowTemplate) => void; onClose: () => void }) {
  return (
    <aside className="wf-side" aria-label="Templates">
      <div className="wf-side-head">
        <span>Start from a template</span>
        <Button variant="ghost" size="icon-xs" aria-label="Hide the templates" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <p className="wf-side-note">Each fills its steps with the teammates that suit them. Pick the rest yourself.</p>
      <ul className="wf-side-list">
        {WORKFLOW_TEMPLATES.map((t) => (
          <li key={t.id}>
            <button type="button" className="wf-side-tpl" onClick={() => onUse(t)}>
              <span className="wf-side-tpl-name">{t.name}</span>
              <span className="wf-side-tpl-blurb">{t.blurb}</span>
              <StepFaces steps={fromTemplate(t, names.pickable.map((m) => ({ id: m.id, name: m.name, role: m.role }))).steps} room={TEAM_ROOM} names={names} size={18} />
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/** What is missing, worst first, in a chip that opens to the list; an item pressed goes to its card. */
function ReadyChip({ checks, onPick, quiet }: { checks: WorkflowCheck[]; onPick: (c: WorkflowCheck) => void; /** Not yet saved or run: what is left, in neutral words (audit CREW-36). */ quiet?: boolean }) {
  const fixes = checks.filter((c) => c.level === "fix").length;
  const tone: DotState = fixes && !quiet ? "bad" : checks.length ? "idle" : "done";
  // The steps still to finish, each once, however many things each lacks.
  const toFinish = new Set(checks.filter((c) => c.level === "fix").map((c) => c.on)).size;
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-2 border-[var(--border)] bg-[var(--bg)] text-[13px] shadow-none">
          <Dot state={tone} />
          {fixes ? (quiet ? `${toFinish} step${toFinish === 1 ? "" : "s"} to finish` : `${fixes} to fix`) : checks.length ? `${checks.length} to check` : "Ready to run"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-1.5">
        <ul className="m-0 flex list-none flex-col p-0" role="list">
          {checks.length === 0 ? (
            <li className="flex items-start gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-[var(--ink-2)]">
              <Dot state="done" className="mt-[5px]" /> Every step has a teammate and its instructions.
            </li>
          ) : (
            checks.map((c) => (
              <li key={c.text}>
                <button type="button" className="wf-check" onClick={() => (setOpen(false), onPick(c))}>
                  <Dot state={c.level === "fix" ? "bad" : "idle"} className="mt-[5px]" />
                  {c.text}
                </button>
              </li>
            ))
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** The last runs, each opening its room, with its steps while it goes. */
function RunsButton({ identity, id, runs: recent, team, onRan }: { identity: Identity; id: string; runs: WorkflowRun[]; team: Team | null; onRan: () => void }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState(recent);
  const [retrying, setRetrying] = useState("");
  useEffect(() => setRuns(recent), [recent]);
  const read = useCallback(() => void api<{ runs: WorkflowRun[] }>(identity, `/api/workflows/${id}/runs`).then((r) => setRuns(r.runs), () => {}), [id, identity]);
  useEffect(() => {
    if (open) read();
  }, [open, read]);
  /** A run that didn't finish, picked up from the stage it stopped at. */
  const retry = async (r: WorkflowRun) => {
    setRetrying(r.id);
    try {
      const got = await api<{ run: WorkflowRun }>(identity, `/api/workflows/${id}/runs/${r.id}/retry`, { method: "POST", body: "{}", headers: JSON_BODY });
      setRuns((l) => l.map((x) => (x.id === r.id ? got.run : x)));
      onRan();
    } catch (e) {
      setRuns((l) => l.map((x) => (x.id === r.id ? { ...x, note: (e as Error).message } : x)));
    } finally {
      setRetrying("");
    }
  };
  const last = recent[0];
  const openRoom = (r: WorkflowRun) => {
    const invite = r.sid === team?.sid ? team?.invite : team?.rooms.find((x) => x.sid === r.sid)?.invite;
    if (r.sid && invite) dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: r.sid, invite } }));
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label="Its last runs">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-[13px] text-[var(--ink-2)]" aria-label={last ? `Its last runs, the latest ${relTime(last.at) === "now" ? "just now" : `${relTime(last.at)} ago`}` : "Its runs: none yet"}>
            {/* Where a run stands is the canvas's banner's to say: here, only the way to the runs. */}
            <HistoryIcon />
            <span className="wf-runs-word">Runs</span>
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="w-[340px] p-1.5">
        {!runs.length ? (
          <p className="m-0 px-2.5 py-2 text-[13px] text-[var(--text-muted)]">It hasn't run yet. Run now starts one, or its trigger will.</p>
        ) : (
          <ul className="m-0 flex max-h-[360px] list-none flex-col overflow-y-auto p-0" role="list">
            {runs.map((r) => (
              <li key={r.id} className="wf-run-li">
                <button type="button" className="wf-run" disabled={!r.sid} onClick={() => (openRoom(r), setOpen(false))}>
                  <TaskMark state={runMark(r.status)} />
                  <span className="wf-run-body">
                    <span className="wf-run-top">
                      <b>{RUN_WORD[r.status]}</b>
                      <span>{timeOf(r.at)}</span>
                    </span>
                    <span className="wf-run-sub">
                      {r.trigger}
                      {r.roomName ? ` · ${r.roomName}` : ""}
                    </span>
                    {r.note && <span className="wf-run-note">{r.note}</span>}
                    {underWay(r) && (
                      <span className="wf-run-steps">
                        {r.steps.map((s) => (
                          <span key={s.task} title={`${s.title}: ${s.asked?.status === "open" && s.status === "open" ? `waiting on ${s.asked.keeper}` : STEP_WORD[s.status]}`}>
                            <TaskMark state={stepMark(s.status)} />
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </button>
                {(r.status === "failed" || r.status === "stopped") && r.stage !== undefined && (
                  <button type="button" className="wf-run-retry" disabled={retrying === r.id} onClick={() => void retry(r)}>
                    <RotateCcwIcon className="size-3.5" /> {retrying === r.id ? "Starting…" : "Try again from here"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── the canvas ───────────────────────────────────────────────────────

const ZOOMS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
/**
 * "Fit it in view": the zoom, on top of the one the canvas picks by itself (`fit`, never under 60% so words stay readable), that
 * shows the whole line across `viewW`. It only reset to that 60%, so a workflow of five steps still ran past the right edge
 * (2026-11-04 retest). Never under 30%, nor over the canvas's own.
 */
export function fitAllZoom(viewW: number, contentW: number, fit: number): number {
  const all = Math.max(0.3, Math.min(1, (viewW - 48) / Math.max(1, contentW)));
  return +Math.min(1, all / fit).toFixed(3);
}

const stepZoom = (z: number, dir: 1 | -1) => {
  const i = ZOOMS.findIndex((v) => v >= z - 0.001);
  return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i < 0 ? ZOOMS.length - 1 : i) + dir))]!;
};

type AddStep = (col: number, alongside: boolean, kind?: StepKind) => void;

/**
 * Where the cards sit (Arun, 2026-11-03: "be able to drag around the layout of the workflow… everything still being connected,
 * rather than just relying on it being a straight line order"). Each column is laid out as before, left to right, and a card
 * moved by hand keeps its offset from there (Workflow.layout): a step added or taken out moves the columns after it along, and
 * the cards moved by hand go with them rather than under a new one. The wires are drawn from where the cards are, so they follow.
 * The widths are workflows.css's .wf-node and .wf-node-trigger.
 */
const STEP_W = 248;
const END_W = 224;
const COL_GAP = 96;
const ROW_GAP = 20;
const PAD = 48;
type Pt = { x: number; y: number };
type Box = Pt & { id: string; w: number; h: number };
const avg = (xs: number[]) => xs.reduce((t, x) => t + x, 0) / Math.max(1, xs.length);

function Canvas({ d, steps, names, others, sel, live, checks, onPick, onAdd, onMove, onLayout, onConnect }: { d: Draft; steps: WorkflowStep[]; names: Names; others: { id: string; name: string }[]; sel: Sel; live: WorkflowRun | null; checks: WorkflowCheck[]; onPick: (s: Sel) => void; onAdd: AddStep; /** A step's card dropped: onto column `col` (alongside), or into the space before it. */ onMove?: (id: string, col: number, alongside: boolean) => void; /** Cards moved by hand: each one's offset from where its column puts it; {} puts them all back. */ onLayout?: (l: WorkflowLayout) => void; onConnect?: (source: string, port: WorkflowPort, target: string) => void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const flow = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ w: 1000, h: 600, fw: 900, fh: 400 });
  const [userZoom, setZoom] = useState(1);
  const [shift, setShift] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const pan = useRef<Pt | null>(null);
  const connectionDrag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [connecting, setConnecting] = useState<{ source: string; port: WorkflowPort } | null>(null);
  /** Why a wire dropped where it was couldn't go there. */
  const [refused, setRefused] = useState("");
  /** A card held: where the pointer went down, whether it has moved yet, and the drop under it. */
  const drag = useRef<{ id: string; x: number; y: number; moved: boolean; on: Element | null } | null>(null);
  /** The card being dragged and how far, in the canvas's units: drawn there, its wires with it. */
  const [held, setHeld] = useState<{ id: string; dx: number; dy: number } | null>(null);
  /** The cards' heights as drawn: a column is centred on them. */
  const [hs, setHs] = useState<Record<string, number>>({});
  /**
   * A card dropped into a new place in the order, once the columns are laid out again: kept at `at` (under a column's cards), or,
   * with none, in line in its new column, the columns after moved along to make room.
   */
  const pin = useRef<{ id: string; at: Pt | null } | null>(null);
  /** A card kept still on the screen after a drop, as the drawing around it grows or shrinks. */
  const anchor = useRef<{ id: string; left: number; top: number } | null>(null);
  /** The column under the pointer: its Alongside shows. */
  const [hot, setHot] = useState(-1);
  const cols = columnsOf(steps);
  // Fix steps: under the check that sends them work, not a column of the line (design A).
  const fix = fixSteps(steps);
  const fixLane = (lane: { id: string }[]) => lane.length > 0 && lane.every((n) => fix.has(n.id));
  const gateOf = (id: string) => ((f) => steps.find((x) => isGate(x) && x.id === f?.fixFor))(steps.find((x) => x.id === id));
  // Narrower than a column and its neighbours need, the steps are a list, top to bottom, at full size.
  const stacked = view.w < 640;
  const stackedNow = useRef(stacked);
  stackedNow.current = stacked;
  const flagged = new Set(checks.filter((c) => c.level === "fix").map((c) => c.on));
  const runStep = (id: string) => live?.steps.find((s) => s.step === id) ?? null;
  const full = steps.length >= MAX_STEPS;

  // The columns as drawn: the trigger, the steps', then what happens after; each laid out in its place, centred on one line.
  const lanes: { id: string; w: number }[][] = [[{ id: "trigger", w: END_W }], ...cols.map((c) => c.map((s) => ({ id: s.id, w: STEP_W }))), [{ id: "outcomes", w: END_W }]];
  const hOf = (id: string) => hs[id] ?? 132;
  const auto: Record<string, Pt> = {};
  let autoW = 0;
  for (const lane of lanes) {
    if (fixLane(lane)) continue;
    const colW = Math.max(...lane.map((n) => n.w));
    let y = -(lane.reduce((t, n) => t + hOf(n.id), 0) + ROW_GAP * (lane.length - 1)) / 2;
    for (const n of lane) {
      auto[n.id] = { x: autoW + (colW - n.w) / 2, y };
      y += hOf(n.id) + ROW_GAP;
    }
    // With no steps yet, room between the two for "Add the first step".
    autoW += colW + (steps.length ? COL_GAP : 236);
  }
  autoW -= steps.length ? COL_GAP : 236;
  // Each fix step under its check, room between for the answer's words, a check's several one under another.
  const under: Record<string, number> = {};
  for (const id of [...fix]) {
    const g = gateOf(id);
    const ga = g && auto[g.id];
    if (!g || !ga) {
      auto[id] = { x: autoW + COL_GAP, y: 0 };
      continue;
    }
    const y = under[g.id] ?? ga.y + hOf(g.id) + 76;
    auto[id] = { x: ga.x, y };
    under[g.id] = y + hOf(id) + ROW_GAP;
  }
  // Moved by hand: its own offset. A card added since takes its column's, or the column before's, so it lands among them.
  const saved = d.layout ?? {};
  const offs: Record<string, Pt> = {};
  let carry: Pt = { x: 0, y: 0 };
  for (const lane of lanes) {
    if (fixLane(lane)) continue;
    const own = lane.find((n) => saved[n.id]);
    const lean = own ? saved[own.id]! : carry;
    for (const n of lane) offs[n.id] = saved[n.id] ?? lean;
    carry = offs[lane[0]!.id]!;
  }
  // A fix step moves with its check, unless moved by hand.
  for (const id of fix) offs[id] = saved[id] ?? offs[gateOf(id)?.id ?? ""] ?? { x: 0, y: 0 };
  const at = (id: string, still = false): Pt => {
    const a = auto[id]!;
    const o = offs[id]!;
    const h = !still && held?.id === id ? held : null;
    return { x: a.x + o.x + (h?.dx ?? 0), y: a.y + o.y + (h?.dy ?? 0) };
  };
  const ids = lanes.flat().map((n) => n.id);
  const boxOf = (id: string, still = false): Box => ({ id, ...at(id, still), w: id === "trigger" || id === "outcomes" ? END_W : STEP_W, h: hOf(id) });
  const boxes = ids.map((id) => boxOf(id));
  const byId = new Map(boxes.map((b) => [b.id, b]));
  // The frame, without the card being dragged's move, so the drawing doesn't slide under the pointer while it moves.
  const still = ids.map((id) => boxOf(id, true));
  const frame = { x: Math.min(...still.map((b) => b.x)), y: Math.min(...still.map((b) => b.y)), r: Math.max(...still.map((b) => b.x + b.w)), b: Math.max(...still.map((b) => b.y + b.h)) };

  // Explicit paths use the same card boxes as the free layout, so moving a card moves every connection with it.
  const connections = connectionsOf(steps).map(c => ({ ...c, target: c.target === "$finish" ? "outcomes" : c.target }));
  for (const n of cols[0] ?? []) connections.unshift({ source: "trigger", target: n.id, port: "next", explicit: false });
  if (!steps.length) connections.push({ source: "trigger", target: "outcomes", port: "next", explicit: false });
  // Drawn under the cards: a path somebody chose, and where a check sends work that doesn't pass. The rest are the wires between columns.
  // A chosen next that is the next column anyway is an ordinary wire, as the end after the last column is.
  const laneAt = new Map(lanes.filter((l) => !fixLane(l)).flatMap((lane, k) => lane.map((n) => [n.id, k] as const)));
  const plainNext = (c: { source: string; target: string; port: WorkflowPort }) => c.port === "next" && !fix.has(c.source) && laneAt.has(c.source) && laneAt.get(c.target) === laneAt.get(c.source)! + 1;
  const routed = (c: typeof connections[number]) => ((c.explicit && !plainNext(c)) || c.port === "otherwise" || fix.has(c.source));
  const working = (id: string) => ((s) => s?.status === "claimed" || s?.status === "review")(runStep(id));
  const finished = (id: string) => runStep(id)?.status === "done";
  const loops = connections.filter(c => routed(c) && byId.has(c.target)).map((c, i) => {
    const A = byId.get(c.source)!;
    const B = byId.get(c.target)!;
    const gate = steps.find(s => s.id === c.source)!;
    const x1 = A.x + A.w / 2, x2 = B.x + B.w / 2;
    const lo = Math.min(A.x, B.x), hi = Math.max(A.x + A.w, B.x + B.w);
    const floor = Math.max(...boxes.filter(b => b.x < hi && b.x + b.w > lo).map(b => b.y + b.h));
    const low = floor + 46 + i * 34;
    const under = boxes.some(b => b.id !== B.id && b.id !== A.id && b.x < B.x + B.w && b.x + b.w > B.x && b.y >= B.y + B.h - 1 && b.y < low);
    const xe = under ? B.x + B.w + 22 : x2;
    const r = Math.min(12, Math.abs(xe - x1) / 2), direction = xe < x1 ? -1 : 1;
    const end = under ? `L${xe},${B.y + B.h - 22 + r} Q${xe},${B.y + B.h - 22} ${xe - r},${B.y + B.h - 22} L${B.x + B.w + 7},${B.y + B.h - 22}` : `L${x2},${B.y + B.h + 7}`;
    const ok = gate.kind === "approve";
    const label = c.port === "otherwise" ? (ok ? "No" : "Fail") : isGate(gate) ? (ok ? "Yes" : "Pass") : "Next";
    const to = steps.findIndex((s) => s.id === c.target) + 1;
    const back = to > 0 && to <= steps.indexOf(gate);
    // Said as the card says it: back to an earlier step, down to a fix step, or on to where it was told to go.
    const text =
      c.port === "otherwise"
        ? fix.has(c.target) ? `${ok ? "If you say no" : "If it fails"} · up to ${gate.tries ?? DEFAULT_TRIES}×` : `Back to step ${to} · up to ${gate.tries ?? DEFAULT_TRIES}×`
        : fix.has(c.source) ? (c.target === "outcomes" ? "Then the end" : `Then ${back ? "back to " : ""}step ${to}`)
        : `${isGate(gate) ? (ok ? "If yes: " : "If it passes: ") : "Then "}${c.target === "outcomes" ? "the end" : `step ${to}`}`;
    // Down to a fix step under it: straight down. A fix step's way back up: out of its side, along, and up into that step.
    const ya = A.y + A.h / 2;
    const down = B.y >= A.y + A.h - 1 && Math.abs(x2 - x1) < A.w;
    const up = fix.has(c.source) && A.y >= B.y + B.h - 1 && (x2 < A.x || x2 > A.x + A.w);
    const sx = x2 < A.x ? A.x : A.x + A.w;
    const turn = x2 < A.x ? 12 : -12;
    const path = down
      ? `M${x1},${A.y + A.h} C${x1},${A.y + A.h + 28} ${x2},${B.y - 34} ${x2},${B.y - 7}`
      : up
        ? `M${sx},${ya} L${x2 + turn},${ya} Q${x2},${ya} ${x2},${ya - 12} L${x2},${B.y + B.h + 7}`
        : `M${x1},${A.y + A.h} L${x1},${low - r} Q${x1},${low} ${x1 + direction * r},${low} L${xe - direction * r},${low} Q${xe},${low} ${xe},${low - r} ${end}`;
    return {
      ...c, id: `${c.source}:${c.port}:${c.target}`,
      d: path,
      x: down ? (x1 + x2) / 2 : up ? (sx + x2) / 2 : (x1 + xe) / 2, y: down ? (A.y + A.h + B.y) / 2 : up ? ya : low, low: down || up ? A.y + A.h : low, label,
      text,
      live: !!live && finished(c.source) && working(c.target),
    };
  });
  frame.b = Math.max(frame.b, ...loops.map(l => l.low + 14));
  // Into the flow's own units: the frame's corner at PAD, PAD. Held as it was while a card is dragged: a loop dragged lower
  // grew the frame, and the whole drawing slid up under the pointer.
  const live0 = { fw: frame.r - frame.x + PAD * 2, fh: frame.b - frame.y + PAD * 2, ox: PAD - frame.x, oy: PAD - frame.y };
  const frozen = useRef(live0);
  if (!held) frozen.current = live0;
  const { fw, fh, ox, oy } = held ? frozen.current : live0;

  // Default next-column wires retain the upstream bends and selection/working states.
  const wires = connections.filter(c => !routed(c) && byId.has(c.target)).map(c => {
    const A = byId.get(c.source)!, B = byId.get(c.target)!;
    const x1 = A.x + A.w, y1 = A.y + A.h / 2, x2 = B.x, y2 = B.y + B.h / 2;
    const k = Math.max(44, Math.abs(x2 - x1) / 2, x2 < x1 + 24 ? 96 : 0);
    return { d: `M${x1},${y1} C${x1 + k},${y1} ${x2 - k},${y2} ${x2},${y2}`, live: !!live && (c.source === "trigger" || finished(c.source)) && working(c.target), on: !!sel && (sel === c.source || sel === c.target) };
  });
  // The "+" between two columns, on the wires between them: a step there, or a card dropped there taking a column of its own.
  // Between the columns of the line only: a fix step's column has none (a step added there goes before it).
  const drawn = lanes.map((lane, i) => ({ lane, i })).filter((x) => !fixLane(x.lane));
  const gaps = drawn.slice(0, -1).map(({ lane }, k) => {
    const next = drawn[k + 1]!;
    const A = lane.map((n) => byId.get(n.id)!);
    const B = next.lane.map((n) => byId.get(n.id)!);
    return { at: next.i - 1, x: (avg(A.map((b) => b.x + b.w)) + avg(B.map((b) => b.x))) / 2, y: (avg(A.map((b) => b.y + b.h / 2)) + avg(B.map((b) => b.y + b.h / 2))) / 2 };
  });
  // Alongside, under a column's lowest card, for the column under the pointer or with a card open.
  const besides = cols.flatMap((col, i) => {
    if (col.length === 1 && (isGate(col[0]!) || !!col[0]!.next || fix.has(col[0]!.id))) return [];
    const low = col.map((s) => byId.get(s.id)!).sort((a, b) => b.y + b.h - (a.y + a.h))[0]!;
    return [{ i, x: low.x, y: low.y + low.h + 10, on: hot === i + 1 || col.some((s) => s.id === sel) }];
  });

  // Never below 60% by itself, where a card's words can still be read: a wider one is panned across, or zoomed out. Fitted to
  // the columns as laid out, not to where cards were dragged, so moving one doesn't zoom the rest.
  const fit = stacked ? 1 : Math.max(0.6, Math.min(1, (view.w - 48) / (autoW + PAD * 2)));
  const zoom = +(userZoom * fit).toFixed(3);
  const fitAll = () => (setZoom(fitAllZoom(view.w, autoW + PAD * 2, fit)), setShift({ x: 0, y: 0 }));
  const moved = Object.keys(saved).length > 0;
  /** Every card's offset as drawn now: written whole the first time one is moved, so the others stay where they are. */
  const whole = (): WorkflowLayout => Object.fromEntries(ids.map((id) => [id, { x: Math.round(offs[id]!.x), y: Math.round(offs[id]!.y) }]));

  useLayoutEffect(() => {
    const el = scroll.current;
    const f = flow.current;
    if (!el || !f) return;
    const measure = () => setView({ w: el.clientWidth, h: el.clientHeight, fw: f.offsetWidth, fh: f.offsetHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(f);
    return () => ro.disconnect();
  }, []);
  // Every drawing: the cards' heights as they came out, then a dropped card kept where it was let go, then kept still on screen.
  useLayoutEffect(() => {
    const f = flow.current;
    if (!f || stacked) return;
    const got: Record<string, number> = {};
    for (const el of f.querySelectorAll<HTMLElement>("[data-wf-node]")) got[el.dataset.wfNode!] = el.offsetHeight;
    if (Object.keys(got).some((k) => got[k] !== hs[k])) return setHs(got);
    const p = pin.current;
    if (p && auto[p.id] && onLayout) {
      pin.current = null;
      const l = whole();
      if (p.at) l[p.id] = { x: Math.round(p.at.x - auto[p.id]!.x), y: Math.round(p.at.y - auto[p.id]!.y) };
      else delete l[p.id];
      return onLayout(l);
    }
    const a = anchor.current;
    const card = a && f.querySelector<HTMLElement>(`[data-wf-node="${a.id}"]`);
    anchor.current = null;
    if (a && card) {
      const r = card.getBoundingClientRect();
      if (Math.abs(r.left - a.left) > 0.5 || Math.abs(r.top - a.top) > 0.5) setShift((s) => ({ x: s.x + a.left - r.left, y: s.y + a.top - r.top }));
    }
  });
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      // A list (narrow) scrolls as a page does.
      if (stackedNow.current) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) return setZoom((z) => Math.min(1.5, Math.max(0.5, +(z * (e.deltaY < 0 ? 1.08 : 1 / 1.08)).toFixed(2))));
      // The wheel pans, as the drag does, sideways with Shift or a trackpad's sideways swipe: it did nothing (QA, 2026-10-28;
      // Arun: "TEST EVERYTHING… EVERY INTERACTION").
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k;
      const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * k;
      setShift((s) => ({ x: s.x - dx, y: s.y - dy }));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);
  // A card opened is brought into sight, clear of the settings over the canvas's right edge (a new step added past the last).
  useEffect(() => {
    if (!sel || stacked) return;
    const t = window.setTimeout(() => {
      const el = scroll.current;
      const card = flow.current?.querySelector<HTMLElement>(`[data-wf-node="${sel}"]`);
      if (!el || !card) return;
      const box = el.getBoundingClientRect();
      const r = card.getBoundingClientRect();
      const right = box.right - (box.width > 700 ? 372 : 16);
      const dx = r.right > right ? right - r.right : r.left < box.left + 16 ? box.left + 16 - r.left : 0;
      if (dx) setShift((s) => ({ ...s, x: s.x + dx }));
    }, 30);
    return () => clearTimeout(t);
  }, [sel, stacked]);

  const connect = (source: string, port: WorkflowPort, target: string) => {
    // Never to itself: a check whose Fails was dropped on its own card sent its work back to itself (2026-11-04 end-to-end check).
    // Said, for a moment, rather than nothing happening (2026-11-04 retest).
    if (onConnect && target === source) (setRefused("A step can't send its work to itself: drop it on another step."), setTimeout(() => setRefused(""), 4000));
    if (!onConnect || target === source || !steps.some(s => s.id === source && (port === "next" || isGate(s)))) return setConnecting(null);
    onConnect(source, port, target === "outcomes" ? "$finish" : target);
    setConnecting(null);
    onPick(source);
  };
  const tidy = () => (onLayout?.({}), setZoom(1), setShift({ x: 0, y: 0 }));
  /** A card's way out, dragged onto a step to send it there; clicked, the card's settings open where every choice is. */
  const portProps = (id: string, port: WorkflowPort) => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      connectionDrag.current = { x: e.clientX, y: e.clientY, moved: false };
      setConnecting({ source: id, port });
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
      const drag = connectionDrag.current;
      if (drag && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) drag.moved = true;
    },
    onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (connectionDrag.current?.moved) {
        const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-wf-node]")?.dataset.wfNode;
        if (target && target !== "trigger") connect(id, port, target);
      } else if (connectionDrag.current) {
        setConnecting(null);
        onPick(id);
      }
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    },
    onPointerCancel: () => {
      connectionDrag.current = null;
      setConnecting(null);
    },
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (e.detail === 0) setConnecting({ source: id, port });
      connectionDrag.current = null;
    },
  });
  /** A step said the way the cards say it: "4 · Finalize and land it"; the end, as such. */
  const titleOf = (id: string) => {
    if (id === "outcomes" || id === "$finish") return "The end";
    const x = steps.find((t) => t.id === id);
    return x ? `${steps.indexOf(x) + 1} · ${stepTitle(x, steps.indexOf(x) + 1)}` : "A step that's gone";
  };
  const passTo = (x: WorkflowStep) => {
    const t = connections.filter((c) => c.source === x.id && c.port === "next").map((c) => c.target);
    return t.length ? `${titleOf(t[0]!)}${t.length > 1 ? ` +${t.length - 1}` : ""}` : "The end";
  };
  const failTo = (x: WorkflowStep) => {
    const t = ifNotOf(x);
    if (!t) return sendsOn(x) ? "Pick a step" : "Stops the run";
    const n = steps.findIndex((y) => y.id === t);
    return n >= 0 && n < steps.indexOf(x) ? `Back to ${titleOf(t)}` : titleOf(t);
  };
  const node = (id: string, children: ReactNode, lane = -1) => {
    const b = byId.get(id);
    const s = steps.find((x) => x.id === id);
    const col = s ? cols.findIndex((c) => c.includes(s)) : -1;
    return (
      <NodeCard
        key={id}
        id={id}
        sel={sel}
        flagged={flagged}
        onPick={onPick}
        runStep={runStep}
        held={held?.id === id}
        style={stacked || !b ? undefined : { left: b.x + ox, top: b.y + oy }}
        drop={!stacked && s && !(cols[col]!.length === 1 && (isGate(s) || !!s.next || fix.has(s.id))) ? `col:${col}` : undefined}
        onEnter={lane < 0 ? undefined : () => setHot(lane)}
        onLeave={lane < 0 ? undefined : () => setHot((h) => (h === lane ? -1 : h))}
      >
        {children}
        {onConnect && id !== "trigger" && (
          <button type="button" className="wf-input-port" aria-label={`Connect to ${s ? stepTitle(s, steps.indexOf(s) + 1) : "Finish"}`} disabled={!connecting}
            onClick={e => { e.stopPropagation(); if (connecting) connect(connecting.source, connecting.port, id); }}>
            ●
          </button>
        )}
        {s && isGate(s) && (
          <div className="wf-exits">
            {(["next", "otherwise"] as WorkflowPort[]).map((port) => {
              const pass = port === "next";
              const ok = s.kind === "approve";
              const word = pass ? (ok ? "Yes" : "Passes") : ok ? "No" : "Fails";
              const to = pass ? passTo(s) : failTo(s);
              const inner = (
                <>
                  {pass ? <CheckIcon className="wf-exit-ic" aria-hidden="true" /> : <XIcon className="wf-exit-ic" aria-hidden="true" />}
                  <span className="wf-exit-k">{word}</span>
                  <span className="wf-exit-to">{to}</span>
                </>
              );
              return onConnect ? (
                <button key={port} type="button" className={cn("wf-exit", pass ? "pass" : "fail")} aria-pressed={connecting?.source === id && connecting.port === port} aria-label={`${word}: ${to}. Drag onto a step to change it`} title="Drag onto a step to send it there" {...portProps(id, port)}>
                  {inner}
                </button>
              ) : (
                <div key={port} className={cn("wf-exit", pass ? "pass" : "fail")}>
                  {inner}
                </div>
              );
            })}
          </div>
        )}
        {onConnect && s && !isGate(s) && (
          <div className="wf-output-ports">
            <button type="button" aria-pressed={connecting?.source === id && connecting.port === "next"} aria-label={`Connect Next from ${stepTitle(s, 1)}`} {...portProps(id, "next")}>
              Next ●
            </button>
          </div>
        )}
      </NodeCard>
    );
  };
  const body = (s: WorkflowStep) => (isGate(s) ? <GateBody s={s} n={steps.indexOf(s) + 1} steps={steps} names={names} room={d.room} run={runStep(s.id)} /> : <StepBody s={s} n={steps.indexOf(s) + 1} names={names} room={d.room} at={runStep(s.id)?.status ?? null} asked={runStep(s.id)?.asked ?? null} again={runStep(s.id)?.again ?? 0} />);
  const gapLabel = (i: number) => (i === 0 ? (steps.length ? "Add before the first step" : "Add the first step") : lanes.slice(i + 1, -1).every(fixLane) ? "Add after the last step" : `Add after step ${steps.indexOf(cols[i - 1]!.at(-1)!) + 1}`);
  return (
    <div className={cn("wf-canvas", stacked && "stacked")} onKeyDown={e => { if (e.key === "Escape") { connectionDrag.current = null; setConnecting(null); } }}>
      {connecting && <div className="wf-connect-note" role="status">Choose an input dot to connect this path. <button type="button" onClick={() => { connectionDrag.current = null; setConnecting(null); }}>Cancel</button></div>}
      {!connecting && refused && <div className="wf-connect-note" role="status">{refused}</div>}
      <div
        className={cn("wf-scroll", panning && "panning", held && "dragging-card")}
        ref={scroll}
        onPointerDown={(e) => {
          const t = e.target as HTMLElement;
          if (e.button !== 0 || stacked || t.closest("button, input, textarea, [data-wf-connection]")) return;
          const card = t.closest<HTMLElement>("[data-wf-node]");
          if (card) {
            // A card, not while a run is going: held, it is dragged once it moves; let go where it was, it opens.
            if (!onMove || !onLayout || live) return;
            drag.current = { id: card.dataset.wfNode!, x: e.clientX, y: e.clientY, moved: false, on: null };
            e.currentTarget.setPointerCapture(e.pointerId);
            return;
          }
          pan.current = { x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const g = drag.current;
          if (g) {
            const dx = e.clientX - g.x;
            const dy = e.clientY - g.y;
            if (!g.moved && Math.hypot(dx, dy) < 4) return;
            g.moved = true;
            setHeld({ id: g.id, dx: dx / zoom, dy: dy / zoom });
            // A step dropped on a "+" takes a column of its own there; on another step's card, it runs alongside it. A check or
            // your OK stands alone, so only a "+"; the trigger and Then only move.
            const s = steps.find((x) => x.id === g.id);
            const under = s ? (document.elementFromPoint(e.clientX, e.clientY)?.closest((isGate(s) || !!s.next) ? "[data-wf-drop^='gap:']" : "[data-wf-drop]") ?? null) : null;
            if (under !== g.on) {
              g.on?.classList.remove("drop-on");
              under?.classList.add("drop-on");
              g.on = under;
            }
            return;
          }
          if (!pan.current) return;
          const dx = e.clientX - pan.current.x;
          const dy = e.clientY - pan.current.y;
          if (!panning && Math.hypot(dx, dy) < 3) return;
          setPanning(true);
          pan.current = { x: e.clientX, y: e.clientY };
          setShift((s) => ({ x: s.x + dx, y: s.y + dy }));
        }}
        onPointerUp={() => {
          const g = drag.current;
          drag.current = null;
          if (g && !g.moved) return onPick(sel === g.id ? null : g.id);
          if (g) {
            g.on?.classList.remove("drop-on");
            const [where, n] = (g.on?.getAttribute("data-wf-drop") ?? "").split(":");
            const card = flow.current?.querySelector<HTMLElement>(`[data-wf-node="${g.id}"]`);
            setHeld(null);
            if (where && onMove) {
              // Into a new place in the order. On a card: under that column's cards, the card it was dropped on kept still. On a
              // "+": in line there, the columns after moved along, the card before the "+" kept still.
              const onto = where === "col" ? (g.on as HTMLElement).dataset.wfNode! : lanes[Number(n)]![0]!.id;
              if (moved) {
                const mates = where === "col" ? cols[Number(n)]!.filter((x) => x.id !== g.id).map((x) => byId.get(x.id)!) : [];
                pin.current = { id: g.id, at: mates.length ? { x: byId.get(onto)!.x, y: Math.max(...mates.map((b) => b.y + b.h)) + ROW_GAP } : null };
              }
              const r = flow.current?.querySelector<HTMLElement>(`[data-wf-node="${onto}"]`)?.getBoundingClientRect();
              if (r) anchor.current = { id: onto, left: r.left, top: r.top };
              return onMove(g.id, Number(n), where === "col");
            }
            // Anywhere else: it stays there, and only it moves.
            const r = card?.getBoundingClientRect();
            if (r) anchor.current = { id: g.id, left: r.left, top: r.top };
            const o = offs[g.id]!;
            return onLayout?.({ ...whole(), [g.id]: { x: Math.round(o.x + (held?.dx ?? 0)), y: Math.round(o.y + (held?.dy ?? 0)) } });
          }
          pan.current = null;
          setPanning(false);
        }}
        onPointerCancel={() => {
          drag.current?.on?.classList.remove("drop-on");
          drag.current = null;
          setHeld(null);
          pan.current = null;
          setPanning(false);
        }}
      >
        <div className="wf-stage" style={stacked ? undefined : { width: Math.max(view.fw * zoom + 48, view.w), height: Math.max(view.fh * zoom + 96, view.h) }}>
          {stacked ? (
            <div ref={flow} className="wf-flow">
              <div className="wf-col wf-col-end">{node("trigger", <TriggerBody d={d} names={names} />)}</div>
              <Gap at={0} label={gapLabel(0)} onAdd={(kind) => onAdd(0, false, kind)} stacked first={!steps.length} />
              {cols.map((col, i) => (
                <ColumnAndGap key={col.map((s) => s.id).join()} i={i} last={i === cols.length - 1} col={col} steps={steps} node={(id, c) => node(id, c)} stacked onAdd={onAdd} full={full} names={names} room={d.room} runStep={runStep} />
              ))}
              <div className="wf-col wf-col-end">{node("outcomes", <OutcomesBody d={d} others={others} />)}</div>
            </div>
          ) : (
            <div
              ref={flow}
              className="wf-flow free"
              style={{ width: fw, height: fh, transform: `translate(${shift.x + Math.max(24, (view.w - fw * zoom) / 2)}px, ${shift.y + Math.max(24, (view.h - fh * zoom) / 2 - 10)}px) scale(${zoom})` }}
            >
              <svg className="wf-wires" aria-hidden="true">
                <defs>
                  <marker id="wf-back-head" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M1,1 L7,4 L1,7" className="wf-back-head" />
                  </marker>
                </defs>
                <g transform={`translate(${ox} ${oy})`}>
                  {wires.map((w, i) => (
                    <path key={i} d={w.d} className={cn(w.live && "live", w.on && "on")} />
                  ))}
                  {loops.map(l => (
                    <g key={l.id} data-wf-connection={l.source} onClick={() => onConnect && onPick(l.source)}>
                      {onConnect && <path d={l.d} className="wf-wire-hit" />}
                      <path d={l.d} className={cn("back", l.live && "live", sel === l.source && "on")} markerEnd="url(#wf-back-head)" />
                    </g>
                  ))}
                </g>
              </svg>
              {loops.map(l => (
                <button key={l.id} type="button" className="wf-loop" data-wf-connection={l.source} style={{ left: l.x + ox, top: l.y + oy }}
                  disabled={!onConnect} aria-label={`Edit ${l.label} connection from step ${steps.findIndex(s => s.id === l.source) + 1}`} onClick={() => onConnect && onPick(l.source)}>
                  <RotateCcwIcon className="size-3" aria-hidden="true" />{l.text}
                </button>
              ))}
              {node("trigger", <TriggerBody d={d} names={names} />)}
              {cols.map((col, i) => col.map((s) => node(s.id, body(s), i + 1)))}
              {node("outcomes", <OutcomesBody d={d} others={others} />)}
              {gaps.map((g) => (
                <Gap key={g.at} at={g.at} label={gapLabel(g.at)} onAdd={(kind) => onAdd(g.at, false, kind)} stacked={false} disabled={full} first={!steps.length} style={{ left: g.x + ox, top: g.y + oy }} />
              ))}
              {besides.map((b) => (
                <button
                  key={b.i}
                  type="button"
                  className={cn("wf-alongside free", b.on && "on")}
                  style={{ left: b.x + ox, top: b.y + oy, width: STEP_W }}
                  disabled={full}
                  onPointerEnter={() => setHot(b.i + 1)}
                  onPointerLeave={() => setHot((h) => (h === b.i + 1 ? -1 : h))}
                  onClick={() => onAdd(b.i, true)}
                >
                  <PlusIcon className="size-3.5" /> Alongside
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {!stacked && (
        <div className="wf-zoom" role="group" aria-label="Zoom">
          <Tip label="Zoom out" keys="⌘ scroll" side="top">
            <Button variant="ghost" size="icon-sm" aria-label="Zoom out" className="text-[var(--ink-2)]" onClick={() => setZoom((z) => stepZoom(z, -1))}>
              <MinusIcon />
            </Button>
          </Tip>
          <Tip label="Fit it in view" side="top">
            <Button variant="ghost" size="sm" className="h-8 min-w-14 px-2 text-[13px] font-medium text-[var(--ink)] tabular-nums" onClick={fitAll}>
              {Math.round(zoom * 100)}%
            </Button>
          </Tip>
          <Tip label="Zoom in" keys="⌘ scroll" side="top">
            <Button variant="ghost" size="icon-sm" aria-label="Zoom in" className="text-[var(--ink-2)]" onClick={() => setZoom((z) => stepZoom(z, 1))}>
              <PlusIcon />
            </Button>
          </Tip>
          <span className="wf-zoom-sep" aria-hidden="true" />
          <Tip label="Fit it in view" side="top">
            <Button variant="ghost" size="icon-sm" aria-label="Fit it in view" className="text-[var(--ink-2)]" onClick={fitAll}>
              <ScanIcon />
            </Button>
          </Tip>
          {/* Cards moved by hand, put back in their columns. */}
          {moved && onLayout && !live && (
            <>
              <span className="wf-zoom-sep" aria-hidden="true" />
              <Tip label="Put every card back in its column" side="top">
                <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2.5 text-[13px] font-medium text-[var(--ink)]" onClick={tidy}>
                  <LayoutGridIcon className="size-3.5" /> Tidy up
                </Button>
              </Tip>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ColumnAndGap({ i, last, col, steps, node, stacked, onAdd, full, names, room, runStep }: { i: number; last: boolean; col: WorkflowStep[]; steps: WorkflowStep[]; node: (id: string, children: ReactNode) => ReactNode; stacked: boolean; onAdd: AddStep; full: boolean; names: Names; room: string; runStep: RunStepOf }) {
  const gate = col.length === 1 && (isGate(col[0]!) || !!col[0]!.next);
  return (
    <>
      <div className={cn("wf-col", col.length > 1 && "side-by-side")} data-wf-drop={gate ? undefined : `col:${i}`} role="group" aria-label={col.length > 1 ? `Steps ${steps.indexOf(col[0]!) + 1} to ${steps.indexOf(col.at(-1)!) + 1}, side by side` : `Step ${steps.indexOf(col[0]!) + 1}`}>
        {stacked && col.length > 1 && <span className="wf-col-label">Side by side</span>}
        {col.map((s) => node(s.id, isGate(s) ? <GateBody s={s} n={steps.indexOf(s) + 1} steps={steps} names={names} room={room} run={runStep(s.id)} /> : <StepBody s={s} n={steps.indexOf(s) + 1} names={names} room={room} at={runStep(s.id)?.status ?? null} asked={runStep(s.id)?.asked ?? null} again={runStep(s.id)?.again ?? 0} />))}
        {!gate && (
          <button type="button" className="wf-alongside" disabled={full} onClick={() => onAdd(i, true)}>
            <PlusIcon className="size-3.5" /> {stacked ? "Add a step alongside" : "Alongside"}
          </button>
        )}
      </div>
      <Gap at={i + 1} label={last ? "Add after the last step" : `Add after step ${steps.indexOf(col.at(-1)!) + 1}`} onAdd={(kind) => onAdd(i + 1, false, kind)} stacked={stacked} disabled={full} />
    </>
  );
}

const ADD_KINDS: { kind: StepKind; icon: LucideIcon; name: string; says: string }[] = [
  { kind: "do", icon: UsersIcon, name: "A step", says: "A teammate does part of the work." },
  { kind: "check", icon: ShieldCheckIcon, name: "A check", says: "A teammate checks the work. Not passed, it goes back or the run stops." },
  { kind: "approve", icon: HandIcon, name: "Your OK", says: "The run waits for you to OK it, or send it back." },
];

/** The space between two columns, with its "+": a step, a check or your OK, in a column of its own there. */
function Gap({ at, label, onAdd, stacked, disabled, first, style }: { /** Where a card dropped here goes: a column of its own before column `at`. */ at: number; label: string; onAdd: (kind?: StepKind) => void; stacked: boolean; disabled?: boolean; /** No steps yet: the "+" says what it does. */ first?: boolean; /** On the free canvas: its middle, there. */ style?: CSSProperties }) {
  const [open, setOpen] = useState(false);
  if (first)
    return (
      <div className={cn("wf-gap first", style && "free")} style={style}>
        <button type="button" className="wf-first" onClick={() => onAdd("do")}>
          <PlusIcon className="size-4" /> Add the first step
        </button>
      </div>
    );
  return (
    <div className={cn("wf-gap", style && "free")} data-wf-drop={`gap:${at}`} style={style}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tip label={label} side={stacked ? "right" : "top"}>
          <PopoverTrigger asChild>
            <button type="button" className="wf-plus" aria-label={label} disabled={disabled}>
              <PlusIcon className="size-3.5" />
            </button>
          </PopoverTrigger>
        </Tip>
        <PopoverContent side={stacked ? "right" : "bottom"} className="w-[280px] p-1.5">
          <ul className="m-0 flex list-none flex-col p-0" role="list">
            {ADD_KINDS.map((k) => (
              <li key={k.kind}>
                <button type="button" className="wf-add-kind" onClick={() => (setOpen(false), onAdd(k.kind))}>
                  <span className="wf-add-icon">
                    <k.icon className="size-3.5" />
                  </span>
                  <span className="wf-add-text">
                    <span className="wf-add-name">{k.name}</span>
                    <span className="wf-add-says">{k.says}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** A card on the canvas: focusable, pressed or Enter to open its settings. */
type RunStepOf = (id: string) => Pick<WorkflowRunStep, "status" | "asked" | "verdict" | "again" | "kind"> | null;

function NodeCard({ id, children, sel, flagged, onPick, runStep, held, style, drop, onEnter, onLeave }: { id: string; children: ReactNode; sel: Sel; flagged: Set<string>; onPick: (s: Sel) => void; runStep: RunStepOf; /** Being dragged. */ held?: boolean; /** Where it sits on the free canvas. */ style?: CSSProperties; /** What a card dropped on it does: `col:n`, alongside it. */ drop?: string; onEnter?: () => void; onLeave?: () => void }) {
  const kind = id === "trigger" || id === "outcomes" ? id : "step";
  const run = kind === "step" ? runStep(id) : null;
  const open = () => onPick(sel === id ? null : id);
  return (
    <div
      className={cn("wf-node", `wf-node-${kind}`, sel === id && "sel", flagged.has(id) && "flag", held && "held")}
      data-wf-node={id}
      data-wf-drop={drop}
      data-run={run?.status}
      style={style}
      tabIndex={0}
      role="button"
      aria-pressed={sel === id}
      onClick={open}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      <div className="wf-node-in">{children}</div>
      {/* Not under a step being done: its face's ring and "On this step" say it, so no second "Working" (DIRECTION.md §9.4). */}
      {run && (run.status !== "claimed" || run.kind === "approve") && (
        <span className="wf-node-run">
          {/* A check that didn't pass says so in its mark too: it read "✓ Didn't pass" (2026-11-04 end-to-end check). */}
          {run.kind === "check" && run.status === "done" && run.verdict && !run.verdict.pass ? <XIcon className="size-3.5 shrink-0 text-[var(--red)]" aria-hidden="true" /> : <TaskMark state={run.kind === "approve" && run.status === "claimed" ? "review" : stepMark(run.status)} />}
          {run.kind === "approve" ? (run.status === "claimed" ? "Waiting for you" : run.status === "done" ? "You OK'd it" : run.status === "cancelled" ? "You said no" : STEP_WORD[run.status]) : run.kind === "check" && run.status === "done" && run.verdict ? (run.verdict.pass ? "Passed" : `Didn't pass${run.verdict.why ? `: ${run.verdict.why}` : ""}`) : STEP_WORD[run.status]}
        </span>
      )}
    </div>
  );
}

function TriggerBody({ d, names }: { d: Draft; names: Names }) {
  const Icon = TRIGGER_ICON[d.trigger.kind];
  return (
    <>
      <div className="wf-node-top">
        <span className="wf-tile">
          <Icon className="size-4" />
        </span>
        <span className="wf-who-text">
          <span className="wf-kind">Starts</span>
          <span className="wf-who-name wrap">{triggerLong(d.trigger, names)}</span>
        </span>
      </div>
      <div className="wf-node-body">
        <div className="wf-node-rows">
          {d.trigger.kind === "schedule" && d.trigger.schedule.every !== "hourly" && (
            <span className="wf-row">
              <ClockIcon className="size-3.5" /> {d.trigger.schedule.tz.replace(/_/g, " ")} time
            </span>
          )}
          <span className="wf-row">
            <UsersIcon className="size-3.5" /> In {d.room === TEAM_ROOM && names.pick ? "your Crew" : `the ${names.room(d.room) || "room that's gone"}`}
          </span>
          <span className="wf-row">
            <HistoryIcon className="size-3.5" /> Up to {d.limits.perDay} a day · {d.limits.skipIfRunning ? "skips while one runs" : "waits for the room"}
          </span>
          {d.ask?.trim() && (
            <span className="wf-row">
              <MessageCircleQuestionIcon className="size-3.5" /> Run now asks: {d.ask.trim()}
            </span>
          )}
        </div>
      </div>
    </>
  );
}

function OutcomesBody({ d, others }: { d: Draft; others: { id: string; name: string }[] }) {
  const o = d.outcomes;
  const then = o.then ? (others.find((w) => w.id === o.then)?.name ?? "a workflow that's gone") : "";
  // Each says what happens, or, dimmed, plainly that it doesn't.
  const rows: [LucideIcon, string, boolean][] = [
    [FileTextIcon, o.brief ? "A brief in the room" : "No brief", o.brief],
    [BellRingIcon, o.notify ? "Tells you when it ends" : "Doesn't tell you", o.notify],
    [GitPullRequestIcon, o.pr ? "The lead opens one pull request" : "No pull request", o.pr],
    [ZapIcon, then ? `Then starts “${then}”` : "Doesn't hand on", !!then],
  ];
  return (
    <>
      <div className="wf-node-top">
        <span className="wf-tile then">
          <FlagIcon className="size-4" />
        </span>
        <span className="wf-who-text">
          <span className="wf-kind">Then</span>
          <span className="wf-who-name">When the run is through</span>
        </span>
      </div>
      <div className="wf-node-body wf-outcomes">
        {rows.map(([Icon, text, on]) => (
          <span key={text} className={cn("wf-row", !on && "off")}>
            {on ? <CheckIcon className="size-3.5" /> : <Icon className="size-3.5" />}
            {text}
          </span>
        ))}
      </div>
    </>
  );
}

/** A step's card: its number, its teammate's face and how it stands (mateStatus), what it does, and what it owns. */
function StepBody({ s, n, names, room, at, asked, again = 0 }: { s: WorkflowStep; n: number; names: Names; room: string; /** How this step stands in the run going now. */ at: BoardStatus | null; /** Asked of its teammate's keeper in that run (the hosted service's). */ asked: WorkflowRunStep["asked"] | null; /** Sent back to it this many times in that run. */ again?: number }) {
  const lead = s.mate === LEAD;
  const m = lead ? names.lead(room) : names.mate(s.mate);
  // On this step in the run going now, the face and its line say so, as the card's "Working" does: the face read "Idle" beside it,
  // being the teammate's standing in the Crew room (QA, 2026-10-28).
  const onIt = at === "claimed" || at === "review";
  // Asked of its keeper: waiting on them, or turned down, said in their name.
  const waits = asked && at === "open" && asked.status === "open" ? { state: "waiting", line: `Waiting on ${asked.keeper} to take it on` } : asked?.status === "declined" ? { state: "idle", line: `${asked.keeper} didn't take it on` } : null;
  const says = m ? (onIt ? { state: "working", line: at === "review" ? "Being checked" : "On this step" } : (waits ?? mateStatus(m))) : null;
  return (
    <>
      <div className="wf-node-top">
        {m ? <Face seed={m.look ?? m.name} size={30} status={onIt ? "working" : m.status} lead={lead} /> : <span className="wf-face-none" style={{ width: 30, height: 30 }} />}
        <span className="wf-who-text">
          <span className="wf-who-name">{m ? (lead ? `The lead · ${m.name}` : m.name) : lead ? "The lead" : "Pick a teammate"}</span>
          {says ? <span className={cn("tm-sub", `s-${says.state}`)}>{says.line}</span> : <span className="tm-sub">{lead ? "Nobody leads this room" : "Nobody does this yet"}</span>}
        </span>
        {again > 0 && <span className="wf-again">Try {again + 1}</span>}
        <span className="wf-num" title={`Step ${n}`} aria-label={`Step ${n}`}>
          {n}
        </span>
      </div>
      <div className="wf-node-body">
        <p className={cn("wf-does", !s.does.trim() && "muted")}>{s.does.trim() || "Say what this step does."}</p>
        {s.owns.length > 0 && (
          <span className="wf-owns">
            {s.owns.slice(0, 3).map((o) => (
              <span key={o} className="wf-own" title={o}>
                <FolderIcon className="size-3" />
                {base(o)}
              </span>
            ))}
            {s.owns.length > 3 && <span className="wf-own">+{s.owns.length - 3}</span>}
          </span>
        )}
      </div>
    </>
  );
}

/**
 * A check's card or your OK's: who checks (or you), what has to hold or what you're asked, and what happens when it isn't passed.
 * Its last answer in the run going now, under it (NodeCard).
 */
function GateBody({ s, n, steps, names, room, run }: { s: WorkflowStep; n: number; steps: WorkflowStep[]; names: Names; room: string; run: ReturnType<RunStepOf> }) {
  const ok = s.kind === "approve";
  const m = ok ? null : s.mate === LEAD ? names.lead(room) : names.mate(s.mate);
  const onIt = run?.status === "claimed" || run?.status === "review";
  return (
    <>
      <div className="wf-node-top">
        {ok ? (
          <span className="wf-tile ok" aria-hidden="true">
            <HandIcon className="size-4" />
          </span>
        ) : m ? (
          <Face seed={m.look ?? m.name} size={30} status={onIt ? "working" : m.status} lead={s.mate === LEAD} />
        ) : (
          <span className="wf-face-none" style={{ width: 30, height: 30 }} />
        )}
        <span className="wf-who-text">
          <span className="wf-who-name">{ok ? "You" : m ? (s.mate === LEAD ? `The lead · ${m.name}` : m.name) : "Pick who checks"}</span>
          <span className="tm-sub">{ok ? "Asked before it goes on" : onIt ? "Checking" : "Checks the work so far"}</span>
        </span>
        {(run?.again ?? 0) > 0 && <span className="wf-again">Try {(run?.again ?? 0) + 1}</span>}
        {/* Its kind and its place in the order, in one: a check's shield, your OK's hand. */}
        <span className={cn("wf-num", ok ? "ok" : "check")} title={`Step ${n} · ${ok ? "Your OK" : "Check"}`} aria-label={`Step ${n}, ${ok ? "your OK" : "a check"}`}>
          {ok ? <HandIcon className="size-3" /> : <ShieldCheckIcon className="size-3" />}
          {n}
        </span>
      </div>
      <div className="wf-node-body">
        <p className={cn("wf-does", !s.does.trim() && "muted")}>{s.does.trim() ? (ok ? s.does.trim() : `Goes on if ${s.does.trim().replace(/^./, (c) => c.toLowerCase())}`) : ok ? "Say what you're asked." : "Say what has to hold."}</p>
      </div>
    </>
  );
}

// ── the settings beside the canvas ───────────────────────────────────

function Inspector({
  identity,
  sel,
  d,
  steps,
  names,
  others,
  hookUrl,
  onClose,
  set,
  setStep,
  moveStep,
  removeStep,
  addFix,
}: {
  identity: Identity;
  sel: string;
  d: Draft;
  steps: WorkflowStep[];
  names: Names;
  others: WorkflowView[];
  hookUrl?: string;
  onClose: () => void;
  set: (c: Partial<Draft>) => void;
  setStep: (id: string, c: Partial<WorkflowStep>) => void;
  moveStep: (id: string, by: -1 | 1) => void;
  removeStep: (id: string) => void;
  /** A fix step for this check, under it. */
  addFix: (gate: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    // Into its first field, so a card opened from the keyboard is edited from the keyboard.
    // A tab only as the one picked: the Kind tabs take what has focus, so a check opened by Enter landed on "Step" and became one.
    ref.current?.querySelector<HTMLElement>("textarea, input, button[role='combobox'], [role='tab'][aria-selected='true']")?.focus();
  }, []);
  const s = steps.find((x) => x.id === sel);
  const title = sel === "trigger" ? "Trigger" : sel === "outcomes" ? "Then" : s ? `Step ${steps.indexOf(s) + 1}${s.kind === "check" ? " · Check" : s.kind === "approve" ? " · Your OK" : ""}` : "";
  if (!title) return null;
  return (
    <aside
      ref={ref}
      className="wf-inspector"
      aria-label={`${title} settings`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !(e.target as HTMLElement).closest("[role='listbox']")) {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="wf-insp-head">
        <span>{title}</span>
        <Button variant="ghost" size="icon-xs" aria-label="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <div className="wf-insp-body">
        {sel === "trigger" && <TriggerForm d={d} names={names} hookUrl={hookUrl} set={set} />}
        {sel === "outcomes" && <OutcomesForm d={d} others={others} set={set} />}
        {s && <StepForm identity={identity} s={s} n={steps.indexOf(s) + 1} steps={steps} d={d} names={names} setStep={setStep} moveStep={moveStep} removeStep={removeStep} addFix={addFix} />}
      </div>
    </aside>
  );
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="wf-field">
      <span className="wf-field-label">{label}</span>
      {children}
      {hint && <span className="wf-field-hint">{hint}</span>}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cn("wf-daychip", on && "on")}>
      {children}
    </button>
  );
}

/** A role's first line, up to 60 letters and ended at a word. */
const roleLine = (role: string) => {
  const line = role.split("\n")[0]!.trim();
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60).replace(/[\s,;:.]+$/, "")}…`;
};

/** Who does a step, or checks: the lead, or a teammate in the room. */
function MatePick({ identity, s, d, names, lead, setStep }: { identity: Identity; s: WorkflowStep; d: Draft; names: Names; lead: TeammateView | null; setStep: (id: string, c: Partial<WorkflowStep>) => void }) {
  const tools = useToolMates(identity, d.room, names);
  return (
    <>
    <Select value={s.mate || undefined} onValueChange={(v) => (isToolPick(v) ? void tools.make(v).then((id) => id && setStep(s.id, { mate: id })) : setStep(s.id, { mate: v }))}>
      <SelectTrigger size="sm" aria-label="Who does it" className="h-9 w-full text-[13px]">
        <SelectValue placeholder="Pick a teammate" />
      </SelectTrigger>
      {/* Under the box and inside the window: centred on the choice, the list ran 14px past the window's right edge (Arun,
          2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"). */}
      <SelectContent position="popper" align="start" collisionPadding={8} className="max-w-[calc(100vw-16px)]">
        <SelectItem value={LEAD}>The lead{lead ? ` (${lead.name} now)` : ""}</SelectItem>
        {names.mates.map((m) => (
          <SelectItem key={m.id} value={m.id} disabled={!names.inRoom(d.room, m.id)}>
            <Face seed={m.look ?? m.name} size={16} /> {m.name}
            {names.inRoom(d.room, m.id) && names.keeperOf(m.id) ? <span className="wf-pick-role">· {names.keeperOf(m.id)}'s, asked of them</span> : null}
            {/* The role ends at a word, and in the closed box with an ellipsis where it runs out of room: cut at 40 letters, it
                stopped mid-word and was clipped bare (Arun, 2026-10-28: "look for like the little details and designs"). */}
            {!names.inRoom(d.room, m.id) ? " (not in this room)" : m.role && !names.keeperOf(m.id) ? <span className="wf-pick-role">· {roleLine(m.role)}</span> : ""}
          </SelectItem>
        ))}
        <ToolItems tools={tools} />
      </SelectContent>
    </Select>
    {tools.err && <p className="wf-tool-err" role="alert">{tools.err}</p>}
    </>
  );
}

const TOOL_PICK = "+tool:";
const isToolPick = (v: string) => v.startsWith(TOOL_PICK);

/**
 * A coding tool on this computer as who does a step, without making a teammate first (Arun, 2026-11-02, from discussion #8:
 * "Claude Code · Personal" on Plan, "· Work" on Implement). Picked, it is a teammate at once, named for the tool and account and
 * put in the workflow's room: the crew is still where everything that works is, and it can be renamed or given a role there.
 * Local only: on the hosted service a teammate's tool is on its keeper's computer.
 */
function useToolMates(identity: Identity, room: string, names: Names) {
  const { state } = useMachine(identity);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = isLocal() ? state.tools.filter((t) => !!t.path && t.loggedIn !== false) : [];
  const items = ready.flatMap((t) => {
    const accts = (t.accounts ?? []).filter((a) => a.loggedIn !== false);
    return accts.length > 1 ? accts.map((a) => ({ value: `${TOOL_PICK}${t.tool}:${a.id}`, tool: t.tool, account: a.id, label: `${ENGINE_NAMES[t.tool]} · ${a.label}` })) : [{ value: `${TOOL_PICK}${t.tool}:`, tool: t.tool, account: "", label: ENGINE_NAMES[t.tool] }];
  });
  const make = async (v: string): Promise<string | null> => {
    const it = items.find((x) => x.value === v);
    if (!it || busy) return null;
    setBusy(true);
    setErr("");
    try {
      const taken = new Set(names.mates.map((m) => m.name.toLowerCase()));
      const stem = it.label.replace(" · ", " ").replace(/[^\p{L}\p{N} ._'-]+/gu, "").trim();
      let name = stem;
      for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${stem} ${i}`;
      const before = new Set(names.mates.map((m) => m.id));
      const got = await api<Team>(identity, "/api/teammates", {
        method: "POST",
        body: JSON.stringify({ name, role: `Takes workflow steps on ${it.label}.`, tool: it.tool, model: canRoute(it.tool as EngineTool) ? "auto" : "", ...(it.account && it.account !== "default" ? { account: it.account } : {}) }),
        headers: { "Content-Type": "application/json" },
      });
      const made = got.teammates.find((m) => !before.has(m.id));
      if (!made) throw new Error("It was made, but isn't in the crew yet. Pick it from the list.");
      const r = room === TEAM_ROOM ? null : got.rooms.find((x) => x.id === room);
      if (r && !r.lanes[made.id]) await api(identity, `/api/teammates/rooms/${r.id}`, { method: "PATCH", body: JSON.stringify({ members: [...Object.keys(r.lanes), made.id] }), headers: { "Content-Type": "application/json" } });
      await refreshTeam(identity);
      return made.id;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { items, make, err, busy };
}

/** The coding tools here, under the teammates: each made a teammate when picked (useToolMates). */
function ToolItems({ tools }: { tools: ReturnType<typeof useToolMates> }) {
  if (!tools.items.length) return null;
  return (
    <>
      <div className="wf-pick-group" role="presentation">
        Or a coding tool, as a new teammate
      </div>
      {tools.items.map((t) => (
        <SelectItem key={t.value} value={t.value} disabled={tools.busy}>
          <EngineMark tool={t.tool} size={14} /> {t.label}
        </SelectItem>
      ))}
    </>
  );
}

/**
 * Who does the step the work goes back to: that step's own teammate, or another, on another tool or account (Arun, 2026-11-02, from
 * discussion #8: Review → "Prepare fixes" → Implement, a step's FAIL handed to a fixer). The check runs again after either.
 */
function FixPick({ identity, s, d, steps, names, lead, setStep }: { identity: Identity; s: WorkflowStep; d: Draft; steps: WorkflowStep[]; names: Names; lead: TeammateView | null; setStep: (id: string, c: Partial<WorkflowStep>) => void }) {
  const tools = useToolMates(identity, d.room, names);
  const to = steps.find((x) => x.id === s.back);
  if (!to) return null;
  const own = to.mate === LEAD ? (lead ? `The lead (${lead.name} now)` : "The lead") : (names.mate(to.mate)?.name ?? "Its teammate");
  return (
    <Field label="Fixed by" hint="Someone else can take the fixes: another teammate, tool or account. Then it's checked again.">
      <Select value={s.fixBy || "+own"} onValueChange={(v) => (isToolPick(v) ? void tools.make(v).then((id) => id && setStep(s.id, { fixBy: id })) : setStep(s.id, { fixBy: v === "+own" ? undefined : v }))}>
        <SelectTrigger size="sm" aria-label="Fixed by" className="h-9 w-full text-[13px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start" collisionPadding={8} className="max-w-[calc(100vw-16px)]">
          <SelectItem value="+own">{own}, who did step {steps.indexOf(to) + 1}</SelectItem>
          {to.mate !== LEAD && <SelectItem value={LEAD}>The lead{lead ? ` (${lead.name} now)` : ""}</SelectItem>}
          {names.mates
            .filter((m) => m.id !== to.mate)
            .map((m) => (
              <SelectItem key={m.id} value={m.id} disabled={!names.inRoom(d.room, m.id)}>
                <Face seed={m.look ?? m.name} size={16} /> {m.name}
                {!names.inRoom(d.room, m.id) ? " (not in this room)" : m.role ? <span className="wf-pick-role">· {roleLine(m.role)}</span> : ""}
              </SelectItem>
            ))}
          <ToolItems tools={tools} />
        </SelectContent>
      </Select>
      {tools.err && <p className="wf-tool-err" role="alert">{tools.err}</p>}
    </Field>
  );
}

function StepForm({ identity, s, n, steps, d, names, setStep, moveStep, removeStep, addFix }: { addFix: (gate: string) => void; identity: Identity; s: WorkflowStep; n: number; steps: WorkflowStep[]; d: Draft; names: Names; setStep: (id: string, c: Partial<WorkflowStep>) => void; moveStep: (id: string, by: -1 | 1) => void; removeStep: (id: string) => void }) {
  const [own, setOwn] = useState("");
  const lead = names.lead(d.room);
  const cols = columnsOf(steps);
  const alone = cols[s.col]?.length === 1;
  const addOwn = () => {
    const v = own.trim();
    if (v && !s.owns.includes(v)) setStep(s.id, { owns: [...s.owns, v].slice(0, 20) });
    setOwn("");
  };
  const kind = s.kind ?? "do";
  /** The steps before it that do work: where a check or OK can send it back to. */
  const earlier = steps.slice(0, n - 1).filter((x) => !isGate(x));
  /** Where it can send work that doesn't pass: an earlier step to do its part again, or a later one, a path of its own. */
  const targets = steps.filter((x) => x.id !== s.id && !isGate(x));
  const fixIds = fixSteps(steps);
  const later = steps.slice(n).filter((x) => !isGate(x));
  const failTarget = ifNotOf(s);
  const nameOf = (id: string) => ((x) => (x ? `${steps.indexOf(x) + 1} · ${stepTitle(x, steps.indexOf(x) + 1)}` : "a step that's gone"))(steps.find((t) => t.id === id));
  /** Where it goes when it passes and nothing says: the next step on the line, or the end. */
  const passDefault = connectionsOf(steps.map((x) => (x.id === s.id ? { ...x, next: undefined } : x))).find((c) => c.source === s.id && c.port === "next")?.target ?? "$finish";
  const setKind = (k: StepKind) => {
    if (k === kind) return;
    const last = earlier.at(-1);
    setStep(s.id, k === "do" ? { kind: undefined, ifNot: undefined, back: undefined, tries: undefined, otherwise: undefined } : { kind: k, mate: k === "approve" ? "" : s.mate || LEAD, owns: [], ifNot: s.ifNot ?? (last ? "back" : "stop"), back: s.back ?? last?.id, tries: s.tries ?? DEFAULT_TRIES, ...(k === "approve" && !s.does.trim() ? { does: "Is this ready to go on?" } : {}) });
  };
  const kindTabs = (
    <Field label="Kind">
      <PageTabs<StepKind>
        label="Kind"
        value={kind}
        onChange={setKind}
        options={[
          { value: "do", label: "Step" },
          { value: "check", label: "Check" },
          { value: "approve", label: "Your OK" },
        ]}
      />
    </Field>
  );
  if (kind !== "do")
    return (
      <>
        {kindTabs}
        {kind === "check" && (
          <Field label="Who checks" hint="Often QA, or the lead. It doesn't change anything, only says PASS or FAIL.">
            <MatePick identity={identity} s={s} d={d} names={names} lead={lead} setStep={setStep} />
          </Field>
        )}
        <Field label={kind === "check" ? "What has to hold" : "What you're asked"} hint={kind === "check" ? "It's handed what the steps before came to." : "You see what the steps before came to, beside the question."}>
          <Textarea value={s.does} onChange={(e) => setStep(s.id, { does: e.target.value })} placeholder={kind === "check" ? "The tests pass and every bug QA listed is fixed." : "Is the post ready to go out?"} className="min-h-[96px] text-[13px] leading-relaxed md:text-[13px]" maxLength={4000} />
        </Field>
        {/* Where the work goes on each answer, said as a sentence, every choice in its menu (design A, Arun 2026-11-04: "make
            this easier to understand… keep full functionality"). */}
        <Field label="Where it goes" hint={sendsOn(s) ? (failTarget && fixIds.has(failTarget) ? "The fix step runs only when it doesn't pass, then the work is checked again. Past the most times, the run stops." : "Past the most times, the run stops. Or drag Passes or Fails on its card onto a step.") : "Or drag Passes or Fails on its card onto a step."}>
          <div className="wf-route">
            <div className="wf-route-row">
              <CheckIcon className="wf-route-ic pass" aria-hidden="true" />
              <span>{kind === "approve" ? "If you say yes, go on to" : "If it passes, go on to"}</span>
              <Select value={s.next && s.next !== passDefault ? s.next : "$default"} onValueChange={(v) => setStep(s.id, { next: v === "$default" ? undefined : v })}>
                <SelectTrigger size="sm" aria-label={kind === "approve" ? "If you say yes" : "If it passes"} className="wf-route-pick">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="start" collisionPadding={8} className="max-w-[calc(100vw-16px)]">
                  <SelectItem value="$default">{passDefault === "$finish" ? "the end of the run" : nameOf(passDefault)}</SelectItem>
                  {steps.map((x) => (x.id === s.id || x.id === passDefault || fixIds.has(x.id) ? null : <SelectItem key={x.id} value={x.id}>{nameOf(x.id)}</SelectItem>))}
                  {passDefault !== "$finish" && <SelectItem value="$finish">the end of the run</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            <div className="wf-route-row">
              <XIcon className="wf-route-ic fail" aria-hidden="true" />
              <span>{kind === "approve" ? "If you say no," : "If it fails,"}</span>
              <Select value={sendsOn(s) ? failTarget : "$stop"} onValueChange={(v) => (v === "$new" ? addFix(s.id) : setStep(s.id, ifNotTo(steps, s, v === "$stop" ? undefined : v)))}>
                <SelectTrigger size="sm" aria-label={kind === "approve" ? "If you say no" : "If it fails"} className="wf-route-pick">
                  <SelectValue placeholder="pick a step" />
                </SelectTrigger>
                <SelectContent position="popper" align="start" collisionPadding={8} className="max-w-[calc(100vw-16px)]">
                  <SelectItem value="$stop">stop the run</SelectItem>
                  {earlier.length > 0 && <SelectSeparator />}
                  {earlier.map((x) => (
                    <SelectItem key={x.id} value={x.id}>
                      send it back to {nameOf(x.id)}
                    </SelectItem>
                  ))}
                  {later.length > 0 && <SelectSeparator />}
                  {later.map((x) => (
                    <SelectItem key={x.id} value={x.id}>
                      send it to {nameOf(x.id)}
                      {fixIds.has(x.id) ? " (its fix step)" : ""}
                    </SelectItem>
                  ))}
                  <SelectSeparator />
                  <SelectItem value="$new">add a fix step for it</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {sendsOn(s) && (
              <div className="wf-route-sub">
                At most
                <Input type="number" min={1} max={MAX_TRIES} value={s.tries ?? DEFAULT_TRIES} onChange={(e) => setStep(s.id, { tries: Math.min(MAX_TRIES, Math.max(1, Math.round(Number(e.target.value) || 1))) })} aria-label="Times, at most" className="h-8 w-[60px] text-[13px] tabular-nums md:text-[13px]" />
                times
              </div>
            )}
          </div>
        </Field>
        {sendsOn(s) && !s.otherwise && <FixPick identity={identity} s={s} d={d} steps={steps} names={names} lead={lead} setStep={setStep} />}
        <Field label="When it runs">
          <div className="flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" className="h-8 border-[var(--border)] px-2.5 text-[13px] shadow-none" disabled={s.col === 0} onClick={() => moveStep(s.id, -1)}>
              <ChevronLeftIcon /> Earlier
            </Button>
            <Button variant="outline" size="sm" className="h-8 border-[var(--border)] px-2.5 text-[13px] shadow-none" disabled={s.col === cols.length - 1} onClick={() => moveStep(s.id, 1)}>
              Later <ChevronRightIcon />
            </Button>
          </div>
        </Field>
        <div className="wf-insp-foot">
          <Button variant="ghost" size="sm" className="h-8 px-2 text-[13px] text-[var(--red)] hover:text-[var(--red)]" onClick={() => removeStep(s.id)}>
            <Trash2Icon /> Remove step {n}
          </Button>
        </div>
      </>
    );
  return (
    <>
      {kindTabs}
      <Field label="Who does it" hint={d.room === TEAM_ROOM ? undefined : `Only teammates in ${names.room(d.room)} can take a step there.`}>
        <MatePick identity={identity} s={s} d={d} names={names} lead={lead} setStep={setStep} />
      </Field>
      <Field label="What it does" hint={n > 1 && s.col > 0 ? "Gets what the steps before it found." : "Gets what started the run."}>
        <Textarea value={s.does} onChange={(e) => setStep(s.id, { does: e.target.value })} placeholder="Read what merged this week and list the changes, grouped as new, improved and fixed." className="min-h-[132px] text-[13px] leading-relaxed md:text-[13px]" maxLength={4000} />
        {/* A crew skill for the step: its line leads what it does, and the teammate fetches the steps (CrewSkills.tsx). */}
        <StepSkill does={s.does} onChange={(does) => setStep(s.id, { does })} />
      </Field>
      <NextField s={s} steps={steps} setStep={setStep} />
      <Field label="Files or folders it owns" hint="No other step edits these while it runs.">
        {s.owns.length > 0 && (
          <span className="wf-owns">
            {s.owns.map((o) => (
              <span key={o} className="wf-own removable" title={o}>
                <FolderIcon className="size-3" />
                {o}
                <button type="button" aria-label={`Stop owning ${o}`} onClick={() => setStep(s.id, { owns: s.owns.filter((x) => x !== o) })}>
                  <XIcon className="size-3" />
                </button>
              </span>
            ))}
          </span>
        )}
        <Input
          value={own}
          onChange={(e) => setOwn(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              addOwn();
            }
          }}
          onBlur={addOwn}
          placeholder="CHANGELOG.md, then Enter"
          aria-label="A file or folder it owns"
          className="h-9 text-[13px] md:text-[13px]"
        />
      </Field>
      {/* A fix step runs when its check doesn't pass, wherever its column is: no earlier or later for it. */}
      {!fixSteps(steps).has(s.id) && (
      <Field label="When it runs" hint={cols.length > 1 || !alone ? (alone ? "On its own in its column: it waits on the column before it." : "Side by side with the others in its column.") : undefined}>
        <div className="flex flex-wrap gap-1.5">
          <Button variant="outline" size="sm" className="h-8 border-[var(--border)] px-2.5 text-[13px] shadow-none" disabled={s.col === 0 && alone} onClick={() => moveStep(s.id, -1)}>
            <ChevronLeftIcon /> Earlier
          </Button>
          <Button variant="outline" size="sm" className="h-8 border-[var(--border)] px-2.5 text-[13px] shadow-none" disabled={s.col === cols.length - 1 && alone} onClick={() => moveStep(s.id, 1)}>
            Later <ChevronRightIcon />
          </Button>
        </div>
      </Field>
      )}
      <div className="wf-insp-foot">
        <Button variant="ghost" size="sm" className="h-8 px-2 text-[13px] text-[var(--red)] hover:text-[var(--red)]" onClick={() => removeStep(s.id)}>
          <Trash2Icon /> Remove step {n}
        </Button>
      </div>
    </>
  );
}

function TriggerForm({ d, names, hookUrl, set }: { d: Draft; names: Names; hookUrl?: string; set: (c: Partial<Draft>) => void }) {
  const [copied, setCopied] = useState(false);
  const t = d.trigger;
  const sched = t.kind === "schedule" ? t.schedule : null;
  const setSched = (c: Partial<AgentSchedule>) => sched && set({ trigger: { kind: "schedule", schedule: { ...sched, ...c } } });
  const pick = (k: TriggerKind) =>
    set({
      trigger:
        k === "schedule"
          ? { kind: "schedule", schedule: { every: "weekly", at: "09:00", days: WEEKDAYS, tz: TZ } }
          : k === "webhook"
            ? { kind: "webhook", secret: "" }
            : k === "teammate"
              ? { kind: "teammate", mate: names.pickable[0]?.id ?? "", on: "turn" }
              : k === "board"
                ? { kind: "board", room: names.rooms.find((r) => r.id !== d.room)?.id ?? TEAM_ROOM }
                : { kind: "manual" },
    });
  return (
    <>
      <Field label="What starts it">
        <Select value={t.kind} onValueChange={(v) => pick(v as TriggerKind)}>
          <SelectTrigger size="sm" aria-label="What starts it" className="h-9 w-full text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="schedule">On a schedule</SelectItem>
            <SelectItem value="webhook">A webhook is called</SelectItem>
            <SelectItem value="teammate">A teammate finishes work</SelectItem>
            <SelectItem value="board">A board in a room finishes</SelectItem>
            <SelectItem value="manual">Only Run now</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {sched && (
        <>
          <Field label="How often">
            <PageTabs<AgentSchedule["every"]>
              label="How often"
              value={sched.every}
              onChange={(v) => setSched({ every: v, ...(v === "weekly" && !sched.days.length ? { days: WEEKDAYS } : {}) })}
              options={[
                { value: "hourly", label: "Hourly" },
                { value: "daily", label: "Daily" },
                { value: "weekly", label: "On these days" },
              ]}
            />
          </Field>
          {sched.every === "weekly" && (
            // One row of seven, never six and a lone "Sat" under them (QA, 2026-10-28).
            <div className="wf-days" role="group" aria-label="Days">
              {DAYS.map((day, i) => (
                <Chip key={day} on={sched.days.includes(i)} onClick={() => setSched({ days: sched.days.includes(i) ? sched.days.filter((x) => x !== i) : [...sched.days, i].sort() })}>
                  {day}
                </Chip>
              ))}
            </div>
          )}
          {sched.every !== "hourly" && (
            <Field label="At" hint={`In ${sched.tz}`}>
              <Input type="time" value={sched.at} onChange={(e) => e.target.value && setSched({ at: e.target.value })} aria-label="At" className="h-9 w-[140px] text-[13px] md:text-[13px]" />
            </Field>
          )}
        </>
      )}
      {t.kind === "webhook" && (
        <Field label="Its address" hint="POST anything to it, from CI, GitHub or a script: what is posted is what the first steps are told. Keep it secret: it is the key.">
          {hookUrl ? (
            <span className="flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded-md bg-[var(--hover)] px-2 py-1.5 text-[12px]">{hookUrl}</code>
              <Button variant="ghost" size="icon-sm" aria-label="Copy the webhook address" onClick={() => void navigator.clipboard.writeText(hookUrl).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}>
                {copied ? <CheckIcon /> : <CopyIcon />}
              </Button>
            </span>
          ) : (
            <span className="text-[13px] text-[var(--text-muted)]">It shows here once it's saved.</span>
          )}
        </Field>
      )}
      {t.kind === "teammate" && (
        <Field label="Whose work" hint="Wherever it works: the Crew room or a room. A workflow's own steps don't start it again while it runs.">
          <div className="flex flex-col gap-2">
            <Select value={t.mate || undefined} onValueChange={(v) => set({ trigger: { ...t, mate: v } })}>
              <SelectTrigger size="sm" aria-label="Which teammate" className="h-9 w-full text-[13px]">
                <SelectValue placeholder="Pick a teammate" />
              </SelectTrigger>
              <SelectContent>
                {names.pickable.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    <Face seed={m.look ?? m.name} size={16} /> {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <PageTabs<"turn" | "task">
              label="Finishes"
              value={t.on}
              onChange={(v) => set({ trigger: { ...t, on: v } })}
              options={[
                { value: "turn", label: "Finishes a turn" },
                { value: "task", label: "Finishes a board task" },
              ]}
            />
          </div>
        </Field>
      )}
      {t.kind === "board" && (
        <Field label="Whose board" hint="Once every task on a board there is done or stuck. Its own boards don't start it.">
          <RoomSelect value={t.room} names={names} onChange={(room) => set({ trigger: { kind: "board", room } })} label="Which room's board" />
        </Field>
      )}
      <Field label="Ask when you run it" hint="Optional. Run now asks you this, and the first steps get your answer.">
        <Input value={d.ask ?? ""} onChange={(e) => set({ ask: e.target.value })} placeholder="Which feature is launching?" aria-label="Ask when you run it" maxLength={200} className="h-9 text-[13px] md:text-[13px]" />
      </Field>
      <div className="wf-insp-rule" />
      <Field label="Where it runs" hint="Its board is posted there, from the room's lead.">
        <RoomSelect value={d.room} names={names} onChange={(room) => set({ room })} label="Where it runs" />
      </Field>
      <Field label="Runs a day, at most">
        <Input type="number" min={1} max={48} value={d.limits.perDay} onChange={(e) => set({ limits: { ...d.limits, perDay: Math.min(48, Math.max(1, Math.round(Number(e.target.value) || 1))) } })} aria-label="Runs a day, at most" className="h-9 w-[96px] text-[13px] tabular-nums md:text-[13px]" />
      </Field>
      <label className="wf-switch-row">
        <span>
          <span className="wf-switch-title">Skip a run while one is still going</span>
          <span className="wf-field-hint">Off, it waits for the room's board to be free (up to 12 hours).</span>
        </span>
        <Switch checked={d.limits.skipIfRunning} onCheckedChange={(v) => set({ limits: { ...d.limits, skipIfRunning: v } })} />
      </label>
    </>
  );
}

function RoomSelect({ value, names, onChange, label }: { value: string; names: Names; onChange: (v: string) => void; label: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" aria-label={label} className="h-9 w-full text-[13px]">
        <SelectValue placeholder="Pick a room" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={TEAM_ROOM}>{names.pick ? ((n) => `Your Crew · your ${n === 1 ? "teammate" : `${n} teammates`}`)(names.mates.filter((m) => (m as { mine?: boolean }).mine).length) : "Crew room · everyone"}</SelectItem>
        {names.rooms.map((r) => (
          <SelectItem key={r.id} value={r.id}>
            {r.name} · {Object.keys(r.lanes).length} teammate{Object.keys(r.lanes).length === 1 ? "" : "s"}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function OutcomesForm({ d, others, set }: { d: Draft; others: WorkflowView[]; set: (c: Partial<Draft>) => void }) {
  const o = d.outcomes;
  const row = (key: "brief" | "notify" | "pr", title: string, hint: string) => (
    <label className="wf-switch-row" key={key}>
      <span>
        <span className="wf-switch-title">{title}</span>
        <span className="wf-field-hint">{hint}</span>
      </span>
      <Switch checked={o[key]} onCheckedChange={(v) => set({ outcomes: { ...o, [key]: v } })} />
    </label>
  );
  return (
    <>
      {row("brief", "Post a brief in the room", "Each step done or stuck, by who, and what the run came to.")}
      {row("notify", "Tell you when it ends", "A notification on this computer, done or not.")}
      {row("pr", "The lead opens one pull request", "It merges the teammates' branches, runs the tests, and opens one PR for you to review.")}
      <div className="wf-insp-rule" />
      <Field label="Then hand its result to" hint="That workflow starts with this one's result, three in a row at most.">
        <Select value={o.then || "none"} onValueChange={(v) => set({ outcomes: { ...o, then: v === "none" ? "" : v } })}>
          <SelectTrigger size="sm" aria-label="Then hand its result to" className="h-9 w-full text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No other workflow</SelectItem>
            {others.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
                {w.on ? "" : " (off)"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </>
  );
}

/**
 * Where a step goes when it's done (a check or your OK: when it passes): the next column unless it says, another step, or the
 * end of the run. The same setting as its card's Next wire (#15), for narrow screens and keyboards too.
 */
function NextField({ s, steps, setStep }: { s: WorkflowStep; steps: WorkflowStep[]; setStep: (id: string, change: Partial<WorkflowStep>) => void }) {
  const label = isGate(s) ? (s.kind === "approve" ? "If you say yes" : "If it passes") : "After it";
  const fixIds = fixSteps(steps);
  const nameOf = (id: string) => ((x) => (x ? `${steps.indexOf(x) + 1} · ${stepTitle(x, steps.indexOf(x) + 1)}` : "a step that's gone"))(steps.find((t) => t.id === id));
  // Where it goes when nothing says: on to the next step on the line, or, for a fix step, back to the work it fixes.
  const dflt = fixIds.has(s.id) ? afterFix(steps, s.id) : (connectionsOf(steps.map((x) => (x.id === s.id ? { ...x, next: undefined } : x))).find((c) => c.source === s.id && c.port === "next")?.target ?? "$finish");
  const back = steps.findIndex((x) => x.id === dflt) < steps.indexOf(s);
  const gone = !!s.next && s.next !== "$finish" && !steps.some((x) => x.id === s.next);
  return (
    <Field label={label} hint={fixIds.has(s.id) ? "A fix step: it runs only when its check doesn't pass." : s.next && s.next !== "$finish" ? "The steps alongside that one run with it." : undefined}>
      <Select value={s.next && s.next !== dflt ? s.next : "$default"} onValueChange={(v) => setStep(s.id, { next: v === "$default" ? undefined : v })}>
        <SelectTrigger size="sm" aria-label={label} className="h-9 w-full text-[13px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start" collisionPadding={8} className="max-w-[calc(100vw-16px)]">
          <SelectItem value="$default">{dflt === "$finish" ? "The end of the run" : `${back ? "Back to" : "On to"} ${nameOf(dflt)}`}</SelectItem>
          {steps.map((x) => (x.id === s.id || x.id === dflt || fixIds.has(x.id) ? null : <SelectItem key={x.id} value={x.id}>{nameOf(x.id)}</SelectItem>))}
          {gone && <SelectItem value={s.next!}>A step that's gone: pick another</SelectItem>}
          {dflt !== "$finish" && <SelectItem value="$finish">The end of the run</SelectItem>}
        </SelectContent>
      </Select>
    </Field>
  );
}
