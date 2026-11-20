import { runOf, type SessionState } from "../../session/projection.js";
import { ENGINE_NAMES, MAIN_LANE, type EngineTool, type SessionEvent } from "../../types.js";
import type { AskLane } from "../Activity.js";
import type { quickConnect as Connect } from "../quickConnect.js";
import type { Identity } from "../storage.js";
import type { Send } from "../useSession.js";

/**
 * "Hand on to Codex now" on the column's bar (Arun, 2026-11-20, wave 5: "Claude Code may hit its limit in ~20 min · Hand on to Codex
 * now / Later"). The bar is the column's, the session is the chat's, so the press travels as a window event the chat's own screen
 * (Activity.tsx, friday:ask-lane with `run`) answers, handing over its live state. The way on is the hand-off Friday
 * already has: the other tool joins the session if it isn't in it (quickConnect, as the Pass on menu does), the turn under way is
 * stopped so two tools aren't in one folder at once, and the task goes to the other with the whole record behind it (a handoff
 * instruction, whose brief the server writes: handoffBrief). Only a tool on the person's own computer, never another sign-in of the
 * same tool (Arun, 2026-10-27: "i do not want my account banned").
 */
/** A press on the bar: which lane's tool to move off, and onto which. */
export interface HandOn {
  sid: string;
  /** The lane whose tool is heading for its limit. */
  from: string;
  tool: EngineTool;
  /** The lane that tool already has in this session, when it has one. */
  to?: string;
  reply: (r: { ok: boolean; error?: string }) => void;
}

/** Asks the chat's screen to run it with its live state. False when no screen has this session (nothing took it). */
export function handOnAsk(d: HandOn): boolean {
  const ask: AskLane = { sid: d.sid, lane: d.from, text: "", reply: d.reply, run: (get, connect) => void handOnNow(get, connect, d).then(d.reply, (e: Error) => d.reply({ ok: false, error: e.message })) };
  window.dispatchEvent(new CustomEvent("friday:ask-lane", { detail: ask }));
  return !!ask.handled;
}

/** What the screen has to say for a hand-on: its session as it is now (read afresh while it waits). */
export interface HandCtx {
  identity: Identity;
  state: SessionState;
  events: SessionEvent[];
  sid: string;
  invite: string;
  send: Send;
}

/** What the lane was last asked by a person: the task that goes on. Failing that, the task it was itself handed (a second hand-on). */
export function lastTask(events: SessionEvent[], lane: string): string {
  const text = (e: SessionEvent | undefined) => (e?.body.type === "instruction" ? e.body.text.trim() : "");
  const own = events.findLast((x) => x.body.type === "instruction" && x.actor.kind === "human" && (x.lane ?? MAIN_LANE) === lane && !x.body.approval && !x.body.keepGoing && !x.body.handoff && x.body.text.trim());
  const carried = events.findLast((x) => x.body.type === "instruction" && (x.lane ?? MAIN_LANE) === lane && !!x.body.handoff && x.body.text.trim());
  // The newer of the two: what it was last given to do.
  return text(own && carried ? (own.seq > carried.seq ? own : carried) : (own ?? carried));
}

export function handOnWhy(from: string, to: string): string {
  return `${from} was heading for its usage limit, so the work moves to ${to} before it stops.`;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `quickConnect` is given by the screen that has it (Activity.tsx): taking it from the module here would tie this chunk to the session screen's. */
export async function handOnNow(get: () => HandCtx, quickConnect: typeof Connect, d: Pick<HandOn, "from" | "tool" | "to">): Promise<{ ok: boolean; error?: string }> {
  const first = get();
  const fromTool = first.state.engines[d.from]?.tool;
  const fromName = fromTool ? ENGINE_NAMES[fromTool] : "The agent";
  const toName = ENGINE_NAMES[d.tool];
  if (fromTool === d.tool) return { ok: false, error: `${toName} is the tool that is running; Friday doesn't move work between sign-ins of one tool.` };
  const task = lastTask(first.events, d.from);
  if (!task) return { ok: false, error: "There is no task to hand on yet." };
  let to = d.to && first.state.engines[d.to]?.tool === d.tool ? d.to : "";
  if (!to) {
    const before = new Set(first.state.lanes.map((l) => l.id));
    const r = await quickConnect({ identity: first.identity, state: first.state, events: first.events, sid: first.sid, invite: first.invite, tool: d.tool, from: d.from, send: first.send });
    if (!r.ok) return { ok: false, error: r.error ? `${toName} didn't start: ${r.error}` : `${toName} didn't start.` };
    // Its lane is added at once; the handoff waits in it while the runner starts.
    for (let i = 0; i < 40 && !to; i++) {
      to = get().state.lanes.find((l) => !before.has(l.id) && get().state.engines[l.id]?.tool === d.tool)?.id ?? "";
      if (!to) await wait(250);
    }
    if (!to) return { ok: false, error: `${toName} didn't join. Try again.` };
  }
  // The tool that is running stops first: two tools in one folder write over each other.
  if (runOf(get().state, d.from).status === "running") {
    await get().send({ type: "run.cancel", ...(d.from !== MAIN_LANE ? { lane: d.from } : {}) });
    for (let i = 0; i < 24 && runOf(get().state, d.from).status === "running"; i++) await wait(250);
  }
  const sent = await get().send({ type: "instruct", lane: to, text: task, handoff: { fromLane: d.from, reason: handOnWhy(fromName, toName), carried: [] }, quiet: true });
  // The tool was stopped above: said, so the person knows to press again rather than wait on a tool that is not running.
  return sent.ok ? { ok: true } : { ok: false, error: `${sent.error ?? `Couldn't hand that to ${toName}.`} ${fromName} was stopped, so press again.` };
}
