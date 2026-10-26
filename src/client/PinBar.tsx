import { useEffect, useMemo, useRef, useState } from "react";
import { driverOf, type SessionState } from "../session/projection.js";
import type { Member } from "../types.js";
import { Icon } from "./icons.js";
import { useDismiss } from "./ui.js";
import type { Send } from "./useSession.js";

/**
 * Files and folders pinned as context.
 *
 * What the agent should always start with — the style guide, the schema, the
 * folder the change belongs in — without being pasted into every message. The
 * pins are read fresh at the start of each run, so they are never stale, and
 * they are the team's, not one person's: anyone who is driving or owns the
 * session can change them and everyone can see what the agent has been given.
 */
export function PinBar({ state, me, sid, invite, send, lane, open, onClose }: { state: SessionState; me: Member; sid: string; invite: string; send: Send; lane: string; open: boolean; onClose: () => void }) {
  const may = me.role === "owner" || driverOf(state, lane)?.id === me.id;
  if (!state.pins.length && !open) return null;
  return (
    <div className="pinbar">
      <span className="pinbar-label">
        <Icon name="link" size={12} /> Pinned
      </span>
      {state.pins.map((p) => (
        <span key={p} className="pin-chip" title={p}>
          <span className="pin-name">{p}</span>
          {may && (
            <button type="button" aria-label={`Unpin ${p}`} onClick={() => void send({ type: "pin.remove", path: p })}>
              <Icon name="x" size={11} />
            </button>
          )}
        </span>
      ))}
      {open && may && <PinPicker sid={sid} invite={invite} pinned={state.pins} onPin={(p) => void send({ type: "pin.add", path: p })} onClose={onClose} />}
    </div>
  );
}

function PinPicker({ sid, invite, pinned, onPin, onClose }: { sid: string; invite: string; pinned: string[]; onPin: (p: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const [q, setQ] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    fetch(`/api/sessions/${encodeURIComponent(sid)}/repo?op=tree&invite=${encodeURIComponent(invite)}`, { credentials: "same-origin" })
      .then((r) => r.json())
      .then((j: { output?: string }) => setFiles((j.output ?? "").split("\n").slice(1).map((l) => l.trim()).filter(Boolean)))
      .catch(() => setFiles([]));
  }, [sid, invite]);
  const hits = useMemo(() => {
    const n = q.trim().toLowerCase();
    return files.filter((f) => !pinned.includes(f) && (!n || f.toLowerCase().includes(n))).slice(0, 7);
  }, [files, q, pinned]);
  const choose = (p: string) => {
    onPin(p);
    onClose();
  };
  return (
    <div ref={ref} className="pin-picker">
      <input
        aria-label="File or folder to pin"
        autoFocus
        value={q}
        placeholder="Type a file or folder (end a folder with /)"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && q.trim()) {
            e.preventDefault();
            choose(hits[0] && !q.endsWith("/") ? hits[0] : q.trim());
          }
        }}
      />
      {hits.map((f) => (
        <button key={f} type="button" className="pin-hit" onClick={() => choose(f)}>
          <Icon name="file" size={13} /> {f}
        </button>
      ))}
      {!hits.length && q.trim() && (
        <button type="button" className="pin-hit" onClick={() => choose(q.trim())}>
          <Icon name="plus" size={13} /> Pin “{q.trim()}”
        </button>
      )}
    </div>
  );
}
