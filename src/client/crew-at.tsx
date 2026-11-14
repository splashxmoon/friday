// What a coding session's box and runs offer of "Keep this going" (Code and Crew, connected, ported to the open-source edition from
// Friday Teams e4d637ea, 773e15e7 and 1815f0ac, keep-going.tsx): your crew mates and crew rooms after "@", "@Kit finish this" handed
// straight on, and the action on a finished run. The session's hand-off lines load on their own (crew-carry.tsx).
import { useEffect, useState } from "react";
import { ASK_DEFAULT, CARRY_DEFAULT, mentionHandOff } from "../crew-carry-rules.js";
import { kgPath, openKeepGoing } from "./crew-carry-open.js";
import { carryReq as workReq } from "./crew-carry-req.js";

/** What "@" in a session's box can hand work to: your crew mates and the crew rooms you're in (Arun, 2026-11-13). */
export type CrewTarget = { kind: "mate" | "room"; id: string; name: string; /** What it is written as after "@": a room's name has no spaces. */ at: string; hint: string; /** A crew mate's mascot. */ look?: string };
const atName = (n: string) => n.trim().replace(/\s+/g, "-");
const targetCache = new Map<string, { at: number; list: CrewTarget[] }>();
/** Your crew mates and crew rooms, from the sheet's own read, kept a little while per session. */
export async function myCrewTargets(sid: string, invite: string): Promise<CrewTarget[]> {
  const hit = targetCache.get(sid);
  if (hit && Date.now() - hit.at < 60_000) return hit.list;
  const r = await workReq<{ own?: { id: string; name: string; line: string; look?: string }[]; rooms?: { id: string; name: string; line: string }[] }>(kgPath(sid, invite)).catch(() => ({ own: [], rooms: [] }));
  const list: CrewTarget[] = [
    ...(r.own ?? []).map((m) => ({ kind: "mate" as const, id: m.id, name: m.name, at: atName(m.name), hint: m.line, ...(m.look ? { look: m.look } : {}) })),
    ...(r.rooms ?? []).map((m) => ({ kind: "room" as const, id: m.id, name: m.name, at: atName(m.name), hint: `Crew room · ${m.line}` })),
  ];
  targetCache.set(sid, { at: Date.now(), list });
  return list;
}
/** The @ list's crew entries for a session's box, read once it is shown and kept up a minute at a time. */
export function useCrewTargets(sid: string, invite: string, on: boolean): CrewTarget[] {
  const [list, setList] = useState<CrewTarget[]>(() => targetCache.get(sid)?.list ?? []);
  useEffect(() => {
    if (!on || !invite) return;
    let live = true;
    void myCrewTargets(sid, invite).then((l) => live && setList(l));
    return () => void (live = false);
  }, [sid, invite, on]);
  return on ? list : [];
}

/**
 * "@Kit finish this" or "@Payments take the rest" in a session's box: one of your crew mates or crew rooms named first, when no
 * agent here has that name (an agent here is written to as always), and the words after. Null for anything else, without asking
 * the server unless it starts with an @name.
 */
export async function mentionCrew(sid: string, invite: string, text: string, laneNames: readonly string[]): Promise<{ target: CrewTarget; words: string } | null> {
  if (!/^@[^\s]+\s+\S/.test(text.trim())) return null;
  const here = new Set(laneNames.map((n) => n.toLowerCase()));
  const list = (await myCrewTargets(sid, invite)).filter((t) => !here.has(t.name.toLowerCase()));
  const m = mentionHandOff(text, list.map((t) => t.at));
  const target = m ? list.find((t) => t.at === m.name) : undefined;
  return m && target ? { target, words: m.words } : null;
}

/**
 * Straight on, no sheet: what was typed after the @name is the line on top, and the rest is the sheet's defaults (where we left
 * off, the branch and its changes, the open question; asks before a PR and a merge). The session's line says it at once, with
 * Stop and Take back on it, so a slip is one press to undo.
 */
export async function handStraight(sid: string, invite: string, lane: string, at: { target: CrewTarget; words: string }): Promise<void> {
  const body = at.target.kind === "room" ? { room: at.target.id, lane, carry: { ...CARRY_DEFAULT }, note: at.words } : { mate: at.target.id, lane, carry: { ...CARRY_DEFAULT }, note: at.words, ask: [...ASK_DEFAULT] };
  await workReq(kgPath(sid, invite), { method: "POST", body: JSON.stringify(body) });
}


// ── The end of a run ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** "Keep this going" on a finished run's own row of actions: the sheet for this lane. Not a card of its own. */
export function KeepGoingAction({ sid, invite, lane, className }: { sid: string; invite: string; lane: string; className: string }) {
  return (
    <button type="button" className={className} data-tip="Hand the rest to your crew" onClick={() => openKeepGoing({ sid, invite, lane })}>
      Keep this going
    </button>
  );
}

export { askWheel, openKeepGoing } from "./crew-carry-open.js";
