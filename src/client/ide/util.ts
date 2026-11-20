/** Small pure helpers for Code: paths, fuzzy matching, line diffs and the outline's symbol scan. */

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** A shortcut as this computer writes it: "⌘⇧P" on a Mac, "Ctrl+Shift+P" elsewhere. Keys are given Mac-first: "mod+shift+p". */
export function kbd(combo: string): string {
  const parts = combo.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  const names: Record<string, [string, string]> = { mod: ["⌘", "Ctrl"], shift: ["⇧", "Shift"], alt: ["⌥", "Alt"], ctrl: ["⌃", "Ctrl"] };
  const shown = key.length === 1 ? key.toUpperCase() : key === "enter" ? "↵" : key === "tab" ? "Tab" : key.charAt(0).toUpperCase() + key.slice(1);
  // macOS writes modifiers in the order ⌃⌥⇧⌘, whatever order they were given in.
  const order = ["ctrl", "alt", "shift", "mod"];
  parts.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (IS_MAC) return parts.map((p) => names[p]?.[0] ?? p).join("") + shown;
  return [...parts.map((p) => names[p]?.[1] ?? p), shown].join("+");
}

export const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const dirName = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const joinRel = (a: string, b: string) => (a ? `${a}/${b}` : b);
export const extOf = (p: string) => {
  const n = baseName(p);
  const i = n.lastIndexOf(".");
  return i > 0 ? n.slice(i + 1).toLowerCase() : "";
};

/** Whether a root is a Windows path, to write the paths shown to the person in its own style. */
export const isWindowsRoot = (root: string) => /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith("\\\\");

/** A path inside the root as this computer's own path: backslashes under C:\. */
export function absPath(root: string, rel: string): string {
  if (!rel) return root;
  const win = isWindowsRoot(root);
  const base = root.replace(/[\\/]+$/, "");
  return win ? `${base}\\${rel.replace(/\//g, "\\")}` : `${base}/${rel}`;
}

/** An absolute path (from a terminal's error, say) as one relative to the root, or null when it lies outside. */
export function relativeTo(root: string, abs: string): string | null {
  const a = abs.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!a.startsWith("/") && !/^[a-zA-Z]:\//.test(a)) return a.replace(/^\.\//, "");
  const same = isWindowsRoot(root) ? a.toLowerCase().startsWith(r.toLowerCase() + "/") : a.startsWith(r + "/");
  return same ? a.slice(r.length + 1) : null;
}

export const rootName = (root: string) => root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || root;

// The fuzzy matcher (⌘P, Friday's one search) moved to fuzzy.ts; import it from ./fuzzy.js (not re-exported here: that would put it in the first load, which is at its budget).

// ── What changed between two texts, by line ───────────────────────────────────────────

export interface LineRange {
  /** 1-based, inclusive. */
  from: number;
  to: number;
}

/**
 * The lines of `next` that are not in `prev`: what an agent added or changed, as ranges to mark. Longest common subsequence
 * over lines, after trimming what both texts share at their ends; a pair of very large middles is marked as a single block
 * rather than spend seconds on it.
 */
export function changedLines(prev: string, next: string): LineRange[] {
  if (prev === next) return [];
  const a = prev.split("\n");
  const b = next.split("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const A = a.slice(s, ea);
  const B = b.slice(s, eb);
  if (!B.length) return [];
  const marked = new Array<boolean>(B.length).fill(true);
  if (A.length && A.length * B.length <= 4_000_000) {
    // dp[i][j]: length of the common run of A[i..] and B[j..], kept as one flat array.
    const w = B.length + 1;
    const dp = new Uint32Array((A.length + 1) * w);
    for (let i = A.length - 1; i >= 0; i--)
      for (let j = B.length - 1; j >= 0; j--) dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < A.length && j < B.length) {
      if (A[i] === B[j]) {
        marked[j] = false;
        i++;
        j++;
      } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
      else j++;
    }
  }
  const out: LineRange[] = [];
  for (let k = 0; k < B.length; k++) {
    if (!marked[k]) continue;
    const line = s + k + 1;
    const last = out[out.length - 1];
    if (last && last.to === line - 1) last.to = line;
    else out.push({ from: line, to: line });
  }
  return out;
}

// ── Outline ─────────────────────────────────────────────────────────────────────────

export interface Symbol {
  name: string;
  kind: "function" | "class" | "const" | "type" | "method" | "heading";
  /** 1-based. */
  line: number;
  depth: number;
}

type Rule = { re: RegExp; kind: Symbol["kind"] };
const JS: Rule[] = [
  { re: /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /^(\s*)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^(\s*)(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  { re: /^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, kind: "function" },
  { re: /^(\s*)(?:export\s+)?const\s+([A-Z][A-Z0-9_]+)\s*(?::[^=]+)?=/, kind: "const" },
];
const RULES: Record<string, Rule[]> = {
  ts: JS, tsx: JS, js: JS, jsx: JS, mjs: JS, cjs: JS,
  py: [
    { re: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" },
    { re: /^(\s*)class\s+([A-Za-z_]\w*)/, kind: "class" },
  ],
  go: [
    { re: /^()func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
    { re: /^()type\s+([A-Za-z_]\w*)/, kind: "type" },
    { re: /^()(?:const|var)\s+([A-Za-z_]\w*)\s*=/, kind: "const" },
  ],
  rs: [
    { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
    { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+([A-Za-z_]\w*)/, kind: "class" },
    { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:impl)(?:<[^>]*>)?\s+([A-Za-z_][\w:<>]*)/, kind: "class" },
    { re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Z_][A-Z0-9_]*)/, kind: "const" },
  ],
  md: [{ re: /^()#{1,6}\s+(.+?)\s*#*\s*$/, kind: "heading" }],
};

/** The functions, classes and constants of a file, found by line patterns: cheap, language by language, and wrong now and then. */
export function symbolsOf(path: string, text: string): Symbol[] {
  const rules = RULES[extOf(path)];
  if (!rules || text.length > 2_000_000) return [];
  const out: Symbol[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    for (const r of rules) {
      const m = r.re.exec(line);
      if (!m) continue;
      const indent = (m[1] ?? "").replace(/\t/g, "  ").length;
      const heading = r.kind === "heading" ? /^#+/.exec(line)![0].length - 1 : Math.min(3, Math.floor(indent / 2));
      // A constant or a function declared inside a function body is noise: only the top level and one level of members.
      if (r.kind !== "heading" && indent > 4 && r.kind !== "function") continue;
      out.push({ name: m[2]!, kind: indent > 0 && r.kind === "function" && out.length ? "method" : r.kind, line: i + 1, depth: heading });
      break;
    }
  }
  return out;
}

/** The symbol a line is inside, for the breadcrumb's last part. */
export function symbolAt(symbols: Symbol[], line: number): Symbol | null {
  let best: Symbol | null = null;
  for (const s of symbols) if (s.line <= line) best = s;
  return best;
}

/** "3 min ago" style times for the Timeline, short. */
export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)}mo`;
  return `${Math.floor(s / 86400 / 365)}y`;
}

/** Text with CRLF turned to LF for the editor (the file's own line ending is kept apart and written back on save). */
export const toLf = (t: string) => t.replace(/\r\n/g, "\n");
