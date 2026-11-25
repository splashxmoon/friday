import { useContext, useEffect, useId, useState, type ReactNode } from "react";
import { stepKind } from "../run-strip.js";
import { tickEvery } from "./presence.js";
import { doingVerb, stepsSummary } from "../step-summary.js";
import { Shine } from "./shine.js";
import { BrainIcon, CircleDotIcon, EyeIcon, GlobeIcon, MessageCircleQuestionIcon, PencilLineIcon, SearchIcon, SquareTerminalIcon, SquareArrowOutUpRightIcon, UsersIcon } from "lucide-react";
import "./run-line.css";
import { useHeldWords } from "./work-line.js";
import { Orb } from "@/components/aicss/Orb";
import { StepList, tookFor, type Step } from "./Response.js";
import { IdeChatContext } from "./ide/mode.js";
import { LIVE_WORDS } from "../step-words.js";

/**
 * A reply's work as one line (Arun, 2026-11-14, direction A of the working-state mockups: "instead of having so many of these",
 * the column of "Thought for 5s · Ran a command" rows). While the agent works the line says the step under way and changes in
 * place, the words shining across ("add that shimmer animation tho like how it goes across the text"), with a tick per step and
 * the clock. Done, it is one summary, "Worked 2m 40s · read 4 files, ran 5 commands", which opens to the steps grouped by kind
 * and what it said along the way. Ported to the open-source edition from Friday Teams 566e73d9.
 */

type Block = { kind: "work"; id: string; steps: Step[] } | { kind: "think"; key: string; thought: string; secs: number } | { kind: string };

/** What a step is doing, said while it runs: "Running npm test", "Reading cart.ts". */
const doingOf = (s: Step) => `${doingVerb(s.verb)}${s.target ? ` ${clip(s.target, 72)}` : ""}`;
const clip = (s: string, n: number) => ((t) => (t.length > n ? `${t.slice(0, n - 1)}…` : t))(s.replace(/\s+/g, " "));
const baseOf = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * A crew mate's step said in plain words for its working line (work-line.tsx): "Reading checkout.ts", "Searching the code",
 * "Running the tests", never the raw command; `full` is the whole of it, for the hover. `kind` is the face's motion.
 */
export function plainStep(blocks: readonly Block[], waiting = false): { words: string; full: string; kind: string } {
  if (waiting) return { words: "Waiting for an answer", full: "Waiting for an answer", kind: "" };
  const steps = blocks.flatMap((b) => (b.kind === "work" && "steps" in b ? b.steps : []));
  const s = steps.findLast((x) => x.state === "running") ?? (blocks.at(-1)?.kind === "think" ? undefined : steps.at(-1));
  if (!s) return { words: "Thinking", full: "Thinking", kind: "think" };
  const full = doingOf(s);
  const k = stepKind(s);
  const file = s.target ? clip(baseOf(s.target), 40) : "";
  if (s.verb === "Searched the web") return { words: "Searching the web", full, kind: "search" };
  if (k === "read") return { words: file ? `Reading ${file}` : "Reading files", full, kind: "read" };
  if (k === "search") return { words: "Searching the code", full, kind: "search" };
  if (k === "edit") return { words: file ? `Editing ${file}` : "Editing files", full, kind: "edit" };
  if (k === "test") return { words: "Running the tests", full, kind: "run" };
  if (k === "run") return { words: /\b(build|tsc|compile)\b/i.test(s.target ?? "") ? "Building" : "Running a command", full, kind: "run" };
  return { words: doingVerb(s.verb).replace(/…$/, ""), full, kind: "work" };
}

/** Each kind of step's mark in the opened line (Arun, 2026-11-17: "add svg icons next to the steps like looked at, searched, changed, ran"). */
function GroupIcon({ k, tip }: { k: string; tip?: string }) {
  const I = k === "think" ? BrainIcon : k === "read" ? EyeIcon : k === "search" ? SearchIcon : k === "edit" ? PencilLineIcon : k === "run" ? SquareTerminalIcon : k === "web" ? GlobeIcon : k === "open" ? SquareArrowOutUpRightIcon : k === "ask" ? MessageCircleQuestionIcon : k === "crew" ? UsersIcon : CircleDotIcon;
  const mark = <I className="rl-icon" data-k={k.split(":")[0]} aria-hidden="true" />;
  // Code's column drops the kind's word beside its mark; the mark carries it as a tip (a span of its own: a tip is not given to an svg).
  return tip ? <span className="rl-mk" title={tip}>{mark}</span> : mark;
}

/** The kinds whose mark is their own (the rest share the dot, so keep their word). */
const OWN_MARK = new Set(["read", "search", "edit", "run", "web", "open", "think"]);

/** The kind a step's group is: what it looked at, searched, changed, ran, or anything else by its own verb. */
function groupOf(s: Step): { key: string; label: string } {
  if (s.mark === "@") return { key: "crew", label: "With the crew" };
  if (s.verb === "Searched the web") return { key: "web", label: "Searched the web" };
  if (s.verb === "Opened") return { key: "open", label: "Opened" };
  const k = stepKind(s);
  if (k === "read") return { key: "read", label: "Looked at" };
  if (k === "search") return { key: "search", label: "Searched" };
  if (k === "edit") return { key: "edit", label: "Changed" };
  if (k === "run" || k === "test") return { key: "run", label: "Ran" };
  if (k === "ask") return { key: "ask", label: "Asked" };
  return { key: `other:${s.verb}`, label: s.verb };
}

/** What kind of step is under way, for the mascot's motion beside the reply (style.css .rsp-avatar[data-doing]). */
export function doingKind(blocks: readonly Block[], live: boolean): string {
  if (!live) return "";
  const steps = blocks.flatMap((b) => (b.kind === "work" && "steps" in b ? b.steps : []));
  const now = steps.findLast((s) => s.state === "running");
  if (!now) return blocks.at(-1)?.kind === "think" || !steps.length ? "think" : "work";
  const k = stepKind(now);
  return k === "test" ? "run" : k;
}

function Clock({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // The page's one 1-second ticker, shared with every other clock and still while the window is hidden (presence.tsx).
    return tickEvery(1000, setNow);
  }, []);
  return <span className="rl-clock">{now - since >= 1000 ? tookFor(now - since) : ""}</span>;
}

export function RunLine({ blocks, live, since, took, waiting = false, writing = false, forecast, notes, plain = false, startOpen = false, bare = false }: { blocks: readonly Block[]; live: boolean; since?: number; took: number; waiting?: boolean; writing?: boolean; forecast?: string; /** What it said along the way, shown when the line is opened. */ notes?: ReactNode; /** A crew mate's: the step under way and the clock, without a tick per step. */ plain?: boolean; /** Shown opened (a crew mate's work, asked for from its message). */ startOpen?: boolean; /** Its steps alone, under a line that already says the one under way (work-line.tsx WorkLine): no head, each kind closed until pressed. */ bare?: boolean }) {
  const inColumn = useContext(IdeChatContext) !== null;
  const [open, setOpen] = useState(startOpen || bare);
  // The group opened: undefined follows the step under way while it works (its group opens as the line does), null is none.
  const [group, setGroup] = useState<string | null | undefined>(undefined);
  const body = useId();
  const steps = blocks.flatMap((b) => (b.kind === "work" && "steps" in b ? b.steps : []));
  const thinks = blocks.filter((b): b is Extract<Block, { kind: "think" }> => b.kind === "think" && "thought" in b);
  const thoughtOwn = thinks.some((t) => t.thought.trim());
  const thoughtSecs = thinks.reduce((n, t) => n + t.secs, 0);
  const running = steps.findLast((s) => s.state === "running");
  const failed = steps.filter((s) => s.state === "failed").length;

  // The line: while it works, the step under way; done, the whole run in a sentence.
  // Said as the crew's working line says it (work-line.tsx): the step in plain words ("Running the tests"), the whole command on
  // hover, each step held a moment and risen in, a long think said its other ways (Arun, 2026-11-17: "bring this work line stuff
  // design into the coding sessions... more advanced for the coding session and interactive as well").
  const plainNow = plainStep(blocks, waiting);
  // Between steps, the words the sidebar's row, the side panel and the board say (step-words.ts LIVE_WORDS, spec 13 polish): writing its
  // answer, thinking (aloud, or its last step back), or not heard from yet.
  // Its words streaming beat a step that still looks under way: a model writing has had its steps back, and a step whose result is
  // never logged (a plan) read "Planning" over its streaming answer until a reload, then "Writing its answer" (2026-11-24 walk).
  const word = waiting ? "Waiting for an answer" : writing ? LIVE_WORDS.writing : running ? plainNow.words : blocks.at(-1)?.kind === "think" || steps.length ? LIVE_WORDS.thinking : LIVE_WORDS.starting;
  // Nothing to open yet (a reply only writing): the line is its words and clock alone.
  const empty = !steps.length && !thinks.length;
  const full = running ? doingOf(running) : word;
  const words = useHeldWords(word, live);
  const opened = group === undefined ? (live && running && !bare ? groupOf(running).key : null) : group;
  const pick = (key: string) => setGroup(opened === key ? null : key);
  const summary = stepsSummary(steps, thoughtSecs);
  const doneLine = [took >= 1000 ? `Worked ${tookFor(took)}` : "", took >= 1000 ? summary.charAt(0).toLowerCase() + summary.slice(1) : summary].filter(Boolean).join(" · ");
  // A tick per step, the newest last; a long run keeps its last 24.
  const ticks = steps.slice(-24);

  // Opened: the steps by kind, in the order each kind first came up, and the thinking first when there was some.
  const groups: { key: string; label: string; steps: Step[] }[] = [];
  for (const s of steps) {
    const g = groupOf(s);
    const at = groups.find((x) => x.key === g.key);
    if (at) at.steps.push(s);
    else groups.push({ ...g, steps: [s] });
  }
  // Who it talked with, for the crew's line ("Messaged Ivy, posted an update"); what it touched, for the rest.
  const what = (g: { key?: string; steps: Step[] }) =>
    g.key === "crew" ? clip([...new Set(g.steps.map((s) => s.verb))].map((v, i) => (i ? v.charAt(0).toLowerCase() + v.slice(1) : v)).join(", "), 90) : clip([...new Set(g.steps.map((s) => s.target).filter((t): t is string => !!t))].join(", "), 90);
  const side = (g: { key: string; steps: Step[] }) => {
    const bad = g.steps.filter((s) => s.state === "failed").length;
    const n = g.steps.length;
    if (bad) return { text: `${bad} failed`, tone: "bad" };
    if (g.steps.some((s) => s.state === "running")) return { text: "now", tone: "live" };
    return { text: g.key === "read" || g.key === "edit" ? `${new Set(g.steps.map((s) => s.target)).size} file${new Set(g.steps.map((s) => s.target)).size === 1 ? "" : "s"}` : `${n}×`, tone: "" };
  };

  return (
    <div className={`rl${live ? " live" : ""}${failed && !live ? " has-fail" : ""}${bare ? " bare" : ""}`} data-orb={live && !waiting && !bare ? "" : undefined}>
      {!bare && <button type="button" className="rl-head" aria-expanded={empty ? undefined : open} aria-controls={empty ? undefined : body} onClick={() => !empty && setOpen((o) => !o)}>
        {/* The same nine-cell grid as the reply's "Thinking" line, so working reads as the same thing moving on. */}
        {live && !waiting && <Orb variant="S3" size={14} label={word} />}
        <span className="rl-text">
          {live ? (
            // Keyed by the step, so each new one slides in over the last.
            <Shine key={words} on={!waiting} className={`rl-now${waiting ? " needs" : ""}`} {...(full !== words ? { title: full } : {})}>
              {words}
            </Shine>
          ) : (
            <span className="rl-done">
              {doneLine}
              {failed > 0 && !/failed/.test(doneLine) && <span className="rl-fail"> · {failed} failed</span>}
            </span>
          )}
        </span>
        {live && !plain && steps.length > 1 && <span className="rl-count">{steps.length} steps</span>}
        {/* A tick per step: hovered, what it was; pressed, the line opens on its kind (the head itself is the keyboard's way in). */}
        {ticks.length > 1 && !plain && (
          <span className="rl-ticks" aria-hidden="true">
            {ticks.map((s) => (
              <i
                key={s.id}
                className={s.state === "running" ? "now" : s.state === "failed" ? "bad" : s.state === "waiting" ? "skip" : "on"}
                data-k={groupOf(s).key.split(":")[0]}
                title={`${doingOf(s)}${s.state === "failed" ? " · failed" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(true);
                  setGroup(groupOf(s).key);
                }}
              />
            ))}
          </span>
        )}
        {live && since !== undefined && !waiting && <Clock since={since} />}
        {live && forecast && <span className="rl-clock">{forecast}</span>}
        {!empty && <span className={`rsp-caret side ${open ? "open" : ""}`} aria-hidden />}
      </button>}
      {open && !empty && (
        <div id={body} className="rl-body">
          {thinks.length > 0 && (
            <div className="rl-group">
              <button type="button" className="rl-row" aria-expanded={opened === "think"} onClick={() => pick("think")}>
                <span className="rl-label"><GroupIcon k="think" {...(inColumn && thoughtOwn ? { tip: "Thought" } : {})} /><span className="rl-lt" {...(thoughtOwn ? { "data-own": "" } : {})}>Thought</span></span>
                <span className="rl-what">{clip(thinks.map((t) => t.thought).join(" "), 90)}</span>
                <span className="rl-side">{thoughtSecs ? tookFor(thoughtSecs * 1000) : ""}</span>
              </button>
              {opened === "think" && <p className="rsp-tl-thought rl-thought">{thinks.map((t) => t.thought).join("\n\n")}</p>}
            </div>
          )}
          {groups.map((g) => {
            const s = side(g);
            return (
              <div key={g.key} className="rl-group">
                <button type="button" className="rl-row" aria-expanded={opened === g.key} onClick={() => pick(g.key)}>
                  {/* Code's column says the kind with its mark alone (data-own), where the mark is its own and the row has words to go with it. */}
                  <span className="rl-label"><GroupIcon k={g.key} {...(inColumn && OWN_MARK.has(g.key) && what(g) ? { tip: g.label } : {})} /><span className="rl-lt" {...(OWN_MARK.has(g.key) && what(g) ? { "data-own": "" } : {})}>{g.label}</span></span>
                  <span className="rl-what">{what(g)}</span>
                  <span className={`rl-side${s.tone ? ` ${s.tone}` : ""}`}>{s.text}</span>
                </button>
                {opened === g.key && <StepList steps={g.steps} />}
              </div>
            );
          })}
          {notes}
        </div>
      )}
    </div>
  );
}
