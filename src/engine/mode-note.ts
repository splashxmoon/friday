import type { EngineMode, SessionEvent } from "../types.js";

/**
 * What a coding tool is told about the mode its turn runs in, so what it says matches what it can do (Arun, 2026-11-18: "there
 * are times where the agent says like if you switch me to auto mode or something even though it is already on auto mode... we
 * need to make this stable and consistent please").
 *
 * The standing note never said a mode, so the agent guessed it: from Claude Code's "you haven't granted it yet" on a turn held
 * to Manual because it carried another agent's message (othersCap) while the lane read Auto, or from refusals and Plan
 * reminders earlier in a conversation it carried on in another mode. It then asked the person to switch it to Auto, which it
 * already was. Now each turn whose mode differs from the last one told on this connection (its first included) leads with the
 * mode it really runs in and, when that is lower than the lane's, the true reason, which a switch to Auto wouldn't change.
 */

const RANK: Record<EngineMode, number> = { plan: 0, edits: 1, full: 2 };

/** The mode a turn runs in: the lower of the lane's and its cap, as the runner holds it (runner.ts capMode). */
export function turnMode(own: EngineMode, cap?: EngineMode): EngineMode {
  return cap && RANK[cap] !== undefined && RANK[cap] < RANK[own] ? cap : own;
}

/**
 * Why a turn carrying someone else's message is held below the lane's mode, in words for the agent: the first of the turn's
 * messages that isn't the host's own (`others`, the hub's othersMessage). Friday's carry-on and an answer to an ask aren't a
 * reason of their own (they carry on whoever's work it was), so past those it says so in general terms.
 */
export function capReason(events: readonly SessionEvent[], pending: readonly number[], host: string, others: (e: SessionEvent) => boolean): string {
  for (const q of pending) {
    const e = events.find((x) => x.seq === q);
    if (e?.body.type !== "instruction" || e.body.keepGoing || e.body.approval || !others(e)) continue;
    const b = e.body;
    const who = e.actor.name;
    if (b.handoff) return `${who} handed this task on to you`;
    if (b.via) return `an app posted this message for ${host}`;
    if (b.peer || b.mesh) return `this message is from another agent (${who}), not ${host}`;
    return `this message is from ${who}, not ${host}`;
  }
  return `this turn carries a message from someone other than ${host}`;
}

const NAME: Record<EngineMode, string> = { plan: "Plan", edits: "Manual", full: "Auto" };

/**
 * The line that leads a turn's prompt about its mode. `own`: the lane's mode; `cap`: what the turn is held to (othersCap),
 * `why` saying why when it is lower; `hand`: the mode the host picked by hand, when `own` was picked for them.
 */
export function modeLine(own: EngineMode, o: { cap?: EngineMode; why?: string; host: string; hand?: EngineMode }): string {
  const mode = turnMode(own, o.cap);
  const held = mode !== own;
  const head = held
    ? `[Friday] This turn runs in ${NAME[mode]}, although your lane is on ${NAME[own]}: ${o.why ?? `it carries a message from someone other than ${o.host}`}, and ${
        o.hand === mode ? `${o.host} picked ${NAME[mode]} by hand for others' messages` : `${o.host} holds others' messages to ${NAME[mode]} on this computer`
      }.`
    : `[Friday] Your lane is on ${NAME[mode]}.`;
  const can =
    mode === "full"
      ? "Change files, run commands and use the web without asking anyone: nothing needs switching or granting, so never ask the person to switch you to Auto or to give you permission. If something is still put to the person or refused, that is Friday's go-ahead list or the tool's own sandbox, not your mode: say what was refused and why, and carry on another way."
      : mode === "edits"
        ? `You may change files in the folder; each command is put to ${held ? o.host : "the person"} first and runs on their yes, so ask for one command at a time and wait for the answer.`
        : "Read and look around only, then say what you would change; don't change files. Commands to look around are put to the person first.";
  const tail = held
    ? ` Switching the lane won't lift this (it is already on ${NAME[own]}), so don't ask for that; ${o.host}'s own messages still run in ${NAME[own]}.`
    : mode === "full"
      ? ""
      : ` Only the person can switch the lane${mode === "plan" ? " out of Plan" : " to Auto"}; if a step needs that, say which step and why.`;
  return `${head} ${can}${tail}`;
}
