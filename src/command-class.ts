/**
 * What kind of command this is, so an owner can say which kinds a teammate may approve.
 *
 * "Editors can approve test runs but not deploys" needs a command to be one or the other. The rule that keeps it honest is
 * that a command is only as safe as its riskiest part and anything not recognised is "other": a line is split into its
 * pieces (`a && b | c; d`), each piece is classified on its own, and a person may approve the line only if they may approve
 * every piece. Command substitution, `eval`, `sh -c`, a download piped into a shell and redirection into files are never
 * waved through as something milder than they are.
 */

export const COMMAND_CLASSES = ["read", "checks", "build", "install", "git", "publish", "deploy", "destructive", "other"] as const;
export type CommandClass = (typeof COMMAND_CLASSES)[number];

export const CLASS_LABEL: Record<CommandClass, { label: string; hint: string; careful?: boolean }> = {
  read: { label: "Look around", hint: "ls, cat, grep, git log and diff: nothing changes" },
  checks: { label: "Tests and checks", hint: "npm test, pytest, lint, typecheck" },
  build: { label: "Builds", hint: "npm run build, cargo build, go build" },
  install: { label: "Installs", hint: "npm install, pip install: runs other people's code" },
  git: { label: "Git, on this machine", hint: "add, commit, checkout, pull, merge, stash" },
  publish: { label: "Publish", hint: "git push, opening a pull request, releases", careful: true },
  deploy: { label: "Deploy", hint: "deploy, kubectl, terraform, cloud CLIs, ssh", careful: true },
  destructive: { label: "Delete or overwrite", hint: "rm, git reset --hard, force push, dropping data", careful: true },
  other: { label: "Anything else", hint: "Commands this list doesn't recognise", careful: true },
};

/**
 * Split on the ways a shell chains commands. A piece that cannot be pulled apart safely makes the whole line "other".
 * Null when the line can't be split safely; one piece is one command.
 */
export function pieces(line: string): string[] | null {
  // Things that run something we cannot see, or write somewhere we have not looked.
  if (/\$\(|`|<\(|>\(|\beval\b|\bsource\b|<<|\bexec\b/.test(line)) return null;
  // Redirecting into a file writes it (output to /dev/null or another stream is fine).
  const noFd = line.replace(/\d*>&\d+/g, "").replace(/\d*>\s*\/dev\/null/g, "");
  if (/>/.test(noFd)) return null;
  // A carriage return ends a statement in PowerShell, which is the shell on a Windows machine without Git Bash.
  const parts = noFd.split(/&&|\|\||;|\||\r|\n|&(?!&)/).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

const strip = (piece: string): string[] => {
  // Leading environment assignments (CI=1 npm test) and a leading `cd dir`-style hop are not what the command is.
  const words = piece.split(/\s+/).filter(Boolean);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
  // `sudo`, `time`, `nice`, `env` wrap a command without changing what it is, except sudo, which is a risk in itself.
  while (words.length && /^(time|nice|env|command|exec)$/.test(words[0]!)) words.shift();
  return words;
};

const has = (w: string[], ...flags: string[]) => w.some((x) => flags.includes(x));

function classOfPiece(piece: string): CommandClass {
  const w = strip(piece);
  const [bin = "", a = "", b = ""] = w;
  if (!bin) return "other";
  if (bin === "sudo" || bin === "su" || bin === "doas") return "destructive";

  // Removing and overwriting.
  if (/^(rm|rmdir|shred|truncate|dd|mkfs|chmod|chown|chgrp|mv|ln)$/.test(bin)) return "destructive";
  if (/^(sed)$/.test(bin) && has(w, "-i", "--in-place")) return "destructive";
  if (/^(find)$/.test(bin) && has(w, "-delete", "-exec")) return "destructive";
  if (/^(drop|truncate)$/i.test(bin)) return "destructive";

  // Looking.
  if (/^(ls|cat|head|tail|wc|grep|rg|ag|fd|tree|pwd|echo|printf|which|whoami|date|stat|file|du|df|diff|cmp|sort|uniq|cut|tr|basename|dirname|realpath|true|false|test|\[|cd|pushd|popd|env|printenv|uname|id)$/.test(bin)) return bin === "find" ? "other" : "read";
  if (bin === "find") return "read";
  if (bin === "git") {
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
  if (pm) {
    if (/^(install|i|add|ci|update|upgrade|remove|rm|uninstall|link|dedupe|prune)$/.test(a)) return "install";
    if (a === "publish" || a === "deploy" || a === "login") return a === "publish" ? "deploy" : "other";
    if (/^(test|t|lint|typecheck|check|format|fmt)$/.test(a)) return "checks";
    if (a === "audit" || a === "outdated" || a === "ls" || a === "list" || a === "why" || a === "view" || a === "info") return "read";
    if (a === "run" || a === "run-script" || (bin === "yarn" && a)) {
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
    if (a === "--test" || (bin === "node" && has(w, "--test")) || (/^python3?$/.test(bin) && a === "-m" && /^(pytest|unittest)$/.test(b))) return "checks";
    return "other";
  }
  if (bin === "go") return /^(test|vet)$/.test(a) ? "checks" : a === "build" || a === "install" ? "build" : /^(get|mod)$/.test(a) ? "install" : /^(list|env|version|doc)$/.test(a) ? "read" : "other";
  if (bin === "cargo") return /^(test|clippy|check|fmt)$/.test(a) ? "checks" : /^(build|b|doc|bench)$/.test(a) ? "build" : /^(add|fetch|install|update|remove)$/.test(a) ? "install" : a === "publish" ? "deploy" : /^(tree|metadata|search)$/.test(a) ? "read" : "other";
  if (bin === "make" || bin === "just" || bin === "task") return /^(test|tests|check|lint|typecheck)$/.test(a) ? "checks" : /^(build|all|compile)$/.test(a) || !a ? "build" : /^(deploy|release|publish|push)/.test(a) ? "deploy" : "other";
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
  if (/^(curl|wget)$/.test(bin)) return has(w, "-X", "--request", "-d", "--data", "-F", "--form", "-T", "--upload-file", "-o", "-O", "--output") ? "other" : "read";
  return "other";
}

/** The kinds in a command line, each once. Anything that can't be taken apart safely is one "other". */
export function classesOf(line: string): CommandClass[] {
  const parts = pieces(line.trim());
  if (!parts) return ["other"];
  // A pipe into a shell runs whatever came down it.
  if (/\|\s*(sh|bash|zsh|fish|dash|ksh|python3?|node|ruby|perl)\b/.test(line)) return ["other"];
  const out = new Set<CommandClass>();
  for (const p of parts) out.add(classOfPiece(p));
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
