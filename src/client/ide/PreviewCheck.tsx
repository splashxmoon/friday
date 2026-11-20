import { useContext, useRef, useState } from "react";
import { fileUrl, uploadFile } from "../api.js";
import { Icon } from "../icons.js";
import { Lightbox, type LightboxPicture } from "../Lightbox.js";
import { hostApi } from "../local.js";
import type { Send } from "../useSession.js";
import { MAIN_LANE, type DiffFile } from "../../types.js";
import { IdeChatContext } from "./mode.js";
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
interface Result {
  at: number;
  started?: string;
  pages: Page[];
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
export default function PreviewCheck({ files, cwd, sid, invite, lane, endSeq, send, via, offer }: { files: DiffFile[]; cwd: string; sid: string; invite: string; lane: string; endSeq: number; send: Send; via?: "instruct" | "suggest" | null; /** Only the lane's latest changes card starts a check (an older run's files are no longer what the app shows); older ones show what they have. */ offer: boolean }) {
  const identity = useContext(IdeChatContext)?.identity;
  const key = `${sid}.${lane}.${endSeq}`;
  const [result, setResult] = useState<Result | null>(() => read(key));
  const [stage, setStage] = useState("");
  const [err, setErr] = useState("");
  const [big, setBig] = useState<number | null>(null);
  const [sent, setSent] = useState(false);
  /** A re-check that failed leaves the old pictures up; they are marked as old so a pass from before is not read as this one. */
  const [stale, setStale] = useState(false);
  const running = useRef(false);
  if (!identity || !cwd || (!result && !offer)) return null;

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
      const r: Result = { at: Date.now(), ...(plan.started ? { started: plan.started } : {}), pages };
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
        <button type="button" className="pck-go" title="Open the app, take pictures of the pages that changed at a laptop's width and a phone's, and read the console" onClick={() => void run()}>
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
    </div>
  );
}
