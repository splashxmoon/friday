/**
 * How often each coding model gets hard work right, and what a task costs on it: what routing (routing.ts) weighs to pick the
 * model that is cheapest to a correct result rather than cheapest per token. A cheaper model that fails more is not cheaper: its
 * misses are paid for again, by a retry or by a person.
 *
 * `solve`: the share of hard, multi-file coding tasks it resolves. SWE-bench Pro where it is published; otherwise estimated from
 * Terminal-Bench 4 at the ratio the models with both scores show (about 1.37), and marked `est`. SWE-bench Verified is left out:
 * the best models all score 95% on it and its tests have leaked.
 * `cost`: dollars per task at the effort its tool runs it on (Artificial Analysis' cost per task), which also stands in for how
 * much of a plan's limits a task takes: Codex's credits are 25 per API dollar, and Claude's plans weigh models about as their
 * prices do.
 *
 * As of 2026-10-11. Sources: Anthropic's launch posts and system cards (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1), BenchLM's
 * Terminal-Bench 4 board, Artificial Analysis' model pages, OpenAI's and DeepSWE's figures for the GPT-6 models, NVIDIA's model
 * card. These are starting points, not the last word: they are measured on someone else's harness, so routing leans on them only
 * until outcomes here say otherwise.
 */
/** When the figures below were gathered. Outcomes learned here are kept per table (route-learning.ts), so a new one starts afresh. */
export const BENCH_ASOF = "2026-10-11";

export interface Bench {
  solve: number;
  cost: number;
  /** Dollars per million input tokens: what re-reading a conversation costs on it when a switch leaves its cache behind. */
  inPrice?: number;
  /** An estimate, not a published score. */
  est?: boolean;
}

export const BENCH: Record<string, Bench> = {
  // Claude Code, by the aliases its CLI resolves (October 2026), at its default effort (medium).
  "claude:opus": { solve: 0.899, cost: 1.34, inPrice: 4 },
  "claude:sonnet": { solve: 0.813, cost: 0.48, inPrice: 2 },
  "claude:haiku": { solve: 0.648, cost: 0.05, inPrice: 0.1 },
  // Below Opus on SWE-bench Pro at more than twice its cost, and capped at half the week on Max: never picked for anyone.
  "claude:fable": { solve: 0.812, cost: 2.98, inPrice: 10 },
  // Codex, at its default effort (medium). No SWE-bench Pro for any GPT-6 model: Terminal-Bench 4 58.2 / 57.7 / 16.4.
  "codex:gpt-6.1-sol": { solve: 0.8, cost: 0.21, inPrice: 2, est: true },
  "codex:gpt-6-astra": { solve: 0.79, cost: 1.14, inPrice: 10, est: true },
  "codex:gpt-6-luna": { solve: 0.45, cost: 0.03, inPrice: 0.1, est: true },
  // Friday's own agent: its everyday model (Nemotron 3 Ultra, free; SWE-bench Verified 70.7 puts it near 0.46 on Pro) and Friday Pro
  // (Claude Sonnet 5.5, SWE-bench Pro 81.3). Friday's model costs the person nothing; Friday Pro draws on a scarce window instead.
  "friday:base": { solve: 0.46, cost: 0, est: true },
  "friday:pro": { solve: 0.813, cost: 0.48 },
};

export const benchFor = (tool: string, model: string): Bench | undefined => BENCH[`${tool}:${model}`];
