import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * The session notes nobody needs to read (Arun, 2026-10-18: "get rid of useless and repetitive session notes"). The log
 * keeps every one; the feed leaves these out:
 *
 *  - an agent going offline and coming back: only an absence that is still going on is news;
 *  - the same agent connecting again exactly as it was (same tool, computer, folder, mode, model, branch), which a restart
 *    or a dropped connection does many times a day;
 *  - "set this lane to run on…", once that tool has connected;
 *  - "Session started by you", "You joined as owner": you were there;
 *  - the wheel changing hands on Solo, where there is nobody to hand it to, and on Team a driver dropping off and taking it
 *    straight back;
 *  - the same person joining again, and an invite link updated more than once in a row (the last one stands).
 */
export function hiddenNotes(events: SessionEvent[], meId: string, solo: boolean): Set<number> {
  const hide = new Set<number>();
  /** Per lane: the last connection's description, and an offline note still waiting for the agent to come back. */
  const attached = new Map<string, string>();
  const offline = new Map<string, number>();
  const expected = new Map<string, number>();
  const joined = new Set<string>();
  /** Per person: the "disconnected, so nobody has control" note waiting for them to take the wheel back. */
  const dropped = new Map<string, number>();
  let lastLink: { role: string; seq: number } | null = null;

  for (const e of events) {
    const b = e.body;
    const lane = e.lane ?? MAIN_LANE;
    if (b.type !== "link.updated") lastLink = null;
    switch (b.type) {
      case "session.created":
        // Who started it with which agent still says something; just "started by you" doesn't.
        if (e.actor.id === meId && !b.options?.agent) hide.add(e.seq);
        break;
      case "member.joined":
        if (e.actor.id === meId || joined.has(e.actor.id)) hide.add(e.seq);
        joined.add(e.actor.id);
        break;
      case "link.updated":
        if (lastLink && lastLink.role === b.role) hide.add(lastLink.seq);
        lastLink = { role: b.role, seq: e.seq };
        break;
      case "engine.expected":
        expected.set(lane, e.seq);
        if (b.effortReset) expected.delete(lane);
        break;
      case "engine.attached": {
        const x = b.engine;
        const said = JSON.stringify([x.tool ?? "", x.hostId, x.cwd, x.mode, x.model ?? "", x.branch ?? "", x.machine ?? ""]);
        const back = offline.get(lane);
        if (back !== undefined) (hide.add(back), offline.delete(lane));
        const waited = expected.get(lane);
        if (waited !== undefined) (hide.add(waited), expected.delete(lane));
        // Its first connection, or one that changed something, is news; the same one again isn't. Unless it dropped an
        // effort someone picked, or carries on an imported conversation: both say something of their own.
        if (attached.get(lane) === said && !b.effortReset && !x.resumedFrom) hide.add(e.seq);
        attached.set(lane, said);
        break;
      }
      case "engine.detached":
        // Handing the lane back to Friday Code is a choice somebody made; going offline is news only until it's back.
        if (b.reason === "disconnected") offline.set(lane, e.seq);
        else attached.delete(lane);
        break;
      case "control.requested":
      case "control.granted":
      case "control.denied":
      case "control.released":
        if (solo) {
          hide.add(e.seq);
          break;
        }
        if (b.type === "control.released" && b.reason === "disconnect") dropped.set(b.from, e.seq);
        if (b.type === "control.granted") {
          const was = dropped.get(b.to);
          // Back at the wheel they dropped: neither the drop nor the claim is worth a line.
          if (was !== undefined && b.reason === "claim") (hide.add(was), hide.add(e.seq));
          dropped.delete(b.to);
        }
        break;
    }
  }
  return hide;
}
