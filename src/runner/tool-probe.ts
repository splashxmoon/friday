import { ENGINE_NAMES, type EngineTool } from "../types.js";

/**
 * How long finding one coding tool on this computer (where its binary is) may take. Only that: whether it is signed in and its
 * accounts have budgets of their own (a sign-in check answers within a second and a half, as "don't know yet" past it), and a
 * tool that was found is never dropped for them being slow. "Couldn't check" is for a tool we can't tell is installed at all.
 */
export const PROBE_MS = 3_000;

/** A tool that could not be looked for in time, or whose look failed: neither "installed" nor "not installed", but unknown. */
export type UnknownTool = { tool: EngineTool; name: string; path: null; loggedIn: null; source: null; unknown: true };

/** Said once a tool per process: a card refreshing every few seconds would say it every few seconds. */
const said = new Set<string>();

/**
 * One tool looked for, with a deadline and nothing thrown: a tool whose look hangs or fails is that tool's row said as unknown,
 * never the whole list. One odd tool installed used to leave the person with no tools at all, and their computer looking as if
 * it had none.
 */
export async function probeTool<T>(tool: EngineTool, look: () => Promise<T>, ms = PROBE_MS): Promise<T | UnknownTool> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([look(), new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error(`no answer in ${ms / 1000}s`)), ms)))]);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (!said.has(`${tool}|${why}`)) (said.add(`${tool}|${why}`), console.warn(`[tools] couldn't look at ${ENGINE_NAMES[tool]}: ${why}`));
    return { tool, name: ENGINE_NAMES[tool], path: null, loggedIn: null, source: null, unknown: true };
  } finally {
    clearTimeout(timer);
  }
}

export const isUnknown = (v: unknown): v is UnknownTool => !!v && typeof v === "object" && (v as { unknown?: unknown }).unknown === true;

/** A part of a found tool's row (its sign-in, its accounts, whether it can run here) that throws is left off, not the tool. */
export async function orElse<T>(f: () => T | Promise<T>, fallback: T): Promise<T> {
  try {
    return await f();
  } catch {
    return fallback;
  }
}
