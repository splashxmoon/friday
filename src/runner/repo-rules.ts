import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { addRule, editRule, parseRules, removeRule, rulesNote, setRuleOn, type Rule } from "../repo-rules.js";

/**
 * The repository a folder belongs to: the nearest folder up with a .git. A separate copy an agent was given (a worktree, whose .git is
 * a file naming "gitdir: /repo/.git/worktrees/name", on Windows "C:\\repo\\.git\\worktrees\\name") is its repository's main folder, so a
 * rule saved from any lane lands in the one file the person's folder, the IDE and the team's commits share (environment.ts does the same).
 */
export function repoOf(cwd: string): string | null {
  for (let d = path.resolve(cwd), prev = ""; d !== prev; prev = d, d = path.dirname(d)) {
    const git = path.join(d, ".git");
    if (!existsSync(git)) continue;
    try {
      if (statSync(git).isFile()) {
        const g = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(git, "utf8"))?.[1];
        const abs = g && /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(g) ? g : g ? path.resolve(d, g) : "";
        const main = /^(.*?)[\\/]\.git[\\/]worktrees[\\/]/.exec(abs)?.[1];
        if (main && existsSync(main)) return main;
      }
    } catch {
      // A .git it can't read: the folder is the repo.
    }
    return d;
  }
  return null;
}

/**
 * Where a folder's rules live: .friday/rules.md at its repo's main folder. With no repo, the nearest folder up that has a rules file,
 * else the folder itself. Never the home folder (its .friday is Friday's own data folder, and every repo beneath would inherit
 * the rules) nor a filesystem root: null, and the folder has no rules.
 */
export function rulesRoot(cwd: string): string | null {
  const bad = (d: string) => d === path.parse(d).root || d === path.resolve(homedir());
  const repo = repoOf(cwd);
  if (repo) return bad(repo) ? null : repo;
  for (let d = path.resolve(cwd), prev = ""; d !== prev && !bad(d); prev = d, d = path.dirname(d)) if (existsSync(path.join(d, ".friday", "rules.md"))) return d;
  const here = path.resolve(cwd);
  return bad(here) ? null : here;
}

const fileOf = (cwd: string): string | null => {
  const root = rulesRoot(cwd);
  return root && path.join(root, ".friday", "rules.md");
};
const readText = (cwd: string) => {
  const f = fileOf(cwd);
  return f ? readFile(f, "utf8").catch(() => "") : Promise.resolve("");
};

export type RulesOp =
  | { op: "add"; text: string; from?: string; tools?: string }
  | { op: "toggle"; index: number; on: boolean }
  | { op: "edit"; index: number; text: string }
  | { op: "editText"; text: string; to: string }
  | { op: "remove"; index: number }
  | { op: "removeText"; text: string };

export async function readRules(cwd: string): Promise<{ file: string; rules: Rule[] }> {
  return { file: fileOf(cwd) ?? "", rules: parseRules(await readText(cwd)) };
}

const MAX_RULE = 300;
const word = (v: unknown, what: string): string => {
  if (typeof v !== "string") throw new Error(`The rule's ${what} must be text.`);
  return v.slice(0, MAX_RULE);
};
const index = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error("Which rule? The number is missing.");
  return v;
};

/** One change at a time per file: a chat's save and the IDE's toggle each read, change and write, and must not lose each other's. */
const queues = new Map<string, Promise<unknown>>();

export function writeRules(cwd: string, op: RulesOp): Promise<{ file: string; rules: Rule[]; removed?: boolean }> {
  if (!op || typeof op !== "object" || typeof (op as { op?: unknown }).op !== "string") return Promise.reject(new Error("Say what to do with the rules: add, toggle, edit, remove."));
  const file = fileOf(cwd);
  if (!file) return Promise.reject(new Error("Rules are kept in a project's folder. Open one first."));
  const run = async () => {
    const before = await readFile(file, "utf8").catch(() => "");
    let next = before;
    let removed: boolean | undefined;
    const find = (t: string) => parseRules(before).findIndex((r) => r.text.toLowerCase() === t.trim().toLowerCase());
    switch (op.op) {
      case "add": {
        const from = op.from === undefined ? undefined : word(op.from, "source");
        const tools = op.tools === undefined ? undefined : word(op.tools, "tools");
        next = addRule(before, { text: word(op.text, "text"), ...(from ? { from } : {}), ...(tools ? { tools } : {}) });
        break;
      }
      case "toggle":
        next = setRuleOn(before, index(op.index), op.on === true);
        break;
      case "edit":
        next = editRule(before, index(op.index), word(op.text, "text"));
        break;
      case "editText": {
        const i = find(word(op.text, "text"));
        removed = i >= 0;
        if (i >= 0) next = editRule(before, i, word(op.to, "new text"));
        break;
      }
      case "remove":
        next = removeRule(before, index(op.index));
        break;
      case "removeText": {
        const i = find(word(op.text, "text"));
        removed = i >= 0;
        if (i >= 0) next = removeRule(before, i);
        break;
      }
      default:
        throw new Error("Say what to do with the rules: add, toggle, edit, remove.");
    }
    if (next !== before) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, next);
    }
    return { file, rules: parseRules(next), ...(removed === undefined ? {} : { removed }) };
  };
  const p = (queues.get(file) ?? Promise.resolve()).then(run, run);
  queues.set(file, p.catch(() => {}));
  return p;
}

/** What a coding tool in this folder is told about the repo's rules (empty when the folder has none on). */
export async function rulesNoteFor(cwd: string | undefined, tool?: string): Promise<string> {
  if (!cwd) return "";
  return rulesNote(await readText(cwd), tool);
}
