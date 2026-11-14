/**
 * What "Always allow" and "Allow for this task" let through beyond the command pressed (Fable's final probe of the allow rules,
 * 2026-11-11: a blocklist of riskier forms kept leaking, `$'--hard'`, `--upload-pa=`, `make --fil=`, `rg --pre`, env variables
 * by the dozen). Widening is an allowlist now, so whole classes close at once:
 *
 * - A pattern names a tool and what it does (`git diff`, `npm test`, `npm run build`, `cat`), and only those on the list below
 *   widen at all. Everything else is allowed exactly as pressed: make, curl, docker, git reset, git push, npm install, and the rest.
 * - Each word past the pattern is either a flag on that tool's own list (exactly, or an unambiguous start of one that is no start
 *   of a dangerous option) or a plain operand: a file, a branch, a package, never `~`, an absolute path, a `..`, or a secret.
 * - Words are read as a shell reads them (command-shape.ts): one the shell would change first (`$`, a backtick, a glob) is never a
 *   pattern's.
 * - Variables in front are an allowlist too (CI, NODE_ENV, …), with plain values; any other makes the piece exact-only.
 * - A line of several pieces is allowed when every piece is: by a pattern, by an exact entry, as a safe pipe tail (head, tail,
 *   wc, grep, sort, uniq, cat), or as a first `cd <folder> &&`.
 *
 * Arun's other priority is speed: the shapes coding agents run all day (tests, typechecks, git diff and log, cat and ls) stop
 * asking once one of them is allowed.
 */
import { classOfWords } from "./command-class.js";
import { lexLine, type Piece, type Word } from "./command-shape.js";
import type { SessionState } from "./session/projection.js";

/** The kinds of command a pattern may widen to: looking around, checks, builds and git on this machine. */
const WIDENS: readonly string[] = ["read", "checks", "build", "git"];

/** Variables in front of a command that change nothing about what runs, with plain values. */
const ENV_OK = /^(CI|NODE_ENV|FORCE_COLOR|NO_COLOR|DEBUG|TZ|LANG|LC_[A-Z]+|TERM|RUST_BACKTRACE|RUST_LOG|PYTHONUNBUFFERED)$/;
const PLAIN_VALUE = /^[\w.,:@%+/-]*$/;

/** Long options never let through by an abbreviation, whatever tool: each starts something that writes, runs or reaches out. */
const DANGER = ["--output", "--hard", "--force", "--delete", "--exec", "--exec-batch", "--upload-pack", "--receive-pack", "--config", "--pre", "--pre-glob", "--ext-diff", "--no-index", "--template", "--script-shell", "--node-options", "--prefix", "--manifest-path", "--rootdir", "--toolexec", "--file", "--makefile", "--directory", "--userconfig", "--globalconfig", "--amend", "--fix", "--require", "--import", "--loader", "--env-file", "--inspect", "--inspect-brk"];

/**
 * A path segment that is a secret, wherever it is, in any case: a Mac's disk doesn't tell .ENV from .env, or .GIT from .git (Fable's
 * probe of the allowlist, 2026-11-11).
 */
const SECRET =
  /^(?:\.env.*|\.dev\.vars|.+\.tfvars(\.json)?|terraform\.tfstate.*|secrets?(\.\w+)?|tokens?\.json|\.secrets|credentials.*|service-account.*\.json|\.pgpass|\.htpasswd|\.vault-token|kubeconfig|\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.docker|\.kube|\.zsh_history|\.bash_history|\.git-credentials|\.git|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|.*\.(pem|key|p12|pfx|keystore|jks))$|\.env$|\.env\./i;
/** Names a glob of files must not take in: if it matches one of these, it could reach a secret. */
const SECRET_SAMPLES = [".env", ".env.local", ".envrc", ".git", ".ssh", ".aws", ".npmrc", ".netrc", ".pgpass", ".htpasswd", ".vault-token", "id_rsa", "id_ed25519", "x.pem", "x.key", "credentials", "credentials.json", "secrets.yml", "secrets", "terraform.tfstate", "prod.env", "kubeconfig"];
function globMayHitSecret(glob: string): boolean {
  const last = glob.split("/").filter(Boolean).at(-1) ?? glob;
  const re = new RegExp(`^${last.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  return glob.split("/").some((seg) => SECRET.test(seg)) || SECRET_SAMPLES.some((n) => re.test(n));
}

/**
 * A path out of the project or to a secret anywhere in a word: it is divided at `:`, `=` and `,` as well as `/` (HEAD:.env,
 * --reporter-option=output=.git/config, k=/etc/passwd, a,.env), and every part is checked for an absolute path, a `~`, a `..`
 * and a secret (Fable's confirm pass, 2026-11-11).
 */
const reachesOut = (x: string) => x.split(/[:=,]/).some((part) => part.startsWith("/") || part.startsWith("~") || part.split("/").some((seg) => seg === ".." || SECRET.test(seg)));

/**
 * A plain operand: a file, folder, branch, commit, package or test name inside the project. Not a flag, not `~`, not an absolute
 * path, not a `..` (a `...` package pattern or an `a..b` range is fine), not a secret.
 */
export function plainOperand(x: string): boolean {
  if (!/^[\w@%+=:,./-][\w@%+=:,./~^-]*$/.test(x) || x.startsWith("-") || x.startsWith("/")) return false;
  // zsh's =cmd is a program's path; a ~ after = or : is the home folder in bash too; @file is a response file (tsc @args.txt),
  // never a scoped package (@scope/pkg).
  if (x.startsWith("=") || /(^|[=:])~/.test(x) || (x.startsWith("@") && !/^@[\w.-]+\/[\w./-]+$/.test(x))) return false;
  return !reachesOut(x);
}

/** Any one word the shell hands over unchanged (a search pattern, a message, a format), not a path outside or to a secret. */
const anyArg = (x: string): boolean => !(x.startsWith("-") || x.startsWith("~") || x.startsWith("/") || /(^|[=:])~/.test(x) || reachesOut(x));

/**
 * What a flag takes: nothing; a value that must be there (plain: an operand; any: a word that reaches no secret, no outside;
 * number); one only written joined (opt…: --pretty or --pretty=oneline, never the next word); a name only (reporter: built in, no
 * path); or what is left out (excl: --exclude-dir=.git names a secret to skip it). A value never starts with "-": that is the next
 * flag, which a value would otherwise swallow (git diff -U --no-index).
 */
type Value = "none" | "plain" | "any" | "number" | "optPlain" | "optAny" | "reporter" | "excl" | "text" | "shard" | "glob" | "chars";

interface Rule {
  /** The flags it takes, by name: whether each takes a value, and what kind. Short ones may run together (-la), values last. */
  flags: Record<string, Value>;
  /** `-5`, `-20`: a count (git log, head, tail). */
  counts?: boolean;
  /** What a word that isn't a flag may be. */
  operands: "plain" | "none" | "names";
  /** The first operand is a search pattern, any word (grep, rg, fd). */
  patternFirst?: boolean;
  /** At most this many operands. */
  maxOperands?: number;
  /** After `--`: the rest goes to the tests or the program run, plain values only. */
  dashDash?: "args" | "paths" | "none" | "cargo";
  /** A check of the whole of what follows the tool, beyond the flags and operands. */
  check?: (args: string[]) => boolean;
  /** Instead of flags and operands: the whole of what follows the tool, judged at once (find). */
  custom?: (args: string[]) => boolean;
  /** Flags by their whole names only: never an abbreviation, never short ones run together (go's -pkgdir is no -p kgdir). */
  exactFlags?: boolean;
  /** An operand of its own shape, in place of the plain one (git stash show stash@{1}). */
  operandOk?: (x: string) => boolean;
}

const f = (names: string, v: Value = "none"): Record<string, Value> => Object.fromEntries(names.split(/\s+/).filter(Boolean).map((n) => [n, v]));

// ── git ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const GIT_READ_ARGS = "--numstat --shortstat --name-only --name-status --no-color --summary -p --patch --raw --no-renames --abbrev-commit";
const GIT: Record<string, Rule> = {
  status: { flags: { ...f("-s --short -b --branch -v --verbose --long --show-stash --ignored --no-renames --ahead-behind"), ...f("--porcelain --untracked-files -u", "optPlain") }, operands: "plain", dashDash: "paths" },
  diff: { flags: { ...f(`${GIT_READ_ARGS} --cached --staged -w --ignore-all-space --ignore-space-change --check --minimal --color-words -R`), ...f("-U --unified --word-diff --color --stat", "optPlain"), ...f("--diff-filter --stat-width", "plain") }, operands: "plain", dashDash: "paths" },
  log: { flags: { ...f(`${GIT_READ_ARGS} --oneline --graph --all --reverse --first-parent --no-merges --merges --follow --date-order --topo-order --left-right`), ...f("--decorate --stat --color", "optPlain"), ...f("-n --max-count --skip --since --until --after --before", "plain"), "--date": "optPlain", ...f("--format --pretty", "optAny"), ...f("--author --committer --grep -S -G", "any") }, counts: true, operands: "plain", dashDash: "paths" },
  show: { flags: { ...f(`${GIT_READ_ARGS} --oneline --no-patch -s`), ...f("--stat --color", "optPlain"), ...f("--format --pretty", "optAny") }, operands: "plain", dashDash: "paths" },
  blame: { flags: { ...f("-w -s -e -l -t --porcelain --line-porcelain"), "-L": "any" }, operands: "plain", dashDash: "paths" },
  // Listing only: -a, -r, -v and the like. Making, moving or deleting a branch asks.
  branch: { flags: { ...f("-a --all -r --remotes -v -vv --verbose --list --show-current --no-color --color"), ...f("--contains --merged --no-merged --sort", "plain"), "--format": "any" }, operands: "none" },
  // A remote by name: never a path (git fetch sub/dir fetches another repository on this disk) or a refspec.
  fetch: { flags: { ...f("--all --prune -p --tags -t --no-tags -q --quiet -v --verbose --unshallow --prune-tags"), ...f("--depth --deepen", "number") }, operands: "names", operandOk: (x) => nameOk(x) && !x.includes("/") && !x.startsWith("."), maxOperands: 2 },
  add: { flags: f("-A --all -u --update -N --intent-to-add -v --verbose -n --dry-run"), operands: "plain", dashDash: "paths" },
  // -m, -a and -s; never --amend, -F, -C, --no-verify.
  commit: { flags: { ...f("-a --all -s --signoff -q --quiet -v --verbose"), ...f("-m --message", "text") }, operands: "none", dashDash: "paths" },
  // A new branch only: never a file, never ".".
  checkout: { flags: { ...f("-q --quiet --track --no-track"), "-b": "plain" }, operands: "names", maxOperands: 1, check: (a) => a.includes("-b") && !a.includes("--") },
  switch: { flags: { ...f("-q --quiet --track --no-track"), ...f("-c --create", "plain") }, operands: "names", maxOperands: 1, check: (a) => !a.includes("--") },
};

/** A revision by reflog or upstream (@{u}, main@{1}, @{u}..HEAD): not a glob, the braces git's own. */
const atRev = (x: string) => /^[\w./-]*@\{(u|upstream|push|-?\d+)\}(\.\.\.?[\w./~^-]*)?$/.test(x);
for (const k of ["diff", "log", "show"]) GIT[k]!.operandOk = (x) => plainOperand(x) || atRev(x);

/** A branch or remote name: a plain operand that is no path ("." or a folder) and has no refspec in it. */
const nameOk = (x: string) => plainOperand(x) && x !== "." && !x.startsWith("./") && !x.endsWith("/") && !x.includes(":") && !x.startsWith("+");

// git stash: push (bare, or `push`), list and show; never pop, apply, drop or clear.
const STASH: Record<string, Rule> = {
  push: { flags: { ...f("-u --include-untracked -k --keep-index -q --quiet"), ...f("-m --message", "any") }, operands: "none", dashDash: "paths" },
  list: { flags: f("--oneline --stat"), operands: "none" },
  show: { flags: f("-p --patch --stat --name-only --name-status"), operands: "plain", operandOk: (x) => /^stash@\{\d+\}$/.test(x), maxOperands: 1 },
};

// ── package managers ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A script by name that checks or builds, the only ones yarn, pnpm and bun run without `run`. */
const SCRIPT_CHECKS_BUILDS = /^(test|tests|lint|typecheck|type-check|check|build|format:check|fmt:check)(:[\w:-]+)?$/;
/**
 * What may be passed on to a script or the tests it runs: by yarn, pnpm and bun after the script's name, and by npm (and yarn, pnpm
 * and bun) after `--`. An allowlist of switches the common runners take and nothing that writes, loads or reaches out (Fable's
 * confirm pass, 2026-11-11: a list of names to refuse let `--tsBuildInfoFile package.json` and `--metafile=package.json` through).
 * Any other flag makes the line exact-only; plain operands, test files and folders in the project, are fine.
 */
const PASSED_FLAGS: Record<string, Value> = {
  ...f("--run --bail --verbose --runInBand -i --coverage --ci --silent --fix --passWithNoTests --no-cache --color --no-color --watch=false --watchAll=false --update -u -x"),
  ...f("--grep -t --testNamePattern", "any"),
  "--reporter": "reporter",
  "--shard": "shard",
  "--project": "plain",
  "--max-warnings": "number",
};
const PASSED: Rule = { flags: PASSED_FLAGS, operands: "plain", exactFlags: true };
const npmScript: Rule = { flags: { ...f("-s --silent --if-present --workspaces -ws"), ...f("-w --workspace", "plain") }, operands: "none", dashDash: "args", exactFlags: true };
const passScript = (pm: string): Rule => ({ flags: { ...PASSED_FLAGS, ...f("-s --silent --if-present"), ...(pm === "pnpm" ? { ...f("--parallel"), ...f("--filter -F", "plain") } : {}) }, operands: "plain", dashDash: "args", exactFlags: true });

// ── the rest ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const GO: Rule = { flags: { ...f("-v -race -cover -short -benchmem -failfast -json -trimpath -a"), ...f("-count -timeout -tags -p -cpu -covermode", "plain"), ...f("-run -bench -skip", "any") }, operands: "plain", exactFlags: true };
/** What cargo passes on to the test binary after `--`: these switches and filter words alone. */
const CARGO_PASSED: Rule = { flags: { ...f("--nocapture --ignored --exact"), "--test-threads": "number" }, operands: "plain", exactFlags: true };
const CARGO: Rule = { flags: { ...f("--release --all --workspace --all-targets --all-features --no-default-features --lib --bins --tests --benches --examples -q --quiet -v --verbose --locked --offline --frozen --no-fail-fast --no-deps"), ...f("-p --package --features -F --bin --test --example -j --jobs --target --profile", "plain") }, operands: "plain", dashDash: "cargo" };
const PYTEST: Rule = { flags: { ...f("-q -v -vv -vvv -x -s -l --lf --ff --co --collect-only --no-header --disable-warnings --exitfirst --last-failed --failed-first --sw --stepwise"), ...f("-k -m", "any"), ...f("--tb --maxfail -n --durations", "plain"), "-r": "chars" }, operands: "plain" };
const TSC: Rule = { flags: { ...f("--noEmit --pretty --incremental -b --build --listFilesOnly --strict"), ...f("-p --project", "plain") }, operands: "plain" };
const ESLINT: Rule = { flags: { ...f("--cache --quiet --color --no-color"), ...f("--max-warnings --ext", "plain") }, operands: "plain" };
const VITEST: Rule = { check: (a) => !a.some((x) => /^(watch|dev|serve|ui)$/.test(x)), flags: { ...f("--run --coverage --silent --bail --passWithNoTests --no-watch --watch=false -u --update"), ...f("-t --testNamePattern", "any"), ...f("--project --shard", "plain"), "--reporter": "reporter" }, operands: "plain" };
const JEST: Rule = { flags: { ...f("--ci --coverage --silent --runInBand -i --passWithNoTests --verbose --watchAll=false -u --updateSnapshot"), ...f("-t --testNamePattern", "any"), ...f("--maxWorkers --shard", "plain") }, operands: "plain" };
const PLAYWRIGHT: Rule = { flags: { ...f("--headed --list -x --quiet"), ...f("--grep -g --grep-invert", "any"), ...f("--project --workers -j --retries --shard", "plain"), "--reporter": "reporter" }, operands: "plain" };
const NODE_TEST: Rule = { flags: { ...f("--test-only"), "--test-name-pattern": "any", "--test-reporter": "reporter" }, operands: "plain" };

// Read tools. Their operands are files in the project; grep, rg and fd take a search pattern first.
const READ: Record<string, Rule> = {
  ls: { flags: { ...f("-l -a -A -h -R -t -r -S -1 -F -d -G -p --all --color"), "--color=auto": "none" }, operands: "plain" },
  cat: { flags: f("-n -b"), operands: "plain" },
  head: { flags: f("-n -c", "number"), counts: true, operands: "plain" },
  tail: { flags: f("-n -c", "number"), counts: true, operands: "plain" },
  wc: { flags: f("-l -w -c -m"), operands: "plain" },
  grep: { flags: { ...f("-r -R -n -i -I -l -v -w -c -H -h -o -E -F -x -s -q -L --color"), ...f("-A -B -C -m", "number"), "-e": "any", "--include": "glob", ...f("--exclude --exclude-dir", "excl") }, operands: "plain", patternFirst: true, dashDash: "paths" },
  rg: { flags: { ...f("-i -n -w -l -c -S -F -u -H -N -v -s -L --hidden --files --count --json --no-ignore --no-heading --color=never"), ...f("-A -B -C -m --max-count", "number"), ...f("-t -T --type --type-not", "plain"), "-e": "any", ...f("-g --glob", "glob") }, operands: "plain", patternFirst: true, dashDash: "paths" },
  sort: { flags: { ...f("-u -n -r -f -b -d -i -h -V"), ...f("-k -t", "any") }, operands: "plain" },
  uniq: { flags: f("-c -u -d -i"), operands: "plain", maxOperands: 1 },
  fd: { flags: { ...f("-H --hidden -I --no-ignore -a -0 -L"), ...f("-e --extension -t --type -d --max-depth", "plain"), ...f("-E --exclude", "any") }, operands: "plain", patternFirst: true },
};

/** find: start folders, then tests that only look: never -exec, -execdir, -ok, -delete or -fprint. */
const FIND_TESTS: Record<string, Value> = { ...f("-name -iname -path -ipath", "glob"), ...f("-regex -iregex", "any"), ...f("-type -maxdepth -mindepth -mtime -mmin -newer -size -perm -user", "plain"), ...f("-print -print0 -empty -o -a -and -or -prune -follow -L -H") };
function findOk(args: string[]): boolean {
  let i = 0;
  while (i < args.length && !args[i]!.startsWith("-") && args[i] !== "!") {
    if (!plainOperand(args[i]!)) return false;
    i++;
  }
  // What follows -not or ! is left out: -not -path "./.git/*" names .git to skip it.
  let not = false;
  for (; i < args.length; i++) {
    const x = args[i]!;
    if (x === "!" || x === "-not") {
      not = true;
      continue;
    }
    const v = FIND_TESTS[x];
    if (v === undefined) return false;
    if (v !== "none") {
      const val = args[++i];
      if (val === undefined || !valueOk(not && (v === "any" || v === "glob") ? "excl" : v, val)) return false;
    }
    not = false;
  }
  return true;
}

/** Pipe tails: what may follow a `|`, reading what came down it and writing nothing. */
const TAILS: Record<string, Rule> = {
  head: { ...READ.head!, operands: "none" },
  tail: { ...READ.tail!, operands: "none" },
  wc: { ...READ.wc!, operands: "none" },
  // Reading the pipe only: never -r or -R, which read the folder instead.
  grep: { ...READ.grep!, flags: Object.fromEntries(Object.entries(READ.grep!.flags).filter(([k]) => !/^(-r|-R|--recursive)$/.test(k))), operands: "none" },
  sort: { ...READ.sort!, operands: "none" },
  uniq: { ...READ.uniq!, operands: "none" },
  cat: { flags: {}, operands: "none" },
  // jq with a plain filter: no files read (-f, --rawfile, --slurpfile, a file operand), no input, env or module of its own.
  jq: { flags: f("-r -c -e -S -j -M -C --raw-output --compact-output --sort-keys --exit-status --tab"), operands: "none", patternFirst: true, check: (a) => a.every((x) => !/\b(inputs?|env|input_filename|import|include|debug|stderr|halt_error|getpath|splits?|\$ENV|\$__loc__|\$__prog_args)\b|\$__loc__|\$ENV/.test(x)) },
};

function valueOk(v: Value, x: string): boolean {
  if (x.startsWith("-")) return false;
  switch (v) {
    case "number":
      return /^\+?\d+$/.test(x);
    case "plain":
    case "optPlain":
      return plainOperand(x);
    case "any":
    case "optAny":
      return anyArg(x);
    // A commit message: words, never read as a path.
    case "text":
      return true;
    // A glob of files to look in: none that could take in a secret (rg -g '.e*', find -name '.en?'); one starting "!" leaves out.
    case "glob":
      return x.startsWith("!") || (anyArg(x) && !globMayHitSecret(x));
    // pytest -r: which outcomes to sum up, letters only.
    case "chars":
      return /^[fEsxXpPaAwN]+$/.test(x);
    case "shard":
      return /^\d+\/\d+$/.test(x);
    case "reporter":
      return /^[a-z][\w-]*$/.test(x);
    case "excl":
      return !x.startsWith("/") && !x.startsWith("~") && !x.split("/").includes("..");
    default:
      return false;
  }
}

/** A flag's name as the rule lists it: exactly, or the one listed long option it is an unambiguous start of (never a dangerous one's). */
function flagName(rule: Rule, name: string): string | null {
  if (name in rule.flags && !name.includes("=")) return name;
  if (!name.startsWith("--") || name.length < 4) return null;
  if (DANGER.some((d) => d.startsWith(name))) return null;
  // Never a flag listed with its value ("--watch=false"): "--watch" is no start of that one.
  const hits = Object.keys(rule.flags).filter((n) => n.startsWith("--") && !n.includes("=") && n.startsWith(name));
  return hits.length === 1 ? hits[0]! : null;
}

/** Whether every word after a tool's name fits its rule. */
export function argsFit(rule: Rule, args: string[]): boolean {
  if (rule.custom) return rule.custom(args);
  if (rule.check && !rule.check(args)) return false;
  let operands = 0;
  let pattern = !!rule.patternFirst;
  for (let i = 0; i < args.length; i++) {
    const x = args[i]!;
    if (x === "--") {
      const rest = args.slice(i + 1);
      if (rule.dashDash === "args") return passedOn(rest);
      if (rule.dashDash === "cargo") return argsFit(CARGO_PASSED, rest);
      if (rule.dashDash === "paths") return rest.every(plainOperand);
      return false;
    }
    if (rule.counts && /^-\d+$/.test(x)) continue;
    if (x.startsWith("-") && x.length > 1) {
      // A flag listed by its full name (--stat, -run, -vv, --watch=false), or the one long option it is an unambiguous start of.
      const [name0, ...v] = x.split("=");
      const listedWhole = x in rule.flags && rule.flags[x] === "none";
      const key = listedWhole ? x : rule.exactFlags ? (name0! in rule.flags && !name0!.includes("=") ? name0! : null) : flagName(rule, name0!);
      if (key) {
        const kind = rule.flags[key]!;
        if (kind === "none") {
          if (v.length && !listedWhole) return false;
          continue;
        }
        // An optional value is only ever joined: the next word is never its value.
        if (kind === "optPlain" || kind === "optAny") {
          if (v.length && !valueOk(kind, v.join("="))) return false;
          continue;
        }
        const val = v.length ? v.join("=") : args[++i];
        if (val === undefined || !valueOk(kind, val)) return false;
        if (key === "-e") pattern = false;
        continue;
      }
      if (x.startsWith("--") || rule.exactFlags) return false;
      // Short flags run together (-la, -am "msg"); one that takes a value goes last, its value joined or next.
      const letters = x.slice(1);
      for (let k = 0; k < letters.length; k++) {
        const flag = `-${letters[k]}`;
        const kind = rule.flags[flag];
        if (kind === undefined) return false;
        if (kind === "none") continue;
        const joined = letters.slice(k + 1);
        if (kind === "optPlain" || kind === "optAny") {
          if (joined && !valueOk(kind, joined)) return false;
          break;
        }
        const val = joined || args[++i];
        if (val === undefined || !valueOk(kind, val)) return false;
        if (flag === "-e") pattern = false;
        break;
      }
      continue;
    }
    if (pattern) {
      // A search pattern or a filter, not a path: "/api/v1" is text to find.
      pattern = false;
      continue;
    }
    operands++;
    if (rule.operands === "none") return false;
    if (rule.operandOk ? !rule.operandOk(x) : rule.operands === "names" ? !nameOk(x) : !plainOperand(x)) return false;
    if (rule.maxOperands !== undefined && operands > rule.maxOperands) return false;
  }
  return true;
}

/**
 * What goes after `--` to a script or the tests run: the passed-on allowlist (PASSED), plain operands, and a lone `-` or another
 * `--`, which hand over nothing of their own.
 */
const passedOn = (rest: string[]): boolean => argsFit(PASSED, rest.filter((r) => r !== "--" && r !== "-"));

/** The same tool by another name: python3 is python, pnpx and bunx are npx. */
const canon = (w: string) => (w === "python3" ? "python" : w === "pnpx" || w === "bunx" ? "npx" : w);

/** Read-only git: an allowance for one of them is one for all (git status && git diff, git log | head). */
const GIT_READ = new Set(["status", "diff", "log", "show", "blame"]);

/**
 * The tool and what it does at the head of a piece's words, and its rule: `key` is what a pattern names ("git diff", "npm run
 * build", "cat"), `family` what it covers (the read-only git commands are one), `args` the rest. Null when it isn't on the list.
 */
export function shapeOf(words: readonly string[]): { key: string[]; family: string; rule: Rule; args: string[] } | null {
  const w = words.map((x, i) => (i === 0 ? canon(x) : x));
  const [bin = "", a = "", b = ""] = w;
  if (bin === "git") {
    // git --no-pager: the same command, its output not paged.
    if (a === "--no-pager") return shapeOf(["git", ...w.slice(2)]);
    // git -C <folder in the project> for the read-only ones: git -C packages/web diff.
    if (a === "-C" && plainOperand(b) && GIT_READ.has(w[3] ?? "")) return { key: ["git", w[3]!], family: "git:read", rule: GIT[w[3]!]!, args: w.slice(4) };
    if (GIT_READ.has(a)) return { key: ["git", a], family: "git:read", rule: GIT[a]!, args: w.slice(2) };
    if (a === "stash") {
      if (b in STASH) return { key: ["git", "stash", b], family: `git:stash:${b}`, rule: STASH[b]!, args: w.slice(3) };
      if (!b || b.startsWith("-")) return { key: ["git", "stash"], family: "git:stash:push", rule: STASH.push!, args: w.slice(2) };
      return null;
    }
    if (a in GIT) return { key: ["git", a], family: `git:${a}`, rule: GIT[a]!, args: w.slice(2) };
    return null;
  }
  if (bin === "npm" && (a === "test" || a === "t")) return { key: ["npm", "test"], family: "npm:test", rule: npmScript, args: w.slice(2) };
  if (/^(npm|pnpm|yarn|bun)$/.test(bin) && (a === "run" || a === "run-script") && /^[\w:.-]+$/.test(b)) return { key: [bin, "run", b], family: `${bin}:script:${b}`, rule: bin === "npm" ? npmScript : passScript(bin), args: w.slice(3) };
  if (/^(pnpm|yarn|bun)$/.test(bin)) {
    // pnpm -F web test, pnpm --filter web test, yarn workspace web lint: the script in that package, a flag of its own.
    let rest = w.slice(1);
    const pre: string[] = [];
    for (;;) {
      if (bin === "pnpm" && /^(-F|--filter)$/.test(rest[0] ?? "") && rest[1] && plainOperand(rest[1])) (pre.push(rest[0]!, rest[1]), (rest = rest.slice(2)));
      // -r before the script is pnpm's own (every package); after it, it would be the script's (mocha's -r is --require).
      else if (bin === "pnpm" && /^(-r|--recursive)$/.test(rest[0] ?? "")) rest = rest.slice(1);
      else break;
    }
    if (bin === "yarn" && rest[0] === "workspace" && rest[1] && plainOperand(rest[1])) rest = rest.slice(2);
    const [s = "", ...more] = rest;
    if (s === "run" && /^[\w:.-]+$/.test(more[0] ?? "")) return { key: [bin, "run", more[0]!], family: `${bin}:script:${more[0]}`, rule: passScript(bin), args: [...pre, ...more.slice(1)] };
    if (SCRIPT_CHECKS_BUILDS.test(s)) return { key: [bin, s], family: `${bin}:script:${s}`, rule: passScript(bin), args: [...pre, ...more] };
    return null;
  }
  if (bin === "go" && /^(test|vet|build)$/.test(a)) return { key: ["go", a], family: `go:${a}`, rule: GO, args: w.slice(2) };
  if (bin === "cargo" && /^(test|check|build|clippy)$/.test(a)) return { key: ["cargo", a], family: `cargo:${a}`, rule: CARGO, args: w.slice(2) };
  if (bin === "pytest" || bin === "py.test") return { key: [bin], family: "pytest", rule: PYTEST, args: w.slice(1) };
  if (bin === "python" && a === "-m" && b === "pytest") return { key: ["python", "-m", "pytest"], family: "pytest", rule: PYTEST, args: w.slice(3) };
  const tool = bin === "npx" ? a : bin;
  const at = bin === "npx" ? 2 : 1;
  const key = w.slice(0, at);
  if (tool === "tsc") return { key, family: "tsc", rule: TSC, args: w.slice(at) };
  if (tool === "eslint") return { key, family: "eslint", rule: ESLINT, args: w.slice(at) };
  if (tool === "vitest") return { key, family: "vitest", rule: VITEST, args: w.slice(at) };
  if (tool === "jest") return { key, family: "jest", rule: JEST, args: w.slice(at) };
  if (tool === "playwright" && w[at] === "test") return { key: [...key, "test"], family: "playwright", rule: PLAYWRIGHT, args: w.slice(at + 1) };
  if ((bin === "node" || bin === "tsx") && a === "--test") return { key: [bin, "--test"], family: `${bin}:test`, rule: NODE_TEST, args: w.slice(2) };
  if (bin === "find") return { key: ["find"], family: "find", rule: { flags: {}, operands: "plain", custom: findOk }, args: w.slice(1) };
  if (bin in READ) return { key: [bin], family: bin, rule: READ[bin]!, args: w.slice(1) };
  return null;
}

/** Variables in front of a piece's words, and the words after them; `ok` when every variable is on the list with a plain value. */
function envSplit(words: readonly Word[]): { ok: boolean; rest: Word[] } {
  let i = 0;
  let ok = true;
  for (; i < words.length - 1; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(words[i]!.text);
    if (!m) break;
    if (!ENV_OK.test(m[1]!) || !PLAIN_VALUE.test(m[2]!) || words[i]!.expands || words[i]!.glob) ok = false;
  }
  return { ok, rest: words.slice(i) };
}

const sameWords = (a: readonly Word[], b: readonly Word[]) => a.length === b.length && a.every((w, i) => w.text === b[i]!.text && w.expands === b[i]!.expands && w.glob === b[i]!.glob);

/** A pattern entry's words ("git diff*" → git, diff), or null for one that isn't a pattern or can't be read. */
function patternWords(entry: string): string[] | null {
  if (!entry.endsWith("*")) return null;
  const words = lexLine(entry.slice(0, -1))?.pieces;
  return words && words.length === 1 ? words[0]!.words.map((w) => w.text) : null;
}

/** Whether a pattern's words cover a piece's: the same tool and what it does (or its family), its rule fitting the rest. */
function patternFits(entry: string[], words: string[]): boolean {
  const mine = shapeOf(words);
  const theirs = shapeOf(entry);
  if (!mine || !theirs) return false;
  // The pattern names at least what the tool does (an old "git*" or "npm run*" widens nothing).
  if (entry.length < theirs.key.length) return false;
  let same = theirs.family === mine.family;
  // An entry ending in punctuation ("npm run test:*") covers the scripts it starts.
  const last = entry.at(-1)!;
  if (!same && entry.length === theirs.key.length && /[^\w]$/.test(last) && mine.key.length === theirs.key.length && mine.key.slice(0, -1).join(" ") === theirs.key.slice(0, -1).join(" ") && mine.key.at(-1)!.startsWith(last)) same = true;
  if (!same) return false;
  // An old pattern naming more than the tool ("cat package.json*", "git status --short*"): read tools and read-only git go by their
  // rule alone; any other starts the same way.
  const readTool = mine.key.length === 1 && (mine.key[0]! in READ || mine.key[0] === "find");
  if (entry.length > theirs.key.length && !readTool && mine.family !== "git:read") {
    const extra = entry.slice(theirs.key.length);
    if (!extra.every((x, i) => x === mine.args[i])) return false;
  }
  // Its kind read from what it does, a package's filter put after the script (pnpm -F web test is pnpm test -F web).
  if (!WIDENS.includes(classOfWords([...mine.key, ...mine.args]))) return false;
  return argsFit(mine.rule, mine.args);
}

/** A first piece `cd <folder>` followed by `&&`: into a folder of the project. */
const cdOk = (p: Piece) => p.words.length === 2 && p.words[0]!.text === "cd" && !p.words[1]!.expands && !p.words[1]!.glob && plainOperand(p.words[1]!.text);

/** A pipe tail: reading what came down the pipe, writing nothing. */
function tailOk(p: Piece): boolean {
  if (p.words.some((w) => w.expands || w.glob)) return false;
  const [bin = "", ...args] = p.words.map((w) => w.text);
  const rule = TAILS[bin];
  return !!rule && argsFit(rule, args);
}

/**
 * Whether a command is let through by these entries: exactly as one was pressed (as written, or as the shell reads it), or every
 * piece of it by a pattern, an exact entry, a safe pipe tail or a first `cd`.
 */
export function entriesAllow(entries: readonly string[], command: string): boolean {
  const c = command.trim();
  if (entries.some((e) => e.trim() === c)) return true;
  const line = lexLine(c);
  if (!line) return false;
  const exact = entries.filter((e) => !e.endsWith("*")).map((e) => lexLine(e)).filter((l): l is NonNullable<typeof l> => !!l);
  // The same line as an exact entry, as the shell reads both (spacing aside).
  if (exact.some((e) => e.pieces.length === line.pieces.length && e.ops.every((o, i) => o === line.ops[i]) && e.pieces.every((p, i) => sameWords(p.words, line.pieces[i]!.words)))) return true;
  // An exact entry is that whole line: never a piece of another, a pipe's sink or a chain's link (Fable's probe of the allowlist,
  // 2026-11-11: an exact `rm -rf tmp` let `cd src && rm -rf tmp` through). Only patterns and safe pipe tails combine.
  const patterns = entries.map(patternWords).filter((p): p is string[] => !!p);
  return line.pieces.every((p, i) => {
    if (i > 0 && line.ops[i - 1] === "|" && tailOk(p)) return true;
    if (i === 0 && line.ops[0] === "&&" && line.pieces.length > 1 && cdOk(p)) return true;
    const { ok, rest } = envSplit(p.words);
    if (!ok || rest.some((w) => w.expands || w.glob)) return false;
    const words = rest.map((w) => w.text);
    return patterns.some((e) => patternFits(e, words));
  });
}

/**
 * What one press of "Always allow" adds: the pattern for the command's tool and what it does ("git diff*", "npm run build*",
 * "cat*") where it is on the list and the command pressed fits its rule, else exactly the command, so it is still allowed as
 * pressed. Never a pattern for a line of several pieces, a word the shell changes, or a variable not on the list.
 */
export function entryFor(command: string): string {
  const c = command.trim();
  const line = lexLine(c);
  if (!line || line.pieces.length !== 1) return c;
  const { ok, rest } = envSplit(line.pieces[0]!.words);
  if (!ok || rest.some((w) => w.expands || w.glob)) return c;
  const words = rest.map((w) => w.text);
  const shape = shapeOf(words);
  if (!shape || !WIDENS.includes(classOfWords([...shape.key, ...shape.args])) || !argsFit(shape.rule, shape.args)) return c;
  return `${shape.key.join(" ")}*`;
}

// Kept apart from session/projection.ts, which every first screen loads: these load with the session screen and the server.
/**
 * Allowed in advance: exactly as an entry was pressed, or by a pattern ("git diff*", "npm test*"), each piece of the line on its own
 * (command-allow.ts). A pattern widens only along an allowlist of tools, what they do and their flags, with words read as a shell
 * reads them, so a riskier form of an allowed command, however it is written, is never a pattern's (Fable's final probe of the
 * allow rules, 2026-11-11). The session's list, and what was let through for this lane's task.
 */
export const allowedCommand = (s: SessionState, command: string, lane?: string): boolean =>
  entriesAllow([...(s.options.allow ?? []), ...(lane ? (s.taskAllow?.[lane] ?? []).map((c) => (c.endsWith("*") ? c : entryFor(c))) : [])], command);
/**
 * The pattern offered for a command: its tool and what it does ("npm test*", "git status*", "ls*"), or, for a command off the
 * allowlist, its first two words, said but never widening (command-allow.ts).
 */
export const allowPrefix = (command: string): string => {
  const e = entryFor(command);
  return e.endsWith("*") ? e : `${command.trim().split(/\s+/).slice(0, 2).join(" ")}*`;
};

/**
 * What one press of "Always allow" adds for a command: the pattern for its tool and what it does where it is on the allowlist
 * (allow "npm test" and "npm test -- --watch" is allowed too), else exactly itself, so "rm -rf build" never quietly becomes
 * "rm -rf" anything and a line of several commands is allowed as pressed (command-allow.ts entryFor).
 */
export const alwaysAllowEntry = (command: string): string => entryFor(command);

