import type { AgentSchedule } from "./agents.js";
import type { BoardStatus } from "./session/projection.js";
import type { BoardTaskDef } from "./types.js";

/**
 * Team workflows: the Team's automations, drawn as a workflow (Arun, 2026-10-28: "make the automation for the teams platform
 * different it can be like a workflow automation design like we did with the agent tab page a while ago").
 *
 * A workflow is a trigger, then steps, then outcomes. Each step is one teammate (or the room's lead) with its instructions and
 * the files it owns; steps in one column run side by side, and each column waits on the one before it, its results handed on.
 * A run is a board posted in its room (agent-mesh.ts post_tasks): the board does the claiming, the checks, the reviews and the
 * lead's report, and the outcomes run once it is through (team-workflows.ts).
 *
 * Two more kinds of step make it go somewhere (Arun, 2026-11-01: "expand on the workflow automation for the crew stuff we need
 * to make it very advanced but very easy to use"): a check, a teammate saying PASS or FAIL on the work so far, and your OK, the
 * run waiting for you. Either, not passed, stops the run there or sends the work back to an earlier step with why, a few times
 * at most. Each stands alone in its column, and they cut a run into stages (stagesOf): a stage is one board, ending at a check;
 * your OK is a stage of its own with no board, the run waiting between two.
 *
 * The shapes and the plain rules, with no Node in them, so the page reads them too (TeamWorkflows.tsx).
 *
 */

/** What starts a run. A webhook's secret is the server's; the page is sent its address instead (`url`). */
export type WorkflowTrigger =
  | { kind: "schedule"; schedule: AgentSchedule }
  | { kind: "webhook"; secret: string; url?: string }
  /** A teammate finishing a turn (its run done) or a board task (approved), anywhere it works. */
  | { kind: "teammate"; mate: string; on: "turn" | "task" }
  /** A board in a room finishing: "team" is the Team room, else a room's id. */
  | { kind: "board"; room: string }
  | { kind: "manual" };

export type TriggerKind = WorkflowTrigger["kind"];

/** The room's lead, whoever it is when the run starts, as a step's teammate. */
export const LEAD = "lead";
/** The Team room, as a workflow's room. */
export const TEAM_ROOM = "team";

/** "do": a teammate does it. "check": a teammate checks the work so far against `does`. "approve": the run waits for your OK. */
export type StepKind = "do" | "check" | "approve";

export interface WorkflowStep {
  id: string;
  /** A teammate's id, or LEAD. Empty until one is picked; always empty for your OK. */
  mate: string;
  /** What it does: its instructions. A check's: what has to hold. Your OK's: what you're asked. */
  does: string;
  /** Files or folders it owns: no other step edits them. */
  owns: string[];
  /** Its column: 0 runs first; one column waits on the one before it; steps in one column run side by side. */
  col: number;
  /** "do" when missing. */
  kind?: StepKind;
  /** A check or your OK not passed: "stop" ends the run there, "back" sends the work back to `back` with why. */
  ifNot?: "stop" | "back";
  /** The earlier step the work goes back to. */
  back?: string;
  /** How many times it sends the work back before the run gives up. */
  tries?: number;
  /**
   * Who does the step sent back to, that time: a teammate's id or LEAD; absent is that step's own. A reviewer's FAIL handed to a
   * fixer on another tool or account, then checked again (Arun, 2026-11-02, from discussion #8: Review → "Prepare fixes" → again).
   */
  fixBy?: string;
}

export const isGate = (s: Pick<WorkflowStep, "kind">): boolean => s.kind === "check" || s.kind === "approve";
export const kindOf = (s: Pick<WorkflowStep, "kind">): StepKind => s.kind ?? "do";
/** Sent back this many times at most, unless it says. */
export const DEFAULT_TRIES = 3;
export const MAX_TRIES = 5;

export interface WorkflowOutcomes {
  /** A brief of the run posted in its room (team.brief). */
  brief: boolean;
  /** The person told when it ends (a notification). */
  notify: boolean;
  /** The lead asked to merge the teammates' branches and open one pull request. */
  pr: boolean;
  /** Another workflow handed this one's result, by id; "" for none. */
  then: string;
}

export interface WorkflowLimits {
  perDay: number;
  /** A run due while the room's board is still being worked on is skipped; otherwise it waits for the board to be free. */
  skipIfRunning: boolean;
}

export interface Workflow {
  id: string;
  name: string;
  on: boolean;
  /** TEAM_ROOM or a room's id. */
  room: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  outcomes: WorkflowOutcomes;
  limits: WorkflowLimits;
  /** What Run now asks you for, handed to the first steps: "Which feature is launching?". "" (or missing) asks nothing. */
  ask?: string;
  created: number;
  updated: number;
}

/** "asking": waiting for your OK. "stopped": a check or you stopped it, as it was told to. */
export type WorkflowRunStatus = "running" | "waiting" | "asking" | "done" | "stopped" | "failed" | "skipped";

/** A step as one run has it: its board task and where that stands. */
export interface WorkflowRunStep {
  step: string;
  task: string;
  title: string;
  /** Who does it: its teammate's name. */
  name: string;
  lane: string;
  status: BoardStatus;
  /** What it came to (its report), once it has. */
  report?: string;
  /**
   * Asked of its teammate's keeper, where the run's owner can't give it the work (the hosted service's: someone else's teammate on
   * its own plan, own-plan.ts): whom, and whether they took it on.
   */
  asked?: { keeper: string; status: "open" | "taken" | "declined" };
  kind?: StepKind;
  /** A check's or your OK's answer, the last time it was asked. */
  verdict?: { pass: boolean; why: string };
  /** How many times it has been done in this run, past the first: the work sent back to it. */
  again?: number;
}

export interface WorkflowRun {
  id: string;
  at: number;
  /** What started it, in words: "every weekday at 09:00", "Run now", "webhook", "Kit finished a turn". */
  trigger: string;
  status: WorkflowRunStatus;
  /** Where it runs: the room's id (or TEAM_ROOM), name and session. */
  room: string;
  roomName: string;
  sid?: string;
  /** Its board, by the seq of its board.posted. */
  seq?: number;
  steps: WorkflowRunStep[];
  /** What it was handed when it started: a webhook's payload, a teammate's last words, another workflow's result. */
  input?: string;
  /** Why it failed, waits or was skipped. */
  note?: string;
  /**
   * Waiting for its room's board since when, and whether it was already under way: the twelve hours are from then, not from
   * when the run began, and a run under way isn't skipped as a fresh one would be (2026-11-02 review: OK'd at 9am, a run begun
   * at 8pm the night before was skipped on the next tick).
   */
  waitingSince?: number;
  waitingCont?: boolean;
  ended?: number;
  /** What it came to: the last column's reports, for the brief and for the workflow it hands on to. */
  result?: string;
  /** How many workflows handed on to reach this one (MAX_CHAIN). */
  depth?: number;
  /** The stage it is at (stagesOf), and what that stage is handed: what the stage before came to, or why the work came back. */
  stage?: number;
  carry?: string;
  /** Each check's and OK's sends back so far, by step id. */
  tries?: Record<string, number>;
  /** Sent back: the step the stage starts again from, its steps before it standing. */
  from?: string;
  /** Sent back to be done by someone else than that step's own (WorkflowStep.fixBy): who, this once. */
  fixBy?: string;
  /** Waiting for your OK: which step, what you're asked, since when. */
  asking?: { step: string; ask: string; since: number };
  /** Its first board's seq: the brief finds every stage's tasks after it. */
  seq0?: number;
}

/** A workflow as the page is sent it. */
export interface WorkflowView extends Workflow {
  says: { trigger: string };
  runs: WorkflowRun[];
  today: number;
  /** When its schedule next fires, if it has one and is on. */
  next: number | null;
}

/** The most steps a workflow has: the board's own limit (agent-mesh.ts MAX_BOARD_TASKS). */
export const MAX_STEPS = 24;
/** How many workflows deep a hand-on goes: A hands to B hands to C, and no further. */
export const MAX_CHAIN = 3;

export const BLANK_OUTCOMES: WorkflowOutcomes = { brief: true, notify: true, pr: false, then: "" };
export const BLANK_LIMITS: WorkflowLimits = { perDay: 6, skipIfRunning: true };

/**
 * The steps by column, in order, each column's in its order, with the columns numbered 0, 1, 2… with none empty. A check or
 * your OK stands alone: one sharing a column is given its own, after the column's work.
 */
export function columnsOf(steps: readonly WorkflowStep[]): WorkflowStep[][] {
  const cols = [...new Set(steps.map((s) => s.col))].sort((a, b) => a - b);
  return cols.flatMap((c) => {
    const col = steps.filter((s) => s.col === c);
    if (col.length < 2 || !col.some(isGate)) return [col];
    const work = col.filter((s) => !isGate(s));
    return [...(work.length ? [work] : []), ...col.filter(isGate).map((g) => [g])];
  });
}

/** A stage of a run: the columns one board carries, ending at its check (`gate`); or your OK, with no columns and no board. */
export interface WorkflowStage {
  cols: WorkflowStep[][];
  gate: WorkflowStep | null;
}

/** The workflow's stages, in order: its columns cut after each check, and around each OK. */
export function stagesOf(steps: readonly WorkflowStep[]): WorkflowStage[] {
  const out: WorkflowStage[] = [];
  let cur: WorkflowStep[][] = [];
  for (const col of columnsOf(steps)) {
    const g = col[0]!;
    if (g.kind === "approve") {
      if (cur.length) out.push({ cols: cur, gate: null });
      out.push({ cols: [], gate: g });
      cur = [];
    } else if (g.kind === "check") {
      out.push({ cols: [...cur, col], gate: g });
      cur = [];
    } else cur.push(col);
  }
  if (cur.length) out.push({ cols: cur, gate: null });
  return out;
}

/**
 * The columns a stage's board carries: all of them, or, for work sent back to `from`, those from its column on (the steps
 * before it in the stage stand as they were).
 */
export function stageCols(steps: readonly WorkflowStep[], stage: number, from = ""): WorkflowStep[][] {
  const stages = stagesOf(steps);
  const cols = stages.length ? (stages[stage]?.cols ?? []) : columnsOf(steps);
  const at = from ? cols.findIndex((c) => c.some((s) => s.id === from)) : -1;
  return at > 0 ? cols.slice(at) : cols;
}

/** The stage a step is in, or -1. */
export const stageOfStep = (stages: readonly WorkflowStage[], id: string): number => stages.findIndex((st) => st.gate?.id === id || st.cols.some((c) => c.some((s) => s.id === id)));

/**
 * A check's answer, from the last line of its report that says one: "PASS", or "FAIL: why". Markdown around it is let be. A
 * report that says neither is no answer (null): the run takes it as not passed, never as passed.
 */
export function verdictOf(report: string): { pass: boolean; why: string } | null {
  const lines = report
    .split("\n")
    .map((l) => l.trim().replace(/^[>*_`#\-\s]+/, "").replace(/[*_`]+$/, "").trim())
    .filter(Boolean);
  for (const l of lines.reverse()) {
    const m = l.match(/^(PASS|FAIL)(?:ED)?\b[\s:.,\u2014\u2013-]*(.*)$/i);
    if (m) return { pass: m[1]!.toUpperCase() === "PASS", why: m[2]!.trim() };
  }
  return null;
}

/** What the steps sent back to are told: which time this is, why the work came back, and what it came to last time. */
export function sendBackNote(o: { gate: Pick<WorkflowStep, "kind" | "does" | "fixBy">; why: string; attempt: number; max: number; before: string }): string {
  const what =
    o.gate.kind === "approve"
      ? `You were sent back by the person${o.why ? `, who said: ${o.why}` : "."}`
      : `The check “${clipLine(o.gate.does, 200)}” didn't pass${o.why ? `: ${o.why}` : "."}`;
  // Handed to a fixer (fixBy): the step's work is someone else's so far, to carry on from rather than do again.
  const then = o.gate.fixBy ? "You're fixing it: the step was done by another teammate, so carry on from their work rather than start over." : "Fix that, then do your step again.";
  return [`This is try ${o.attempt + 1} of ${o.max + 1}. ${what} ${then}`, o.before.trim() ? `What it came to last time:\n${o.before.trim().slice(0, 6000)}` : ""].filter(Boolean).join("\n\n");
}

const clipLine = (s: string, n: number) => ((l) => (l.length > n ? `${l.slice(0, n - 1).trimEnd()}…` : l))(s.trim().split("\n")[0]!.trim());

/** The steps with their columns closed up (0, 1, 2…), in reading order: column by column, top to bottom. */
export function packSteps(steps: readonly WorkflowStep[]): WorkflowStep[] {
  return columnsOf(steps).flatMap((col, i) => col.map((s) => ({ ...s, col: i })));
}

/** "Step 2": a step's number in reading order. */
export const stepNumber = (steps: readonly WorkflowStep[], id: string): number => packSteps(steps).findIndex((s) => s.id === id) + 1;

/** A step's title on the board: the first line of what it does, cut short, or "Step n". */
export function stepTitle(s: Pick<WorkflowStep, "does">, n: number): string {
  const line = s.does.trim().split("\n")[0]!.replace(/\s+/g, " ").trim();
  return line ? (line.length > 90 ? `${line.slice(0, 88).trimEnd()}…` : line) : `Step ${n}`;
}

/** A board task carrying who it goes to (`next`, as a person's pick: board.posted keeps each task's fields). */
export type PostedTask = BoardTaskDef & { next: string };

/**
 * The board a run posts for one stage (all of it when there are no checks or OKs): a task per step, each waiting on every step
 * in the column before it, each for its teammate by name (`next`: it goes to them whatever they are doing, the lead included).
 * The first column is told what started the run, or what the stage before came to; the board hands every later step the reports
 * of those it waited on (agent-mesh.ts taskBrief). A check's task asks for PASS or FAIL on its last line (verdictOf). Ids are the
 * steps' numbers in the whole workflow, so a step is `s3` whichever stage's board it is on.
 */
export function workflowTasks(w: Pick<Workflow, "name" | "steps" | "outcomes">, nameOf: (mate: string) => string, input = "", stage = 0, from = ""): PostedTask[] {
  const all = columnsOf(w.steps);
  const total = w.steps.length;
  const numOf = new Map(all.flat().map((s, i) => [s.id, i + 1]));
  const cols = stageCols(w.steps, stage, from);
  const stages = stagesOf(w.steps);
  const lastStage = !stages.length || stage >= stages.length - 1;
  const ids = cols.map((col) => col.map((s) => `s${numOf.get(s.id)}`));
  return cols.flatMap((col, c) =>
    col.map((s, i) => {
      const id = ids[c]![i]!;
      const num = numOf.get(s.id)!;
      const later = c < cols.length - 1 || !lastStage;
      const check = s.kind === "check";
      const detail = [
        check
          ? `[Workflow "${w.name}", step ${num} of ${total}: a check] Check whether this holds: ${s.does.trim() || "the work so far is right."}\n\nLook at what the steps before handed on and at the work itself: run the tests, open the files. Don't change anything yourself.`
          : `[Workflow "${w.name}", step ${num} of ${total}] ${s.does.trim() || "Do your part of this workflow."}`,
        c === 0 && input.trim() ? `${stage === 0 ? "What started this run" : "Handed on to this step"}:\n${input.trim().slice(0, 6000)}` : "",
        col.length > 1 ? `Running alongside this step: ${col.filter((x) => x !== s).map((x) => nameOf(x.mate)).join(", ")}.` : "",
        check
          ? "End your report with one line on its own: PASS if it holds, or FAIL: what isn't right, in one sentence."
          : later
            ? "End with a short report of what you made or found: it is handed to the next step."
            : "End with a short report of what you made or found: it is what this run comes to.",
        "Do this step yourself; don't post a new board (it would replace this workflow's).",
      ]
        .filter(Boolean)
        .join("\n\n");
      return { id, title: check ? `Check: ${stepTitle(s, num)}` : stepTitle(s, num), detail, owns: check ? [] : s.owns.slice(0, 20), after: c > 0 ? ids[c - 1]! : [], next: nameOf(s.mate), ...(check ? { noReview: true as const } : {}) };
    }),
  );
}

/** What is missing before a workflow can run, worst first: as the Agent Studio's ready check has it. */
export interface WorkflowCheck {
  level: "fix" | "warn";
  text: string;
  /** The card it is about: "trigger", "outcomes", a step's id, or FIRST_STEP when there is none yet. */
  on: string;
}

/** A check about a step that isn't there yet: pressed, it adds the first. */
export const FIRST_STEP = "+first";

export function workflowChecks(
  w: Pick<Workflow, "name" | "room" | "trigger" | "steps" | "outcomes" | "id">,
  team: { mates: { id: string; name: string }[]; rooms: { id: string; name: string; members: string[] }[]; workflows: { id: string; name: string }[] },
): WorkflowCheck[] {
  const out: WorkflowCheck[] = [];
  const steps = packSteps(w.steps);
  if (!steps.length) out.push({ level: "fix", text: "Add a step: a teammate and what it does", on: FIRST_STEP });
  const room = w.room === TEAM_ROOM ? null : team.rooms.find((r) => r.id === w.room);
  if (w.room !== TEAM_ROOM && !room) out.push({ level: "fix", text: "Its room is gone: pick where it runs", on: "trigger" });
  steps.forEach((s, i) => {
    const n = i + 1;
    if (s.kind === "approve") {
      if (!s.does.trim()) out.push({ level: "fix", text: `Say what you're asked to OK at step ${n}`, on: s.id });
    } else if (s.kind === "check" && !s.does.trim()) out.push({ level: "fix", text: `Say what step ${n} checks`, on: s.id });
    if (isGate(s) && s.ifNot === "back") {
      const to = steps.findIndex((x) => x.id === s.back);
      if (to < 0 || to >= i || isGate(steps[to]!)) out.push({ level: "fix", text: `Pick the earlier step ${n} sends the work back to`, on: s.id });
      if (s.fixBy && s.fixBy !== LEAD) {
        const m = team.mates.find((x) => x.id === s.fixBy);
        if (!m) out.push({ level: "fix", text: `Who fixes what step ${n} sends back isn't in the crew any more`, on: s.id });
        else if (room && !room.members.includes(m.id)) out.push({ level: "fix", text: `${m.name} isn't in ${room.name}: add them to the room, or pick someone there to fix what step ${n} sends back`, on: s.id });
      }
    }
    if (s.kind === "approve") return;
    if (!s.mate) out.push({ level: "fix", text: `Pick ${s.kind === "check" ? "who checks" : "a teammate for"} step ${n}`, on: s.id });
    else if (s.mate !== LEAD) {
      const m = team.mates.find((x) => x.id === s.mate);
      if (!m) out.push({ level: "fix", text: `Step ${n}'s teammate isn't in the crew any more`, on: s.id });
      else if (room && !room.members.includes(m.id)) out.push({ level: "fix", text: `${m.name} isn't in ${room.name}: add them to the room, or pick someone there for step ${n}`, on: s.id });
    }
    if (!s.does.trim() && s.kind !== "check") out.push({ level: "fix", text: `Say what step ${n} does`, on: s.id });
  });
  if (steps.length && steps.every(isGate)) out.push({ level: "fix", text: "Add a step that does the work: checks and OKs only look at it", on: FIRST_STEP });
  const t = w.trigger;
  if (t.kind === "teammate" && !team.mates.some((m) => m.id === t.mate)) out.push({ level: "fix", text: "Pick the teammate whose work starts it", on: "trigger" });
  if (t.kind === "board" && t.room !== TEAM_ROOM && !team.rooms.some((r) => r.id === t.room)) out.push({ level: "fix", text: "Pick the room whose board starts it", on: "trigger" });
  if (t.kind === "board" && t.room === w.room) out.push({ level: "warn", text: "It starts when a board in its own room finishes: its own runs don't, but the lead's next board will", on: "trigger" });
  if (t.kind === "schedule" && t.schedule.every === "weekly" && !t.schedule.days.length) out.push({ level: "fix", text: "Pick the days it runs", on: "trigger" });
  if (w.outcomes.then && w.outcomes.then === w.id) out.push({ level: "fix", text: "It can't hand its result to itself", on: "outcomes" });
  else if (w.outcomes.then && !team.workflows.some((x) => x.id === w.outcomes.then)) out.push({ level: "warn", text: "The workflow it hands on to is gone", on: "outcomes" });
  if (!w.name.trim()) out.push({ level: "warn", text: "Name it, so its runs say what they are", on: "trigger" });
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "fix" ? -1 : 1));
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A schedule in a few words: "Weekdays 09:00", "Mon, Thu 17:30", "Every hour". */
export function scheduleShort(s: AgentSchedule): string {
  if (s.every === "hourly") return "Every hour";
  if (s.every === "daily") return `Daily ${s.at}`;
  const d = [...s.days].sort();
  return `${d.join() === "1,2,3,4,5" ? "Weekdays" : d.length === 7 ? "Daily" : d.map((x) => DAY[x]).join(", ")} ${s.at}`;
}

/** What starts it, as a sentence's start: "Every weekday at 09:00 (Europe/London)", "When Kit finishes a turn". */
export function describeTrigger(t: WorkflowTrigger, names: { mate: (id: string) => string; room: (id: string) => string }): string {
  if (t.kind === "schedule") {
    const s = t.schedule;
    if (s.every === "hourly") return "Every hour";
    const when = `at ${s.at} (${s.tz})`;
    if (s.every === "daily") return `Every day ${when}`;
    const d = [...s.days].sort();
    return `${d.join() === "1,2,3,4,5" ? "Every weekday" : d.length === 7 ? "Every day" : `On ${d.map((x) => DAY_LONG[x]).join(", ")}`} ${when}`;
  }
  if (t.kind === "webhook") return "When its webhook is called";
  if (t.kind === "teammate") return `When ${names.mate(t.mate) || "a teammate"} finishes ${t.on === "task" ? "a board task" : "a turn"}`;
  if (t.kind === "board") return `When a board in ${names.room(t.room) || "a room"} finishes`;
  return "When you press Run now";
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * A workflow as the page sent it, made safe: anything missing or wrong becomes the plain default. `secret` makes a webhook's
 * key, kept from `prev` when it had one; `schedule` checks a schedule (agents.ts validateSchedule, on the server).
 */
export function cleanWorkflow(
  input: Record<string, unknown>,
  prev: Workflow | null,
  make: { secret: () => string; schedule: (s: unknown) => AgentSchedule | undefined },
): Omit<Workflow, "id" | "created" | "updated"> {
  const t = (input.trigger ?? prev?.trigger ?? { kind: "manual" }) as Record<string, unknown>;
  const trigger: WorkflowTrigger =
    t.kind === "schedule"
      ? { kind: "schedule", schedule: make.schedule(t.schedule) ?? { every: "weekly", at: "09:00", days: [1, 2, 3, 4, 5], tz: "UTC" } }
      : t.kind === "webhook"
        ? { kind: "webhook", secret: prev?.trigger.kind === "webhook" ? prev.trigger.secret : make.secret() }
        : t.kind === "teammate"
          ? { kind: "teammate", mate: str(t.mate, 40), on: t.on === "task" ? "task" : "turn" }
          : t.kind === "board"
            ? { kind: "board", room: str(t.room, 40) || TEAM_ROOM }
            : { kind: "manual" };
  const rawSteps = Array.isArray(input.steps) ? input.steps : (prev?.steps ?? []);
  const seen = new Set<string>();
  const steps = packSteps(
    rawSteps.slice(0, MAX_STEPS).flatMap((x): WorkflowStep[] => {
      if (!x || typeof x !== "object") return [];
      const s = x as Record<string, unknown>;
      let id = str(s.id, 24).replace(/[^\w-]/g, "") || uid();
      while (seen.has(id)) id = uid();
      seen.add(id);
      const col = Number(s.col);
      const owns = Array.isArray(s.owns) ? [...new Set(s.owns.map((o) => str(o, 300)).filter(Boolean))].slice(0, 20) : [];
      const kind: StepKind = s.kind === "check" || s.kind === "approve" ? s.kind : "do";
      const tries = Number(s.tries);
      const gate = kind === "do" ? {} : { kind, ifNot: s.ifNot === "back" ? ("back" as const) : ("stop" as const), ...(str(s.back, 24) ? { back: str(s.back, 24) } : {}), ...(s.ifNot === "back" && str(s.fixBy, 40) ? { fixBy: str(s.fixBy, 40) } : {}), tries: Number.isFinite(tries) && tries >= 1 ? Math.min(MAX_TRIES, Math.round(tries)) : DEFAULT_TRIES };
      return [{ id, mate: kind === "approve" ? "" : str(s.mate, 40), does: str(s.does, 4000), owns: kind === "do" ? owns : [], col: Number.isFinite(col) && col >= 0 ? Math.floor(col) : 0, ...gate }];
    }),
  );
  const o = (input.outcomes ?? prev?.outcomes ?? BLANK_OUTCOMES) as Record<string, unknown>;
  const l = (input.limits ?? prev?.limits ?? BLANK_LIMITS) as Record<string, unknown>;
  const perDay = Number(l.perDay);
  return {
    name: str(input.name, 80) || prev?.name || "New workflow",
    on: typeof input.on === "boolean" ? input.on : (prev?.on ?? true),
    room: input.room === undefined ? (prev?.room ?? TEAM_ROOM) : str(input.room, 40) || TEAM_ROOM,
    trigger,
    steps,
    outcomes: { brief: o.brief !== false, notify: o.notify !== false, pr: o.pr === true, then: str(o.then, 40) },
    limits: { perDay: Number.isFinite(perDay) && perDay > 0 ? Math.min(48, Math.max(1, Math.round(perDay))) : BLANK_LIMITS.perDay, skipIfRunning: l.skipIfRunning !== false },
    ask: input.ask === undefined ? (prev?.ask ?? "") : str(input.ask, 200),
  };
}

/** A starting point: its steps by the kind of teammate each suits (matched to the team's by name and role), and its trigger. */
export interface WorkflowTemplate {
  id: string;
  name: string;
  blurb: string;
  trigger: WorkflowTrigger;
  /**
   * Each step: the kinds of teammate it suits, words to find one by in a name or role (LEAD for the lead; none for your OK), what
   * it does, its column; a check's or OK's kind, and the step it sends the work back to, by its place in this list.
   */
  steps: { suits: string[]; does: string; col: number; kind?: StepKind; back?: number; tries?: number }[];
  outcomes: Partial<WorkflowOutcomes>;
  ask?: string;
}

const weekdays = (at: string, days = [1, 2, 3, 4, 5]): WorkflowTrigger => ({ kind: "schedule", schedule: { every: "weekly", at, days, tz: "UTC" } });

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "changelog",
    name: "Weekly changelog",
    blurb: "A researcher reads the week's merges, a writer drafts the changelog, the lead reviews it and posts it.",
    trigger: weekdays("16:00", [5]),
    steps: [
      { suits: ["research", "analyst"], does: "Read what merged this week (git log, the merged pull requests) and list what changed for people using it, grouped as new, improved and fixed. Note each change's pull request.", col: 0 },
      { suits: ["writ", "copy", "doc"], does: "Write this week's changelog from the researcher's list: short entries a user understands, newest first, in CHANGELOG.md.", col: 1 },
      { suits: [LEAD], does: "Review the changelog for accuracy against the list and for tone. Fix what is off, then say it is ready to post.", col: 2 },
    ],
    outcomes: { brief: true, notify: true },
  },
  {
    id: "ship",
    name: "Ship a feature",
    blurb: "The lead plans it and you OK the plan, an engineer builds it, QA sends it back until the tests pass, then one pull request.",
    trigger: { kind: "manual" },
    ask: "What should it do?",
    steps: [
      { suits: [LEAD], does: "Plan the feature asked for: the files it touches, the approach, and how we'll know it works. Keep it short.", col: 0 },
      { suits: [], kind: "approve", does: "Is this the right plan?", col: 1, back: 0 },
      { suits: ["engineer", "develop", "build", "code"], does: "Build it as planned, with tests. Say what you changed and how you checked it.", col: 2 },
      { suits: ["qa", "test", "quality"], kind: "check", does: "The tests pass and the feature does what was asked.", col: 3, back: 2, tries: 3 },
    ],
    outcomes: { brief: true, notify: true, pr: true },
  },
  {
    id: "bugsweep",
    name: "Bug sweep",
    blurb: "QA finds what is broken, an engineer fixes it, QA sends it back until every fix holds, then one pull request.",
    trigger: weekdays("09:00"),
    steps: [
      { suits: ["qa", "test", "quality"], does: "Run the tests and try the main flows. List each bug you find: how to reproduce it, what you expected, what happened, and the file it is likely in.", col: 0 },
      { suits: ["engineer", "develop", "build", "code"], does: "Fix the bugs QA listed, one commit each, with a test for each where one fits. Say which you fixed and which you couldn't.", col: 1 },
      { suits: ["qa", "test", "quality"], kind: "check", does: "Every bug QA listed is fixed: each one reproduced again and gone, and the tests pass.", col: 2, back: 1, tries: 3 },
    ],
    outcomes: { brief: true, notify: true, pr: true },
  },
  {
    id: "launch",
    name: "Launch post",
    blurb: "A researcher gathers what shipped and why it matters, a writer drafts the post, a designer makes its images.",
    trigger: { kind: "manual" },
    ask: "What's launching?",
    steps: [
      { suits: ["research", "analyst"], does: "Gather what this launch ships, who it is for and why it matters: the changes, numbers worth quoting, and two or three comparable launches.", col: 0 },
      { suits: ["writ", "copy", "market"], does: "Draft the launch post from the research: a headline, a short opening, what's new, and a call to action. Save it as launch-post.md.", col: 1 },
      { suits: [], kind: "approve", does: "Is the post right? Say what to change if not.", col: 2, back: 1 },
      { suits: ["design", "visual", "brand"], does: "Make the post's images: a header image and one per feature, in the brand's style. Save them beside the post and name them in it.", col: 3 },
    ],
    outcomes: { brief: true, notify: true },
  },
  {
    id: "standup",
    name: "Morning standup digest",
    blurb: "Every teammate says what it did yesterday and what is next, side by side; the lead writes the digest.",
    trigger: weekdays("08:30"),
    steps: [
      { suits: ["*"], does: "Say in three lines what you did since yesterday's standup, what you're on next, and what blocks you.", col: 0 },
      { suits: [LEAD], does: "Write the standup digest from everyone's lines: done, next and blocked, per teammate, then the one thing the person should look at first.", col: 1 },
    ],
    outcomes: { brief: true, notify: true },
  },
];

/**
 * A template made a workflow for this team: each step given the teammate that suits it best (by name, then role), the lead where
 * it says, and "" where nobody does, for the person to pick; a step for everyone ("*") is one per teammate, side by side.
 */
export function fromTemplate(t: WorkflowTemplate, mates: readonly { id: string; name: string; role: string }[]): Pick<Workflow, "name" | "trigger" | "steps" | "outcomes" | "ask"> {
  const fit = (suits: string[]) => {
    const words = suits.map((s) => s.toLowerCase());
    return mates.find((m) => words.some((w) => m.name.toLowerCase().includes(w))) ?? mates.find((m) => words.some((w) => m.role.toLowerCase().includes(w)));
  };
  const ids = t.steps.map(() => uid());
  const steps = t.steps.flatMap((s, i): WorkflowStep[] => {
    if (s.suits[0] === "*") return (mates.length ? mates : [{ id: "" }]).map((m) => ({ id: uid(), mate: m.id, does: s.does, owns: [], col: s.col }));
    const gate = s.kind && s.kind !== "do" ? { kind: s.kind, ifNot: s.back === undefined ? ("stop" as const) : ("back" as const), ...(s.back === undefined ? {} : { back: ids[s.back]! }), tries: s.tries ?? DEFAULT_TRIES } : {};
    const mate = s.kind === "approve" ? "" : s.suits[0] === LEAD ? LEAD : (fit(s.suits)?.id ?? (s.kind === "check" ? LEAD : ""));
    return [{ id: ids[i]!, mate, does: s.does, owns: [], col: s.col, ...gate }];
  });
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  })();
  const trigger: WorkflowTrigger = t.trigger.kind === "schedule" ? { kind: "schedule", schedule: { ...t.trigger.schedule, tz } } : t.trigger;
  return { name: t.name, trigger, steps: packSteps(steps), outcomes: { ...BLANK_OUTCOMES, ...t.outcomes }, ask: t.ask ?? "" };
}

// ── drafted from a sentence ─────────────────────────────────────────

/**
 * A workflow drafted from what the person wrote (Arun, 2026-11-01: "very advanced but very easy to use"): their words and their
 * crew handed to a small model, which answers in the shape below; draftFromAnswer turns its answer into a workflow for the builder, never
 * saved until they save it. Teammates and rooms by name, steps by number, so the model never has to copy an id.
 */
export function draftPrompt(text: string, crew: { mates: readonly { name: string; role: string }[]; rooms: readonly { name: string }[] }): { system: string; prompt: string } {
  const system = [
    "You turn a person's description of an automation for their AI crew into one workflow, as JSON. Reply with the JSON object only.",
    "A workflow is a trigger, then numbered steps in columns (steps sharing a col run side by side; each col waits for the one before), then outcomes.",
    "Shape:",
    `{"name": "a short name",
 "trigger": {"kind": "manual"} | {"kind": "schedule", "every": "hourly" | "daily" | "weekly", "at": "HH:MM", "days": [0-6, Sunday is 0]} | {"kind": "webhook"} | {"kind": "teammate", "who": "<teammate name>", "on": "turn" | "task"} | {"kind": "board", "room": "<room name>" | "crew"},
 "room": "crew" | "<room name>",
 "ask": "the question Run now asks, when the work needs one from the person (\\"Which feature?\\"), else \\"\\"",
 "steps": [{"n": 1, "col": 0, "kind": "do" | "check" | "approve", "who": "<teammate name>" | "lead" | "", "does": "...", "ifNot": "stop" | "back", "back": <an earlier do step's n>, "tries": 1-5}],
 "outcomes": {"brief": true, "notify": true, "pr": false}}`,
    "Rules:",
    "- \"do\": a teammate does the work. Give it to the teammate whose role fits; \"lead\" for planning, reviewing or summing up.",
    "- \"check\": a teammate (QA or the lead) says PASS or FAIL on the work so far; \"does\" is what has to hold (\"the tests pass\"). For \"until it passes\" or \"keep fixing\", ifNot \"back\" to the step that fixes, tries 3. For \"only if\", ifNot \"stop\".",
    "- \"approve\": the person's OK (\"let me review\", \"ask me first\", \"I sign off\"); who is \"\"; \"does\" is the question. ifNot \"back\" when they would want changes made.",
    "- A check or approve is alone in its col. At most 8 steps. Each \"does\" is one to three plain, concrete sentences.",
    "- pr true only when the work changes code and should land as a pull request.",
    "- Schedule times in 24-hour HH:MM; weekdays are [1,2,3,4,5].",
  ].join("\n");
  const prompt = [
    `The crew: ${crew.mates.length ? crew.mates.map((m) => `${m.name} (${m.role.split("\n")[0]!.slice(0, 80) || "no role given"})`).join("; ") : "nobody yet"}.`,
    crew.rooms.length ? `Rooms besides the Crew room: ${crew.rooms.map((r) => r.name).join(", ")}.` : "",
    `What the person wants:\n${text.trim().slice(0, 2000)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, prompt };
}

/**
 * The model's answer as a workflow the page can open (cleanWorkflow still has the last word when it is saved), or null when it
 * isn't one. Names that aren't the crew's are left for the person to pick, never guessed.
 */
export function draftFromAnswer(answer: string, crew: { mates: readonly { id: string; name: string }[]; rooms: readonly { id: string; name: string }[] }, tz = "UTC"): Record<string, unknown> | null {
  const at = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (at < 0 || end <= at) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(answer.slice(at, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const low = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
  const mate = (who: unknown) => (low(who) === "lead" ? LEAD : (crew.mates.find((m) => m.name.toLowerCase() === low(who))?.id ?? ""));
  const room = (v: unknown) => (!low(v) || low(v) === "crew" || /crew room/.test(low(v)) ? TEAM_ROOM : (crew.rooms.find((r) => r.name.toLowerCase() === low(v))?.id ?? TEAM_ROOM));
  const t = (j.trigger ?? {}) as Record<string, unknown>;
  const every = t.every === "hourly" || t.every === "daily" ? t.every : "weekly";
  const days = Array.isArray(t.days) ? t.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
  const trigger =
    t.kind === "schedule"
      ? { kind: "schedule", schedule: { every, at: typeof t.at === "string" && /^\d{1,2}:\d{2}$/.test(t.at) ? t.at.padStart(5, "0") : "09:00", days: every === "weekly" ? (days.length ? [...new Set(days)].sort() : [1, 2, 3, 4, 5]) : [], tz } }
      : t.kind === "webhook"
        ? { kind: "webhook" }
        : t.kind === "teammate"
          ? { kind: "teammate", mate: mate(t.who), on: t.on === "task" ? "task" : "turn" }
          : t.kind === "board"
            ? { kind: "board", room: room(t.room) }
            : { kind: "manual" };
  const raw = (Array.isArray(j.steps) ? j.steps : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object").slice(0, MAX_STEPS);
  const idOf = new Map(raw.map((s, i) => [Number(s.n) || i + 1, `d${i + 1}`]));
  const steps = raw.map((s, i) => {
    const kind = s.kind === "check" || s.kind === "approve" ? s.kind : "do";
    const back = idOf.get(Number(s.back));
    return {
      id: `d${i + 1}`,
      kind,
      mate: kind === "approve" ? "" : mate(s.who) || (kind === "check" ? LEAD : ""),
      does: typeof s.does === "string" ? s.does : "",
      owns: [],
      col: Number.isFinite(Number(s.col)) ? Number(s.col) : i,
      ...(kind === "do" ? {} : { ifNot: s.ifNot === "back" && back ? "back" : "stop", ...(s.ifNot === "back" && back ? { back } : {}), tries: Number(s.tries) || DEFAULT_TRIES }),
    };
  });
  if (!steps.length) return null;
  const o = (j.outcomes ?? {}) as Record<string, unknown>;
  return {
    name: typeof j.name === "string" ? j.name : "",
    room: room(j.room),
    trigger,
    steps,
    ask: typeof j.ask === "string" ? j.ask : "",
    outcomes: { brief: o.brief !== false, notify: o.notify !== false, pr: o.pr === true, then: "" },
  };
}

// ── a run as its room shows it ──────────────────────────────────────

/**
 * A run as its room shows it, one card (Arun, 2026-11-01, the Crew room concept: "Crew room run card"): every step of the
 * workflow in order, each with who, where it stands and what it came to in a line, the check's answer, your OK; sent with the
 * team (GET /api/teammates `flowRuns`) so the room draws it where its first board was posted (`seq0`).
 */
export interface RoomRunStep {
  step: string;
  n: number;
  kind: StepKind;
  /** Who does it: a teammate's name, "the lead", or "You" for your OK. */
  name: string;
  lane: string;
  /** "pending": its stage hasn't been posted yet. */
  status: BoardStatus | "pending";
  title: string;
  /** What it came to, in a line (reportLine). */
  said?: string;
  verdict?: { pass: boolean; why: string };
  again?: number;
}

export interface RoomRun {
  id: string;
  name: string;
  run: string;
  sid: string;
  seq0: number;
  status: WorkflowRunStatus;
  at: number;
  ended?: number;
  note?: string;
  trigger: string;
  steps: RoomRunStep[];
  asking?: { step: string; ask: string; ifNot: "stop" | "back"; backTo?: number };
  result?: string;
}

/**
 * A step's report in a line: the "Result:" a board report carries (agent-mesh's Status / Result / Evidence / Unblock form), or
 * its first sentence; a check's PASS or FAIL line and Friday's notes left out.
 */
export function reportLine(report: string, max = 160): string {
  const text = report.replace(/\r/g, "").split(/\n\n(?=\[Friday\])/)[0]!;
  const result = text.match(/^\s*\**Result\**:\s*(.+)$/im)?.[1];
  const plain = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^\**(Status|Evidence|Unblock|Result)\**:/i.test(l) && !/^(PASS|FAIL)\b/i.test(l) && !/^#+\s/.test(l))
    .join(" ");
  const said = (result ?? plain).replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  // "Done: I added…" says it twice beside a tick: the rest, when there is a rest.
  const line = said.replace(/^(Done|Finished|Completed)\s*[:.\u2014-]\s*/i, "") || said;
  const first = line.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? line;
  const pick = first.length >= 24 || first === line ? first : line;
  return pick.length > max ? `${pick.slice(0, max - 1).trimEnd()}…` : pick;
}

/** The room's view of a run: every step of `w` in order, as the run has it or still to come. */
export function roomRunOf(w: Pick<Workflow, "id" | "name" | "steps">, run: WorkflowRun, nameOf: (mate: string) => string): RoomRun | null {
  const seq0 = run.seq0 ?? run.seq;
  if (!run.sid || !seq0) return null;
  const order = packSteps(w.steps);
  const steps = order.map((s, i): RoomRunStep => {
    const r = run.steps.find((x) => x.step === s.id);
    const kind = kindOf(s);
    const title = kind === "approve" ? s.does.trim().split("\n")[0]!.slice(0, 120) || "OK to go on?" : stepTitle(s, i + 1);
    return {
      step: s.id,
      n: i + 1,
      kind,
      name: kind === "approve" ? "You" : (r?.name ?? nameOf(s.mate)),
      lane: r?.lane ?? "",
      status: r?.status ?? "pending",
      title,
      ...(r?.report && kind !== "approve" ? { said: kind === "check" && r.verdict ? r.verdict.why || reportLine(r.report) : reportLine(r.report) } : {}),
      ...(r?.verdict ? { verdict: r.verdict } : {}),
      ...(r?.again ? { again: r.again } : {}),
    };
  });
  const gate = run.asking ? order.find((s) => s.id === run.asking!.step) : undefined;
  return {
    id: w.id,
    name: w.name,
    run: run.id,
    sid: run.sid,
    seq0,
    status: run.status,
    at: run.at,
    ...(run.ended ? { ended: run.ended } : {}),
    ...(run.note ? { note: run.note } : {}),
    trigger: run.trigger,
    steps,
    ...(run.asking ? { asking: { step: run.asking.step, ask: run.asking.ask, ifNot: gate?.ifNot === "back" ? ("back" as const) : ("stop" as const), ...(gate?.ifNot === "back" && gate.back ? { backTo: order.findIndex((s) => s.id === gate.back) + 1 } : {}) } } : {}),
    ...(run.result ? { result: run.result.slice(0, 4000) } : {}),
  };
}
