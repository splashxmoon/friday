import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { driverOf, type SessionState } from "../../session/projection.js";
import { type EngineTool, type Member, type SessionEvent } from "../../types.js";
import { Icon } from "../icons.js";
import { prefillComposer, visibleComposer } from "../prefill.js";
import type { Identity } from "../storage.js";
import { useConfirm, type MenuItem } from "../ui.js";
import type { Send } from "../useSession.js";
import { absolute, filesFrom, folderDiffers, rewindConfirm, rewoundNow, touchedDirty, turnLabel, turnsOf, turnSub, unsavedInIde, type Rewound, type Turn } from "./rewind-ide.js";

/**
 * Rewind in Code's column (Arun, 2026-11-19, wave 4: "Rewind an agent run: go back to before any message of a Code chat, files and all,
 * and redo if you change your mind"). The chat's session screen mounts <ColumnRewind> out of sight; it reads the session's events (the
 * checkpoints already in them), asks the confirm, sends the session's own `folder.restore`, and tells the column what it knows
 * through a small store: the slim bar under the tabs (<RewoundBar>) and the "Checkpoints" in the history menu (checkpointItems) read it.
 * A message's own "Rewind to here" sends it a `friday:rewind-to` event, so there is one confirm and one way back.
 */
interface Published {
  turns: Turn[];
  rewound: Rewound | null;
  /** A redo just done, said for a few seconds where the bar was. */
  redone: string | null;
  /** Whether this person may rewind now: an owner or the driver, with nothing running. */
  can: boolean;
  busy: boolean;
  /** Go back to before a message; `onDone` is what the caller wants done once the files are back (the box refilled its own way). */
  goBack: (seq: number, onDone?: () => void) => void;
  redo: () => void;
}

const published = new Map<string, Published>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
function publish(sid: string, p: Published | null) {
  if (p) published.set(sid, p);
  else published.delete(sid);
  listeners.forEach((l) => l());
}

/** What the column knows of a chat's rewinds: its turns and the rewind it stands on. Undefined until the chat has drawn. */
export const useRewindFor = (sid: string | null): Published | undefined => useSyncExternalStore(subscribe, () => (sid ? published.get(sid) : undefined), () => undefined);

/** The history menu's "Checkpoints" for this chat: its turns, newest first, each one a way back. Nothing when it has none. */
export function checkpointItems(sid: string | null, max = Infinity): MenuItem[] {
  const p = sid ? published.get(sid) : undefined;
  if (!p?.turns.length) return [];
  return [
    { heading: "Checkpoints" },
    ...p.turns.slice(0, max).map((t): MenuItem => ({ label: turnLabel(t.text), sub: turnSub(t), hint: "Go back to here", title: `Go back to before “${turnLabel(t.text, 80)}”${p.can ? "" : " (not while it is running)"}`, icon: "rewindTo", disabled: !p.can || p.busy, onSelect: () => p.goBack(t.seq) })),
  ];
}

/** Mounted by the session screen inside Code's column: draws nothing but the confirm, and keeps the store up to date. */
export default function ColumnRewind({ sid, invite, events, state, me, send, notify, identity }: { sid: string; invite: string; events: SessionEvent[]; state: SessionState; me: Member; send: Send; notify: (m: string) => void; identity: Identity }) {
  const [ask, confirmUI] = useConfirm();
  const [busy, setBusy] = useState(false);
  const [redone, setRedone] = useState<string | null>(null);
  const turns = useMemo(() => turnsOf(events), [events]);
  const rewound = useMemo(() => rewoundNow(events), [events]);
  const running = state.run.status === "running" || Object.values(state.laneRuns).some((r) => r.status === "running");
  const can = !running && (me.role === "owner" || turns.some((t) => driverOf(state, t.lane)?.id === me.id));
  // What the buttons do reads the newest of everything, so the published functions never change.
  const now = useRef({ events, turns, rewound, state, send, notify, identity, busy });
  now.current = { events, turns, rewound, state, send, notify, identity, busy };

  /** What the rewind put in the box, so a redo can take it out again if it is still there untouched. */
  const prefilled = useRef("");
  const goBack = useRef((seq: number, onDone?: () => void) => {
    const n = now.current;
    const t = n.turns.find((x) => x.seq === seq);
    if (!t || n.busy) return;
    void (async () => {
      const tool = n.state.engines[t.lane]?.tool as EngineTool | undefined;
      const theirs = filesFrom(n.events, seq);
      // A coding tool's rewind puts back every file that differs from the checkpoint, your own saved edits too, so the folder is asked
      // what that is; with no answer, the agent's own change sets are all that is known and the confirm says so.
      const found = tool ? await folderDiffers(sid, invite, t.lane, t.checkpoint) : null;
      const cwd = n.state.engines[t.lane]?.cwd ?? "";
      const root = found?.root || cwd;
      const files = found ? found.paths : theirs;
      const known = new Set(theirs);
      const mine = found ? found.paths.filter((p) => !known.has(p)) : [];
      // Asked of the IDE just now, so the confirm names what is unsaved at this moment. Both sides as absolute paths.
      const unsaved = await unsavedInIde(n.identity);
      const dirty = found && !files.length ? [] : touchedDirty(unsaved, root ? files.map((p) => absolute(root, p)) : []);
      ask({
        ...rewindConfirm({ files, dirty, tool, exact: !!found, mine }),
        danger: true,
        icon: "rewindTo",
        onConfirm: async () => {
          setBusy(true);
          try {
            const r = await now.current.send({ type: "folder.restore", sha: t.checkpoint, lane: t.lane, rewindTo: t.seq });
            if (!r.ok) return now.current.notify(r.error ?? "Couldn't rewind. The folder may have moved on since; check the Changes panel, then try again.");
            setRedone(null);
            // The message goes back in the box, to change and send again: the caller's way (a quote back as a chip), else as plain text.
            // What went in is remembered so a redo can take it out again if it is still there untouched.
            prefilled.current = t.text;
            if (onDone) onDone();
            else prefillComposer(t.text);
          } finally {
            setBusy(false);
          }
        },
      });
    })();
  }).current;

  const redo = useRef(() => {
    const n = now.current;
    if (!n.rewound?.undo || n.busy) return;
    const r0 = n.rewound;
    setBusy(true);
    void n.send({ type: "folder.restore", sha: r0.undo!, lane: r0.lane }).then((r) => {
      setBusy(false);
      if (!r.ok) return now.current.notify(r.error ?? "Couldn't redo. The folder may have moved on since; check the Changes panel.");
      setRedone(`Redone · ${r0.files} file${r0.files === 1 ? "" : "s"} changed again`);
      // The message the rewind put back in the box is no longer wanted unless it was changed: it was already acted on.
      if (prefilled.current && visibleComposer()?.value === prefilled.current) prefillComposer("");
      prefilled.current = "";
    });
  }).current;

  // A message's own "Rewind to here" (Activity's hover action) comes here for the one confirm.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ sid?: string; seq?: number; handled?: boolean; onDone?: () => void }>).detail;
      if (d?.sid !== sid || typeof d.seq !== "number") return;
      // Only a turn it knows (a message with a checkpoint); anything else is left to the caller's own confirm.
      if (!now.current.turns.some((t) => t.seq === d.seq)) return;
      d.handled = true;
      goBack(d.seq, d.onDone);
    };
    window.addEventListener("friday:rewind-to", on);
    return () => window.removeEventListener("friday:rewind-to", on);
  }, [sid, goBack]);

  useEffect(() => {
    if (!redone) return;
    const t = window.setTimeout(() => setRedone(null), 5000);
    return () => window.clearTimeout(t);
  }, [redone]);

  useEffect(() => {
    publish(sid, { turns, rewound, redone, can, busy, goBack, redo });
  }, [sid, turns, rewound, redone, can, busy, goBack, redo]);
  useEffect(() => () => publish(sid, null), [sid]);
  return <>{confirmUI}</>;
}

/** The slim bar under the tabs: "Rewound · 2 files back · Redo", until the next message. */
export function RewoundBar({ sid }: { sid: string | null }) {
  const p = useRewindFor(sid);
  if (!p) return null;
  if (!p.rewound) return p.redone ? <div className="ia-rewound ia-rewound-done" role="status">{p.redone}</div> : null;
  const n = p.rewound.files;
  return (
    <div className="ia-rewound" role="status" aria-label="Rewound">
      <Icon name="rewindTo" size={13} />
      <span className="ia-rewound-text">
        Rewound · {n ? `${n} file${n === 1 ? "" : "s"} back` : "no files changed"}
      </span>
      {p.rewound.undo && (
        <button type="button" className="ia-from-btn ia-rewound-redo" title="Put the files back as they were before the rewind" disabled={p.busy || !p.can} onClick={p.redo}>
          Redo
        </button>
      )}
    </div>
  );
}
