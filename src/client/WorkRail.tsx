/**
 * A Work session's rail beside the chat, in place of the tabbed side panels (Arun, 2026-10-26: "rather than side panels we can
 * have what claude and codex have on their chats... like outputs, connectors, etc basically but with our own spin on it"): what
 * Claude's and Codex's own apps keep beside a task, for a session two agents share.
 *   Progress    each agent, what it is doing now, and the steps of the latest plan
 *   Outputs     everything they made: collections first (a body of work in a folder of its own, opened as one; "hubs" in the
 *               code), then the newest pieces
 *   Sources     what they searched for and read
 *   Connectors  what they can reach: the folder, Friday's browser, the person's own browser, the apps they used
 * An output opens in the rail, widened into a reader (a document, a page working, a video, a hub's home), and the whole gallery
 * is one press away. Its bar along the foot (WorkBar) says the same at a glance.
 *
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { HubAgent } from "../agents-hub.js";
import { pendingFor, type SessionState } from "../session/projection.js";
import { ENGINE_NAMES, MAIN_LANE, type EngineTool, type SessionEvent } from "../types.js";
import { jumpTo, planSteps, type AskLane } from "./Activity.js";
import { useAgents } from "./agentFocus.js";
import { EngineMark } from "./BrandMarks.js";
import { Icon, type IconName } from "./icons.js";
import { barLine, runLine, useRunClock } from "./StatusBar.js";
import { carriedOn } from "../limit-reset.js";
import { relTime } from "./ui.js";
import { PresenceRing, type Presence } from "./presence.js";
import { DocView, ext, fileUrl, Gallery, LazyVideo, MARK, mediaFolders, name, openOutside, readAs, ReaderGuard, refreshWork, runOf, showFolder, sourcesIn, subDir, useTried, useWork, type WorkFile, type WorkList } from "./WorkPanels.js";
import { dirOf, galleryOf, hubPieces, hubsIn, learnTitles, isSourcesFile, matchFile, mcpUsed, outputsOf, pieceTitle, plainLine, sameTitled, sentIn, shownIn, sourceCount, type Hub, type Shown, type Source } from "./work-outputs.js";
import type { Send } from "./useSession.js";
import "./work.css";

// ── whether the rail shows, and which part of it was asked for ──────

const RAIL_KEY = "friday.work.rail";
type Part = "progress" | "outputs" | "collections" | "sources" | "connectors";
const readRail = () => {
  try {
    return localStorage.getItem(RAIL_KEY) !== "0";
  } catch {
    return true;
  }
};

/** The rail open or put away, remembered on this computer, the same for the bar's button and the rail's own. */
export function useWorkRail(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(readRail);
  useEffect(() => {
    const heard = () => setOpen(readRail());
    addEventListener("friday:work-rail", heard);
    return () => removeEventListener("friday:work-rail", heard);
  }, []);
  return [
    open,
    (v: boolean) => {
      try {
        localStorage.setItem(RAIL_KEY, v ? "1" : "0");
      } catch {
        // A preference: losing it costs nothing.
      }
      dispatchEvent(new Event("friday:work-rail"));
    },
  ];
}

/** The rail opened on one of its parts (the bar's "12 outputs"). */
const showPart = (part: Part) => {
  try {
    localStorage.setItem(RAIL_KEY, "1");
  } catch {
    // As above.
  }
  dispatchEvent(new Event("friday:work-rail"));
  dispatchEvent(new CustomEvent("friday:work-part", { detail: part }));
};

// ── what the outputs are ────────────────────────────────────────────

type Kind = "writing" | "page" | "sheet" | "deck" | "pdf" | "picture" | "video" | "sound";
const KIND: Record<Kind, { label: string; many: string; icon: IconName }> = {
  writing: { label: "Writing", many: "pieces of writing", icon: "file" },
  page: { label: "Page", many: "pages", icon: "browser" },
  sheet: { label: "Sheet", many: "sheets", icon: "grid" },
  deck: { label: "Deck", many: "decks", icon: "columns" },
  pdf: { label: "PDF", many: "PDFs", icon: "book" },
  picture: { label: "Picture", many: "pictures", icon: "image" },
  video: { label: "Video", many: "videos", icon: "play" },
  sound: { label: "Audio", many: "sounds", icon: "headset" },
};
const KIND_ORDER: Kind[] = ["writing", "page", "sheet", "deck", "pdf", "picture", "video", "sound"];

export function kindOf(f: Pick<WorkFile, "kind" | "path">): Kind {
  if (f.kind === "image") return "picture";
  if (f.kind === "video") return "video";
  if (f.kind === "audio") return "sound";
  const e = ext(f.path);
  return e === "html" ? "page" : e === "csv" || e === "xlsx" ? "sheet" : e === "pptx" ? "deck" : e === "pdf" ? "pdf" : "writing";
}

/** "12 pieces of writing · 15 pictures · 1 video", a numbered run of pictures counted as one set. */
function tally(files: WorkFile[]): string {
  const n = new Map<Kind, number>();
  for (const f of files) n.set(kindOf(f), (n.get(kindOf(f)) ?? 0) + 1);
  return KIND_ORDER.filter((k) => n.get(k))
    .map((k) => {
      const c = n.get(k)!;
      return `${c} ${c === 1 ? KIND[k].label.toLowerCase() : KIND[k].many}`;
    })
    .join(" · ")
    .replace(/^1 writing/, "1 piece of writing");
}

/** The newest pieces, a numbered run of pictures once (its newest) so a render's frames don't fill the list. */
function newest(files: WorkFile[], n: number): WorkFile[] {
  const seen = new Set<string>();
  const out: WorkFile[] = [];
  for (const f of [...files].sort((a, b) => b.mtime - a.mtime)) {
    if (isSourcesFile(f)) continue;
    const key = f.kind === "image" && /\d/.test(name(f.path)) ? `${f.root}|${dirOf(f.path)}|${runOf(f.path)}` : `${f.root}|${f.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
    if (out.length >= n) break;
  }
  return out;
}

const fresh = (f: WorkFile) => Date.now() - f.mtime < 120_000;
/** "5m ago", "now", or a date as it is. */
const ago = (ts: number) => {
  const r = relTime(ts);
  return r === "now" ? "now" : /^\d+\s*[a-z]+$/i.test(r) ? `${r} ago` : r;
};

/**
 * What the folder holds as the rail shows it: the outputs, the collections, and the outputs in none. Worked out once for the rail
 * and the bar together, and again only when the folder or the pictures shown in the chat change, not on every live event (Arun,
 * 2026-10-28: "iron everything and ensure we are good… any logic errors").
 */
type Made = { outputs: WorkFile[]; hubs: Hub[]; loose: WorkFile[] };
let made: { work: WorkList; sent: string; got: Made } | null = null;
function madeOf(work: WorkList, events: SessionEvent[]): Made {
  const sent = sentIn(events);
  const key = sent.join("\n");
  if (made && made.work === work && made.sent === key) return made.got;
  const outputs = outputsOf(work, sent);
  learnTitles(work.files);
  const hubs = hubsIn(outputs);
  const loose = outputs.filter((f) => !hubs.some((h) => h.root === f.root && f.path.startsWith(`${h.dir}/`)));
  made = { work, sent: key, got: { outputs, hubs, loose } };
  return made.got;
}
const useMade = (work: WorkList, events: SessionEvent[]) => useMemo(() => madeOf(work, events), [work, events]);

/** What the agents can reach, as many as Connectors lists, its "Friday's browser" row included (the head said 4 over 5 rows, QA 2026-10-28). */
const connectorCount = (roots: string[], tools: Set<unknown>, apps: number) => Math.min(2, roots.length) + 1 + (tools.has("claude") ? 2 : 0) + (tools.has("codex") ? 1 : 0) + apps;



// ── what the agents are doing ───────────────────────────────────────

interface Steps {
  lane: string;
  by: string;
  tool: EngineTool | null;
  steps: ReturnType<typeof planSteps>;
  at: number;
}

/** The latest plan any agent laid out (Claude Code's todo list, Codex's update_plan), and whose. */
function latestPlan(events: SessionEvent[], state: SessionState, agents: HubAgent[]): Steps | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.body.type !== "agent.message") continue;
    for (const c of [...e.body.toolCalls].reverse()) {
      if (!/^(todo|TodoWrite|update_plan|todo_write)$/.test(c.name)) continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.arguments || "{}") as Record<string, unknown>;
      } catch {
        continue;
      }
      // Codex says its plan as `plan: [{ step, status }]`.
      if (Array.isArray(args.plan)) args = { steps: (args.plan as { step?: string; status?: string }[]).map((p) => ({ title: p.step, status: p.status })) };
      const lane = e.lane ?? MAIN_LANE;
      const run = lane === MAIN_LANE ? state.run : state.laneRuns[lane];
      const steps = planSteps(args, run?.status === "running");
      if (!steps.length) continue;
      const agent = agents.find((a) => a.lane === lane);
      return { lane, by: agent?.name ?? e.actor.name, tool: agent?.tool ?? state.engines[lane]?.tool ?? null, steps, at: e.ts };
    }
  }
  return null;
}

/** The lane of the agent whose plan it is, when it finished or stopped with steps still open ("Stopped at 3 of 5"), else null. */
function stoppedShort(plan: Steps | null, agents: HubAgent[]): string | null {
  if (!plan) return null;
  const owner = agents.find((a) => a.lane === plan.lane);
  if (!owner || owner.status === "working" || owner.status === "waiting") return null;
  return plan.steps.some((x) => x.status !== "completed" && x.status !== "cancelled") ? plan.lane : null;
}

/** Which of the rail's parts each session has folded, by session (WorkRail's toggle). */
const RAIL_FOLDED = "friday.work.railFolded.bySession";
const STATUS_WORD: Record<HubAgent["status"], string> = { working: "Working", waiting: "Waiting", paused: "Paused", offline: "Offline", limited: "Out of usage", failed: "Stopped", done: "Done", ready: "Ready" };
/**
 * How an agent stands, drawn on its mark as on every face in the app (presence.tsx; Arun, 2026-10-29: "so clean and beautiful
 * really with a clear direction in design language"; DIRECTION.md §8, §9.8): a turning blue ring while it works, amber with a "?"
 * while it waits on you (a question, out of usage, paused, or a plan it stopped short of, which Carry on picks up), red when it
 * stopped on an error. The words beside it stay in the ink of the row: the state is on the mark, not in orange text.
 */
const PRESENCE: Record<HubAgent["status"], Presence> = { working: "working", waiting: "needs", paused: "needs", limited: "needs", failed: "error", offline: "asleep", done: "idle", ready: "idle" };

// ── the rail ────────────────────────────────────────────────────────

type View = { kind: "file"; file: WorkFile } | { kind: "hub"; hub: Hub } | { kind: "all"; filter?: Kind | "hubs" };

export function WorkRail({ state, events, sid, invite, away, onBrowser, onBrowse, send }: { state: SessionState; events: SessionEvent[]; sid: string; invite: string; /** The side panel is open in its place. */ away: boolean; /** Opens the Browser panel. */ onBrowser: () => void; /** Opens a page in it. */ onBrowse: (url: string) => void; /** Says something to an agent (Progress's "Carry on"). */ send?: Send }) {
  const [open, setOpen] = useWorkRail();
  const aside = useRef<HTMLElement>(null);
  // A Work session's header has no settings or side panel buttons: the rail is its side (style.css, html.work-session).
  useLayoutEffect(() => {
    document.documentElement.classList.add("work-session");
    return () => document.documentElement.classList.remove("work-session");
  }, []);
  // A narrow window keeps the chat its room: below 1100px the rail opens folded, as its row of tiles, until you open it yourself
  // (2026-10-27 design review: at 900px the open rail took a third of the window and squeezed the chat to 500px).
  const [cramped, setCramped] = useState(() => innerWidth < 1100);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    const fit = () => setCramped(innerWidth < 1100);
    const opened = () => setAsked(readRail());
    addEventListener("resize", fit);
    addEventListener("friday:work-rail", opened);
    addEventListener("friday:work-part", opened);
    return () => {
      removeEventListener("resize", fit);
      removeEventListener("friday:work-rail", opened);
      removeEventListener("friday:work-part", opened);
    };
  }, []);
  const work = useWork(sid, invite, true);
  const agents = useAgents();
  const [stack, setStack] = useState<View[]>([]);
  const [gallery, setGallery] = useState<{ files: WorkFile[]; at: number } | null>(null);
  // Every part folded to its one line until it is opened (Arun, 2026-10-26: "with all of the sections within it collapsed"). Each
  // session's own: one setting for all of them opened Progress in a new session because it was open in another, and changed under
  // a reload when another window had moved it (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors").
  const readShut = (): Record<Part, boolean> => {
    const folded = { progress: true, outputs: true, collections: true, sources: true, connectors: true };
    try {
      return { ...folded, ...((JSON.parse(localStorage.getItem(RAIL_FOLDED) ?? "{}") as Record<string, Partial<Record<Part, boolean>>>)[sid] ?? {}) };
    } catch {
      return folded;
    }
  };
  const [shut, setShut] = useState<Record<Part, boolean>>(readShut);
  useEffect(() => setShut(readShut()), [sid]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (p: Part) =>
    setShut((s) => {
      const next = { ...s, [p]: !s[p] };
      try {
        const all = JSON.parse(localStorage.getItem(RAIL_FOLDED) ?? "{}") as Record<string, Partial<Record<Part, boolean>>>;
        delete all[sid];
        // The newest last, and only the last hundred sessions' kept.
        localStorage.setItem(RAIL_FOLDED, JSON.stringify(Object.fromEntries([...Object.entries(all), [sid, next]].slice(-100))));
      } catch {
        // A preference.
      }
      return next;
    });
  const scroller = useRef<HTMLDivElement>(null);
  // The bar's "12 outputs" and the folded strip's tiles open the rail there: once the open rail is drawn, not in the same frame
  // as the press, when a rail that was folded (or put away for the Browser) had no list yet to scroll (w2 P1-1: "Show
  // Connectors" opened the rail at its top, Connectors off the screen).
  const [goTo, setGoTo] = useState<Part | null>(null);
  useEffect(() => {
    const go = (e: Event) => {
      const part = (e as CustomEvent<Part>).detail;
      setStack([]);
      setShut((s) => ({ ...s, [part]: false }));
      setGoTo(part);
    };
    addEventListener("friday:work-part", go);
    return () => removeEventListener("friday:work-part", go);
  }, []);
  const url = (f: Pick<WorkFile, "root" | "path">) => fileUrl(sid, invite, f);
  // A file named in the chat (a step's "Edited launch-thread.md", a path in an answer) opens here as what it is: in the reader,
  // or in its own app for one Friday can't show (SessionView's friday:open-file, in a Work session).
  // The closest match, never the first that ends the same (work-outputs.ts matchFile); one written since the last look, after
  // looking again; and only then its own app, saying so when that fails.
  const [note, setNote] = useState("");
  const workNow = useRef(work);
  workNow.current = work;
  const showNow = useRef<(f: WorkFile, among?: WorkFile[]) => void>(() => {});
  useEffect(() => {
    const opened = (e: Event) => {
      const asked = (e as CustomEvent<{ path: string }>).detail.path.replace(/^\.\//, "");
      setOpen(true);
      setAsked(true);
      setNote("");
      const found = matchFile(workNow.current, asked);
      if (found) return showNow.current(found, workNow.current.files);
      // Twice, the second after the folder's own listing has had time to be read afresh (work-files.ts keeps it three seconds).
      const again = () => refreshWork(sid, invite).then((w) => (matchFile(w, asked) ? w : new Promise<WorkList>((ok) => window.setTimeout(() => void refreshWork(sid, invite).then(ok), 3200))));
      void again().then(async (w) => {
        const f = matchFile(w, asked);
        if (f) return showNow.current(f, w.files);
        const root = w.roots[0];
        const at = asked.startsWith("/") ? asked : root ? `${root}/${asked}` : "";
        const d = window.fridayDesktop;
        // Not one the reader shows: in its own app, from the desktop app; said when that can't be done, or when it isn't there.
        if (!at || !d?.openFile) return setNote(`${name(asked)} isn't in this session's folder yet.`);
        const err = await d.openFile(at).then((r) => (r.ok ? "" : r.error || "it couldn't be opened"), (x: Error) => x.message);
        setNote(err ? `${name(asked)}: ${err.replace(/\.$/, "")}.` : "");
      });
    };
    addEventListener("friday:work-open", opened);
    return () => removeEventListener("friday:work-open", opened);
  }, [sid, invite]); // eslint-disable-line react-hooks/exhaustive-deps
  // Outputs holds what isn't in a collection; each collection is one card of its own.
  const { hubs, loose } = useMade(work, events);
  const sources = useMemo(() => sourcesIn(events, state), [events, state]);
  // What the agents can reach, counted as Connectors lists it: the folder, Friday's browser, each tool's own, the apps they used.
  const apps = useMemo(() => mcpUsed(events, new Map(agents.map((a) => [a.lane, a.name]))), [events, agents]);
  const engineTools = new Set(Object.values(state.engines).map((e) => e.tool).filter(Boolean));
  const connectors = connectorCount(work.roots, engineTools, apps.length);
  const push = (v: View) => setStack((s) => [...s, v]);
  // What "every output" was narrowed to, kept while a piece opened from it is read and found again on the way back (w2 #11).
  const allKept = useRef<{ find: string; only: Kind | "hubs" | "all" }>({ find: "", only: "all" });
  const back = () => setStack((s) => s.slice(0, -1));
  // A picture opens among the others in its folder, as the folder has them: a picture a document shows, never shown in the chat,
  // is still the one that opens, never another or nothing.
  const show = (f: WorkFile, among?: WorkFile[]) => {
    if (f.kind === "image") return setGallery(galleryOf(f, among ?? work.files));
    if (f.kind !== "video" && f.kind !== "audio" && readAs(f.path) === "app") return void openOutside(work.roots, f).then((err) => setNote(err ? `${name(f.path)}: ${err}` : ""));
    push({ kind: "file", file: f });
  };
  showNow.current = show;
  const view = stack[stack.length - 1];
  // Its width, dragged by its left edge: the overview's and the reader's each kept, so reading wide doesn't widen the overview.
  const [widths, setWidths] = useState<{ rail: number; reader: number }>(() => {
    try {
      return { rail: 336, reader: 640, ...(JSON.parse(localStorage.getItem("friday.work.railWidths") ?? "{}") as object) };
    } catch {
      return { rail: 336, reader: 640 };
    }
  });
  const which = view ? "reader" : "rail";
  // Kept inside the window as it narrows, not only once something else draws the rail again.
  const [, reflow] = useState(0);
  useEffect(() => {
    let frame = 0;
    const fit = () => (frame ||= requestAnimationFrame(() => ((frame = 0), reflow((n) => n + 1))));
    addEventListener("resize", fit);
    return () => (removeEventListener("resize", fit), cancelAnimationFrame(frame));
  }, []);
  const roomFor = (el: HTMLElement) => (el.parentElement?.clientWidth ?? innerWidth) - 480;
  const width = (el: HTMLElement | null, w: number) => Math.round(Math.max(which === "reader" ? 420 : 280, Math.min(w, el ? roomFor(el) : w)));
  const drag = (e: ReactPointerEvent) => {
    const el = aside.current;
    if (!el) return;
    e.preventDefault();
    const right = el.getBoundingClientRect().right;
    let next = widths[which];
    let frame = 0;
    document.body.classList.add("resizing", "resizing-x");
    const move = (ev: PointerEvent) => {
      next = width(el, right - ev.clientX);
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        el.style.width = `${next}px`;
      });
    };
    const up = () => {
      if (frame) cancelAnimationFrame(frame);
      document.body.classList.remove("resizing", "resizing-x");
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      setWidths((w) => {
        const kept = { ...w, [which]: next };
        try {
          localStorage.setItem("friday.work.railWidths", JSON.stringify(kept));
        } catch {
          // A preference.
        }
        return kept;
      });
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };
  const plan = useMemo(() => latestPlan(events, state, agents), [events, state, agents]);
  const working = agents.filter((a) => a.status === "working");
  const folded = !open || (cramped && !asked && !view);
  const shown = useMemo(() => shownIn(events), [events]);
  // The part asked for, brought into view once the open rail is on the screen, and the keyboard put on its head.
  useEffect(() => {
    if (!goTo || folded || away || view) return;
    const head = scroller.current?.querySelector<HTMLElement>(`[data-part="${goTo}"]`);
    if (!head) return;
    const frame = requestAnimationFrame(() => {
      head.scrollIntoView({ block: "start", behavior: "smooth" });
      head.querySelector<HTMLElement>(".wr-part-head")?.focus({ preventScroll: true });
      setGoTo(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [goTo, folded, away, view]);
  // Put away, the keyboard goes to what brings it back, never to the page's body (w2 #16).
  const putAway = () => {
    setOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".wr-shut .wr-head .wr-icon, .work-bar .wb-rail")?.focus());
  };
  // Opened over the chat on a phone's width (work.css), Escape puts it back, as the reader's Escape goes back (w2 #4).
  useEffect(() => {
    if (folded || view || away) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || innerWidth > 720) return;
      if (document.querySelector('.gallery, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"]')) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]")) return;
      setAsked(false);
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [folded, view, away]); // eslint-disable-line react-hooks/exhaustive-deps
  const counted = sourceCount(sources);
  // What "Shown in chat" adds to Outputs' count.
  const made = loose.length + shown.length;
  // On a Mac the rail runs up to the top of the window, as the docked side panel does, and says where its left edge is
  // (--rail-edge, from the window's right) so the header's buttons sit just before it (work.css, .rail-docked).
  // Set up when the rail shows, folds or widens into the reader, not on every render: every live event re-measured the window,
  // took the class off <html> and put it back (waking everything that watches it) and made a new observer.
  useLayoutEffect(() => {
    const el = aside.current;
    const root = document.documentElement;
    if (!el || away) return;
    const set = () => root.style.setProperty("--rail-edge", `${Math.max(0, Math.round(innerWidth - el.getBoundingClientRect().left))}px`);
    set();
    root.classList.add("rail-docked");
    const ro = new ResizeObserver(set);
    ro.observe(el);
    addEventListener("resize", set);
    return () => {
      ro.disconnect();
      removeEventListener("resize", set);
      root.classList.remove("rail-docked");
      root.style.removeProperty("--rail-edge");
    };
  }, [away, folded, !!view]);
  // Back from the Browser, the keyboard lands in the rail, on the part it was last in, never on the page's body: the rail goes
  // while the Browser has its place, and with it whatever had focus (QA, 2026-10-28; Arun: "TEST EVERYTHING… EVERY INTERACTION").
  const lastPart = useRef<string | null>(null);
  const wasAway = useRef(away);
  useEffect(() => {
    const back = wasAway.current && !away;
    wasAway.current = away;
    if (!back) return;
    const frame = requestAnimationFrame(() => {
      const a = document.activeElement;
      if (a && a !== document.body && a.isConnected) return;
      const el = aside.current;
      const at = (lastPart.current && el?.querySelector<HTMLElement>(`[data-part="${lastPart.current}"] .wr-part-head`)) || el?.querySelector<HTMLElement>(".wr-part-head, .wr-tab, .wr-icon");
      at?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [away]);
  const noteFocus = (e: React.FocusEvent) => void (lastPart.current = (e.target as HTMLElement).closest<HTMLElement>("[data-part]")?.dataset.part ?? lastPart.current);

  if (away) return null;
  if (folded)
    return (
      <aside className="wr wr-shut" aria-label="Session overview" ref={aside} onFocus={noteFocus}>
        <div className="wr-head">
          <button type="button" className="wr-icon" onClick={() => (setAsked(true), setOpen(true))} title="Show the overview" aria-label="Show the overview">
            <Icon name="panelRight" size={17} />
          </button>
        </div>
        {/* Each part as its own tile, as it is in the open rail, with what it holds said under it. */}
        {/* Each tile says what it is under its count (the 2026-10-28 critique: "3/5, 8, 1, 5, 6" read as numbers with no words). */}
        {(
          [
            ["progress", "list", "Progress", "Progress", plan ? `${plan.steps.filter((x) => x.status === "completed").length}/${plan.steps.length}` : working.length ? `${working.length} on` : ""],
            ["outputs", "file", "Outputs", "Outputs", made ? String(made) : ""],
            ...(hubs.length ? ([["collections", "board", "Collections", "Collections", String(hubs.length)]] as [Part, IconName, string, string, string][]) : []),
            ["sources", "globe", "Sources", "Sources", counted.n ? String(counted.n) : ""],
            // The sections' own names: "Sets" and "Apps" were a second vocabulary for the same two (QA, 2026-10-28).
            ["connectors", "plug", "Connectors", "Connectors", String(connectors)],
          ] as [Part, IconName, string, string, string][]
        ).map(([p, icon, label, short, n]) => (
          <button key={p} type="button" className={`wr-tab p-${p}`} onClick={() => (setAsked(true), showPart(p))} title={n ? `${label}: ${n}` : label} aria-label={`Show ${label}${n ? `, ${n}` : ""}`}>
            <Icon name={icon} size={16} />
            {n && <em>{n}</em>}
            <span className="wr-tab-label">{short}</span>
          </button>
        ))}
      </aside>
    );

  return (
    <aside className={`wr${view ? " wide" : ""}`} aria-label="Session overview" ref={aside} onFocus={noteFocus} style={{ width: width(aside.current, widths[which]) }}>
      {/* Reachable from the keyboard too: ← and → widen and narrow it, Home puts it back (w2 #16). */}
      <div
        className="wr-grip"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={view ? "Resize the reader" : "Resize the overview"}
        aria-valuenow={width(aside.current, widths[which])}
        aria-valuemin={which === "reader" ? 420 : 280}
        // The widest it may go here, so a screen reader can say where in its range it is (Arun, 2026-10-28: "TEST EVERYTHING…").
        aria-valuemax={Math.round(Math.max(which === "reader" ? 420 : 280, aside.current ? roomFor(aside.current) : innerWidth - 480))}
        onPointerDown={drag}
        onDoubleClick={() => setWidths((w) => ({ ...w, [which]: which === "reader" ? 640 : 336 }))}
        onKeyDown={(e) => {
          const by = e.key === "ArrowLeft" ? 24 : e.key === "ArrowRight" ? -24 : 0;
          if (!by && e.key !== "Home") return;
          e.preventDefault();
          setWidths((w) => {
            const kept = { ...w, [which]: e.key === "Home" ? (which === "reader" ? 640 : 336) : width(aside.current, w[which] + by) };
            try {
              localStorage.setItem("friday.work.railWidths", JSON.stringify(kept));
            } catch {
              // A preference.
            }
            return kept;
          });
        }}
      />
      {view ? (
        <ReaderGuard onBack={back} reset={`${stack.length}:${view.kind === "file" ? `${view.file.root}:${view.file.path}` : view.kind === "hub" ? view.hub.dir : "all"}`}>
          <Reader view={view} sid={sid} invite={invite} work={work} hubs={hubs} outputs={loose} onBack={back} onOpen={show} onHub={(hub) => push({ kind: "hub", hub })} url={url} backLabel={stack.length > 1 ? "Back" : "Overview"} kept={allKept} />
        </ReaderGuard>
      ) : (
        <>
          <div className="wr-head">
            <b>Overview</b>
            <button type="button" className="wr-icon" onClick={() => (allKept.current = { find: "", only: "all" }, push({ kind: "all" }))} title="Every output, as a gallery" aria-label="Open every output">
              <Icon name="expand" size={14} />
            </button>
            <button type="button" className="wr-icon" onClick={putAway} title="Put the overview away" aria-label="Put the overview away">
              <Icon name="panelRight" size={17} />
            </button>
          </div>
          <div className="wr-scroll" ref={scroller}>
            {note && (
              <p className="wr-note" role="status">
                <Icon name="help" size={13} />
                <span>{note}</span>
                <button type="button" className="wr-icon" onClick={() => setNote("")} aria-label="Dismiss">
                  <Icon name="x" size={12} />
                </button>
              </p>
            )}
            <Part
              part="progress"
              title="Progress"
              aside={plan ? <span className="wr-count">{plan.steps.filter((x) => x.status === "completed").length}/{plan.steps.length}</span> : null}
              shut={!!shut.progress}
              onToggle={() => toggle("progress")}
            >
              <Progress state={state} events={events} agents={agents} plan={plan} {...(send ? { send } : {})} />
            </Part>
            <Part
              part="outputs"
              title="Outputs"
              aside={made ? <span className="wr-count">{made}</span> : null}
              shut={!!shut.outputs}
              onToggle={() => toggle("outputs")}
            >
              <Outputs work={work} outputs={loose} shown={shown} url={url} onOpen={(f) => show(f)} onAll={() => (allKept.current = { find: "", only: "all" }, push({ kind: "all" }))} />
            </Part>
            {hubs.length > 0 && (
              <Part
                part="collections"
                title="Collections"
                aside={<span className="wr-count">{hubs.length}</span>}
                shut={!!shut.collections}
                onToggle={() => toggle("collections")}
              >
                <div className="wr-outputs">
                  {hubs.map((h) => (
                    <HubCard key={`${h.root}|${h.dir}`} hub={h} url={url} onOpen={() => push({ kind: "hub", hub: h })} />
                  ))}
                </div>
              </Part>
            )}
            <Part
              part="sources"
              title="Sources"
              aside={counted.n ? <span className="wr-count">{counted.n}</span> : null}
              shut={!!shut.sources}
              onToggle={() => toggle("sources")}
            >
              <SourceList sources={sources} sid={sid} invite={invite} agents={agents} onBrowse={onBrowse} />
            </Part>
            <Part
              part="connectors"
              title="Connectors"
              aside={<span className="wr-count">{connectors}</span>}
              shut={!!shut.connectors}
              onToggle={() => toggle("connectors")}
            >
              <Connectors state={state} events={events} roots={work.roots} agents={agents} onBrowser={onBrowser} sid={sid} invite={invite} />
            </Part>
          </div>
        </>
      )}
      {gallery && <Gallery files={gallery.files} at={gallery.at} url={url} roots={work.roots} onClose={() => setGallery(null)} />}
    </aside>
  );
}

/** One part of the rail: folded, its title and how many (Arun, 2026-10-27: "get rid of the secondary text only keep number"); opened, all of it. */
function Part({ part, title, aside, shut, onToggle, children }: { part: Part; title: string; aside?: ReactNode; shut: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className={`wr-part p-${part}${shut ? " shut" : ""}`} data-part={part}>
      <button type="button" className="wr-part-head" onClick={onToggle} aria-expanded={!shut}>
        <span className="wr-part-title">{title}</span>
        {aside}
        <Icon name="chevronDown" size={13} />
      </button>
      {!shut && <div className="wr-part-body">{children}</div>}
    </section>
  );
}

// ── progress ────────────────────────────────────────────────────────

/** "steps 4–5", "step 4", "steps 2, 4 and 5": the steps left, as a person would say them. */
const stepsWord = (ns: number[]) => {
  if (ns.length === 1) return `step ${ns[0]}`;
  const run = ns.every((n, i) => !i || n === ns[i - 1]! + 1);
  return run ? `steps ${ns[0]}–${ns.at(-1)}` : `steps ${ns.slice(0, -1).join(", ")} and ${ns.at(-1)}`;
};

function Progress({ state, events, agents, plan, send }: { state: SessionState; events: SessionEvent[]; agents: HubAgent[]; plan: Steps | null; send?: Send }) {
  const now = useRunClock(state);
  const [pressed, setAsked] = useState("");
  // Asked, and still waiting for the agent in its queue: said so after a reload too, from the log, not only from the press (Arun,
  // 2026-10-28: "iron everything and ensure we are good").
  const waiting = !!plan && pendingFor(state, plan.lane).some((seq) => {
    const e = events.find((x) => x.seq === seq);
    return e?.body.type === "instruction" && e.body.text.startsWith("Carry on with ");
  });
  const asked = pressed || (waiting ? "Asked" : "");
  // The plan's agent finished (or stopped) with steps still open: said as it is, "Stopped at 3 of 5", never "Done" over a plan at
  // 3/5, and a way to have it carry on (the 2026-10-28 critique: "Progress contradicts itself").
  const owner = plan ? agents.find((a) => a.lane === plan.lane) : undefined;
  const busy = !owner || owner.status === "working" || owner.status === "waiting";
  const done = plan ? plan.steps.filter((x) => x.status === "completed").length : 0;
  const left = plan ? plan.steps.map((x, i) => ({ x, n: i + 1 })).filter(({ x }) => x.status !== "completed" && x.status !== "cancelled") : [];
  const stopped = !!plan && !busy && left.length > 0;
  const carryOn = () => {
    if (!plan || !send || !left.length) return;
    const text = `Carry on with ${stepsWord(left.map((l) => l.n))}: ${left.map((l) => l.x.title).join("; ")}.`;
    setAsked("…");
    const done = (r: { ok: boolean; error?: string }) => setAsked(r.ok ? "Asked" : r.error || "That didn't send");
    // Sent the way the composer sends it, so an agent that isn't running is started first (Activity.tsx askLane). A bare send sat
    // "Queued" forever behind an agent nobody started (QA, 2026-10-28; Arun: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
    const ask: AskLane = { lane: plan.lane, text, reply: done };
    window.dispatchEvent(new CustomEvent("friday:ask-lane", { detail: ask }));
    if (!ask.handled) void send({ type: "instruct", text, ...(plan.lane !== MAIN_LANE ? { lane: plan.lane } : {}) }).then(done);
  };
  return (
    <div className="wr-progress">
      <ul className="wr-agents">
        {agents.map((a) => {
          const short = stopped && owner?.lane === a.lane;
          return (
            <li key={a.lane} className={`wr-agent s-${a.status}${short ? " s-short" : ""}`}>
              <PresenceRing state={short ? "needs" : PRESENCE[a.status]} size={24} square className="wr-agent-mark" label={short ? "Stopped early" : STATUS_WORD[a.status]}>
                <span className="wr-agent-disc">
                  <EngineMark tool={a.tool ?? ""} size={13} />
                </span>
              </PresenceRing>
              <span className="wr-agent-main">
                <span className="wr-agent-top">
                  <b>{a.name}</b>
                  <em>{short ? `Stopped at ${done} of ${plan!.steps.length}` : STATUS_WORD[a.status]}</em>
                  {a.status === "working" && a.startedAt ? <span className="wr-agent-clock">{clockOf(now - a.startedAt)}</span> : null}
                </span>
                {/* What it last said, as words: "## Tuning results" read with its marks (w1 #7, w3 P3-3). */}
                {a.line && !/^ready\b/i.test(a.line) && plainLine(a.line) && <span className="wr-agent-line">{plainLine(a.line)}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      {plan ? (
        <div className={`wr-plan${stopped ? " stopped" : ""}`}>
          <span className="wr-plan-by">
            <EngineMark tool={plan.tool ?? ""} size={11} />
            {plan.by}'s plan · {relTime(plan.at)}
          </span>
          <ol>
            {plan.steps.map((s, i) => (
              <li key={s.id} className={`st-${s.status}${stopped && s.status !== "completed" && s.status !== "cancelled" ? " st-left" : ""}`}>
                <span className="wr-step">{s.status === "completed" ? <Icon name="check" size={13} /> : s.status === "active" && !stopped ? <i aria-hidden="true" /> : i + 1}</span>
                <span>{plainLine(s.title)}</span>
              </li>
            ))}
          </ol>
          {stopped && (
            <div className="wr-carry">
              <span>
                {left.length === 1 ? "1 step" : `${left.length} steps`} not done
              </span>
              {send && (
                <button type="button" className="wr-chip" onClick={carryOn} disabled={asked === "…" || asked === "Asked"} title={`Ask ${plan.by} to carry on with ${stepsWord(left.map((l) => l.n))}`}>
                  <span aria-live="polite">{asked === "Asked" ? "Asked to carry on" : asked && asked !== "…" ? asked : "Carry on"}</span>
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <p className="wr-quiet">The steps show here once an agent lays out a plan.</p>
      )}
    </div>
  );
}

const clockOf = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

// ── outputs ─────────────────────────────────────────────────────────

/**
 * The rows in the order they had when the pointer came over them, for as long as it stays: a piece an agent saves goes to the top
 * of a list sorted newest first, and the row under the pointer moved as it was clicked, opening another (w2 #6). New ones wait
 * at the foot until the pointer leaves.
 */
function useHeld<T>(items: T[], key: (t: T) => string): [T[], { onPointerEnter: () => void; onPointerLeave: () => void }] {
  const [held, setHeld] = useState<string[] | null>(null);
  const shown = useMemo(() => {
    if (!held) return items;
    const at = new Map(held.map((k, i) => [k, i]));
    return [...items].sort((a, b) => (at.get(key(a)) ?? Infinity) - (at.get(key(b)) ?? Infinity));
  }, [items, held]); // eslint-disable-line react-hooks/exhaustive-deps
  return [shown, { onPointerEnter: () => setHeld(items.map(key)), onPointerLeave: () => setHeld(null) }];
}

const SHOWN_KIND: Record<Shown["kind"], { label: string; icon: IconName; tint: Kind }> = {
  mermaid: { label: "Diagram", icon: "diagram", tint: "deck" },
  svg: { label: "Drawing", icon: "image", tint: "picture" },
  html: { label: "Live page", icon: "browser", tint: "page" },
};

/** Scrolls the chat to a drawing an agent showed there, and lets it flash once. */
function goToShown(s: Shown) {
  jumpTo(s.seq);
  requestAnimationFrame(() => {
    let item: HTMLElement | null = null;
    for (const el of document.querySelectorAll<HTMLElement>("[data-seq]")) if (Number(el.dataset.seq) <= s.seq) item = el;
    const block = item?.querySelectorAll<HTMLElement>(".live-block")[s.at];
    block?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

function Outputs({ work, outputs, shown, url, onOpen, onAll }: { work: WorkList; outputs: WorkFile[]; shown: Shown[]; url: (f: WorkFile) => string; onOpen: (f: WorkFile) => void; onAll: () => void }) {
  // As many as the gallery shows: a numbered run of pictures is one card there, so it is one here.
  const cards = useMemo(() => newest(outputs, Infinity), [outputs]);
  const twins = useMemo(() => sameTitled(cards), [cards]);
  const [rows, hold] = useHeld(cards.slice(0, 6), (f) => `${f.root}:${f.path}`);
  // A folder that can't be read says so, rather than looking as if the agents made nothing.
  const failed = work.error ? <p className="wr-quiet wr-failed" role="status">The folder couldn't be read: {work.error}</p> : null;
  if (!outputs.length && !shown.length) return failed ?? (work.loaded ? <p className="wr-quiet">What the agents make lands here: posts, briefs, pages and sheets, the pictures they show you and the finished videos.</p> : <p className="wr-quiet">Looking in the folder…</p>);
  return (
    <div className="wr-outputs">
      {failed}
      {rows.length > 0 && (
        <ul className="wr-files" {...hold}>
          {rows.map((f) => (
            <li key={`${f.root}:${f.path}`}>
              <FileRow f={f} url={url} twin={twins.has(`${f.root}|${f.path}`)} onOpen={() => onOpen(f)} />
            </li>
          ))}
        </ul>
      )}
      {/* Only when there are more than the six shown: "See all 3" under three rows promised nothing more. */}
      {cards.length > 6 && (
        <button type="button" className="wr-all" onClick={onAll}>
          See all {cards.length}
          <Icon name="arrowRight" size={13} />
        </button>
      )}
      {/* What the agents drew in the chat itself (a diagram, a chart page, a drawing): one row each, a press away from where it
          is in the chat (the 2026-10-28 critique: "Whatever the agent shows in chat never reaches Outputs"). */}
      {shown.length > 0 && (
        <>
          <h3 className="wr-sub">Shown in chat</h3>
          <ul className="wr-files">
            {shown.slice(0, 8).map((x) => (
              <li key={`${x.seq}:${x.at}`}>
                <button type="button" className="wr-file" onClick={() => goToShown(x)} title="Show it in the chat">
                  <span className={`wr-thumb k-${SHOWN_KIND[x.kind].tint}`}>
                    <Icon name={SHOWN_KIND[x.kind].icon} size={14} />
                  </span>
                  <span className="wr-file-main">
                    <b>{x.title}</b>
                    <span>
                      {SHOWN_KIND[x.kind].label} · in the chat · {relTime(x.ts)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** A hub as a card: its pictures as its cover when it has some, else its name set in type; what it is, and what is in it. */
function HubCard({ hub, url, onOpen, big }: { hub: Hub; url: (f: WorkFile) => string; onOpen: () => void; big?: boolean }) {
  const pics = newest(hub.files.filter((f) => f.kind === "image"), 3);
  const live = hub.files.some(fresh);
  // Counted as its page counts it, from the same list: not its own collection.md (the card said 29, the page 28).
  const pieces = hubPieces(hub);
  const word = hub.title.split(/\s+/)[0] ?? hub.title;
  return (
    <button type="button" className={`wr-hub${big ? " big" : ""}${pics.length ? "" : " plain"}`} onClick={onOpen} title={hub.title}>
      {pics.length > 0 ? (
        <span className={`wr-hub-cover n${pics.length}`}>
          {pics.map((f) => (
            <img key={f.path} src={url(f)} alt="" loading="lazy" />
          ))}
        </span>
      ) : (
        // A cover in type, not a single grey letter: the name's first word, and how much is in it.
        <span className="wr-hub-cover type" aria-hidden>
          <b>{word}</b>
          <em>{pieces.length === 1 ? "1 piece" : `${pieces.length} pieces`}</em>
        </span>
      )}
      <span className="wr-hub-text">
        {/* No "Collection" label over the name: the part it sits in says so (a kicker over a title is a tell, the taste skill). */}
        <b>{hub.title}</b>
        {hub.about && <span className="wr-hub-about">{hub.about}</span>}
        <span className="wr-hub-meta">
          {live && <i className="wr-fresh" title="Changed in the last two minutes" />}
          {tally(pieces)} · {live ? "updated now" : relTime(hub.mtime)}
        </span>
      </span>
    </button>
  );
}

function Thumb({ f, url }: { f: WorkFile; url: (f: WorkFile) => string }) {
  const k = kindOf(f);
  if (k === "picture") return <img className="wr-thumb pic" src={url(f)} alt="" loading="lazy" decoding="async" />;
  if (k === "video")
    return (
      <span className="wr-thumb pic">
        <LazyVideo src={url(f)} />
        <Icon name="play" size={10} />
      </span>
    );
  return (
    <span className={`wr-thumb k-${k}`}>
      <Icon name={KIND[k].icon} size={14} />
    </span>
  );
}

/** What a piece is, said in its row: how long a piece of writing is, a sheet's rows, else its kind; never "Writing", which read
 *  as the agent still writing it (w1 #6, w3 P2-11). */
const sizeOf = (f: WorkFile): string => {
  const k = kindOf(f);
  if (k === "writing") return f.words ? `${f.words.toLocaleString()} ${f.words === 1 ? "word" : "words"}` : "Document";
  if (k === "sheet" && f.rows !== undefined) return `Sheet · ${f.rows.toLocaleString()} rows`;
  return `${KIND[k].label}${f.frames ? ` · ${f.frames} frames` : ""}`;
};

function FileRow({ f, url, onOpen, twin }: { f: WorkFile; url: (f: WorkFile) => string; onOpen: () => void; /** Another row has its title too: its file name says which. */ twin?: boolean }) {
  const isNew = fresh(f);
  return (
    <button type="button" className="wr-file" onClick={onOpen} title={f.path}>
      <Thumb f={f} url={url} />
      <span className="wr-file-main">
        <b>{pieceTitle(f)}</b>
        <span>
          {isNew && <i className="wr-fresh" title="Changed in the last two minutes" />}
          {twin ? `${name(f.path)} · ` : ""}
          {sizeOf(f)} · {isNew ? "edited now" : `edited ${ago(f.mtime)}`}
        </span>
      </span>
    </button>
  );
}

// ── sources and connectors ──────────────────────────────────────────

/** A site's own icon, fetched from the site by Friday on this computer (work-files.ts siteIcon); its initial until then, or without one. */
function SiteIcon({ host, sid, invite }: { host: string; sid: string; invite: string }) {
  // Only a public site's name is asked about: this computer, an address, or a name on its network has no icon to fetch (and the
  // server, work-files.ts publicHost, refuses those anyway).
  const [failed, setFailed] = useState(() => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) || /^[\d.]+$/.test(host) || /\.(local|localhost|internal|lan|home)$/i.test(host));
  return (
    <span className="wr-source-ico">
      {failed ? host.replace(/^www\./, "").slice(0, 1).toUpperCase() : <img src={`/api/sessions/${encodeURIComponent(sid)}/work/icon?host=${encodeURIComponent(host)}&invite=${encodeURIComponent(invite)}`} alt="" loading="lazy" onError={() => setFailed(true)} />}
    </span>
  );
}

/** Who searched, as the rest of the page names the tool: "Claude Code", never the lane's "Arun's Claude Code" (w2 #19). */
const toolName = (by: string, agents: HubAgent[]) => agents.find((a) => a.name === by)?.name ?? by.replace(/^.+?['’]s\s+/, "");
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.split("/")[0]!.replace(/^www\./, "");
  }
};
/** Address parts that say nothing about the page: `item?id=4123`, `/videos`, `/watch`. */
const GENERIC = /^(item|items|index|view|watch|page|pages|post|posts|p|a|videos?|about|home|en|en-us|docs?|wiki|article|story|status|s|r|c|w)$/i;
/** A page with no title of its own, by the words its address names it with (github.com/splashxmoon/friday is "Friday",
 *  youtube.com/@anthropic-ai/videos is "Anthropic ai"), else its site; never its path as written. */
const pageWords = (s: Source) => {
  if (s.title) return s.title;
  const url = s.url ?? `https://${s.text}`;
  let parts: string[] = [];
  try {
    parts = new URL(url).pathname.split("/").filter(Boolean).map((x) => decodeURIComponent(x));
  } catch {
    parts = s.text.split("/").slice(1);
  }
  const named = [...parts].reverse().find((x) => !GENERIC.test(x) && /[a-z]{3}/i.test(x) && !/^\d+$/.test(x));
  const words = named?.replace(/^@/, "").replace(/\.[a-z]{2,4}$/i, "").replace(/[-_+]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : hostOf(url);
};

/**
 * The web the agents read, as a cited answer lists it (Perplexity): each page by its title, numbered as it was first read, its
 * site's icon, its site and when; the pages a search turned up under that search. A search opens in the Browser too.
 */
function SourceList({ sources, sid, invite, agents, onBrowse }: { sources: Source[]; sid: string; invite: string; agents: HubAgent[]; onBrowse: (url: string) => void }) {
  const [all, setAll] = useState(false);
  if (!sources.length) return <p className="wr-quiet">Searches and pages the agents read show here as they go.</p>;
  const shown = all ? sources : sources.slice(0, 8);
  return (
    <>
      <ol className="wr-sources">
        {shown.map((s) => (
          <li key={`${s.kind}:${s.url ?? s.text}`} className={s.kind === "page" && s.of ? "under" : ""}>
            {s.kind === "page" ? (
              <button type="button" className="wr-source" onClick={() => onBrowse(s.url!)} title={`Open ${s.url} in the Browser`}>
                <span className="wr-source-n">{s.n}</span>
                <SiteIcon host={hostOf(s.url!)} sid={sid} invite={invite} />
                <span className="wr-source-main">
                  <b>{pageWords(s)}</b>
                  <span>
                    {hostOf(s.url!)} · {ago(s.at)}
                  </span>
                </span>
              </button>
            ) : (
              <button type="button" className="wr-source search" onClick={() => onBrowse(`https://duckduckgo.com/?q=${encodeURIComponent(s.text)}`)} title="Search it again in the Browser">
                <span className="wr-source-ico search" aria-hidden>
                  <Icon name="search" size={13} />
                </span>
                <span className="wr-source-main">
                  <b>{s.text}</b>
                  <span>
                    Searched by {toolName(s.by, agents)} · {ago(s.at)}
                  </span>
                </span>
              </button>
            )}
          </li>
        ))}
      </ol>
      {sources.length > 8 && (
        <button type="button" className="wr-more" onClick={() => setAll(!all)}>
          {all ? "Fewer" : `${sources.length - 8} more`}
        </button>
      )}
    </>
  );
}

/** The site a connected app lives at, for its own icon (work-files.ts siteIcon); its plug where there isn't one. */
const APP_SITE: [RegExp, string][] = [
  [/gmail|google.?mail/i, "mail.google.com"],
  [/drive/i, "drive.google.com"],
  [/calendar/i, "calendar.google.com"],
  [/notion/i, "notion.so"],
  [/linear/i, "linear.app"],
  [/github/i, "github.com"],
  [/figma/i, "figma.com"],
  [/canva/i, "canva.com"],
  [/airtable/i, "airtable.com"],
  [/asana/i, "asana.com"],
  [/hubspot/i, "hubspot.com"],
  [/atlassian|jira|confluence/i, "atlassian.com"],
];
/** "Searched once", "Read 3 times", "Used twice": what an app was used for, in a word. */
const usedWord = (tools: string[], calls: number) => {
  const verb = tools.every((t) => /search|find|query|list/i.test(t)) ? "Searched" : tools.every((t) => /read|get|fetch|view|open/i.test(t)) ? "Read" : tools.every((t) => /send|create|post|write|draft|update/i.test(t)) ? "Wrote to it" : "Used";
  return `${verb} ${calls === 1 ? "once" : calls === 2 ? "twice" : `${calls} times`}`;
};

/** What the agents can reach, and the apps they reached this session (their MCP tools, by server). */
function Connectors({ state, events, roots, agents, onBrowser, sid, invite }: { state: SessionState; events: SessionEvent[]; roots: string[]; agents: HubAgent[]; onBrowser: () => void; sid: string; invite: string }) {
  const [failed, tryIt] = useTried();
  const agentsByLane = useMemo(() => new Map(agents.map((a) => [a.lane, a.name])), [agents]);
  const tools = new Set(Object.values(state.engines).map((e) => e.tool).filter(Boolean) as EngineTool[]);
  const used = useMemo(() => mcpUsed(events, agentsByLane), [events, agentsByLane]);
  const browser = !!window.fridayDesktop?.browser;
  const rows: { icon: ReactNode; name: string; says: string; on: boolean; act?: { label: string; run: () => void; tip?: string } }[] = [];
  // The folder by its name, as words, not its raw slug as a title ("folder"): "Working folder", and which one under it.
  for (const root of roots.slice(0, 2)) {
    const folder = root.split("/").pop() || root;
    rows.push({ icon: <Icon name="folderOpen" size={14} />, name: roots.length > 1 ? `Working folder: ${folder}` : "Working folder", says: `${folder} · every output is saved here`, on: true, act: { label: "Show", run: () => tryIt(showFolder(root)), tip: `Show ${folder} in the Finder` } });
  }
  rows.push({ icon: <Icon name="webBrowser" size={14} />, name: "Friday's browser", says: browser ? "Pages the agents open, where you can watch" : "In the Friday desktop app", on: browser, ...(browser ? { act: { label: "Open", run: onBrowser } } : {}) });
  if (tools.has("claude")) rows.push({ icon: <EngineMark tool="claude" size={14} />, name: "Claude in Chrome", says: "Your own Chrome, with your sign-ins, when the extension is on", on: true });
  if (tools.has("codex")) rows.push({ icon: <EngineMark tool="codex" size={14} />, name: "Live web search", says: "Codex searches the web as it works, and makes images", on: true });
  if (tools.has("claude")) rows.push({ icon: <EngineMark tool="claude" size={14} />, name: "Claude's connectors", says: "Mail, drive, docs and the other apps you connected to Claude Code", on: true });
  return (
    <div className="wr-conn">
      <ul>
        {rows.map((r, i) => (
          <li key={`${i}:${r.name}`} className={r.on ? "on" : ""}>
            <span className="wr-conn-ico">{r.icon}</span>
            <span className="wr-conn-main">
              <b>{r.name}</b>
              <span>{r.says}</span>
            </span>
            {r.act ? (
              <button type="button" className="wr-chip" onClick={r.act.run} {...(r.act.tip ? { title: r.act.tip } : {})}>
                {r.act.label}
              </button>
            ) : (
              // Said in words beside its dot, for eyes and for screen readers (w2 #16; the critique's "a dot with no text").
              <span className="wr-state">
                <i className="wr-on" aria-hidden />
                {r.on ? "On" : "Off"}
              </span>
            )}
          </li>
        ))}
      </ul>
      {failed && (
        <p className="wr-quiet wr-failed" role="alert">
          {failed}
        </p>
      )}
      {used.length > 0 && (
        <>
          <h3 className="wr-sub">Used this session</h3>
          <ul>
            {used.map((u) => {
              const site = APP_SITE.find(([re]) => re.test(u.server))?.[1];
              return (
                <li key={u.server} className="on" title={u.tools.join(", ")}>
                  <span className="wr-conn-ico">{site ? <SiteIcon host={site} sid={sid} invite={invite} /> : <Icon name="plug" size={14} />}</span>
                  <span className="wr-conn-main">
                    <b>{u.name}</b>
                    <span>
                      {usedWord(u.tools, u.calls)}
                      {u.by.length ? ` · ${u.by.map((b) => toolName(b, agents)).join(" & ")}` : ""}
                    </span>
                  </span>
                  <span className="wr-conn-when">{ago(u.at)}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

// ── the reader: an output, a hub, or all of them ─────────────────────

function Reader({ view, sid, invite, work, hubs, outputs, onBack, onOpen, onHub, url, backLabel, kept }: { view: View; sid: string; invite: string; work: WorkList; hubs: Hub[]; outputs: WorkFile[]; onBack: () => void; onOpen: (f: WorkFile, among?: WorkFile[]) => void; onHub: (h: Hub) => void; url: (f: WorkFile) => string; backLabel: string; kept: { current: { find: string; only: Kind | "hubs" | "all" } } }) {
  // Esc goes back, as it does out of the gallery; never when it is closing something over the reader (the palette, a menu, a
  // dialog), which is asked before anything else hears the key, while what it closes is still there.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('.gallery, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"]')) return;
      // An empty find box is no reason to stay: Esc cleared it, and the next Esc goes back (QA, 2026-10-28: it kept the reader open).
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable]") && !(t instanceof HTMLInputElement && !t.value && t.closest(".docs-find, .wa-find"))) return;
      onBack();
      // The keyboard back in the rail, not on the page's body, where the find box it was in has gone.
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if (a && a !== document.body && a.isConnected) return;
        const at = [".wr .wr-part.p-outputs .wr-part-head", ".wr .work-doc-head .icon-btn", ".wr .wr-part-head"].map((q) => document.querySelector<HTMLElement>(q)).find(Boolean);
        at?.focus({ preventScroll: true });
      });
    };
    addEventListener("keydown", key, true);
    return () => removeEventListener("keydown", key, true);
  }, [onBack]);
  const [outside, tryOutside] = useTried();
  const [shown, tryShow] = useTried();
  if (view.kind === "file") {
    // The latest of it, as the folder has it now.
    const f = work.files.find((x) => x.root === view.file.root && x.path === view.file.path) ?? view.file;
    if (f.kind === "video" || f.kind === "audio")
      return (
        <div className="work-doc">
          <ReaderHead back={backLabel} onBack={onBack} title={pieceTitle(f)} meta={`${KIND[kindOf(f)].label} · edited ${ago(f.mtime)}`} tip={f.path}>
            {/* Download and Show in folder, as every other kind of piece has them (QA, 2026-10-28; Arun: "TEST EVERYTHING… EVERY INTERACTION"). */}
            <a className="icon-btn" href={url(f)} download={name(f.path)} title={`Download ${name(f.path)}`} aria-label={`Download ${name(f.path)}`}>
              <Icon name="download" size={15} />
            </a>
            <button type="button" className={`icon-btn${shown ? " tried-fail" : ""}`} onClick={() => tryShow(showFolder(`${work.roots[f.root] ?? ""}${dirOf(f.path) ? `/${dirOf(f.path)}` : ""}`))} title={shown || `Show ${name(f.path)} in its folder`} aria-label="Show in folder">
              <Icon name="folderOpen" size={15} />
            </button>
            <button type="button" className={`btn small${outside ? " tried-fail" : ""}`} onClick={() => tryOutside(openOutside(work.roots, f))} title={outside || "Open it in the app this computer uses for it"}>
              <Icon name="external" size={13} />
              <span aria-live="polite">{outside || "Open"}</span>
            </button>
          </ReaderHead>
          <div className="wr-player">{f.kind === "video" ? <video src={url(f)} controls autoPlay playsInline /> : <audio src={url(f)} controls autoPlay />}</div>
        </div>
      );
    // Its own reader for each file: the last file's words never show, or copy, under the next one's name.
    return <DocView key={`${f.root}:${f.path}`} sid={sid} invite={invite} roots={work.roots} file={f} files={work.files} onOpen={onOpen} onBack={onBack} back={backLabel} />;
  }
  if (view.kind === "hub") {
    const hub = hubs.find((h) => h.root === view.hub.root && h.dir === view.hub.dir) ?? view.hub;
    return <HubView hub={hub} roots={work.roots} url={url} onBack={onBack} back={backLabel} onOpen={(f) => onOpen(f, hub.files)} />;
  }
  return <AllView outputs={outputs} hubs={hubs} url={url} onBack={onBack} back={backLabel} onOpen={(f) => onOpen(f)} onHub={onHub} start={view.filter} kept={kept} />;
}

function ReaderHead({ back, onBack, title, meta, tip, children }: { back: string; onBack: () => void; title: string; meta?: string; /** The file it is, for whoever wants it. */ tip?: string; children?: ReactNode }) {
  // The keyboard lands on the way back, not on the page's body, as a piece opens (w2 #16).
  const backBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => void (!document.activeElement?.closest(".work-doc") && backBtn.current?.focus({ preventScroll: true })), []);
  return (
    <div className="work-doc-head">
      <button ref={backBtn} type="button" className="icon-btn" onClick={onBack} aria-label={back} title={back}>
        <Icon name="arrowLeft" size={15} />
      </button>
      <span className="work-doc-title" {...(tip ? { title: tip } : {})}>
        <b>{title}</b>
        {meta && <span>{meta}</span>}
      </span>
      {children}
    </div>
  );
}

/** A hub's home: what it is, then what is in it, by kind: the writing in its order, the pages and sheets, the pictures and video. */
function HubView({ hub, roots, url, onBack, back, onOpen }: { hub: Hub; roots: string[]; url: (f: WorkFile) => string; onBack: () => void; back: string; onOpen: (f: WorkFile) => void }) {
  const [failed, tryIt] = useTried();
  const by = (k: Kind[]) => hub.files.filter((f) => k.includes(kindOf(f)));
  const writing = by(["writing", "pdf"])
    .filter((f) => f !== hub.home)
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  const made = by(["page", "sheet", "deck"]);
  const media = mediaFolders(by(["picture", "video", "sound"]), hub.dir);
  const pics = newest(by(["picture"]), 4);
  const pieces = hubPieces(hub);
  return (
    <div className="work-doc">
      <ReaderHead back={back} onBack={onBack} title={hub.title} meta={`Collection · ${pieces.length === 1 ? "1 piece" : `${pieces.length} pieces`} · updated ${ago(hub.mtime)}`} tip={hub.dir}>
        <button type="button" className={`btn small${failed ? " tried-fail" : ""}`} onClick={() => tryIt(showFolder(roots[hub.root] ? `${roots[hub.root]}/${hub.dir}` : ""))} title={failed || `Show ${hub.dir.split("/").pop()} in the Finder`}>
          <Icon name="folderOpen" size={13} />
          <span aria-live="polite">{failed || "Show folder"}</span>
        </button>
      </ReaderHead>
      <div className="work-doc-scroll">
        <div className="wr-hubpage">
          <header className={`wr-hubhero${pics.length ? "" : " plain"}`}>
            {pics.length > 0 && (
              <span className={`wr-hubhero-pics n${pics.length}`}>
                {pics.map((f) => (
                  <img key={f.path} src={url(f)} alt="" decoding="async" />
                ))}
              </span>
            )}
            <h1>{hub.title}</h1>
            {hub.about && <p>{hub.about}</p>}
            <span className="wr-hubhero-meta">
              {/* What the sections below list: not the overview, which has its own button, nor the sources file (2026-10-27 audit:
                  "29 pieces of writing" over "Writing 28"). */}
              {tally(pieces)} · updated {ago(hub.mtime)}
            </span>
            {hub.home && (
              <button type="button" className="btn small" onClick={() => onOpen(hub.home!)}>
                <Icon name="book" size={13} />
                Read the overview
              </button>
            )}
          </header>
          {writing.length > 0 && (
            <section className="wr-hubsec">
              <h4>
                Writing <em>{writing.length}</em>
              </h4>
              <ul className="wr-doclist">
                {writing.map((d) => (
                  <li key={d.path}>
                    <DocLine d={d} top={hub.dir} onOpen={() => onOpen(d)} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {made.length > 0 && (
            <section className="wr-hubsec">
              <h4>
                Pages and sheets <em>{made.length}</em>
              </h4>
              <div className="wa-grid">
                {made.map((f) => (
                  <Card key={f.path} f={f} url={url} onOpen={() => onOpen(f)} />
                ))}
              </div>
            </section>
          )}
          {media.length > 0 && (
            <section className="wr-hubsec">
              <h4>
                Pictures, video and sound <em>{by(["picture", "video", "sound"]).length}</em>
              </h4>
              {media.map((g) => (
                <div key={g.dir || "."} className="wr-hubmedia">
                  {g.dir && (
                    <span className="wr-hubmedia-dir">
                      <Icon name="folder" size={11} />
                      {g.dir.split("/").join(" / ")}
                    </span>
                  )}
                  <div className="wa-grid">
                    {g.videos.map((f) => (
                      <Card key={f.path} f={f} url={url} onOpen={() => onOpen(f)} />
                    ))}
                    {g.items.map((it) =>
                      it.set ? (
                        <button key={it.key} type="button" className="wa-card" onClick={() => onOpen(it.set![0]!)}>
                          <span className="wa-pic mosaic">
                            {it.set.slice(0, 4).map((f) => (
                              <img key={f.path} src={url(f)} alt="" loading="lazy" />
                            ))}
                            <span className="work-tile-count">{it.set.length}</span>
                          </span>
                          <span className="wa-foot">
                            <b>{it.label}</b>
                            <em>{it.set.length} pictures in a set</em>
                          </span>
                        </button>
                      ) : (
                        <Card key={it.key} f={it.file!} url={url} onOpen={() => onOpen(it.file!)} />
                      ),
                    )}
                  </div>
                  {g.sounds.length > 0 && (
                    <ul className="media-sounds">
                      {g.sounds.map((f) => (
                        <li key={f.path}>
                          <Icon name="headset" size={14} />
                          <span title={f.path}>{subDir(f.path, `${hub.dir}/${g.dir}`) ? `${subDir(f.path, `${hub.dir}/${g.dir}`)} / ` : ""}{name(f.path)}</span>
                          <audio src={url(f)} controls preload="none" />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** A piece of writing in a collection: its number when it has one, its title and first line, how long, and when. */
function DocLine({ d, top, onOpen }: { d: WorkFile; top: string; onOpen: () => void }) {
  const file = name(d.path);
  const num = /^(\d{1,3})[-_ ]/.exec(file)?.[1];
  const dir = subDir(d.path, top);
  return (
    <button type="button" className="wr-doc" onClick={onOpen} title={d.path}>
      <span className={`wr-doc-n${num ? "" : " none"}`}>{num ?? <Icon name={KIND[kindOf(d)].icon} size={13} />}</span>
      <span className="wr-doc-main">
        <span className="wr-doc-title">
          <b dir="auto">{pieceTitle(d)}</b>
          {fresh(d) && <i className="wr-fresh" title="Changed in the last two minutes" />}
        </span>
        {d.excerpt && <span className="wr-doc-about" dir="auto">{d.excerpt}</span>}
        {dir && (
          <span className="wr-doc-dir">
            <Icon name="folder" size={10} />
            {dir.split("/").join(" / ")}
          </span>
        )}
      </span>
      <span className="wr-doc-meta">
        <span>{d.words ? `${d.words >= 1000 ? `${(d.words / 1000).toFixed(1)}k` : d.words} words` : d.rows !== undefined ? `${d.rows} rows` : ext(d.path).toUpperCase()}</span>
        <span>{relTime(d.mtime)}</span>
      </span>
    </button>
  );
}

/** One output as a card, its preview drawn for what it is: a page of writing, a page, a sheet's columns, the picture itself. */
function Card({ f, url, onOpen, where }: { f: WorkFile; url: (f: WorkFile) => string; onOpen: () => void; /** The folder it is in, said when a search found it by that. */ where?: string }) {
  const k = kindOf(f);
  const title = pieceTitle(f);
  return (
    <button type="button" className={`wa-card k-${k}`} onClick={onOpen} title={f.path}>
      <span className={`wa-pic${k === "picture" || k === "video" ? "" : " drawn"}`}>
        {k === "picture" ? (
          <img src={url(f)} alt="" loading="lazy" decoding="async" />
        ) : k === "video" ? (
          <>
            <LazyVideo src={url(f)} />
            <span className="wa-play">
              <Icon name="play" size={14} />
            </span>
          </>
        ) : k === "sheet" ? (
          <span className="wa-sheet">
            <span className="wa-sheet-row head">
              {(f.columns?.length ? f.columns : ["A", "B", "C"]).slice(0, 4).map((c, i) => (
                <i key={i}>{c}</i>
              ))}
            </span>
            {[0, 1, 2, 3].map((r) => (
              <span key={r} className="wa-sheet-row">
                {(f.columns?.length ? f.columns : ["A", "B", "C"]).slice(0, 4).map((_, i) => (
                  <i key={i} />
                ))}
              </span>
            ))}
          </span>
        ) : k === "page" ? (
          <span className="wa-page">
            <span className="wa-page-bar">
              <i />
              <i />
              <i />
            </span>
            <b dir="auto">{title}</b>
            {f.excerpt && <span dir="auto">{f.excerpt}</span>}
          </span>
        ) : k === "sound" ? (
          <span className="wa-wave" aria-hidden>
            {Array.from({ length: 24 }, (_, i) => (
              <i key={i} style={{ height: `${20 + Math.round(60 * Math.abs(Math.sin(i * 1.7 + f.size)))}%` }} />
            ))}
          </span>
        ) : (
          <span className="wa-paper">
            <b dir="auto">{title}</b>
            {f.excerpt && <span dir="auto">{f.excerpt}</span>}
          </span>
        )}
      </span>
      <span className="wa-foot">
        {/* Each piece's own direction: an Arabic preview read out of order in a left-to-right page (QA, 2026-10-28). */}
        <b dir="auto">{title}</b>
        {where && <span className="wa-where">{where}</span>}
        <em>
          {/* Freshness in the foot, before what it is: a tag over the preview sat on its title (the 2026-10-28 critique). */}
          {fresh(f) && <i className="wr-fresh" title="Changed in the last two minutes" />}
          <span className={`wa-kind k-${MARK[ext(f.path)] ?? k}`}>{KIND[k].label}</span>
          {f.words ? `${f.words >= 1000 ? `${(f.words / 1000).toFixed(1)}k` : f.words} words · ` : f.rows !== undefined ? `${f.rows} rows · ` : f.frames ? `${f.frames} frames · ` : ""}
          {relTime(f.mtime)}
        </em>
      </span>
    </button>
  );
}

/** As many cards as the gallery draws at once. */
const ALL_CAP = 400;

/**
 * Every output as a gallery: found by name or what it says, narrowed to one kind, collections first. What it holds is what the
 * rail's Outputs counts (the pieces in no collection, a numbered run of pictures as one card) and the collections, so "See all 12"
 * opens twelve, and each count on a chip is the cards that chip shows.
 */
function AllView({ outputs, hubs, url, onBack, back, onOpen, onHub, start, kept }: { outputs: WorkFile[]; hubs: Hub[]; url: (f: WorkFile) => string; onBack: () => void; back: string; onOpen: (f: WorkFile) => void; onHub: (h: Hub) => void; start?: Kind | "hubs"; kept: { current: { find: string; only: Kind | "hubs" | "all" } } }) {
  // Where it was left: back from a piece opened here, the same search and the same kind (w2 #11).
  const [find, setFindNow] = useState(kept.current.find);
  const [only, setOnlyNow] = useState<Kind | "hubs" | "all">(start ?? kept.current.only);
  const setFind = (v: string) => (setFindNow(v), (kept.current = { ...kept.current, find: v }));
  const setOnly = (v: Kind | "hubs" | "all") => (setOnlyNow(v), (kept.current = { ...kept.current, only: v }));
  const cards = useMemo(() => newest(outputs, Infinity), [outputs]);
  const words = find.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (s: string) => words.every((w) => s.toLowerCase().includes(w));
  const said = (f: WorkFile) => `${pieceTitle(f)} ${name(f.path)} ${f.excerpt ?? ""}`;
  const matched = cards.filter((f) => hit(`${f.path} ${said(f)}`));
  // The chips count what the search found, so "Writing 30" never sits beside "12 of 39" (w2 #12).
  const counts = new Map<Kind, number>();
  for (const f of matched) counts.set(kindOf(f), (counts.get(kindOf(f)) ?? 0) + 1);
  const found = matched.filter((f) => only === "all" || only === kindOf(f));
  const files = found.slice(0, ALL_CAP);
  const matchedHubs = hubs.filter((h) => hit(`${h.dir} ${h.title} ${h.about}`));
  const shownHubs = only === "all" || only === "hubs" ? matchedHubs : [];
  // Found by its folder alone: the folder said on the card, so it is plain why it matched.
  const byFolder = (f: WorkFile) => (words.length && !hit(said(f)) ? dirOf(f.path).split("/").join(" / ") : "");
  return (
    <div className="work-doc">
      <ReaderHead back={back} onBack={onBack} title="Outputs" meta={`${cards.length === 1 ? "1 piece" : `${cards.length} pieces`}${hubs.length ? ` · ${hubs.length} collection${hubs.length === 1 ? "" : "s"}` : ""}`} />
      <div className="wa-bar">
        <label className="wa-find">
          <Icon name="search" size={15} />
          <input autoFocus value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => e.key === "Escape" && find && (e.stopPropagation(), setFind(""))} placeholder="Search by name or what it says" spellCheck={false} aria-label="Search the outputs" />
          {find.trim() ? (
            <>
              <span className="wa-find-n">
                {found.length + shownHubs.length} of {cards.length + hubs.length}
              </span>
              <button type="button" className="wa-find-x" onClick={() => setFind("")} aria-label="Clear the search">
                <Icon name="x" size={12} />
              </button>
            </>
          ) : (
            <span className="wa-find-n">{cards.length + hubs.length}</span>
          )}
        </label>
        <div className="wa-chips" role="tablist" aria-label="Kind">
          {(
            [
              // The files and the collections, as the count in the search box says and as "All" shows (2026-10-27 audit: 38 here, 39 there).
              ["all", "All", matched.length + matchedHubs.length],
              // Like the kinds, gone while a search finds none, unless it is the one picked ("Collections 0", QA 2026-10-28).
              ...(matchedHubs.length || only === "hubs" ? ([["hubs", "Collections", matchedHubs.length]] as const) : []),
              ...KIND_ORDER.filter((k) => counts.get(k) || only === k).map((k) => [k, k === "writing" ? "Writing" : KIND[k].many[0]!.toUpperCase() + KIND[k].many.slice(1), counts.get(k) ?? 0] as const),
            ] as [Kind | "hubs" | "all", string, number][]
          ).map(([k, label, n]) => (
            <button key={k} type="button" role="tab" aria-selected={only === k} className={only === k ? "on" : ""} onClick={() => setOnly(k)}>
              {label}
              <em>{n}</em>
            </button>
          ))}
        </div>
      </div>
      <div className="work-doc-scroll wa-scroll">
        {shownHubs.length > 0 && (
          <div className="wa-hubs">
            {shownHubs.map((h) => (
              <HubCard key={`${h.root}|${h.dir}`} hub={h} url={url} onOpen={() => onHub(h)} big />
            ))}
          </div>
        )}
        {only !== "hubs" && (
          <div className="wa-grid">
            {files.map((f) => (
              <Card key={`${f.root}:${f.path}`} f={f} url={url} onOpen={() => onOpen(f)} where={byFolder(f)} />
            ))}
          </div>
        )}
        {found.length > files.length && (
          <p className="docs-none">
            The newest {files.length} of {found.length}. Search to find the others.
          </p>
        )}
        {!files.length && !shownHubs.length && <p className="docs-none">Nothing matches{find.trim() ? ` “${find.trim()}”` : ""}.</p>}
      </div>
    </div>
  );
}

// ── the bar along the foot ──────────────────────────────────────────

/**
 * A Work session's bar: no branch, no lines changed, no environment. What the agents are doing and who they are, what they have
 * made and read (each a way into the rail), the chat's own Jump menu and context gauge, the folder, and the rail's button.
 */
export function WorkBar({ state, events, me, sid, invite, slot, onRail }: { state: SessionState; events: SessionEvent[]; me: string; sid: string; invite: string; slot: (el: HTMLElement | null) => void; /** The rail is about to show: the side panel makes way. */ onRail: () => void }) {
  const now = useRunClock(state);
  const agents = useAgents();
  const line = barLine(runLine(state, events, now, me), agents, (lane) => carriedOn(state, lane));
  const work = useWork(sid, invite, true);
  const [open, setOpen] = useWorkRail();
  const { hubs, loose } = useMade(work, events);
  // Counted as the rail and a reply count them: the pages read (else the searches), and what was drawn in the chat as well.
  const sources = useMemo(() => sourceCount(sourcesIn(events, state)), [events, state]);
  const made = loose.length + useMemo(() => shownIn(events).length, [events]);
  const [failed, tryIt] = useTried();
  const root = work.roots[0] ?? state.engines[MAIN_LANE]?.cwd ?? "";
  const folder = root.split("/").pop() || root;
  const names = agents.map((a) => a.name);
  // The plan's agent stopped short wears the rail's amber ring here too.
  const short = useMemo(() => stoppedShort(latestPlan(events, state, agents), agents), [events, state, agents]);
  const go = (p: Part) => (onRail(), showPart(p));
  return (
    <footer className="status-bar session-bar work-bar" aria-label="Session status">
      {/* Who, with how each stands on its mark (a turning ring while it works, amber while it waits on you), then the run in
          words: the state is on the marks, not a dot before a word (DIRECTION.md §9.6; Arun, 2026-10-29: "so clean and beautiful
          really with a clear direction in design language"). */}
      <div className="stb-start">
        {agents.length > 0 && (
          <button type="button" className="wb-item wb-team" onClick={() => go("progress")} title="What each agent is doing">
            <span className="wb-marks">
              {agents.slice(0, 3).map((a) => (
                <PresenceRing key={a.lane} state={short === a.lane ? "needs" : PRESENCE[a.status]} size={18} square className="wb-mark" label={`${a.name}: ${short === a.lane ? "Stopped early" : STATUS_WORD[a.status]}`}>
                  <span className="wb-mark-disc">
                    <EngineMark tool={a.tool ?? ""} size={11} />
                  </span>
                </PresenceRing>
              ))}
            </span>
            <span className="wb-names">{names.length > 2 ? `${names[0]} and ${names.length - 1} more` : names.join(" & ") || ENGINE_NAMES.claude}</span>
          </button>
        )}
        <span className={`stb-run ${line.tone}`} title={line.detail || undefined}>
          {/* With no agent to wear the state (none started yet), the dot still says it. */}
          {!agents.length && <i className="stb-dot" aria-hidden="true" />}
          {/* Ready is the marks alone, as in Code's bar (StatusBar.tsx): its word kept for a screen reader. */}
          <span className={`stb-run-text${line.tone === "idle" && agents.length ? " sr-only" : ""}`} role="status">
            {line.text}
          </span>
        </span>
        {line.detail && line.tone === "busy" && <span className="stb-run-detail">{line.detail}</span>}
      </div>
      <div className="stb-end">
        <button type="button" className="wb-item wb-count" onClick={() => go("outputs")} title="What the agents made">
          <Icon name="file" size={13} />
          {made || hubs.length ? (
            <span>
              {made} {made === 1 ? "output" : "outputs"}
              {hubs.length > 0 && <em> · {hubs.length === 1 ? "1 collection" : `${hubs.length} collections`}</em>}
            </span>
          ) : (
            <span className="wb-quiet">No outputs yet</span>
          )}
        </button>
        {sources.n > 0 && (
          <button type="button" className="wb-item wb-count" onClick={() => go("sources")} title="What they searched and read">
            <Icon name="globe" size={13} />
            <span>
              {sources.n} {sources.n === 1 ? sources.word : sources.word === "search" ? "searches" : "sources"}
            </span>
          </button>
        )}
        <span className="stb-slot" ref={slot} />
        <span className="stb-sep" aria-hidden="true" />
        {root && (
          <button type="button" className={`wb-item wb-folder-btn${failed ? " tried-fail" : ""}`} onClick={() => tryIt(showFolder(root))} title={failed || `Show ${folder} in the Finder`} aria-label={`Show ${folder} in the Finder`}>
            <Icon name="folder" size={13} />
            <span className="wb-folder" aria-live="polite">{failed || folder}</span>
          </button>
        )}
        <button type="button" className={`wb-item wb-rail${open ? " on" : ""}`} onClick={() => (open && document.querySelector(".sv-body > .wr:not(.wr-shut)") ? setOpen(false) : (onRail(), setOpen(true)))} aria-pressed={open} title={open ? "Put the overview away" : "Show the overview"} aria-label="Overview">
          <Icon name="panelRight" size={14} />
        </button>
      </div>
    </footer>
  );
}

// ── the browser's start page ────────────────────────────────────────

/**
 * An empty tab of a Work session's Browser (Preview.tsx): the sites the agents read, one press from opening again, under the
 * address bar that searches or goes to an address. No dev servers, no project to run, no second search box (Arun, 2026-10-27:
 * "redesign the browser page too and no iOS"; "get rid of the search bar in the middle of the browser panel").
 */
export function BrowserStart({ onGo, suggest, sid, invite }: { onGo: (to: string) => void; suggest: { url: string; title: string }[]; sid?: string; invite?: string }) {
  const sites = useMemo(() => {
    const seen = new Set<string>();
    return suggest.filter((s) => {
      const host = hostOf(s.url);
      if (seen.has(host)) return false;
      seen.add(host);
      return true;
    });
  }, [suggest]);
  return (
    <div className="bs">
      {sites.length > 0 && (
        <section className="bs-sites">
          <h3 className="wr-sub">What the agents read</h3>
          <div className="bs-grid">
            {sites.slice(0, 12).map((s) => {
              const host = hostOf(s.url);
              // Its title when the agents' reading gave one; else the site alone (the address is in the tooltip).
              const title = s.title && !/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s.title) ? s.title : "";
              return (
                <button key={s.url} type="button" className="bs-site" onClick={() => onGo(s.url)} title={s.url}>
                  {sid && invite ? <SiteIcon host={host} sid={sid} invite={invite} /> : <span className="wr-source-ico">{host.slice(0, 1).toUpperCase()}</span>}
                  <span>
                    <b>{title || host}</b>
                    <em>{title ? host : "Home page"}</em>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}
      <p className="bs-note">Search or type an address above. Pages the agents open show here, where you can watch. This browser isn't signed in to your accounts; for those the agents use your own Chrome.</p>
    </div>
  );
}
