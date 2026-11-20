import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { api } from "../api.js";
import { hostApi } from "../local.js";
import { FridayMark, Icon } from "../icons.js";
import type { Identity } from "../storage.js";
import { AgentPanel, type AskedAbout } from "./AgentPanel.js";
import { Splitter } from "./Splitter.js";
import { setIdeRoot, setVscodeShowing, swapMode, takePendingOpen, takeReviewWanted, useMode, type IdeOpenDetail } from "./mode.js";
import { isCodeChat, loadCodeChats, showCodeChat, useCodeChats } from "./code-chats.js";
import { watchLater } from "./later-adopt.js";
import { useNeedMarks } from "../Attention.js";
import { agentsWaiting, openAgentsNeeds } from "./waiting.js";
import type { VsCodeCommand } from "../WindowNav.js";
import { RootPicker, type RecentFolder } from "./RootPicker.js";
import { rootName } from "./util.js";
import { PR_REVIEW_EVENT, takePrReviewWanted } from "./pr-review.js";
import { useIdeActions } from "./palette-run.js";
import {
  absoluteIn,
  askFromVscode,
  chooseView,
  CHAT_MIN,
  chatMax,
  clampChat,
  formatBytes,
  plainTrouble,
  progressOf,
  sameRoot,
  statusEvery,
  type VsAsk,
  type VsStatus,
} from "./vscode-util.js";

/** What App hands Code: the session and its folder, folders to offer when none is open, and the agent at work, if any. */
export interface IdeViewProps {
  identity: Identity;
  sid: string | null;
  root: string | null;
  recent: ReadonlyArray<string | RecentFolder>;
  onOpenRoot: (root: string, sid?: string) => void;
  agentWorking?: string | null;
}
import { setQuietWhileTyping, typed } from "./quiet.js";
import { openAgentsTask, useAgentsHere } from "./board-feed.js";
import "./ide.css";
import "./vscode.css";
// One search for Code (CodeSearch.tsx), opened by the window bar's pill: loaded with the folder, in a chunk of its own.
const CodeSearchHost = lazy(() => import("./CodeSearchHost.js").then((m) => ({ default: m.CodeSearchHost })));

/**
 * Code with real VS Code in it (Arun, 2026-11-19: "real VS Code in Code mode, with our own designs and features", and light on
 * disk). VS Code is code-server, an optional download the runner makes on this computer (src/runner/vscode.ts): this page asks
 * the runner for it (vscode.status / install / start / open), shows it in a frame, and puts Friday's agent beside it. The Friday
 * extension inside it brings the look (Friday Dark / Light) and ⌘L, which asks the agent about the selected code
 * (/api/vscode/asks, polled here).
 *
 * CodeSurface is what App shows for Code: always VS Code (Arun, 2026-11-19: "get rid of this friday ide thing we had before so it
 * doesnt load"), after a folder is picked, with the install card where it isn't on this computer yet.
 */

const vs = <T,>(identity: Identity, op: string, body: object = {}) => hostApi<T>(identity, `/api/runner/vscode.${op}`, { method: "POST", body: JSON.stringify(body) });
const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)) || "Something went wrong.";

export function CodeSurface(props: IdeViewProps) {
  const look = useVsStatus(props.identity, true, props.root);
  // Straight into VS Code, with nothing of Friday's in front (Arun, 2026-11-19: "get rid of the screen when you load into IDE for
  // the first time, it should just auto load into the IDE"): no folder is VS Code's own empty window, where one is chosen.
  return (
    <>
      <VsCodeGate {...props} root={props.root ?? ""} look={look} />
      <Suspense fallback={null}><CodeSearchHost identity={props.identity} folder={props.root || null} /></Suspense>
    </>
  );
}

/** Where VS Code can't run here (no build for this computer, or its runner can't be reached): said plainly. */
function CannotRun({ note }: { note: string }) {
  return (
    <div className="vsc-wrap">
      <div className="vsc-fill">
        <div className="vsc-empty">
          <div className="vsc-card">
            <span className="vsc-mark"><FridayMark size={26} /></span>
            <h2>Friday IDE can't run here</h2>
            <p>{note}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The runner's look at VS Code: every 30 s (which also keeps it running), quickly while it installs or starts, and at once when poked. Not while the window is hidden. */
function useVsStatus(identity: Identity, on: boolean, root?: string | null) {
  const [status, setStatus] = useState<VsStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const who = useRef({ identity, root });
  who.current = { identity, root };
  const poke = useRef<() => void>(() => {});
  useEffect(() => {
    if (!on) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waitingSince = 0;
    let last: VsStatus | null = null;
    const look = async () => {
      clearTimeout(timer);
      // A hidden window sends no heartbeat, so the runner's 10 minutes of quiet can end VS Code; it looks again as soon as it shows.
      if (document.hidden) return;
      try {
        last = await vs<VsStatus>(who.current.identity, "status", who.current.root ? { root: who.current.root } : {});
        if (stop) return;
        setStatus(last);
        setFailed(false);
      } catch {
        // A runner that doesn't know VS Code (an older one) or can't be reached: first time, Code says so; later, the last look stands.
        if (stop) return;
        setFailed(true);
      }
      if (last?.running && last.running.ready === false) waitingSince ||= Date.now();
      else waitingSince = 0;
      timer = setTimeout(() => void look(), statusEvery(last, waitingSince ? Date.now() - waitingSince : 0));
    };
    const shown = () => {
      if (!document.hidden) void look();
    };
    poke.current = () => {
      waitingSince = 0;
      void look();
    };
    document.addEventListener("visibilitychange", shown);
    void look();
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [on]);
  return { status, failed, set: setStatus, refresh: () => poke.current() };
}

type VsLook = ReturnType<typeof useVsStatus>;

function VsCodeGate(props: IdeViewProps & { root: string; look: VsLook }) {
  const { identity, look, ...rest } = props;
  const { status, failed, set, refresh } = look;
  const { view, note } = chooseView({ editor: "vscode", status, failed: failed && !status });
  if (view === "loading") return <div className="vsc-wrap"><div className="vsc-fill"><div className="vsc-opening vsc-blank" aria-busy="true" /></div></div>;
  if (view === "friday") return <CannotRun note={note} />;
  if (view === "install") return <div className="vsc-wrap"><div className="vsc-fill"><InstallCard identity={identity} status={status!} onStatus={set} onRefresh={refresh} /></div></div>;
  return <VsCodeWorkspace identity={identity} {...rest} status={status!} onRefresh={refresh} />;
}

/** Friday's own quiet waiting state: the mark, one line. Both themes, no white flash. */
function Opening({ label, hint, className = "" }: { label: string; hint?: string; className?: string }) {
  return (
    <div className={`vsc-opening ${className}`} role="status" aria-live="polite">
      <span className="vsc-mark pulse"><FridayMark size={26} /></span>
      <b>{label}</b>
      {hint && <p>{hint}</p>}
    </div>
  );
}

/** Where VS Code isn't installed: what it is, what it takes, and the way to get it (or not). */
function InstallCard({ identity, status, onStatus, onRefresh }: { identity: Identity; status: VsStatus; onStatus: (s: VsStatus) => void; onRefresh: () => void }) {
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState("");
  const installing = status.installing;
  const error = failure || (!installing ? status.error : "") || "";
  const size = formatBytes(status.downloadBytes);
  const onDisk = formatBytes(status.unpackedBytes ?? 660_000_000);
  const install = async () => {
    if (starting) return;
    setStarting(true);
    setFailure("");
    try {
      onStatus(await vs<VsStatus>(identity, "install"));
      onRefresh();
    } catch (e) {
      setFailure(plainTrouble(errText(e)));
    } finally {
      setStarting(false);
    }
  };
  const p = installing ? progressOf(installing) : null;
  return (
    <div className="vsc-empty">
      <div className="vsc-card">
        <span className="vsc-mark"><FridayMark size={26} /></span>
        <h2>Friday IDE</h2>
        <p className="vsc-lede">The editor you know, with extensions from Open VSX, beside your agents. It runs on this computer; your files never leave it.</p>
        <ul className="vsc-gets">
          <li>Extensions from Open VSX, most of the Marketplace. Microsoft's own, like Pylance, aren't there</li>
          <li>Starts clean: your settings and keybindings from another editor aren't copied in</li>
          <li>Friday's agent beside it: <kbd>{MAC ? "⌘L" : "Ctrl+L"}</kbd> asks about the code you select</li>
        </ul>
        <div className="vsc-act">
          {p ? (
            <>
              <div className="vsc-progress">
                <div className="vsc-bar" role="progressbar" aria-label="Installing Friday IDE" aria-valuemin={0} aria-valuemax={100} {...(p.fraction != null ? { "aria-valuenow": Math.round(p.fraction * 100) } : {})}>
                  <i className={p.fraction == null ? "busy" : ""} style={p.fraction != null ? { width: `${Math.max(2, p.fraction * 100)}%` } : undefined} />
                </div>
                <span className="vsc-pline" aria-live="polite">{p.line}</span>
              </div>
              <div className="vsc-acts">
                <button type="button" className="vsc-link" onClick={() => vs<VsStatus>(identity, "cancel").then(onStatus, () => {})}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              {error && <p className="vsc-error" role="alert">{error}</p>}
              <div className="vsc-acts">
                <Button type="button" size="sm" onClick={() => void install()} disabled={starting}>
                  {starting ? "Starting…" : error ? "Try again" : size ? `Install Friday IDE · ${size}` : "Install Friday IDE"}
                </Button>
              </div>
              <span className="vsc-fine">{size ? `${size} download, about ${onDisk} on disk, in Friday's own folder. Remove it any time in Settings.` : `About ${onDisk} on disk, in Friday's own folder. Remove it any time in Settings.`}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const CHAT_KEY = "friday.vsc.chat";
function readChat(): { open: boolean; width: number } {
  try {
    const v = JSON.parse(localStorage.getItem(CHAT_KEY) ?? "null") as { open?: unknown; width?: unknown } | null;
    return { open: v?.open !== false, width: clampChat(Number(v?.width ?? 380)) };
  } catch {
    return { open: true, width: 380 };
  }
}

/** VS Code in a frame with Friday's agent panel beside it. */
function VsCodeWorkspace({ identity, sid, root, agentWorking = null, status, onRefresh, recent, onOpenRoot }: IdeViewProps & { root: string; status: VsStatus; onRefresh: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  // VS Code is signed in by a one-off form post into the frame (the server runs with a password, so a web page or another user
  // reaching its port gets the login page, not an editor): the key never goes into an address. posted = the url it was sent for.
  const [sess, setSess] = useState<{ login: string; key: string } | null>(null);
  const posted = useRef<string | null>(null);
  const [frameLoaded, setFrameLoaded] = useState(false);
  // The cover ("Opening VS Code") stays until VS Code has drawn, not merely loaded: the Friday extension says so (status.running.ready),
  // with a wait of 8 s after the frame loads as the end of it. Then it fades out over a moment.
  const [cover, setCover] = useState<"on" | "fading" | "off">("on");
  // The folder the frame has drawn: set when the cover lifts, cleared the moment the folder changes (the cover's own state only
  // follows a render later, so on that very commit `revealed` still describes the old folder).
  const drawnRoot = useRef<string | null>(null);
  const [late, setLate] = useState(false);
  const [slow, setSlow] = useState(false);
  const [trouble, setTrouble] = useState("");
  const [again, setAgain] = useState(0);
  const startedAt = useRef(0);
  const [chat, setChat] = useState(readChat);
  // Kept when Agents is showing (App keeps Code mounted, hidden, so coming back is instant): only the shown one answers keys and the bar.
  const [mode] = useMode();
  const active = mode === "code";
  const frameRef = useRef<HTMLIFrameElement>(null);
  const rootRef = useRef(root);
  rootRef.current = root;
  const [asked, setAsked] = useState<AskedAbout | null>(null);
  // The IDE's right side bar, as its skin last said (vscode-skin.ts sayAux): the chat lies exactly over it, above the IDE's status
  // bar, so that status bar runs the window's whole width under the editor and the chat alike (Arun, 2026-11-20: "the native vscode
  // footer needs to the be running across the full length of the footer"). undefined until the IDE has said where it is: until
  // then (and with no IDE) the chat is a column beside it, as before.
  const [aux, setAux] = useState<{ left: number; top: number; width: number; height: number } | null | undefined>(undefined);
  const auxShown = useRef<boolean | null>(null);
  const sized = useRef(false);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const askChat = useCallback((open: boolean) => void vs(identity, "command", { name: open ? "chatOpen" : "chatClose", root: rootRef.current }).catch(() => {}), [identity]);
  // Shown or hidden from Friday (⌘⌥B, the bar's button, a task picked): the IDE's bar opens or closes to match. Shown or hidden from
  // the IDE (its own ⌘⌥B, its layout button) comes back as a change of the bar, below, and is only followed.
  useEffect(() => {
    if (aux === undefined || auxShown.current === null) return;
    if (chat.open !== auxShown.current) askChat(chat.open);
  }, [chat.open]); // eslint-disable-line react-hooks/exhaustive-deps
  const onAux = useCallback(
    (box: { left: number; top: number; width: number; height: number } | null) => {
      const shown = !!box;
      const was = auxShown.current;
      auxShown.current = shown;
      setAux(box);
      // The first time the bar shows in this IDE it is brought to the chat's kept width (the skin drags its edge, sizeAux); after
      // that the bar's width is the chat's, kept for next time.
      if (box) {
        if (!sized.current) {
          sized.current = true;
          if (Math.abs(box.width - chatRef.current.width) >= 4) frameRef.current?.contentWindow?.postMessage({ fridayVsc: 1, kind: "aux-width", width: chatRef.current.width }, "*");
        } else if (box.width !== chatRef.current.width) setChat((c) => ({ ...c, width: box.width }));
      }
      // The first word from this IDE: it opens or closes to what Friday had, the person's last choice.
      if (was === null) {
        if (shown !== chatRef.current.open) askChat(chatRef.current.open);
      } else if (shown !== was) setChat((c) => (c.open === shown ? c : { ...c, open: shown }));
    },
    [askChat],
  );
  // A new IDE (another folder, a restart): heard from afresh.
  useEffect(() => {
    auxShown.current = null;
    sized.current = false;
    setAux(undefined);
  }, [url]);
  // The column's width and whether it is open are kept between runs.
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify(chat));
    } catch {
      // A preference.
    }
  }, [chat]);

  // Start VS Code on this folder: one server for the computer, the folder named in the address. Started again when the runner
  // let it go (it stops after Code has been left for a while) or the folder changes.
  // A folder VS Code opened itself (its own Open Folder): the frame is already there, so the runner is told and the frame stays.
  const adopted = useRef<string | null>(null);
  useEffect(() => {
    let stop = false;
    if (adopted.current !== null && adopted.current === root) {
      adopted.current = null;
      drawnRoot.current = root;
      void vs(identity, "start", { root }).catch(() => {});
      return;
    }
    adopted.current = null;
    drawnRoot.current = null;
    setTrouble("");
    setFrameLoaded(false);
    setCover("on");
    setLate(false);
    setSlow(false);
    vs<{ url: string; login: string; key: string }>(identity, "start", { root }).then(
      (r) => {
        if (stop) return;
        startedAt.current = Date.now();
        setSess({ login: r.login, key: r.key });
        setUrl(r.url);
        onRefresh();
      },
      (e) => !stop && setTrouble(errText(e)),
    );
    return () => {
      stop = true;
    };
  }, [identity, root, again]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!url || !sess) return;
    const form = document.createElement("form");
    form.method = "post";
    form.action = sess.login;
    form.target = "vsc-frame";
    form.style.display = "none";
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "password";
    input.value = sess.key;
    form.appendChild(input);
    document.body.appendChild(form);
    posted.current = url;
    form.submit();
    form.remove();
  }, [url, sess]);
  // VS Code follows Friday's theme, not only the operating system's: the runner tells its extension on start and on every change.
  useEffect(() => {
    let last: boolean | null = null;
    const send = () => {
      const dark = document.documentElement.classList.contains("dark");
      if (dark === last) return;
      last = dark;
      void vs(identity, "theme", { dark }).catch(() => {});
    };
    if (frameLoaded) send();
    window.addEventListener("friday:theme", send);
    const mo = new MutationObserver(send);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    return () => {
      window.removeEventListener("friday:theme", send);
      mo.disconnect();
    };
  }, [identity, frameLoaded]);
  const gone = !!url && !status.running && Date.now() - startedAt.current > 5000;
  useEffect(() => {
    if (gone) {
      setUrl(null);
      setAgain((n) => n + 1);
    }
  }, [gone]);
  useEffect(() => {
    if (!url || cover !== "on") return;
    const t = setTimeout(() => setSlow(true), 15_000);
    return () => clearTimeout(t);
  }, [url, cover]);
  useEffect(() => {
    if (!frameLoaded) return;
    const t = setTimeout(() => setLate(true), 8000);
    return () => clearTimeout(t);
  }, [frameLoaded]);
  const drawn = frameLoaded && (late || status.running?.ready === true);
  useEffect(() => {
    if (drawn && cover === "on") setCover("fading");
  }, [drawn, cover]);
  // Its own effect: one keyed on `cover` too cleared this timer the moment it set "fading", and the cover never left.
  useEffect(() => {
    if (cover !== "fading") return;
    const t = setTimeout(() => setCover("off"), 180);
    return () => clearTimeout(t);
  }, [cover]);
  const revealed = cover !== "on";
  // The window bar's sidebar, quick-open and panel buttons drive Friday's own editor: left off while VS Code is up (WindowNav).
  useEffect(() => {
    setVscodeShowing(active);
    return () => setVscodeShowing(false);
  }, [active]);
  // Code's chats, for the IDE's task board and status bar (/api/vscode/tasks): sent whenever they change, with how many of Agents'
  // Needs you wait (the status bar's "waiting in Agents"; a Code chat, linked ones too, is counted in Code's own line).
  const codeChats = useCodeChats();
  // Chats Run later started while nobody was here are taken into Code's history, marked "Ran overnight" or "Ran later" (ide/later.ts), as
  // Code is open; until then Agents' list leaves them out (/api/sessions/mine says which they are).
  useEffect(() => watchLater(identity), [identity]);
  const marks = useNeedMarks();
  const waitingInAgents = agentsWaiting(marks.needs, (sid) => isCodeChat(sid) || codeChats.some((c) => c.sid === sid));
  // And the Agents sessions working in this folder, listed beside them (board-feed.ts).
  const agentsHere = useAgentsHere(root || null, active);
  useEffect(() => {
    if (!active) return;
    const tasks = codeChats.slice(0, 100).map((c) => ({ sid: c.sid, title: c.title, folder: c.folder, tool: c.tool ?? "", at: c.at, ...(c.linked ? { linked: true } : {}) }));
    void api(identity, "/api/vscode/tasks", { method: "POST", body: JSON.stringify({ tasks, agents: agentsHere, agentsWaiting: waitingInAgents }) }).catch(() => {});
  }, [codeChats, active, identity, waitingInAgents, agentsHere]);

  // Friday's palette (palette-run.ts): the actions it runs, its key on this page, and what the IDE's palette reads from here.
  useIdeActions({ identity, root: root || null, active, openChat: () => setChat((x) => (x.open ? x : { ...x, open: true })) });

  // The newest self-review's findings (SelfReviewCard), sent to the IDE to show as comments on the lines (/api/vscode/review).
  useEffect(() => {
    if (!active) return;
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ findings?: unknown[]; sid?: string; seq?: number }>).detail;
      if (!Array.isArray(d?.findings)) return;
      // With the chat and the message's number, so the server keeps the newest review and ignores a stale or repeated one.
      void api(identity, "/api/vscode/review", { method: "POST", body: JSON.stringify({ folder: root, findings: d.findings, sid: d.sid ?? "", seq: d.seq ?? 0 }) }).catch(() => {});
    };
    window.addEventListener("friday:self-review", on);
    // Cards drawn before the IDE was listening say theirs again now.
    window.dispatchEvent(new Event("friday:self-review-ask"));
    return () => window.removeEventListener("friday:self-review", on);
  }, [active, identity, root]);

  // The empty editor's Open File, Open Folder and recent folders (the skin's script, src/runner/vscode-skin.ts FRIDAY_SKIN_JS): the
  // folders are sent into the frame, and a click comes back here. Only messages from this frame are heard.
  const folders = useMemo(() => recent.map((r) => (typeof r === "string" ? { path: r, name: rootName(r) } : { path: r.path, name: r.name })), [recent]);
  const sendFolders = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ fridayVsc: 1, kind: "recents", folders, current: root, native: !!window.fridayDesktop?.pickPath }, "*");
  }, [folders, root]);
  useEffect(() => sendFolders(), [sendFolders, frameLoaded]);
  // The window bar's search pill over VS Code's editor area, not the window's middle (Arun, 2026-11-19: "make sure the search bar
  // is centered in the header"): the editor starts after the activity bar, and the side bar and this column, so the window's
  // middle sat to one side of everything under it. Kept clear of the bar's buttons at either end.
  const [editorBox, setEditorBox] = useState<{ left: number; width: number } | null>(null);
  useEffect(() => {
    const root = document.documentElement;
    const place = () => {
      const f = frameRef.current?.getBoundingClientRect();
      if (!active || !editorBox || !f || f.width <= 0) return root.style.removeProperty("--code-pill-x");
      const pill = document.querySelector(".win-code-find")?.getBoundingClientRect();
      const half = (pill?.width ?? 340) / 2;
      const x = f.left + editorBox.left + editorBox.width / 2;
      root.style.setProperty("--code-pill-x", `${Math.round(Math.max(330 + half, Math.min(innerWidth - 110 - half, x)))}px`);
    };
    place();
    addEventListener("resize", place);
    return () => {
      removeEventListener("resize", place);
      root.style.removeProperty("--code-pill-x");
    };
  }, [editorBox, active, chat.open, chat.width]);
  // Where the window bar's search pill is, over the frame: VS Code's pick lists are put under it (the skin's script).
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !frameLoaded) return;
    const tell = () => {
      const pill = document.querySelector(".win-code-find")?.getBoundingClientRect();
      const f = frame.getBoundingClientRect();
      const x = pill && pill.width > 0 && f.width > 0 ? pill.left + pill.width / 2 - f.left : null;
      frame.contentWindow?.postMessage({ fridayVsc: 1, kind: "pill", x }, "*");
    };
    tell();
    const ro = new ResizeObserver(tell);
    ro.observe(frame);
    addEventListener("resize", tell);
    return () => (ro.disconnect(), removeEventListener("resize", tell));
  }, [frameLoaded, chat.open, chat.width, active, editorBox]);
  const openRootRef = useRef(onOpenRoot);
  openRootRef.current = onOpenRoot;
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as { fridayVsc?: number; kind?: string; path?: unknown } | null;
      if (!d || d.fridayVsc !== 1) return;
      if (d.kind === "hello") sendFolders();
      else if (d.kind === "aux") {
        const b = (d as { box?: { left?: unknown; top?: unknown; width?: unknown; height?: unknown } | null }).box;
        const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
        onAux(b && n(b.width) > 0 ? { left: n(b.left), top: n(b.top), width: n(b.width), height: n(b.height) } : null);
      }
      else if (d.kind === "editor-box") setEditorBox({ left: Number((d as { left?: unknown }).left) || 0, width: Number((d as { width?: unknown }).width) || 0 });
      else if (d.kind === "typing") typed();
      else if (d.kind === "open-folder") window.dispatchEvent(new Event("friday:ide-open-folder"));
      // VS Code's own Open, Open File and Open Folder (vscode-skin.ts nativePickers): the system's panel. A folder becomes Code's
      // folder; a file opens in VS Code.
      else if (d.kind === "pick") {
        const what = (d as { what?: unknown }).what;
        if (what === "folder") window.dispatchEvent(new Event("friday:ide-open-folder"));
        else void window.fridayDesktop?.pickPath?.(what === "file" ? "file" : "any").then((p) => {
          if (!p) return;
          if (p.dir) setIdeRoot(p.path);
          else void vs(identity, "open", { path: p.path, root }).catch(() => {});
        }, () => {});
      }
      else if (d.kind === "open-file") void vs(identity, "command", { name: "openFile", root }).catch(() => {});
      else if (d.kind === "open-recent" && typeof d.path === "string" && folders.some((f) => f.path === d.path)) openRootRef.current(d.path);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [identity, root, folders, sendFolders, onAux]);

  // The window bar's search pill and layout buttons (WindowNav vscCommand): VS Code's own command, run by the Friday extension.
  // The frame takes focus first, so what opens in it (Go to File) is typed into straight away.
  useEffect(() => {
    if (!active) return;
    const on = (e: Event) => {
      // A name, or {name, arg} for a command that takes one (a commit's hash, "Open the change").
      const d = (e as CustomEvent<VsCodeCommand | { name: VsCodeCommand; arg?: string }>).detail;
      const name = typeof d === "string" ? d : d.name;
      frameRef.current?.focus();
      void vs(identity, "command", { name, root, ...(typeof d === "object" && d.arg ? { arg: d.arg } : {}) }).catch(() => {});
    };
    window.addEventListener("friday:vsc-command", on);
    // The Mac menu bar's VS Code menus (App, friday:vsc-run): a command by its id, checked again by the runner.
    const run = (e: Event) => {
      frameRef.current?.focus();
      void vs(identity, "command", { name: (e as CustomEvent<string>).detail, root }).catch(() => {});
    };
    // Compare on a racer in the chat column (ide/race-column.tsx): Review changes on that racer's own checkout.
    const racer = (e: Event) => {
      const detail = (e as CustomEvent<{ dir: string; base?: string; label?: string; handled?: boolean; failed?: (why: string) => void }>).detail;
      if (!detail?.dir) return;
      const { dir, base, label } = detail;
      // Said to the race card, which has nobody else to ask: this page is the one that can reach the IDE (race-column.tsx compare).
      detail.handled = true;
      frameRef.current?.focus();
      void vs(identity, "command", { name: "reviewChanges", root, review: { dir, base, label } }).catch((err: Error) => detail.failed?.(err.message || "The IDE didn't open the changes."));
    };
    window.addEventListener("friday:vsc-review", racer);
    const agent = () => setChat((c) => ({ ...c, open: !c.open }));
    window.addEventListener("friday:vsc-run", run);
    window.addEventListener("friday:vsc-agent", agent);
    return () => {
      window.removeEventListener("friday:vsc-command", on);
      window.removeEventListener("friday:vsc-run", run);
      window.removeEventListener("friday:vsc-review", racer);
      window.removeEventListener("friday:vsc-agent", agent);
    };
  }, [active, identity, root]);

  // Files to open in VS Code: from the chat, and from anywhere in Friday (openInCode, mode.ts). One named before VS Code has
  // drawn waits for it, with a beat for its extension to start watching.
  const waiting = useRef<IdeOpenDetail | null>(null);
  const openFile = useCallback(
    (path: string, line?: number, end?: number, how: { focus?: boolean; side?: boolean } = {}) => {
      const body = { path: absoluteIn(root, path), root, ...(line ? { line } : {}), ...(line && end && end > line ? { end } : {}), ...(how.side ? { side: true } : {}) };
      // From the search the editor takes the keyboard, as the IDE's own quick open left you typing in the file.
      if (how.focus) frameRef.current?.focus();
      vs(identity, "open", body).catch(() => {});
    },
    [identity, root],
  );
  const loadedRef = useRef(false);
  loadedRef.current = revealed;
  // The frame has drawn on this folder: marked before the effect below, which reads it.
  useEffect(() => {
    if (revealed) drawnRoot.current = rootRef.current;
  }, [revealed]);
  // "Open in Code" on a session with changes: Review changes, once the IDE has drawn on that session's folder (mode.ts wantReview;
  // not on a frame still showing the folder before it).
  useEffect(() => {
    if (!active) return;
    const review = () => {
      if (!revealed || drawnRoot.current !== root || !takeReviewWanted(root)) return;
      setTimeout(() => void vs(identity, "command", { name: "reviewChanges", root }).catch(() => {}), 500);
    };
    review();
    window.addEventListener("friday:code-review", review);
    return () => window.removeEventListener("friday:code-review", review);
  }, [active, revealed, identity, root]);
  // "Review in the IDE" on a teammate's pull request (pr-review.ts): its copy is the folder now, and once the IDE has drawn on it, the
  // diff of the whole pull request opens, with the comments the extension reads from GitHub.
  useEffect(() => {
    if (!active) return;
    const ask = () => {
      if (!revealed || drawnRoot.current !== root) return;
      const w = takePrReviewWanted(root);
      if (w) setTimeout(() => void vs(identity, "command", { name: "reviewChanges", root, review: w }).catch(() => {}), 500);
    };
    ask();
    window.addEventListener(PR_REVIEW_EVENT, ask);
    return () => window.removeEventListener(PR_REVIEW_EVENT, ask);
  }, [active, revealed, identity, root]);
  // A file named while the folder is changing (Open in Code from a session in another folder) waits for the frame of the new folder:
  // the names arrive in the same turn as the folder, before this component has seen it.
  const flushOpen = () => {
    const d = waiting.current;
    if (!d || !loadedRef.current || drawnRoot.current !== rootRef.current) return;
    waiting.current = null;
    openFile(d.path, d.line, undefined, d);
  };
  const flushRef = useRef(flushOpen);
  flushRef.current = flushOpen;
  const take = useCallback((d: IdeOpenDetail) => {
    waiting.current = d;
    setTimeout(() => flushRef.current(), 80);
  }, []);
  useEffect(() => {
    const pending = takePendingOpen();
    if (pending) take(pending);
    const on = (e: Event) => {
      const d = (e as CustomEvent<IdeOpenDetail>).detail;
      if (!d?.path) return;
      e.preventDefault();
      take(d);
    };
    window.addEventListener("friday:ide-open", on);
    return () => window.removeEventListener("friday:ide-open", on);
  }, [take]);
  useEffect(() => {
    if (!revealed || !waiting.current || drawnRoot.current !== root) return;
    const d = waiting.current;
    waiting.current = null;
    const t = setTimeout(() => openFile(d.path, d.line, undefined, d), 200);
    return () => clearTimeout(t);
  }, [revealed, openFile, root]);

  // ⌘L inside VS Code: the extension posts the ask, the page picks it up. A long poll: the server holds each look until something
  // arrives (up to 25 s), so an ask lands at once and an idle window sends next to nothing; none while the window is hidden. The
  // first look only learns the numbers, so an ask made before this page opened doesn't fill the box. Asks from another folder's
  // window, or old ones, are let go (askFromVscode).
  useEffect(() => {
    let stop = false;
    let since = Number.MAX_SAFE_INTEGER;
    let kSince = Number.MAX_SAFE_INTEGER;
    let fSince = Number.MAX_SAFE_INTEGER;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctl: AbortController | undefined;
    const look = async () => {
      clearTimeout(timer);
      ctl?.abort();
      if (document.hidden) return;
      const mine = (ctl = new AbortController());
      let wait = 0;
      try {
        const r = await api<{ seq: number; ask: VsAsk | null; kseq?: number; key?: "mode" | "agent" | "root" | "task" | "new" | "needs" | "action" | null; root?: string; sid?: string; inCode?: boolean; action?: string; invite?: string; fseq?: number; typing?: boolean; quiet?: boolean }>(identity, `/api/vscode/asks?since=${since}&kseq=${kSince}&fseq=${fSince}&wait=1`, { signal: mine.signal });
        if (stop || mine.signal.aborted) return;
        const first = since === Number.MAX_SAFE_INTEGER;
        since = r.seq;
        // Friday's own keys pressed inside VS Code (the extension forwards them: the frame keeps them from this page).
        const firstKey = kSince === Number.MAX_SAFE_INTEGER;
        kSince = typeof r.kseq === "number" ? r.kseq : 0;
        // The quiet-while-typing setting is a state of its own, answered on every look (quiet.ts); a key typed before this page looked is old news.
        const firstFocus = fSince === Number.MAX_SAFE_INTEGER;
        fSince = typeof r.fseq === "number" ? r.fseq : 0;
        if (typeof r.quiet === "boolean") setQuietWhileTyping(r.quiet);
        if (!firstFocus && r.typing) typed();
        if (!firstKey && r.key === "mode") swapMode();
        else if (!firstKey && r.key === "task" && r.sid) {
          // A task picked on the IDE's board: its chat, in its folder, in the column.
          const c = loadCodeChats().find((x) => x.sid === r.sid);
          if (c) {
            if (!sameRoot(c.folder, rootRef.current)) setIdeRoot(c.folder);
            showCodeChat(c.folder, c.sid);
            setChat((x) => (x.open ? x : { ...x, open: true }));
          } else if (openAgentsTask(r.sid, !!r.inCode, rootRef.current) && r.inCode) setChat((x) => (x.open ? x : { ...x, open: true }));
        } else if (!firstKey && r.key === "new" && rootRef.current) {
          showCodeChat(rootRef.current, "new");
          setChat((x) => (x.open ? x : { ...x, open: true }));
        } else if (!firstKey && r.key === "root" && r.root && r.root !== rootRef.current) {
          adopted.current = r.root;
          setIdeRoot(r.root);
        }
        else if (!firstKey && r.key === "agent") setChat((c) => ({ ...c, open: !c.open }));
        else if (!firstKey && r.key === "needs") openAgentsNeeds();
        // One of Friday's palette in the IDE, chosen there (palette-run.ts runs it).
        else if (!firstKey && r.key === "action" && r.action) window.dispatchEvent(new CustomEvent("friday:ide-action", { detail: { id: r.action, sid: r.sid, invite: r.invite } }));
        const a = first ? null : askFromVscode(root, r.ask, Date.now());
        if (a) {
          setAsked(a);
          // A ⌘K edit is made in the background and shows in the editor: the column stays as it was.
          if (a.kind !== "edit") setChat((c) => (c.open ? c : { ...c, open: true }));
        }
      } catch {
        // The server is busy or away: a pause, then the next look tries again.
        if (stop || mine.signal.aborted) return;
        wait = 3000;
      }
      if (!stop) timer = setTimeout(() => void look(), wait);
    };
    const visibility = () => {
      if (document.hidden) {
        clearTimeout(timer);
        ctl?.abort();
      } else void look();
    };
    document.addEventListener("visibilitychange", visibility);
    void look();
    return () => {
      stop = true;
      clearTimeout(timer);
      ctl?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [identity, root]);

  // ⌘⌥B: the chat column (the window bar's button sends the same chord, ideKey in mode.ts). In the capture phase, as Code's own
  // keys are, so it works wherever focus is on this page; inside VS Code's frame its own keys rule.
  useEffect(() => {
    if (!active) return;
    const on = (e: KeyboardEvent) => {
      if (e.code === "KeyB" && e.altKey && !e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        setChat((c) => ({ ...c, open: !c.open }));
      }
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [active]);

  // Over the IDE's right side bar once the IDE has said where it is and shows; a column beside it otherwise.
  const over = aux !== undefined && cover === "off" && !trouble;
  return (
    <div className={`ix vsc${over ? " over" : ""}`} data-testid="vscode-view">
      <div className="vsc-stage">
        {url && (
          <iframe
            ref={frameRef}
            key={url}
            className="vsc-frame"
            name="vsc-frame"
            title="Friday IDE"
            allow="clipboard-read; clipboard-write"
            onLoad={() => posted.current === url && setFrameLoaded(true)}
          />
        )}
        {/* While VS Code draws: just the editor's ground, no mark or words (Arun, 2026-11-19: "make sure the loading VS code thing
            doesnt appear"). Only a start that is really slow (the very first) says so, after 15 s. */}
        {cover !== "off" && !trouble && (slow ? <Opening className={`vsc-cover ${cover === "fading" ? "fading" : ""}`} label="Opening Friday IDE" hint="Still starting. The first start takes a little longer." /> : <div className={`vsc-opening vsc-cover vsc-blank ${cover === "fading" ? "fading" : ""}`} aria-busy="true" />)}
        {trouble && (
          <div className="vsc-empty over">
            <div className="vsc-card">
              <span className="vsc-mark"><FridayMark size={26} /></span>
              <h2>Friday IDE didn't start</h2>
              <p className="vsc-error" role="alert">{plainTrouble(trouble)}</p>
              <div className="vsc-acts">
                <Button type="button" size="sm" onClick={() => setAgain((n) => n + 1)}>Try again</Button>
              </div>
            </div>
          </div>
        )}
        {/* A browser has no window bar to open the agent from: one small round button at the corner, not a column. The desktop
            app's bar has the button, and ⌘⌥B works in both. */}
        {!chat.open && !window.fridayDesktop && (
          <button type="button" className="vsc-agent-btn" aria-label="Show the agent" title={`Show the agent (${MAC ? "⌘⌥B" : "Ctrl+Alt+B"})`} onClick={() => setChat((c) => ({ ...c, open: true }))}>
            <Icon name="chat" size={14} />
          </button>
        )}
      </div>
      {chat.open && !over ? (
        <Splitter edge="left" label="Resize the chat" value={chat.width} min={CHAT_MIN} max={chatMax()} onChange={(w) => setChat((c) => ({ ...c, width: clampChat(w) }))} onReset={() => setChat((c) => ({ ...c, width: 380 }))} />
      ) : null}
      {/* Stays mounted when hidden: it listens for files its messages point at, and keeps its place. */}
      <div className={`ix-right${over ? " over" : ""}`} style={over ? (aux ? { left: aux.left, top: aux.top, width: aux.width, height: aux.height } : undefined) : { width: chat.width }} hidden={over ? !aux : !chat.open}>
        <AgentPanel editor="vscode" root={root} asked={asked} onOpenFile={openFile} onClose={() => setChat((c) => ({ ...c, open: false }))} />
      </div>
    </div>
  );
}
