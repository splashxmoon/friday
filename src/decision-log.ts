import type { LLM } from "./agent/llm.js";
import { commandFailed } from "./receipt.js";
import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * What a run settled, written down by itself.
 *
 * The reasoning behind a change is the first thing to be lost: it is in a chat
 * nobody re-reads, and the diff only says what. Asking people to write it down
 * does not work — PostHog found that of everyone who was offered a shared
 * context file, fourteen ever edited it — but reading a finished run for the
 * decisions in it is something a model does well and nobody has to remember.
 *
 * Small on purpose. Only a run with real work in it is read, only a handful of
 * things are kept, and only what will still be true next week: a decision and
 * its reason, a constraint that turned up, an approach that was tried and
 * failed. Status updates and what the diff already shows are left out.
 */

export interface Decision {
  key: string;
  text: string;
}

/** A run shorter than this has nothing worth filing. */
export const MIN_TOOL_CALLS = 4;
const MAX_DECISIONS = 5;
/** Enough of the run to judge it by, from the end, where the conclusions are. */
const MAX_CHARS = 12_000;

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** One lane's run as plain lines: who asked, what was said, and what was tried and failed. */
export function transcriptOf(events: SessionEvent[], lane: string, sinceSeq: number): { text: string; tools: number } {
  const lines: string[] = [];
  const commands = new Map<string, string>();
  let tools = 0;
  for (const e of events) {
    if (e.seq <= sinceSeq || (e.lane ?? MAIN_LANE) !== lane) continue;
    const b = e.body;
    if (b.type === "instruction") lines.push(`${e.actor.name} asked: ${clip(b.text, 500)}`);
    else if (b.type === "agent.message") {
      if (b.text.trim()) lines.push(`Agent: ${clip(b.text, 700)}`);
      for (const c of b.toolCalls) {
        tools++;
        if (c.name === "run_command" || c.name === "shell") {
          try {
            commands.set(c.id, String((JSON.parse(c.arguments || "{}") as { command?: unknown }).command ?? ""));
          } catch {
            // Arguments that are not JSON are not a command anyone can quote.
          }
        }
      }
    } else if (b.type === "tool.result" && commandFailed(b) === true && commands.has(b.callId)) {
      // What was tried and did not work is exactly what gets repeated otherwise.
      lines.push(`Tried \`${clip(commands.get(b.callId)!, 160)}\`, which failed: ${clip(b.output, 200)}`);
    }
  }
  let text = lines.join("\n");
  if (text.length > MAX_CHARS) text = text.slice(text.length - MAX_CHARS);
  return { text, tools };
}

const SYSTEM =
  "You read a finished run of a coding session and file what the team will want to know later. " +
  'Answer with only a JSON array of at most 5 objects, each {"key": "a-short-slug", "text": "one or two sentences"}. ' +
  "Keep only: a decision that was made and why, a constraint that turned up, or an approach that was tried and failed and why. " +
  "Leave out status updates, anything the diff already shows, and anything that is only true for this run. " +
  "If there is nothing worth keeping, answer [].";

/** Whatever the model said, read as decisions. Anything malformed is dropped, never guessed at. */
export function parseDecisions(raw: string): Decision[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: Decision[] = [];
  for (const x of list) {
    const o = (x ?? {}) as { key?: unknown; text?: unknown };
    const text = typeof o.text === "string" ? clip(o.text, 300) : "";
    const key = typeof o.key === "string" ? o.key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) : "";
    if (text.length >= 12 && key) out.push({ key, text });
    if (out.length >= MAX_DECISIONS) break;
  }
  return out;
}

export async function extractDecisions(llm: LLM, transcript: string, signal: AbortSignal, model?: string): Promise<Decision[]> {
  const done = await llm.complete({ system: SYSTEM, messages: [{ role: "user", content: transcript }], tools: [], signal, reasoningEffort: "low", ...(model ? { model } : {}) });
  return parseDecisions(done.text);
}
