/**
 * A run's stop reason, made fit for a card, a toast or a list line. It can carry a whole file address
 * (file:///C:/Users/…/very/long/folder), shown as the last part of it, the name someone would recognise; and a crashed
 * tool's stack can carry a terminal's colour codes (ESC[90m…ESC[39m), which are dropped rather than shown as junk. Never
 * throws: the text is often clipped, and a cut can land inside a %XX escape, which decodeURIComponent refuses.
 */
// A terminal's control sequences: ESC [ parameters, intermediates, final byte (colours, cursor moves), and a lone ESC.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b/g;

export function shortPaths(text: string): string {
  return text.replace(ANSI, "").replace(/file:\/\/\/[^\s"'<>)]+/g, (url) => {
    const last = url.split(/[\\/]/).filter(Boolean).pop() ?? url;
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  });
}
