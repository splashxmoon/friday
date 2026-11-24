import assert from "node:assert/strict";
import { test } from "node:test";
import { aboutMinutes, auditFindings, ciFindings, FOUND_MAX, issueFinding, issueSize, rankFound, readBlame, readGrep, todoFindings, TODO_AGE_MS } from "../src/found-work.js";

const where = { repo: "acme/web", folder: "/code/web", branch: "main" };
const runs = (s: string, name = "CI") => [...s].map((c, i) => ({ workflowName: name, conclusion: c === "x" ? "failure" : c === "o" ? "success" : "cancelled", url: `https://github.com/acme/web/actions/runs/${i}` }));

test("ci: three failures in a row on main is broken, with the latest run's link", () => {
  const [f, ...rest] = ciFindings(runs("xxxooooo"), where);
  assert.equal(rest.length, 0);
  assert.equal(f!.kind, "broken");
  assert.equal(f!.title, "CI is failing on main");
  assert.equal(f!.why, "Its last 3 runs on main failed");
  assert.equal(f!.url, "https://github.com/acme/web/actions/runs/0");
  assert.match(f!.ask, /gh run view --log-failed/);
});

test("ci: failures now and then is flaky; one failure or too few runs says nothing", () => {
  const [f] = ciFindings(runs("oxooooxoooo"), where);
  assert.equal(f!.kind, "flaky");
  assert.equal(f!.why, "Failed 2 of its last 11 runs");
  assert.deepEqual(ciFindings(runs("oooxoooooo"), where), []);
  assert.deepEqual(ciFindings(runs("oxox"), where), []);
  // Cancelled runs say nothing either way.
  assert.deepEqual(ciFindings(runs("--xo-oooo"), where), []);
});

test("ci: each workflow is judged on its own, and the id is stable across looks", () => {
  const both = ciFindings([...runs("xxx", "Lint"), ...runs("oxooxoooo", "Test")], where);
  assert.deepEqual(both.map((f) => f.kind).sort(), ["broken", "flaky"]);
  assert.equal(ciFindings(runs("xxx", "Lint"), where)[0]!.id, ciFindings(runs("xxxx", "Lint"), where)[0]!.id);
});

test("audit: high and critical with a safe fix, as one row; a major-version fix is left out", () => {
  const json = {
    vulnerabilities: {
      axios: { severity: "high", fixAvailable: true, via: [{ title: "SSRF", url: "https://github.com/advisories/GHSA-1" }] },
      lodash: { severity: "critical", fixAvailable: { name: "lodash", isSemVerMajor: false }, via: ["x"] },
      next: { severity: "critical", fixAvailable: { isSemVerMajor: true }, via: [] },
      tiny: { severity: "moderate", fixAvailable: true, via: [] },
    },
  };
  const [f, ...rest] = auditFindings(json, where);
  assert.equal(rest.length, 0);
  assert.equal(f!.title, "2 packages have known vulnerabilities");
  assert.equal(f!.why, "1 critical, 1 high. A safe update fixes them");
  assert.equal(f!.size, "XS");
  assert.equal(f!.url, "https://github.com/advisories/GHSA-1");
  assert.match(f!.ask, /never --force/);
  assert.doesNotMatch(f!.ask, /next/);
  assert.deepEqual(auditFindings({ vulnerabilities: { next: json.vulnerabilities.next } }, where), []);
  assert.deepEqual(auditFindings(null, where), []);
  assert.equal(auditFindings({ vulnerabilities: { axios: json.vulnerabilities.axios } }, where)[0]!.title, "axios has a known vulnerability");
});

test("issues: a short bug is small and fixed straight away; anything else plans first", () => {
  assert.equal(issueSize({ body: "Crashes on save", labels: ["bug"] }), "S");
  assert.equal(issueSize({ body: "x".repeat(2000), labels: ["bug"] }), "M");
  assert.equal(issueSize({ body: "Add CSV export", labels: ["feature"] }), "M");
  const f = issueFinding({ repo: "acme/web", number: 91, title: "Dark mode loses the chart colours", body: "", url: "https://github.com/acme/web/issues/91", labels: ["bug", "ui", "p2"] }, "/code/web");
  assert.equal(f.why, "Issue #91, assigned to you · bug, ui");
  assert.deepEqual(f.issue, { repo: "acme/web", number: 91, url: "https://github.com/acme/web/issues/91", title: "Dark mode loses the chart colours" });
  assert.match(f.ask, /test that fails before the fix/);
});

test("todos: only this person's, two weeks old or more, oldest first, two at most", () => {
  const now = Date.UTC(2026, 10, 21);
  const at = (days: number) => Math.floor((now - days * 24 * 3600_000) / 1000);
  const todos = [
    { file: "a.ts", line: 3, text: "// TODO: handle partial refunds", authorTime: at(21), authorMail: "<me@x.com>" },
    { file: "b.ts", line: 9, text: "// TODO(arun): retry", authorTime: at(40), authorMail: "<ME@x.com>" },
    { file: "c.ts", line: 1, text: "// FIXME later", authorTime: at(60), authorMail: "<me@x.com>" },
    { file: "d.ts", line: 2, text: "// TODO: new one", authorTime: at(3), authorMail: "<me@x.com>" },
    { file: "e.ts", line: 2, text: "// TODO: theirs", authorTime: at(90), authorMail: "<them@x.com>" },
  ];
  const found = todoFindings(todos, { ...where, me: "me@x.com", now });
  assert.deepEqual(found.map((f) => f.why), ["c.ts:1 · you left it 8 weeks ago", "b.ts:9 · you left it 5 weeks ago"]);
  assert.equal(found[1]!.title, "TODO: retry");
  assert.deepEqual(todoFindings(todos, { ...where, me: "", now }), []);
  assert.ok(TODO_AGE_MS === 14 * 24 * 3600_000);
});

test("readGrep and readBlame read git's output", () => {
  assert.deepEqual(readGrep("src/a.ts:12:  // TODO: x\nweird:name.ts:3:// FIXME y\n\n"), [
    { file: "src/a.ts", line: 12, text: "// TODO: x" },
    { file: "weird:name.ts", line: 3, text: "// FIXME y" },
  ]);
  assert.deepEqual(readBlame("abc 1 1 1\nauthor Arun\nauthor-mail <a@b.c>\nauthor-time 1763000000\n"), { authorMail: "<a@b.c>", authorTime: 1763000000 });
  assert.equal(readBlame("nothing"), null);
});

test("rankFound: broken first, todos last, each once, without skipped, at most FOUND_MAX", () => {
  const todo = todoFindings([{ file: "a.ts", line: 1, text: "TODO x", authorTime: 0, authorMail: "m" }], { ...where, me: "m", now: Date.UTC(2026, 0, 1) })[0]!;
  const broken = ciFindings(runs("xxx"), where)[0]!;
  const ranked = rankFound([todo, broken, broken]);
  assert.deepEqual(ranked.map((f) => f.kind), ["broken", "todo"]);
  assert.deepEqual(rankFound([todo, broken], new Set([broken.id])).map((f) => f.kind), ["todo"]);
  const many = Array.from({ length: 20 }, (_, i) => ({ ...todo, id: `t${i}` }));
  assert.equal(rankFound(many).length, FOUND_MAX);
});

test("aboutMinutes", () => {
  assert.equal(aboutMinutes(10), "about 10m");
  assert.equal(aboutMinutes(3), "about 5m");
  assert.equal(aboutMinutes(60), "about 1h");
  assert.equal(aboutMinutes(65), "about 1h 5m");
  assert.equal(aboutMinutes(122), "about 2h");
});
