import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.js";

/**
 * The quick prompt's page (desktop/quick.ts): what the floating window shows. A line for the task, a Snapshot of the screen
 * to go with it, Enter to send it to the session Friday has open (or a new one) and bring Friday forward, Esc to put the box
 * away. Bare: no shell, no sidebar; the window is the box.
 */

type Snapshot = { data: string; mimeType: string; width: number; height: number };
type Quick = { send: (text: string, snapshot?: Snapshot) => Promise<boolean>; snapshot: () => Promise<Snapshot | { error: string }>; close: () => Promise<boolean>; onShown: (fn: () => void) => () => void };

const quickApi = (): Quick | undefined => (window as unknown as { fridayDesktop?: { quick?: Quick } }).fridayDesktop?.quick;

export function QuickPrompt() {
  const [text, setText] = useState("");
  const [shot, setShot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<"shot" | "send" | "">("");
  const [err, setErr] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const q = quickApi();
  // Shown again: the words from last time are gone, the box is focused.
  useEffect(() => {
    box.current?.focus();
    return q?.onShown(() => {
      setText("");
      setShot(null);
      setErr("");
      requestAnimationFrame(() => box.current?.focus());
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const snapshot = async () => {
    if (!q) return;
    setBusy("shot");
    setErr("");
    const r = await q.snapshot();
    setBusy("");
    if ("error" in r) return setErr(r.error);
    setShot(r);
    box.current?.focus();
  };
  const send = async () => {
    if (!q || (!text.trim() && !shot)) return;
    setBusy("send");
    const ok = await q.send(text.trim(), shot ?? undefined);
    setBusy("");
    if (!ok) setErr("Friday's window isn't open to take it.");
    else {
      setText("");
      setShot(null);
    }
  };
  const mac = /Mac/.test(navigator.platform);
  return (
    <div className="quick-page" role="dialog" aria-label="Quick prompt">
      <div className="quick-box">
        <div className="quick-row">
          <textarea
            ref={box}
            value={text}
            rows={2}
            placeholder={shot ? "What should the agent do with this?" : "Tell your agent what to do…"}
            aria-label="Your task"
            maxLength={8000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") void q?.close();
              else if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), void send());
              else if (e.key.toLowerCase() === "s" && e.shiftKey && (e.metaKey || e.ctrlKey)) (e.preventDefault(), void snapshot());
            }}
          />
          {shot && (
            <span className="quick-shot" title={`${shot.width}×${shot.height} screen capture, attached to the message`}>
              <img src={`data:${shot.mimeType};base64,${shot.data}`} alt="" />
              <button type="button" className="quick-shot-x" aria-label="Drop the snapshot" onClick={() => setShot(null)}>
                <Icon name="x" size={11} />
              </button>
            </span>
          )}
        </div>
        <div className="quick-foot">
          <button type="button" className="btn ghost small" disabled={busy === "shot"} title={`Capture the screen the cursor is on (${mac ? "⌘⇧S" : "Ctrl+Shift+S"})`} onClick={() => void snapshot()}>
            <Icon name="image" size={13} /> {busy === "shot" ? "Capturing…" : shot ? "Snapshot again" : "Snapshot"}
          </button>
          <span className="quick-hint">{err ? <span className="quick-err">{err}</span> : "Goes to the session you have open, or starts one · Esc to close"}</span>
          <button type="button" className="btn primary small" disabled={busy === "send" || (!text.trim() && !shot)} onClick={() => void send()}>
            {busy === "send" ? "Sending…" : "Send"} <kbd>↵</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
