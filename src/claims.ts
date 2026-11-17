import { commandFailed } from "./receipt.js";
import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * "Done", checked rather than claimed (Arun, 2026-11-15, after reports of agents saying "tests pass" when none ran): what a crew
 * mate's answer says passes (the tests, the build, the linter, the types), and whether a command in its turn backs it. When none
 * does, Friday runs the project's own (app.ts checkClaim) and says how it went; when one failed, the answer is contradicted.
 */

export type ClaimKind = "tests" | "build" | "lint" | "types";

const PASS = String.raw`(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|clean|ok|work(?:s|ing)|compiles?|no (?:errors|failures))`;
const CLAIMS: { kind: ClaimKind; re: RegExp }[] = [
  { kind: "tests", re: new RegExp(String.raw`\b(?:all (?:the )?|the |\d+ )?(?:tests?|specs?|test suite)\b[^.\n]{0,40}?\b${PASS}\b|\b${PASS}\b[^.\n]{0,12}\b(?:tests?|specs?)\b|\btests?: *(?:green|passing)`, "i") },
  { kind: "build", re: new RegExp(String.raw`\b(?:the )?build\b[^.\n]{0,30}?\b${PASS}\b|\bbuilds? (?:cleanly|fine|successfully)\b`, "i") },
  { kind: "lint", re: new RegExp(String.raw`\b(?:lint(?:er|ing)?|eslint)\b[^.\n]{0,30}?\b${PASS}\b`, "i") },
  { kind: "types", re: new RegExp(String.raw`\b(?:type ?check(?:ing)?|tsc|types)\b[^.\n]{0,30}?\b${PASS}\b`, "i") },
];
/** Said as not passing, or as not run: "tests still fail", "I couldn't run the tests". Not a claim of passing. */
const NOT = /\b(?:not|n't|never|fail(?:s|ed|ing)?|unable|couldn'?t|didn'?t|without|skipped|unverified|haven'?t)\b/i;

/** What an answer claims passes, with the sentence that says it; null when it claims nothing a command can check. */
export function claimOf(text: string): { kind: ClaimKind; words: string } | null {
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    for (const c of CLAIMS) {
      const m = c.re.exec(sentence);
      if (m && !NOT.test(sentence)) return { kind: c.kind, words: sentence.trim().slice(0, 200) };
    }
  }
  return null;
}

/** Whether a command is one that checks `kind`. */
export function checks(kind: ClaimKind, command: string): boolean {
  const c = command.toLowerCase();
  if (kind === "tests") return /\b(test|tests|pytest|jest|vitest|mocha|rspec|go test|cargo test|phpunit|playwright test|node --test)\b/.test(c);
  if (kind === "build") return /\b(build|compile|cargo build|go build|tsc -b|next build|vite build|gradle|mvn)\b/.test(c);
  if (kind === "lint") return /\b(lint|eslint|ruff|flake8|clippy|golangci|biome)\b/.test(c);
  return /\b(tsc|typecheck|type-check|mypy|pyright|check-types)\b/.test(c);
}

/** The last command in the turn (seqs `from` to `to`) that checks `kind`, and whether it passed; null when none ran. */
export function checkedIn(events: readonly SessionEvent[], lane: string, from: number, to: number, kind: ClaimKind): { command: string; ok: boolean } | null {
  const commands = new Map<string, string>();
  let last: { command: string; ok: boolean } | null = null;
  for (const e of events) {
    if (e.seq < from || e.seq > to || (e.lane ?? MAIN_LANE) !== lane) continue;
    const b = e.body;
    if (b.type === "agent.message")
      for (const c of b.toolCalls ?? []) {
        if (c.name !== "shell" && c.name !== "run_command") continue;
        try {
          const cmd = String((JSON.parse(c.arguments || "{}") as { command?: unknown }).command ?? "").trim();
          if (cmd && checks(kind, cmd)) commands.set(c.id, cmd);
        } catch {
          /* not readable */
        }
      }
    if (b.type === "tool.result" && commands.has(b.callId)) {
      const failed = commandFailed(b);
      if (failed !== null) last = { command: commands.get(b.callId)!, ok: !failed };
    }
    if (b.type === "folder.ran" && checks(kind, b.command)) last = { command: b.command, ok: !b.isError };
  }
  return last;
}

/**
 * The project's own command for `kind`, from what is in its folder: its package.json scripts, or the usual one for its language.
 * `has` says whether a file is there; `pkg` is package.json's text. "" when it can't say.
 */
export function commandFor(kind: ClaimKind, pkg: string | null, has: (file: string) => boolean): string {
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(pkg ?? "") as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    // no package.json, or not JSON
  }
  const run = (name: string) => (has("pnpm-lock.yaml") ? `pnpm ${name === "test" ? "test" : `run ${name}`}` : has("yarn.lock") ? `yarn ${name}` : has("bun.lockb") || has("bun.lock") ? `bun run ${name}` : name === "test" ? "npm test" : `npm run ${name}`);
  const script = (names: string[]) => names.find((n) => scripts[n] && !/no test specified/.test(scripts[n]!));
  if (kind === "tests") {
    const s = script(["test"]);
    if (s) return run(s);
    if (has("pytest.ini") || has("pyproject.toml") || has("setup.cfg")) return "python -m pytest -q";
    if (has("go.mod")) return "go test ./...";
    if (has("Cargo.toml")) return "cargo test";
    return "";
  }
  if (kind === "build") {
    const s = script(["build"]);
    if (s) return run(s);
    if (has("go.mod")) return "go build ./...";
    if (has("Cargo.toml")) return "cargo build";
    return "";
  }
  if (kind === "lint") {
    const s = script(["lint"]);
    return s ? run(s) : "";
  }
  const s = script(["typecheck", "type-check", "check-types", "tsc"]);
  if (s) return run(s);
  return has("tsconfig.json") ? "npx tsc --noEmit" : "";
}

/** The claim's words for a person: "the tests pass", "the build passes". */
export const claimWords = (k: ClaimKind) => (k === "tests" ? "the tests pass" : k === "build" ? "the build passes" : k === "lint" ? "the linter passes" : "the types check");
