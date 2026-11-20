"use strict";
// The pure part of the IDE's Keep / Undo blocks (marks.js draws them): a line diff between a file as it was and as it is now,
// the changed blocks ("hunks"), and what Keep and Undo do to one. No vscode in here, so it is tested on its own
// (test/vscode-ext-marks.test.ts). Lines are indexed as the editor indexes them: a text ending in a newline has a last, empty line.

/** A text as lines, with every line ending one kind (the editor's own eol is put back on writing). */
function splitLines(text) {
  return String(text).replace(/\r\n?/g, "\n").split("\n");
}

// Past this many cells the middle of a change is one block instead of a precise diff: a huge rewrite is one block anyway.
const MAX_CELLS = 4_000_000;

/**
 * The blocks that turn `a` (the lines as they were) into `b` (as they are): [{a0, a1, b0, b1}], half open, in order. A block
 * with a0 == a1 only adds lines; one with b0 == b1 only removes them.
 */
function lineDiff(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || n * m > MAX_CELLS) return [{ a0: pre, a1: pre + n, b0: pre, b1: pre + m }];
  // Longest common subsequence of the middle, by dynamic programming on the lengths, then walked forward.
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[pre + i] === b[pre + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  let open = null;
  const close = () => {
    if (open) out.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[pre + i] === b[pre + j]) {
      close();
      i++;
      j++;
    } else {
      if (!open) open = { a0: pre + i, a1: pre + i, b0: pre + j, b1: pre + j };
      if (j < m && (i === n || t[i * w + j + 1] >= t[(i + 1) * w + j])) {
        j++;
        open.b1 = pre + j;
      } else {
        i++;
        open.a1 = pre + i;
      }
    }
  }
  close();
  return out;
}

/** The blocks between a base text and the text now. */
function hunksOf(base, text) {
  return lineDiff(splitLines(base), splitLines(text));
}

/**
 * Where blocks go when the person types: one change (the lines it replaced, and how many lines it wrote) moves the blocks after
 * it, and stretches a block it lands in. The base never moves, so what they typed is not taken for the agent's.
 */
function shiftHunks(hunks, startLine, endLine, newLines) {
  const delta = newLines - (endLine - startLine);
  if (!delta) return hunks.map((h) => ({ ...h }));
  return hunks.map((h) => {
    if (endLine < h.b0 || (endLine === h.b0 && startLine < h.b0)) return { ...h, b0: h.b0 + delta, b1: h.b1 + delta };
    if (startLine >= h.b1 && !(h.b0 === h.b1 && startLine === h.b0)) return { ...h };
    return { ...h, b1: Math.max(h.b0, h.b1 + delta) };
  });
}

/**
 * The person's own change when it lands outside every block (c: startLine, startChar, endLine, endChar, text, in the lines as they
 * are before it): it goes into the base as well, and the blocks after it move in both, so the base follows what they type. A save,
 * or the agent's next write, then reads to the agent's blocks alone, never to the person's lines (Arun, 2026-11-19: "your typing
 * never clobbers theirs"). Null when it touches a block (its words stay inside that block, as typed) or doesn't fit the base.
 */
function typedOutside(base, hunks, c) {
  for (const h of hunks) if (c.endLine >= h.b0 && c.startLine < Math.max(h.b1, h.b0 + 1)) return null;
  let delta = 0;
  for (const h of hunks) if (h.b1 <= c.startLine) delta += h.a1 - h.a0 - (h.b1 - h.b0);
  const lines = splitLines(base);
  const sl = c.startLine + delta;
  const el = c.endLine + delta;
  if (sl < 0 || el >= lines.length || el < sl) return null;
  const ins = splitLines(c.text);
  ins[0] = lines[sl].slice(0, c.startChar) + ins[0];
  ins[ins.length - 1] += lines[el].slice(c.endChar);
  const d = ins.length - (el - sl + 1);
  lines.splice(sl, el - sl + 1, ...ins);
  const moved = hunks.map((h) => (h.b0 > c.endLine ? { ...h, a0: h.a0 + d, a1: h.a1 + d, b0: h.b0 + d, b1: h.b1 + d } : { ...h }));
  return { base: lines.join("\n"), hunks: moved };
}

/**
 * What putting a block back is, as an edit to the text now: replace lines [start, end) with `text`. A block that runs to the end of
 * the file (`toEnd`) is replaced from the end of the line before it (`joinPrev`, else from the file's start) to the file's end, so
 * the newline that closed the file before is the one that closes it after.
 */
function undoEdit(base, hunk, nowLines, eol) {
  const was = splitLines(base).slice(hunk.a0, hunk.a1);
  if (hunk.b1 >= nowLines.length) {
    const joinPrev = hunk.b0 > 0;
    return { start: hunk.b0, end: nowLines.length, toEnd: true, joinPrev, text: joinPrev ? (was.length ? eol + was.join(eol) : "") : was.join(eol) };
  }
  return { start: hunk.b0, end: hunk.b1, toEnd: false, text: was.map((l) => l + eol).join("") };
}

/** The base after Keep on one block: that block's lines are now the base's. */
function keepBase(base, hunk, nowLines) {
  const a = splitLines(base);
  a.splice(hunk.a0, hunk.a1 - hunk.a0, ...nowLines.slice(hunk.b0, hunk.b1));
  return a.join("\n");
}

module.exports = { splitLines, lineDiff, hunksOf, shiftHunks, typedOutside, undoEdit, keepBase };
