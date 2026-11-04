/**
 * The first line of a coding tool's error that says what went wrong, for a place that has room for a line: "Error: ENOENT: no such
 * file or directory, open 'package.json'" out of Node's whole report, never its first line ("node:fs:624"), a source line, a caret
 * or a stack frame. The whole error stays where it is kept (the session's feed, one click away on Needs you).
 */
export function errorHead(text: string, max = 200): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // An exception's own line first (Python's comes last, after its Traceback), then any line that says it is an error.
  const said = lines.find((l) => /^(?:[A-Z][\w.]*(?:Error|Exception)\b|Error\b)/.test(l)) ?? lines.find((l) => /^(?:panic:|fatal:|error:|npm ERR!|Traceback\b)/i.test(l));
  // Else the first line that is words: not a place in a file, a stack frame, a caret, a brace, an error's fields or Node's version.
  const noise = (l: string) => /^at\s|^node:[\w/]+:\d+$|^\S+:\d+(?::\d+)?$|^[\^~\s]+$|^[{}[\]]|^Node\.js v\d|^(?:errno|code|syscall|path):/.test(l);
  const words = lines.find((l) => !noise(l));
  const line = said ?? words ?? lines[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
