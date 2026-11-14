/**
 * A command line read as a shell reads it (Fable's final probe of the allow rules, 2026-11-11: with real bash and zsh, `$'--hard'`,
 * `--ha$1rd` and `$'.'` got a destructive command through a pattern that compared text). Words are taken apart the way the shell
 * does it, with single quotes, double quotes, `$'…'` and backslashes, and each word says whether the shell would change it on the
 * way (`$`, a backtick, a glob) before the command ever sees it. A line is split into pieces on `&&`, `||`, `;` and `|`, outside
 * quotes, so `git commit -m "feat(ui): a; b > c --force"` is one piece of four words.
 *
 * Anything this can't read for certain is null, and a null line is only ever allowed exactly as it was pressed: a lone `&`, a
 * redirect into a file, a subshell, a here-document, a comment, a quote left open, a control character, and any character outside
 * plain ASCII outside quotes (a fullwidth semicolon, a zero-width space, a line separator).
 */

export interface Word {
  /** The word as the command receives it, quotes and backslashes taken away. */
  text: string;
  /** The shell would change it first: an unquoted `$`, `$'…'`, `$"…"`, a backtick, or a `$` inside double quotes. */
  expands: boolean;
  /** An unquoted glob (`*`, `?`, `[`) or brace expansion (`{a,b}`, `{1..3}`): the shell may put other words in its place. */
  glob: boolean;
  /** Written with a quote or a backslash somewhere: never a file descriptor ("2">&1 is the word 2). */
  quoted?: boolean;
}

export interface Piece {
  words: Word[];
  /** Its text as written, for saying it. */
  raw: string;
}

export type Op = "&&" | "||" | ";" | "|";

export interface Line {
  pieces: Piece[];
  /** Between pieces[i] and pieces[i + 1]. */
  ops: Op[];
}

/** Redirects that write nowhere: the error stream into the output, or either into /dev/null. */
const SAFE_REDIRECT = /^(?:[12]?>&[12]|[12]?>\s*\/dev\/null|&>\s*\/dev\/null)$/;

/** Characters never read as plain anywhere in a line: controls (but tab), and Unicode spaces, separators and zero-widths. */
const NEVER = /[\u0000-\u0008\u000a-\u001f\u007f\u0085\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]/;

export function lexLine(input: string): Line | null {
  const line = input.trim();
  if (!line || NEVER.test(line)) return null;
  const pieces: Piece[] = [];
  const ops: Op[] = [];
  let words: Word[] = [];
  let start = 0;
  let cur: Word | null = null;
  const word = () => (cur ??= { text: "", expands: false, glob: false });
  const endWord = () => {
    if (cur) words.push(cur);
    cur = null;
  };
  const endPiece = (op: Op | null, at: number, next: number) => {
    endWord();
    if (!words.length) return false;
    pieces.push({ words, raw: line.slice(start, at).trim() });
    words = [];
    start = next;
    if (op) ops.push(op);
    return true;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === " " || ch === "\t") {
      endWord();
      continue;
    }
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      const w = word();
      w.text += line.slice(i + 1, end);
      w.quoted = true;
      i = end;
      continue;
    }
    if (ch === '"') {
      const w = word();
      w.quoted = true;
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        const c = line[j]!;
        if (c === "\\" && j + 1 < line.length && /["\\$`\n]/.test(line[j + 1]!)) {
          w.text += line[++j];
          continue;
        }
        if (c === "$" || c === "`") w.expands = true;
        w.text += c;
      }
      if (j >= line.length) return null;
      i = j;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= line.length) return null;
      const w = word();
      w.quoted = true;
      w.text += line[++i];
      continue;
    }
    if (ch === "$" || ch === "`") {
      // $'…' and $"…" are the shell's own quoting with escapes of its own; $x, $1, $@, $( and a backtick are expansions. All of
      // them make the word one the shell changes, so it is never matched by a pattern.
      const w = word();
      w.expands = true;
      w.text += ch;
      continue;
    }
    if (ch === "#" && !cur) return null;
    if (ch === "(" || ch === ")" || ch === "<") return null;
    if (ch === "&" || ch === "|" || ch === ";") {
      const two = line.slice(i, i + 2);
      if (two === "&&" || two === "||") {
        if (!endPiece(two as Op, i, i + 2)) return null;
        i++;
        continue;
      }
      if (ch === "&" && line[i + 1] === ">") {
        const m = /^&>\s*\/dev\/null(?=\s|$|[;&|])/.exec(line.slice(i));
        if (!m || cur) return null;
        i += m[0].length - 1;
        continue;
      }
      if (ch === "&") return null;
      if (!endPiece(ch as Op, i, i + 1)) return null;
      continue;
    }
    if (ch === ">") {
      // A file descriptor written just before it ("2>"), then where it goes: only the safe ones.
      const before = cur as Word | null;
      const fd = before && /^[12]$/.test(before.text) && !before.expands && !before.quoted ? before.text : "";
      if (before && !fd) return null;
      const m = /^>(?:&[12]|\s*\/dev\/null)(?=\s|$|[;&|])/.exec(line.slice(i));
      if (!m || !SAFE_REDIRECT.test(`${fd}${m[0]}`)) return null;
      cur = null;
      i += m[0].length - 1;
      continue;
    }
    // Outside quotes, only plain ASCII.
    if (ch.charCodeAt(0) > 0x7e) return null;
    const w = word();
    // A brace is a glob only where it expands ({a,b}, {1..3}): stash@{0} and HEAD@{1} are words as they are.
    if (/[*?[\]]/.test(ch)) w.glob = true;
    if (ch === "}" && /\{[^{}]*(,|\.\.)[^{}]*$/.test(w.text)) w.glob = true;
    w.text += ch;
  }
  if (!endPiece(null, line.length, line.length)) return null;
  if (ops.length !== pieces.length - 1) return null;
  return { pieces, ops };
}

/** The words of a line that is one piece, or null. */
export function lexOne(input: string): Word[] | null {
  const l = lexLine(input);
  return l && l.pieces.length === 1 ? l.pieces[0]!.words : null;
}
