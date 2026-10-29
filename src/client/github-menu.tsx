import { useRef, useState, type ReactNode } from "react";
import type { SessionState } from "../session/projection.js";
import { MAIN_LANE } from "../types.js";
import { BranchCard } from "./Branches.js";
import { Icon } from "./icons.js";
import { openInItems, openTargets, type OpenTarget } from "./openIn.js";
import { ShipDialog } from "./Ship.js";
import type { Send } from "./useSession.js";
import { ContextMenu, type MenuItem } from "./ui.js";

/**
 * The GitHub things you can do to the code this session works in, on a right-click of the repo.
 *
 * Each is offered where it makes sense and greyed, with the reason, where it does not: a pull request needs a branch
 * that is not the default one, a commit needs changes, and anything on GitHub needs a GitHub remote. The remote is only
 * asked of the folder when the menu opens, so a header nobody right-clicks costs nothing.
 */

interface Remote {
  github?: string | null;
  branch?: string;
}

const DEFAULT_BRANCH = /^(main|master|trunk|develop)$/;

async function remoteOf(sid: string, invite: string): Promise<Remote> {
  try {
    const r = (await (await fetch(`/api/sessions/${encodeURIComponent(sid)}/repo?op=remote&invite=${encodeURIComponent(invite)}`)).json()) as { output?: string };
    return JSON.parse(r.output ?? "{}") as Remote;
  } catch {
    return {};
  }
}

/**
 * A new session of your own that starts from this one's conversation. The sidebar files it just below this one, and it opens: made
 * and not opened, nothing on screen said it had happened (Arun, 2026-10-28: "iron everything and ensure we are good… any logic
 * errors and fixes").
 */
export async function forkSession(sid: string, invite: string, upTo?: number): Promise<string | null> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/fork?invite=${encodeURIComponent(invite)}${upTo ? `&upTo=${upTo}` : ""}`, { method: "POST" });
  const d = (await r.json()) as { sessionId?: string; invites?: { owner?: string }; title?: string; error?: string; note?: string };
  if (!d.sessionId || !d.invites?.owner) return d.error ?? "Couldn't fork this session. Try again in a moment.";
  window.dispatchEvent(new CustomEvent("friday:forked", { detail: { from: sid, sid: d.sessionId, invite: d.invites.owner, title: d.title ?? "Fork" } }));
  window.dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: d.sessionId, invite: d.invites.owner } }));
  // Made, with something left behind (an agent whose tool wouldn't start): said where an error would be, so it isn't missed.
  return d.note ?? null;
}

/** The same menu as a button beside the message box, because a right-click is not something anybody finds. */
export function GitButton(p: { state: SessionState; sid: string; invite: string; send: Send }) {
  const e = p.state.engines[MAIN_LANE] ?? Object.values(p.state.engines)[0];
  if (!e?.cwd) return null;
  return (
    <GitMenu {...p} clickToo>
      <button type="button" className="git-btn" title="Commit, branch, pull request, fork">
        <Icon name="gitBranch" size={13} />
        <span>{e.branch ?? "Git"}</span>
        <Icon name="chevronDown" size={12} />
      </button>
    </GitMenu>
  );
}

export function GitMenu({ state, sid, invite, send, children, clickToo, below }: { state: SessionState; sid: string; invite: string; send: Send; children: ReactNode; clickToo?: boolean; /** Opens under what was pressed rather than over it, for a button at the top of the window. */ below?: boolean }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [remote, setRemote] = useState<Remote | null>(null);
  const [targets, setTargets] = useState<OpenTarget[]>([]);
  const [ship, setShip] = useState(false);
  const [note, setNote] = useState("");
  // "New branch…" opens the branch card, whose box names a new branch on Enter. It was prompt(), which the desktop app does not
  // have: there the item threw and did nothing.
  const [naming, setNaming] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const engine = state.engines[MAIN_LANE] ?? Object.values(state.engines)[0];
  const branch = engine?.branch ?? remote?.branch ?? "";
  const slug = remote?.github ?? null;
  const changed = state.diffs[MAIN_LANE]?.files.length ?? 0;
  const online = !!engine?.online;
  const go = (path: string) => window.open(`https://github.com/${slug}${path}`, "_blank");

  const items = (): MenuItem[] => [
    { heading: "Git" },
    { label: "Commit changes…", icon: "gitCommit", disabled: !changed || !online, onSelect: () => setShip(true) },
    {
      label: "New branch…",
      icon: "gitBranch",
      disabled: !online,
      onSelect: () => setNaming(true),
    },
    { heading: "GitHub" },
    { label: "Open pull request", icon: "gitPullRequest", disabled: !slug || !branch || DEFAULT_BRANCH.test(branch), onSelect: () => go(`/compare/${encodeURIComponent(branch)}?expand=1`) },
    { label: "Open on GitHub", icon: "external", disabled: !slug, onSelect: () => go(branch ? `/tree/${branch}` : "") },
    { label: "Fork repository", icon: "gitFork", disabled: !slug, onSelect: () => go("/fork") },
    { heading: "Fork" },
    { label: "Fork this session", icon: "gitFork", onSelect: () => void forkSession(sid, invite).then((e) => e && setNote(e)) },
    { label: "Copy session as Markdown", icon: "copy", onSelect: () => dispatchEvent(new CustomEvent("friday:export-markdown", { detail: { how: "copy" } })) },
    branch ? { label: "Copy branch name", icon: "copy", onSelect: () => void navigator.clipboard?.writeText(branch) } : null,
    engine?.cwd ? { label: "Copy path", icon: "copy", onSelect: () => void navigator.clipboard?.writeText(engine.cwd) } : null,
    // The folder in your own editor, file manager or terminal, in the desktop app (desktop-native.ts).
    ...openInItems(targets, engine?.cwd ?? "", setNote),
  ];

  return (
    <>
      <span
        ref={wrap}
        onClick={(e) => {
          if (!clickToo) return;
          const r = e.currentTarget.getBoundingClientRect();
          setAt(at ? null : { x: r.left, y: below ? r.bottom + 4 : r.top - 4 });
          void remoteOf(sid, invite).then(setRemote);
          void openTargets().then(setTargets);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setAt({ x: e.clientX, y: e.clientY });
          void remoteOf(sid, invite).then(setRemote);
          void openTargets().then(setTargets);
        }}
      >
        {children}
        {at && <ContextMenu compact at={at} items={items} onClose={() => setAt(null)} />}
        {note && (
          <span className="muted small" role="status" onClick={() => setNote("")}>
            {note}
          </span>
        )}
      </span>
      {/* Outside the span: a press inside either one would otherwise reach the span's own click and open the menu over it. */}
      {ship && <ShipDialog state={state} sid={sid} invite={invite} send={send} lane={MAIN_LANE} onClose={() => setShip(false)} />}
      {naming && <BranchCard sid={sid} invite={invite} send={send} lane={MAIN_LANE} {...(branch ? { current: branch } : {})} trigger={wrap.current} onClose={() => setNaming(false)} />}
    </>
  );
}
