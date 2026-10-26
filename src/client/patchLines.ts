import type { FileDiffLine } from "@/components/agents/file-diff";

/** A unified diff as the rows FileDiff draws, with line numbers from the hunk headers. */
export function patchLines(patch: string): FileDiffLine[] {
  const out: FileDiffLine[] = [];
  let oldN = 0;
  let newN = 0;
  let inHunk = false;
  patch.split("\n").forEach((l, i) => {
    const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) {
      inHunk = true;
      oldN = Number(h[1]);
      newN = Number(h[2]);
      out.push({ id: `h${i}`, type: "context", content: `@@${h[3] ?? ""}` });
      return;
    }
    if (!inHunk || l.startsWith("\\")) return;
    if (l.startsWith("+")) out.push({ id: `l${i}`, type: "added", newLine: newN++, content: l.slice(1) });
    else if (l.startsWith("-")) out.push({ id: `l${i}`, type: "removed", oldLine: oldN++, content: l.slice(1) });
    else out.push({ id: `l${i}`, type: "context", oldLine: oldN++, newLine: newN++, content: l.slice(1) });
  });
  return out;
}
