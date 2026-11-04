import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { childEnv, childPath } from "./adapters.js";
import { contains } from "../folder-key.js";

/**
 * Every agent its own app to run (Arun, 2026-11-03, of the shortlist: "Every agent gets its own app to run";
 * docs/plans/dev-essentials.md §3).
 *
 * A worktree stops two agents' files colliding, not their running apps: one agent's frontend talked to another's backend on the
 * same port, and a migration run in one copy changed everybody's database. So each copy an agent is given (a lane's worktree, a
 * teammate's copy) gets a stack of its own here, kept for the copy's life:
 *
 * - a block of ports: PORT is the first, set for its coding tool, its commands, its background commands and the Preview;
 * - the ports its copied .env files name (localhost:3000, VITE_PORT=5173) moved into that block, the same original to the same
 *   new one in every file, so its frontend calls its own backend (a database's or a cache's port is a shared server's: left);
 * - its database: a SQLite file the env names is copied with it; a local Postgres database is copied for it when the folder is
 *   set to (Environment: "Each agent's copy gets its own database"), and the copy's env points at the copy.
 *
 * Gone with the copy (dropWorktree): its ports freed and its database copy dropped. Friday only ever drops a database it made,
 * named `<name>_f<8 hex>` and kept in this registry.
 */

export interface Stack {
  /** The copy's top. */
  dir: string;
  /** The folder it is a copy of. */
  root: string;
  /** Its first port; it has BLOCK of them. */
  ports: number;
  /** Ports its env files named, moved: original → its own. */
  moved?: Record<string, number>;
  /**
   * Postgres: `server` is where it lives, to drop it again when the copy goes: with the password the folder's env gave it, kept
   * here only, in a file only its owner reads, as the copy's own env holds it anyway.
   */
  db?: { kind: "sqlite" | "postgres"; name: string; from: string; server?: string };
  /** What couldn't be done, said once in its Environment: "pg_dump isn't installed here". */
  note?: string;
  at: number;
}

export const BLOCK = 20;
const FIRST = 41000;
const LAST = 59980;
/** The ports of servers every copy shares (databases, caches, queues): never moved. */
const SHARED = new Set([5432, 5433, 3306, 3307, 6379, 6380, 27017, 9200, 9300, 11211, 5672, 15672, 1433, 1521, 2181, 9092, 8983, 4317, 4318, 26257, 8086]);

const FILE = () => process.env.FRIDAY_STACKS ?? path.join(homedir(), ".friday", "stacks.json");
function readAll(): Record<string, Stack> {
  try {
    return JSON.parse(readFileSync(FILE(), "utf8")) as Record<string, Stack>;
  } catch {
    return {};
  }
}
function writeAll(all: Record<string, Stack>): void {
  mkdirSync(path.dirname(FILE()), { recursive: true, mode: 0o700 });
  const tmp = `${FILE()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  renameSync(tmp, FILE());
}

/** The stack of the copy `cwd` is in (or is), if it has one. */
export function stackFor(cwd: string | undefined): Stack | null {
  if (!cwd) return null;
  const at = path.resolve(cwd);
  for (const s of Object.values(readAll())) if (at === path.resolve(s.dir) || contains(s.dir, at)) return s;
  return null;
}

/** What everything run in a copy with a stack is given: its first port as PORT, and the block. */
export function stackVars(cwd: string | undefined): Record<string, string> {
  const s = stackFor(cwd);
  return s ? { PORT: String(s.ports), FRIDAY_PORT_BASE: String(s.ports), FRIDAY_PORTS: `${s.ports}-${s.ports + BLOCK - 1}` } : {};
}

const free = (port: number) =>
  new Promise<boolean>((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });

/** The lowest block no copy has and nothing is listening at the start of. */
async function pickPorts(taken: Set<number>): Promise<number> {
  for (let p = FIRST; p <= LAST; p += BLOCK) if (!taken.has(p) && (await free(p)) && (await free(p + 1))) return p;
  throw new Error("No ports left for another copy.");
}

/** An env file's lines with its ports moved into the copy's block. Exported for its test. */
export function movePorts(text: string, moved: Map<number, number>, next: () => number): string {
  const to = (n: number) => {
    if (SHARED.has(n) || n < 1024 || n > 65535) return n;
    if (!moved.has(n)) moved.set(n, next());
    return moved.get(n)!;
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
      if (!m) return line;
      const [, lead, key, eq, raw] = m as unknown as [string, string, string, string, string];
      // A database's own address keeps its port: its server is shared; the copy gets its own database on it instead.
      if (/DATABASE|_DB_|^DB_|REDIS|MONGO|POSTGRES|MYSQL|AMQP|RABBIT|KAFKA|ELASTIC/i.test(key)) return line;
      if (/(?:^|_)PORT$/i.test(key) && /^["']?\d{2,5}["']?$/.test(raw.trim())) return `${lead}${key}${eq}${raw.replace(/\d{2,5}/, (d) => String(to(Number(d))))}`;
      return `${lead}${key}${eq}${raw.replace(/\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b/g, (_s, host: string, d: string) => `${host}:${to(Number(d))}`)}`;
    })
    .join(text.includes("\r\n") ? "\r\n" : "\n");
}

/** The database a set of env files names, as the first DATABASE_URL-like value: what kind, and where it is. Exported for its test. */
export function databaseIn(files: { file: string; text: string }[]): { file: string; key: string; value: string; kind: "sqlite" | "postgres" | "other" } | null {
  for (const f of files) {
    for (const line of f.text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?((?:[A-Za-z_][A-Za-z0-9_]*_)?(?:DATABASE_URL|DB_URL))\s*=\s*["']?([^"'\s#]+)/);
      if (!m) continue;
      const value = m[2]!;
      const kind = /^(?:file:|sqlite:)/i.test(value) || /\.(?:db|sqlite3?)$/i.test(value) ? "sqlite" : /^postgres(?:ql)?:\/\//i.test(value) ? "postgres" : "other";
      return { file: f.file, key: m[1]!, value, kind };
    }
  }
  return null;
}

/** A local Postgres URL's parts: only one on this computer is ever copied. */
export function localPostgres(url: string): { db: string; server: string; with: (db: string) => string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^postgres(ql)?:$/i.test(u.protocol) || !/^(localhost|127\.0\.0\.1|\[::1\]|)$/i.test(u.hostname)) return null;
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!db || !/^[\w-]{1,50}$/.test(db)) return null;
  const withDb = (name: string) => {
    const c = new URL(url);
    c.pathname = `/${encodeURIComponent(name)}`;
    return c.toString();
  };
  const server = new URL(url);
  server.pathname = "/postgres";
  return { db, server: server.toString(), with: withDb };
}

const run = (cmd: string, args: string[], opts: { input?: string; timeout?: number } = {}) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile(cmd, args, { env: { ...childEnv(), PATH: childPath() }, timeout: opts.timeout ?? 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim().split("\n")[0])) : resolve(String(out))));
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });

/** A copy of a local Postgres database, made with the tools Postgres ships: CREATE DATABASE, then pg_dump into it. */
async function copyPostgres(url: string, name: string): Promise<void> {
  const pg = localPostgres(url)!;
  await run("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-c", `CREATE DATABASE "${name}"`]);
  try {
    const dump = await run("pg_dump", ["--no-owner", "--no-acl", url], { timeout: 600_000 });
    await run("psql", [pg.with(name), "-v", "ON_ERROR_STOP=1", "-q"], { input: dump, timeout: 600_000 });
  } catch (e) {
    await run("psql", [url, "-q", "-c", `DROP DATABASE IF EXISTS "${name}"`]).catch(() => "");
    throw e;
  }
}

const ENV = /^\.env(\.[\w.-]+)?$/;
async function envAt(dir: string): Promise<string[]> {
  const top = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = top.filter((e) => e.isFile() && ENV.test(e.name)).map((e) => e.name);
  for (const d of top.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").slice(0, 30)) {
    for (const e of await readdir(path.join(dir, d.name), { withFileTypes: true }).catch(() => [])) if (e.isFile() && ENV.test(e.name)) out.push(`${d.name}/${e.name}`);
  }
  return out;
}

/** The biggest database copied for each copy: past it, the copy shares the folder's and says why. */
const MAX_PG_BYTES = 2 * 1024 ** 3;
const MAX_SQLITE_BYTES = 500 * 1024 ** 2;

/**
 * A copy's stack, made once when the copy is (git.ts addWorktree, app.ts copyFor) and kept: its ports, its env files' ports moved
 * into them, and its database. `env` is the env files copied into it, relative to its top. `ownDb`: the folder is set to give
 * each copy its own Postgres database. Never throws: whatever can't be done is its `note`.
 */
export async function setupStack(root: string, dir: string, env: string[], opts: { ownDb?: boolean } = {}): Promise<Stack> {
  const all = readAll();
  const had = all[dir];
  if (had && (!opts.ownDb || had.db)) return had;
  const s: Stack = had ?? { dir, root, ports: await pickPorts(new Set(Object.values(all).map((x) => x.ports))), at: Date.now() };
  // The env files it was given, or, a copy made before (a spare taken for a lane), the ones at its top and a level down.
  const named = env.length ? env : await envAt(dir);
  const files = (await Promise.all(named.filter((f) => /(^|\/)\.env(\.[\w.-]+)?$/.test(f)).map(async (f) => ({ file: f, text: await readFile(path.join(dir, f), "utf8").catch(() => "") })))).filter((f) => f.text);
  if (!had) {
    // Ports moved, the same original to the same new one in every file: PORT's own first, so it is the block's first.
    const moved = new Map<number, number>();
    let n = 0;
    const next = () => s.ports + Math.min(++n, BLOCK - 1);
    for (const f of files) {
      const port = f.text.match(/^\s*(?:export\s+)?PORT\s*=\s*["']?(\d{2,5})/m);
      if (port && !moved.has(Number(port[1]))) moved.set(Number(port[1]), s.ports);
    }
    for (const f of files) {
      const out = movePorts(f.text, moved, next);
      if (out !== f.text) await writeFile(path.join(dir, f.file), out);
      f.text = out;
    }
    if (moved.size) s.moved = Object.fromEntries([...moved].map(([a, b]) => [String(a), b]));
  }
  const db = databaseIn(files);
  if (db?.kind === "sqlite" && !s.db) {
    // A file the env names, relative to the file or where Prisma reads it from: copied from the folder, where the copy has none.
    const rel = db.value.replace(/^(?:file:|sqlite:(?:\/\/)?)/i, "");
    const tries = path.isAbsolute(rel) ? [rel] : [path.join(path.dirname(path.join(root, db.file)), rel), path.join(root, "prisma", rel), path.join(root, rel)];
    for (const from of tries) {
      const size = await stat(from).then((x) => (x.isFile() ? x.size : -1), () => -1);
      if (size < 0) continue;
      if (size > MAX_SQLITE_BYTES) {
        s.note = `Its database (${path.basename(from)}) is over 500 MB, so it uses the folder's own.`;
        break;
      }
      const to = path.join(dir, path.relative(root, from));
      if (!existsSync(to) && contains(root, from)) {
        await mkdir(path.dirname(to), { recursive: true }).catch(() => undefined);
        await copyFile(from, to).catch(() => undefined);
        for (const side of ["-wal", "-shm", "-journal"]) await copyFile(`${from}${side}`, `${to}${side}`).catch(() => undefined);
      }
      // Named by its full path in the folder: the copy's env names the copy's own file instead.
      if (existsSync(to) && path.isAbsolute(rel)) {
        const file = path.join(dir, db.file);
        await writeFile(file, (await readFile(file, "utf8")).split(from).join(to)).catch(() => undefined);
      }
      if (existsSync(to)) s.db = { kind: "sqlite", name: path.relative(dir, to), from: path.relative(root, from) };
      break;
    }
  }
  if (db?.kind === "postgres" && opts.ownDb && !s.db) {
    const pg = localPostgres(db.value);
    if (!pg) s.note = "Its database isn't a Postgres database on this computer, so it is shared.";
    else {
      const name = `${pg.db.slice(0, 50)}_f${randomBytes(4).toString("hex")}`;
      try {
        const size = Number((await run("psql", [db.value, "-tAc", `SELECT pg_database_size(current_database())`]).catch(() => "0")).trim()) || 0;
        if (size > MAX_PG_BYTES) throw new Error(`${pg.db} is ${Math.round(size / 1024 ** 3)} GB: too big to copy for every agent`);
        await copyPostgres(db.value, name);
        const file = path.join(dir, db.file);
        const text = await readFile(file, "utf8");
        await writeFile(file, text.split(db.value).join(pg.with(name)));
        s.db = { kind: "postgres", name, from: pg.db, server: pg.server };
        delete s.note;
      } catch (e) {
        const msg = (e as Error).message;
        s.note = /ENOENT|not found/i.test(msg) ? "Postgres's own tools (psql, pg_dump) aren't installed here, so it shares the folder's database." : `It shares the folder's database: ${msg}`;
      }
    }
  }
  const now = readAll();
  now[dir] = s;
  writeAll(now);
  return s;
}

/** A copy gone: its database copy dropped (only one Friday made, by the name it gave it), its ports freed. */
export async function releaseStack(dir: string): Promise<void> {
  const all = readAll();
  const key = Object.keys(all).find((k) => path.resolve(k) === path.resolve(dir));
  if (!key) return;
  const s = all[key]!;
  if (s.db?.kind === "postgres" && s.db.server && /_f[0-9a-f]{8}$/.test(s.db.name)) await run("psql", [s.db.server, "-q", "-c", `DROP DATABASE IF EXISTS "${s.db.name}"`]).catch(() => "");
  const now = readAll();
  delete now[key];
  writeAll(now);
}
