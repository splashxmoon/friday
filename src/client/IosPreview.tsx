import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type PointerEvent } from "react";
import type { IosBuild, IosInput, IosStatus } from "../runner/ios.js";
import { uploadFile } from "./api.js";
import { Icon } from "./icons.js";
import { hostApi } from "./local.js";
import type { Identity } from "./storage.js";
import type { Send } from "./useSession.js";

/**
 * The Preview panel's iOS side, on a Mac with Xcode: the folder's app built for a simulator and run there, shown as the
 * phone it runs on (Arun, 2026-10-18: "the whole app in the phone, like Xcode's preview"). A bar with the device, the scheme
 * and Run; the phone itself, its screen read a frame at a time, at the panel's size or the device's own; and a toolbar under
 * it to rebuild, keep a screenshot, hand the screen to the agent, or read the build. Touching and typing happen in Simulator,
 * which opens beside the window. The runner does the building (runner/ios.ts).
 */

const STAGE: Record<IosBuild["stage"], string> = {
  booting: "Starting the simulator…",
  building: "Building…",
  installing: "Installing…",
  launching: "Launching…",
  running: "Running",
  failed: "Didn't run",
  stopped: "Stopped",
};
const BUSY = new Set<IosBuild["stage"]>(["booting", "building", "installing", "launching"]);
/** How often the screen is read while the app runs: about as smooth as a frame read through simctl allows. */
const FRAME_MS = 700;
/** Sizes the phone can be shown at, as a share of the device's own size in points (a frame's pixels over three). */
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5];
/** A phone screen this much taller than wide has a Dynamic Island; an older or folding one doesn't. */
const ISLAND_RATIO = 1.9;
/** A press that moves less than this share of the screen is a tap; more, a swipe. */
const TAP_SLOP = 0.02;
/** Keys sent as themselves rather than typed (HID usage codes, as the simulator takes them). */
const KEYS: Record<string, number> = { Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Delete: 76, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82 };
/** The command that makes the screen touchable here, said where it isn't yet. */
const AXE_INSTALL = "brew install cameroncooke/axe/axe";

/** The Home button's mark: a rounded square, like the one on Simulator's own toolbar. */
const HomeMark = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden>
    <rect x="5" y="5" width="14" height="14" rx="4" />
  </svg>
);

export function IosPreview({
  identity,
  cwd,
  elsewhere = [],
  runAsk = 0,
  shown = true,
  sid,
  invite,
  send,
}: {
  identity: Identity;
  cwd: string;
  /** Other folders the agents are working in, most likely first (ios-folders.ts): looked through when `cwd` has no Xcode project. */
  elsewhere?: string[];
  /** Changed by an agent's "Preview: ios": build and run now. */
  runAsk?: number;
  shown?: boolean;
  /** With these, the screen can be handed to the agent. */
  sid?: string | null;
  invite?: string;
  send?: Send;
}) {
  const [status, setStatus] = useState<IosStatus | null>(null);
  const [err, setErr] = useState("");
  const [project, setProject] = useState("");
  const [scheme, setScheme] = useState("");
  const [udid, setUdid] = useState("");
  const [frame, setFrame] = useState("");
  /**
   * The simulator live (runner/ios-live.ts): a page on this Mac's 127.0.0.1 with the screen streaming and input going straight
   * back, shown in the phone's frame. In the desktop app only, which can show a local page; a browser, or an app from before
   * it, reads a frame at a time as before.
   */
  const [live, setLive] = useState("");
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [showLog, setShowLog] = useState(false);
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState("");
  const area = useRef<HTMLDivElement>(null);
  const streaming = useRef(false);
  const glass = useRef<HTMLDivElement>(null);
  /** Asks for the next frame now, after a touch or key, instead of waiting for the next one due. */
  const kick = useRef<() => void>(() => {});
  const [room, setRoom] = useState({ w: 0, h: 0 });
  const build = status?.build ?? null;
  /**
   * The folder the app is built from: the session's, or, when that has no Xcode project, the first of the agents' other folders
   * that has one (Arun, 2026-10-20: the agents were building an app outside the session's folder and the iOS side found nothing).
   */
  const [root, setRoot] = useState(cwd);
  const searched = useRef("");
  useEffect(() => {
    setRoot(cwd);
    searched.current = "";
  }, [cwd]);
  const statusOf = async (dir: string) => (await hostApi<{ ios?: IosStatus }>(identity, `/api/runner/ios.status?cwd=${encodeURIComponent(dir)}`))?.ios;

  const look = async () => {
    try {
      let ios = await statusOf(root);
      // A Friday app from before iOS previews answers without one: its runner can't build them yet.
      if (!ios) return setErr("Update the Friday app to build and run iOS apps here: this version can't yet.");
      // Nothing to build in the session's folder: where the agents are building, once for each set of folders to try.
      const key = elsewhere.join("\n");
      if (ios.xcode && !ios.projects.length && root === cwd && key && searched.current !== key) {
        searched.current = key;
        for (const dir of elsewhere) {
          const there = await statusOf(dir).catch(() => undefined);
          if (!there?.projects.length) continue;
          setRoot(dir);
          ios = there;
          break;
        }
      }
      setStatus(ios);
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  // Asked again quickly while a build goes, and now and then otherwise (a simulator booted elsewhere, a scheme added).
  useEffect(() => {
    if (!shown) return;
    void look();
    const t = setInterval(() => void look(), build && BUSY.has(build.stage) ? 1500 : 10_000);
    return () => clearInterval(t);
  }, [root, shown, build?.stage, elsewhere.join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps

  // What was chosen stays chosen; otherwise the build's own, then the first of each.
  const proj = status?.projects.find((p) => p.path === (project || build?.project)) ?? status?.projects[0];
  const sch = proj?.schemes.find((s) => s === (scheme || build?.scheme)) ?? proj?.schemes[0] ?? "";
  const sim = status?.simulators.find((s) => s.udid === (udid || build?.udid)) ?? status?.simulators[0];

  const runNow = async () => {
    if (!proj || !sim) return;
    setStarting(true);
    setErr("");
    setNote("");
    try {
      await hostApi(identity, "/api/runner/ios.run", { method: "POST", body: JSON.stringify({ cwd: root, project: proj.path, scheme: sch, udid: sim.udid }) });
      await look();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setStarting(false);
    }
  };
  const stop = async () => {
    await hostApi(identity, "/api/runner/ios.stop", { method: "POST", body: JSON.stringify({ cwd: root }) }).catch(() => {});
    setFrame("");
    await look();
  };

  // An agent asked for it: run as soon as there is something to run.
  const asked = useRef(runAsk);
  useEffect(() => {
    if (!runAsk || runAsk === asked.current || !status?.xcode || !proj || !sim) return;
    asked.current = runAsk;
    void runNow();
  }, [runAsk, status, proj?.path, sim?.udid]); // eslint-disable-line react-hooks/exhaustive-deps

  // The screen, while the app is up and the panel can be seen. One frame at a time: the next is asked for when this one is in.
  const screenOf = build && (build.stage === "running" || build.stage === "launching" || build.stage === "installing") ? build.udid : sim?.state === "Booted" && !build ? sim.udid : "";
  useEffect(() => {
    setLive("");
    if (!screenOf || !status?.input || !window.fridayDesktop) return;
    let gone = false;
    void hostApi<{ url?: string; error?: string }>(identity, "/api/runner/ios.live", { method: "POST", body: JSON.stringify({ udid: screenOf }) })
      .then((r) => !gone && r?.url && setLive(r.url))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [screenOf, status?.input]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!screenOf || !shown) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = async () => {
      if (!live) return;
      if (document.visibilityState === "visible") {
        const r = await hostApi<{ image?: string; error?: string }>(identity, "/api/runner/ios.screen", { method: "POST", body: JSON.stringify({ udid: screenOf }) }).catch(() => null);
        if (live && r?.image) setFrame(r.image);
      }
      // Live, a frame now and then is enough: for the phone's shape, and for a screenshot to keep or send. Every 30 seconds: a full
      // screenshot every 5 took the simulator from the stream beside it, and the live view stuttered each time (Arun, 2026-10-20).
      if (live) timer = setTimeout(() => void next(), streaming.current ? 30_000 : FRAME_MS);
    };
    void next();
    kick.current = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void next(), 150);
    };
    return () => {
      live = false;
      clearTimeout(timer);
      kick.current = () => {};
    };
  }, [screenOf, shown]); // eslint-disable-line react-hooks/exhaustive-deps

  // Touching and typing, when this Mac has AXe (runner/ios.ts iosInput): what the panel's screen is pressed with goes to the
  // simulator, as a share of the screen so the runner turns it into the device's own points.
  streaming.current = !!live;
  // Live, the page in the frame takes the touches and keys itself; this side does only while it reads a frame at a time.
  const touchable = !!status?.input && !!screenOf && !!frame && !live;
  const sendInput = async (input: IosInput) => {
    if (!screenOf) return;
    const r = await hostApi<{ ok?: true; error?: string }>(identity, "/api/runner/ios.input", { method: "POST", body: JSON.stringify({ udid: screenOf, input }) }).catch((e: Error) => ({ error: e.message }));
    if (r?.error) setNote(r.error);
    kick.current();
  };
  const press = useRef<{ x: number; y: number; at: number; id: number } | null>(null);
  const shareOf = (e: { clientX: number; clientY: number }) => {
    const r = glass.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!touchable || e.button !== 0) return;
    e.preventDefault();
    glass.current?.focus({ preventScroll: true });
    // Kept while dragging off the screen, so a swipe that ends outside it still lands; a pointer that can't be held is still a tap.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* the press still counts */
    }
    press.current = { ...shareOf(e), at: performance.now(), id: e.pointerId };
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    const to = shareOf(e);
    const moved = Math.hypot(to.x - p.x, to.y - p.y);
    void sendInput(moved < TAP_SLOP ? { kind: "tap", x: p.x, y: p.y } : { kind: "swipe", x: p.x, y: p.y, x2: to.x, y2: to.y, seconds: (performance.now() - p.at) / 1000 });
  };
  // What is typed is gathered for a moment and sent as one run of text: a key at a time would be a process a key.
  const typed = useRef("");
  const flush = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sendTyped = () => {
    const text = typed.current;
    typed.current = "";
    if (text) void sendInput({ kind: "type", text });
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!touchable || e.metaKey || e.ctrlKey || e.altKey) return;
    const code = KEYS[e.key];
    if (code !== undefined) {
      e.preventDefault();
      clearTimeout(flush.current);
      sendTyped();
      void sendInput({ kind: "key", code });
      return;
    }
    if (e.key.length !== 1) return;
    e.preventDefault();
    typed.current += e.key;
    clearTimeout(flush.current);
    flush.current = setTimeout(sendTyped, 160);
  };
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!touchable) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    void sendInput({ kind: "type", text });
  };

  // The room the phone has, for Fit.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [status?.xcode, status?.simulators.length, status?.projects.length]);

  // The phone's size: the screen's own shape (a frame's pixels), a bezel round it, at Fit or at a share of its points.
  const screen = size ?? { w: 1206, h: 2622 };
  const points = { w: screen.w / 3, h: screen.h / 3 };
  // The bezel is 4.5% of the screen's width on each side, so the phone is 1.09 screens wide and that much taller too.
  const outer = (s: number) => ({ w: points.w * s * 1.09, h: points.h * s + points.w * s * 0.09 });
  const fitScale = room.w && room.h ? Math.min((room.w - 24) / outer(1).w, (room.h - 24) / outer(1).h) : 0.6;
  const scale = zoom === "fit" ? Math.max(0.2, fitScale) : zoom;
  const sw = Math.round(points.w * scale);
  const sh = Math.round(points.h * scale);
  const bezel = Math.round(sw * 0.045);
  const radius = Math.round(sw * 0.15);
  const island = screen.h / screen.w > ISLAND_RATIO;
  const step = (dir: 1 | -1) => {
    const now = scale;
    const next = dir > 0 ? ZOOMS.find((z) => z > now + 0.01) : [...ZOOMS].reverse().find((z) => z < now - 0.01);
    if (next) setZoom(next);
  };

  const handToAgent = async () => {
    if (!frame || !sid || !invite || !send) return;
    setSending(true);
    setNote("");
    try {
      const att = await uploadFile(sid, invite, identity.id, { url: frame, mediaType: "image/jpeg", filename: "ios-preview.jpg" });
      const r = await send({ type: "instruct", text: `Here is what the iOS app shows right now${build ? ` (${build.scheme} on ${sim?.name ?? "the simulator"})` : ""}.`, attachments: [att] });
      setNote(r.ok ? "Sent the screen to the agent." : (r.error ?? "Couldn't send the screen. Try again."));
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  if (!status && !err) return <div className="preview-note"><p className="muted small"><span className="spinner tiny" /> Looking for Xcode…</p></div>;
  if (status && !status.xcode)
    return (
      <div className="preview-note ios-note">
        <p className="small">{status.error}</p>
        <button type="button" className="btn ghost small" onClick={() => void look()}>Check again</button>
      </div>
    );
  if (status && !status.simulators.length)
    return (
      <div className="preview-note ios-note">
        <p className="small">{status.simError ?? "This Mac has no iOS simulator yet."}</p>
        <button type="button" className="btn ghost small" onClick={() => void look()}>Check again</button>
      </div>
    );
  if (status && !status.projects.length)
    return (
      <div className="preview-note ios-note">
        <p className="muted small">No Xcode project or workspace in this folder{elsewhere.length ? ", or in the folders the agents are working in" : ""}. Open a folder with an .xcodeproj or .xcworkspace to run its app here.</p>
      </div>
    );

  const busy = starting || (!!build && BUSY.has(build.stage));
  const running = build?.stage === "running";
  return (
    <div className="ios-preview">
      <div className="ios-bar">
        {/* The device as its name and iOS, the way Xcode shows it: a picker drawn as the label it is. */}
        <label className="ios-device-pick" title="Which simulator">
          <span className="ios-device-text">
            <span className="ios-device-name">{sim?.name ?? "Simulator"}</span>
            <span className="ios-device-os">{sim?.runtime ?? ""}</span>
          </span>
          <Icon name="chevronDown" size={12} className="ios-device-caret" />
          <select aria-label="Simulator" value={sim?.udid ?? ""} onChange={(e) => setUdid(e.target.value)}>
            {status?.simulators.map((s) => (
              <option key={s.udid} value={s.udid}>
                {s.name} · {s.runtime}
                {s.state === "Booted" ? " · on" : ""}
              </option>
            ))}
          </select>
        </label>
        {status && status.projects.length > 1 && (
          <select className="ios-select" aria-label="Project" value={proj?.path ?? ""} onChange={(e) => (setProject(e.target.value), setScheme(""))}>
            {status.projects.map((p) => <option key={p.path} value={p.path}>{p.path}</option>)}
          </select>
        )}
        <select className="ios-select" aria-label="Scheme" value={sch} onChange={(e) => setScheme(e.target.value)} disabled={!proj?.schemes.length}>
          {(proj?.schemes.length ? proj.schemes : ["No scheme"]).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {busy ? (
          <button type="button" className="btn ghost small ios-go" onClick={() => void stop()}>
            <Icon name="stop" size={12} /> Stop
          </button>
        ) : (
          <button type="button" className="btn primary small ios-go" onClick={() => void runNow()} disabled={!proj || !sch || !sim}>
            <Icon name="play" size={12} /> {running ? "Rebuild" : "Run"}
          </button>
        )}
        <span className="ios-zoom" role="group" aria-label="Size">
          <button type="button" className="icon-btn tiny" title="Smaller" aria-label="Smaller" onClick={() => step(-1)} disabled={scale <= ZOOMS[0]! + 0.01}>
            <Icon name="minus" size={14} />
          </button>
          <button type="button" className={`icon-btn tiny ${zoom === "fit" ? "on" : ""}`} title="Fit the panel" aria-label="Fit the panel" aria-pressed={zoom === "fit"} onClick={() => setZoom("fit")}>
            <Icon name="expand" size={13} />
          </button>
          <button type="button" className={`ios-zoom-one ${zoom === 1 ? "on" : ""}`} title="The device's own size" aria-label="The device's own size" aria-pressed={zoom === 1} onClick={() => setZoom(1)}>
            1:1
          </button>
          <button type="button" className="icon-btn tiny" title="Bigger" aria-label="Bigger" onClick={() => step(1)} disabled={scale >= ZOOMS.at(-1)! - 0.01}>
            <Icon name="plus" size={14} />
          </button>
        </span>
      </div>

      {(build || err || note) && (
        <div className={`ios-stage ${err ? "failed" : (build?.stage ?? "")}`} role="status">
          {busy && <span className="spinner tiny" />}
          <span>{err || note || (build ? STAGE[build.stage] : "")}</span>
          {running && !err && !note && <span className="muted small">{build!.scheme}. {status?.input ? `${live ? "Live. " : ""}Click, drag and type on the screen here.` : "Touch and type in Simulator."}</span>}
          {build?.error && <span className="ios-error">{build.error}</span>}
        </div>
      )}

      <div className={`ios-room ${zoom === "fit" ? "fit" : ""}`} ref={area}>
        <div className="ios-phone" style={{ padding: bezel, borderRadius: radius + bezel }}>
          <i className="ios-btn ios-btn-action" aria-hidden />
          <i className="ios-btn ios-btn-up" aria-hidden />
          <i className="ios-btn ios-btn-down" aria-hidden />
          <i className="ios-btn ios-btn-side" aria-hidden />
          <div
            ref={glass}
            className={`ios-glass ${touchable ? "touchable" : ""}`}
            style={{ width: sw, height: sh, borderRadius: radius }}
            {...(touchable
              ? { tabIndex: 0, role: "application", "aria-label": `${build?.scheme ?? "The app"} in the simulator: click to tap, drag to swipe, type to enter text`, onPointerDown: onDown, onPointerUp: onUp, onPointerCancel: () => (press.current = null), onKeyDown: onKey, onPaste }
              : {})}
          >
            {live ? (
              <webview className="ios-live" src={live} partition="persist:preview" />
            ) : frame ? (
              <img
                draggable={false}
                src={frame}
                alt={`The simulator's screen${build ? `, running ${build.scheme}` : ""}`}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (img.naturalWidth && (img.naturalWidth !== size?.w || img.naturalHeight !== size?.h)) setSize({ w: img.naturalWidth, h: img.naturalHeight });
                }}
              />
            ) : (
              <p className="ios-empty">{busy ? STAGE[build?.stage ?? "building"] : "Run the app to see it here."}</p>
            )}
            {island && <i className="ios-island" style={{ width: Math.round(sw * 0.31), height: Math.round(sw * 0.093), top: Math.round(sw * 0.028) }} aria-hidden />}
          </div>
        </div>
      </div>

      {status?.xcode && !status.input && frame && (
        <p className="ios-hint muted small">
          To click and type on the screen here, install AXe: <code>{AXE_INSTALL}</code>
          <button type="button" className="link-btn small" onClick={() => void navigator.clipboard?.writeText(AXE_INSTALL).then(() => setNote("Copied. Run it in Terminal, then come back."))}>
            Copy
          </button>
        </p>
      )}
      <div className="ios-tools" role="toolbar" aria-label="iOS preview">
        {status?.input && (
          <button type="button" className="icon-btn" title="Home" aria-label="Home" onClick={() => void sendInput({ kind: "button", name: "home" })} disabled={!screenOf}>
            <HomeMark />
          </button>
        )}
        <button type="button" className="icon-btn" title={running ? "Rebuild and run" : "Build and run"} aria-label={running ? "Rebuild and run" : "Build and run"} onClick={() => void runNow()} disabled={busy || !proj || !sim}>
          <Icon name="refresh" size={16} />
        </button>
        <a
          className={`icon-btn ${frame ? "" : "off"}`}
          title="Save a screenshot"
          aria-label="Save a screenshot"
          href={frame || undefined}
          download={`${build?.scheme ?? "ios"}-screenshot.jpg`}
          aria-disabled={!frame}
          // Live, the frame on hand can be half a minute old: the screen as it is now is taken and saved instead.
          onClick={(e) => {
            if (!streaming.current || !screenOf) return;
            e.preventDefault();
            void hostApi<{ image?: string }>(identity, "/api/runner/ios.screen", { method: "POST", body: JSON.stringify({ udid: screenOf }) })
              .then((r) => {
                const image = r?.image ?? frame;
                if (!image) return;
                if (r?.image) setFrame(r.image);
                Object.assign(document.createElement("a"), { href: image, download: `${build?.scheme ?? "ios"}-screenshot.jpg` }).click();
              })
              .catch(() => {});
          }}
        >
          <Icon name="download" size={16} />
        </a>
        {sid && invite && send && (
          <button type="button" className="icon-btn" title="Send the screen to the agent" aria-label="Send the screen to the agent" onClick={() => void handToAgent()} disabled={!frame || sending}>
            <Icon name="send" size={16} />
          </button>
        )}
        <i className="ios-tools-rule" aria-hidden />
        <button type="button" className={`icon-btn ${showLog ? "on" : ""}`} title={showLog ? "Hide the build log" : "Build log"} aria-label="Build log" aria-pressed={showLog} onClick={() => setShowLog((v) => !v)} disabled={!build?.log.length}>
          <Icon name="terminal" size={16} />
        </button>
      </div>
      {showLog && build && <pre className="cmd-out ios-log">{build.log.slice(-80).join("\n")}</pre>}
    </div>
  );
}
