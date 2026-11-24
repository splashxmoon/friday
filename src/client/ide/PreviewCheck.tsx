import { useContext, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { fileUrl, uploadFile } from "../api.js";
import { Icon } from "../icons.js";
import { Lightbox, type LightboxPicture } from "../Lightbox.js";
import { hostApi } from "../local.js";
import { openSettings } from "../openSettings.js";
import { postProofClip, PROOF_CLIPS_DEFAULT, useProofClips } from "../proof-clips.js";
import type { Identity } from "../storage.js";
import { Segmented } from "../ui.js";
import type { Send } from "../useSession.js";
import { MAIN_LANE, type DiffFile } from "../../types.js";
import { IdeChatContext } from "./mode.js";
import { clipName } from "../../preview-check.js";
import { checkSummary, fixErrorsText, pagesWord } from "./preview-check-text.js";
import "./preview-check.css";

/** One page as it was looked at: its pictures are files of the session (fileUrl), so they outlive the page's reload. */
interface Page {
  path: string;
  url: string;
  shots: { label: string; width: number; height: number; file: string; /** What it is called when downloaded. */ name?: string; cut?: boolean }[];
  errors: string[];
  consoleChecked: boolean;
  /** Why the page couldn't be looked at (all of it, or the pictures after the first): not a console error, so never sent to the agent. */
  failed?: string;
}
/** Which clip: the change walked through, the page before it, or the change at a phone's width. */
type ClipLabel = "after" | "before" | "phone";
/** A proof clip of the first page: a session file too (a WebM), with how long it runs and its captions with their times. */
interface Clip {
  label: ClipLabel;
  page: string;
  file: string;
  name: string;
  durationMs: number;
  marks: { atMs: number; label: string }[];
}
interface Result {
  at: number;
  started?: string;
  pages: Page[];
  clips?: Clip[];
  /** The one clip a check made before there were several (2026-11-21, first version): read as the "after" one. */
  clip?: Omit<Clip, "label" | "marks">;
  /** Why a clip wasn't made, said under the pictures: never a reason to fail the check. */
  clipFailed?: string;
  clipNotes?: string[];
  /** The person has proof clips turned off (Settings › Coding tools): said once, with the way back. */
  clipsOff?: boolean;
}
interface Plan {
  pages: string[];
  url: string | null;
  starting?: boolean;
  started?: string;
  error?: string;
}
interface Look {
  shots: { label: string; width: number; height: number; mimeType: string; data: string; cut?: boolean }[];
  errors: string[];
  consoleChecked: boolean;
  error?: string;
}
type Recorded = { data: string; mimeType: string; width: number; height: number; durationMs: number; marks: { atMs: number; label: string }[]; stops: number[]; /** The same walk as a GIF, base64 (pull requests). */ gif?: string; /** And as H.264 in an MP4, base64, for an iPhone (the desktop app records one). */ mp4?: string } | { error: string };
const CLIP_WORDS: Record<ClipLabel, string> = { after: "After", before: "Before", phone: "Phone" };
const clipsOf = (r: Result): Clip[] => r.clips ?? (r.clip ? [{ ...r.clip, label: "after", marks: [] }] : []);
/**
 * A session file as a blob of this page. The files route answers whole files, without byte ranges, and a video a browser can't ask
 * for by range can't seek: the step list and the large view's bar need it to. Clips are a few hundred KB, a few MB at most.
 */
function useBlobUrl(src: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    let gone = false;
    setUrl(null);
    void fetch(src, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => (gone ? undefined : ((made = URL.createObjectURL(b)), setUrl(made))))
      // Not fetched: played straight from the route, which still plays, only without seeking.
      .catch(() => !gone && setUrl(src));
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [src]);
  return url;
}
/** "0:07" */
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

const KEY = "friday.previewchk.";
const done = new Map<string, Result>();
const read = (k: string): Result | null => {
  if (done.has(k)) return done.get(k)!;
  try {
    const r = JSON.parse(localStorage.getItem(KEY + k) ?? "null") as Result | null;
    if (r && Array.isArray(r.pages)) return (done.set(k, r), r);
  } catch {}
  return null;
};
/** Most checks kept in this browser: the oldest go (each holds only addresses and file ids, but they add up over months). */
const KEEP = 30;
const keep = (k: string, r: Result | null) => {
  if (r) done.set(k, r);
  else done.delete(k);
  try {
    if (r) localStorage.setItem(KEY + k, JSON.stringify(r));
    else localStorage.removeItem(KEY + k);
    const all: string[] = JSON.parse(localStorage.getItem(KEY + "index") ?? "[]");
    const next = all.filter((x) => x !== k);
    if (r) next.push(k);
    for (const old of next.splice(0, Math.max(0, next.length - KEEP))) {
      localStorage.removeItem(KEY + old);
      done.delete(old);
    }
    localStorage.setItem(KEY + "index", JSON.stringify(next));
  } catch {}
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const joinUrl = (base: string, path: string) => base.replace(/\/$/, "") + path;

/**
 * "Check it in the preview", under a Code chat's changes card (Arun, 2026-11-19, wave 3: "Preview checks: after a change, Friday
 * opens the app's preview, clicks through what changed and shows you screenshots before you look."). One press finds the project's
 * dev server (or starts it, as the Preview's own start does), works out which pages the changed files are (src/preview-check.ts),
 * takes each at a laptop's width and a phone's while reading the console (src/runner/preview-check.ts), and shows a compact card:
 * thumbnails that open large, whether the console was clean (with "Fix with Friday" when it wasn't), and the page addresses.
 */
type Props = { files: DiffFile[]; cwd: string; sid: string; invite: string; lane: string; endSeq: number; send: Send; via?: "instruct" | "suggest" | null; /** Only the lane's latest changes card starts a check (an older run's files are no longer what the app shows); older ones show what they have. */ offer: boolean };
export default function PreviewCheck(props: Props) {
  const identity = useContext(IdeChatContext)?.identity;
  if (!identity || !props.cwd) return null;
  return <CheckCard {...props} identity={identity} />;
}

function CheckCard({ files, cwd, sid, invite, lane, endSeq, send, via, offer, identity }: Props & { identity: Identity }) {
  const key = `${sid}.${lane}.${endSeq}`;
  const [result, setResult] = useState<Result | null>(() => read(key));
  const [stage, setStage] = useState("");
  const [err, setErr] = useState("");
  const [big, setBig] = useState<number | null>(null);
  const [sent, setSent] = useState(false);
  /** A re-check that failed leaves the old pictures up; they are marked as old so a pass from before is not read as this one. */
  const [stale, setStale] = useState(false);
  const running = useRef(false);
  // Proof clips on or off, and which (Settings › Coding tools; Arun, 2026-11-21: "and can be toggled on or off"), read at the moment a check records.
  const proof = useProofClips(identity);
  const proofNow = useRef(proof);
  proofNow.current = proof;
  const [view, setView] = useState<ClipLabel>("after");
  const [bigClip, setBigClip] = useState(false);
  const tile = useRef<HTMLVideoElement>(null);
  if (!result && !offer) return null;

  const call = <T,>(op: string, body: object) => hostApi<T>(identity, `/api/runner/preview.check.${op}`, { method: "POST", body: JSON.stringify(body) });

  const run = async () => {
    if (running.current) return;
    running.current = true;
    setErr("");
    setSent(false);
    try {
      setStage("Finding the dev server…");
      // A linked computer may give up on the first call while the server is still starting: it is then found on the next one.
      let plan: Plan | null = null;
      for (let i = 0; i < 8; i++) {
        const asked = await call<Plan>("plan", { cwd, files: files.filter((f) => f.status !== "deleted").map((f) => f.path) }).catch((e: Error) => e);
        // The first few failures are taken for a server still coming up; after that, what it said.
        plan = asked instanceof Error ? { pages: [], url: null, ...(i >= 3 ? { error: asked.message } : {}) } : asked;
        if (plan.url || plan.error) break;
        setStage("Starting the dev server…");
        await sleep(2500);
      }
      if (!plan?.url) throw new Error(plan?.error || "The dev server didn't come up. Start it in the Preview, then check again.");
      const pages: Page[] = [];
      for (const path of plan.pages) {
        setStage(`Looking at ${path}…`);
        const url = joinUrl(plan.url, path);
        const look = await call<Look>("look", { url });
        if (look.error && !look.shots.length) {
          if (!pages.length) throw new Error(look.error);
          pages.push({ path, url, shots: [], errors: [], consoleChecked: false, failed: look.error });
          continue;
        }
        const shots: Page["shots"] = [];
        for (const s of look.shots) {
          const name = `${s.label.toLowerCase()}${path.replace(/[^\w]+/g, "-")}.${s.mimeType === "image/png" ? "png" : "jpg"}`;
          const att = await uploadFile(sid, invite, identity.id, { url: `data:${s.mimeType};base64,${s.data}`, mediaType: s.mimeType, filename: name });
          shots.push({ label: s.label, width: s.width, height: s.height, file: att.id, name, ...(s.cut ? { cut: true } : {}) });
        }
        pages.push({ path, url, shots, errors: look.errors, consoleChecked: look.consoleChecked, ...(look.error ? { failed: look.error } : {}) });
      }
      // The proof clips (Arun, 2026-11-21: "1. Speed baseline, Today with Tonight, and proof clips."; then "i want this proof clips to
      // be very advanced.... and can be toggled on or off"): the first page that drew, walked through what changed; then, when the person
      // asked for them, the same page before the change and at a phone's width. A clip that can't be made leaves the pictures as they are.
      const p = proofNow.current ?? PROOF_CLIPS_DEFAULT;
      const clips: Clip[] = [];
      const notes: string[] = [];
      let clipFailed: string | undefined;
      const lead = pages.find((pg) => pg.shots.length);
      let afterGif: string | undefined;
      let beforeGif: string | undefined;
      // Each clip's MP4, when the desktop app could record one: an iPhone on an older iOS plays these and not the WebM.
      const mp4s: Partial<Record<ClipLabel, string>> = {};
      const changed = files.filter((f) => f.status !== "deleted").map((f) => f.path);
      const keepClip = async (label: ClipLabel, rec: Recorded): Promise<Recorded> => {
        if (!("data" in rec) || !lead) return rec;
        const name = label === "after" ? clipName(lead.path) : clipName(lead.path).replace(/^clip/, `clip-${label}`);
        try {
          const att = await uploadFile(sid, invite, identity.id, { url: `data:${rec.mimeType};base64,${rec.data}`, mediaType: rec.mimeType, filename: name });
          clips.push({ label, page: lead.path, file: att.id, name, durationMs: rec.durationMs, marks: rec.marks ?? [] });
          if (rec.mp4) mp4s[label] = rec.mp4;
          return rec;
        } catch (e) {
          return { error: (e as Error).message || "The clip couldn't be kept." };
        }
      };
      const ask = (op: "clip" | "before", body: object) => call<Recorded>(op, body).catch((e: Error) => ({ error: e.message || "The clip couldn't be made." }) as Recorded);
      if (lead && p.on) {
        setStage(`Recording a walk through ${lead.path}…`);
        const after = await keepClip("after", await ask("clip", { url: lead.url, cwd, files: changed }));
        if ("error" in after) clipFailed = after.error;
        else afterGif = after.gif;
        if (p.before) {
          setStage("Recording the page before the change…");
          const before = await keepClip("before", await ask("before", { url: lead.url, cwd, files: changed, ...("stops" in after ? { stops: after.stops } : {}) }));
          if ("error" in before) notes.push(`No before clip: ${before.error.replace(/\.$/, "")}.`);
          else beforeGif = before.gif;
        }
        if (p.phone) {
          setStage("Recording it at a phone's width…");
          const phone = await keepClip("phone", await ask("clip", { url: lead.url, cwd, files: changed, width: "phone" }));
          if ("error" in phone) notes.push(`No phone clip: ${phone.error.replace(/\.$/, "")}.`);
        }
      }
      // Kept in the chat as a proof.clip (Arun, 2026-11-21: "add clips to PRs and the phone too"), with the walk's GIF, so the phone, the
      // log and a pull request opened from here can show it. A clip that can't be kept there is said, never a failed check.
      const after = clips.find((c) => c.label === "after");
      if (after && lead) {
        try {
          let gif: string | undefined;
          if (afterGif) gif = (await uploadFile(sid, invite, identity.id, { url: `data:image/gif;base64,${afterGif}`, mediaType: "image/gif", filename: clipName(lead.path).replace(/\.webm$/, ".gif") })).id;
          // The page before the change as a GIF too, for the pull request's side by side.
          const gifBefore = beforeGif ? (await uploadFile(sid, invite, identity.id, { url: `data:image/gif;base64,${beforeGif}`, mediaType: "image/gif", filename: clipName(lead.path).replace(/^clip/, "clip-before").replace(/\.webm$/, ".gif") })).id : undefined;
          const before = clips.find((c) => c.label === "before");
          const phone = clips.find((c) => c.label === "phone");
          // The MP4s beside them, named as the WebMs are: clip-<page>.mp4, clip-before-<page>.mp4, clip-phone-<page>.mp4.
          const mp4Id = async (label: ClipLabel) => {
            const data = mp4s[label];
            const c = clips.find((x) => x.label === label);
            return data && c ? (await uploadFile(sid, invite, identity.id, { url: `data:video/mp4;base64,${data}`, mediaType: "video/mp4", filename: c.name.replace(/\.webm$/, ".mp4") })).id : undefined;
          };
          const [mp4, mp4Before, mp4Phone] = [await mp4Id("after"), await mp4Id("before"), await mp4Id("phone")];
          await postProofClip(sid, invite, { page: after.page, file: after.file, durationMs: after.durationMs, ...(after.marks.length ? { marks: after.marks } : {}), ...(before ? { before: before.file } : {}), ...(phone ? { phone: phone.file } : {}), ...(gif ? { gif } : {}), ...(gifBefore ? { gifBefore } : {}), ...(mp4 ? { mp4 } : {}), ...(mp4Before ? { mp4Before } : {}), ...(mp4Phone ? { mp4Phone } : {}), lane });
        } catch (e) {
          notes.push(`The clip couldn't be kept in the chat: ${((e as Error).message || "it didn't go through").replace(/\.$/, "")}.`);
        }
      }
      const r: Result = {
        at: Date.now(),
        ...(plan.started ? { started: plan.started } : {}),
        pages,
        ...(clips.length ? { clips } : {}),
        ...(clipFailed ? { clipFailed } : {}),
        ...(notes.length ? { clipNotes: notes } : {}),
        ...(lead && !p.on ? { clipsOff: true } : {}),
      };
      setView("after");
      keep(key, r);
      setResult(r);
      setStale(false);
    } catch (e) {
      setErr((e as Error).message || "The check couldn't run.");
      setStale(true);
    } finally {
      running.current = false;
      setStage("");
    }
  };

  const clear = () => {
    keep(key, null);
    setResult(null);
    setErr("");
    setStale(false);
  };

  if (stage) {
    return (
      <div className="pck pck-row" role="status">
        <span className="pck-dot" aria-hidden="true" />
        <span className="pck-stage">{stage}</span>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="pck pck-row">
        <button type="button" className="pck-go" title="Open the app, take pictures of the pages that changed at a laptop's width and a phone's, record a short clip, and read the console" onClick={() => void run()}>
          <Icon name="eye" size={13} /> Check it in the preview
        </button>
        {err && (
          <span className="pck-err" role="alert">
            {err}
          </span>
        )}
      </div>
    );
  }

  const sum = stale ? { text: "Earlier check, out of date", tone: "none" as const } : checkSummary(result.pages);
  const pics: LightboxPicture[] = result.pages.flatMap((p) => p.shots.map((s) => ({ src: fileUrl(sid, invite, s.file), alt: `${p.path}, ${s.label.toLowerCase()}`, file: s.name ?? s.file })));
  let n = 0;
  // The clip shown leads the card: the change walked through, unless the person picked the page before it or the phone's.
  const clips = clipsOf(result);
  const shown = clips.find((c) => c.label === view) ?? clips[0];
  const pair = clips.find((c) => c.label === "after") && clips.find((c) => c.label === "before") ? { after: clips.find((c) => c.label === "after")!, before: clips.find((c) => c.label === "before")! } : null;
  const seek = (ms: number) => {
    const v = tile.current;
    if (!v) return;
    v.currentTime = ms / 1000;
    void v.play().catch(() => {});
  };
  const bad = result.pages.filter((p) => p.errors.length);
  return (
    <div className="pck">
      <div className="pck-head">
        <Icon name="eye" size={13} />
        <b>Preview check</b>
        <span className="pck-sum" data-tone={sum.tone}>
          {sum.text}
        </span>
        <span className="pck-sp" />
        <button type="button" className="pck-btn pck-x" aria-label="Check again" title={`Look at ${pagesWord(result.pages.length)} again`} onClick={() => void run()}>
          <Icon name="refresh" size={12} />
        </button>
        <button type="button" className="pck-btn pck-x" aria-label="Close the check" title="Close" onClick={clear}>
          <Icon name="x" size={12} />
        </button>
      </div>
      {err && (
        <p className="pck-err pck-lead" role="alert">
          {err}
        </p>
      )}
      {shown && (
        <div className="pck-clipbox">
          {clips.length > 1 && <Segmented<ClipLabel> value={shown.label} onChange={setView} options={clips.map((c) => [c.label, CLIP_WORDS[c.label]] as [ClipLabel, string])} className="pck-seg" />}
          <ClipTile key={shown.file} ref={tile} src={fileUrl(sid, invite, shown.file)} page={shown.page} label={shown.label} seconds={Math.max(1, Math.round(shown.durationMs / 1000))} onOpen={() => setBigClip(true)} />
          {shown.marks.length > 0 && (
            <ol className="pck-steps" aria-label="What the clip shows">
              {shown.marks.map((m) => (
                <li key={`${m.atMs}${m.label}`}>
                  <button type="button" className="pck-step" title="Play from here" onClick={() => seek(m.atMs)}>
                    <span className="pck-step-t">{clock(m.atMs)}</span>
                    <span className="pck-step-l">{m.label}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      <ul className="pck-pages">
        {result.pages.map((p) => (
          <li key={p.path} className="pck-page">
            <span className="pck-url" title={p.url}>
              {p.url.replace(/^https?:\/\//, "")}
            </span>
            <div className="pck-thumbs">
              {p.shots.map((s) => {
                const at = n++;
                return (
                  <button type="button" key={s.label} className={`pck-thumb ${s.label === "Phone" ? "phone" : "wide"}`} title={`${s.label}, ${s.width} wide${s.cut ? " (the page goes on below)" : ""}: open large`} onClick={() => setBig(at)}>
                    <img src={fileUrl(sid, invite, s.file)} alt={`${p.path}, ${s.label.toLowerCase()}`} loading="lazy" />
                    <span className="pck-cap">{s.label}</span>
                  </button>
                );
              })}
              {!p.shots.length && <span className="pck-none">No pictures.</span>}
            </div>
            {p.failed && <span className="pck-none">{p.failed}</span>}
          </li>
        ))}
      </ul>
      {result.clipFailed && !stale && <p className="pck-note">No clip this time: {result.clipFailed.replace(/\.$/, "")}.</p>}
      {!stale && result.clipNotes?.map((t) => (
        <p key={t} className="pck-note">
          {t}
        </p>
      ))}
      {result.clipsOff && !stale && (
        <p className="pck-note">
          Proof clips are off ·{" "}
          <button type="button" className="link-btn" onClick={() => openSettings("coding-tools")}>
            Settings
          </button>
        </p>
      )}
      {result.started && <p className="pck-note">Friday started the preview ({result.started}) for this check and left it running.</p>}
      {bad.length > 0 && (
        <div className="pck-errors">
          {bad.map((p) => (
            <div key={p.path} className="pck-e">
              <span className="pck-e-page">{p.path}</span>
              {p.errors.map((e, i) => (
                <code key={i}>{e}</code>
              ))}
            </div>
          ))}
          {via && (
            <div className="pck-fix">
              <button
                type="button"
                className="pck-btn pri"
                disabled={sent}
                onClick={() =>
                  void send({ type: via, text: fixErrorsText(bad), ...(lane !== MAIN_LANE ? { lane } : {}) }).then((r) => (r.ok ? setSent(true) : setErr(r.error ?? "Couldn't send it. Try again.")))
                }
              >
                {sent ? (via === "instruct" ? "Sent to the agent" : "Suggested") : via === "instruct" ? "Fix with Friday" : "Suggest a fix"}
              </button>
            </div>
          )}
        </div>
      )}
      {!result.pages.every((p) => p.consoleChecked) && bad.length === 0 && <p className="pck-note">This Friday app can take the pictures but not read the console yet. Update it to see console errors here.</p>}
      {big !== null && <Lightbox items={pics} start={big} onClose={() => setBig(null)} />}
      {bigClip && shown && <ClipView clips={pair && shown.label !== "phone" ? [pair.before, pair.after] : [shown]} src={(c) => fileUrl(sid, invite, c.file)} onClose={() => setBigClip(false)} />}
    </div>
  );
}

/**
 * The clip as the card's lead tile: playing, muted and looping, the way a moving thumbnail does; a press opens it large with its
 * controls. Someone who asked the system for less motion gets its first frame and plays it themselves.
 */
function ClipTile({ ref, src: file, page, label, seconds, onOpen }: { ref: RefObject<HTMLVideoElement | null>; src: string; page: string; label: ClipLabel; seconds: number; onOpen: () => void }) {
  const src = useBlobUrl(file) ?? undefined;
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const what = label === "before" ? "before the change" : label === "phone" ? "at a phone's width" : "walked through what changed";
  return (
    <button type="button" className={`pck-thumb pck-clip${label === "phone" ? " phone" : ""}`} title={`A ${seconds}-second clip of ${page}, ${what}: open large`} onClick={onOpen}>
      <video ref={ref} src={src} muted loop playsInline autoPlay={!still} preload={still ? "metadata" : "auto"} aria-label={`${page}, ${what}, ${seconds} seconds`} />
      <span className="pck-cap">
        <Icon name="play" size={9} /> {label === "after" ? "Clip" : CLIP_WORDS[label]} · {seconds}s
      </span>
    </button>
  );
}

/**
 * The clip large, in front of everything, with its controls. With the page before the change too, the two play side by side and in
 * step: the after clip leads (play, pause, seek, speed), and the before clip follows it, so the same moment of the walk is on both.
 */
function ClipView({ clips, src, onClose }: { clips: Clip[]; src: (c: Clip) => string; onClose: () => void }) {
  const lead = useRef<HTMLVideoElement>(null);
  const follow = useRef<HTMLVideoElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const two = clips.length === 2;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    window.addEventListener("keydown", key, true);
    return () => (window.removeEventListener("keydown", key, true), before?.focus?.());
  }, [onClose]);
  useEffect(() => {
    const a = lead.current;
    const b = follow.current;
    if (!two || !a || !b) return;
    const sync = () => {
      b.playbackRate = a.playbackRate;
      if (Math.abs(b.currentTime - a.currentTime) > 0.25 && a.currentTime <= (b.duration || Infinity)) b.currentTime = a.currentTime;
      if (a.paused !== b.paused) void (a.paused ? b.pause() : b.play().catch(() => {}));
    };
    const evs = ["play", "pause", "seeked", "ratechange", "timeupdate"] as const;
    for (const e of evs) a.addEventListener(e, sync);
    return () => evs.forEach((e) => a.removeEventListener(e, sync));
  }, [two]);
  // Before on the left, after on the right, as the change reads.
  const [left, right] = two ? clips : [null, clips[0]!];
  const leftSrc = useBlobUrl(left ? src(left) : src(right!)) ?? undefined;
  const rightSrc = useBlobUrl(src(right!)) ?? undefined;
  return createPortal(
    <div className="lightbox pck-big" role="dialog" aria-modal="true" aria-label={two ? "The page before and after the change" : "Proof clip"} onClick={onClose}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <a className="lightbox-btn" href={src(right!)} download={right!.name} aria-label="Download" title="Download">
          <Icon name="download" size={16} />
        </a>
        <button ref={close} type="button" className="lightbox-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className={`pck-big-row${two ? " two" : ""}${right!.label === "phone" ? " phone" : ""}`} onClick={(e) => e.stopPropagation()}>
        {left && (
          <figure className="pck-big-fig">
            <video ref={follow} src={leftSrc} muted playsInline aria-label={`${left.page}, before the change`} />
            <figcaption>Before</figcaption>
          </figure>
        )}
        <figure className="pck-big-fig">
          <video ref={lead} src={rightSrc} controls autoPlay playsInline muted aria-label={`${right!.page}, ${right!.label === "phone" ? "at a phone's width" : "after the change"}`} />
          <figcaption>{two ? "After" : right!.label === "phone" ? "Phone" : right!.page}</figcaption>
        </figure>
      </div>
    </div>,
    document.body,
  );
}
