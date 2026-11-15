import type { TeammateView } from "../teammates.js";
import { api } from "./api.js";
import type { Identity } from "./storage.js";
import { refreshTeam, type RoomView, type Team } from "./Teammates.js";
import type { Confirmation, MenuItem } from "./ui.js";

/**
 * What can be done to a crew mate from its row, in the sidebar and on the Agents page: restart its coding tool, make it the lead,
 * and remove it from the crew (Arun, 2026-11-15: "WHY CANT I DELETE AND REMOVE AGENTS?"). Its menu lived on the old crew list,
 * which the rail's sidebar replaced, and Edit… became the Settings panel, so nothing offered it any more. Friday Teams keeps the
 * same three on each crew mate's row.
 */
export function mateItems(o: { identity: Identity; team: Team; mate: TeammateView; ask: (c: Confirmation) => void; onRemoved?: () => void }): MenuItem[] {
  const { identity, team, mate: m, ask } = o;
  // Said where it was pressed: the row's list updates by itself when it works.
  const fail = (e: Error) => ask({ title: "That didn't work", body: e.message || "Try again.", action: "OK", danger: false, onConfirm: () => {} });
  return [
    team.lead !== m.lane && { label: "Make them the lead", icon: "crown", onSelect: () => void api(identity, `/api/teammates/${m.id}/lead`, { method: "POST" }).then(() => refreshTeam(identity)).catch(fail) },
    { label: "Restart their tool", icon: "refresh", onSelect: () => void api(identity, `/api/teammates/${m.id}/reconnect`, { method: "POST" }).then(() => refreshTeam(identity)).catch(fail) },
    { label: "Remove…", icon: "trash", danger: true, onSelect: () => askRemove(o) },
  ];
}

/** Removing a crew mate, after asking: from its row's menu and from the foot of its settings. */
export function askRemove(o: { identity: Identity; mate: TeammateView; ask: (c: Confirmation) => void; onRemoved?: () => void }): void {
  const { identity, mate: m, ask } = o;
  const fail = (e: Error) => ask({ title: "That didn't work", body: e.message || "Try again.", action: "OK", danger: false, onConfirm: () => {} });
  const home = m.folder.replace(/^\/(?:Users|home)\/[^/]+/, "~");
  ask({
    title: `Remove ${m.name}?`,
    body: `${m.name} leaves your crew and its coding tool stops. Its folder stays where it is, with everything it made: ${home}`,
    action: "Remove",
    danger: true,
    onConfirm: () =>
      void api(identity, `/api/teammates/${m.id}`, { method: "DELETE" })
        .then(() => refreshTeam(identity))
        .then(() => o.onRemoved?.())
        .catch(fail),
  });
}

/** A room's own, from its sidebar row's right-click (Arun, 2026-11-15: "make sure i can have right click too on the side bar"): open
 *  it, edit it (its name, purpose and who is in it), or remove it, as the old crew list's room menu had them. */
export function roomItems(o: { identity: Identity; room: RoomView; ask: (c: Confirmation) => void; onOpen: () => void; onEdit: () => void; onRemoved?: () => void }): MenuItem[] {
  const { identity, room: r, ask } = o;
  const fail = (e: Error) => ask({ title: "That didn't work", body: e.message || "Try again.", action: "OK", danger: false, onConfirm: () => {} });
  return [
    { label: "Open", icon: "users", onSelect: o.onOpen },
    { label: "Edit…", icon: "pencil", onSelect: o.onEdit },
    {
      label: "Remove room…",
      icon: "trash",
      danger: true,
      onSelect: () =>
        ask({
          title: `Remove ${r.name}?`,
          body: "Its crew mates stop working in it. They stay in your crew, with their folders and everything they made; the room's conversation is kept, out of sight.",
          action: "Remove room",
          onConfirm: () =>
            void api(identity, `/api/teammates/rooms/${r.id}`, { method: "DELETE" })
              .then(() => refreshTeam(identity))
              .then(() => o.onRemoved?.())
              .catch(fail),
        }),
    },
  ];
}
