import { notesPrompt } from "../threads.js";
/**
 * Comments on a diff, turned into one instruction.
 *
 * A review is several remarks about several lines, and the agent is best at
 * acting on them together: it can see that two comments are the same problem,
 * and it makes one pass over the files instead of one per remark. Each comment
 * says exactly where it points — the file, the line, and the line itself — so
 * the agent doesn't have to guess which of three similar lines was meant, even
 * if the file has moved since.
 */

export interface LineComment {
  path: string;
  /** The line number in the file as it is now; for a removed line, as it was. */
  line: number;
  /** The last line of a range, when the note is about a block of lines. */
  endLine?: number;
  removed: boolean;
  /** The code on that line, for the agent to find it by. */
  code: string;
  text: string;
}

export function reviewText(comments: LineComment[]): string {
  return notesPrompt(comments);
}
