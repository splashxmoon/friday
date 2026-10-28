import { engineName, MAIN_LANE, type EngineInfo, type SessionEvent } from "./types.js";

/**
 * A coding tool on its host's own plan does its host's work alone (Arun, 2026-10-27: "i do not want my account banned or
 * whatever for other people too").
 *
 * Anthropic's terms keep a personal Claude plan (Free, Pro, Max) to its owner: a product may not "route requests through Free,
 * Pro, or Max plan credentials on behalf of their users", and the plans' limits "assume ordinary, individual usage"
 * (code.claude.com/docs/en/legal-and-compliance, read 2026-10-27). OpenAI's say the same of a ChatGPT plan, and every other
 * tool's personal plan is held to it too. So in a session several people share, the Claude Code on Arun's computer, signed in
 * as Arun, runs Arun's work and nobody else's: a teammate's message to it is refused, with the way to get it done (a
 * suggestion Arun can send on, or their own coding tool). Every way a turn reaches a tool is checked at the one place a turn is
 * handed over (EngineHub.drain), whatever started it: a person, another agent, a hand-off, the board, Friday itself.
 *
 * A tool on an API key or a cloud provider (EngineInfo.apiKey, runner/api-key.ts) is its host's to share with the people
 * they work with, which the same terms allow; Friday's own agent spends the workspace's credit, not a person's plan.
 */

/** Whether `e` runs on its host's own plan, so takes its host's work alone. */
export const ownPlan = (e: EngineInfo | undefined | null): e is EngineInfo => !!e?.tool && !e.apiKey;

type Ev = Pick<SessionEvent, "seq" | "actor" | "body" | "lane">;
const laneOf = (e: Ev) => e.lane ?? MAIN_LANE;

/**
 * Whose work an instruction is: the person it is done for, followed back through the agents and hand-offs that carried it.
 * A person's own message is theirs; another agent's carries who that agent was working for (MeshNote.by, PeerNote.by); a
 * hand-off, Friday's own nudges (keep going, a goal, a review's findings, a wake) and an approval go on with whatever the lane
 * they came from, or this one, was doing for somebody. Null when no person is behind it at all.
 */
export function whoseWork(events: readonly Ev[], ev: Ev, depth = 0): string | null {
  const b = ev.body;
  if (b.type !== "instruction" || depth > 8) return null;
  if (b.peer) return b.peer.by.id;
  if (b.mesh) return b.mesh.by?.id ?? taskOwner(events, b.mesh.fromLane, ev.seq, depth + 1);
  if (b.handoff) return taskOwner(events, b.handoff.fromLane, ev.seq, depth + 1);
  if (ev.actor.kind === "human") return ev.actor.id;
  return taskOwner(events, laneOf(ev), ev.seq, depth + 1);
}

/** Who `lane` was last working for before `before`: the person behind its latest instruction that has one. */
export function taskOwner(events: readonly Ev[], lane: string, before: number, depth = 0): string | null {
  if (depth > 8) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.seq >= before || laneOf(e) !== lane || e.body.type !== "instruction" || e.body.approval) continue;
    const who = whoseWork(events, e, depth);
    if (who) return who;
  }
  return null;
}

/** Why `e` won't take this work, said to the room; null when it may (its host's work, nobody's, or a tool on a key). */
export function refusal(e: EngineInfo | undefined | null, who: string | null, whoName?: string): string | null {
  if (!ownPlan(e) || !who || who === e.hostId) return null;
  const tool = engineName(e.tool!);
  return `${tool} here runs on ${e.hostName}'s own ${planOf(e)} plan, so it takes ${e.hostName}'s work only${whoName ? `, not ${whoName}'s` : ""}. ${whoName ?? "They"} can send ${e.hostName} a suggestion, or connect their own ${tool}.`;
}

/** The plan a tool's sign-in is, by its maker. */
const planOf = (e: EngineInfo) => (e.tool === "claude" ? "Claude" : e.tool === "codex" ? "ChatGPT" : engineName(e.tool!));
