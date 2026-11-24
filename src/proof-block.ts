/**
 * Proof in a pull request's description (Arun, 2026-11-21: "add clips to PRs and the phone too also see where else we can intergrate
 * it"): the walk through what changed, as a GIF GitHub shows inline, the page before it beside it when there is one, and what the walk
 * did step by step. One block between two markers, so Friday can put it in again with a newer clip without touching anything a
 * person wrote around it. Written by both places that say what a pull request is about: Friday opening one (runner/repo-read.ts
 * publish) and a clip that lands after it was opened (runner/pr-proof.ts).
 */

export const PROOF_START = "<!-- friday-proof -->";
export const PROOF_END = "<!-- /friday-proof -->";

export interface ProofBlockParts {
  /** The page the clip walked, "/checkout". */
  page: string;
  /** Where the GIFs are (raw URLs GitHub shows inline). */
  after: string;
  before?: string;
  marks?: { atMs: number; label: string }[];
  /** What was changed, in the agent's words, and the files it touched (clip-summary.ts; Arun, 2026-11-22). */
  summary?: string;
  files?: string[];
}

/** Text that can't close the alt text or a table cell it sits in. */
const plain = (s: string) => s.replace(/[[\]|<>\r\n]/g, " ").replace(/\s+/g, " ").trim();
/** "2.4s" */
export const secondsOf = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

export function proofBlock(p: ProofBlockParts): string {
  const page = plain(p.page) || "/";
  const out = [PROOF_START, "### Proof"];
  // What changed, said first, so the description reads before the picture loads.
  if (p.summary?.trim()) out.push("", `**What changed:** ${p.summary.replace(/[\r\n]+/g, " ").replace(/<!--|-->/g, "").trim()}`);
  const files = (p.files ?? []).map((f) => f.replace(/[`\r\n]/g, "").trim()).filter(Boolean).slice(0, 6);
  if (files.length) out.push("", `Files: ${files.map((f) => `\`${f}\``).join(", ")}`);
  out.push("", `![${page}, walked through what changed](${p.after})`);
  if (p.before) out.push("", "| Before | After |", "| --- | --- |", `| ![${page} before the change](${p.before}) | ![${page} after the change](${p.after}) |`);
  const steps = (p.marks ?? []).slice(0, 12);
  if (steps.length) out.push("", ...steps.map((m) => `- ${secondsOf(m.atMs)} · ${plain(m.label)}`));
  out.push("", "<sub>Recorded by Friday when the work finished</sub>", PROOF_END);
  return out.join("\n");
}

/** A description with the block in it: the one already there replaced in place, else added at the end after a blank line. */
export function withProofBlock(body: string, block: string): string {
  const text = body ?? "";
  const start = text.indexOf(PROOF_START);
  const end = start >= 0 ? text.indexOf(PROOF_END, start) : -1;
  if (start >= 0 && end >= 0) return text.slice(0, start) + block + text.slice(end + PROOF_END.length);
  const trimmed = text.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

/** Where a pull request's GIF is kept on the friday-proof branch: "pr-42/checkout-1a2b3c.gif". */
export function proofPath(number: number, page: string, id: string, kind: "after" | "before" = "after"): string {
  const slug = page.replace(/^\/+|\/+$/g, "").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 60) || "home";
  return `pr-${number}/${slug}${kind === "before" ? "-before" : ""}-${id}.gif`;
}

/** A file on a commit, as GitHub shows it raw in a description (works for a private repository to those who can see it). */
export const rawUrl = (owner: string, repo: string, commit: string, path: string) => `https://github.com/${owner}/${repo}/blob/${commit}/${path.split("/").map(encodeURIComponent).join("/")}?raw=true`;
