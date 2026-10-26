import { useEffect, useState } from "react";
import { ENGINE_MODEL_INFO, ENGINE_NAMES, type EngineModelInfo, type EngineTool } from "../types.js";
import { EngineMark } from "./BrandMarks.js";
import { hostApi } from "./local.js";
import type { Identity } from "./storage.js";
import { InlineEdit, MenuButton, type MenuItem } from "./ui.js";

/**
 * Which of a coding CLI's own models it runs on, beside the pill that names the CLI.
 *
 * The list is that CLI's: its models, each with a line on what it is for, and
 * the CLI's own mark. "Default" leaves the choice to the CLI. A model that is
 * not in the list is a model somebody typed, and it is shown as theirs rather
 * than hidden. These run on the person's own account with that CLI, never on
 * anything Friday pays for.
 *
 * Cursor's models differ by account and there are dozens, so for Cursor the
 * list is asked of the installed `cursor-agent` once, and what it says replaces
 * the short one shown until it answers. The tools Friday speaks to over ACP
 * (Copilot, Gemini CLI, OpenCode, Droid…) list theirs as a conversation opens,
 * and the computer they run on remembers the last list, which is asked for the
 * same way: before, the picker had nothing for them but a box to type a name.
 */
const live = new Map<string, EngineModelInfo[]>();
/** The tools whose list is in the picker already, and so not asked for. */
const LISTED: readonly EngineTool[] = ["claude", "codex", "amp"];

/** A CLI's models: its short list at once, and for Cursor and the ACP tools, whatever this computer says once it answers. */
export function useEngineModelInfo(tool: EngineTool, identity?: Identity): EngineModelInfo[] {
  const [asked, setAsked] = useState<EngineModelInfo[] | null>(live.get(tool) ?? null);
  useEffect(() => {
    setAsked(live.get(tool) ?? null);
    if (LISTED.includes(tool) || !identity || live.has(tool)) return;
    let on = true;
    hostApi<{ models: { id: string; label: string }[] }>(identity, "/api/runner/models", { method: "POST", body: JSON.stringify({ tool }) }).then(
      (r) => {
        const theirs = r.models.map((m) => ({ id: m.id, label: m.label, blurb: m.id }));
        if (!theirs.length) return;
        // Auto, where the short list has it, stays first.
        const list = [...ENGINE_MODEL_INFO[tool].filter((m) => m.id === "auto" && !theirs.some((x) => x.id === "auto")), ...theirs];
        live.set(tool, list);
        if (on) setAsked(list);
      },
      () => {},
    );
    return () => {
      on = false;
    };
  }, [tool, identity]);
  return asked ?? ENGINE_MODEL_INFO[tool];
}

/** Whether something typed could be a model's name, for one the list does not have. */
export const isModelName = (v: string) => /^[\w.\-/:[\]]{2,80}$/.test(v);

/**
 * A model asked for by name, typed where the list or pill was.
 *
 * This was prompt(), which the desktop app does not have: there it threw, and "Another model…" did nothing at all. Enter or
 * leaving the box keeps it, Escape leaves the model as it was.
 */
export function ModelNameInput({ tool, current, onDone, className }: { tool: EngineTool; current: string; onDone: (model: string | null) => void; className?: string }) {
  return (
    <InlineEdit
      value={current}
      className={className}
      label={`Which ${ENGINE_NAMES[tool]} model`}
      placeholder="The name it takes after --model"
      onSave={(v) => onDone(isModelName(v) ? v : null)}
      onCancel={() => onDone(null)}
    />
  );
}

export function EngineModelPill({ tool, model, onChange, disabled, title, identity }: { tool: EngineTool; model: string; onChange: (model: string) => void; disabled?: boolean; title?: string; identity?: Identity }) {
  const info = useEngineModelInfo(tool, identity);
  // "Another model…" turns the pill itself into a box to type the name in.
  const [typing, setTyping] = useState(false);
  const known = info.find((m) => m.id === model);
  const text = model ? (known?.label ?? model) : "Default";
  const mark = <EngineMark tool={tool} size={14} />;
  const items = (): MenuItem[] => {
    const out: MenuItem[] = [
      { heading: `${ENGINE_NAMES[tool]} models` },
      { label: "Default", title: `Whatever ${ENGINE_NAMES[tool]} is set to use`, mark, checked: !model, onSelect: () => onChange("") },
    ];
    let group: string | undefined;
    for (const m of info) {
      if (m.group && m.group !== group) out.push({ heading: m.group });
      group = m.group;
      out.push({ label: m.label, title: m.blurb, mark, checked: model === m.id, onSelect: () => onChange(m.id) });
    }
    // Anything else the CLI knows by name.
    if (model && !known) out.push({ label: model, title: "A model you typed", mark, checked: true, onSelect: () => {} });
    out.push({
      label: "Another model…",
      title: `Type the name ${ENGINE_NAMES[tool]} uses`,
      onSelect: () => setTyping(true),
    });
    return out;
  };
  if (disabled) {
    return (
      <span className="menu-pill model-pill-static" title={title}>
        {mark}
        <span>{text}</span>
      </span>
    );
  }
  if (typing)
    return (
      <ModelNameInput
        tool={tool}
        current={model}
        className="model-pill-input"
        onDone={(v) => {
          setTyping(false);
          if (v) onChange(v);
        }}
      />
    );
  return <MenuButton className="agent-pill model-pill" label={`${ENGINE_NAMES[tool]} model`} text={text} mark={mark} items={items} width={260} maxHeight={224} above />;
}
