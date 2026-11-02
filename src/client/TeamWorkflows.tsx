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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
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
  FolderIcon,
  GitPullRequestIcon,
  HandIcon,
  HistoryIcon,
  MessageCircleQuestionIcon,
  LayoutTemplateIcon,
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
} from "lucide-react";
import type { AgentSchedule } from "../agents.js";
import type { BoardStatus } from "../session/projection.js";
import {
  BLANK_LIMITS,
  BLANK_OUTCOMES,
  columnsOf,
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
  type WorkflowRun,
  type WorkflowRunStep,
  type WorkflowStep,
  type WorkflowTemplate,
  type WorkflowTrigger,
  type WorkflowView,
} from "../team-workflow-model.js";
import type { TeammateView } from "../teammates.js";
import { api } from "./api.js";
import type { Identity } from "./storage.js";
import { TaskMark, type TaskMarkState } from "./TaskMark.js";
import { relTime, useConfirm } from "./ui.js";
import { base, Face, mateStatus, useTeam, type Team } from "./Teammates.js";
import { isLocal } from "./edition.js";
import { timeOf } from "./team-status.js";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/dass";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
const draftOf = (w: WorkflowView): Draft => ({ name: w.name, on: w.on, room: w.room, trigger: w.trigger, steps: w.steps, outcomes: w.outcomes, limits: w.limits, ask: w.ask ?? "" });
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
  return "Run now";
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
        <DraftBox identity={identity} onDraft={(draft) => setEditing({ id: null, fresh: true, draft: { ...blank(), ...draft } })} />
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
          A workflow is a trigger, then steps, then what happens after. A step is a teammate and what it does; a check sends the work back until it passes; your OK waits for you. Describe one above, or start from a template.
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
function DraftBox({ identity, onDraft }: { identity: Identity; onDraft: (d: Partial<Draft>) => void }) {
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
    <form className="wf-draft" onSubmit={(e) => (e.preventDefault(), void go())}>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (e.preventDefault(), void go())}
        placeholder="Describe a workflow: “Every weekday at 9, Ada runs the tests, Kit fixes what fails until they pass, and I OK the pull request.”"
        aria-label="Describe a workflow"
        rows={2}
        maxLength={2000}
        disabled={busy}
        className="wf-draft-box"
      />
      <div className="wf-draft-foot">
        <span className={error ? "wf-draft-note bad" : "wf-draft-note"} role={error ? "alert" : undefined}>
          {error || (busy ? "Drafting it with your coding tool…" : "Friday drafts it. You look it over before it's saved.")}
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
  const [side, setSide] = useState(fresh && !initial.steps.length);
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

  const save = async (): Promise<WorkflowView | null> => {
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
  // ⌘S saves.
  const saveRef = useRef(save);
  saveRef.current = save;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!ownerRef.current) void saveRef.current();
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);

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
          <Tip label={side ? "Hide the templates" : "Start from a template"}>
            <Button variant="ghost" size="icon-sm" aria-label={side ? "Hide the templates" : "Start from a template"} aria-pressed={side} onClick={() => setSide((x) => !x)}>
              <LayoutTemplateIcon />
            </Button>
          </Tip>
          <ReadyChip checks={checks} onPick={(c) => goTo(c.on)} />
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
      <section className="wf-canvas-wrap" aria-label="How this workflow runs">
        {error && (
          <p role="alert" className="wf-error">
            {error}
            <button type="button" aria-label="Dismiss" onClick={() => setError("")}>
              <XIcon className="size-3.5" />
            </button>
          </p>
        )}
        {live && <LiveLine run={live} steps={steps} />}
        {live?.status === "asking" && id && (
          <div className="wf-asks-float">
            <WorkflowAsksFor identity={identity} id={id} onAnswered={onRan} />
          </div>
        )}
        <Canvas d={d} steps={steps} names={names} others={others} sel={sel} live={live} checks={checks} onPick={setSel} onAdd={addStep} />
        {sel && (
          <Inspector
            key={sel}
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
function ReadyChip({ checks, onPick }: { checks: WorkflowCheck[]; onPick: (c: WorkflowCheck) => void }) {
  const fixes = checks.filter((c) => c.level === "fix").length;
  const tone: DotState = fixes ? "bad" : checks.length ? "idle" : "done";
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-2 border-[var(--border)] bg-[var(--bg)] text-[13px] shadow-none">
          <Dot state={tone} />
          {fixes ? `${fixes} to fix` : checks.length ? `${checks.length} to check` : "Ready to run"}
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
const stepZoom = (z: number, dir: 1 | -1) => {
  const i = ZOOMS.findIndex((v) => v >= z - 0.001);
  return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i < 0 ? ZOOMS.length - 1 : i) + dir))]!;
};

type AddStep = (col: number, alongside: boolean, kind?: StepKind) => void;

function Canvas({ d, steps, names, others, sel, live, checks, onPick, onAdd }: { d: Draft; steps: WorkflowStep[]; names: Names; others: { id: string; name: string }[]; sel: Sel; live: WorkflowRun | null; checks: WorkflowCheck[]; onPick: (s: Sel) => void; onAdd: AddStep }) {
  const scroll = useRef<HTMLDivElement>(null);
  const flow = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ w: 1000, h: 600, fw: 900, fh: 400 });
  const [userZoom, setZoom] = useState(1);
  const [shift, setShift] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const pan = useRef<{ x: number; y: number } | null>(null);
  const [paths, setPaths] = useState<{ d: string; live: boolean; back?: { x: number; y: number; text: string } }[]>([]);
  const cols = columnsOf(steps);
  // Narrower than a column and its neighbours need, the steps are a list, top to bottom, at full size.
  const stacked = view.w < 640;
  const stackedNow = useRef(stacked);
  stackedNow.current = stacked;
  // Wider than the window, it is shown whole, scaled down to half at the least; the zoom buttons scale on top of that.
  // Never below 60% by itself, where a card's words can still be read: a wider one is panned across, or zoomed out.
  // Its margins are the stage's 24px a side: fitted to 32 it came out 16px wider than the window, with a scrollbar under it
  // (Arun, 2026-10-28: "look for like the little details and designs").
  const fit = stacked ? 1 : Math.max(0.6, Math.min(1, (view.w - 48) / view.fw));
  const zoom = +(userZoom * fit).toFixed(3);
  const flagged = new Set(checks.filter((c) => c.level === "fix").map((c) => c.on));
  const runStep = (id: string) => live?.steps.find((s) => s.step === id) ?? null;

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
  // The wires: from each card's right edge to the next column's cards' left edges, measured on screen, drawn in the flow's units.
  useLayoutEffect(() => {
    const f = flow.current;
    if (!f || stacked) return setPaths([]);
    const box = f.getBoundingClientRect();
    const at = (id: string) => f.querySelector<HTMLElement>(`[data-wf-node="${id}"]`)?.getBoundingClientRect();
    const out: { d: string; live: boolean; back?: { x: number; y: number; text: string } }[] = [];
    const link = (a: string, b: string, on: boolean) => {
      const r1 = at(a);
      const r2 = at(b);
      if (!r1 || !r2) return;
      const x1 = (r1.right - box.left) / zoom;
      const y1 = (r1.top + r1.height / 2 - box.top) / zoom;
      const x2 = (r2.left - box.left) / zoom;
      const y2 = (r2.top + r2.height / 2 - box.top) / zoom;
      const mx = (x1 + x2) / 2;
      out.push({ d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, live: on });
    };
    const ids = cols.map((c) => c.map((s) => s.id));
    const working = (id: string) => ((s) => s?.status === "claimed" || s?.status === "review")(runStep(id));
    const finished = (id: string) => runStep(id)?.status === "done";
    if (!ids.length) link("trigger", "outcomes", false);
    for (const s of ids[0] ?? []) link("trigger", s, !!live && working(s));
    for (let i = 1; i < ids.length; i++) for (const a of ids[i - 1]!) for (const b of ids[i]!) link(a, b, finished(a) && working(b));
    for (const s of ids.at(-1) ?? []) link(s, "outcomes", false);
    // A check or OK that sends the work back: a loop under the cards, from it back to the step it names, clear of the
    // Alongside buttons; shorter loops inside longer ones, each at its own depth, its count where it bottoms out.
    const loops = steps
      .filter((x) => isGate(x) && x.ifNot === "back" && x.back)
      .map((g) => ({ g, span: steps.indexOf(g) - steps.findIndex((x) => x.id === g.back) }))
      .sort((a, b) => a.span - b.span);
    const floor = Math.max(0, ...[...f.querySelectorAll<HTMLElement>("[data-wf-node]")].map((el) => (el.getBoundingClientRect().bottom - box.top) / zoom));
    loops.forEach(({ g }, i) => {
      const r1 = at(g.id);
      const r2 = at(g.back!);
      if (!r1 || !r2) return;
      const x1 = (r1.left + r1.width / 2 - box.left) / zoom;
      const y1 = (r1.bottom - box.top) / zoom;
      // Into the step's right side, clear of its Alongside button under the middle.
      const x2 = (r2.right - 36 - box.left) / zoom;
      const y2 = (r2.bottom - box.top) / zoom;
      const low = floor + 56 + i * 30;
      out.push({ d: `M${x1},${y1} L${x1},${low - 14} Q${x1},${low} ${x1 - 14},${low} L${x2 + 14},${low} Q${x2},${low} ${x2},${low - 14} L${x2},${y2 + 3}`, live: false, back: { x: (x1 + x2) / 2, y: low + 4, text: `back to step ${steps.findIndex((x) => x.id === g.back) + 1} · up to ${g.tries ?? DEFAULT_TRIES}×` } });
    });
    setPaths(out);
  }, [JSON.stringify(d), zoom, view.w, view.fh, stacked, live?.steps.map((s) => s.status).join()]);

  const node = (id: string, children: ReactNode) => (
    <NodeCard key={id} id={id} sel={sel} flagged={flagged} onPick={onPick} runStep={runStep}>
      {children}
    </NodeCard>
  );
  return (
    <div className={cn("wf-canvas", stacked && "stacked")}>
      <div
        className={cn("wf-scroll", panning && "panning")}
        ref={scroll}
        onPointerDown={(e) => {
          if (e.button !== 0 || stacked || (e.target as HTMLElement).closest("button, [data-wf-node], input, textarea")) return;
          pan.current = { x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!pan.current) return;
          const dx = e.clientX - pan.current.x;
          const dy = e.clientY - pan.current.y;
          if (!panning && Math.hypot(dx, dy) < 3) return;
          setPanning(true);
          pan.current = { x: e.clientX, y: e.clientY };
          setShift((s) => ({ x: s.x + dx, y: s.y + dy }));
        }}
        onPointerUp={() => ((pan.current = null), setPanning(false))}
        onPointerCancel={() => ((pan.current = null), setPanning(false))}
      >
        <div className="wf-stage" style={stacked ? undefined : { width: Math.max(view.fw * zoom + 48, view.w), height: Math.max(view.fh * zoom + 96, view.h) }}>
          <div
            ref={flow}
            className={cn("wf-flow", steps.some((x) => isGate(x) && x.ifNot === "back") && "loops")}
            style={stacked ? undefined : { transform: `translate(${shift.x + Math.max(24, (view.w - view.fw * zoom) / 2)}px, ${shift.y + Math.max(24, (view.h - view.fh * zoom) / 2 - 10)}px) scale(${zoom})` }}
          >
            {!stacked && (
              <svg className="wf-wires" aria-hidden="true">
                <defs>
                  <marker id="wf-back-head" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M1,1 L7,4 L1,7" className="wf-back-head" />
                  </marker>
                </defs>
                {paths.map((p, i) =>
                  p.back ? (
                    <g key={i}>
                      <path d={p.d} className="back" markerEnd="url(#wf-back-head)" />
                      <text x={p.back.x} y={p.back.y} className="wf-back-label" textAnchor="middle">
                        {p.back.text}
                      </text>
                    </g>
                  ) : (
                    <path key={i} d={p.d} className={p.live ? "live" : undefined} />
                  ),
                )}
              </svg>
            )}
            <div className="wf-col wf-col-end">{node("trigger", <TriggerBody d={d} names={names} />)}</div>
            <Gap label={steps.length ? "Add before the first step" : "Add the first step"} onAdd={(kind) => onAdd(0, false, kind)} stacked={stacked} first={!steps.length} />
            {cols.map((col, i) => (
              <ColumnAndGap key={col.map((s) => s.id).join()} i={i} last={i === cols.length - 1} col={col} steps={steps} node={node} stacked={stacked} onAdd={onAdd} full={steps.length >= MAX_STEPS} names={names} room={d.room} runStep={runStep} />
            ))}
            <div className="wf-col wf-col-end">{node("outcomes", <OutcomesBody d={d} others={others} />)}</div>
          </div>
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
            <Button variant="ghost" size="sm" className="h-8 min-w-14 px-2 text-[13px] font-medium text-[var(--ink)] tabular-nums" onClick={() => (setZoom(1), setShift({ x: 0, y: 0 }))}>
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
            <Button variant="ghost" size="icon-sm" aria-label="Fit it in view" className="text-[var(--ink-2)]" onClick={() => (setZoom(1), setShift({ x: 0, y: 0 }))}>
              <ScanIcon />
            </Button>
          </Tip>
        </div>
      )}
    </div>
  );
}

function ColumnAndGap({ i, last, col, steps, node, stacked, onAdd, full, names, room, runStep }: { i: number; last: boolean; col: WorkflowStep[]; steps: WorkflowStep[]; node: (id: string, children: ReactNode) => ReactNode; stacked: boolean; onAdd: AddStep; full: boolean; names: Names; room: string; runStep: RunStepOf }) {
  const gate = col.length === 1 && isGate(col[0]!);
  return (
    <>
      <div className={cn("wf-col", col.length > 1 && "side-by-side")} role="group" aria-label={col.length > 1 ? `Steps ${steps.indexOf(col[0]!) + 1} to ${steps.indexOf(col.at(-1)!) + 1}, side by side` : `Step ${steps.indexOf(col[0]!) + 1}`}>
        {stacked && col.length > 1 && <span className="wf-col-label">Side by side</span>}
        {col.map((s) => node(s.id, isGate(s) ? <GateBody s={s} n={steps.indexOf(s) + 1} steps={steps} names={names} room={room} run={runStep(s.id)} /> : <StepBody s={s} n={steps.indexOf(s) + 1} names={names} room={room} at={runStep(s.id)?.status ?? null} asked={runStep(s.id)?.asked ?? null} again={runStep(s.id)?.again ?? 0} />))}
        {!gate && (
          <button type="button" className="wf-alongside" disabled={full} onClick={() => onAdd(i, true)}>
            <PlusIcon className="size-3.5" /> {stacked ? "Add a step alongside" : "Alongside"}
          </button>
        )}
      </div>
      <Gap label={last ? "Add after the last step" : `Add after step ${steps.indexOf(col.at(-1)!) + 1}`} onAdd={(kind) => onAdd(i + 1, false, kind)} stacked={stacked} disabled={full} />
    </>
  );
}

const ADD_KINDS: { kind: StepKind; icon: LucideIcon; name: string; says: string }[] = [
  { kind: "do", icon: UsersIcon, name: "A step", says: "A teammate does part of the work." },
  { kind: "check", icon: ShieldCheckIcon, name: "A check", says: "A teammate checks the work. Not passed, it goes back or the run stops." },
  { kind: "approve", icon: HandIcon, name: "Your OK", says: "The run waits for you to OK it, or send it back." },
];

/** The space between two columns, with its "+": a step, a check or your OK, in a column of its own there. */
function Gap({ label, onAdd, stacked, disabled, first }: { label: string; onAdd: (kind?: StepKind) => void; stacked: boolean; disabled?: boolean; /** No steps yet: the "+" says what it does. */ first?: boolean }) {
  const [open, setOpen] = useState(false);
  if (first)
    return (
      <div className="wf-gap first">
        <button type="button" className="wf-first" onClick={() => onAdd("do")}>
          <PlusIcon className="size-4" /> Add the first step
        </button>
      </div>
    );
  return (
    <div className="wf-gap">
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

function NodeCard({ id, children, sel, flagged, onPick, runStep }: { id: string; children: ReactNode; sel: Sel; flagged: Set<string>; onPick: (s: Sel) => void; runStep: RunStepOf }) {
  const kind = id === "trigger" || id === "outcomes" ? id : "step";
  const run = kind === "step" ? runStep(id) : null;
  const open = () => onPick(sel === id ? null : id);
  return (
    <div
      className={cn("wf-node", `wf-node-${kind}`, sel === id && "sel", flagged.has(id) && "flag")}
      data-wf-node={id}
      data-run={run?.status}
      tabIndex={0}
      role="button"
      aria-pressed={sel === id}
      onClick={open}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      {children}
      {/* Not under a step being done: its face's ring and "On this step" say it, so no second "Working" (DIRECTION.md §9.4). */}
      {run && (run.status !== "claimed" || run.kind === "approve") && (
        <span className="wf-node-run">
          <TaskMark state={run.kind === "approve" && run.status === "claimed" ? "review" : stepMark(run.status)} />
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
      <div className="wf-node-head">
        <span className="wf-node-kind">Trigger</span>
      </div>
      <div className="wf-node-body">
        <div className="wf-trigger">
          <span className="wf-trigger-tile">
            <Icon className="size-4" />
          </span>
          <span className="wf-trigger-text">{triggerLong(d.trigger, names)}</span>
        </div>
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
      <div className="wf-node-head">
        <span className="wf-node-kind">Then</span>
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
      <div className="wf-node-head">
        <span className="wf-node-kind">Step {n}</span>
        {again > 0 && <span className="wf-again">Try {again + 1}</span>}
      </div>
      <div className="wf-node-body">
        <div className="wf-who">
          {m ? <Face seed={m.look ?? m.name} size={24} status={onIt ? "working" : m.status} lead={lead} /> : <span className="wf-face-none" style={{ width: 24, height: 24 }} />}
          <span className="wf-who-text">
            <span className="wf-who-name">{m ? (lead ? `The lead · ${m.name}` : m.name) : lead ? "The lead" : "Pick a teammate"}</span>
            {says ? <span className={cn("tm-sub", `s-${says.state}`)}>{says.line}</span> : <span className="tm-sub">{lead ? "Nobody leads this room" : "Nobody does this yet"}</span>}
          </span>
        </div>
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
  const back = s.ifNot === "back" ? steps.findIndex((x) => x.id === s.back) + 1 : 0;
  const onIt = run?.status === "claimed" || run?.status === "review";
  return (
    <>
      <div className="wf-node-head">
        <span className="wf-node-kind">
          Step {n} · {ok ? "Your OK" : "Check"}
        </span>
        {(run?.again ?? 0) > 0 && <span className="wf-again">Try {(run?.again ?? 0) + 1}</span>}
      </div>
      <div className="wf-node-body">
        <div className="wf-who">
          {ok ? (
            <span className="wf-gate-tile" aria-hidden="true">
              <HandIcon className="size-3.5" />
            </span>
          ) : m ? (
            <Face seed={m.look ?? m.name} size={24} status={onIt ? "working" : m.status} lead={s.mate === LEAD} />
          ) : (
            <span className="wf-face-none" style={{ width: 24, height: 24 }} />
          )}
          <span className="wf-who-text">
            <span className="wf-who-name">{ok ? "You" : m ? (s.mate === LEAD ? `The lead · ${m.name}` : m.name) : "Pick who checks"}</span>
            <span className="tm-sub">{ok ? "Asked before it goes on" : onIt ? "Checking" : "Checks the work so far"}</span>
          </span>
        </div>
        <p className={cn("wf-does", !s.does.trim() && "muted")}>{s.does.trim() ? (ok ? s.does.trim() : `Goes on if ${s.does.trim().replace(/^./, (c) => c.toLowerCase())}`) : ok ? "Say what you're asked." : "Say what has to hold."}</p>
        <span className="wf-row">
          {s.ifNot === "back" ? <CornerUpLeftIcon className="size-3.5" /> : <XIcon className="size-3.5" />}
          {s.ifNot === "back" ? (back ? `${ok ? "If you say no" : "If not"}: back to step ${back}, up to ${s.tries ?? DEFAULT_TRIES}×` : "Pick the step it sends back to") : `${ok ? "If you say no" : "If not"}: the run stops`}
        </span>
      </div>
    </>
  );
}

// ── the settings beside the canvas ───────────────────────────────────

function Inspector({
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
}: {
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
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    // Into its first field, so a card opened from the keyboard is edited from the keyboard.
    ref.current?.querySelector<HTMLElement>("textarea, input, button[role='combobox'], [role='tab']")?.focus();
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
        {s && <StepForm s={s} n={steps.indexOf(s) + 1} steps={steps} d={d} names={names} setStep={setStep} moveStep={moveStep} removeStep={removeStep} />}
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
function MatePick({ s, d, names, lead, setStep }: { s: WorkflowStep; d: Draft; names: Names; lead: TeammateView | null; setStep: (id: string, c: Partial<WorkflowStep>) => void }) {
  return (
    <Select value={s.mate || undefined} onValueChange={(v) => setStep(s.id, { mate: v })}>
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
      </SelectContent>
    </Select>
  );
}

function StepForm({ s, n, steps, d, names, setStep, moveStep, removeStep }: { s: WorkflowStep; n: number; steps: WorkflowStep[]; d: Draft; names: Names; setStep: (id: string, c: Partial<WorkflowStep>) => void; moveStep: (id: string, by: -1 | 1) => void; removeStep: (id: string) => void }) {
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
  const setKind = (k: StepKind) => {
    if (k === kind) return;
    const last = earlier.at(-1);
    setStep(s.id, k === "do" ? { kind: undefined, ifNot: undefined, back: undefined, tries: undefined } : { kind: k, mate: k === "approve" ? "" : s.mate || LEAD, owns: [], ifNot: s.ifNot ?? (last ? "back" : "stop"), back: s.back ?? last?.id, tries: s.tries ?? DEFAULT_TRIES, ...(k === "approve" && !s.does.trim() ? { does: "Is this ready to go on?" } : {}) });
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
            <MatePick s={s} d={d} names={names} lead={lead} setStep={setStep} />
          </Field>
        )}
        <Field label={kind === "check" ? "What has to hold" : "What you're asked"} hint={kind === "check" ? "It's handed what the steps before came to." : "You see what the steps before came to, beside the question."}>
          <Textarea value={s.does} onChange={(e) => setStep(s.id, { does: e.target.value })} placeholder={kind === "check" ? "The tests pass and every bug QA listed is fixed." : "Is the post ready to go out?"} className="min-h-[96px] text-[13px] leading-relaxed md:text-[13px]" maxLength={4000} />
        </Field>
        <Field label={kind === "check" ? "If it doesn't pass" : "If you say no"}>
          <PageTabs<"stop" | "back">
            label={kind === "check" ? "If it doesn't pass" : "If you say no"}
            value={s.ifNot === "back" ? "back" : "stop"}
            onChange={(v) => setStep(s.id, v === "back" ? { ifNot: "back", back: s.back && earlier.some((x) => x.id === s.back) ? s.back : earlier.at(-1)?.id } : { ifNot: "stop" })}
            options={[
              { value: "back", label: "Send it back" },
              { value: "stop", label: "Stop the run" },
            ]}
          />
        </Field>
        {s.ifNot === "back" && (
          <>
            <Field label="Back to" hint={kind === "check" ? "That step is told why, and does its part again; then the check runs again." : "That step is told what you said, and does its part again."}>
              <Select value={s.back && earlier.some((x) => x.id === s.back) ? s.back : undefined} onValueChange={(v) => setStep(s.id, { back: v })}>
                <SelectTrigger size="sm" aria-label="Back to" className="h-9 w-full text-[13px]">
                  <SelectValue placeholder={earlier.length ? "Pick a step" : "No step before it does work"} />
                </SelectTrigger>
                <SelectContent position="popper" align="start" collisionPadding={8} className="max-w-[calc(100vw-16px)]">
                  {earlier.map((x) => (
                    <SelectItem key={x.id} value={x.id}>
                      Step {steps.indexOf(x) + 1} · {stepTitle(x, steps.indexOf(x) + 1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Times, at most" hint="Past that, the run stops and says why.">
              <Input type="number" min={1} max={MAX_TRIES} value={s.tries ?? DEFAULT_TRIES} onChange={(e) => setStep(s.id, { tries: Math.min(MAX_TRIES, Math.max(1, Math.round(Number(e.target.value) || 1))) })} aria-label="Times, at most" className="h-9 w-[96px] text-[13px] tabular-nums md:text-[13px]" />
            </Field>
          </>
        )}
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
        <MatePick s={s} d={d} names={names} lead={lead} setStep={setStep} />
      </Field>
      <Field label="What it does" hint={n > 1 && s.col > 0 ? "Gets what the steps before it found." : "Gets what started the run."}>
        <Textarea value={s.does} onChange={(e) => setStep(s.id, { does: e.target.value })} placeholder="Read what merged this week and list the changes, grouped as new, improved and fixed." className="min-h-[132px] text-[13px] leading-relaxed md:text-[13px]" maxLength={4000} />
        {/* A crew skill for the step: its line leads what it does, and the teammate fetches the steps (CrewSkills.tsx). */}
        <StepSkill does={s.does} onChange={(does) => setStep(s.id, { does })} />
      </Field>
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
