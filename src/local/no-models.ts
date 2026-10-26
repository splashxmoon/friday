import type { Completion, CompletionRequest, LLM } from "../agent/llm.js";

/** Said wherever something would have asked Friday's own model: the open-source edition has none, only your coding tools. */
export const NO_MODELS_SAID = "Friday's own models aren't part of this edition: work runs on your own coding tools (Claude Code, Codex, Cursor and others).";

/** The local edition's stand-in for Friday's models: nothing to call, so every ask says why. */
export const NO_MODELS: LLM = {
  complete(_req: CompletionRequest): Promise<Completion> {
    return Promise.reject(new Error(NO_MODELS_SAID));
  },
  search(): Promise<string> {
    return Promise.reject(new Error(NO_MODELS_SAID));
  },
};
