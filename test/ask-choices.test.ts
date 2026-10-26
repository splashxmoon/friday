import assert from "node:assert/strict";
import { test } from "node:test";
import { askReply, parseAsks, parseChoices } from "../src/client/ask-choices.js";

/**
 * A coding tool's questions, read off the end of its answer.
 *
 * Every answer a coding tool gives goes through this, so the tests that matter most are the ones where it must say
 * nothing: a summary, a plan, a courtesy line. A card under an answer that wasn't asking anything is worse than none.
 */

const EXAMPLE = `I looked at the last three sweeps and the holdout numbers.

Before I plan further: **which thread does the team want to pull?**
[1] What's the primary goal right now?
- a. **Model accuracy (LOCO recall)** — requires a new tune sweep over the window sizes
- b. **Cross-network generalisation (the 19% holdout recall)** — needs the second network's data
- c. **System-level recall (LLM prompt)** — prompt work, no retraining
- d. **Other** — tell me what's on your mind.
(Answering "1=a" or "1=b" is enough to move forward.)`;

test("reads the questions a coding tool ends its answer with", () => {
  assert.deepEqual(parseAsks(EXAMPLE), [
    {
      n: 1,
      question: "What's the primary goal right now?",
      options: [
        { key: "a", label: "Model accuracy (LOCO recall)", detail: "requires a new tune sweep over the window sizes" },
        { key: "b", label: "Cross-network generalisation (the 19% holdout recall)", detail: "needs the second network's data" },
        { key: "c", label: "System-level recall (LLM prompt)", detail: "prompt work, no retraining" },
        { key: "d", label: "Other", detail: "tell me what's on your mind." },
      ],
    },
  ]);
});

test("several numbered questions, each with its own options", () => {
  const asks = parseAsks(`A few things first:

1. Which database should the cache use?
   a) Redis
   b) Postgres
2. Should old entries expire?
   a) After a day
   b) Never`);
  assert.deepEqual(
    asks.map((a) => [a.n, a.question, a.options.map((o) => `${o.key}:${o.label}`)]),
    [
      [1, "Which database should the cache use?", ["a:Redis", "b:Postgres"]],
      [2, "Should old entries expire?", ["a:After a day", "b:Never"]],
    ],
  );
});

test("bold numbers, Q1: and upper-case or bracketed keys", () => {
  assert.deepEqual(
    parseAsks("**1.** Which branch?\n- A) main\n- B) develop\n\n**2.** Squash?\n- A) Yes\n- B) No").map((a) => [a.n, a.question, a.options.map((o) => o.key + o.label)]),
    [
      [1, "Which branch?", ["Amain", "Bdevelop"]],
      [2, "Squash?", ["AYes", "BNo"]],
    ],
  );
  assert.deepEqual(
    parseAsks("**Q1: Where should the flag live?**\n(a) In the config\n(b) In the database").map((a) => [a.n, a.question, a.options.map((o) => o.label)]),
    [[1, "Where should the flag live?", ["In the config", "In the database"]]],
  );
  // Numbered, but nothing to pick in any of them: answered in the box, not a card (Arun, 2026-10-24).
  assert.deepEqual(parseAsks("Q1: Keep the old API?\nQ2: Bump the major version?"), []);
});

test("numbered options under a bracketed question are options, not more questions", () => {
  const asks = parseAsks("[1] Which test runner?\n1. Vitest\n2. node:test\n[2] Run them in CI?\n1. Yes\n2. No");
  assert.deepEqual(asks.map((a) => [a.n, a.options.map((o) => o.key + o.label)]), [
    [1, ["1Vitest", "2node:test"]],
    [2, ["1Yes", "2No"]],
  ]);
});

test("a single question with options and no number", () => {
  assert.deepEqual(parseAsks("The migration is ready.\n\nHow should I roll it out?\n- a) All at once\n- b) Behind a flag"), [
    { question: "How should I roll it out?", options: [{ key: "a", label: "All at once" }, { key: "b", label: "Behind a flag" }] },
  ]);
  // Numbered options under an unnumbered question.
  assert.deepEqual(parseAsks("Which approach do you prefer?\n1. Rewrite the parser\n2. Patch the regex").map((a) => [a.n, a.options.map((o) => o.label)]), [[undefined, ["Rewrite the parser", "Patch the regex"]]]);
  // A lettered list under a line with no question mark is still a choice.
  assert.deepEqual(parseAsks("I see two ways forward:\n\nA) Rewrite the parser\nB) Patch the regex").map((a) => [a.question, a.options.length]), [["I see two ways forward:", 2]]);
});

test("options written on the question's own line", () => {
  assert.deepEqual(parseAsks("Done with the refactor. Which next? A) the docs B) the tests"), [
    { question: "Done with the refactor. Which next?", options: [{ key: "A", label: "the docs" }, { key: "B", label: "the tests" }] },
  ]);
});

test("a question with nothing to choose is answered in the box under the chat, not a card (only multiple choice is)", () => {
  assert.deepEqual(parseAsks("I've drafted step 1 and the tests pass.\n\nShould I go ahead with step 2?"), []);
  assert.deepEqual(parseAsks("Two things before I go on:\n\nShould I bump the version?\nAnd do you want a changelog entry?"), []);
  assert.deepEqual(parseAsks("Want me to go deeper on any specific topic — eigenvalues, SVD, least squares, numerical stability, or how it maps to a particular library (NumPy, PyTorch, JAX)?"), [], "Arun, 2026-10-24: a card with nothing to pick");
});

test("an open question with nothing to choose is conversation, not a decision", () => {
  assert.deepEqual(parseAsks("Hello! What would you like to work on today?"), []);
  assert.deepEqual(parseAsks("Done. Anything else you need?"), []);
  assert.deepEqual(parseAsks("I looked at both. Which database should I use?"), [], "no choices offered: the box answers it");
  // Asking leave for a step, with nothing to pick, is answered in the box too.
  assert.equal(parseAsks("All green.\n\nOK to push to main?").length, 0);
  assert.equal(parseAsks("Would you like me to open a pull request?").length, 0);
  // And an open question with choices is a decision whatever it asks.
  assert.equal(parseAsks("What should we cache?\na) users\nb) sessions")[0]!.options.length, 2);
});

test("an option's explanation can wrap onto the next lines", () => {
  const [a] = parseAsks("Which cache?\n- a. **Redis** — fast,\n  but one more service to run\n- b. **In memory** — simplest");
  assert.deepEqual(a!.options, [
    { key: "a", label: "Redis", detail: "fast, but one more service to run" },
    { key: "b", label: "In memory", detail: "simplest" },
  ]);
});

test("the lead-in above numbered questions is not a question of its own", () => {
  // One of them with options: the free-text one beside it stays, as they're answered together.
  assert.deepEqual(parseAsks("Quick check?\n[1] Which port?\n- a) 3000\n- b) 8080\n[2] Which host?").map((a) => a.n), [1, 2]);
});

test("an answer that doesn't end by asking asks nothing", () => {
  const none = [
    "Done: I added a **Notes** section to `README.md`.\n\n- Read the README\n- Added the note\n- Checked node (v22.1.0)",
    "Here's the plan:\n1. Add the migration\n2. Wire the middleware\n3. Update the tests",
    "Here's what I did:\n1. Edited the parser\n2. Ran the tests",
    "All tests pass. Let me know if you want me to also update the docs.",
    "Should I keep going? I went ahead and fixed the typo anyway, so it's done.",
    "Why did it fail? Because the cache was stale. I cleared it and the build is green now.",
    "The fix is in.\n\n> Should we also handle the empty case?\n\nThat was the reviewer's question; I handled it.",
    "",
  ];
  for (const text of none) assert.deepEqual(parseAsks(text), [], text);
});

test("questions only count at the end of the answer", () => {
  assert.deepEqual(parseAsks("Which cache?\n- a) Redis\n- b) Memory\n\nI went with Redis since it was already running."), []);
  // Numbers that skip or don't start at 1 are a list, not a set of questions.
  assert.deepEqual(parseAsks("3. Should we cache it?\n4. Should we log it?"), []);
  // One option is not a choice.
  assert.deepEqual(parseAsks("Which one?\n- a) Redis"), []);
});

test("code is never read as questions", () => {
  assert.deepEqual(parseAsks("Run this:\n\n```\nread -p 'Continue?' yn\n```"), []);
  // An answer that ends inside an unclosed block ends in code.
  assert.deepEqual(parseAsks("Here:\n```js\nconst ok = confirm('Proceed?');"), []);
  // What comes after the code still counts.
  assert.deepEqual(parseAsks("```sh\nnpm test\n```\n\nShall I commit it?\na) Yes\nb) Not yet").map((a) => a.question), ["Shall I commit it?"]);
});

test("the reply is the agent's own shorthand with the words beside it", () => {
  const asks = parseAsks(EXAMPLE);
  assert.equal(askReply(asks, [{ key: "b", label: "Cross-network generalisation (the 19% holdout recall)" }]), "1=b (Cross-network generalisation (the 19% holdout recall))");
  const two = parseAsks("[1] Which?\n- a) X\n- b) Y\n[2] When?\n- a) Now\n- b) Later");
  assert.equal(askReply(two, [{ key: "a", label: "X" }, { text: "after the release" }]), "1=a (X)\n2: after the release");
  assert.equal(askReply([{ question: "Should I go ahead with step 2?", options: [] }], [{ text: "Yes, go ahead" }]), "Yes, go ahead");
  assert.equal(askReply([{ question: "Bump the version?", options: [] }, { question: "Add a changelog entry?", options: [] }], [{ text: "yes" }, { text: "no" }]), "Bump the version? yes\nAdd a changelog entry? no");
});

test("pulls inline lettered choices out of an ask_human question", () => {
  const { prompt, options } = parseChoices('Which do you mean? A) Review the spec B) Research patterns C) Draft the criteria');
  assert.equal(prompt, "Which do you mean?");
  assert.deepEqual(options.map((o) => o.label), ["Review the spec", "Research patterns", "Draft the criteria"]);
});

test("handles numbered choices", () => {
  const { prompt, options } = parseChoices("Pick one. 1) Ship it 2) Hold off");
  assert.equal(prompt, "Pick one.");
  assert.deepEqual(options.map((o) => o.label), ["Ship it", "Hold off"]);
});

test("leaves ordinary prose alone", () => {
  const q = "Should I use option a) or something else entirely?";
  const { prompt, options } = parseChoices(q);
  assert.equal(prompt, q);
  assert.deepEqual(options, []);
});

test("needs two consecutive markers, not just any letter", () => {
  const { options } = parseChoices("See section B) for details.");
  assert.deepEqual(options, []);
});

test("keeps the whole question as the prompt when there is no lead-in", () => {
  const { prompt, options } = parseChoices("A) yes B) no");
  assert.equal(prompt, "A) yes B) no");
  assert.equal(options.length, 2);
});
