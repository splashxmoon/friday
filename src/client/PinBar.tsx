import { useEffect, useMemo, useRef, useState } from "react";
import { driverOf, type SessionState } from "../session/projection.js";
import type { Member } from "../types.js";
import { Icon } from "./icons.js";
import { useDismiss } from "./ui.js";
import { foldersOf, treeFiles } from "./treeFiles.js";
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
  const input = useRef<HTMLInputElement>(null);
  useDismiss(ref, onClose);
  const [q, setQ] = useState("");
  // null while the folder is read; then its files and folders, or why there are none.
  const [paths, setPaths] = useState<string[] | null>(null);
  const [why, setWhy] = useState("");
  useEffect(() => {
    fetch(`/api/sessions/${encodeURIComponent(sid)}/repo?op=tree&invite=${encodeURIComponent(invite)}`, { credentials: "same-origin" })
      .then((r) => r.json() as Promise<{ output?: string; error?: string }>)
      .then((j) => {
        // Files and the folders they are in, from a listing; a reason, from anything else ("no folder yet"), said rather than
        // read as a folder with nothing in it (2026-10-28 QA: "sour" offered only Pin "sour", sources.md being there).
        const got = treeFiles(j);
        setPaths([...foldersOf(got.files), ...got.files]);
        setWhy(got.why);
      })
      .catch(() => (setPaths([]), setWhy("The folder couldn't be read just now.")));
  }, [sid, invite]);
  // Opened from the + menu, whose closing hands the focus back to the + after its own fade: whatever takes the focus outside the
  // picker in its first moments gives it back, so typing goes here (a single focus at 60ms lost to the menu's: 2026-10-29 verify).
  useEffect(() => {
    input.current?.focus();
    const back = (e: FocusEvent) => {
      if (!ref.current?.contains(e.target as Node)) input.current?.focus();
    };
    document.addEventListener("focusin", back);
    const t = setTimeout(() => (input.current?.focus(), document.removeEventListener("focusin", back)), 500);
    return () => (clearTimeout(t), document.removeEventListener("focusin", back));
  }, []);
  const n = q.trim().toLowerCase();
  const hits = useMemo(() => {
    if (!paths) return [];
    const rank = (p: string) => (p.toLowerCase().split("/").some((part) => part.startsWith(n)) ? 0 : 1);
    return paths
      .filter((f) => !pinned.includes(f) && (!n || f.toLowerCase().includes(n)))
      .sort((a, b) => rank(a) - rank(b) || a.length - b.length)
      .slice(0, 7);
  }, [paths, n, pinned]);
  // A path typed whole that the folder has: pinned as typed. One it hasn't, while the folder's own list is known, isn't offered.
  const typed = q.trim().replace(/^\.\//, "");
  const known = !paths?.length || paths.includes(typed) || paths.includes(`${typed.replace(/\/$/, "")}/`);
  const choose = (p: string) => {
    onPin(p);
    onClose();
  };
  return (
    <div ref={ref} className="pin-picker">
      <input
        ref={input}
        aria-label="File or folder to pin"
        autoFocus
        value={q}
        placeholder="Type a file or folder (end a folder with /)"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
          if (e.key === "Enter" && q.trim()) {
            e.preventDefault();
            // The path as typed when the folder has it, else the best match, else (the folder's list unknown) what was typed.
            if (paths?.length && known) choose(paths.includes(typed) ? typed : `${typed.replace(/\/$/, "")}/`);
            else if (hits[0]) choose(hits[0]);
            else if (known && typed) choose(typed);
          }
        }}
      />
      {paths === null && <p className="pin-note">Reading the folder…</p>}
      {why && <p className="pin-note">{why}</p>}
      {hits.map((f) => (
        <button key={f} type="button" className="pin-hit" onClick={() => choose(f)}>
          <Icon name={f.endsWith("/") ? "folder" : "file"} size={13} /> {f}
        </button>
      ))}
      {!hits.length && typed && known && (
        <button type="button" className="pin-hit" onClick={() => choose(typed)}>
          <Icon name="plus" size={13} /> Pin “{typed}”
        </button>
      )}
      {!hits.length && typed && !known && <p className="pin-note">Nothing called “{typed}” in the session’s folder.</p>}
    </div>
  );
}
