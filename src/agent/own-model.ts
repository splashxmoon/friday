import { isOwnModel, ownModelParts } from "../own-model-id.js";
import { ProviderError, type Completion, type CompletionRequest, type LLM } from "./llm.js";

/** Asks somebody's computer to do something, with word back as it goes: the link to it, or this machine when it is theirs. */
export type ViaComputer = (userId: string, method: string, params: Record<string, unknown>, onProgress: (v: unknown) => void) => Promise<unknown>;

/**
 * Friday's model, or somebody's own.
 *
 * A model id of `own:<user>:<id>` is a key or a local model server set up on that person's computer, so the step goes
 * there and comes back with the same shape the provider's does: text as it is written, tool calls, usage. Everything else
 * goes to the provider as before. The id stays as given on the completion, so the meter knows it isn't Friday's to count.
 */
export class OwnModelLLM implements LLM {
  constructor(
    private base: LLM,
    private via: ViaComputer,
  ) {}

  async complete(req: CompletionRequest): Promise<Completion> {
    if (!isOwnModel(req.model)) return this.base.complete(req);
    const own = ownModelParts(req.model);
    if (!own) throw new ProviderError(400, "That isn't a model anyone has set up.");
    if (req.signal.aborted) throw new ProviderError(499, "Stopped.");
    const call = this.via(own.owner, "llm.complete", { id: own.entry, system: req.system, messages: req.messages, tools: req.tools, ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}) }, (v) => {
      if (req.signal.aborted) return;
      const p = v as { d?: string; r?: string } | null;
      if (p?.d) req.onDelta?.(p.d);
      if (p?.r) req.onReasoning?.(p.r);
    });
    call.catch(() => {});
    // Stopping the run stops waiting at once; the computer finishes its call on its own and the answer is let go.
    const stopped = new Promise<never>((_, reject) => req.signal.addEventListener("abort", () => reject(new ProviderError(499, "Stopped.")), { once: true }));
    const done = (await Promise.race([call, stopped])) as Completion;
    return { text: done.text ?? "", toolCalls: done.toolCalls ?? [], finishReason: done.finishReason ?? "", ...(done.usage ? { usage: done.usage } : {}), ...(done.reasoning ? { reasoning: done.reasoning } : {}), model: req.model };
  }

  search(query: string, signal: AbortSignal): Promise<string> {
    return this.base.search(query, signal);
  }

  info() {
    return this.base.info?.() ?? Promise.resolve({ model: "", free: true, configured: true, creditsRemaining: null });
  }

  /**
   * An own model is sent pictures only when its owner's computer says it sees them (set by them, or guessed from its name: see
   * seesImages): most local ones can't, and a picture sent to one that can't fails the whole step. Asked only for a step that has
   * pictures; a computer that can't be asked (an older runner, gone offline) is a no.
   */
  async supportsImages(model?: string): Promise<boolean> {
    if (!isOwnModel(model)) return (await this.base.supportsImages?.(model)) ?? false;
    const own = ownModelParts(model!);
    if (!own) return false;
    // A few seconds at most: the link waits minutes for a model's answer, and this is only a question about it.
    const asked = this.via(own.owner, "models.own.vision", { id: own.entry }, () => {}).catch(() => null);
    const r = (await Promise.race([asked, new Promise((resolve) => setTimeout(resolve, 5_000).unref?.())])) as { vision?: unknown } | null | undefined;
    return r?.vision === true;
  }
}

/** A model fixed for every call made through it: Friday's helpers (review, commit messages, skills) on somebody's own model. */
export function withModel(llm: LLM, model: string | undefined): LLM {
  if (!model) return llm;
  return { complete: (req) => llm.complete({ ...req, model }), search: (q, s) => llm.search(q, s), supportsImages: (m) => llm.supportsImages?.(m ?? model) ?? Promise.resolve(false) };
}
