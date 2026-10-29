import type { ReactNode } from "react";
import { engineName, ENGINE_TOOLS, MAIN_LANE, TOOL_INFO, type EngineTool } from "../types.js";
import { runOf, type SessionState } from "../session/projection.js";
import { EngineMark } from "./AgentSwitch.js";
import { AgentMark, Icon, type IconName } from "./icons.js";
import { teammateMark } from "./Teammates.js";

/**
 * What each kind of agent looks like, and who to offer work to.
 *
 * An agent was a name in a chip and the same little bot for all of them. Each kind now has its own face, used the same
 * way everywhere an agent shows up in a handoff: a CLI wears its maker's mark and colour, a saved agent wears its own
 * icon on its own colour, and Friday Code is Friday's. Seeing "Claude Code → Reviewer" is then a thing you can read
 * at a glance rather than two grey words.
 */

export type Kind = EngineTool | "friday" | "agent";

export interface Look {
  kind: Kind;
  mark: ReactNode;
  /** A colour to tint its chip and mark with. */
  tint: string;
  /** What it is, in a word: the tool, or "saved agent". */
  label: string;
}

const AGENT_TINT: Record<string, string> = { indigo: "#7c5cff", green: "#4fd1a1", violet: "#a898ff", amber: "#f2b453", pink: "#f472b6", teal: "#2dd4bf", red: "#ff7b72", blue: "#60a5fa" };
// Friday Code takes the text colour, so its mark is as dark as the page is light, and the reverse.
const FRIDAY_TINT = "var(--ink)";

export const tintOfColor = (color: string): string => AGENT_TINT[color] ?? AGENT_TINT.indigo!;
export const tintOfEngine = (tool: EngineTool): string => TOOL_INFO[tool].tint;

/** The lane's name as the session shows it: the same rule the server names a handoff's two ends by. */
function baseLabel(state: SessionState, id: string): string {
  if (id === MAIN_LANE) return state.mainName ?? state.options.agent?.name ?? (state.engines[MAIN_LANE]?.tool ? engineName(state.engines[MAIN_LANE]!.tool!) : "Main");
  const l = state.lanes.find((x) => x.id === id);
  const e = state.engines[id];
  return l?.name ?? (e?.tool ? engineName(e.tool) : id);
}

/** An agent's name; two of the same tool are "Claude Code" and "Claude Code 2", so a tab, a speaker line or a handoff can tell them apart. */
/**
 * What a hand-off's card shows as its task: the task itself, not the brief Friday wrapped it in for the agent taking it ("Carry
 * on with this task, which … Don't start over: what it already did is in the record…\n\nThe task:\n…"), which read as internal
 * prompt text under a "the task" label that "The task:" then said again (Arun, 2026-10-28: "iron everything and ensure we are
 * good… any logic errors and fixes"). A task a person wrote is shown as they wrote it.
 */
export function handoffTaskText(text: string): string {
  const task = /\n\s*The task:\s*\n([\s\S]+)$/.exec(text)?.[1]?.trim();
  return task || text;
}

export function laneLabel(state: SessionState, id: string): string {
  const base = baseLabel(state, id);
  const same = [MAIN_LANE, ...state.lanes.map((l) => l.id)].filter((x) => baseLabel(state, x) === base);
  const at = same.indexOf(id);
  return at > 0 ? `${base} ${at + 1}` : base;
}

/** A handoff records its two ends by name; this finds the lane a name belongs to, if it still exists. */
export function laneIdByName(state: SessionState, name: string): string | null {
  const want = name.trim().toLowerCase();
  for (const id of [MAIN_LANE, ...state.lanes.map((l) => l.id)]) if (laneLabel(state, id).toLowerCase() === want) return id;
  return null;
}

export function agentLook(state: SessionState, lane: string | null, size = 14): Look {
  if (lane === null) return { kind: "agent", mark: <Icon name="agent" size={size} />, tint: AGENT_TINT.indigo!, label: "agent" };
  // A teammate wears its face (Teammates.tsx) wherever an agent's mark shows.
  const mate = state.options.team ? teammateMark(lane, size) : null;
  if (mate) return mate.tool === "friday" ? { kind: "friday", mark: mate.mark, tint: FRIDAY_TINT, label: "Friday Code" } : { kind: mate.tool, mark: mate.mark, tint: TOOL_INFO[mate.tool].tint, label: engineName(mate.tool) };
  const engine = state.engines[lane];
  if (engine?.tool) return { kind: engine.tool, mark: <EngineMark tool={engine.tool} size={size} />, tint: TOOL_INFO[engine.tool].tint, label: engineName(engine.tool) };
  const def = lane === MAIN_LANE ? null : state.lanes.find((l) => l.id === lane);
  const agent = lane === MAIN_LANE ? state.options.agent : def?.agent;
  // A lane named for a coding tool that has not connected yet (or has disconnected) is still that tool: it wears its mark.
  const named = !agent && def ? ENGINE_TOOLS.find((t) => def.name.toLowerCase().includes(t)) : undefined;
  if (named) return { kind: named, mark: <EngineMark tool={named} size={size} />, tint: TOOL_INFO[named].tint, label: engineName(named) };
  if (agent) return { kind: "agent", mark: <Icon name={(agent.icon as IconName | undefined) ?? "agent"} size={size} />, tint: AGENT_TINT[agent.color] ?? AGENT_TINT.indigo!, label: "saved agent" };
  return { kind: "friday", mark: <AgentMark size={size} />, tint: FRIDAY_TINT, label: "Friday Code" };
}

/** What the run that just finished left behind, in the terms a choice of next agent turns on. */
export interface Signals {
  changed: string[];
  tests: "pass" | "fail" | null;
  failing: number;
  /** It stopped on its coding tool's usage limit: somebody on another account is who can carry on now. */
  limited?: boolean;
}

export interface Suggestion {
  id: string;
  why: string;
}

const has = (text: string, re: RegExp) => re.test(text.toLowerCase());

/** Does this lane wake by itself when `from` finishes? Then handing off to it is already happening. */
export function wakesOnItsOwn(state: SessionState, lane: string, from: string): boolean {
  const t = state.lanes.find((l) => l.id === lane)?.trigger;
  return !!t && t.kind === "lane-finished" && (!t.laneId || t.laneId === from);
}

/**
 * Who this work is for, if it is clear.
 *
 * Read from what the agents are for and what the run left: changed code wants a reader, changed code nobody has run
 * wants tests, a failing test wants somebody to fix it, a changed doc wants whoever keeps the docs. A busy agent
 * is a worse choice than a free one, and an agent that will wake up on its own is not offered at all, because it
 * already is the next step. Returns nothing when nothing stands out, which is better than a confident guess.
 */
export function suggestTarget(state: SessionState, from: string, candidates: string[], s: Signals): Suggestion | null {
  let best: (Suggestion & { score: number }) | null = null;
  const docs = s.changed.filter((p) => /\.(md|mdx|txt|rst)$/i.test(p) || /(^|\/)docs?\//i.test(p));
  for (const id of candidates) {
    if (wakesOnItsOwn(state, id, from)) continue;
    // A coding agent that is offline can't take anything until it is back: never the one to suggest.
    if (state.engines[id]?.tool && !state.engines[id]!.online) continue;
    const def = id === MAIN_LANE ? null : state.lanes.find((l) => l.id === id);
    const agent = id === MAIN_LANE ? state.options.agent : def?.agent;
    const profile = `${laneLabel(state, id)} ${agent?.instructions ?? ""}`;
    let score = 0;
    let why = "";
    const fromTool = state.engines[from];
    const tool = state.engines[id];
    // Out of usage: anyone not on the same account can carry on, and that matters more than what the run left. The same tool
    // on the same computer is the same sign-in, so out too; Friday Code, or a teammate's, isn't.
    if (s.limited && !(tool?.tool && tool.tool === fromTool?.tool && tool.hostId === fromTool?.hostId))
      [score, why] = [6, `${fromTool?.tool ? engineName(fromTool.tool) : laneLabel(state, from)} is out of usage; this one isn't`];
    else if (s.tests === "fail" && has(profile, /\b(fix|debug|root cause|diagnos|repair)/)) [score, why] = [5, "A test is failing, and this one fixes things"];
    else if (s.tests === "fail" && has(profile, /\btest/)) [score, why] = [4, "A test is failing"];
    else if (s.changed.length && s.tests === null && has(profile, /\b(tests?|qa|regression)\b/)) [score, why] = [4, `${s.changed.length} file${s.changed.length === 1 ? "" : "s"} changed and nothing has run them`];
    else if (s.changed.length && has(profile, /\b(review|reviewer|audit|security|read a diff)/)) [score, why] = [3, `Reads changes: ${s.changed.length} file${s.changed.length === 1 ? "" : "s"} changed`];
    else if (docs.length && has(profile, /\b(docs?|readme|changelog|writer|documentation)\b/)) [score, why] = [3, `${docs.length} doc${docs.length === 1 ? "" : "s"} changed`];
    else if (s.tests === "pass" && s.changed.length && has(profile, /\b(release|ship|deploy|captain)\b/)) [score, why] = [3, "Tests pass, so it is ready to ship"];
    if (!score) continue;
    if (runOf(state, id).status === "running") score -= 2;
    if (!best || score > best.score) best = { id, why, score };
  }
  return best && best.score >= 3 ? { id: best.id, why: best.why } : null;
}

/** The reason line, written for who is taking it. */
export function reasonFor(fromName: string, toName: string, s: Signals, why?: string): string {
  if (s.limited) return `${fromName} ran out of usage partway through${s.changed.length ? `, after changing ${s.changed.length} file${s.changed.length === 1 ? "" : "s"}` : ""}. ${toName} picks it up from where it stopped.`;
  const did = `${fromName} finished its part${s.changed.length ? ` and changed ${s.changed.length} file${s.changed.length === 1 ? "" : "s"}` : ""}`;
  if (s.tests === "fail") return `${did}, but a test is still failing. ${toName} takes it from here.`;
  if (why && /reads changes/i.test(why)) return `${did}. ${toName} reads the changes before they go any further.`;
  if (why && /nothing has run/i.test(why)) return `${did}, and nothing has run them yet. ${toName} writes and runs the tests.`;
  if (why && /doc/i.test(why)) return `${did}. ${toName} brings the docs in line.`;
  return `${did}. ${toName} takes it from here.`;
}
