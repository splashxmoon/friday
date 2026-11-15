import { EFFORT_LEVELS, ENGINE_MODEL_INFO, ENGINE_TOOLS, isEngineEffort, type EngineEffort, type EngineTool } from "./types.js";
import type { Teammate } from "./teammates.js";

/**
 * A crew mate's fallbacks, shared by the server and the page (the page can't load teammates.ts, which reads the disk).
 *
 * Each is a coding tool with the model and reasoning effort it runs on there (Arun, 2026-11-15: "make the fallback more advanced...
 * like the coding tool model and reasoning effort"); none set is the tool's own default. A list kept before that, of tools alone,
 * reads the same.
 */
export interface Fallback {
  tool: EngineTool;
  /** One of that tool's models (ENGINE_MODEL_INFO), "auto" where it routes; absent is its default. */
  model?: string;
  /** A level that tool takes (EFFORT_LEVELS); absent is the tool's own (Auto). */
  effort?: EngineEffort;
}

type Has = Pick<Teammate, "tool" | "backup" | "backups" | "switched">;

/** Its fallbacks in order, never its own tool: the list set, else the one backup, else the other of Claude Code and Codex. */
export function fallbacksOf(t: Has): Fallback[] {
  const own = t.switched?.from ?? t.tool;
  const raw = t.backups?.length ? t.backups : [t.backup ?? (own === "claude" ? "codex" : "claude")];
  const seen = new Set<string>();
  const out: Fallback[] = [];
  for (const b of raw) {
    const f = typeof b === "string" ? { tool: b } : b;
    if (!f?.tool || f.tool === own || seen.has(f.tool)) continue;
    seen.add(f.tool);
    out.push(f);
  }
  return out;
}

/** Its fallbacks' tools, in order. */
export const backupsOf = (t: Has): EngineTool[] => fallbacksOf(t).map((f) => f.tool);
/** What it runs on at one of its fallbacks: the model and effort set there, if any. */
export const fallbackFor = (t: Has, tool: EngineTool): Fallback | undefined => fallbacksOf(t).find((f) => f.tool === tool);

/** How many fallbacks a crew mate keeps. */
export const MAX_BACKUPS = 4;

/**
 * A fallback list as the page sent it, checked: tools Friday knows, each once, never its own or Friday's own models, at most
 * MAX_BACKUPS; a model kept only if that tool has it, an effort only if that tool takes it.
 */
export function cleanBackups(v: unknown, own: string, tools: readonly string[] = ENGINE_TOOLS): Fallback[] {
  if (!Array.isArray(v)) return [];
  const out: Fallback[] = [];
  for (const raw of v) {
    const o = (typeof raw === "string" ? { tool: raw } : raw) as { tool?: unknown; model?: unknown; effort?: unknown } | null;
    const tool = typeof o?.tool === "string" ? o.tool : "";
    if (!tools.includes(tool) || tool === own || tool === "friday" || out.some((f) => f.tool === tool)) continue;
    const t = tool as EngineTool;
    const model = typeof o!.model === "string" && ENGINE_MODEL_INFO[t]?.some((m) => m.id === o!.model) ? o!.model : undefined;
    const effort = isEngineEffort(o!.effort) && (EFFORT_LEVELS[t] ?? []).includes(o!.effort) ? o!.effort : undefined;
    out.push({ tool: t, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    if (out.length >= MAX_BACKUPS) break;
  }
  return out;
}
