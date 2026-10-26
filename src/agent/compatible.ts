import type { ToolCall } from "../types.js";
import { ProviderError, type Completion, type CompletionRequest, type LLM } from "./llm.js";

/**
 * Any server that speaks the OpenAI chat format: somebody's own key at OpenAI, Anthropic, Google, Groq…, or a model running
 * on their computer (Ollama, LM Studio, llama.cpp, vLLM). The open-source edition's own models are called through this
 * (runner/own-models.ts), and it sends only what every such server takes: the model, the conversation, the tools, a stream.
 * The key, when there is one, goes to that server and nowhere else.
 */
export class CompatibleLLM implements LLM {
  private readonly endpoint: string;
  constructor(private o: { baseUrl: string; model: string; apiKey?: string }) {
    this.endpoint = `${o.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }

  /** One request, retried while the reason is "wait a moment" (a limit, the server having one), honouring Retry-After. */
  private async send(build: () => RequestInit): Promise<Response> {
    let wait = FIRST_WAIT_MS;
    for (let i = 0; ; i++) {
      const init = build();
      const res = await fetch(this.endpoint, init);
      if (res.ok || i >= RETRIES || !RETRYABLE.has(res.status)) return res;
      const after = Number(res.headers.get("retry-after"));
      const ms = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, MAX_WAIT_MS) : wait;
      await res.body?.cancel().catch(() => {});
      if (init.signal?.aborted) return res;
      await sleep(ms + Math.random() * 250, init.signal ?? undefined);
      wait = Math.min(wait * 2, MAX_WAIT_MS);
    }
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    const build = (): RequestInit => ({
      method: "POST",
      signal: req.signal,
      headers: { "Content-Type": "application/json", ...(this.o.apiKey ? { Authorization: `Bearer ${this.o.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.o.model,
        messages: [{ role: "system", content: req.system }, ...req.messages],
        ...(req.tools.length ? { tools: req.tools } : {}),
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    for (let attempt = 0; ; attempt++) {
      const res = await this.send(build);
      if (!res.ok || !res.body) throw new ProviderError(res.status, await errorText(res));
      let text = "";
      let finishReason = "";
      let usage: Completion["usage"];
      const calls = new Map<number, ToolCall>();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            // Comments and blank lines are keep-alives.
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            const j = JSON.parse(data);
            if (j.error) throw new ProviderError(Number(j.error.code) || 500, j.error.message ?? JSON.stringify(j.error));
            // The usage chunk has no choices, so it is read before those are skipped.
            if (j.usage) usage = { prompt: Number(j.usage.prompt_tokens) || 0, completion: Number(j.usage.completion_tokens) || 0, total: Number(j.usage.total_tokens) || 0, cached: Number(j.usage.prompt_tokens_details?.cached_tokens) || 0 };
            const choice = j.choices?.[0];
            if (!choice) continue;
            const d = choice.delta ?? {};
            if (typeof d.content === "string" && d.content) {
              text += d.content;
              req.onDelta?.(d.content);
            }
            // Local servers name a model's thinking differently: Ollama and LM Studio `reasoning_content`, others `reasoning`.
            const thought = typeof d.reasoning === "string" ? d.reasoning : typeof d.reasoning_content === "string" ? d.reasoning_content : "";
            if (thought) req.onReasoning?.(thought);
            for (const tc of d.tool_calls ?? []) {
              const i = tc.index ?? 0;
              const c = calls.get(i) ?? { id: "", name: "", arguments: "" };
              if (tc.id) c.id = tc.id;
              if (tc.function?.name) c.name += tc.function.name;
              if (tc.function?.arguments) c.arguments += tc.function.arguments;
              calls.set(i, c);
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
          }
        }
      } catch (err) {
        // A server that fails after it has begun answering: nothing is kept from a stream until it ends, so it is asked again.
        const retryable = err instanceof ProviderError && RETRYABLE.has(err.status);
        if (!retryable || attempt >= RETRIES || req.signal?.aborted) throw err;
        await sleep(Math.min(FIRST_WAIT_MS * 2 ** attempt, MAX_WAIT_MS) + Math.random() * 250, req.signal);
        continue;
      }
      const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([i, c]) => ({ ...c, id: c.id || `call_${i}_${Date.now()}` }));
      return { text, toolCalls, finishReason, usage, model: req.model || this.o.model };
    }
  }

  search(): Promise<string> {
    return Promise.reject(new ProviderError(400, "Searching the web isn't something this model's server does."));
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const RETRIES = 3;
const FIRST_WAIT_MS = 1_200;
const MAX_WAIT_MS = 20_000;

/** A wait that a cancelled call doesn't have to sit through. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

async function errorText(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const j = JSON.parse(body);
    return j.error?.message ?? body;
  } catch {
    return body || res.statusText;
  }
}
