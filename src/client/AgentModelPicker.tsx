import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode } from "react";
import { StarIcon } from "lucide-react";
import { dragEnds } from "./drag-end.js";
import { isOwnModel } from "../own-model-id.js";
import { ownName, useOwnModels } from "./ownModelStore.js";
import { ENGINE_MODEL_INFO, ENGINE_NAMES, ENGINE_TOOLS, type EngineEffort, type EngineTool, type Thinking } from "../types.js";
import { useRailLimits } from "./gauge.js";
import type { Plan } from "../plan-types.js";
import { EngineMark, VendorMark } from "./BrandMarks.js";
import { ModelNameInput, useEngineModelInfo } from "./EngineModelPill.js";
import { Icon } from "./icons.js";
import type { Identity } from "./storage.js";
import { planLimits, startTeam } from "./edition.js";
import { floating, placeCard, Switch, uiZoom, useDismiss } from "./ui.js";
import { splitTools, toolOrder } from "./engines.js";
import { costMark, type RouteHint } from "./RouteWhy.js";
import { forValue } from "../routing.js";

/**
 * Friday Code's own side of the picker: its models, the person's own models it can run on, and how hard it reasons. The hosted
 * Friday's; in the local edition only the person's own models, so Friday Code is offered once they have set one up.
 */
const fridaySide: {
  useOwnModels: (identity?: Identity) => { choice: string; name: string; model: string; local?: boolean }[];
  vendorOf: (id: string) => string | undefined;
  thinkingLabel: (t: Thinking) => string;
  label: (id: string) => string;
  isOwn: (id: string) => boolean;
  /** Friday's catalogue rows besides the person's own (Default, Auto and each frontier model). */
  catalogSize: number;
  /** The plan a model needs, said on its row when this plan can't run it. */
  proName: string;
} = { useOwnModels: () => [], vendorOf: () => undefined, thinkingLabel: () => "", label: (id) => id || "Default", isOwn: () => false, catalogSize: 0, proName: "" };
Object.assign(fridaySide, { useOwnModels, label: (id: string) => (isOwnModel(id) ? ownName(id) : id || "Default"), isOwn: isOwnModel });

/** One of your own models as the picker shows it: the exact model, where it runs and on whose key. */
type OwnRow = { choice: string; name: string; model: string; local?: boolean; provider?: string; baseUrl?: string };
const SOURCE: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google Gemini", gemini: "Google Gemini", groq: "Groq", deepseek: "DeepSeek", mistral: "Mistral", xai: "xAI", together: "Together", ollama: "Ollama", lmstudio: "LM Studio", llamacpp: "llama.cpp", vllm: "vLLM" };
/**
 * Where one of your own models runs, in the words you'd use for it (Arun, 2026-11-18: "properly displaying the mdoels from the keys
 * and local too, needs to be perfect and exact"): the provider whose key it is on, or the server on this computer.
 */
export function sourceOf(m: Pick<OwnRow, "provider" | "baseUrl" | "local" | "name">): string {
  const named = m.provider ? SOURCE[m.provider.toLowerCase()] : undefined;
  if (named) return named;
  try {
    const host = new URL(m.baseUrl ?? "").host.replace(/^api\./, "");
    return m.local ? `This computer (${host})` : host;
  } catch {
    return m.name;
  }
}
const whereOf = (m: OwnRow) => `${sourceOf(m)} · ${m.local ? "this computer" : "your key"}`;

/** Your starred models, as "tool|model" ("" for your own keys and local models), kept in this browser. */
const FAVS = "friday.model.favs";
function loadFavs(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(FAVS) ?? "[]") as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
function saveFavs(s: Set<string>): void {
  try {
    localStorage.setItem(FAVS, JSON.stringify([...s]));
  } catch {
    // Private mode: starred for this picker only.
  }
}

/** One plain word for what a model is for, from its line (the compact picker): Smartest, Deep, Balanced, Fast; none for an old one. */
export function wordOf(blurb: string, id: string): string {
  if (!blurb || blurb === id) return "";
  if (/most capable|longest, hardest|smartest|frontier/i.test(blurb)) return "Smartest";
  if (/complex|reasoning|deep|hard/i.test(blurb)) return "Deep";
  if (/fast|light|quick|cheap|simple/i.test(blurb)) return "Fast";
  if (/everyday|balanced|good pace|default|general/i.test(blurb)) return "Balanced";
  return "";
}

/** What a coding agent's row says about the machine it would run on. */
export interface ToolState {
  disabled: boolean;
  hint: string;
  /** Not on this computer: listed after the ones it has (see splitTools). */
  absent?: boolean;
  /** Installed, signed in and usable here: drawn in its colours with a dot. Anything else is greyed. */
  ready?: boolean;
}

/**
 * How hard a coding tool thinks, offered in the picker beside its models: Auto, then the levels that tool takes. A level
 * that isn't this person's to pick is greyed, its title saying why, and pressing it says so (`set` is not called for it).
 */
export interface EffortChoice {
  now: EngineEffort | null;
  options: { value: EngineEffort; label: string; title: string; locked?: boolean }[];
  set: (e: EngineEffort | null) => void;
  /** Said for a locked level, in place of choosing it. */
  onLocked?: (title: string) => void;
}

/** Which of a tool's accounts it runs as, for a tool with more than one here (Accounts.tsx useAccountChoice): the Account row. */
export interface AccountChoice {
  rows: { id: string; label: string; email?: string; note?: string; used?: number; out?: boolean; off?: boolean; main?: boolean }[];
  now: string;
  set: (id: string) => void;
  /** Why it can't be changed now (a run going), said on the row. */
  disabled?: string;
  /** Said under the list: what picking another does. */
  note?: string;
}

/**
 * Who does the work, and on which model: one control, because they are one decision.
 *
 * The model list belongs to the agent. Friday Code runs Friday's models (Default, and the frontier ones a plan unlocks); Claude
 * Code, Codex and Cursor each run their own CLI's models. So the agents are the left column and the models of whichever one is
 * chosen are the right, and picking an agent swaps the list beside it and puts the model back to Default, as it always did.
 *
 * The pill says only what is not obvious: the agent's name, and the model after it when someone picked one. "Default" is
 * the absence of a choice, so it is not written down.
 */
export function AgentModelPicker({
  engine,
  onEngine,
  model,
  onModel,
  fridayModelId,
  onFridayModel,
  fridayName,
  plan,
  identity,
  toolState,
  machineName,
  thinking,
  onThinking,
  route,
  effort,
  ownOnly,
  own: ownGiven,
  modelOnly = false,
  accounts = null,
  auto = null,
}: {
  /** The tool's accounts, when it has more than one here: a row of their own (design D). */
  accounts?: AccountChoice | null;
  /**
   * The pill as the second half of the box's "agent | model (reasoning)" (Arun, 2026-11-03: "it needs to be compact maybe like it
   * can be like the coding agent | model (reasoning level)"): the model and, in brackets, how hard it thinks; the agent is the
   * half before it. The panel is the same.
   */
  modelOnly?: boolean;
  engine: EngineTool | "";
  onEngine: (t: EngineTool | "") => void;
  /** The CLI's model, when a CLI is the agent. */
  model: string;
  onModel: (id: string) => void;
  /** Friday's model, when Friday Code is the agent. */
  fridayModelId: string;
  onFridayModel: (id: string) => void;
  /** What Friday's own entry is called (a saved agent keeps its name here). */
  fridayName: string;
  plan: Plan;
  identity?: Identity;
  toolState: (t: EngineTool) => ToolState;
  machineName?: string;
  /** Given together, Friday Code's models also carry how hard it thinks: a third column, and a word on the pill. */
  thinking?: Thinking;
  onThinking?: (t: Thinking) => void;
  /** What suits the task being typed (useRouteHint): drawn on the rows, a bar of room left on each tool and Best on the pick. */
  route?: RouteHint | null;
  /** Auto (ide/auto-tool.tsx; Arun, 2026-11-20): a row on the rail, and its card (what it picked and why) over the models while on. */
  auto?: { on: boolean; set: (on: boolean) => void; card: ReactNode } | null;
  /** Given for a coding tool that takes an effort level: a column of its own beside the models, and a word on the pill. */
  effort?: EffortChoice | null;
  /**
   * Friday Code only ever on the person's own models, and offered whether or not they have set one up, saying so when they
   * haven't: a teammate's picker (Teammates.tsx), where Friday's own models never run.
   */
  ownOnly?: boolean;
  /** The own models to offer, read from the computer the agent runs on, when that isn't this browser's (a teammate's). */
  own?: OwnRow[];
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  // The panel reads this render's props but keeps one component type for as long as the picker lives: a type made afresh each
  // render remounted it whenever the composer re-rendered, dropping what was typed in its search and the keyboard's place.
  const panel = useRef<() => ReactElement | null>(Panel);
  panel.current = Panel;
  const [PickerPanel] = useState(() => () => panel.current());
  const cliModels = useEngineModelInfo(engine || "claude", identity);
  // Models this person set up on their computer (Settings › Your models): any plan, and on Solo what Friday Code runs on.
  const ownHere = fridaySide.useOwnModels(identity);
  const own = ownGiven ?? ownHere;

  // One of your own models: the pill says the model and where it runs ("Ollama · llama3.1:8b"), never Friday Code (Arun, 2026-11-18:
  // "NO FRIDAY CODE BS").
  const ownNow = !engine ? own.find((m) => m.choice === fridayModelId) : undefined;
  // Where Friday's own models don't run (the open-source edition, a teammate's picker), the key side is only your own models.
  const solo0 = planLimits(plan).fridayAgent === "none" || !!ownOnly;
  const agentName = engine ? ENGINE_NAMES[engine] : ownNow ? sourceOf(ownNow) : solo0 ? "Your keys and local models" : fridayName;
  const cliKnown = cliModels.find((m) => m.id === model);
  const frontierVendor = !engine && fridayModelId ? fridaySide.vendorOf(fridayModelId) : undefined;
  const reasoning = !engine && thinking && onThinking ? fridaySide.thinkingLabel(thinking) : "";
  const modelText = engine ? (model ? (cliKnown?.label ?? model) : "") : ownNow ? ownNow.model : fridayModelId ? fridaySide.label(fridayModelId) : "";
  // The effort column only for a coding tool that takes one; the pill names the level when it isn't Auto.
  const efforts = engine && effort?.options.length ? effort : null;
  const effortText = efforts?.now ? (efforts.options.find((o) => o.value === efforts.now)?.label ?? "") : "";
  const third = !!reasoning || !!efforts;
  // Which account it runs as, on the pill, when it has more than one: "Claude Code · Work · Opus 5.5".
  const accountText = engine && accounts ? (accounts.rows.find((a) => a.id === accounts.now)?.label ?? "") : "";

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`menu-pill agent-pill model-choice ${open ? "on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Who does the work, and which model"
        title={[agentName, accountText, modelText, reasoning, effortText].filter(Boolean).join(" · ")}
        onClick={() => setOpen((v) => !v)}
      >
        {modelOnly ? (
          <span className="amp-pill-text">
            {!engine && frontierVendor && (
              <span className="menu-pill-mark" aria-hidden>
                <VendorMark vendor={frontierVendor} size={14} />
              </span>
            )}
            {accountText && (
              <>
                {accountText}
                <span className="model-pill-sep">·</span>
              </>
            )}
            {modelText || (engine ? "Default model" : "Auto")}
            {(reasoning || effortText) && <span className="amp-pill-level"> ({reasoning || effortText})</span>}
          </span>
        ) : (
          <>
        <span className="menu-pill-mark">
          {!engine && (ownNow || solo0) ? <Icon name="key" size={14} /> : <EngineMark tool={engine} size={14} />}
        </span>
        {/* One line that ends in "…" when it can't fit, so a long typed model name can't push the pill off a narrow composer
            (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"). */}
        <span className="amp-pill-text">
        {agentName}
        {accountText && (
          <>
            <span className="model-pill-sep">·</span>
            {accountText}
          </>
        )}
        {(modelText || reasoning || effortText) && (
          <>
            <span className="model-pill-sep">·</span>
            {/* A frontier model wears its maker's mark, so which one is running is clear at a glance. */}
            {!engine && frontierVendor && (
              <span className="menu-pill-mark" aria-hidden>
                <VendorMark vendor={frontierVendor} size={14} />
              </span>
            )}
            {modelText}
            {modelText && reasoning && <span className="model-pill-sep">·</span>}
            {reasoning}
            {(modelText || reasoning) && effortText && <span className="model-pill-sep">·</span>}
            {effortText}
          </>
        )}
        </span>
          </>
        )}
        <Icon name="chevronDown" size={13} className="menu-pill-caret" />
      </button>
      {open && <PickerPanel />}
    </>
  );

  /**
   * The picker, in the order a person decides (Dass, Arun 2026-10-19: "easier to use, think of user flow"): which tool, on the
   * left, named, with whether it's ready here; how hard it works, as one switch over the models; then the model, a list that
   * filters as you type and that the arrow keys walk. Choosing a model closes it; the tool and the effort don't, since a model
   * usually follows them.
   */
  function Panel() {
    useDismiss(pop, () => setOpen(false), btn.current);
    const [typing, setTyping] = useState(false);
    const [q, setQ] = useState("");
    const [others, setOthers] = useState(false);
    // Design D (Arun, 2026-11-05: "i kinda like D"): the choices as rows, Tool, Account, Model, one open at a time; the model's
    // first, as the one changed most. Effort is always shown, as a row of its own.
    const [row, setRow] = useState<"tool" | "account" | "model">("model");
    // What the rail shows (Favourites, your keys and local models, or the chosen tool's models) and your starred models.
    const [browse, setBrowse] = useState<"fav" | "own" | "more" | EngineTool | "">(engine);
    const [favs, setFavs] = useState<Set<string>>(loadFavs);
    // A model of another tool picked (a favourite, a search hit): set once that tool is the agent.
    const pending = useRef<{ t: EngineTool; id: string } | null>(null);
    useEffect(() => {
      const p = pending.current;
      if (!p || p.t !== engine) return;
      pending.current = null;
      // After the screen has had its own say on the change of tool (the home screen puts the model back to its default then).
      setTimeout(() => onModel(p.id), 0);
      setOpen(false);
    }, [engine]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
      if (browse !== "fav" && browse !== "own" && browse !== "more") setBrowse(engine);
    }, [engine]); // eslint-disable-line react-hooks/exhaustive-deps
    // Each tool's limit, for the dot on its rail icon and the line over its models.
    const rail = useRailLimits(identity ?? ({} as Identity), !identity);
    const limitOf = (t: EngineTool) => {
      const r = rail.find((x) => x.tool === t);
      return r ? { used: Math.round(Math.max(r.outer, r.inner ?? 0)) } : null;
    };
    const list = useRef<HTMLDivElement>(null);
    // What this computer has is known once any tool is known to be missing; until then the usual four come first. Ready ones on
    // top, then those not set up, as Settings lists them (Arun, 2026-11-06: "the ones installed should be at the top").
    const split = splitTools(ENGINE_TOOLS.some((t) => toolState(t).absent) ? (t) => !toolState(t).absent : null, engine);
    const order = toolOrder((t) => {
      const s = toolState(t);
      return s.absent ? "absent" : s.ready === false ? "signed out" : "ready";
    });
    const here = [...split.here].sort(order);
    const away = [...split.away].sort(order);
    // The chosen model's row has the keyboard when the picker opens, so arrows and Enter work at once.
    useEffect(() => {
      if (row !== "model") return;
      const t = setTimeout(() => (list.current?.querySelector<HTMLElement>('[data-row][aria-checked="true"]') ?? list.current?.querySelector<HTMLElement>("[data-row]"))?.focus(), 30);
      return () => clearTimeout(t);
    }, [row]);
    // Another tool's list starts at its top: it kept the last one's scroll, and Codex opened on its last rows, Default out of view.
    useEffect(() => {
      if (list.current) list.current.scrollTop = 0;
    }, [engine]);
    // Placed again when the window changes size, so it stays on its pill and on screen (it kept its first place, cut off and
    // away from the pill) (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
    const [, resized] = useState(0);
    useEffect(() => {
      const again = () => resized((n) => n + 1);
      addEventListener("resize", again);
      return () => removeEventListener("resize", again);
    }, []);
    const r = btn.current?.getBoundingClientRect();
    if (!r) return null;
    // Upward: this hangs off the composer, near the bottom of the window. One size whichever tool is chosen.
    // From the model half of the box, the models alone: the agent is picked beside it (Arun, 2026-11-03: "we should only be able
    // to change the model and not the tool").
    const place = placeCard(r, 320, { want: 372, min: 220, prefer: "above", cover: true });
    // Opened from a dialog (a teammate's Runs on), it keeps inside the dialog's edges: it hung about 45px past its right (Arun,
    // 2026-10-29: the verification's "the teammate dialog's model picker pokes past the dialog's right edge").
    const box = btn.current?.closest('[data-slot="dialog-content"]')?.getBoundingClientRect();
    if (box) {
      const z = uiZoom();
      place.width = Math.min(place.width, box.width / z - 16);
      place.left = Math.min(Math.max(place.left, box.left / z + 8), box.right / z - 8 - place.width);
    }
    const choose = (id: string) => {
      (engine ? onModel : onFridayModel)(id);
      setOpen(false);
    };
    /** Up and down walk the model rows (and the search box above them); Home and End jump to the ends. */
    const walk = (e: ReactKeyboardEvent) => {
      const search = pop.current?.querySelector<HTMLInputElement>("[data-search]");
      const inSearch = e.target === search;
      if (inSearch && e.key === "Enter") {
        e.preventDefault();
        return list.current?.querySelector<HTMLElement>("[data-row]:not(:disabled)")?.click();
      }
      // A letter typed while a row has the keyboard goes into the search, so you can just start typing a model's name.
      if (!inSearch && search && e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target instanceof HTMLInputElement)) search.focus();
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || (inSearch && (e.key === "Home" || e.key === "End"))) return;
      const rows = [...(list.current?.querySelectorAll<HTMLElement>("[data-row]:not(:disabled)") ?? [])];
      if (!rows.length) return;
      e.preventDefault();
      const at = rows.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : e.key === "ArrowDown" ? Math.min(rows.length - 1, at + 1) : at <= 0 ? -1 : at - 1;
      if (next < 0) (pop.current?.querySelector<HTMLElement>("[data-search]") ?? rows[0])?.focus();
      else rows[next]!.focus();
    };

    // Friday's own agent is Team's: on Solo its row says so, and choosing it offers a team instead. Unless the
    // person has a model of their own, which Friday Code then runs on.
    const solo = planLimits(plan).fridayAgent === "none" || !!ownOnly;
    const locked = solo && !own.length && !ownOnly;
    const pickFriday = () => {
      if (locked) return setOpen(false), startTeam();
      onEngine("");
      // With none set up yet (ownOnly), the column says so and how to add one, rather than picking nothing.
      if (solo && !fridaySide.isOwn(fridayModelId) && own[0]) onFridayModel(own[0].choice);
    };

    /** A tool in the list on the left: its mark, its name, and in a word whether it's ready on this computer. */
    const toolRow = (key: string, label: string, mark: ReactElement, state: ToolState | null, on: boolean, pick: () => void) => {
      const fit = state?.disabled ? undefined : route?.tools[key as EngineTool];
      const best = !!fit && !fit.out && route!.best === key;
      const off = !!state && (state.disabled || !!state.absent || state.ready === false);
      const ready = !!state && !off && state.ready !== undefined;
      const room = fit && !fit.out ? fit.room : undefined;
      // A row already called "Your model" says how many are set up, not its own name again.
      const word = key === "friday" ? (locked ? "Team" : solo ? (label === "Your model" ? (own.length ? `${own.length} set up` : "None set up") : "Your model") : "Friday's models") : state?.disabled || state?.absent ? "Not installed" : state?.ready === false ? "Not set up" : ready ? "Ready" : (state?.hint ?? "");
      const tip = [label, state?.hint, fit?.out ?? (fit && fit.success !== null ? `${Math.round(fit.success * 100)}% likely for this task` : ""), typeof room === "number" ? `${Math.round(room * 100)}% of its limits left` : "", route?.forecasts[key as EngineTool] ?? ""].filter(Boolean).join(" · ");
      return (
        <button
          key={key}
          type="button"
          className="amp-tool"
          data-on={on}
          data-off={off}
          disabled={!!state?.disabled}
          aria-pressed={on}
          title={tip}
          onClick={pick}
        >
          <span className="amp-tool-mark">
            {mark}
            {ready && <i className="amp-ready" aria-hidden />}
          </span>
          <span className="amp-tool-text">
            <span className="amp-tool-name">{label}</span>
            {!(ready && key !== "friday") && <span className="amp-tool-word">{word}</span>}
          </span>
          {best && <span className="amp-best">{route!.bestForValue ? "Best value" : "Best"}</span>}
        </button>
      );
    };

    /** Whether a model marked best was picked for its value: one of its tool's other models reads as likelier. */
    const bestForValue = (id: string) => {
      const fits = engine ? (route?.fits[engine] ?? []).filter((f) => !f.out) : [];
      const f = fits.find((x) => x.model === id);
      return !!f && forValue(f, fits);
    };
    /** A model weighed for the task being typed: how likely it gets it right, and what a task costs on it. */
    const oddsOf = (id: string) => {
      const f = engine ? route?.fits[engine]?.find((x) => x.model === id) : undefined;
      if (!f) return null;
      return (
        <span className="mp-fit" title={`${Math.round(f.success * 100)}% likely to get this right${f.runs ? `, from benchmarks and ${f.runs} run${f.runs === 1 ? "" : "s"} here` : f.est ? " (estimated)" : ""}; about $${f.cost.toFixed(2)} a task`}>
          {f.out ? <span className="model-pop-meta">{f.out}</span> : <span className="mp-odds">{Math.round(f.success * 100)}%</span>}
          <span className="mp-cost">{costMark(f.cost)}</span>
        </span>
      );
    };
    // Every word typed has to be in the model's name, id or maker (or the tool's own name), ignoring case and punctuation:
    // "gpt5" finds GPT-5, "opus 4.8" and "opus48" find claude-opus-4-8, "claude-sonnet" finds Sonnet 5.5 (id "sonnet").
    // Descriptions aren't searched: Auto's "Haiku, Sonnet or Opus" would answer every one of those names.
    const query = q.trim();
    const bare = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const words = query.split(/[\s\-_/]+/).map(bare).filter(Boolean);
    let hits = 0;
    const shows = (find: string) => {
      const hay = bare(find);
      const yes = words.every((w) => hay.includes(w));
      if (yes) hits++;
      return yes;
    };
    const modelRow = (id: string, name: string, meta: string, on: boolean, mark: ReactElement, allowed = true, best = false, find = `${name} ${id}`) =>
      shows(find) && (
        <button key={id || "default"} type="button" data-row role="menuitemradio" aria-checked={on} className="amp-model" data-on={on} disabled={!allowed} title={allowed ? undefined : `On ${fridaySide.proName}`} onClick={() => choose(id)}>
          <span className="amp-model-mark" aria-hidden>
            {mark}
          </span>
          <span className="amp-model-text">
            <span className="amp-model-name">
              {name}
              {best && <span className="amp-best">{bestForValue(id) ? "Best value" : "Best"}</span>}
            </span>
            {/* Names only (Arun, 2026-11-05: "get rid of the scondary text"): a row says more only when it can't be picked. */}
            {!allowed && fridaySide.proName && <span className="amp-model-meta">{fridaySide.proName}</span>}
          </span>
          {oddsOf(id)}
          {on && <Icon name="check" size={14} className="amp-check" />}
        </button>
      );
    // Each group its own key: two unnamed ones (Default, and a model you typed) shared "top", and React kept a stale Default row.
    const group = (label: string | null, rows: (ReactElement | false)[], key = label ?? "top") => {
      const shown = rows.filter(Boolean);
      if (!shown.length) return null;
      return (
        <div className="amp-group" key={key}>
          {label && <div className="amp-group-label">{label}</div>}
          {shown}
        </div>
      );
    };

    const cliMark = engine ? <EngineMark tool={engine} size={14} /> : null;
    const friday = toolRow("friday", fridayName, <EngineMark tool="" size={16} />, locked ? { disabled: false, hint: "Team" } : solo ? { disabled: false, hint: "Your model" } : null, !engine, () => (pickFriday(), setRow("model")));
    const modelCount = engine ? cliModels.length + 1 : own.length + (solo ? 0 : fridaySide.catalogSize);

    // How hard it works: Friday Code's reasoning, or a coding tool's effort, as a meter dragged along its levels (Arun,
    // 2026-11-05: "make this into a draggable meter thing").
    const power =
      efforts ? (
        <StepMeter
          label="Effort"
          title="Higher effort thinks longer and uses more of the tool's plan."
          steps={[{ label: "Auto", title: "The tool's own default." }, ...efforts.options.map((o) => ({ label: o.label, title: o.title, ...(o.locked ? { locked: true } : {}) }))]}
          at={efforts.now === null ? 0 : 1 + Math.max(0, efforts.options.findIndex((o) => o.value === efforts.now))}
          onPick={(i) => {
            if (i === 0) return efforts.set(null);
            const o = efforts.options[i - 1]!;
            if (o.locked) efforts.onLocked?.(o.title);
            else efforts.set(o.value);
          }}
        />
      ) : null; // A tool with no levels to pick has no row: the models start higher, in the same size of card.

    // Smart routing as a switch of its own, for a tool that has it (Arun, 2026-11-06: "make sure you can toggle on and off the smart
    // routing too"): the model list is the tool's own models only (2026-11-05), so it had no way back on once a model was picked.
    // On, Friday picks the model for each message; off, the tool's own default until a model is picked, which turns it off too.
    // At the foot, where the line repeating the choices was ("move the smart routing to the bottom… and get rid of text").
    const smart = engine ? cliModels.find((m) => m.id === "auto") : undefined;
    const routing = smart ? (
      <div className="ampd-route" title={smart.blurb}>
        <span className="ampd-route-name">Smart routing</span>
        <Switch on={model === "auto"} label="Smart routing" onChange={(on) => onModel(on ? "auto" : "")} />
      </div>
    ) : null;

    const pickTool = (t: EngineTool) => (onEngine(t), setRow("model"), setBrowse(t));

    // How hard it works, as one row of its levels (the compact picker, Arun 2026-11-18: "a bit more comapct and easy to use and
    // understand"): Friday Code's reasoning, or a coding tool's effort, a level locked to this person saying why when pressed.
    const levels: { label: string; title?: string; locked?: boolean }[] | null =
      efforts ? [{ label: "Auto", title: "The tool's own default." }, ...efforts.options.map((o) => ({ label: o.label, title: o.title, ...(o.locked ? { locked: true } : {}) }))] : null;
    const levelAt =
      efforts ? (efforts.now === null ? 0 : 1 + Math.max(0, efforts.options.findIndex((o) => o.value === efforts.now))) : 0;
    const pickLevel = (i: number) => {
      if (!efforts) return;
      if (i === 0) return efforts.set(null);
      const o = efforts.options[i - 1]!;
      if (o.locked) efforts.onLocked?.(o.title);
      else efforts.set(o.value);
    };

    // What the rail is showing: Favourites, a coding tool (its subscription), or your own keys and local models (Friday Code on
    // them). A tool shown is the tool chosen, as the Tool row did; your keys are shown before they are chosen, so one not set up yet
    // says how to add one rather than switching to nothing (Arun, 2026-11-18: "make it easy to swtich between subcriptions and
    // keys/local models too").
    const shownKey = browse === "own" || browse === "fav" || browse === "more" ? browse : engine || "own";
    const ownOffered = !solo || own.length > 0 || !!ownOnly;
    const favOf = (t: string, id: string) => favs.has(`${t}|${id}`);
    const flip = (t: string, id: string) => {
      const k = `${t}|${id}`;
      const next = new Set(favs);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      setFavs(next);
      saveFavs(next);
    };
    /** A model of any tool, or one of your own: chosen now, or once its tool is (a favourite of another tool, a search hit). */
    const take = (t: string, id: string) => {
      if (t === "") {
        if (engine) pickFriday();
        return void (onFridayModel(id), setOpen(false));
      }
      if (t === engine) return choose(id);
      pending.current = { t: t as EngineTool, id };
      onEngine(t as EngineTool);
    };
    const star = (t: string, id: string) => (
      <span role="button" tabIndex={-1} className="mpc-star" data-on={favOf(t, id) || undefined} aria-label={favOf(t, id) ? "Remove from favourites" : "Add to favourites"} title={favOf(t, id) ? "Remove from favourites" : "Add to favourites"} onClick={(e) => (e.stopPropagation(), flip(t, id))}>
        <StarIcon className="size-[13px]" aria-hidden />
      </span>
    );
    /** One model, a row: its name, one plain word for what it's for, its star, and a tick on the one in use. */
    const line = (t: string, id: string, name: string, word: string, on: boolean, mark: ReactElement | null, find: string, allowed = true, best = false) =>
      shows(find) && (
        <button key={`${t}|${id || "default"}`} type="button" data-row role="menuitemradio" aria-checked={on} className="mpc-row" data-on={on || undefined} disabled={!allowed} title={allowed ? undefined : `On ${fridaySide.proName}`} onClick={() => take(t, id)}>
          {mark && <span className="mpc-mark" aria-hidden>{mark}</span>}
          <span className="mpc-name">{name}</span>
          {best && <span className="amp-best">{bestForValue(id) ? "Best value" : "Best"}</span>}
          {t === engine && t !== "" && oddsOf(id)}
          <span className="mpc-word">{word}</span>
          <span className="mpc-check" aria-hidden>{on && <Icon name="check" size={13} />}</span>
          {/* At the row's right end (Arun, 2026-11-18: "move the start icon to the right more"). */}
          {star(t, id)}
        </button>
      );
    const cliOn = (t: EngineTool, id: string) => engine === t && model === id;
    const ownOn = (id: string) => !engine && fridayModelId === id;
    const markOf = (t: string, size = 14) => (t === "" ? <Icon name="key" size={size} /> : <EngineMark tool={t as EngineTool} size={size} />);
    /** A model's label wherever it is listed: this tool's live list, the catalogue, or your own models. */
    const nameOf = (t: string, id: string) =>
      t === "" ? (own.find((m) => m.choice === id)?.model ?? fridaySide.label(id)) : ((t === engine ? cliModels : ENGINE_MODEL_INFO[t as EngineTool] ?? []).find((m) => m.id === id)?.label ?? id);
    const blurbOf = (t: string, id: string) => (t === "" ? "" : ((t === engine ? cliModels : ENGINE_MODEL_INFO[t as EngineTool] ?? []).find((m) => m.id === id)?.blurb ?? ""));

    // Your own models by where they run, each by its exact model id: "Ollama · this computer", "Anthropic · your key".
    const ownGroups = () => {
      const by = new Map<string, OwnRow[]>();
      for (const m of own) by.set(whereOf(m), [...(by.get(whereOf(m)) ?? []), m]);
      return [...by].map(([where, ms]) => group(where, ms.map((m) => line("", m.choice, m.model, m.name && m.name !== m.model && m.name !== sourceOf(m) ? m.name : "", ownOn(m.choice), null, `${m.model} ${m.name} ${where}`)), `own:${where}`));
    };
    const ownList = (all: boolean) => (
      <>
        {ownGroups()}
      </>
    );
    /**
     * A tool's models, by group. `starred`: those shown in Favourites above it, left out here so none is listed twice (Arun,
     * 2026-11-19: "it shouldnt repeat"), and its first group headed, so its models don't read as more favourites.
     */
    const toolList = (t: EngineTool, starred?: Set<string>) => {
      const list = (t === engine ? cliModels : ENGINE_MODEL_INFO[t]).filter((m) => !starred?.has(`${t}|${m.id}`));
      const out: ReactElement[] = [];
      let label: string | null = starred ? "Models" : null;
      let rows: (ReactElement | false)[] = [];
      const flush = () => {
        const g = group(label, rows, `${t}:${label ?? "top"}`);
        if (g) out.push(g);
        rows = [];
      };
      for (const m of list) {
        if (m.id === "auto") continue;
        const g = m.group === "Latest" || !m.group ? (starred ? "Models" : null) : m.group;
        if (g !== label) (flush(), (label = g));
        rows.push(line(t, m.id, m.label, wordOf(m.blurb, m.id), cliOn(t, m.id), null, `${ENGINE_NAMES[t]} ${m.label} ${m.id}`, true, t === engine && !!route && route.tools[t]?.model === m.id));
      }
      flush();
      return out;
    };
    // Typed in the search: every tool's models and your own, not only those of the tool shown.
    const everywhere = () => (
      <>
        {[...here, ...away].map((t) => group(ENGINE_NAMES[t], (t === engine ? cliModels : ENGINE_MODEL_INFO[t]).filter((m) => m.id !== "auto").map((m) => line(t, m.id, m.label, wordOf(m.blurb, m.id), cliOn(t, m.id), markOf(t), `${ENGINE_NAMES[t]} ${m.label} ${m.id}`)), `q:${t}`))}
        {ownOffered && ownGroups()}
      </>
    );
    const favRows = [...favs].map((k) => {
      const [t = "", ...rest] = k.split("|");
      const id = rest.join("|");
      if (t !== "" && !(ENGINE_TOOLS as readonly string[]).includes(t)) return false;
      if (t === "" && !own.some((m) => m.choice === id)) return false;
      if (modelOnly && t !== engine) return false;
      return line(t, id, nameOf(t, id), t === "" ? ((m) => (m ? sourceOf(m) : ""))(own.find((m) => m.choice === id)) : wordOf(blurbOf(t, id), id), t === "" ? ownOn(id) : cliOn(t as EngineTool, id), modelOnly ? null : markOf(t), `${t} ${nameOf(t, id)} ${id}`);
    });
    const addOwn = (
      <button type="button" data-row className="mpc-row mpc-add" onClick={() => (setOpen(false), window.dispatchEvent(new CustomEvent("friday:settings", { detail: { tab: "own-models" } })))}>
        <span className="mpc-mark" aria-hidden><Icon name="plus" size={13} /></span>
        <span className="mpc-name">Add a key or local model…</span>
      </button>
    );

    const railItem = (key: string, label: string, mark: ReactElement, on: boolean, pick: () => void, state?: ToolState) => {
      const off = !!state && (state.disabled || !!state.absent || state.ready === false);
      const lim = key !== "fav" && key !== "own" && key !== "auto" ? limitOf(key as EngineTool) : null;
      const tip = [label, state ? (state.disabled || state.absent ? "Not installed" : state.ready === false ? "Not set up" : "") : "", lim ? `${lim.used}% of its limit used` : ""].filter(Boolean).join(" · ");
      return (
        <button key={key} type="button" className="mpc-tab" data-on={on || undefined} data-off={off || undefined} disabled={!!state?.disabled} aria-pressed={on} aria-label={tip} title={tip} onClick={pick}>
          {mark}
          {lim && <i className={`mpc-lim ${lim.used >= 90 ? "hot" : lim.used >= 70 ? "warm" : "ok"}`} aria-hidden />}
        </button>
      );
    };
    /** Installed and signed in here: on the rail above your keys; one set up but signed out goes under them. */
    const connected = (t: EngineTool) => {
      const st = toolState(t);
      return !st.disabled && !st.absent && st.ready !== false;
    };
    const headLimit = engine && shownKey === engine ? limitOf(engine) : null;
    const listHead = query ? "Results" : shownKey === "fav" ? "Favourites" : shownKey === "own" ? "Your keys and local models" : shownKey === "more" ? "More tools" : agentName;
    const acct = accounts?.rows.find((a) => a.id === accounts.now);

    return floating(
      <div ref={pop} className={`amp mpc${modelOnly ? " models-only" : ""}`} style={place} role="dialog" aria-label={modelOnly ? "Model" : "Agent and model"} onKeyDown={walk}>
        <div className="mpc-search">
          <Icon name="search" size={13} />
          <input data-search value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search models" aria-label="Search models" spellCheck={false} />
        </div>
        <div className="mpc-body">
          {!modelOnly && (
            <div className="mpc-rail" role="group" aria-label={machineName ? `Tools on ${machineName}` : "Tools"}>
              {railItem("fav", "Favourites", <StarIcon className="size-[15px]" aria-hidden />, shownKey === "fav", () => setBrowse("fav"))}
              {auto && engine && railItem("auto", "Auto tool: the one with the most room on your plans", <Icon name="scale" size={15} />, auto.on, () => auto.set(!auto.on))}
              {/* Connected first, then your keys and local models, then the tools not connected (Arun, 2026-11-18: "place the local
                  models and subscriptions selector thing above the coding tools that are not connected"). */}
              {here.filter(connected).map((t) => railItem(t, ENGINE_NAMES[t], <EngineMark tool={t} size={16} />, shownKey === t, () => pickTool(t), toolState(t)))}
              {/* Your own keys and local models, a click from a subscription: Friday Code runs on them. */}
              {railItem("own", "Your keys and local models", <Icon name="key" size={15} />, shownKey === "own", () => (setBrowse("own"), (own.length > 0 || ownOnly || !solo) && engine && pickFriday()))}
              {here.some((t) => !connected(t)) && <span className="mpc-rail-sep" aria-hidden />}
              {here.filter((t) => !connected(t)).map((t) => railItem(t, ENGINE_NAMES[t], <EngineMark tool={t} size={16} />, shownKey === t, () => pickTool(t), toolState(t)))}
              {/* The tools not on this computer, by name in the list rather than a rail too long to read. */}
              {away.length > 0 && (away.includes(engine as EngineTool) ? railItem(engine, ENGINE_NAMES[engine as EngineTool], <EngineMark tool={engine as EngineTool} size={16} />, shownKey === engine, () => setBrowse(engine), toolState(engine as EngineTool)) : null)}
              {away.length > 0 && railItem("more", `More tools (${away.length})`, <Icon name="plus" size={15} />, shownKey === "more", () => setBrowse("more"))}
            </div>
          )}
          <div ref={list} className="mpc-list" role="menu" aria-label="Models">
            <div className="mpc-head">
              <span>{listHead}</span>
              {!query && headLimit && <span className={`mpc-head-lim ${headLimit.used >= 90 ? "hot" : headLimit.used >= 70 ? "warm" : ""}`}>{headLimit.used >= 100 ? "Out of usage" : `${headLimit.used}% used`}</span>}
            </div>
            {query ? (
              modelOnly ? (engine ? toolList(engine) : ownList(false)) : everywhere()
            ) : shownKey === "more" ? (
              away.map((t) => {
                const st = toolState(t);
                return (
                  <button key={t} type="button" data-row className="mpc-row" disabled={!!st.disabled} onClick={() => pickTool(t)}>
                    <span className="mpc-mark" aria-hidden><EngineMark tool={t} size={14} /></span>
                    <span className="mpc-name">{ENGINE_NAMES[t]}</span>
                    <span className="mpc-word">{st.disabled || st.absent ? "Not installed" : st.ready === false ? "Not set up" : st.hint}</span>
                  </button>
                );
              })
            ) : shownKey === "fav" ? (
              favRows.some(Boolean) ? group(null, favRows, "favs") : <p className="mpc-none">Star a model to keep it here.</p>
            ) : shownKey === "own" ? (
              <>
                {ownList(false)}
                {ownOnly && !own.length && <p className="mpc-none">No key or local model yet: a provider's key, or a model running on this computer (Ollama, LM Studio).</p>}
                {!own.length && !ownOnly && solo && <p className="mpc-none">Run on your own API key, or a model on this computer (Ollama, LM Studio), instead of a subscription.</p>}
                {addOwn}
              </>
            ) : (
              <>
                {auto?.on && auto.card}
                {modelOnly && favRows.some(Boolean) && group("Favourites", favRows, "favs")}
                {engine && toolList(engine, modelOnly && favRows.some(Boolean) ? new Set([...favs].filter((k) => k.startsWith(`${engine}|`))) : undefined)}
                {engine && model && model !== "auto" && !cliKnown && group(null, [line(engine, model, model, "Typed", true, null, model)], "typed")}
                {engine &&
                  (typing ? (
                    <ModelNameInput tool={engine} current={model} className="model-pop-input" onDone={(v) => (v ? choose(v) : setTyping(false))} />
                  ) : (
                    <button type="button" data-row className="mpc-row mpc-add" onClick={() => setTyping(true)}>
                      <span className="mpc-mark" aria-hidden><Icon name="plus" size={13} /></span>
                      <span className="mpc-name">Another model…</span>
                    </button>
                  ))}
              </>
            )}
            {query && !hits && engine && (
              <button type="button" data-row className="mpc-row mpc-add" onClick={() => choose(query)}>
                <span className="mpc-mark" aria-hidden><Icon name="plus" size={13} /></span>
                <span className="mpc-name">Use “{query}” in {ENGINE_NAMES[engine]}</span>
              </button>
            )}
          </div>
        </div>
        {/* A tool's subscriptions side by side, when it has more than one here: which one it runs as, a press to change. */}
        {accounts && engine && accounts.rows.length > 1 && (
          <div className="mpc-foot" title={accounts.disabled || accounts.note || undefined}>
            <span className="mpc-foot-k">Plan</span>
            <div className="mpc-seg" role="radiogroup" aria-label={`${ENGINE_NAMES[engine]} account`}>
              {accounts.rows.map((a) => (
                <button key={a.id} type="button" role="radio" aria-checked={a.id === accounts.now} data-on={a.id === accounts.now || undefined} disabled={!!a.off || !!accounts.disabled} title={[a.email, a.note].filter(Boolean).join(" · ") || undefined} onClick={() => a.id !== accounts.now && accounts.set(a.id)}>
                  <i className={`ampd-dot${a.out ? " out" : a.off ? " off" : ""}`} aria-hidden />
                  {a.label}
                </button>
              ))}
            </div>
            {acct?.out && <span className="mpc-foot-note">Out</span>}
          </div>
        )}
        {levels && (
          <div className="mpc-foot">
            <span className="mpc-foot-k">{reasoning ? "Reasoning" : "Effort"}</span>
            <div className="mpc-seg" role="radiogroup" aria-label={reasoning ? "Reasoning" : "Effort"} title={reasoning ? undefined : "Higher effort thinks longer and uses more of the tool's plan."}>
              {levels.map((l, i) => (
                <button key={l.label} type="button" role="radio" aria-checked={i === levelAt} data-on={i === levelAt || undefined} data-locked={l.locked || undefined} title={l.title} onClick={() => pickLevel(i)}>
                  {l.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {routing}
      </div>,
    );
  }
}

/**
 * A level picked by dragging along a meter (Arun, 2026-11-05: "make this into a draggable meter thing", then design 7 of the
 * mockups): a rounded track whose dark fill grows from the left under a round handle, a dot at each level, and the levels named
 * under it to press. The handle follows the pointer and settles on the nearest level when let go; the arrows, Home and End step
 * along. A locked level is a dim name the handle passes over.
 */
function StepMeter({ label, title, steps, at, onPick }: { label: string; title?: string; steps: { label: string; title?: string; locked?: boolean }[]; at: number; onPick: (i: number) => void }) {
  const track = useRef<HTMLDivElement>(null);
  // Where the handle is while it's held, from 0 to 1; null when it rests on its level.
  const [held, setHeld] = useState<number | null>(null);
  const last = Math.max(1, steps.length - 1);
  const frac = held ?? at / last;
  const shown = held === null ? at : Math.round(held * last);
  const open = (i: number) => !steps[i]?.locked;
  /** The track's length the handle travels: inside its 4px rim, less the handle's own 24px. */
  const along = (f: number) => `calc(${f} * (100% - 20px))`;
  const fracAt = (x: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (x - r.left - 10) / Math.max(1, r.width - 20)));
  };
  /** The nearest level to a place on the track that may be picked. */
  const nearest = (f: number) => {
    const want = f * last;
    let best = at;
    let gap = Infinity;
    steps.forEach((_, i) => open(i) && Math.abs(i - want) < gap && ((gap = Math.abs(i - want)), (best = i)));
    return best;
  };
  const pick = (i: number) => i !== at && open(i) && onPick(i);
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.focus();
    let f = fracAt(e.clientX);
    setHeld(f);
    // Settled where it's let go; it ends however the pointer goes (drag-end.ts).
    const held2 = dragEnds(e, () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", held2.stop);
      el.removeEventListener("pointercancel", held2.stop);
      setHeld(null);
      pick(nearest(f));
    });
    const move = (ev: PointerEvent) => {
      if (!held2.live(ev)) return;
      f = fracAt(ev.clientX);
      setHeld(f);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", held2.stop);
    el.addEventListener("pointercancel", held2.stop);
  };
  /** The arrows step to the next level that may be picked; Home and End to the first and last. */
  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const ok = steps.map((_, i) => i).filter(open);
    const to =
      e.key === "Home" ? ok[0]
      : e.key === "End" ? ok.at(-1)
      : e.key === "ArrowRight" || e.key === "ArrowUp" ? ok.find((i) => i > at)
      : e.key === "ArrowLeft" || e.key === "ArrowDown" ? ok.findLast((i) => i < at)
      : null;
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (to !== undefined) pick(to);
  };
  return (
    <div className="amp-meter-box">
      <div className="amp-meter-head">
        <span className="amp-power-label" title={title}>
          {label}
        </span>
        <span className="amp-meter-value">{steps[shown]?.label}</span>
      </div>
      <div
        ref={track}
        className="amp-meter"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={shown}
        aria-valuetext={steps[shown]?.label}
        data-held={held !== null}
        title={steps[shown]?.title}
        onPointerDown={down}
        onKeyDown={key}
      >
        {steps.map((s, i) => i > 0 && <span key={s.label} className="amp-meter-dot" data-locked={!!s.locked} style={{ left: `calc(10px + ${along(i / last)})` }} aria-hidden />)}
        <span className="amp-meter-fill" style={{ width: `calc(14px + ${along(frac)})` }} aria-hidden />
        <span className="amp-meter-thumb" style={{ left: `calc(3px + ${along(frac)})` }} aria-hidden />
      </div>
      <div className="amp-meter-names" aria-hidden>
        {steps.map((s, i) => (
          <button key={s.label} type="button" tabIndex={-1} data-on={i === shown} data-locked={!!s.locked} title={s.title} onClick={() => pick(i)}>
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
