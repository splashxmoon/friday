/**
 * When a change is big enough to be offered "Split into a stack" (Arun, 2026-11-19, wave 3): over ~400 lines or 10 files. Apart from
 * stack-plan.ts so the changes card, which is on every session screen, doesn't carry the rest of it with it.
 */
export const BIG_LINES = 400;
export const BIG_FILES = 10;

/** Whether a change set is big enough to offer the split: lines added and removed, or files. */
export function isBig(files: readonly { additions: number; deletions: number }[]): boolean {
  if (files.length > BIG_FILES) return true;
  return files.reduce((n, f) => n + f.additions + f.deletions, 0) > BIG_LINES;
}
