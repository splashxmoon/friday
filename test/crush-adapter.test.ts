// Crush prints plain text, not an event stream: written from its documented output (crush run), not a live recording.
import assert from "node:assert/strict";
import test from "node:test";
import { ADAPTERS, CRUSH_LAST, plainText, type AdapterOut, type TurnSpec } from "../src/runner/adapters.js";
import { installStep } from "../src/client/engines.js";
import { ENGINE_MODEL_INFO, ENGINE_NAMES, ENGINE_TOOLS } from "../src/types.js";

const run = (parse: ReturnType<typeof plainText>, lines: string[], code: number | null = 0): AdapterOut[] => [...lines.flatMap((l) => parse(l)), ...(parse.end?.(code) ?? [])];
const said = (outs: AdapterOut[]) => outs.filter((o) => o.kind === "delta" && o.channel === "text").map((o) => (o.kind === "delta" ? o.text : "")).join("");

test("a Crush turn: the instruction on stdin, its answer as text, and the next turn continues its latest conversation", () => {
  const crush = ADAPTERS.crush;
  const turn: TurnSpec = { prompt: "Explain main.go", system: "Be brief.", resumeId: null, mode: "full", model: "gpt-5" };
  assert.deepEqual(crush.args(turn), ["run", "--quiet", "--model", "gpt-5"]);
  assert.match(crush.stdin(turn), /Be brief\.[\s\S]*Explain main\.go$/);
  const outs = run(crush.parser(turn), ["main.go starts the server."]);
  assert.equal(said(outs), "main.go starts the server.\n");
  assert.deepEqual(outs.slice(-2), [{ kind: "session", id: CRUSH_LAST }, { kind: "done" }]);
  assert.deepEqual(crush.args({ ...turn, resumeId: CRUSH_LAST, model: undefined }), ["run", "--quiet", "--continue"]);
  assert.deepEqual(crush.modes, ["full"]);
  assert.deepEqual(crush.login, ["login"]);
  assert.match(crush.explain("no providers configured"), /crush login/);
});

test("Crush is offered by name with its npm install line on every system", () => {
  assert.ok(ENGINE_TOOLS.includes("crush"));
  assert.deepEqual(ENGINE_MODEL_INFO.crush, []);
  assert.equal(ENGINE_NAMES.crush, "Crush");
  for (const os of ["windows", "mac", "linux"] as const) assert.equal(installStep("crush", os).command, "npm install -g @charmland/crush");
});
