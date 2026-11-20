import { pathOf } from "../answer-format.js";
import { relativeTo } from "./util.js";

/** Fences whose "#" starts a heading, not a comment: a first line "# Next.js" there names no file. */
const HEADS = /^(md|markdown|mdx|text|txt|plain|plaintext)?$/i;

/**
 * The file a block names, and the language left once the file is taken off the fence: "ts:src/a.ts" or a first line like
 * "// src/a.ts". `root` is the open folder, so a fence that gives the whole path ("ts:/Users/me/proj/src/a.ts") still names a file
 * when it lies inside it.
 */
export function codeFile(fence: string, code: string, root?: string | null): { lang: string; file: { path: string; line?: number } | null; body: string } {
  // ```ts:src/a.ts  or  ```ts title="src/a.ts" (the renderer hands over only the first word, so the first form is what reaches here).
  const colon = /^([^:\s]+):(.+)$/.exec(fence);
  if (colon) {
    let f = pathOf(colon[2]!);
    if (!f && root) {
      // A whole path: inside the folder it is that file; the language is what stands before the colon either way.
      const at = /^(.*?)(?::(\d+))?$/.exec(colon[2]!);
      const rel = at && relativeTo(root, at[1]!);
      const g = rel && /^(?:[A-Za-z]:)?[\\/]/.test(at![1]!) ? pathOf(rel) : null;
      if (g) f = at![2] ? { ...g, line: Number(at![2]) } : g;
    }
    return { lang: colon[1]!, file: f, body: code };
  }
  // A first line that is only a path in a comment: "// src/a.ts", "# configs/model.yaml", "/* src/a.css */", "-- db/up.sql".
  const first = code.split("\n", 1)[0] ?? "";
  const c = /^\s*(\/\/|#!?|--|\/\*+|<!--)\s*(?:file(?:name)?:\s*)?(\S+?)\s*(?:\*+\/|-->)?\s*$/i.exec(first);
  const f = c ? pathOf(c[2]!) : null;
  // A "#" is a heading in Markdown and a comment elsewhere, where a bare name ("# README.md") is still more likely a title than a file.
  const hash = c?.[1]!.startsWith("#");
  if (f && /[./]/.test(c![2]!) && /\.[A-Za-z0-9]{1,8}(?::\d+)?$/.test(c![2]!) && !(hash && (HEADS.test(fence) || !c![2]!.includes("/")))) return { lang: fence, file: f, body: code };
  return { lang: fence, file: null, body: code };
}

/** Which extensions a fence's language goes with, where it is not its own name ("bash" blocks hold .sh files; "ts" ones .ts and .tsx). */
const EXTS: Record<string, string[]> = {
  ts: ["ts", "tsx", "mts", "cts"], typescript: ["ts", "tsx", "mts", "cts"], tsx: ["tsx", "ts"],
  js: ["js", "jsx", "mjs", "cjs"], javascript: ["js", "jsx", "mjs", "cjs"], jsx: ["jsx", "js"], node: ["js", "mjs", "cjs"],
  py: ["py", "pyi"], python: ["py", "pyi"], rb: ["rb"], ruby: ["rb"], rs: ["rs"], rust: ["rs"], kt: ["kt", "kts"], kotlin: ["kt", "kts"],
  sh: ["sh", "bash", "zsh"], bash: ["sh", "bash", "zsh"], shell: ["sh", "bash", "zsh"], zsh: ["sh", "zsh"],
  yml: ["yml", "yaml"], yaml: ["yml", "yaml"], json: ["json", "jsonc", "json5"], jsonc: ["json", "jsonc"],
  md: ["md", "mdx", "markdown"], markdown: ["md", "mdx", "markdown"], html: ["html", "htm"], css: ["css"], scss: ["scss"],
  cpp: ["cpp", "cc", "cxx", "hpp", "h"], c: ["c", "h"], cs: ["cs"], csharp: ["cs"], objc: ["m", "mm", "h"], swift: ["swift"], java: ["java"],
};

/** Whether a fence's language is the kind of file this is: no language agrees with anything; a shell block is not a .ts file. */
export function fenceAgrees(language: string, path: string): boolean {
  const l = language.toLowerCase();
  if (!l || l === "text" || l === "txt" || l === "plaintext" || l === "diff") return true;
  const ext = (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? "").toLowerCase();
  return (EXTS[l] ?? [l]).includes(ext);
}
