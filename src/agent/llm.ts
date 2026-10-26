import type { ToolCall } from "../types.js";

// Provider-neutral shapes (OpenAI chat-completions format, which OpenRouter speaks).

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export type ChatMessage =
  | { role: "user"; content: string | ContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
      reasoning_details?: unknown[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  signal: AbortSignal;
  /** Per-session model override (a custom agent can pick its own model). */
  model?: string;
  /**
   * What the session is for, when no model was picked.
   *
   * Writing code and writing a memo are different jobs; the provider decides
   * which of its defaults suits this one rather than the caller knowing the
   * names of any of them.
   */
  /** Per-session reasoning effort ("low" | "medium" | "high"). Overrides the server default. */
  reasoningEffort?: string;
  /** Who is asking (the workspace), so a shared key can be paced fairly between them. */
  caller?: string;
  onDelta?: (text: string) => void;
  /** Live reasoning text, for display only (the replayable form is `Completion.reasoning`). */
  onReasoning?: (text: string) => void;
}

export interface Completion {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
  /** What the call cost, as the provider counted it. Absent if it didn't say. */
  usage?: { prompt: number; completion: number; total: number; cached?: number };
  /** The model that actually ran, which decides which pool it is charged to. */
  model?: string;
  /** Provider reasoning blocks; replayed verbatim on the next request. */
  reasoning?: unknown[];
}

export interface ModelInfo {
  model: string;
  free: boolean;
  configured: boolean;
  creditsRemaining: number | null;
}

export interface LLM {
  complete(req: CompletionRequest): Promise<Completion>;
  /** Web search used by the web_search tool. Returns findings with source URLs. */
  search(query: string, signal: AbortSignal): Promise<string>;
  info?(): Promise<ModelInfo>;
  /** Whether the given (or default) model accepts image input. */
  supportsImages?(model?: string): Promise<boolean>;
}

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
