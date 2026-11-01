// Crew skills (team-skills.ts): named, reusable procedures the crew keeps, listed in each teammate's note, fetched with use_skill,
// proposed by a teammate with save_skill as a card the person keeps or drops (Arun, 2026-10-31: skills, the biggest repeat-work saver).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { localKV } from "../src/local/kv.js";
import { NO_MODELS } from "../src/local/no-models.js";
import { cleanSkill, skillsNote, skillText, skillTools, SkillStore, usableBy, type Skill, type SkillView } from "../src/team-skills.js";
import type { TeammateView } from "../src/teammates.js";

process.env.FRIDAY_MINE = "1";
process.env.FRIDAY_TEAMMATES_DRY = "1";

const skill = (over: Partial<Skill> = {}): Skill => ({ id: "s1", name: "Cut a release", when: "When a version is ready to ship.", steps: "1. Bump the version.\n2. Tag it.", author: { id: "local", name: "Me", kind: "person" }, created: 1, updated: 1, ...over });

test("a skill's details are checked: a name, when, and steps; inputs, check and who it's for optional", () => {
  assert.throws(() => cleanSkill({ when: "x", steps: "y" }), /Give the skill a name/);
  assert.throws(() => cleanSkill({ name: "Release", steps: "y" }), /when to use it/);
  assert.throws(() => cleanSkill({ name: "Release", when: "x" }), /Write its steps/);
  assert.throws(() => cleanSkill({ name: "Release", when: "x", steps: "y", for: ["gone"] }, ["t1"]), /isn't in the crew/);
  assert.deepEqual(cleanSkill({ name: "  Cut   a release ", when: " When it ships ", steps: "1. Tag", inputs: "the version", check: "", for: [] }), { name: "Cut a release", when: "When it ships", steps: "1. Tag", inputs: "the version", check: undefined, for: undefined });
});

test("a teammate's note lists only the skills it may use, by name and when, and use_skill's text carries the steps and the check", () => {
  const open = skill();
  const kits = skill({ id: "s2", name: "Triage a bug report", when: "A new bug comes in.", for: ["kit"] });
  const asked = skill({ id: "s3", name: "Weekly changelog", when: "Fridays.", proposed: { for: { id: "local", name: "Me" }, sid: "x", lane: "l", at: 1 } });
  assert.equal(usableBy(kits, "nova"), false);
  assert.equal(usableBy(kits, "kit"), true);
  assert.equal(usableBy(asked, "kit"), false, "a proposal isn't offered until it's kept");
  const nova = skillsNote([open, kits, asked], "nova");
  assert.match(nova, /use_skill/);
  assert.match(nova, /- Cut a release: When a version is ready to ship\./);
  assert.doesNotMatch(nova, /Triage|Weekly/);
  assert.doesNotMatch(nova, /Bump the version/, "the steps stay out of the note");
  assert.match(skillsNote([open, kits], "kit"), /Triage a bug report/);
  assert.equal(skillsNote([asked], "kit"), "", "nothing to list, nothing said");
  const text = skillText(skill({ check: "The tag is on GitHub." }), "v2.1.0");
  assert.match(text, /Steps:\n1\. Bump the version\.\n2\. Tag it\./);
  assert.match(text, /This time: v2\.1\.0/);
  assert.match(text, /Done when: The tag is on GitHub\./);
  assert.match(text, /never changes that/, "said: a skill doesn't change who it works for");
});

test("on this computer: the person makes a skill, a teammate sees it in its note and uses it, proposes another, and the person keeps it", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-skills-"));
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } }, teammatesHome: home });
  t.after(async () => (await app.close(), await kv.close(), await rm(home, { recursive: true, force: true })));
  const call = async <T = { skills: SkillView[]; made?: string; error?: string }>(p: string, method = "GET", json?: unknown) => {
    const r = await fetch(`${app.url}${p}`, { method, headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
    return { status: r.status, body: (await r.json()) as T };
  };
  const team = (await call<{ sid: string; teammates: TeammateView[] }>("/api/teammates", "POST", { name: "Nova", tool: "claude", folder: path.join(home, "Nova") })).body;
  const kit = (await call<{ sid: string; teammates: TeammateView[] }>("/api/teammates", "POST", { name: "Kit", tool: "codex", folder: path.join(home, "Kit") })).body.teammates.find((x) => x.name === "Kit")!;
  const nova = team.teammates[0]!;

  assert.deepEqual((await call("/api/teammates/skills")).body.skills, []);
  const made = await call("/api/teammates/skills", "POST", { name: "Cut a release", when: "When a version is ready to ship.", steps: "1. Bump the version.\n2. Tag it and push the tag.", inputs: "the version", check: "The tag shows on GitHub." });
  assert.equal(made.status, 200, made.body.error);
  const release = made.body.skills[0]!;
  assert.deepEqual([release.name, release.author.name, release.mine, release.uses], ["Cut a release", "Me", true, 0]);
  assert.match((await call("/api/teammates/skills", "POST", { name: "cut a RELEASE", when: "x", steps: "y" })).body.error ?? "", /already has a skill called/);
  // One kept for Kit alone.
  await call("/api/teammates/skills", "POST", { name: "Triage a bug report", when: "A new bug comes in.", steps: "1. Reproduce it.", for: [kit.id] });

  // In the agents' tools wherever there is a crew, and in each teammate's note: the ones it may use.
  assert.ok((await app.mesh.listingFor(team.sid, false)).tools.some((x) => x.name === "use_skill"));
  const note = (await app.teammates.note(team.sid, nova.lane)) ?? "";
  assert.match(note, /- Cut a release: When a version is ready to ship\./);
  assert.doesNotMatch(note, /Triage a bug report/, "Kit's alone");
  assert.match((await app.teammates.note(team.sid, kit.lane)) ?? "", /Triage a bug report/);

  const listed = await app.mesh.call(team.sid, nova.lane, "list_skills", {});
  assert.match(listed.output, /Cut a release: When a version is ready to ship\.\n  Inputs: the version/);
  const used = await app.mesh.call(team.sid, nova.lane, "use_skill", { name: "cut a release", inputs: "v2.1.0" });
  assert.equal(used.isError, undefined, used.output);
  assert.match(used.output, /2\. Tag it and push the tag\.[\s\S]*Done when: The tag shows on GitHub\./);
  assert.match((await app.mesh.call(team.sid, nova.lane, "use_skill", { name: "Triage a bug report" })).output, /kept for Kit/);
  const after = (await call("/api/teammates/skills")).body.skills.find((s) => s.id === release.id)!;
  assert.deepEqual([after.uses, after.lastUsed?.by], [1, "Nova"], "counted, by whom");

  // Nova proposes one from a run that went well: a card in the Crew room, not offered until the person keeps it.
  const saved = await app.mesh.call(team.sid, nova.lane, "save_skill", { name: "Write the weekly changelog", when: "Friday afternoons.", steps: "1. Read the merged PRs.\n2. Write it up.", check: "It reads well to someone outside the team." });
  assert.equal(saved.isError, undefined, saved.output);
  assert.match(saved.output, /Proposed “Write the weekly changelog” to Me/);
  const card = (await app.store.events(team.sid)).findLast((e) => e.body.type === "skill.proposed");
  assert.ok(card && card.body.type === "skill.proposed");
  assert.deepEqual([card.body.name, card.body.madeBy.name, card.lane ?? "main"], ["Write the weekly changelog", "Nova", "main"]);
  const proposed = (await call("/api/teammates/skills")).body.skills.find((s) => s.name === "Write the weekly changelog")!;
  assert.deepEqual([proposed.author.kind, proposed.author.name, !!proposed.proposed], ["teammate", "Nova", true]);
  assert.doesNotMatch((await app.teammates.note(team.sid, kit.lane)) ?? "", /weekly changelog/);
  assert.equal((await app.mesh.call(team.sid, kit.lane, "use_skill", { name: "Write the weekly changelog" })).isError, true);

  // Kept: in every teammate's note from the next turn.
  const kept = await call(`/api/teammates/skills/${proposed.id}`, "PATCH", { keep: true });
  assert.equal(kept.status, 200, kept.body.error);
  assert.equal(kept.body.skills.find((s) => s.id === proposed.id)!.proposed, undefined);
  assert.match((await app.teammates.note(team.sid, kit.lane)) ?? "", /- Write the weekly changelog: Friday afternoons\./);

  // Edited and deleted by the person.
  const edited = await call(`/api/teammates/skills/${release.id}`, "PATCH", { when: "When main is green and a version is ready.", for: [nova.id] });
  assert.equal(edited.status, 200, edited.body.error);
  assert.deepEqual(edited.body.skills.find((s) => s.id === release.id)!.for, [nova.id]);
  assert.equal((await call(`/api/teammates/skills/${release.id}`, "DELETE")).body.skills.some((s) => s.id === release.id), false);
  assert.equal((await call("/api/teammates/skills/nope", "DELETE")).status, 404);

  // "Save as a skill" on a run: Nova is asked to write it up, in its own chat.
  const asked = await call<{ asked?: boolean; error?: string }>("/api/teammates/skills/write-up", "POST", { sid: team.sid, lane: nova.lane });
  assert.equal(asked.status, 200, asked.body.error);
  const told = (await app.store.events(team.sid)).findLast((e) => e.body.type === "instruction" && (e.lane ?? "main") === nova.lane);
  assert.match(told?.body.type === "instruction" ? told.body.text : "", /^Save what you just did as a crew skill with save_skill/);
  assert.equal((await call("/api/teammates/skills/write-up", "POST", { sid: team.sid, lane: "main" })).status, 400, "only a teammate's chat");
});

test("an out-of-date skill gets a teammate's change, kept in place; one kept for a teammate since removed is open to all; a name gone is said with what there is", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "friday-skills-unit-"));
  const kv = await localKV(home);
  try {
    const store = new SkillStore(kv.redis, "t:");
    const mates = new Map([["nova", "Nova"], ["kit", "Kit"]]);
    const cards: { name: string; revises?: string; to: string }[] = [];
    const tools = skillTools(async (_sid, lane) => ({
      store,
      mate: mates.has(lane) ? { id: lane, name: mates.get(lane)! } : null,
      name: mates.get(lane) ?? "Main",
      person: { id: "local", name: "Me" },
      mateName: (id) => mates.get(id),
      card: async (s, _by, to) => void cards.push({ name: s.name, ...(s.revises ? { revises: s.revises } : {}), to: to.name }),
    }));
    const release = await store.add(cleanSkill({ name: "Cut a release", when: "A version is ready.", steps: "1. Tag it.", check: "The tag is up.", for: ["kit"] }), { id: "local", name: "Me", kind: "person" });

    // Kept for Kit: not Nova's. Kit removed from the crew: open to everyone rather than dead.
    assert.equal((await tools.call("s", "nova", "use_skill", { name: "Cut a release" })).isError, true);
    mates.delete("kit");
    assert.match(await tools.note("s", "nova"), /- Cut a release/);
    assert.equal((await tools.call("s", "nova", "use_skill", { name: "Cut a release" })).isError, undefined);

    // Nova proposes a change under the same name: a card for the owner, the skill used as it is until kept; again, the same card.
    const r = await tools.call("s", "nova", "save_skill", { name: "cut a release", when: "A version is ready and main is green.", steps: "1. Run the tests.\n2. Tag it." });
    assert.match(r.output, /Proposed your change to “Cut a release” to Me/);
    assert.deepEqual(cards, [{ name: "Cut a release", revises: release.id, to: "Me" }]);
    assert.match((await tools.call("s", "nova", "use_skill", { name: "Cut a release" })).output, /Steps:\n1\. Tag it\./, "unchanged until kept");
    assert.match((await tools.call("s", "nova", "save_skill", { name: "Cut a release", when: "A version is ready and main is green.", steps: "1. Run the tests.\n2. Tag it.\n3. Push the tag." })).output, /Updated your proposal/);
    assert.equal(cards.length, 1, "one card for one change");
    const change = (await store.list()).find((s) => s.revises)!;
    const kept = await store.edit(change.id, { keep: true });
    assert.deepEqual([kept?.id, kept?.check, /Push the tag/.test(kept?.steps ?? "")], [release.id, "The tag is up.", true], "in place: its id, and its check kept");
    assert.equal((await store.list()).length, 1);

    // A name another teammate already proposed is theirs; a name since deleted is said with what there is.
    await tools.call("s", "nova", "save_skill", { name: "Weekly changelog", when: "Fridays.", steps: "1. Write it." });
    mates.set("kit", "Kit");
    assert.match((await tools.call("s", "kit", "save_skill", { name: "weekly changelog", when: "x", steps: "y" })).output, /Nova already proposed/);
    const gone = await tools.call("s", "kit", "use_skill", { name: "Triage a bug report" });
    assert.match(gone.output, /no skill called “Triage a bug report” now\. The crew's: Cut a release\./);

    // A teammate on its own model, run by Friday Code: the same line in its note, and the tools as its own.
    const own = await tools.withOwn(async () => ({ model: "own:local:m1", note: "You are Kit." }))("s", "kit");
    assert.match(own?.note ?? "", /You are Kit\.\n\nSkills the crew keeps[\s\S]*- Cut a release/);
    assert.deepEqual(own?.tools?.map((t) => t.name), ["list_skills", "use_skill", "save_skill"]);
  } finally {
    await kv.close();
    await rm(home, { recursive: true, force: true });
  }
});
