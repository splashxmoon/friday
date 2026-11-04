/**
 * Undo and redo over one value, as a canvas keeps its own: each change pushes what it replaced; undo hands back the last one, redo
 * the one undone. A change after an undo forgets what could be redone.
 */
export interface History<T> {
  /** A change was made: `prev` is what it replaced. */
  changed(prev: T): void;
  /** What to go back to from `now`, or undefined when there is nothing to undo. */
  undo(now: T): T | undefined;
  /** What to go forward to from `now`, or undefined when nothing was undone. */
  redo(now: T): T | undefined;
}

export function history<T>(limit = 50): History<T> {
  const past: T[] = [];
  let future: T[] = [];
  return {
    changed(prev) {
      past.push(prev);
      if (past.length > limit) past.shift();
      future = [];
    },
    undo(now) {
      const p = past.pop();
      if (p !== undefined) future.push(now);
      return p;
    },
    redo(now) {
      const n = future.pop();
      if (n !== undefined) past.push(now);
      return n;
    },
  };
}
