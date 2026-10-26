import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { ENGINE_NAMES, ENGINE_TOOLS, toolList, type EngineTool } from "../types.js";
import { ADAPTERS, childEnv, findBin, launcher } from "./adapters.js";
import { spawnCli } from "./spawn-cli.js";

/**
 * One question to the person's own CLI, answered as text.
 *
 * The agent builder is a short structured conversation, not a coding run: it needs a model, not a folder. Somebody with
 * Claude Code, Codex or Cursor on their machine already has a model on their own account, so the builder can run there,
 * through the same adapters the sessions use, in plan mode so nothing is changed, in a scratch folder so there is nothing
 * to change. Nothing leaves the machine but the answer.
 */

export interface AskInput {
  tool: EngineTool;
  system: string;
  prompt: string;
  model?: string;
  timeoutMs?: number;
}

/** onText hears the answer as the CLI writes it, a piece at a time; the whole answer is still what this returns. */
export async function askCli(input: AskInput, onText?: (chunk: string) => void): Promise<{ text: string }> {
  if (!ENGINE_TOOLS.includes(input.tool)) throw new Error(`Pick ${toolList()}.`);
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Nothing to ask.");
  const adapter = ADAPTERS[input.tool];
  const cannot = adapter.unavailable?.();
  if (cannot) throw new Error(cannot);
  const bin = await findBin(input.tool);
  if (!bin) throw new Error(`${ENGINE_NAMES[input.tool]} isn't installed on this machine.`);
  const launch = await launcher(bin);
  const cwd = path.join(tmpdir(), "friday-ask");
  await mkdir(cwd, { recursive: true });

  const spec = { prompt, resumeId: null, mode: "plan" as const, system: input.system, ...(input.model ? { model: input.model } : {}) };
  const args = adapter.args(spec);
  // Cursor's answer streams as it is written (the adapter asks for that), and its own result line has it whole.
  const partial = input.tool === "cursor";
  const child = spawnCli(launch.command, [...launch.prefix, ...args], { cwd, env: { ...childEnv(), ...launch.env, ...adapter.env?.(spec) } });
  const stdin = child.stdin!;
  stdin.on("error", () => {});
  // A tool spoken to as it runs (ACP) keeps its stdin until it has answered.
  if (adapter.interactive) stdin.write(adapter.stdin(spec));
  else stdin.end(adapter.stdin(spec));

  const parse = adapter.parser(spec, adapter.interactive ? { cwd, write: (l) => void (stdin.writableEnded || stdin.write(l)), end: () => void (stdin.writableEnded || stdin.end()) } : undefined);
  let text = "";
  let streamed = "";
  let done: { error?: string } | null = null;
  let note = "";
  let stderr = "";
  /** The finished answer as the CLI's own result line states it, when it gives one. */
  let final = "";
  child.stderr!.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    if (line.includes('"result"')) {
      try {
        const r = JSON.parse(line) as { type?: string; result?: unknown; is_error?: boolean };
        if (r.type === "result" && !r.is_error && typeof r.result === "string") final = r.result;
      } catch {
        // not one of its JSON lines
      }
    }
    for (const out of parse(line)) {
      if (out.kind === "message" && out.text) text = out.text;
      else if (out.kind === "delta" && out.channel === "text") {
        streamed += out.text;
        onText?.(out.text);
      }
      else if (out.kind === "note") note = out.text;
      else if (out.kind === "done") done = out;
    }
  });
  const killer = setTimeout(() => child.kill(), input.timeoutMs ?? 150_000);
  const exit = await new Promise<{ code: number | null }>((resolve) => {
    child.on("close", (code) => resolve({ code }));
    child.on("error", (err) => {
      stderr += err.message;
      resolve({ code: -1 });
    });
  });
  clearTimeout(killer);
  lines.close();

  const finished = done as { error?: string } | null;
  const answer = (partial ? final || streamed || text : text || final || streamed).trim();
  if (finished?.error || (!answer && (!finished || exit.code))) {
    throw new Error(adapter.explain(finished?.error || note || stderr.trim() || `${ENGINE_NAMES[input.tool]} exited with code ${exit.code}.`));
  }
  return { text: answer };
}
