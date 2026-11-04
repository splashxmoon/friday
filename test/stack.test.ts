// Every agent its own app to run (src/runner/stack.ts; Arun, 2026-11-03).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const scratch = mkdtempSync(path.join(tmpdir(), "fb-stack-"));
process.env.FRIDAY_STACKS = path.join(scratch, "stacks.json");
process.env.FRIDAY_WORKTREES = path.join(scratch, "worktrees");
const { BLOCK, databaseIn, localPostgres, movePorts, stackFor, stackVars } = await import("../src/runner/stack.js");

test("a copy's env files have their ports moved into its block, the same port to the same new one, a database's left alone", () => {
  const moved = new Map<number, number>([[3000, 41000]]);
  let n = 0;
  const next = () => 41000 + ++n;
  const env = "PORT=3000\nVITE_API_URL=http://localhost:3000/api\nVITE_PORT=5173\nDATABASE_URL=postgres://me:pw@localhost:5432/shop\nREDIS_URL=redis://127.0.0.1:6379\nPUBLIC_URL=https://shop.example.com\n# PORT=9999 in a comment\n";
  assert.equal(movePorts(env, moved, next), "PORT=41000\nVITE_API_URL=http://localhost:41000/api\nVITE_PORT=41001\nDATABASE_URL=postgres://me:pw@localhost:5432/shop\nREDIS_URL=redis://127.0.0.1:6379\nPUBLIC_URL=https://shop.example.com\n# PORT=9999 in a comment\n");
  assert.equal(movePorts("API=http://localhost:5173", moved, next), "API=http://localhost:41001", "the same original to the same new one, in every file");
});

test("the database an env names: its kind, and a local Postgres one's parts", () => {
  assert.equal(databaseIn([{ file: ".env", text: "X=1\nDATABASE_URL=\"file:./dev.db\"" }])?.kind, "sqlite");
  assert.equal(databaseIn([{ file: ".env", text: "DATABASE_URL=postgresql://u:p@localhost:5432/shop_dev?schema=public" }])?.kind, "postgres");
  assert.equal(databaseIn([{ file: ".env", text: "DATABASE_URL=mysql://u@localhost/shop" }])?.kind, "other");
  assert.equal(databaseIn([{ file: ".env", text: "NOTHING=1" }]), null);
  const pg = localPostgres("postgresql://u:p@localhost:5432/shop_dev?schema=public")!;
  assert.equal(pg.db, "shop_dev");
  assert.equal(pg.with("shop_dev_f12345678"), "postgresql://u:p@localhost:5432/shop_dev_f12345678?schema=public");
  assert.equal(localPostgres("postgres://u:p@db.example.com/shop"), null, "only a database on this computer is ever copied");
});

test("an agent's copy gets its own ports, its env's ports moved and its SQLite file copied; dropped, all of it goes", async () => {
  const { addWorktree, dropWorktree } = await import("../src/runner/git.js");
  const { folderVars } = await import("../src/runner/environment.js");
  const repo = path.join(scratch, "shop");
  mkdirSync(path.join(repo, "prisma"), { recursive: true });
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(path.join(repo, ".gitignore"), ".env\nprisma/dev.db\n");
  writeFileSync(path.join(repo, "index.js"), "x\n");
  writeFileSync(path.join(repo, ".env"), "PORT=3000\nNEXT_PUBLIC_API=http://localhost:3000\nDATABASE_URL=file:./dev.db\n");
  writeFileSync(path.join(repo, "prisma", "dev.db"), "sqlite bytes");
  g("add", "-A");
  g("commit", "-qm", "init");

  const made = await addWorktree(repo, "Nova", false);
  const top = path.dirname(path.join(made.path, "x"));
  const s = stackFor(made.path);
  assert.ok(s, "it has a stack");
  assert.equal(s!.ports % BLOCK === 41000 % BLOCK, true);
  const env = readFileSync(path.join(top, ".env"), "utf8");
  assert.match(env, new RegExp(`^PORT=${s!.ports}$`, "m"), "its PORT is its block's first");
  assert.match(env, new RegExp(`NEXT_PUBLIC_API=http://localhost:${s!.ports}$`, "m"), "and the URL that named it moved with it");
  assert.equal(readFileSync(path.join(repo, ".env"), "utf8").includes("PORT=3000"), true, "the folder's own env untouched");
  assert.deepEqual(s!.db, { kind: "sqlite", name: path.join("prisma", "dev.db"), from: path.join("prisma", "dev.db") });
  assert.equal(readFileSync(path.join(top, "prisma", "dev.db"), "utf8"), "sqlite bytes", "its own copy of the database");
  assert.equal(folderVars(made.path).PORT, String(s!.ports), "everything it runs is given its PORT");
  assert.equal(stackVars(repo).PORT, undefined, "the folder itself has none");

  const second = await addWorktree(repo, "Ivy", false);
  assert.notEqual(stackFor(second.path)!.ports, s!.ports, "a second copy, a block of its own");

  assert.equal(await dropWorktree(top, true), true);
  assert.equal(stackFor(made.path), null, "dropped, its stack goes");
  assert.equal(existsSync(path.join(repo, "prisma", "dev.db")), true, "and the folder's database stays");
  await dropWorktree(path.dirname(path.join(second.path, "x")), true);
});

test("a copy set to get its own Postgres database where Postgres's tools aren't installed shares the folder's, and says why", async () => {
  const { setupStack, releaseStack } = await import("../src/runner/stack.js");
  const root = mkdtempSync(path.join(scratch, "pg-root-"));
  const dir = mkdtempSync(path.join(scratch, "pg-copy-"));
  writeFileSync(path.join(dir, ".env"), "DATABASE_URL=postgresql://me:pw@localhost:5432/shop_dev\n");
  const prior = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const s = await setupStack(root, dir, [".env"], { ownDb: true });
    assert.equal(s.db, undefined);
    assert.match(s.note ?? "", /psql, pg_dump\) aren't installed here, so it shares the folder's database|It shares the folder's database/);
    assert.equal(readFileSync(path.join(dir, ".env"), "utf8"), "DATABASE_URL=postgresql://me:pw@localhost:5432/shop_dev\n", "its env still names the folder's");
  } finally {
    process.env.PATH = prior;
    await releaseStack(dir);
  }
});
