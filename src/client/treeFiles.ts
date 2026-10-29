/**
 * A folder's listing as the session's tree read gives it ("12 files under …", then a path a line): its paths, or why there are
 * none. An answer that is not a listing ("This session has no folder yet. Attach one…") is the reason, in its first sentence: it
 * was read as an empty folder, "The folder has no files to name yet." (2026-10-28 QA; Arun: "TEST EVERYTHING… EVERY
 * INTERACTION, EVERY VISUAL").
 */
export function treeFiles(answer: { output?: string; error?: string }): { files: string[]; why: string } {
  const out = answer.output ?? "";
  if (/^\d+ files? under /.test(out)) return { files: out.split("\n").slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith("[")), why: "" };
  const said = (answer.error || out).trim();
  return { files: [], why: said ? said.split(/(?<=[.!?])\s/)[0]! : "" };
}

/** The folders the paths are in, each ending in "/", for a picker that takes a folder as well as a file. */
export function foldersOf(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join("/")}/`);
  }
  return [...dirs].sort();
}
