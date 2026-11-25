import { Suspense, cloneElement, isValidElement, lazy, useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { Manager, ManagerLevel, ManagerThread, ReadyItem } from "../managers.js";
import { ENGINE_NAMES } from "../types.js";
import { api } from "./api.js";
import { Icon } from "./icons.js";
import { TabRing, elapsed, useNow } from "./presence.js";
import type { Identity } from "./storage.js";
import { BlobFace } from "./teammate-face.js";
import { Shine } from "./shine.js";
import { MANAGER_STARTED } from "./manager-events.js";
import "./managers.css";

/**
 * The project Captains in the coding sidebar (spec 14, sidebar A3; Arun, 2026-11-24: "A3", "i dont want that full ring around the
 * mascot to be the thing just the small ring thing we have for the coding session tabs"): a bar of every Captain's face at the top,
 * each project's Captain on its tile with one line under its name, its panel (what it's doing, how much it may do, its queue, what
 * it did), and the sheet that sets one up. Its live state is the session tab's small ring beside it, never a ring round its face.
 */

/** A Captain as GET /api/managers sends it: with its threads (managers-run threadsOf, aeae2438). */
export type ManagerView = Manager & { threads?: ManagerThread[] };
/** A project as the sidebar knows it: its name, its folder, its threads now. */
export interface ManagedProject {
  name: string;
  folder: string;
  running: number;
  needs: number;
}

export const LEVEL_WORD: Record<ManagerLevel, string> = { watch: "Watch", help: "Help", run: "Run" };
// What each level does (2026-11-25, the advanced Captain): you can talk to it at every level.



const DAY = 24 * 3600_000;



/** Its "For you" questions from the last day: the person's to decide. */
export const forYouOf = (m: ManagerView, now = Date.now()) => m.log.filter((a) => a.kind === "for-you" && !a.answered && !a.dismissed && now - a.at < DAY);

/** The project a Captain minds, by its folder or its name. */
export function managerFor(managers: readonly ManagerView[], project: { name: string; folder?: string }): ManagerView | null {
  const folder = project.folder?.replace(/[\\/]+$/, "").toLowerCase();
  return managers.find((m) => (folder && m.project.folder.replace(/[\\/]+$/, "").toLowerCase() === folder) || m.project.name.toLowerCase() === project.name.toLowerCase()) ?? null;
}

/** Every Captain, read now and every few seconds while the window is showing, with what changes them. */
export function useManagers(identity: Identity, enabled = true) {
  const [managers, setManagers] = useState<ManagerView[]>([]);
  const [error, setError] = useState("");
  const seen = useRef<Set<string> | null>(null);
  /** New threads a Captain started since the last read: the session list is told to read them in. */
  const told = (list: readonly ManagerView[]) => {
    const now = new Set(list.flatMap((m) => m.log.filter((a) => a.kind === "started" && a.sid).map((a) => a.sid!)));
    if (seen.current && [...now].some((sid) => !seen.current!.has(sid))) dispatchEvent(new Event(MANAGER_STARTED));
    seen.current = now;
  };
  const read = useCallback(async () => {
    const got = await api<{ managers?: ManagerView[] }>(identity, "/api/managers").catch(() => null);
    if (got?.managers) (told(got.managers), setManagers(got.managers));
  }, [identity]);
  useEffect(() => {
    if (!enabled) return;
    void read();
    const t = setInterval(() => document.visibilityState === "visible" && void read(), 5_000);
    return () => clearInterval(t);
  }, [read, enabled]);
  const send = useCallback(
    async (path: string, method: string, body?: unknown) => {
      setError("");
      try {
        const got = await api<{ managers?: ManagerView[]; error?: string }>(identity, path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (got.error) return (setError(got.error), false);
        if (got.managers) (told(got.managers), setManagers(got.managers));
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      }
    },
    [identity],
  );
  return {
    identity,
    managers,
    error,
    read,
    create: (body: Record<string, unknown>) => send("/api/managers", "POST", body),
    change: (id: string, body: Record<string, unknown>) => send(`/api/managers/${id}`, "PATCH", body),
    remove: (id: string) => send(`/api/managers/${id}`, "DELETE"),
    queue: (id: string, text: string) => send(`/api/managers/${id}/queue`, "POST", { text }),
    unqueue: (id: string, task: string) => send(`/api/managers/${id}/queue/${task}`, "DELETE"),
    /** A thread's ready card put away. */
    doneReady: (id: string, sid: string, lane?: string) => send(`/api/managers/${id}/ready`, "POST", { sid, ...(lane ? { lane } : {}) }),
    /** One of its suggested next steps: onto its queue, or put away. */
    next: (id: string, at: number, take: boolean) => send(`/api/managers/${id}/next`, "POST", { at, take }),
    awaySeen: (id: string) => send(`/api/managers/${id}/away`, "POST", { seen: true }),
    say: (id: string, text: string) => send(`/api/managers/${id}/say`, "POST", { text }),
    newChat: (id: string) => send(`/api/managers/${id}/chat`, "POST", { new: true }),
    openChat: (id: string, at: number) => send(`/api/managers/${id}/chat`, "POST", { open: at }),
    deleteChat: (id: string, at: number) => send(`/api/managers/${id}/chat`, "POST", { delete: at }),
    giveUp: (id: string, goal: string) => send(`/api/managers/${id}/goals/${goal}`, "DELETE"),
    dismissSuggest: (key: string) => send("/api/managers/suggest/dismiss", "POST", { key }),
    answer: (id: string, at: number, text: string | null) => send(`/api/managers/${id}/answer`, "POST", text === null ? { at, dismiss: true } : { at, text }),
  };
}
export type ManagersApi = ReturnType<typeof useManagers>;

/** A Captain's face: the crew's blob, with the cap that marks it as the project's Captain. Asleep when it's off. */
export function ManagerFace({ m, size }: { m: Pick<ManagerView, "look" | "on">; size: number }) {
  return (
    <span className="mgr-face" style={{ width: size, height: size }} aria-hidden>
      <BlobFace seed={m.look} size={size} eyes={m.on ? "open" : "closed"} hat />
    </span>
  );
}

/** Its live state as a session tab shows one: working while its project runs, waiting when something needs you. */
const ringOf = (m: ManagerView, p: ManagedProject | undefined) => (!m.on ? null : (p?.needs ?? 0) + forYouOf(m).length > 0 ? ("needs" as const) : (p?.running ?? 0) > 0 ? ("working" as const) : null);

/**
 * The Captains at the top of the coding sidebar, C (Arun, 2026-11-25: "i need better mockups of the working states for the captains",
 * then "Build C"): a row each, what it's doing now under its name, live, and how it stands on the right: the session tab's ring and
 * how long it's been at it while a thread works, Asks or Ready as a pill, Off. Folded: the faces, every Captain a click away, and
 * under them the one thing for you (a question first, then work ready). Folded or not is remembered here; a row or face opens its Captain's window. Add is the way in.
 */
const BAR_KEY = "friday.captains.bar";
const readBarOpen = () => {
  try {
    return localStorage.getItem(BAR_KEY) === "open";
  } catch {
    return false;
  }
};
type BarTone = "off" | "needs" | "ready" | "working" | "quiet";
/** How a Captain stands for its row, from its live record and its project's threads now. */
function barStateOf(x: ManagerView, p: ManagedProject | undefined, now: number): { tone: BarTone; line: string; pill?: string; since?: number; more?: number } {
  if (!x.on) return { tone: "off", line: "Not watching" };
  const asks = forYouOf(x, now);
  const ts = x.threads ?? [];
  const waiting = ts.filter((t) => t.state === "needs");
  const needs = asks.length + Math.max(p?.needs ?? 0, waiting.length);
  if (needs) return { tone: "needs", line: asks[0]?.text ?? (waiting[0] ? `“${waiting[0].title}” needs you` : `${needs} waiting on you`), pill: asks.length ? "Asks" : "Needs you", more: needs - 1 };
  const ready = x.ready ?? [];
  if (ready.length) {
    const r = ready[0]!;
    const fact = readyFacts(r).split(" · ")[0];
    return { tone: "ready", line: fact ? `${r.title} · ${fact.charAt(0).toLowerCase()}${fact.slice(1)}` : r.title, pill: "Ready", more: ready.length - 1 };
  }
  const working = ts.filter((t) => t.state === "working").sort((a, b) => (a.since || now) - (b.since || now));
  if (working.length || (p?.running ?? 0) > 0) {
    const w = working[0];
    const extra = Math.max(working.length, p?.running ?? 0) - 1;
    const line = w ? `“${w.title}”${w.tool ? ` · ${ENGINE_NAMES[w.tool] ?? w.tool}` : ""}${extra > 0 ? ` · +${extra}` : ""}` : "Working";
    return { tone: "working", line, ...(w?.since ? { since: w.since } : {}) };
  }
  if (x.away && !x.away.back && x.away.until > now) return { tone: "quiet", line: `Away until ${clockOf(x.away.until)}` };
  const idle = ts.filter((t) => t.state === "idle" || t.state === "stopped").length;
  return { tone: "quiet", line: idle ? `${idle} thread${idle === 1 ? "" : "s"} idle` : x.queue.length ? `${x.queue.length} queued` : "All quiet" };
}
export function ManagersBar({ api: m, projects, open, setOpen, onAdd }: { api: ManagersApi; projects: ReadonlyMap<string, ManagedProject>; open: string | null; setOpen: (key: string | null) => void; onAdd: (project?: { name: string; folder: string }) => void }) {
  const [unfolded, setUnfolded] = useState(readBarOpen);
  const now = useNow();
  const fold = () =>
    setUnfolded((v) => {
      try {
        localStorage.setItem(BAR_KEY, v ? "shut" : "open");
      } catch {}
      return !v;
    });
  const states = new Map(m.managers.map((x) => [x.id, barStateOf(x, projects.get(x.project.name), now)]));
  const st = (x: ManagerView) => states.get(x.id)!;
  // Each trigger its own open state: a face and the folded line for the same Captain never open two windows.
  const pop = (x: ManagerView, trigger: ReactNode, where = "bar") => (
    <ManagerPopover key={x.id} m={x} p={projects.get(x.project.name)} api={m} open={open === `${where}:${x.id}`} onOpenChange={(v) => setOpen(v ? `${where}:${x.id}` : null)}>
      {trigger}
    </ManagerPopover>
  );
  const row = (x: ManagerView) => {
    const b = st(x);
    return pop(
      x,
      <button type="button" className={`mgr-crow ${b.tone}`} aria-label={`Captain of ${x.project.name}`} title={b.line}>
        <span className="mgr-crow-face">
          <ManagerFace m={x} size={22} />
        </span>
        <span className="mgr-crow-name">{x.project.name}</span>
        <span className="mgr-crow-r">
          {b.tone === "working" ? (
            <>
              <TabRing state="working" />
              {b.since ? elapsed(b.since, now) : null}
            </>
          ) : b.pill ? (
            <span className={`mgr-crow-pill ${b.tone}`}>{b.pill}</span>
          ) : b.tone === "off" ? (
            "Off"
          ) : null}
        </span>
        <span className="mgr-crow-line">{b.tone === "working" ? <Shine>{b.line}</Shine> : b.line}</span>
      </button>,
    );
  };
  // Folded: the one thing for you, a question first, then work ready.
  const urgent = m.managers.find((x) => st(x).tone === "needs") ?? m.managers.find((x) => st(x).tone === "ready");
  const faces = (
    <span className="mgr-bar-row">
      {m.managers.map((x) =>
        pop(
          x,
          <button type="button" className={`mgr-bar-face mini${x.on ? "" : " off"}`} aria-label={`Captain of ${x.project.name}`} title={`${x.project.name}: ${st(x).line}`}>
            <span className="mgr-bar-pic">
              <ManagerFace m={x} size={20} />
              {st(x).tone === "working" && <span className="mgr-bar-dot working" />}
            </span>
          </button>,
        ),
      )}
    </span>
  );
  const add = (
    <button type="button" className="mgr-bar-add" onClick={() => onAdd()} aria-label="Set up a Captain" title="Set up a Captain">
      <Icon name="plus" size={13} />
    </button>
  );
  return (
    <div className={`mgr-bar${unfolded ? " unfolded" : ""}`} data-testid="managers-bar">
      <div className="mgr-bar-head">
        <button type="button" className="mgr-bar-fold" onClick={fold} aria-expanded={unfolded} aria-label={unfolded ? "Fold the Captains" : "Unfold the Captains"}>
          <Icon name={unfolded ? "chevronDown" : "chevronRight"} size={12} />
          <b>Captains</b>
          {!m.managers.length && <span>One per project</span>}
        </button>
        {!unfolded && m.managers.length > 0 && faces}
        {add}
      </div>
      {unfolded && m.managers.length > 0 && <div className="mgr-crows">{m.managers.map(row)}</div>}
      {!unfolded &&
        urgent &&
        pop(
          urgent,
          <button type="button" className={`mgr-cnow ${st(urgent).tone}`} title={st(urgent).line}>
            <ManagerFace m={urgent} size={16} />
            <span className="mgr-cnow-t">
              <b>{urgent.project.name}</b> {st(urgent).tone === "needs" ? `asks: ${st(urgent).line}` : `ready: ${st(urgent).line}`}
            </span>
          </button>,
          "now",
        )}
    </div>
  );
}

/** A project's tile with its Captain's face on its corner. */
export function ManagedTile({ m, tile }: { m: ManagerView; tile: ReactNode }) {
  return (
    <span className="mgr-tile">
      {tile}
      <span className="mgr-tile-face">
        <ManagerFace m={m} size={12} />
      </span>
    </span>
  );
}

/** Its one line under the project's name: "Captain · Run · 3 running", and the tab's ring. Opens its panel. */
export function ManagerLine({ m, p, ...rest }: { m: ManagerView; p: ManagedProject | undefined } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const asks = forYouOf(m).length + (p?.needs ?? 0);
  const what = !m.on ? "off" : asks ? `${asks} for you` : p?.running ? `${p.running} running` : m.queue.length ? `${m.queue.length} queued` : "all quiet";
  return (
    <button type="button" className="mgr-line" data-testid="manager-line" {...rest}>
      <TabRing state={ringOf(m, p)} />
      <b>Captain</b>
      <span>· {m.on ? LEVEL_WORD[m.level] : "Off"}</span>
      <span className={asks && m.on ? "mgr-asks" : ""}>· {what}</span>
    </button>
  );
}


/**
 * Its strip in the project's card, between the facts and the threads (the B layout): its face, "Captain" with its level and the
 * session tab's small ring, what it did last, and its questions as one pill. Opens its panel.
 */
export function CaptainStrip({ m, p, ...rest }: { m: ManagerView; p: ManagedProject | undefined } & ButtonHTMLAttributes<HTMLButtonElement>) {
  // A band across the top of its project's card (2026-11-25: H, "keep it clean and only important stuff like status and mode"):
  // its face, Captain and its mode, and how it stands in a word or a count. What it did lives in its popover.
  const asks = m.on ? forYouOf(m).length + (p?.needs ?? 0) : 0;
  const ready = m.on ? (m.ready?.length ?? 0) : 0;
  const ring = ringOf(m, p);
  const tone = !m.on ? "off" : asks > 0 ? "needs" : ready > 0 ? "ready" : ring === "working" ? "working" : "quiet";
  return (
    <button type="button" className={`mgr-strip mgr-band ${tone}`} data-testid="captain-strip" {...rest}>
      <ManagerFace m={m} size={18} />
      <span className="mgr-band-t">
        <b>Captain</b>
        <span className="mgr-band-lv">{m.on ? LEVEL_WORD[m.level] : "Off"}</span>
      </span>
      {asks > 0 ? (
        <span className="mgr-band-pill">{asks} for you</span>
      ) : ready > 0 ? (
        <span className="mgr-band-pill ready">{ready} ready</span>
      ) : (
        <span className="mgr-band-s">
          <TabRing state={ring} />
          {!m.on ? "Paused" : ring === "working" ? "Working" : "All quiet"}
        </span>
      )}
    </button>
  );
}

export const clockOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
/** A ready item's facts in a few words: "tests pass · 4 files · +27 −3". */
export const readyFacts = (r: ReadyItem) =>
  r.facts
    .replace(/^(Checked|Done)\s*·\s*/i, "")
    .replace(/(\d+ files?) ([+−-])/, "$1 · $2")
    .replace(/^./, (c) => c.toUpperCase());

const CaptainWindow = lazy(() => import("./ManagerWindow.js").then((x) => ({ default: x.CaptainWindow })));
const LazySetup = lazy(() => import("./ManagerWindow.js").then((x) => ({ default: x.ManagerSetup })));

/**
 * The panel as a modal opened from anything inside `children` (2026-11-25: "into a modal as well so we have more space"): its
 * header, then two columns. Its settings open in their own modal from its gear.
 */
export function ManagerPopover({ m, p, api, open, onOpenChange, children }: { m: ManagerView; p: ManagedProject | undefined; api: ManagersApi; open: boolean; onOpenChange: (v: boolean) => void; children: ReactNode }) {
  const [sheet, setSheet] = useState(false);
  const trigger = isValidElement<{ onClick?: (e: React.MouseEvent) => void }>(children)
    ? cloneElement(children, {
        onClick: (e: React.MouseEvent) => {
          children.props.onClick?.(e);
          onOpenChange(true);
        },
      })
    : children;
  // The window and its settings load the first time one is opened, not with the sidebar (the first screen's budget).
  const [used, setUsed] = useState(false);
  if ((open || sheet) && !used) setUsed(true);
  return (
    <>
      {trigger}
      {used && (
        <Suspense fallback={null}>
          <CaptainWindow m={m} p={p} api={api} open={open} onOpenChange={onOpenChange} sheet={sheet} setSheet={setSheet} />
        </Suspense>
      )}
    </>
  );
}

/** The New Captain sheet, loaded the first time it opens. */
export function ManagerSetup(props: { api: ManagersApi; projects: readonly { name: string; folder: string }[]; initial?: string; open: boolean; onClose: () => void }) {
  const [used, setUsed] = useState(false);
  if (props.open && !used) setUsed(true);
  return used ? (
    <Suspense fallback={null}>
      <LazySetup {...props} />
    </Suspense>
  ) : null;
}
