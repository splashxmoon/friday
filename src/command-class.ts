/**
 * What kind of command this is, so an owner can say which kinds a teammate may approve.
 *
 * "Editors can approve test runs but not deploys" needs a command to be one or the other. The rule that keeps it honest is
 * that a command is only as safe as its riskiest part and anything not recognised is "other": a line is split into its
 * pieces (`a && b | c; d`), each piece is classified on its own, and a person may approve the line only if they may approve
 * every piece. Command substitution, `eval`, `sh -c`, a download piped into a shell and redirection into files are never
 * waved through as something milder than they are.
 */

import { lexLine } from "./command-shape.js";

export const COMMAND_CLASSES = ["read", "checks", "build", "install", "git", "publish", "deploy", "destructive", "other"] as const;
export type CommandClass = (typeof COMMAND_CLASSES)[number];

export const CLASS_LABEL: Record<CommandClass, { label: string; hint: string; careful?: boolean; /** What the command does, for its chip on a permission card, where the class's name reads oddly (audit CREW-24). */ chip?: string }> = {
  read: { label: "Look around", hint: "ls, cat, grep, git log and diff: nothing changes" },
  checks: { label: "Tests and checks", hint: "npm test, pytest, lint, typecheck" },
  build: { label: "Builds", hint: "npm run build, cargo build, go build" },
  install: { label: "Installs", hint: "npm install, pip install: runs other people's code" },
  git: { label: "Git, on this machine", hint: "add, commit, checkout, pull, merge, stash" },
  publish: { label: "Publish", hint: "git push, opening a pull request, releases", careful: true },
  deploy: { label: "Deploy", hint: "deploy, kubectl, terraform, cloud CLIs, ssh", careful: true },
  destructive: { label: "Delete or overwrite", hint: "rm, git reset --hard, force push, dropping data", careful: true, chip: "Deletes files" },
  other: { label: "Anything else", hint: "Commands this list doesn't recognise", careful: true },
};

/**
 * Split on the ways a shell chains commands, as a shell reads them (command-shape.ts: quotes, `$'…'` and backslashes taken apart,
 * `&&`, `||`, `;` and `|` outside quotes only). Each piece is its words joined by a space, as the command receives them. Null when
 * the line can't be read for certain, or a word the shell would change first (a `$`, a backtick) is in it.
 */
export function pieces(line: string): string[] | null {
  const l = lexLine(line);
  if (!l || l.pieces.some((p) => p.words.some((w) => w.expands))) return null;
  return l.pieces.map((p) => p.words.map((w) => w.text).join(" "));
}

const strip = (input: readonly string[]): string[] => {
  // Leading environment assignments (CI=1 npm test) are not what the command is.
  const words = input.filter(Boolean);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
  // `time`, `nice`, `env` and `command` wrap a command without changing what it is (sudo is a risk in itself, below).
  while (words.length && /^(time|nice|env|command)$/.test(words[0]!)) words.shift();
  return words;
};

const has = (w: string[], ...flags: string[]) => w.some((x) => flags.includes(x));

/** A long option written as any unique start of one of these (git takes --har for --hard), with or without its `=value`. */
const longAs = (x: string, ...names: string[]) => x.startsWith("--") && x.split("=")[0]!.length >= 4 && names.some((n) => n.startsWith(x.split("=")[0]!));
/** Short options run together (-qD), holding any of these letters. */
const shortHas = (x: string, letters: RegExp) => /^-[a-zA-Z]{2,}$/.test(x) && letters.test(x.slice(1));
/** Credentials and keys on a computer: reading them is never just looking around. */
const SECRET = /(^|\/)(\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.docker|\.kube|\.config\/gh)(\/|$)|(^|\/)id_(rsa|ed25519|ecdsa|dsa)\b/;
/** Whether a command line touches keys or credentials (~/.aws, ~/.ssh, an id_rsa): asked about at every level that asks. */
export const touchesSecrets = (line: string): boolean => line.split(/\s+/).some((x) => SECRET.test(x.replace(/^["']|["']$/g, "").replace(/^~/, "")));

/**
 * A git command's riskier forms, which its subcommand alone doesn't say (Fable re-check, 2026-11-11): a force, a hard reset or a
 * delete however it is written (-f, --force, --fo, --hard, --har, -D, -qD, --del), a branch moved or copied over another (-B, -C,
 * -M), a file written (--output), a program run (--ext-diff, -O, --upload-pack, -c), a remote changed, a stash dropped, a
 * checkout over files. Null when it is as the subcommand says.
 */
function gitRisk(a: string, args: string[]): CommandClass | null {
  const flags = args.filter((x) => x.startsWith("-"));
  const words = args.filter((x) => !x.startsWith("-"));
  // What runs another program: an upload pack, an external diff, files opened in a pager.
  if (flags.some((x) => x.startsWith("--upload-pack") || x.startsWith("--receive-pack") || x === "--ext-diff" || x.startsWith("--open-files-in-pager") || (a === "grep" && /^-O/.test(x)) || (a === "clone" && x === "-u"))) return "other";
  if (flags.some((x) => x === "-f" || x === "--discard-changes" || longAs(x, "--force", "--hard") || shortHas(x, /f/))) return "destructive";
  if (/^(branch|tag|checkout|switch|worktree)$/.test(a) && flags.some((x) => x === "-D" || x === "-B" || x === "-C" || x === "-M" || longAs(x, "--delete") || shortHas(x, /[DM]/))) return "destructive";
  if (/^(diff|log|show|format-patch|range-diff)$/.test(a) && flags.some((x) => x === "--output" || x.startsWith("--output=") || (a === "format-patch" && (x === "-o" || x.startsWith("--output-directory"))))) return "destructive";
  if (a === "remote" && words.some((x) => /^(add|set-url|remove|rm|rename|prune|set-head|set-branches)$/.test(x))) return "other";
  if (a === "stash" && words.some((x) => /^(drop|clear)$/.test(x))) return "destructive";
  if (a === "checkout") {
    // Values that aren't what is checked out: a new branch's name, an orphan's, a tracked one's.
    const pos: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const x = args[i]!;
      if (/^(-b|-B|--orphan|-t|--track)$/.test(x)) i++;
      else if (!x.startsWith("-")) pos.push(x);
    }
    // Files rather than a branch: "--", ".", a folder, or a commit then paths, each put back as that commit has them.
    if (args.includes("--") || pos.some((x) => x === "." || x === "./" || x.endsWith("/")) || pos.length >= 2) return "destructive";
  }
  return null;
}

/**
 * A variable in front of a command that changes what runs (NODE_OPTIONS=--require, LD_PRELOAD, PATH, GIT_SSH_COMMAND), or whose
 * value runs something: the command is anything at all then (Fable re-check, 2026-11-11). CI=1 or FORCE_COLOR=0 change nothing.
 */
const RISKY_ENV = /^(NODE_OPTIONS|NODE_PATH|LD_\w+|DYLD_\w+|PATH|BASH_ENV|ENV|ZDOTDIR|PROMPT_COMMAND|IFS|SHELL|HOME|PYTHON\w*|PERL\w*|RUBY\w*|RUBYOPT|GEM_\w+|GIT_\w+|npm_config_\w+|NPM_CONFIG_\w+|YARN_\w+|CARGO_\w+|RUSTC_WRAPPER|RUSTFLAGS|EDITOR|VISUAL|PAGER|LESSOPEN|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS)$/i;
export function riskyEnv(words: readonly string[]): boolean {
  for (const word of words) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word);
    if (!m) return false;
    if (RISKY_ENV.test(m[1]!) || /[$`()]/.test(m[2]!)) return true;
  }
  return false;
}

/** What kind of command one piece is, from its words as the shell hands them over (command-shape.ts). */
export const classOfWords = (words: readonly string[]): CommandClass => classOfPiece(words);

function classOfPiece(words: readonly string[]): CommandClass {
  if (riskyEnv(words)) return "other";
  const w = strip(words);
  const [bin = "", a = "", b = ""] = w;
  if (!bin) return "other";
  if (bin === "sudo" || bin === "su" || bin === "doas") return "destructive";
  // Keys and credentials, read by anything.
  if (w.some((x) => SECRET.test(x.replace(/^~/, "")))) return "other";

  // Removing and overwriting.
  if (/^(rm|rmdir|shred|truncate|dd|mkfs|chmod|chown|chgrp|mv|ln)$/.test(bin)) return "destructive";
  if (/^(sed)$/.test(bin) && has(w, "-i", "--in-place")) return "destructive";
  if (/^(find)$/.test(bin) && w.some((x) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(x))) return "destructive";
  if (/^(drop|truncate)$/i.test(bin)) return "destructive";

  // Looking.
  if (/^(ls|cat|head|tail|wc|grep|rg|ag|fd|tree|pwd|echo|printf|which|whoami|date|stat|file|du|df|diff|cmp|sort|uniq|cut|tr|basename|dirname|realpath|true|false|test|\[|cd|pushd|popd|env|printenv|uname|id)$/.test(bin)) return bin === "find" ? "other" : "read";
  if (bin === "find") return "read";
  // sed printing lines and nothing else ("sed -n 1,150p file", "sed -n '/start/,/end/p'"): looking, as cat and head are (Arun,
  // 2026-11-13: "why is crew asking me to approve this stuff?"). Any other script, which could write a file (w) or run one (e),
  // stays unrecognised.
  if (bin === "sed" && sedPrintsOnly(w.slice(1))) return "read";
  if (bin === "git") {
    // A push is publishing, its force said by always-ask.ts; anything else as risky as its riskier forms.
    const risk = a.startsWith("-") || a === "push" ? null : gitRisk(a, w.slice(2));
    if (risk) return risk;
    if (/^(status|log|diff|show|blame|ls-files|ls-tree|rev-parse|describe|shortlog|grep|reflog|cat-file|config|remote|tag|branch|stash)$/.test(a)) {
      if (a === "stash" && !/^(list|show)$/.test(b)) return "git";
      if ((a === "branch" || a === "tag") && has(w, "-d", "-D", "--delete", "-f", "--force")) return "destructive";
      if (a === "branch" || a === "tag") return b && !b.startsWith("-") ? "git" : "read";
      if (a === "config" && b && !b.startsWith("--get") && !b.startsWith("--list") && b !== "-l") return "git";
      return "read";
    }
    if (a === "push") return "publish";
    if (a === "reset" && has(w, "--hard", "--merge", "--keep")) return "destructive";
    if (a === "clean" || (a === "checkout" && has(w, "--", ".")) || (a === "restore" && !has(w, "--staged"))) return "destructive";
    if (a === "rebase" || a === "filter-branch" || a === "filter-repo") return "destructive";
    if (/^(add|commit|checkout|switch|pull|fetch|merge|cherry-pick|revert|mv|rm|init|clone|worktree|submodule|apply|am|restore|reset|bisect)$/.test(a)) return a === "rm" || a === "mv" ? "destructive" : "git";
    return "other";
  }
  if (bin === "gh") return /^(pr|release|repo|issue|workflow|run|api)$/.test(a) ? (a === "run" || a === "workflow" || a === "api" ? "other" : "publish") : "other";

  // Package managers.
  const pm = /^(npm|pnpm|yarn|bun)$/.test(bin);
  // Run from another folder: another package's scripts (npm --prefix /tmp/evil run build).
  if (pm && w.some((x) => /^(--prefix|-C|--dir|--cwd)(=|$)/.test(x))) return "other";
  if (pm) {
    if (/^(install|i|add|ci|update|upgrade|remove|rm|uninstall|link|dedupe|prune)$/.test(a)) return "install";
    if (a === "publish" || a === "deploy" || a === "login") return a === "publish" ? "deploy" : "other";
    if (/^(test|t|lint|typecheck|check|format|fmt)$/.test(a)) return "checks";
    if (a === "audit" || a === "outdated" || a === "ls" || a === "list" || a === "why" || a === "view" || a === "info") return "read";
    // yarn, pnpm and bun run a script by its name alone (pnpm build is pnpm run build).
    if (a === "run" || a === "run-script" || (/^(yarn|pnpm|bun)$/.test(bin) && a)) {
      const script = a === "run" || a === "run-script" ? b : a;
      if (/^(test|tests|test:\w[\w:-]*|lint|lint:\w[\w:-]*|typecheck|type-check|tsc|check|check:\w[\w:-]*|format:check|fmt:check|e2e|spec|vitest|jest)$/.test(script)) return "checks";
      if (/^(build|build:\w[\w:-]*|compile|bundle|dist|package)$/.test(script)) return "build";
      if (/^(deploy|release|publish|ship)/.test(script)) return "deploy";
      return "other";
    }
    return "other";
  }
  if (/^(npx|pnpx|bunx)$/.test(bin)) {
    const tool = a.replace(/@.*$/, "");
    if (/^(vitest|jest|mocha|ava|playwright|cypress|eslint|tsc|prettier|biome|oxlint|stylelint)$/.test(tool)) return tool === "prettier" && has(w, "--write", "-w") ? "build" : "checks";
    return "other";
  }
  if (/^(vitest|jest|mocha|pytest|py\.test|tox|nox|rspec|phpunit|ctest|eslint|tsc|mypy|ruff|flake8|pylint|black|isort|rubocop|golangci-lint|shellcheck)$/.test(bin)) return bin === "black" || bin === "isort" || (bin === "ruff" && a === "format") ? (has(w, "--check", "--diff") ? "checks" : "build") : "checks";
  if (bin === "tsx" || bin === "node" || bin === "ts-node" || bin === "deno" || bin === "python" || bin === "python3" || bin === "ruby" || bin === "php") {
    // Code loaded before the tests: --require, --import, a loader, or code on the line itself.
    if (w.some((x) => /^(-r|--require|--import|--loader|--experimental-loader|-e|--eval|-p|--print|-c)(=|$)/.test(x))) return "other";
    if (a === "--test" || (bin === "node" && has(w, "--test")) || (/^python3?$/.test(bin) && a === "-m" && /^(pytest|unittest)$/.test(b))) return "checks";
    return "other";
  }
  // A program run in its place (-exec, -toolexec, -vettool) or another folder (-C): anything at all.
  if (bin === "go" && w.some((x) => /^-(exec|toolexec|vettool|C)(=|$)/.test(x))) return "other";
  if (bin === "go") return /^(test|vet)$/.test(a) ? "checks" : a === "build" || a === "install" ? "build" : /^(get|mod)$/.test(a) ? "install" : /^(list|env|version|doc)$/.test(a) ? "read" : "other";
  if (bin === "cargo") return /^(test|clippy|check|fmt)$/.test(a) ? "checks" : /^(build|b|doc|bench)$/.test(a) ? "build" : /^(add|fetch|install|update|remove)$/.test(a) ? "install" : a === "publish" ? "deploy" : /^(tree|metadata|search)$/.test(a) ? "read" : "other";
  if (bin === "make" || bin === "just" || bin === "task") {
    // Every target, wherever it is on the line (after -k, -B or --), each as risky as it is (Fable re-check, 2026-11-11); another
    // makefile or folder is anything at all.
    const args = w.slice(1);
    if (args.some((x) => /^(-f|--file|--makefile|-C|--directory|-I|--include-dir|-E|--eval|--justfile|--working-directory|-d|--dir|-t|--taskfile)(=|$)/.test(x) || /^-[fCIE]./.test(x))) return "other";
    const targets = args.filter((x) => !x.startsWith("-") && !x.includes("=") && !/^\d+$/.test(x));
    if (!targets.length) return "build";
    const one = (t: string): CommandClass => (/^(test|tests|check|lint|typecheck)$/.test(t) ? "checks" : /^(build|all|compile)$/.test(t) ? "build" : /^(deploy|release|publish|push)/.test(t) ? "deploy" : "other");
    return targets.map(one).sort((x, y) => RISK.indexOf(y) - RISK.indexOf(x))[0]!;
  }
  if (/^(mvn|gradle|gradlew|\.\/gradlew|\.\/mvnw)$/.test(bin)) return /^(test|verify|check)$/.test(a) ? "checks" : /^(package|compile|build|assemble|install)$/.test(a) ? "build" : /^(deploy|publish)/.test(a) ? "deploy" : "other";
  if (/^(pip|pip3|poetry|uv|pipenv|bundle|gem|composer|dotnet|apt|apt-get|brew|yum|dnf|apk|pacman)$/.test(bin)) {
    if (bin === "dotnet" && a === "test") return "checks";
    if (bin === "dotnet" && a === "build") return "build";
    if (bin === "poetry" && a === "publish") return "deploy";
    return /^(install|add|sync|update|upgrade|remove|uninstall|i)$/.test(a) || (bin === "pip" && a === "install") ? "install" : /^(list|show|freeze|outdated|check|search|info)$/.test(a) ? "read" : "other";
  }

  // Putting things in front of users, or on other machines.
  if (/^(vercel|netlify|fly|flyctl|heroku|kubectl|helm|terraform|tofu|pulumi|ansible|ansible-playbook|serverless|sls|cdk|aws|gcloud|az|doctl|wrangler|firebase|ssh|scp|rsync|sftp|ftp|docker-compose|docker|podman)$/.test(bin)) {
    if (bin === "docker" || bin === "podman" || bin === "docker-compose") return /^(ps|images|logs|inspect|version|info|ls)$/.test(a) ? "read" : a === "build" ? "build" : a === "push" ? "deploy" : /^(rm|rmi|prune|system|kill|stop)$/.test(a) ? "destructive" : "other";
    return "deploy";
  }
  // Sending, writing a file or reading a config, however the options are written (-o~/.zshrc, --data-binary, -sSLo).
  if (/^(curl|wget)$/.test(bin)) return w.slice(1).some((x) => /^(-X|--request|-d|--data|-F|--form|-T|--upload-file|-o|-O|--output|-K|--config|--post|--body|-P|--directory-prefix)/.test(x) || /^-[a-zA-Z]*[oOdFTXKP]/.test(x)) ? "other" : "read";
  return "other";
}

/** A line address: a number, $, or a /pattern/ with no slash of its own inside. */
const SED_ADDR = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/)`;
const SED_PRINT = new RegExp(`^${SED_ADDR}(?:,${SED_ADDR})?p$`);
/** "-n" and one or more print-only scripts (-e or bare), then files: nothing else. */
function sedPrintsOnly(args: readonly string[]): boolean {
  let quiet = false;
  let script = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-n" || a === "--quiet" || a === "--silent") quiet = true;
    else if (a === "-e" || a === "--expression") {
      const x = args[++i];
      if (!x || !x.split(";").every((c) => SED_PRINT.test(c.trim()))) return false;
      script = true;
    } else if (a === "-E" || a === "-r") continue;
    else if (a.startsWith("-")) return false;
    else if (!script) {
      if (!a.split(";").every((c) => SED_PRINT.test(c.trim()))) return false;
      script = true;
    }
  }
  return quiet && script;
}

/** The kinds in a command line, each once. Anything that can't be taken apart safely is one "other". */
export function classesOf(line: string): CommandClass[] {
  const l = lexLine(line);
  if (!l || l.pieces.some((p) => p.words.some((w) => w.expands))) return ["other"];
  // A pipe into a shell runs whatever came down it.
  if (l.pieces.slice(1).some((p, i) => l.ops[i] === "|" && /^(sh|bash|zsh|fish|dash|ksh|python3?|node|ruby|perl)$/.test(p.words[0]!.text))) return ["other"];
  const out = new Set<CommandClass>();
  for (const p of l.pieces) out.add(classOfPiece(p.words.map((w) => w.text)));
  return [...out];
}

/** Whether somebody who may approve these kinds may approve this line: every part of it, not most. */
export function mayApprove(allowed: readonly CommandClass[], line: string): boolean {
  const set = new Set(allowed);
  return classesOf(line).every((c) => set.has(c));
}

/** The riskiest kind in a line, for saying in a sentence what a command is. */
const RISK: CommandClass[] = ["read", "checks", "build", "git", "install", "other", "publish", "deploy", "destructive"];
export function headlineClass(line: string): CommandClass {
  return classesOf(line).sort((a, b) => RISK.indexOf(b) - RISK.indexOf(a))[0] ?? "other";
}

/** A permitted list from whatever came in: known kinds only, each once. */
export function cleanClasses(raw: unknown): CommandClass[] {
  if (!Array.isArray(raw)) return [];
  return COMMAND_CLASSES.filter((c) => raw.includes(c));
}

/**
 * The riskiest kind among these commands that a person should look at before saying yes, if any. Needs you suggests "Don't" for
 * it, and every place that asks (the session's card, the toast, the Agents hub) makes "Don't" the main button for it, so the one
 * an Enter or a quick click lands on is the safer one (2026-11-04 QA).
 */
export function carefulClass(items: readonly string[]): CommandClass | undefined {
  const classes = new Set<CommandClass>(items.flatMap((c) => classesOf(c)));
  return (["destructive", "deploy", "publish", "install", "other"] as const).find((c) => classes.has(c));
}
