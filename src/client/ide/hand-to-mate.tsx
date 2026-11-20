import { MenuButton, type MenuItem } from "../ui.js";
import { Icon } from "../icons.js";
import { Face, setTeamTab, useTeam } from "../Teammates.js";
import { roleWord } from "../team-status.js";
import { kgPath } from "../crew-carry-open.js";
import { carryReq } from "../crew-carry-req.js";
import type { Identity } from "../storage.js";
import { closeCodeTab, type CodeChat } from "./code-chats.js";
import { buildPacket, gatherFacts } from "./handoff-packet.js";
import { setMode } from "./mode.js";
import { dismissMoved, noteMoved, type MovedChat } from "./send-to-agents.js";

/**
 * "Hand to a teammate" (Arun, 2026-11-20, wave 5: "a Code chat's task goes to one of your Crew teammates (persistent AI teammates)
 * with the hand-off packet: the ask, what's done, the branch, changed files, open questions, the repo's rules and memory"). It is
 * "Keep this going" (crew-carry.ts) with the packet of handoff-packet.ts on top: the teammate gets a thread of its own on its page,
 * in a copy of the folder that has the branch and the uncommitted changes, and the chat says so on its line. What is new here is
 * only that Code's column does it in one pick, and leaves a "With <name> · open" tab where the chat was.
 */
export interface Mate {
  id: string;
  name: string;
  look?: string;
  /** Its coding tool: the repo's rules are kept to the ones for it. */
  tool?: string;
}

const notice = (text: string) => window.dispatchEvent(new CustomEvent("friday:notice", { detail: text }));
const first = (n: string) => n.split(/\s+/)[0] || n;

/** The hand-off's answer: where the teammate works on it. `why` is said when it can't start yet (its computer is away). */
interface Handed {
  job: { id: string; mate: { id: string; name: string }; lane: string; sid: string; thread?: string };
  why?: string;
}

/**
 * Hands the chat to the teammate. The packet is written first; if the server refuses (someone is on it already, the teammate was
 * taken away) nothing has moved. Then the chat's tab closes (it stays in Code's history) and its place says who has it.
 */
export async function handToMate(identity: Identity, chat: CodeChat, mate: Mate, onHanded?: (m: MovedChat) => void): Promise<void> {
  const facts = await gatherFacts(identity, chat, { rulesFor: mate.tool ?? "all" }).catch(() => ({ title: chat.title, folder: chat.folder }));
  const packet = buildPacket(facts, { kind: "mate", name: first(mate.name) });
  // The packet carries the ask, the state and the changes; the session's own notes (where we left off) and the branch with its
  // uncommitted files go the way "Keep this going" sends them. The open question is in the packet, so not twice.
  const r = await carryReq<Handed>(kgPath(chat.sid, chat.invite), {
    method: "POST",
    body: JSON.stringify({ mate: mate.id, carry: { leftOff: true, branch: true, question: false, conversation: false }, note: "", packet }),
  });
  window.dispatchEvent(new Event("friday:attention"));
  window.dispatchEvent(new Event("friday:teammates"));
  if (r.why) notice(r.why);
  const m: MovedChat = { sid: chat.sid, invite: chat.invite, folder: chat.folder, title: chat.title, mate: { id: mate.id, name: mate.name, ...(mate.look ? { look: mate.look } : {}), job: r.job.id } };
  // The tab is noted and chosen before the chat's own closes (as sendToAgents does): the column never shows the next chat in between.
  noteMoved(m);
  onHanded?.(m);
  closeCodeTab(chat.folder, chat.sid);
}

/** The teammate's thread on its page, opened (the Crew side in view): the same place the chat's own "open" goes. */
export function openMateThread(m: Pick<MovedChat, "sid" | "invite" | "mate">): void {
  if (!m.mate) return;
  void carryReq<{ sid: string; invite: string; lane: string; mate?: string }>(kgPath(m.sid, m.invite, `/${m.mate.job}`)).then(
    (o) => {
      // From Code the page is on Code's side: Agents, with the Crew in view, first.
      setMode("agents");
      if (o.mate) setTeamTab(true);
      window.dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: o.sid, invite: o.invite } }));
    },
    (e: Error & { status?: number }) => {
      // The hand-off is gone (taken back, finished and cleared, the teammate deleted): the tab that says "With" no longer is true.
      if (e.status === 404) dismissMoved(m.sid);
      notice(e.message);
    },
  );
}

/** What Code's column shows under a "With <name>" tab. */
export function WithMatePanel({ chat, onClose }: { chat: MovedChat; onClose: () => void }) {
  const mate = chat.mate!;
  return (
    <div className="ia-empty ia-start ia-moved">
      <span className="ia-hero" aria-hidden="true"><Face seed={mate.look ?? mate.name} size={32} /></span>
      <p className="ia-empty-title">With {first(mate.name)}</p>
      <p>“{chat.title || "Untitled"}” is {first(mate.name)}'s now, with its branch, changes, questions and the repo's rules. Its answer comes back to the chat.</p>
      <button type="button" className="ia-btn" onClick={() => openMateThread(chat)}>
        Open {first(mate.name)}'s thread <Icon name="arrowUpRight" size={13} />
      </button>
      <button type="button" className="ia-link" onClick={onClose}>Close this tab</button>
    </div>
  );
}

/**
 * The column's "⋯" (More): Send to Agents, then the Crew's teammates, as faces and names, to hand the chat to. Reads the crew itself (the page is not on the
 * Crew side while Code is open), so it is as fresh as the Crew page.
 */
export function HandMenu({ identity, busy, onPick, onSend }: { identity: Identity; busy?: boolean; onPick: (m: Mate) => void; onSend: () => void }) {
  const team = useTeam(identity);
  const mates = team?.teammates ?? [];
  const items = (): MenuItem[] => [
    // Send to Agents sits here, above the crew (Arun, 2026-11-20: Code's header kept one slot less for the tabs).
    { label: "Send to Agents", sub: "A big job carries on there", icon: "arrowUpLeft", disabled: busy, onSelect: onSend },
    { heading: "Hand to a teammate" },
    ...(mates.length
      ? mates.map(
          (m): MenuItem => ({
            label: m.name,
            sub: roleWord(m.role) || undefined,
            mark: <Face seed={m.look ?? m.name} size={20} />,
            disabled: busy,
            onSelect: () => onPick({ id: m.id, name: m.name, ...(m.look ? { look: m.look } : {}), ...(m.tool ? { tool: m.tool } : {}) }),
          }),
        )
      : [{ label: team ? "No teammates yet" : "Reading your crew…", sub: team ? "Add one on the Crew page" : undefined, disabled: true, onSelect: () => {} } as MenuItem]),
  ];
  return <MenuButton className="ia-icon" icon="more" label="More" end maxHeight={420} items={items} />;
}
