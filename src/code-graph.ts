/**
 * Which file uses which, read from the code itself with no model (Arun, 2026-11-22: "visualizing or making a web of connections or
 * showing how your code works for the deep dive"): the imports in each file, resolved to the repo's own files. Deep Dive's code map
 * (code-map.ts, client/CodeMap.tsx) draws it. Read on the computer the repo is on (runner/dive.ts codeGraph): only paths, line
 * counts and these links leave it, never the code.
 *
 * Languages read: JavaScript and TypeScript (import, export from, require, import()), Python (import, from), Go (its module's own
 * packages), Rust (mod, use crate::), C and C++ (#include "…"), Java and Kotlin (import of the repo's own classes), Ruby
 * (require_relative). A package from outside the repo is not a link: the map is of this code.
 */

export interface CodeGraph {
  /** The code files read, paths from the repo's root with forward slashes. */
  files: string[];
  /** Each file's lines, by its index in `files`. */
  lines: number[];
  /** [from, to, how many imports]: `from` uses `to`. */
  edges: [number, number, number][];
  /** There were more code files than were read. */
  more: boolean;
  /** Test files, left off the map (they use everything, and drown how the code itself fits together). */
  tests: number;
  head: string;
}

/** A test, by its folder or its name: test/, __tests__/, e2e/, x.test.ts, x.spec.js, x_test.go, test_x.py. */
export const TEST_FILE = /(^|\/)(tests?|__tests__|e2e|spec|__mocks__|fixtures)\/|\.(test|spec|stories)\.[^/]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;

export const CODE_FILE = /\.(m?[jt]sx?|c[jt]s|mts|cts|vue|svelte|astro|py|go|rs|c|cc|cpp|cxx|h|hh|hpp|java|kt|kts|rb)$/i;
const JS = /\.(m?[jt]sx?|c[jt]s|mts|cts|vue|svelte|astro)$/i;
const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte", ".astro", ".d.ts"];

const dirOf = (f: string) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");
/** `a/b/../c` as `a/c`; null when it climbs out of the repo. */
export function joinRel(dir: string, rel: string): string | null {
  const out: string[] = dir ? dir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

/** What a file imports, as written: module specifiers, include paths, dotted names. */
export function importsIn(file: string, text: string): string[] {
  const out: string[] = [];
  const add = (s: string | undefined) => s && out.push(s.trim());
  // Comments out first, so an import in a comment or a doc block isn't a link. Strings stay.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  if (JS.test(file)) {
    for (const m of code.matchAll(/(?:^|[;\n}])\s*(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"'\n]+)["']/g)) add(m[1]);
    for (const m of code.matchAll(/\b(?:require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)/g)) add(m[1]);
  } else if (/\.py$/i.test(file)) {
    const py = text.replace(/#[^\n]*/g, "");
    for (const m of py.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import\s+([\w\s,.*()]+)/gm)) {
      const mod = m[1]!;
      // `from . import a, b` names modules; `from .x import y` names a module x.
      if (/^\.+$/.test(mod)) for (const n of m[2]!.replace(/[()]/g, "").split(",")) add(`${mod}${n.trim().split(/\s+/)[0]}`);
      else add(mod);
    }
    for (const m of py.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) for (const n of m[1]!.split(",")) add(n.trim());
  } else if (/\.go$/i.test(file)) {
    for (const m of code.matchAll(/^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm)) add(m[1]);
    for (const block of code.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) for (const m of block[1]!.matchAll(/"([^"]+)"/g)) add(m[1]);
  } else if (/\.rs$/i.test(file)) {
    for (const m of code.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) add(`mod:${m[1]}`);
    for (const m of code.matchAll(/\buse\s+crate::([\w:]+)/g)) add(`crate:${m[1]}`);
  } else if (/\.(c|cc|cpp|cxx|h|hh|hpp)$/i.test(file)) {
    for (const m of code.matchAll(/^\s*#\s*include\s+"([^"]+)"/gm)) add(m[1]);
  } else if (/\.(java|kt|kts)$/i.test(file)) {
    for (const m of code.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)/gm)) add(m[1]);
  } else if (/\.rb$/i.test(file)) {
    for (const m of text.matchAll(/^\s*require_relative\s+["']([^"']+)["']/gm)) add(m[1]);
  }
  return out;
}

/**
 * A tsconfig's or jsconfig's import aliases (compilerOptions.paths and baseUrl), for the files in its folder (Arun, 2026-11-23: the
 * code map "lacking basically everything … logic"): a repo whose web app is its own package, like edge's client/, writes
 * `@/components/x` meaning client/src/components/x, and every such import was lost, so a 26-file app showed as linked to nothing.
 */
export interface Alias {
  /** The config's folder, from the repo's root ("" at the root). */
  dir: string;
  /** Where its paths resolve from: baseUrl, else the config's folder. */
  base: string;
  /** Whether baseUrl was set, so a bare `components/x` may resolve under it. */
  baseUrl: boolean;
  paths: [pattern: string, targets: string[]][];
}

/** A tsconfig.json or jsconfig.json's aliases, from its text (comments and trailing commas allowed, as TypeScript allows them). */
export function aliasOf(file: string, text: string): Alias | null {
  let json: { compilerOptions?: { baseUrl?: unknown; paths?: unknown } };
  try {
    const plain = text
      .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_m, str: string | undefined) => str ?? "")
      .replace(/,(\s*[}\]])/g, "$1");
    json = JSON.parse(plain);
  } catch {
    return null;
  }
  const o = json?.compilerOptions;
  if (!o) return null;
  const dir = dirOf(file);
  const baseUrl = typeof o.baseUrl === "string" ? o.baseUrl : "";
  const base = joinRel(dir, baseUrl || ".");
  if (base === null) return null;
  const paths: [string, string[]][] = [];
  if (o.paths && typeof o.paths === "object")
    for (const [k, v] of Object.entries(o.paths as Record<string, unknown>))
      if (Array.isArray(v)) paths.push([k, v.filter((t): t is string => typeof t === "string")]);
  if (!paths.length && !baseUrl) return null;
  return { dir, base, baseUrl: !!baseUrl, paths };
}

/** What `resolveImport` needs to know about the repo besides the files: its Go module path, read from go.mod, and its aliases. */
export interface ResolveContext {
  files: ReadonlySet<string>;
  goModule?: string;
  /** Deepest folder first, so a file takes the config nearest it. */
  aliases?: Alias[];
  /** Files by their name, for an `#include "x.h"` that isn't beside its file. */
  byName?: Map<string, string[]>;
  /** Go files by their folder. */
  byDir?: Map<string, string[]>;
}

/** The repo's files one import names (several for a Go package), or none when it is outside the repo. */
export function resolveImport(from: string, spec: string, ctx: ResolveContext): string[] {
  const has = (p: string | null): p is string => !!p && ctx.files.has(p);
  const first = (cands: (string | null)[]) => {
    const hit = cands.find(has);
    return hit ? [hit] : [];
  };
  const dir = dirOf(from);
  if (JS.test(from)) {
    const roots: string[] = [];
    if (spec.startsWith(".")) {
      const b = joinRel(dir, spec);
      if (b === null) return [];
      roots.push(b);
    } else {
      // The nearest config's paths first (`@app/*` → `src/app/*`), then a bare name under its baseUrl.
      const alias = ctx.aliases?.find((a) => !a.dir || from.startsWith(`${a.dir}/`));
      if (alias) {
        for (const [pattern, targets] of alias.paths) {
          const star = pattern.indexOf("*");
          const hit = star < 0 ? (spec === pattern ? "" : null) : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)) && spec.length >= pattern.length - 1 ? spec.slice(star, spec.length - (pattern.length - star - 1)) : null;
          if (hit === null) continue;
          for (const t of targets) {
            const r = joinRel(alias.base, t.replace("*", hit));
            if (r !== null) roots.push(r);
          }
        }
        if (alias.baseUrl) {
          const r = joinRel(alias.base, spec);
          if (r !== null) roots.push(r);
        }
      }
      // `@/x`, `~/x` and `/x` with no config saying: the usual src/ or app/ of the package the file is in, nearest first, then the
      // repo's root.
      const rest = /^[@~]\//.test(spec) ? spec.slice(2) : spec.startsWith("/") ? spec.slice(1) : null;
      if (rest !== null)
        for (let d: string | null = dir; d !== null; d = d ? (d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "") : null) {
          const at = d ? `${d}/` : "";
          roots.push(`${at}src/${rest}`, `${at}app/${rest}`, `${at}${rest}`);
          if (!d) break;
        }
      if (!roots.length) return [];
    }
    const cands: (string | null)[] = [];
    for (const b of roots) {
      cands.push(b);
      // TypeScript written for ESM names the built file: `./x.js` is `./x.ts`.
      const bare = b.replace(/\.(m|c)?js$/, "").replace(/\.jsx$/, "");
      for (const e of JS_EXTS) cands.push(bare + e);
      for (const e of JS_EXTS) cands.push(`${b}/index${e}`);
    }
    return first(cands);
  }
  if (/\.py$/i.test(from)) {
    const dots = spec.match(/^\.*/)![0].length;
    const name = spec.slice(dots).replace(/\./g, "/");
    let base: string;
    if (dots) {
      let d: string | null = dir;
      for (let i = 1; i < dots && d !== null; i++) d = joinRel(d, "..");
      if (d === null) return [];
      base = d ? (name ? `${d}/${name}` : d) : name;
    } else base = name;
    if (!base) return [];
    const roots = dots ? [base] : [base, `src/${base}`];
    // `import a.b.c` may name a module or a name inside one: the longest prefix that is a file.
    const cands: string[] = [];
    for (const r of roots) {
      const parts = r.split("/");
      for (let n = parts.length; n >= 1; n--) {
        const p = parts.slice(0, n).join("/");
        cands.push(`${p}.py`, `${p}/__init__.py`);
        if (dots) break;
      }
    }
    return first(cands);
  }
  if (/\.go$/i.test(from)) {
    if (!ctx.goModule || !(spec === ctx.goModule || spec.startsWith(`${ctx.goModule}/`))) return [];
    const pkg = spec.slice(ctx.goModule.length).replace(/^\//, "");
    return (ctx.byDir?.get(pkg) ?? []).filter((f) => f !== from && !/_test\.go$/.test(f));
  }
  if (/\.rs$/i.test(from)) {
    if (spec.startsWith("mod:")) {
      const m = spec.slice(4);
      const stem = from.slice(from.lastIndexOf("/") + 1).replace(/\.rs$/, "");
      const here = ["main", "lib", "mod"].includes(stem) ? dir : dir ? `${dir}/${stem}` : stem;
      const at = here ? `${here}/` : "";
      return first([`${at}${m}.rs`, `${at}${m}/mod.rs`]);
    }
    if (spec.startsWith("crate:")) {
      const i = from.lastIndexOf("src/");
      const root = i >= 0 ? from.slice(0, i + 4) : "";
      const parts = spec.slice(6).split("::");
      const cands: string[] = [];
      for (let n = parts.length; n >= 1; n--) {
        const p = parts.slice(0, n).join("/");
        cands.push(`${root}${p}.rs`, `${root}${p}/mod.rs`);
      }
      return first(cands);
    }
    return [];
  }
  if (/\.(c|cc|cpp|cxx|h|hh|hpp)$/i.test(from)) {
    const near = first([joinRel(dir, spec), joinRel("", spec), joinRel("include", spec), joinRel("src", spec)]);
    if (near.length) return near;
    const named = ctx.byName?.get(spec.slice(spec.lastIndexOf("/") + 1)) ?? [];
    return named.length === 1 ? named : [];
  }
  if (/\.(java|kt|kts)$/i.test(from)) {
    const tail = spec.replace(/\.\*$/, "").replace(/\./g, "/");
    const name = tail.slice(tail.lastIndexOf("/") + 1);
    for (const ext of [".java", ".kt"]) {
      const hits = (ctx.byName?.get(name + ext) ?? []).filter((f) => f.endsWith(`/${tail}${ext}`) || f === `${tail}${ext}`);
      if (hits.length) return [hits[0]!];
    }
    return [];
  }
  if (/\.rb$/i.test(from)) return first([joinRel(dir, spec.endsWith(".rb") ? spec : `${spec}.rb`)]);
  return [];
}

/** The context for a repo's files, and its go.mod's text if it has one. */
export function resolveContext(files: readonly string[], goMod = "", aliases: Alias[] = []): ResolveContext {
  const byName = new Map<string, string[]>();
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const name = f.slice(f.lastIndexOf("/") + 1);
    (byName.get(name) ?? byName.set(name, []).get(name)!).push(f);
    if (/\.go$/.test(f)) (byDir.get(dirOf(f)) ?? byDir.set(dirOf(f), []).get(dirOf(f))!).push(f);
  }
  const goModule = goMod.match(/^\s*module\s+(\S+)/m)?.[1];
  // A folder's configs as one (tsconfig.json and the tsconfig.app.json it points at): their paths together, a baseUrl if either has.
  const byFolder = new Map<string, Alias>();
  for (const a of aliases) {
    const had = byFolder.get(a.dir);
    byFolder.set(a.dir, had ? { dir: a.dir, base: had.baseUrl ? had.base : a.base, baseUrl: had.baseUrl || a.baseUrl, paths: [...had.paths, ...a.paths] } : a);
  }
  const nearest = [...byFolder.values()].sort((a, b) => b.dir.split("/").length - a.dir.split("/").length || b.dir.length - a.dir.length);
  return { files: new Set(files), byName, byDir, ...(goModule ? { goModule } : {}), ...(nearest.length ? { aliases: nearest } : {}) };
}
