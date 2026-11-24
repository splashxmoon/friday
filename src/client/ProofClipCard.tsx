/**
 * A proof clip in the chat (types.ts proof.clip; Arun, 2026-11-21: "add clips to PRs and the phone too also see where else we can
 * intergrate it"; 2026-11-22: "design the proof card better please"). The result card he likes (memory: result-cards-design): the clip as
 * the preview on top, a bold title, what was changed in the agent's words, one muted line of facts, small actions.
 * - The clip plays quietly in a rounded frame, the page and its length on it, and a line under it that fills as it plays with a mark at
 *   each step; a press on the line or a step seeks it, and the step it is at is lit.
 * - Before / After / Phone, when those were recorded; Watch opens it large.
 * One the preview check's card recorded is shown there instead, never twice.
 */
import { useEffect, useRef, useState } from "react";
import type { SessionEvent } from "../types.js";
import { fileUrl } from "./api.js";
import { Icon } from "./icons.js";
import { Lightbox } from "./Lightbox.js";
import { TabRing } from "./presence.js";
import "./proof-clip-card.css";

type Clip = Extract<SessionEvent["body"], { type: "proof.clip" }>;
type Which = "after" | "before" | "phone";

const pageName = (p: string) => (p === "/" ? "the home page" : p);

/** The clips this person put away in a session, by event seq, kept on this computer (fifty a session at most). */
const HIDDEN_KEY = (sid: string) => `friday.proofHidden.${sid}`;
function hiddenClips(sid: string): Set<number> {
  try {
    return new Set((JSON.parse(localStorage.getItem(HIDDEN_KEY(sid)) ?? "[]") as number[]).filter((n) => typeof n === "number"));
  } catch {
    return new Set();
  }
}
function keepHidden(sid: string, seq: number, on: boolean) {
  try {
    const set = hiddenClips(sid);
    if (on) set.add(seq);
    else set.delete(seq);
    localStorage.setItem(HIDDEN_KEY(sid), JSON.stringify([...set].slice(-50)));
  } catch {}
}
const LABEL = { after: "After", before: "Before", phone: "Phone" } as const;

export function ProofClipCard({ ev, sid, invite }: { ev: SessionEvent; sid: string; invite: string }) {
  const c = ev.body as Clip;
  const [which, setWhich] = useState<Which>("after");
  const [big, setBig] = useState(false);
  const [t, setT] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  // Hidden by this person (Arun, 2026-11-22: "allow to dimiss the proof in the chat"): folded to a line that brings it back, kept here.
  const [hidden, setHidden] = useState(() => hiddenClips(sid).has(ev.seq));
  const hide = (on: boolean) => (setHidden(on), keepHidden(sid, ev.seq, on));
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Where the clip is, for the line under it and the lit step: read as it plays, a few times a second.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const on = () => setT(v.currentTime * 1000);
    v.addEventListener("timeupdate", on);
    return () => v.removeEventListener("timeupdate", on);
  }, [which]);
  if (c.type !== "proof.clip" || c.by === "check") return null;
  if (hidden)
    return (
      <div className="pcc-folded">
        <Icon name="play" size={11} />
        <span>
          Proof clip of {pageName(c.page)}
          {c.summary ? ` · ${c.summary}` : ""}
        </span>
        <button type="button" className="link-btn" onClick={() => hide(false)}>
          Show
        </button>
      </div>
    );
  const files: Record<Which, string | undefined> = { after: c.file, before: c.before, phone: c.phone };
  const choices = (["after", "before", "phone"] as Which[]).filter((w) => files[w]);
  const src = fileUrl(sid, invite, files[which]!);
  const total = Math.max(1, c.durationMs);
  const marks = which === "after" ? (c.marks ?? []) : [];
  const at = marks.reduce((n, m, i) => (t >= m.atMs - 150 ? i : n), -1);
  const seek = (ms: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = Math.max(0, ms) / 1000;
    void v.play().catch(() => {});
  };
  const seconds = Math.max(1, Math.round(c.durationMs / 1000));
  const facts = [c.files?.length ? c.files.map((f) => f.split("/").pop()).join(", ") : "", `${seconds}s`, marks.length ? `${marks.length} step${marks.length === 1 ? "" : "s"}` : "", "recorded when the work finished"].filter(Boolean);
  return (
    <section className="pcc" aria-label={`Proof clip of ${pageName(c.page)}`}>
      <div className={`pcc-frame${which === "phone" ? " is-phone" : ""}`}>
        <button type="button" className="pcc-media" aria-label={`Watch the clip of ${pageName(c.page)} large`} onClick={() => setBig(true)}>
          <video key={src} ref={video} src={src} muted loop playsInline autoPlay={!still} preload={still ? "metadata" : "auto"} aria-hidden="true" />
          <span className="pcc-chip pcc-page">
            <Icon name="globe" size={11} /> {c.page}
          </span>
          <span className="pcc-chip pcc-len">{seconds}s</span>
          <span className="pcc-expand" aria-hidden="true">
            <Icon name="expand" size={13} />
          </span>
        </button>
        {/* The line under the clip: how far it has played, a mark at each step; a press seeks. */}
        <div
          className="pcc-line"
          role="slider"
          aria-label="Where the clip is"
          aria-valuemin={0}
          aria-valuemax={seconds}
          aria-valuenow={Math.round(t / 1000)}
          tabIndex={0}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            seek(((e.clientX - r.left) / r.width) * total);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") seek(t + 1000);
            if (e.key === "ArrowLeft") seek(t - 1000);
          }}
        >
          <span className="pcc-fill" style={{ width: `${Math.min(100, (t / total) * 100)}%` }} />
          {marks.map((m, i) => (
            <span key={i} className={`pcc-tick${i <= at ? " on" : ""}`} style={{ left: `${Math.min(100, (m.atMs / total) * 100)}%` }} />
          ))}
        </div>
      </div>

      <div className="pcc-body">
        <div className="pcc-head">
          <h4 className="pcc-title">
            <span className="pcc-badge" aria-hidden="true">
              <Icon name="play" size={10} />
            </span>
            Proof · {pageName(c.page)}
          </h4>
          <button type="button" className="pcc-x" aria-label="Hide this proof clip" title="Hide" onClick={() => hide(true)}>
            <Icon name="x" size={13} />
          </button>
        </div>
        {!!c.summary && <p className="pcc-summary">{c.summary}</p>}
        <p className="pcc-facts">{facts.join(" · ")}</p>

        {marks.length > 0 && (
          <ol className="pcc-steps">
            {marks.map((m, i) => (
              <li key={i}>
                <button type="button" className={i === at ? "on" : ""} aria-current={i === at ? "step" : undefined} onClick={() => seek(m.atMs)}>
                  <span className="pcc-n">{i + 1}</span>
                  <span className="pcc-label">{m.label}</span>
                  <span className="pcc-at">{(m.atMs / 1000).toFixed(1)}s</span>
                </button>
              </li>
            ))}
          </ol>
        )}

        <div className="pcc-acts">
          <button type="button" className="pcc-btn primary" onClick={() => setBig(true)}>
            <Icon name="expand" size={12} /> Watch
          </button>
          {choices.length > 1 && (
            <span className="pcc-seg" role="radiogroup" aria-label="Which clip">
              {choices.map((w) => (
                <button key={w} type="button" role="radio" aria-checked={which === w} className={which === w ? "on" : ""} onClick={() => (setWhich(w), setT(0))}>
                  {LABEL[w]}
                </button>
              ))}
            </span>
          )}
        </div>
      </div>
      {big && (
        <Lightbox
          items={choices.map((w) => ({ src: fileUrl(sid, invite, files[w]!), alt: `${LABEL[w]} · ${pageName(c.page)}`, file: `${w}.webm` }))}
          start={Math.max(0, choices.indexOf(which))}
          onClose={() => setBig(false)}
        />
      )}
    </section>
  );
}

const STAGE_WORDS = { testing: "Running the tests", server: "Finding the dev server", recording: "Walking the page that changed", saving: "Keeping the clip", failed: "" } as const;

/**
 * A proof clip being made, in the chat (types.ts proof.status; Arun, 2026-11-22: "add some status after you click show proof or something in
 * the coding sessions as well"): the working ring, the step it is on, and how long it has taken, counting; gone once the clip lands (or a
 * newer status replaces it). Couldn't be made: why, with Try again.
 */
export function ProofStatusCard({ ev, events, sid, invite, onRetry }: { ev: SessionEvent; events: readonly SessionEvent[]; sid: string; invite: string; onRetry: (lane: string) => void }) {
  const b = ev.body;
  const lane = ev.lane ?? "main";
  const [now, setNow] = useState(Date.now());
  const newer = events.some((e) => e.seq > ev.seq && (e.lane ?? "main") === lane && (e.body.type === "proof.status" || e.body.type === "proof.clip" || e.body.type === "proof.tests"));
  const failed = b.type === "proof.status" && b.stage === "failed";
  // Counting while it works; a status left over from a recording that never finished (Friday closed) stops showing after ten minutes.
  const stale = !failed && Date.now() - ev.ts > 10 * 60_000;
  useEffect(() => {
    if (newer || failed || stale) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [newer, failed, stale]);
  if (b.type !== "proof.status" || newer || stale) return null;
  void sid;
  void invite;
  // From the first step of this recording: the statuses since the lane's last clip.
  const since = events.filter((e) => e.seq <= ev.seq && (e.lane ?? "main") === lane && (e.body.type === "proof.status" || e.body.type === "proof.clip"));
  const lastClip = since.findLastIndex((e) => e.body.type === "proof.clip" || (e.body.type === "proof.status" && e.body.stage === "failed" && e.seq !== ev.seq));
  const started = since[lastClip + 1]?.ts ?? ev.ts;
  const secs = Math.max(0, Math.round(((failed ? ev.ts : now) - started) / 1000));
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  return (
    <div className={`pcs${failed ? " is-failed" : ""}`} role="status" aria-live="polite">
      <span className="pcs-mark" aria-hidden="true">
        {failed ? <Icon name="x" size={11} /> : <TabRing state="working" />}
      </span>
      <span className="pcs-text">
        <span className="pcs-title">{b.tests ? (failed ? "Couldn't test it" : "Testing it") : failed ? "No proof clip this time" : "Recording a proof clip"}</span>
        <span className="pcs-sub">{failed ? b.why || "It couldn't be made." : b.stage === "testing" && b.command ? `Running ${b.command}…` : `${STAGE_WORDS[b.stage]}…`}</span>
      </span>
      {failed && !b.tests ? (
        <button type="button" className="pcc-btn" onClick={() => onRetry(lane)}>
          Try again
        </button>
      ) : failed ? null : (
        <span className="pcs-clock">{clock}</span>
      )}
    </div>
  );
}
