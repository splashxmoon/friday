/**
 * Proof clips for this session, in its settings (Arun, 2026-11-22: "be smart when we show these clips… toggle them in a session",
 * "an option where the user can either click to see the proof after the task was done… lets be customizable"): Automatically, When I
 * ask, or Off, for everyone in it; "as in Settings" until somebody picks, said so. Recording uses no coding tool's usage.
 */
import { useEffect, useState } from "react";
import { CLIP_MODE_WORDS, sessionClips, setSessionClips, type ClipMode, type SessionClips } from "./proof-clips.js";

const MODES: ClipMode[] = ["auto", "ask", "off"];

export function ClipModeRow({ sid, invite }: { sid: string; invite: string }) {
  const [c, setC] = useState<SessionClips | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    void sessionClips(sid, invite).then((r) => live && setC(r), () => {});
    return () => void (live = false);
  }, [sid, invite]);
  // Only the IDE's chats take proof (Arun, 2026-11-25): nothing to set anywhere else.
  if (!c || c.ide === false) return null;
  const pick = (mode: ClipMode | "settings") => {
    setErr("");
    void setSessionClips(sid, invite, mode).then(setC, (e: Error) => setErr(e.message));
  };
  return (
    <div className="set-row">
      <div>
        <div className="set-label">Proof clips</div>
        <div className="muted small">
          {c.mode === "auto" ? "Recorded by themselves when work nobody watched changes a page." : c.mode === "ask" ? "Only when you press Record a proof clip on finished work." : "None recorded in this session."}{" "}
          {c.own ? (
            <button type="button" className="link-btn" onClick={() => pick("settings")}>
              Use Settings ({CLIP_MODE_WORDS[c.settings].toLowerCase()})
            </button>
          ) : (
            "As in Settings."
          )}
          {err && <span className="error"> {err}</span>}
        </div>
      </div>
      <div className="hist-filters" role="radiogroup" aria-label="Proof clips in this session">
        {MODES.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={c.mode === m} className={`hist-chip ${c.mode === m ? "on" : ""}`} onClick={() => pick(m)}>
            {m === "auto" ? "Auto" : m === "ask" ? "Ask" : "Off"}
          </button>
        ))}
      </div>
    </div>
  );
}
