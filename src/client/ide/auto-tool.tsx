import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import type { AutoPick } from "../../ide-routing.js";
import type { EngineTool } from "../../types.js";
import { api } from "../api.js";
import type { Identity } from "../storage.js";
import "./routing.css";

/**
 * Auto in Code's tool picker (Arun, 2026-11-20, wave 5: "Friday picks the coding tool for a Code chat by what's left on each plan"):
 * the tool with the most room on the person's own plans for the task being typed, with a line saying why. The ranking is the
 * server's (POST /api/vscode/auto, ide-routing.ts autoPick: it already holds each plan's windows and what routing learned), asked as
 * the words are typed.
 *
 * Opt-in, kept per computer: the picker stays on the person's own pick until they choose Auto, and choosing a tool by hand turns it
 * off again. The tool the person had is kept in mind (`usual`), so two tools with about the same room don't swap as words are typed.
 *
 * All of it lives here, loaded with Code's column and not with the first screen (test/client-bundle.test.ts): the composer
 * (Code.tsx) only mounts this and hands what it makes to the picker. Few imports on purpose: each name a lazy chunk takes from the
 * first screen's code is one more the first screen must export.
 */
const KEY = "friday.autoTool";
/** Limits move while a task is written: asked again this often while Auto is on. */
const AGAIN_MS = 2 * 60_000;

/** What the composer gets from Auto: the switch, and the picker's card. */
export interface AutoCtl {
  on: boolean;
  set: (on: boolean) => void;
  card: ReactNode;
}

export default function AutoTool({ identity, task, engine, setEngine, chose, onCtl }: { identity: Identity; task: string; engine: EngineTool | ""; setEngine: (t: EngineTool) => void; chose: MutableRefObject<boolean>; onCtl: (c: AutoCtl) => void }) {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  });
  const [pick, setPick] = useState<AutoPick | null>(null);
  const usual = useRef<EngineTool | "">("");
  // The picker's tool as of this render: `set` is handed on to the picker once and read later, so it can't close over `engine`
  // (a tool picked by hand while Auto was off would not be the one kept when Auto turns on: 2026-11-20 review).
  const now = useRef<EngineTool | "">(engine);
  now.current = engine;
  // The tool Auto set itself: another one showing is the person's pick, and Auto steps aside for it.
  const mine = useRef<EngineTool | "">("");
  const set = (v: boolean) => {
    if (v && !on) (usual.current = now.current), (mine.current = now.current);
    if (!v) setPick(null);
    setOn(v);
    try {
      localStorage.setItem(KEY, v ? "1" : "0");
    } catch {
      // Kept for this visit only.
    }
  };
  useEffect(() => {
    // While Auto is off, the tool the person has is the one Auto would keep.
    if (!on || !usual.current) usual.current = engine;
    if (on && engine && mine.current && engine !== mine.current) (usual.current = engine), set(false);
  }, [engine]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!on) return;
    let live = true;
    const ask = () =>
      void api<{ pick: AutoPick | null }>(identity, "/api/vscode/auto", { method: "POST", body: JSON.stringify({ task: task.slice(0, 2000), usual: usual.current }) }).then(
        (r) => live && setPick(r.pick),
        () => {
          // A moment away: the last pick stands.
        },
      );
    // Not on every keystroke.
    const t = setTimeout(ask, 500);
    const every = setInterval(ask, AGAIN_MS);
    return () => ((live = false), clearTimeout(t), clearInterval(every));
  }, [on, task]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!on || !pick || pick.tool === engine) return;
    // Not second-guessed by the composer's own choice of a first tool (Code.tsx `chose`).
    chose.current = true;
    mine.current = pick.tool;
    setEngine(pick.tool);
  }, [on, pick?.tool]); // eslint-disable-line react-hooks/exhaustive-deps
  const why = pick?.why ?? "Friday picks the tool with the most room on your plans";
  useEffect(
    () =>
      onCtl({
        on,
        set,
        card: (
          <div className="rt-auto-card">
            <p className="rt-auto-why">{why}</p>
            <p className="rt-auto-note">Friday picks the tool with the most room left on your own plans for what you ask. Pick a tool on the left to choose yourself.</p>
            <button type="button" className="rt-auto-off" onClick={() => set(false)}>Turn Auto off</button>
          </div>
        ),
      }),
    [on, why],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  return on && pick ? (
    <span className="rt-auto-line" title={pick.why} role="status">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden>
        <path d="M9 1.5 3 9h4.5L7 14.5 13 7H8.5z" />
      </svg>
      <span className="rt-auto-text">{pick.why}</span>
    </span>
  ) : null;
}
