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

export interface WorkflowStep {
  id: string;
  /** A teammate's id, or LEAD. Empty until one is picked. */
  mate: string;
  /** What it does: its instructions. */
  does: string;
  /** Files or folders it owns: no other step edits them. */
  owns: string[];
  /** Its column: 0 runs first; one column waits on the one before it; steps in one column run side by side. */
  col: number;
}

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
  created: number;
  updated: number;
}

export type WorkflowRunStatus = "running" | "waiting" | "done" | "failed" | "skipped";

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
  ended?: number;
  /** What it came to: the last column's reports, for the brief and for the workflow it hands on to. */
  result?: string;
  /** How many workflows handed on to reach this one (MAX_CHAIN). */
  depth?: number;
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

/** The steps by column, in order, each column's in its order, with the columns numbered 0, 1, 2… with none empty. */
export function columnsOf(steps: readonly WorkflowStep[]): WorkflowStep[][] {
  const cols = [...new Set(steps.map((s) => s.col))].sort((a, b) => a - b);
  return cols.map((c) => steps.filter((s) => s.col === c));
}

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
 * The board a run posts: a task per step, each waiting on every step in the column before it, each for its teammate by name
 * (`next`: it goes to them whatever they are doing, the lead included). The first column is told what started the run; the
 * board hands every later step the reports of those it waited on (agent-mesh.ts taskBrief).
 */
export function workflowTasks(w: Pick<Workflow, "name" | "steps" | "outcomes">, nameOf: (mate: string) => string, input = ""): PostedTask[] {
  const cols = columnsOf(w.steps);
  const total = w.steps.length;
  let n = 0;
  const ids = cols.map((col) => col.map(() => `s${++n}`));
  return cols.flatMap((col, c) =>
    col.map((s, i) => {
      const id = ids[c]![i]!;
      const num = Number(id.slice(1));
      const later = c < cols.length - 1;
      const detail = [
        `[Workflow "${w.name}", step ${num} of ${total}] ${s.does.trim() || "Do your part of this workflow."}`,
        c === 0 && input.trim() ? `What started this run:\n${input.trim().slice(0, 4000)}` : "",
        col.length > 1 ? `Running alongside this step: ${col.filter((x) => x !== s).map((x) => nameOf(x.mate)).join(", ")}.` : "",
        later ? "End with a short report of what you made or found: it is handed to the next step." : "End with a short report of what you made or found: it is what this run comes to.",
        "Do this step yourself; don't post a new board (it would replace this workflow's).",
      ]
        .filter(Boolean)
        .join("\n\n");
      return { id, title: stepTitle(s, num), detail, owns: s.owns.slice(0, 20), after: c > 0 ? ids[c - 1]! : [], next: nameOf(s.mate) };
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
    if (!s.mate) out.push({ level: "fix", text: `Pick a teammate for step ${n}`, on: s.id });
    else if (s.mate !== LEAD) {
      const m = team.mates.find((x) => x.id === s.mate);
      if (!m) out.push({ level: "fix", text: `Step ${n}'s teammate isn't in the crew any more`, on: s.id });
      else if (room && !room.members.includes(m.id)) out.push({ level: "fix", text: `${m.name} isn't in ${room.name}: add them to the room, or pick someone there for step ${n}`, on: s.id });
    }
    if (!s.does.trim()) out.push({ level: "fix", text: `Say what step ${n} does`, on: s.id });
  });
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
      return [{ id, mate: str(s.mate, 40), does: str(s.does, 4000), owns, col: Number.isFinite(col) && col >= 0 ? Math.floor(col) : 0 }];
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
  };
}

/** A starting point: its steps by the kind of teammate each suits (matched to the team's by name and role), and its trigger. */
export interface WorkflowTemplate {
  id: string;
  name: string;
  blurb: string;
  trigger: WorkflowTrigger;
  /** Each step: the kinds of teammate it suits, words to find one by in a name or role (LEAD for the lead), what it does, its column. */
  steps: { suits: string[]; does: string; col: number }[];
  outcomes: Partial<WorkflowOutcomes>;
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
    id: "bugsweep",
    name: "Bug sweep",
    blurb: "QA finds what is broken, an engineer fixes it, QA checks the fixes, and the lead opens one pull request.",
    trigger: weekdays("09:00"),
    steps: [
      { suits: ["qa", "test", "quality"], does: "Run the tests and try the main flows. List each bug you find: how to reproduce it, what you expected, what happened, and the file it is likely in.", col: 0 },
      { suits: ["engineer", "develop", "build", "code"], does: "Fix the bugs QA listed, one commit each, with a test for each where one fits. Say which you fixed and which you couldn't.", col: 1 },
      { suits: ["qa", "test", "quality"], does: "Check each fix: reproduce the bug again and run the tests. Say which are fixed and which aren't.", col: 2 },
    ],
    outcomes: { brief: true, notify: true, pr: true },
  },
  {
    id: "launch",
    name: "Launch post",
    blurb: "A researcher gathers what shipped and why it matters, a writer drafts the post, a designer makes its images.",
    trigger: { kind: "manual" },
    steps: [
      { suits: ["research", "analyst"], does: "Gather what this launch ships, who it is for and why it matters: the changes, numbers worth quoting, and two or three comparable launches.", col: 0 },
      { suits: ["writ", "copy", "market"], does: "Draft the launch post from the research: a headline, a short opening, what's new, and a call to action. Save it as launch-post.md.", col: 1 },
      { suits: ["design", "visual", "brand"], does: "Make the post's images: a header image and one per feature, in the brand's style. Save them beside the post and name them in it.", col: 2 },
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
export function fromTemplate(t: WorkflowTemplate, mates: readonly { id: string; name: string; role: string }[]): Pick<Workflow, "name" | "trigger" | "steps" | "outcomes"> {
  const fit = (suits: string[]) => {
    const words = suits.map((s) => s.toLowerCase());
    return mates.find((m) => words.some((w) => m.name.toLowerCase().includes(w))) ?? mates.find((m) => words.some((w) => m.role.toLowerCase().includes(w)));
  };
  const steps = t.steps.flatMap((s): WorkflowStep[] => {
    if (s.suits[0] === "*") return (mates.length ? mates : [{ id: "" }]).map((m) => ({ id: uid(), mate: m.id, does: s.does, owns: [], col: s.col }));
    return [{ id: uid(), mate: s.suits[0] === LEAD ? LEAD : (fit(s.suits)?.id ?? ""), does: s.does, owns: [], col: s.col }];
  });
  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  })();
  const trigger: WorkflowTrigger = t.trigger.kind === "schedule" ? { kind: "schedule", schedule: { ...t.trigger.schedule, tz } } : t.trigger;
  return { name: t.name, trigger, steps: packSteps(steps), outcomes: { ...BLANK_OUTCOMES, ...t.outcomes } };
}
