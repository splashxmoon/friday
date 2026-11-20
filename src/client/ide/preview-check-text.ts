// What "Fix with Friday" asks of the agent when a preview check found console errors (Arun, 2026-11-19, wave 3: "Preview checks").

export function fixErrorsText(pages: { path: string; errors: string[] }[]): string {
  const lines: string[] = [];
  for (const p of pages) if (p.errors.length) lines.push(`${p.path}`, ...p.errors.map((e) => `  - ${e}`));
  return [
    "After my last change I checked the app in the preview, and its console logged errors:",
    "",
    ...lines,
    "",
    "Find what causes them and fix it. Run the page again and tell me when the console is clean.",
  ].join("\n");
}

/** "2 pages", "1 page". */
export const pagesWord = (n: number): string => `${n} page${n === 1 ? "" : "s"}`;

/** The one line a finished check says: how many pages, and whether the console was clean. */
export function checkSummary(pages: { errors: string[]; consoleChecked: boolean; failed?: string }[]): { text: string; tone: "ok" | "bad" | "none" } {
  const n = pages.reduce((a, p) => a + p.errors.length, 0);
  const read = pages.length > 0 && pages.every((p) => p.consoleChecked);
  if (n > 0) return { text: `${n} console error${n === 1 ? "" : "s"}`, tone: "bad" };
  // A page that couldn't be looked at is no clean console: said apart from errors, which are the app's own.
  const failed = pages.filter((p) => p.failed).length;
  if (failed > 0) return { text: failed === pages.length ? "Couldn't look at the page" : `${failed} of ${pagesWord(pages.length)} couldn't be looked at`, tone: "none" };
  return read ? { text: "No console errors", tone: "ok" } : { text: "Console not read", tone: "none" };
}
