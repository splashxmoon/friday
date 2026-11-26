import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADAPTERS, type AdapterOut, type TurnSpec } from "../src/runner/adapters.js";
import { ENGINE_MODEL_INFO, TOOL_INFO } from "../src/types.js";

const auggie = ADAPTERS.auggie;

function agent(spec: Partial<TurnSpec> = {}) {
  const t: TurnSpec = { prompt: "Fix the test", resumeId: null, mode: "edits", system: "Standing note", withSystem: true, ask: false, ...spec };
  const sent: Record<string, any>[] = [JSON.parse(auggie.stdin(t))];
  let ended = false;
  const parse = auggie.parser(t, { cwd: "/work/repo", write: (l) => void sent.push(JSON.parse(l)), end: () => { ended = true; } });
  const say = (o: Record<string, unknown>): AdapterOut[] => parse(JSON.stringify({ jsonrpc: "2.0", ...o }));
  const update = (u: Record<string, unknown>) => say({ method: "session/update", params: { sessionId: "s1", update: u } });
  return { parse, say, update, sent, last: () => sent.at(-1)!, ended: () => ended };
}

describe("auggie via ACP", () => {
  it("registers Auggie with its install command", () => {
    assert.equal(TOOL_INFO.auggie.name, "Auggie");
    assert.equal(TOOL_INFO.auggie.install.npm, "@augmentcode/auggie");
    assert.equal(TOOL_INFO.auggie.docs, "https://docs.augmentcode.com/cli/setup-auggie/install-auggie-cli");
    assert.deepEqual(ENGINE_MODEL_INFO.auggie, []);
  });

  it("starts auggie in ACP mode and signs in with auggie auth login", () => {
    const t: TurnSpec = { prompt: "Hi", resumeId: null, mode: "edits", system: "", withSystem: false, ask: false };
    assert.equal(auggie.tool, "auggie");
    assert.deepEqual(auggie.bins, ["auggie"]);
    assert.deepEqual(auggie.login, ["auth", "login"]);
    assert.deepEqual(auggie.logout, ["auth", "logout"]);
    assert.deepEqual(auggie.args(t), ["--acp"]);
  });

  it("reads the answer back", () => {
    const a = agent();
    assert.equal(a.sent[0].method, "initialize");
    assert.deepEqual(a.say({ id: 0, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }), []);
    assert.equal(a.last().method, "session/new");
    assert.deepEqual(a.last().params, { cwd: "/work/repo", mcpServers: [] });
    assert.deepEqual(a.say({ id: a.last().id, result: { sessionId: "s1" } }), [{ kind: "session", id: "s1" }]);
    assert.equal(a.last().method, "session/prompt");
    assert.equal(a.last().params.sessionId, "s1");
    const [chunk] = a.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
    assert.deepEqual(chunk, { kind: "delta", text: "Done.", channel: "text" });
  });
});
