import type { Completion, CompletionRequest, LLM } from "./agent/llm.js";

/**
 * The agent builder on somebody's own CLI.
 *
 * The builder talks to a model through one interface. Friday's model answers it from the server; a person's Claude Code,
 * Codex or Cursor answers it from their machine, one question at a time, on their own account and their own allowance.
 * This is the shim between the two: the builder's conversation flattened into one prompt, and the CLI's answer handed
 * back as a completion with nothing else in it.
 */

type Message = { role: string; content: unknown };

const text = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("") : "");

/** The conversation as one prompt: what was said, in order, ending with what is being asked now. */
export function cliPrompt(messages: Message[]): string {
  const turns = messages.filter((m) => m.role === "user" || m.role === "assistant");
  if (!turns.length) return "";
  if (turns.length === 1) return text(turns[0]!.content);
  const earlier = turns.slice(0, -1).map((m) => `${m.role === "user" ? "The person" : "You"} said:\n${text(m.content)}`).join("\n\n");
  return `The conversation so far:\n\n${earlier}\n\nThe person now says:\n${text(turns[turns.length - 1]!.content)}\n\nAnswer this last message, in the format your instructions ask for.`;
}

/** A model that is somebody's CLI: every completion is one question to it. No usage is counted, since it is theirs. */
export function cliLlm(ask: (q: { system: string; prompt: string }, onText?: (chunk: string) => void) => Promise<{ text: string }>): LLM {
  return {
    async complete(req: CompletionRequest): Promise<Completion> {
      // The CLI's text as it writes it goes to the builder the way a streamed model's does, so each card fills when its field is whole.
      const r = await ask({ system: req.system ?? "", prompt: cliPrompt((req.messages ?? []) as Message[]) }, req.onDelta);
      return { text: r.text, toolCalls: [], finishReason: "stop" };
    },
    async search() {
      return "";
    },
  };
}
