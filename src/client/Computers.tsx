import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { MenuButton, relTime, useDismiss } from "./ui.js";
import { pickMachine, pickedMachine } from "./local.js";
import { pollWhileShown } from "./app-push.js";
import { Icon } from "./icons.js";
import { bestComputer, rankComputers, toolName, type MachineFacts, type PlaceAsk } from "../placement.js";

/**
 * Your other computers, for the open-source edition (Arun, 2026-10-30: "lets also add support for multi machine for coding and
 * crew"). Settings › Computer › Your computers: add one with a link to paste in its Friday, see which are linked
 * now, take one away; and on another computer, paste that link to use it from here (local/computers.ts, local/join.ts).
 * The new-session page says which computer it runs on, on its own line above the box (RunsOn).
 */

export interface LinkedComputer {
  id: string;
  name: string;
  at: number;
  seen: number;
  connected: boolean;
  tools: { tool: string; name: string; loggedIn?: boolean | null }[];
  platform: string;
  /** What tells it apart from another of the same name: its system, and its host name or address (computers.ts computerDetail). */
  detail?: string;
  /** The Friday it runs, as it said when it last linked. */
  version?: string;
  /** Why it can't link, when this computer can tell: only pairing it again fixes it. */
  problem?: string;
  /** What it is and has now (placement.ts), from a Friday that answers `machine.facts`. */
  facts?: MachineFacts | null;
  address?: string;
}
/** Why this computer can't link to the one it is used from (join.ts JoinProblem). */
export interface JoinProblem {
  kind: "certificate" | "refused" | "unreachable" | "removed";
  said: string;
  at: number;
  repair: boolean;
}
export interface State {
  /** This computer: its name, the coding tools signed in here, and what it is and has now. */
  here?: { name: string; platform: string; tools: { tool: string; name: string; loggedIn?: boolean | null }[]; facts: MachineFacts | null };
  computers: LinkedComputer[];
  joined: { hub: { name: string; connected: boolean; address?: string; since?: number; tried?: number; problem?: JoinProblem; version?: string } | null; version?: string; error?: string } | null;
  /** The Friday this computer runs. */
  version?: string;
  error?: string;
}

/** "Friday 0.2.11", or both when they differ: an older one there can't do everything this one asks of it. */
export const versions = (there: string | undefined, here: string | undefined) => (!there ? "" : here && here !== there ? `Friday ${there} there, ${here} here` : `Friday ${there}`);

export const call = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
  const r = await fetch(path, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json", "x-friday-local": "1", ...init.headers } });
  const b = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(b.error || "Couldn't reach Friday.");
  return b;
};

/** The computers linked now, as the places a session can run, refreshed while something shows them. */
export function useComputers(every = 8_000): { id: string; label: string; detail?: string }[] & { read?: true } {
  const [list, setList] = useState<{ id: string; label: string; detail?: string }[] & { read?: true }>([]);
  useEffect(() => {
    let gone = false;
    // `read` once the list has come back: an empty one then is "none linked now", not "not asked yet".
    const read = () => void call<{ machines: { id: string; label: string; detail?: string }[] }>("/api/machines").then((r) => !gone && setList(Object.assign(r.machines, { read: true as const })), () => {});
    read();
    const t = setInterval(read, every);
    return () => ((gone = true), clearInterval(t));
  }, [every]);
  return list;
}

/** When a computer was last here, as "Runs on" says it: "just now", "2h ago", "on Nov 3". */
export function lastSeen(seen: number): string {
  const r = relTime(seen);
  return r === "now" ? "just now" : /^\d+[mhd]$/.test(r) ? `${r} ago` : `on ${r}`;
}

/**
 * The line under a computer's name in "Runs on": what stops it taking work (a problem only pairing again fixes, or not being
 * connected and since when), else the coding tools signed in there, and an older or newer Friday there than here.
 */
export function computerLine(c: Pick<LinkedComputer, "connected" | "seen" | "tools" | "problem" | "version">, here?: string): string {
  if (c.problem) return c.problem;
  if (!c.connected) return `Not connected · last seen ${lastSeen(c.seen)}`;
  const ready = c.tools.filter((t) => t.loggedIn === true).map((t) => t.name);
  const tools = ready.length ? ready.join(", ") : "No coding tool signed in";
  return c.version && here && c.version !== here ? `${tools} · Friday ${c.version} there` : tools;
}

/**
 * Where a new session runs, on its own line above the box (Arun, 2026-11-07: "Move the machine selector to above the input
 * chat", design B on the "Run on another computer" canvas). Always there in the open-source edition, so running on another of
 * your computers can be found before one is added: "Runs on This computer", and its menu offers Add a computer… in place, the
 * way Settings › Computer › Your computers does. Every computer paired is listed: connected ones with the coding tools signed
 * in there, the rest greyed with when they were last seen. The pick is this browser's (local.ts pickMachine), so the folders and
 * tools offered in the box are that computer's. `onPick`: the folder picked was the other computer's, so it goes.
 */
export function RunsOn({ onPick, ask }: { onPick?: () => void; /** What the run needs, as far as the page knows: placement weighs it. */ ask?: PlaceAsk }) {
  const [state, setState] = useState<State | null>(null);
  const [on, setOn] = useState(pickedMachine);
  const [adding, setAdding] = useState(false);
  const [mapping, setMapping] = useState(false);
  /** Picked as "Best": the computer placement chose, and why, said on the line (spec 09 step 1). */
  const [bestWhy, setBestWhy] = useState<string>("");
  /** A computer picked that isn't connected now, so the work runs here: said beside the line until another is picked. */
  const [fellBack, setFellBack] = useState("");
  const [n, setN] = useState(0);
  useEffect(() => {
    let gone = false;
    // The same answer leaves the line as it is: set anew, the box under it drew again every 8 seconds.
    const read = () => void call<State>("/api/computers").then((r) => !gone && setState((was) => (JSON.stringify(was) === JSON.stringify(r) ? was : r)), () => {});
    // Asked when a computer links or goes (app-push.ts), not every 8 seconds; as before where nothing tells it.
    const stop = pollWhileShown(read, { every: 8_000, on: ["computers"] });
    return () => ((gone = true), stop());
  }, [n]);
  useEffect(() => {
    const sync = () => setOn(pickedMachine());
    addEventListener("friday:machine", sync);
    return () => removeEventListener("friday:machine", sync);
  }, []);
  // The one picked is gone or not connected now: back to this computer, said beside the line, rather than every start failing
  // there (and the page asking its tools of it, a red "Forbidden" in the console every few seconds).
  useEffect(() => {
    if (!on || !state) return;
    const c = state.computers.find((x) => x.id === on);
    if (c?.connected) return;
    pickMachine("");
    if (c) setFellBack(c.name);
  }, [on, state]);
  const computers = state?.computers ?? [];
  const current = computers.find((c) => c.id === on);
  // Each of your computers for this run, ranked (placement.ts): this one is "" and named "This computer".
  const candidates = state ? [{ id: "", name: "This computer", connected: true, tools: state.here?.tools ?? [], facts: state.here?.facts ?? null }, ...computers.map((c) => ({ id: c.id, name: c.name, connected: c.connected, tools: c.tools, facts: c.facts ?? null }))] : [];
  const ranked = rankComputers(candidates, ask ?? {});
  const best = bestComputer(candidates, ask ?? {});
  const whyOf = (id: string) => ranked.find((r) => r.id === id);
  // One short line per computer in the menu (Arun, 2026-11-21: "design this better"): what it's doing, the picked tool's limit,
  // the repo there, and battery only when it's on one. Never more than three, so it never wraps.
  const shortLine = (id: string): string | undefined => {
    const c = candidates.find((x) => x.id === id);
    const f = c?.facts;
    const r = whyOf(id);
    if (!c || !f || !r?.ok) return undefined;
    const lim = ask?.tool ? f.limits[ask.tool] : undefined;
    const here = r.why.find((w) => w.endsWith(" is here"));
    return [
      f.agents ? `${f.agents} running` : "Idle",
      lim ? `${toolName(ask!.tool!)} ${Math.round(lim.usedPercent)}%` : "",
      here ?? "",
      f.power === "battery" ? `battery ${f.batteryPercent ?? "?"}%` : "",
    ].filter(Boolean).slice(0, 3).join(" · ");
  };
  const choose = (id: string, why = "") => {
    setFellBack("");
    setBestWhy(why);
    if (id === on) return;
    pickMachine(id);
    onPick?.();
  };
  return (
    <div className="cw-runs-on">
      <span className="cw-runs-label">Runs on</span>
      <MenuButton
        className="cw-drop cw-computer"
        label={`Runs on ${current?.name ?? "this computer"}. Choose another computer`}
        text={current?.name ?? "This computer"}
        mark={<Icon name="server" size={13} />}
        width={320}
        items={() => [
          { heading: "Runs on" },
          // Placement's pick, when there's more than one computer to pick from: it chooses now, and the line says why.
          ...(computers.length && best
            ? [{ label: `Best: ${best.name}`, sub: shortLine(best.id) ?? "Ready", icon: "zap" as const, onSelect: () => choose(best.id, best.why.slice(0, 3).join(", ")) }]
            : []),
          { label: "This computer", sub: shortLine(""), icon: "server", checked: !on, onSelect: () => choose("") },
          ...computers.map((c) => ({
            label: c.name,
            sub: (c.connected && shortLine(c.id)) || computerLine(c, state?.version),
            title: [c.detail, versions(c.version, state?.version)].filter(Boolean).join(" · "),
            icon: "server" as const,
            checked: c.id === on,
            live: c.connected,
            disabled: !c.connected,
            onSelect: () => choose(c.id),
          })),
          ...(computers.length ? [{ label: "See your computers…", sub: "What each has now, and how they link", icon: "server" as const, onSelect: () => setMapping(true) }] : []),
          { label: "Add a computer…", sub: "Nearby, over SSH, a command or a link", icon: "plus", onSelect: () => setAdding(true) },
        ]}
      />
      {bestWhy && <span className="cw-runs-note">Best: {bestWhy}.</span>}
      {mapping && state && <MapDialog state={state} onClose={() => setMapping(false)} onAdd={() => (setMapping(false), setAdding(true))} />}
      {fellBack && <span className="cw-runs-note">{fellBack} isn't connected, so this runs here.</span>}
      {adding && <AddComputer onClose={() => (setAdding(false), setN((x) => x + 1))} />}
    </div>
  );
}

// Settings › Computer › Your computers is ComputersSettings.tsx, loaded with Settings or when Runs on › Add a computer… opens:
// the new-session page draws RunsOn and the Crew useComputers with the first screen, and the page (about 15 KB) came with them.
const ComputersSettings = lazy(() => import("./ComputersSettings.js").then((m) => ({ default: m.ComputersSettings })));

const MachinesMap = lazy(() => import("./MachinesMap.js").then((m) => ({ default: m.MachinesMap })));

/** Runs on › See your computers…: the map of them, in a dialog over the new-session page. */
function MapDialog({ state, onClose, onAdd }: { state: State; onClose: () => void; onAdd: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  return (
    <div className="overlay">
      <div ref={ref} className="modal runs-map" role="dialog" aria-modal="true" aria-label="Your computers">
        <div className="pop-head">
          <div>
            <h2>Your computers</h2>
            <p className="muted small">What each one has now, and how it links to this one.</p>
          </div>
          <button className="icon-btn tiny" type="button" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <Suspense fallback={null}>
          <MachinesMap state={state} onAdd={onAdd} />
        </Suspense>
      </div>
    </div>
  );
}

/** Runs on › Add a computer…: Settings' own way of adding one, in a dialog over the new-session page. */
function AddComputer({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  return (
    <div className="overlay">
      <div ref={ref} className="modal runs-add" role="dialog" aria-modal="true" aria-label="Add a computer">
        <div className="pop-head">
          <div>
            <h2>Add a computer</h2>
            <p className="muted small">Link another of your computers, and agents can run there too.</p>
          </div>
          <button className="icon-btn tiny" type="button" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <Suspense fallback={null}>
          <ComputersSettings adding onDone={onClose} />
        </Suspense>
      </div>
    </div>
  );
}
