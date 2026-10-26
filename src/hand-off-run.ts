import type { Bus } from "./bus.js";
import { BOUNCE_WINDOW_MS, bouncesBetween, carriedFor, MAX_BOUNCES, resolveTarget } from "./handoff.js";
import { cleanHandoff, laneName } from "./session/core.js";
import { canDriveLane, driverOf, laneOf } from "./session/projection.js";
import type { SessionStore } from "./session/store.js";
import { MAIN_LANE, type ActorRef } from "./types.js";

const AGENT: ActorRef = { id: "agent", name: "Agent", kind: "agent" };

/**
 * Queue work on another lane as a handoff from this one, written as the agent (agent/runtime.ts handOff for Friday's own agent;
 * agent-mesh.ts for every coding tool's hand_off).
 *
 * Under the same lane rules as a person's handoff: a lane someone else steers is theirs, and an agent can't go around that by
 * handing work to it. What stops a loop is the same as any instruction: the receiving agent has to decide to hand it back, and
 * every hop is in the log with its reason.
 */
export async function handOff(store: SessionStore, bus: Bus, sid: string, from: string, req: { to: string; reason: string; carried: string[]; task: string }) {
  const state = await store.state(sid);
  if (!req.task.trim() || !req.reason.trim()) return { ok: false as const, error: "Say why you're handing it off and what the task is." };
  const events = await store.events(sid);
  // The person who started this run, if one did: the agent hands work only where they could have sent it themselves.
  // With nobody behind it (a trigger, another agent), only to a lane nobody is steering and no one's own coding tool.
  const started = events.findLast((e) => e.body.type === "run.started" && (e.lane ?? MAIN_LANE) === from);
  const cause = started?.body.type === "run.started" ? events.find((e) => e.seq === (started.body as { causedBy: number }).causedBy) : undefined;
  const person = cause?.body.type === "instruction" && cause.actor.kind === "human" && (cause.lane ?? MAIN_LANE) === from ? cause.actor : null;
  const refusal = (id: string): string | null => {
    const name = laneName(state, id);
    const driver = driverOf(state, id);
    const engine = state.engines[id];
    if (laneOf(state, id)?.control.kind === "standing") return `${name} runs on its own when what it watches happens, so I can't hand work to it.`;
    if (driver && driver.id !== person?.id) return `${name} is ${driver.name}'s to steer, so I can't hand work to it. Ask ${driver.name}.`;
    if (person ? canDriveLane(state, person.id, id) : !engine) return null;
    if (person) return `${person.name} can't steer ${name}, so I can't hand work to it.`;
    return `${name} is ${engine!.hostName}'s own coding tool, so I can't hand work to it unless a person asks. Ask ${engine!.hostName}.`;
  };
  // Who was meant: the name as shown, however a person would say it, or the best fit for the work. A miss says what each choice is for.
  const found = resolveTarget(state, from, req.to, `${req.reason} ${req.task}`, (id) => !refusal(id));
  if (!found.ok) return { ok: false as const, error: found.error };
  const to = found.to;
  const refused = refusal(to);
  if (refused) return { ok: false as const, error: refused };
  // Two agents handing one thing back and forth is a conversation nobody is steering.
  const bounces = bouncesBetween(events, from, to, Date.now() - BOUNCE_WINDOW_MS);
  if (bounces >= MAX_BOUNCES) {
    return { ok: false as const, error: `Work has gone between you and ${laneName(state, to)} ${bounces} times in the last few minutes. Settle it yourself, or ask a person with ask_human.` };
  }
  // What the agent forgot to say it did, from the log: the files it changed, a question still open.
  const handoff = cleanHandoff(state, { fromLane: from, reason: req.reason, carried: carriedFor(state, from, req.carried) }, to);
  if (!handoff) return { ok: false as const, error: "That handoff couldn't be made." };
  const sent = await store.append(sid, { ...AGENT, name: handoff.fromName }, { type: "instruction", text: req.task.trim().slice(0, 8000), interrupt: false, handoff }, { lane: to, expectDriver: driverOf(state, to)?.id ?? "" });
  if (!sent.ok) return { ok: false as const, error: `${handoff.toName} changed hands just now, so the work wasn't handed over. Try again.` };
  void bus.wake(sid, to);
  const note = found.how === "named" ? undefined : `"${req.to.trim() || "(nobody named)"}" was taken to mean ${handoff.toName}.`;
  return { ok: true as const, toName: handoff.toName, ...(note ? { note } : {}) };
}
