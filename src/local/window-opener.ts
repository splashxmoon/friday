/**
 * A thread brought up in Friday's window, from somewhere that isn't the window (spec 11: Slack's "Open in Friday" button, which
 * comes down Slack's socket to this computer rather than as a link, so nothing that opens the computer ever leaves it). The
 * desktop app sets the opener once its window can be made (desktop.ts); a Friday run without a window (tests, `friday serve`)
 * has none, and opening says so.
 */
let opener: ((sid: string) => boolean) | null = null;

export function setWindowOpener(f: ((sid: string) => boolean) | null): void {
  opener = f;
}

/** Whether a window took it. */
export function openInWindow(sid: string): boolean {
  return opener ? opener(sid) : false;
}
