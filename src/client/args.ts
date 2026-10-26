import type { ToolCall } from "../types.js";

function parse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

const parsed = new WeakMap<ToolCall, Record<string, unknown>>();
/** A call's arguments, parsed the first time they're asked for: a file written whole is parsed once, not on every draw. */
export function argsOf(call: ToolCall): Record<string, unknown> {
  let a = parsed.get(call);
  if (!a) parsed.set(call, (a = parse(call.arguments)));
  return a;
}
