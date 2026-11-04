/**
 * A branch a person named ("dev", "fix/export-timeout"), not one Friday or a coding tool made up for a session
 * ("friday/2026-11-04-0519", "2026-11-04-1132", "friday/spare-3", "claude/…", "codex/…") nor a repository's own "main": only
 * these are worth a word in a session's row (audit CODE-15 A, Arun 2026-11-04: "· main" on every row said nothing).
 */
export const namedBranch = (b: string | undefined): b is string =>
  !!b && !/^(?:main|master|trunk)$/.test(b) && !/^(?:friday|claude|codex|cursor|copilot)[/-]/i.test(b) && !/(?:^|\/)\d{4}-\d{2}-\d{2}(?:-\d{3,6})?$/.test(b) && !spareBranch(b);

/** One of the spare branches Friday keeps ready for new sessions ("friday/spare-2"): never a branch to offer anybody (audit CODE-16 A). */
export const spareBranch = (b: string): boolean => /^friday\/spare-/.test(b);
