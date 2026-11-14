import { can, type SessionState } from "../session/projection.js";
import { SESSION_LANES, type Member } from "../types.js";
import { api } from "./api.js";
import { isLocal } from "./edition.js";
import type { Identity } from "./storage.js";
import { Face, refreshTeam, useTeam, type Team } from "./Teammates.js";
import type { MenuItem } from "./ui.js";

/**
 * "Add an agent" lists your crew first (Code and Crew, connected, ported to the open-source edition from Friday Teams 6e231ada,
 * 79b27a67 and cdd44714): Kit as a lane of this coding session, run by its own tool, model and account, with its role and its
 * memory, driven by you (crew-code.ts). Each row is the crew mate's name and face, its role on hover (Arun, 2026-11-10: "get rid
 * of seconday text"). The rows for each of the session's add menus: the agent switch's +, the box's Send to and the Agents panel.
 */

/** The coding sessions your crew mates are in, as GET /api/teammates says (crew-code.ts). */
export const visitsOf = (t: Team | null): { sid: string; lane: string; mate: string }[] => (t as { visits?: { sid: string; lane: string; mate: string }[] } | null)?.visits ?? [];

/** The crew mate on a lane of a coding session, when that lane is one brought in (crew-code.ts). */
export const visitOn = (t: Team | null, sid: string, lane: string) => {
  const v = visitsOf(t).find((x) => x.sid === sid && x.lane === lane);
  return v ? (t?.teammates.find((m) => m.id === v.mate) ?? null) : null;
};

const notice = (text: string) => dispatchEvent(new CustomEvent("friday:notice", { detail: text }));

export function useCrewAddRows(state: SessionState, me: Pick<Member, "id" | "role">, identity: Identity): () => MenuItem[] {
  const crew = useTeam(identity);
  return () => {
    const mine = crew?.teammates ?? [];
    if (!isLocal() || !mine.length || state.options.team || me.role === "viewer" || !can(state, me.id, "control")) return [];
    const here = new Set(visitsOf(crew).filter((v) => v.sid === state.id && state.lanes.some((l) => l.id === v.lane)).map((v) => v.mate));
    const full = state.lanes.length >= SESSION_LANES;
    return [
      { heading: "Your crew" },
      ...mine.map(
        (m): MenuItem => ({
          label: m.name,
          mark: <Face seed={m.look ?? m.name} size={14} />,
          // Names only, the role on hover; a hint only when it can't be picked.
          hint: here.has(m.id) ? "in this session" : full ? `${SESSION_LANES} is the most` : undefined,
          ...(m.role ? { title: m.role } : {}),
          disabled: here.has(m.id) || full,
          onSelect: () =>
            void api<{ visit?: { lane: string; started: boolean } }>(identity, `/api/teammates/${m.id}/visit`, { method: "POST", body: JSON.stringify({ sid: state.id }), headers: { "Content-Type": "application/json" } }).then(
              (r) => {
                void refreshTeam(identity);
                // The box points at it, so the next message goes to Kit.
                if (r.visit) window.dispatchEvent(new CustomEvent("friday:focus-lane", { detail: { lane: r.visit.lane } }));
                if (r.visit && !r.visit.started) notice(`${m.name} is here. It starts once ${m.machine ? "its computer" : "your computer"} is connected.`);
              },
              (e: Error) => notice(e.message),
            ),
        }),
      ),
    ];
  };
}
