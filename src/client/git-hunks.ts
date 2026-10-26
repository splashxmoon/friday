import type { DiffFile } from "../types.js";

/**
 * A file's patch cut into its hunks, each one a patch of its own with the file's header, so one hunk can be staged or
 * thrown away without the rest (Git panel; the runner applies it with `git apply`, see git.ts applyPatch).
 */
export interface Hunk {
  /** The hunk's header line, "@@ -a,b +c,d @@ …". */
  header: string;
  /** Its lines after the header, each starting with " ", "+" or "-" (or "\\" for a no-newline note). */
  lines: string[];
  /** The whole thing as git takes it: the file header, then this hunk. */
  patch: string;
  additions: number;
  deletions: number;
}

export function hunksOf(file: Pick<DiffFile, "patch" | "path" | "from" | "status">): Hunk[] {
  const all = file.patch.split("\n");
  const first = all.findIndex((l) => l.startsWith("@@ "));
  // A patch without a diff header (one the Diff panel cut down) gets one, so git knows which file.
  let head = first > 0 ? all.slice(0, first) : [];
  if (!head.some((l) => l.startsWith("diff --git"))) {
    const from = file.status === "added" ? "/dev/null" : `a/${file.from ?? file.path}`;
    const to = file.status === "deleted" ? "/dev/null" : `b/${file.path}`;
    head = [`diff --git a/${file.from ?? file.path} b/${file.path}`, ...(file.status === "added" ? ["new file mode 100644"] : file.status === "deleted" ? ["deleted file mode 100644"] : []), `--- ${from}`, `+++ ${to}`];
  }
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of first < 0 ? [] : all.slice(first)) {
    if (line.startsWith("@@ ")) {
      cur = { header: line, lines: [], patch: "", additions: 0, deletions: 0 };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line === "" && all.at(-1) === "") continue;
    cur.lines.push(line);
    if (line.startsWith("+")) cur.additions++;
    else if (line.startsWith("-")) cur.deletions++;
  }
  for (const h of out) {
    // A trailing empty string from the patch's final newline isn't a line of the hunk.
    while (h.lines.length && h.lines.at(-1) === "") h.lines.pop();
    h.patch = `${[...head, h.header, ...h.lines].join("\n")}\n`;
  }
  return out;
}
