import { MAIN_LANE, type EngineMode } from "../types.js";
import { runOf, type SessionState } from "../session/projection.js";

/**
 * What an agent may do in your folder, chosen for each piece of work instead of once for the whole session.
 *
 * Plan, Manual and Auto are about reach, and the right one changes with what is asked. A question, an explanation or a
 * review needs nothing but reading, so it goes in Plan and the folder can't change under it. A change goes in Manual,
 * which asks before it runs a command. Running the tests, fixing a failing build or installing packages is commands from
 * the first step, so it goes in Auto rather than stopping to ask about each one. A folder another agent is already editing
 * takes only a reader. Anything that doesn't read clearly as one of these stays as it is: a confident guess is worse than none.
 *
 * Always on, with nothing to set: the mode pill shows where it is. A switch made here is for the host's own piece of work
 * only: the runner is told the mode picked by hand (`handMode`), anyone else's turn on the lane is held to it, and the lane
 * goes back to it once that run ends (revertTo). Only on the computer the agent runs on, the only place a mode can be changed.
 */

export interface Reach {
  mode: EngineMode;
  /** Why, in a few words, for the note that says it switched. */
  why: string;
}

export const REACH_NAME: Record<EngineMode, string> = { plan: "Plan", edits: "Manual", full: "Auto" };

// Asked not to change anything: the plainest signal there is, and it wins over everything else.
const HANDS_OFF = /\b(don'?t|do not|without)\s+(chang|edit|touch|modify|writ|commit)|\bno (changes|edits)\b|\bread[- ]only\b|\bjust (tell|explain|show|look|describe)\b/;
// A polite request is still a request: "can you fix…" is an instruction, not a question.
const POLITE = /^(please\s+|(can|could|would|will) you\s+(please\s+)?|i('d| would) like you to\s+|i want you to\s+|let'?s\s+)/;
const ASKS = /^(what|what'?s|whats|why|how|where|when|which|who|whose|is|are|was|were|does|do|did|should|has|have|any idea)\b/;
// Reading as the whole job, said first.
const READS = /^(explain|describe|summari[sz]e|walk me through|tell me|show me|help me understand|give me an? (overview|summary)|review|audit|look (at|over|into|through)|read( through)?|compare|plan|outline|propose|suggest|brainstorm|investigate|diagnose|figure out|find out|understand|check (whether|if)|research|evaluate|assess)\b/;
// Commands from the first step: checks to run, packages to install.
const RUNS = new RegExp(
  [
    String.raw`\b(run|re-?run|execute)\b[^.?!]{0,40}\b(tests?|specs?|suite|build|lint|linter|typecheck|type-check|tsc|checks?|benchmarks?|migrations?|scripts?)\b`,
    String.raw`\b(make|get)\b[^.?!]{0,30}\b(tests?|build|ci|checks?)\b[^.?!]{0,15}\b(pass|passing|green|work)`,
    String.raw`\bfix\b[^.?!]{0,30}\b(failing|broken|red)\b[^.?!]{0,20}\b(tests?|build|ci|checks?)`,
    String.raw`\bfix\b[^.?!]{0,20}\b(the )?(tests?|build|ci|lint|type errors?)\b`,
    String.raw`\b(npm|pnpm|yarn|bun|npx|cargo|pytest|go test|pip|poetry|gradle|mvn)\s+\w`,
    String.raw`\binstall\b[^.?!]{0,30}\b(deps|dependencies|packages?|modules?)\b`,
    String.raw`\b(bump|upgrade|update)\b[^.?!]{0,30}\b(deps|dependencies|packages?)\b`,
  ].join("|"),
);
const CHANGES = /\b(fix|add|implement|build|create|write|change|update|edit|refactor|rename|remove|delete|drop|move|migrate|replace|rewrite|clean ?up|make|convert|port|wire|hook up|set ?up|support|introduce|extract|split|merge|redesign|restyle|style|tweak|adjust|improve|optimi[sz]e|bump|upgrade|commit|apply|do it|go ahead)\b/;
// A question that ends in an instruction: "what's wrong with the login? fix it".
const THEN_DO = /\b(and|then)\s+(please\s+)?(fix|change|implement|update|add|make|do|apply|write|refactor|remove)\b/;

/** What a message to an agent calls for, or null when it doesn't say clearly enough to switch on. */
export function reachForMessage(text: string): Reach | null {
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!t || t.startsWith("/")) return null;
  if (HANDS_OFF.test(t)) return { mode: "plan", why: "you asked for no changes" };
  const polite = POLITE.test(t);
  const bare = t.replace(POLITE, "");
  const question = !polite && (ASKS.test(bare) || /\?\s*$/.test(bare));
  // A question that goes on to ask for the fix is a change: "why does it crash? fix it", "what's wrong and then fix it".
  const tail = bare.includes("?") ? bare.slice(bare.indexOf("?") + 1) : "";
  if (question && !THEN_DO.test(bare) && !CHANGES.test(tail)) return { mode: "plan", why: "it's a question" };
  if (RUNS.test(bare)) return { mode: "full", why: "it runs commands from the start" };
  if (READS.test(bare) && !THEN_DO.test(bare)) return { mode: "plan", why: "it only needs to read" };
  if (CHANGES.test(bare)) return { mode: "edits", why: "it changes files" };
  return null;
}

/** What the run that handed over left, in the terms handoff-ui's Signals uses. */
export interface HandoffSignals {
  changed: string[];
  tests: "pass" | "fail" | null;
  limited?: boolean;
}

/** What the agent taking a handoff should be able to do, from what was left for it and what it is for. */
export function reachForHandoff(s: HandoffSignals, profile: string, fromMode?: EngineMode): Reach | null {
  const p = profile.toLowerCase();
  // Out of usage partway through: the same job, carried on the same terms.
  if (s.limited && fromMode) return { mode: fromMode, why: "it carries on the same work" };
  if (/\b(review|reviewer|audit|security|read a diff)/.test(p)) return { mode: "plan", why: "it reads the changes" };
  if (s.tests === "fail") return { mode: "full", why: "a test is failing, and it reruns them" };
  if (s.changed.length && s.tests === null && /\b(tests?|qa|regression)\b/.test(p)) return { mode: "full", why: "it writes and runs the tests" };
  if (/\b(docs?|readme|changelog|writer|documentation)\b/.test(p)) return { mode: "edits", why: "it edits the docs" };
  return null;
}

const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();

/** Who else is editing this lane's folder, by name, if anyone: a second writer is refused there, so only Plan can join it. */
export function folderHeldBy(state: SessionState, lane: string): string | null {
  const mine = state.engines[lane];
  // A folder shared by choice holds nobody back, as the hub has it (EngineHub.attach, EngineInfo.shared): a lane that shares it
  // isn't held, and a lane beside it that shares it isn't holding. Agents that share one folder by design had every message
  // dropped into Plan (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors and fixes").
  if (!mine?.cwd || mine.shared) return null;
  const other = Object.entries(state.engines).find(([id, e]) => id !== lane && e.online && e.mode !== "plan" && !e.shared && norm(e.cwd) === norm(mine.cwd));
  return other ? `${other[1].hostName.split(" ")[0]}'s ${other[0] === MAIN_LANE ? "main agent" : "agent"}` : null;
}

/**
 * No switch from Auto down to Manual just because a message asks for a change: Auto is what every agent starts in (Arun,
 * 2026-10-18), and a change is what Auto is for. Plan, for a question or "don't change anything", still applies.
 */
export function keepAuto(want: Reach | null, hand: EngineMode | undefined): Reach | null {
  return want?.mode === "edits" && (hand ?? "full") === "full" ? null : want;
}

/** The reach to switch to, once a folder somebody else is editing is taken into account. */
export function settle(state: SessionState, lane: string, want: Reach | null): Reach | null {
  want = keepAuto(want, state.engines[lane]?.handMode ?? state.engines[lane]?.mode);
  if (!want || want.mode === "plan") return want;
  const holder = folderHeldBy(state, lane);
  return holder ? { mode: "plan", why: `${holder} is editing this folder` } : want;
}

/**
 * The reach for a message, worked out from the mode picked by hand each time, never from where an earlier switch left it
 * (Arun, 2026-10-19: "switching from auto to plan and then staying on plan"). A question still reads in Plan; the next
 * message that asks for a change goes back to the mode picked by hand (Auto covers a change, and Manual is a change's own
 * mode), and one that says nothing clear goes back too, rather than inheriting the question's Plan. A folder somebody else is
 * editing still takes only a reader.
 */
export function reachFor(state: SessionState, lane: string, text: string): Reach | null {
  const e = state.engines[lane];
  if (!e) return null;
  const r = reachFrom(state, lane, e, text);
  // Already where it should be: nothing to switch.
  return r && r.mode !== modeOf(e) ? r : null;
}

/**
 * The mode a lane runs in: Auto when its record doesn't say, as the mode pill shows it. A lane with no mode on record showed
 * "Auto" and was then switched to Manual by the first message that asked for a change (QA, 2026-10-28: "The mode pill showed
 * Auto before the send, and the agent then ran in Manual"; Arun: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
 */
export const modeOf = (e: { mode?: EngineMode | undefined }): EngineMode => e.mode ?? "full";

function reachFrom(state: SessionState, lane: string, e: { mode: EngineMode; handMode?: EngineMode }, text: string): Reach | null {
  const hand = e.handMode ?? modeOf(e);
  const back: Reach = { mode: hand, why: `back to ${REACH_NAME[hand]}, the mode you picked` };
  let want = reachForMessage(text);
  // A change in Auto is Auto's to do; in Plan picked by hand it is still the person's call, so it stays a reader.
  if (want?.mode === "edits") want = hand === "full" ? back : hand === "plan" ? null : want;
  if (!want) return modeOf(e) === hand ? null : back;
  if (want.mode === "plan") return want;
  const holder = folderHeldBy(state, lane);
  return holder ? { mode: "plan", why: `${holder} is editing this folder` } : want;
}

/**
 * The mode picked by hand to go back to, once the run an automatic switch was made for has ended (stopped with an error
 * too), or null. A run that began after the switch and is over: one paused or waiting on a person keeps it until it ends.
 */
export function revertTo(state: SessionState, lane: string): EngineMode | null {
  const e = state.engines[lane];
  if (!e?.online || !e.handMode || e.handMode === e.mode) return null;
  const run = runOf(state, lane);
  return run.sinceSeq > e.sinceSeq && (run.status === "idle" || run.status === "error") ? e.handMode : null;
}
