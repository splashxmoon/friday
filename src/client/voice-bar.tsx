import { Icon } from "./icons.js";
import { openSettings } from "./openSettings.js";
import { clock, mb } from "./voice-text.js";
import type { Voice } from "./VoiceMic.js";

/**
 * The box footer's left side while voice has something to say (VoiceMic.tsx VoiceBar): listening, with the time and a meter;
 * writing it down; the download's offer and its progress; or one line on what happened. Loaded with the engine, not the app.
 */

/** Seven thin bars, each the loudness of a tenth of a second, still when nothing is said. Nothing loops. */
function Meter({ levels }: { levels: number[] }) {
  return (
    <span className="voice-meter" aria-hidden="true">
      {levels.map((l, i) => (
        <i key={i} style={{ height: `${3 + Math.round(Math.min(1, Math.sqrt(l / 0.15)) * 11)}px` }} />
      ))}
    </span>
  );
}

export default function VoiceBarView({ v }: { v: Voice }) {
  const p = v.phase;
  if (p.kind === "idle") return null;
  // The buttons here leave the box its keyboard, and its caret where the words go.
  const keep = (e: { preventDefault(): void }) => e.preventDefault();
  if (p.kind === "listening" || p.kind === "starting")
    return (
      <span className="voice-bar" role="status" aria-live="polite">
        <span className="voice-dot" aria-hidden="true" />
        <span className="voice-word">{p.kind === "starting" ? "Starting the microphone" : `Listening · ${clock(v.ms)}`}</span>
        {p.kind === "listening" && <Meter levels={v.levels} />}
      </span>
    );
  if (p.kind === "finishing")
    return (
      <span className="voice-bar" role="status" aria-live="polite">
        <span className="voice-word muted">Writing it down…</span>
      </span>
    );
  if (p.kind === "offer")
    return (
      <span className="voice-bar" role="group" aria-label="Download the voice model">
        <span className="voice-line" title={`Voice runs on this computer. It needs a one-time ${mb(p.bytes)} download: the speech model (Whisper) from Hugging Face, and the engine that runs it (transformers.js) from jsDelivr's copy of the npm registry. Those are Friday's only calls out for voice; after them, nothing you say leaves this computer.`}>
          One {mb(p.bytes)} download, then your voice stays on this computer.
        </span>
        <button type="button" className="btn small primary voice-act" onMouseDown={keep} onClick={v.download}>
          Download
        </button>
        <button type="button" className="icon-btn tiny voice-x" aria-label="Not now" title="Not now" onMouseDown={keep} onClick={v.cancel}>
          <Icon name="x" size={12} />
        </button>
      </span>
    );
  if (p.kind === "downloading")
    return (
      <span className="voice-bar" role="status">
        <span className="voice-word">Downloading the voice model</span>
        <span className="voice-progress" aria-hidden="true">
          <i style={{ width: `${Math.round((100 * p.got) / Math.max(1, p.bytes))}%` }} />
        </span>
        <span className="voice-word muted">
          {Math.floor(p.got / 1e6)} of {mb(p.bytes)}
        </span>
      </span>
    );
  return (
    <span className={`voice-bar${p.bad ? " bad" : ""}`} role={p.bad ? "alert" : "status"}>
      <span className="voice-line" title={p.text}>
        {p.text}
      </span>
      {p.settings && (
        <button type="button" className="btn small voice-act" onClick={() => (openSettings("voice"), v.cancel())}>
          Settings
        </button>
      )}
      <button type="button" className="icon-btn tiny voice-x" aria-label="Dismiss" title="Dismiss" onMouseDown={keep} onClick={v.cancel}>
        <Icon name="x" size={12} />
      </button>
    </span>
  );
}
