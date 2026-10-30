import { feedbackUrl, osName } from "../feedback.js";
import { openOutside } from "./openOutside.js";

let version: Promise<string> | null = null;

/** Open a new GitHub issue in the person's own browser, its form started with this Friday's version and system (../feedback.ts). */
export async function sendFeedback(): Promise<void> {
  const asked = (version ??= fetch("/api/version", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((b: { version?: string } | null) => b?.version ?? "")
    .catch(() => ""));
  const app = typeof window !== "undefined" && !!window.fridayDesktop;
  const platform = window.fridayDesktop?.platform ?? navigator.platform;
  await openOutside(feedbackUrl({ version: await asked, os: osName(platform), app }));
}
