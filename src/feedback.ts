/**
 * Send feedback: a new issue on the open-source repository, its form started for the person (Arun, 2026-10-30: 'A "Send
 * feedback" link in the app that opens a GitHub issue'). The app's sidebar, Settings › About and the Mac app's Help menu all
 * open this.
 *
 * It says which Friday and which system, so a report can be acted on, and nothing else: no name, no folder, no session. The
 * person reads all of it on GitHub before anything is sent, and sends it from their own account.
 */
export const ISSUES = "https://github.com/splashxmoon/friday/issues/new";

/** "macOS", "Windows" or "Linux", from Node's process.platform or the browser's navigator.platform. */
export function osName(platform: string): string {
  if (/^darwin$|mac/i.test(platform)) return "macOS";
  if (/^win32$|^win/i.test(platform)) return "Windows";
  if (/linux|freebsd|openbsd/i.test(platform)) return "Linux";
  return platform || "unknown";
}

export function feedbackUrl({ version, os, app }: { version: string; os: string; app: boolean }): string {
  const body = [
    "**What happened**",
    "",
    "",
    "**What you expected**",
    "",
    "",
    "**Steps to reproduce**",
    "1. ",
    "",
    "---",
    `Friday ${version || "(version unknown)"} · ${os} · ${app ? "desktop app" : "browser"}`,
  ].join("\n");
  return `${ISSUES}?${new URLSearchParams({ body })}`;
}
