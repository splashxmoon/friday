/**
 * Turning command output back into places in the code.
 *
 * A failing build says what is wrong and where, and then that sentence sits in
 * a scrollback until somebody retypes the path into an editor. These are the
 * shapes the tools people actually run print their errors in, so the panel can
 * offer the file instead of the sentence.
 *
 * Deliberately a few patterns and not a parser per tool: the formats below
 * cover tsc, eslint, most compilers, python and node stack traces, and
 * anything unrecognised stays text rather than being guessed at.
 */

export interface Problem {
  path: string;
  line: number;
  column?: number;
  severity: "error" | "warning";
  message: string;
}

/** `src/a.ts(12,5): error TS2322: …` — tsc, and the compilers that copy it. */
const TSC = /^\s*(\S.*?)\((\d+),(\d+)\)\s*:\s*(error|warning)\b[^:]*:\s*(.+)$/;
/** `src/a.ts:12:5: error: …` — eslint, clang, go, rust and most of unix. */
const COLON = /^\s*(\S.*?):(\d+):(\d+):\s*(error|warning)\b[^:]*:\s*(.+)$/;
/** `  File "app.py", line 12` — python, whose message is on the line after. */
const PYTHON = /^\s*File "(.+?)", line (\d+)/;
/** `    at fn (/repo/src/a.ts:12:5)` — a node stack frame. */
const NODE = /^\s*at .*?\(?([^\s()]+):(\d+):(\d+)\)?$/;
/** eslint prints the file once, then indented `12:5  error  …` rows under it. */
const ESLINT_HEAD = /^(?:\/|[A-Za-z]:[\\/]|\.{0,2}[\\/])?\S+\.\w+$/;
const ESLINT_ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}\S+)?$/;

/** Anything that isn't a path in the folder: node internals, npm's own noise. */
const NOT_OURS = /^(node:|internal\/|<anonymous>|\[|npm |eval )/;

/**
 * What went wrong, in the order it was printed, without repeats.
 *
 * A build prints the same error from several angles — the compiler's line, a
 * summary, then a stack frame through it — and three rows for one mistake is
 * how a problems list becomes something people stop reading.
 */
export function problemsIn(output: string, base = ""): Problem[] {
  const found: Problem[] = [];
  const seen = new Set<string>();
  const lines = output.split(/\r?\n/);
  let eslintFile = "";

  const add = (path: string, line: number, column: number | undefined, severity: Problem["severity"], message: string) => {
    const clean = tidy(path, base);
    if (!clean || NOT_OURS.test(path.trim())) return;
    const key = `${clean}:${line}:${message.trim()}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ path: clean, line, ...(column ? { column } : {}), severity, message: message.trim() });
  };

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? "";
    let m = TSC.exec(text) ?? COLON.exec(text);
    if (m) {
      add(m[1]!, Number(m[2]), Number(m[3]), m[4] === "warning" ? "warning" : "error", m[5]!);
      continue;
    }
    m = PYTHON.exec(text);
    if (m) {
      // Python's own message lands a line or two later, after the source line.
      const after = lines.slice(i + 1, i + 4).find((l) => /^\w*(Error|Exception|Warning)\b/.test(l.trim()));
      add(m[1]!, Number(m[2]), undefined, "error", after?.trim() ?? "raised here");
      continue;
    }
    if (ESLINT_HEAD.test(text.trim())) {
      eslintFile = text.trim();
      continue;
    }
    m = eslintFile ? ESLINT_ROW.exec(text) : null;
    if (m) {
      add(eslintFile, Number(m[1]), Number(m[2]), m[3] === "warning" ? "warning" : "error", m[4]!);
      continue;
    }
    m = NODE.exec(text);
    // Only the first frame: the rest of a stack is the path it took, not the fault.
    if (m && found.length === 0) add(m[1]!, Number(m[2]), Number(m[3]), "error", "threw here");
  }
  return found;
}

/** A path as the tree knows it: relative to the folder, forward slashes, no `./`. */
function tidy(raw: string, base: string): string {
  let p = raw.trim().replace(/\\/g, "/");
  const root = base.replace(/\\/g, "/").replace(/\/$/, "");
  if (root && p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) p = p.slice(root.length + 1);
  p = p.replace(/^\.\//, "");
  // An absolute path that isn't under the folder belongs to something else.
  if (/^([A-Za-z]:)?\//.test(p)) return "";
  return p;
}

export interface Script {
  name: string;
  command: string;
  /** What runs it, said the way a person would type it. */
  run: string;
}

/**
 * What this project can be asked to do.
 *
 * Read from the files themselves rather than guessed at, and only the handful
 * a person actually runs — a package with forty scripts is a list nobody
 * scans, and the ones worth a button are always the same few names.
 */
const WORTH_A_BUTTON = ["dev", "start", "build", "test", "lint", "typecheck", "check", "format", "e2e"];

export function scriptsIn(files: { path: string; text: string }[]): Script[] {
  const out: Script[] = [];
  for (const f of files) {
    const name = f.path.split("/").pop() ?? "";
    if (name === "package.json") {
      const scripts = safeJson<{ scripts?: Record<string, string> }>(f.text)?.scripts ?? {};
      for (const key of Object.keys(scripts)) {
        if (!WORTH_A_BUTTON.some((w) => key === w || key.startsWith(`${w}:`))) continue;
        out.push({ name: key, command: scripts[key]!, run: `npm run ${key}` });
      }
    }
    if (name === "Makefile") {
      for (const m of f.text.matchAll(/^([a-zA-Z][\w-]*):(?!=)/gm)) out.push({ name: m[1]!, command: `make ${m[1]}`, run: `make ${m[1]}` });
    }
    if (name === "Cargo.toml") out.push({ name: "build", command: "cargo build", run: "cargo build" }, { name: "test", command: "cargo test", run: "cargo test" });
    if (name === "pyproject.toml") out.push({ name: "test", command: "pytest", run: "pytest" });
  }
  // `npm start` and `npm run start` are the same button; keep the first.
  const seen = new Set<string>();
  return out.filter((s) => !seen.has(s.run) && seen.add(s.run)).slice(0, 12);
}

function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
