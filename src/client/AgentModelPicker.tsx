import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { ENGINE_NAMES, ENGINE_TOOLS, type EngineEffort, type EngineTool, type Thinking } from "../types.js";
import type { Plan } from "../plan-types.js";
import { EngineMark, VendorMark } from "./BrandMarks.js";
import { ModelNameInput, useEngineModelInfo } from "./EngineModelPill.js";
import { Icon } from "./icons.js";
import type { Identity } from "./storage.js";
import { planLimits, startTeam } from "./edition.js";
import { placeCard, useDismiss } from "./ui.js";
import { splitTools } from "./engines.js";
import { TierMeter, costMark, type RouteHint } from "./RouteWhy.js";
import { forValue } from "../routing.js";

/**
 * Friday Code's own side of the picker: its models, the person's own models it can run on, and how hard it reasons. The hosted
 * Friday's; in the local edition only the coding tools are offered, so each of these answers as if there were none.
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
}: {
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
  /** Given for a coding tool that takes an effort level: a column of its own beside the models, and a word on the pill. */
  effort?: EffortChoice | null;
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
  const own = fridaySide.useOwnModels(identity);

  const agentName = engine ? ENGINE_NAMES[engine] : fridayName;
  const cliKnown = cliModels.find((m) => m.id === model);
  const frontierVendor = !engine && fridayModelId ? fridaySide.vendorOf(fridayModelId) : undefined;
  const reasoning = !engine && thinking && onThinking ? fridaySide.thinkingLabel(thinking) : "";
  const modelText = engine ? (model ? (cliKnown?.label ?? model) : "") : fridayModelId ? fridaySide.label(fridayModelId) : "";
  // The effort column only for a coding tool that takes one; the pill names the level when it isn't Auto.
  const efforts = engine && effort?.options.length ? effort : null;
  const effortText = efforts?.now ? (efforts.options.find((o) => o.value === efforts.now)?.label ?? "") : "";
  const third = !!reasoning || !!efforts;

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`menu-pill agent-pill model-choice ${open ? "on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Who does the work, and which model"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="menu-pill-mark">
          <EngineMark tool={engine} size={14} />
        </span>
        {agentName}
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
    const list = useRef<HTMLDivElement>(null);
    // What this computer has is known once any tool is known to be missing; until then the usual four come first.
    const { here, away } = splitTools(ENGINE_TOOLS.some((t) => toolState(t).absent) ? (t) => !toolState(t).absent : null, engine);
    // The chosen model's row has the keyboard when the picker opens, so arrows and Enter work at once.
    useEffect(() => {
      const t = setTimeout(() => (list.current?.querySelector<HTMLElement>('[data-row][aria-checked="true"]') ?? list.current?.querySelector<HTMLElement>("[data-row]"))?.focus(), 30);
      return () => clearTimeout(t);
    }, []);
    const r = btn.current?.getBoundingClientRect();
    if (!r) return null;
    // Upward: this hangs off the composer, near the bottom of the window. One size whichever tool is chosen.
    const place = placeCard(r, 560, { want: 440, min: 240, prefer: "above" });
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

    // Friday's own agent is Team's: on Solo its row says so, and choosing it offers a team (7 days free) instead. Unless the
    // person has a model of their own, which Friday Code then runs on.
    const solo = planLimits(plan).fridayAgent === "none";
    const locked = solo && !own.length;
    const pickFriday = () => {
      if (locked) return setOpen(false), startTeam();
      onEngine("");
      if (solo && !fridaySide.isOwn(fridayModelId)) onFridayModel(own[0]!.choice);
    };

    /** A tool in the list on the left: its mark, its name, and in a word whether it's ready on this computer. */
    const toolRow = (key: string, label: string, mark: ReactElement, state: ToolState | null, on: boolean, pick: () => void) => {
      const fit = state?.disabled ? undefined : route?.tools[key as EngineTool];
      const best = !!fit && !fit.out && route!.best === key;
      const off = !!state && (state.disabled || !!state.absent || state.ready === false);
      const ready = !!state && !off && state.ready !== undefined;
      const room = fit && !fit.out ? fit.room : undefined;
      const word = key === "friday" ? (locked ? "Team" : solo ? "Your model" : "Friday's models") : state?.disabled || state?.absent ? "Not installed" : state?.ready === false ? "Not set up" : ready ? "Ready" : (state?.hint ?? "");
      const tip = [label, state?.hint, fit?.out ?? (fit && fit.success !== null ? `${Math.round(fit.success * 100)}% likely for this task` : ""), typeof room === "number" ? `${Math.round(room * 100)}% of its limits left` : ""].filter(Boolean).join(" · ");
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
            <span className="amp-tool-word">{word}</span>
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
            {(allowed ? meta : fridaySide.proName) && <span className="amp-model-meta">{allowed ? meta : fridaySide.proName}</span>}
          </span>
          {oddsOf(id)}
          {on && <Icon name="check" size={14} className="amp-check" />}
        </button>
      );
    const group = (label: string | null, rows: (ReactElement | false)[]) => {
      const shown = rows.filter(Boolean);
      if (!shown.length) return null;
      return (
        <div className="amp-group" key={label ?? "top"}>
          {label && <div className="amp-group-label">{label}</div>}
          {shown}
        </div>
      );
    };

    const cliMark = engine ? <EngineMark tool={engine} size={14} /> : null;
    const friday = toolRow("friday", fridayName, <EngineMark tool="" size={18} />, locked ? { disabled: false, hint: "Team" } : solo ? { disabled: false, hint: "Your model" } : null, !engine, pickFriday);
    const modelCount = engine ? cliModels.length + 1 : own.length + (solo ? 0 : fridaySide.catalogSize);

    // How hard it works: Friday Code's reasoning, or a coding tool's effort, as one switch over the models.
    const power =
      efforts ? (
        <div className="amp-power" role="radiogroup" aria-label={`${ENGINE_NAMES[engine as EngineTool]} effort`}>
          <span className="amp-power-label" title="Higher effort thinks longer and uses more of the tool's plan.">Effort</span>
          <div className="amp-seg">
            <button type="button" role="radio" aria-checked={efforts.now === null} data-on={efforts.now === null} title="The tool's own default." onClick={() => efforts.set(null)}>
              Auto
            </button>
            {efforts.options.map((o) => (
              <button key={o.value} type="button" role="radio" aria-checked={efforts.now === o.value} data-on={efforts.now === o.value} data-locked={!!o.locked} title={o.title} onClick={() => (o.locked ? efforts.onLocked?.(o.title) : efforts.set(o.value))}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ) : null; // A tool with no levels to pick has no row: the models start higher, in the same size of card.

    return createPortal(
      <div ref={pop} className="amp" style={{ ...place, height: place.maxHeight }} role="dialog" aria-label="Agent and model">
        {/* Which tool: the ones this computer has first, Friday Code with them (after them on Solo), the rest folded away. */}
        <div className="amp-tools" role="group" aria-label={machineName ? `Tools on ${machineName}` : "Tools"}>
          <div className="amp-col-label">Who works</div>
          {here.map((t) => toolRow(t, ENGINE_NAMES[t], <EngineMark tool={t} size={18} />, toolState(t), engine === t, () => onEngine(t)))}
          {away.length > 0 && (
            <>
              <button type="button" className="amp-more" aria-expanded={others || away.includes(engine as EngineTool)} onClick={() => setOthers((v) => !v)}>
                <Icon name={others || away.includes(engine as EngineTool) ? "chevronDown" : "chevronRight"} size={12} />
                Other tools <span className="amp-more-n">{away.length}</span>
              </button>
              {(others || away.includes(engine as EngineTool)) && away.map((t) => toolRow(t, ENGINE_NAMES[t], <EngineMark tool={t} size={18} />, toolState(t), engine === t, () => onEngine(t)))}
            </>
          )}
        </div>

        <div className="amp-main" onKeyDown={walk}>
          {/* No name over the column (Arun, 2026-10-26: "get rid of the tool text above the effort section"): the tool is the one
              picked on the left. Only Smart routing's meter, when it chose. */}
          {route && (
            <div className="amp-head">
              <span className="amp-route" title={route.why}>
                <TierMeter tier={route.tier} />
              </span>
            </div>
          )}
          {power}
          {/* Always there, so the list starts at the same place for every tool. */}
          {modelCount > 0 && (
            <div className="amp-search">
              <Icon name="search" size={13} />
              <input data-search value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search models" aria-label="Search models" spellCheck={false} />
            </div>
          )}
          <div ref={list} className="amp-models" role="menu" aria-label="Models">
            {!engine ? (
              <>
              </>
            ) : (
              <>
                {group(null, [modelRow("", "Default", `Whatever ${ENGINE_NAMES[engine]} is set to use`, !model, cliMark!, true, false, "default")])}
                {(() => {
                  const out: ReactElement[] = [];
                  let label: string | null = null;
                  let rows: (ReactElement | false)[] = [];
                  const flush = () => {
                    const g = group(label, rows);
                    if (g) out.push(g);
                    rows = [];
                  };
                  for (const m of cliModels) {
                    if ((m.group ?? null) !== label) {
                      flush();
                      label = m.group ?? null;
                    }
                    rows.push(modelRow(m.id, m.label, m.blurb ?? "", model === m.id, cliMark!, true, !!route && route.tools[engine]?.model === m.id, `${ENGINE_NAMES[engine]} ${m.label} ${m.id}`));
                  }
                  flush();
                  return out;
                })()}
                {model && !cliKnown && group(null, [modelRow(model, model, "A model you typed", true, cliMark!)])}
                {typing ? (
                  <ModelNameInput tool={engine} current={model} className="model-pop-input" onDone={(v) => (v ? choose(v) : setTyping(false))} />
                ) : (
                  !query && (
                    <button type="button" data-row className="amp-model amp-add" onClick={() => setTyping(true)}>
                      <span className="amp-model-mark" aria-hidden>
                        <Icon name="plus" size={14} />
                      </span>
                      <span className="amp-model-name">Another model…</span>
                    </button>
                  )
                )}
                {/* Nothing listed by that name: the tool may still know it, so offer it as typed. */}
                {query && !hits && !typing && (
                  <button type="button" data-row className="amp-model amp-add" onClick={() => choose(query)}>
                    <span className="amp-model-mark" aria-hidden>
                      <Icon name="plus" size={14} />
                    </span>
                    <span className="amp-model-text">
                      <span className="amp-model-name">Use “{query}”</span>
                      <span className="amp-model-meta">Not in {ENGINE_NAMES[engine]}'s list; it runs if the tool knows it</span>
                    </span>
                  </button>
                )}
              </>
            )}
          </div>
          <div className="amp-foot" aria-hidden>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move <kbd>↵</kbd> choose <kbd>esc</kbd> close
          </div>
        </div>
      </div>,
      document.body,
    );
  }
}
