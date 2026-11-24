/**
 * What a proof clip shows, in words (Arun, 2026-11-22: "also for the proof clip add like a description what was changed..."): the
 * agent's own account of the change, its last message in that lane cut to its first paragraph and a couple of sentences, and the files
 * the change touched. Read from what is already in the session (no model call), once, as the clip is kept (app.ts proofClipBody), so the
 * chat's card, the phone and the pull request's Proof block all say the same thing.
 */
import type { SessionEvent } from "./types.js";

/** The longest description kept: a couple of sentences. */
export const SUMMARY_MAX = 280;
/** The most files named. */
export const FILES_MAX = 6;

/** Markdown as one plain run of words: no fences, headings, list marks, emphasis or link syntax. */
export function plainWords(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first paragraph of an answer, plain, cut at a sentence end within the limit (else at a word, with an ellipsis). */
export function firstWords(text: string, max = SUMMARY_MAX): string {
  // A paragraph made only of a heading or a fence says nothing about the change: the first one with words in it.
  const paras = text.split(/\n\s*\n/).map(plainWords).filter((p) => p.length > 0);
  const p = paras[0] ?? "";
  if (p.length <= max) return p;
  const cut = p.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (end >= max * 0.4) return cut.slice(0, end + 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : max).trimEnd()}…`;
}

/** The agent's description of the change in `lane`: its last message with words in it, from an agent, at or before `upTo`. */
export function changeSummary(events: SessionEvent[], lane: string, upTo = Infinity): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.seq > upTo || (e.lane ?? "main") !== lane || e.actor.kind !== "agent" || e.body.type !== "agent.message") continue;
    const t = String((e.body as { text?: unknown }).text ?? "").trim();
    if (t) return firstWords(t);
  }
  return "";
}

/** The files a change touched, as they will read in a line: newest change set's paths, at most FILES_MAX, deleted ones too. */
export function changedFiles(files: ReadonlyArray<{ path: string }>): string[] {
  const seen = new Set<string>();
  return files.map((f) => f.path).filter((p) => p && !seen.has(p) && !!seen.add(p)).slice(0, FILES_MAX);
}
