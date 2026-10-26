/** What kind of step this is, for the run strip's colour: read, search, edit, run, test, ask, or other. Marks are the ones stepFor gives. */
export type StepKind = "read" | "search" | "edit" | "run" | "test" | "ask" | "other";

const TEST = /\b(test|tests|jest|vitest|pytest|mocha|rspec|playwright|cypress)\b|go test|cargo test/i;

export function stepKind(s: { mark: string; target?: string }): StepKind {
  if (s.mark === "≡") return "read";
  if (s.mark === "⌕") return "search";
  if (s.mark === "±" || s.mark === "+") return "edit";
  if (s.mark === "›_") return TEST.test(s.target ?? "") ? "test" : "run";
  if (s.mark === "?") return "ask";
  return "other";
}
