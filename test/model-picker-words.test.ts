import assert from "node:assert/strict";
import test from "node:test";
import { sourceOf, wordOf } from "../src/client/AgentModelPicker.js";

// The compact model picker (Arun, 2026-11-18): one plain word a model, and your own models said exactly, by where they run.
test("a model's one word comes from its line, and an old model's id-only line gives none", () => {
  assert.equal(wordOf("Most capable. For the longest, hardest tasks.", "fable"), "Smartest");
  assert.equal(wordOf("Complex reasoning and big pieces of work.", "opus"), "Deep");
  assert.equal(wordOf("Everyday work at a good pace.", "sonnet"), "Balanced");
  assert.equal(wordOf("Fast and light, for simple tasks.", "haiku"), "Fast");
  assert.equal(wordOf("claude-opus-4-8", "claude-opus-4-8"), "");
});

test("your own models say where they run: the provider of their key, the server on this computer, or its address", () => {
  assert.equal(sourceOf({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", name: "Work key" }), "Anthropic");
  assert.equal(sourceOf({ provider: "ollama", baseUrl: "http://localhost:11434/v1", local: true, name: "" }), "Ollama");
  assert.equal(sourceOf({ provider: "custom", baseUrl: "https://llm.example.com/v1", name: "Mine" }), "llm.example.com");
  assert.equal(sourceOf({ baseUrl: "http://127.0.0.1:9000/v1", local: true, name: "" }), "This computer (127.0.0.1:9000)");
});
