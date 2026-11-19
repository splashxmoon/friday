/**
 * Apps Friday itself is registered as, with providers that won't let an app register itself at sign-in (Google, Slack, GitHub,
 * HubSpot, Box, Zendesk, PagerDuty), so a person can connect Gmail or Calendar with one click rather than registering an app of
 * their own (Arun, 2026-11-17: "make it so i can connect gmail without registering my own app").
 *
 * Each is a desktop ("installed") app: its client secret isn't secret, as Google says of desktop apps and as the Google Cloud
 * CLI and rclone ship theirs, and the sign-in is held to PKCE and to a redirect back to this computer (127.0.0.1). The desktop
 * build puts them in from a file on the building computer, never from this source; FRIDAY_<KEY>_CLIENT_ID and
 * FRIDAY_<KEY>_CLIENT_SECRET on this computer stand in for them.
 * A provider with none falls back to the person's own app (mcp-directory.tsx), as before.
 */

export type ProviderKey = "GOOGLE" | "SLACK" | "GITHUB" | "HUBSPOT" | "BOX" | "ZENDESK" | "PAGERDUTY" | "LINEAR";

/** Put in by the desktop build from a file on the building computer (scripts/build-local-desktop.mts); absent from source. */
declare const __FRIDAY_BUILT_IN_APPS__: Partial<Record<ProviderKey, { id: string; secret?: string }>> | undefined;

/** Friday's own apps, by provider: the build's, when it was given some; none when run from source. */
const BUILT_IN: Partial<Record<ProviderKey, { id: string; secret?: string }>> = typeof __FRIDAY_BUILT_IN_APPS__ !== "undefined" ? __FRIDAY_BUILT_IN_APPS__ : {};

/** Which provider a server's sign-in belongs to, by its address. */
export function providerOf(url: string): ProviderKey | null {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (/(^|\.)googleapis\.com$/.test(host)) return "GOOGLE";
  if (/(^|\.)slack\.com$/.test(host)) return "SLACK";
  if (/(^|\.)githubcopilot\.com$|(^|\.)github\.com$/.test(host)) return "GITHUB";
  if (/(^|\.)hubspot\.com$/.test(host)) return "HUBSPOT";
  if (/(^|\.)box\.com$/.test(host)) return "BOX";
  if (/(^|\.)zendesk\.com$/.test(host)) return "ZENDESK";
  if (/(^|\.)pagerduty\.com$/.test(host)) return "PAGERDUTY";
  return null;
}

/** Friday's own app for a provider, when it has one: this computer's settings first, then the build's. */
export function builtInApp(key: ProviderKey | null): { id: string; secret?: string } | null {
  if (!key) return null;
  const id = process.env[`FRIDAY_${key}_CLIENT_ID`]?.trim();
  if (id) return { id, ...(process.env[`FRIDAY_${key}_CLIENT_SECRET`]?.trim() ? { secret: process.env[`FRIDAY_${key}_CLIENT_SECRET`]!.trim() } : {}) };
  return BUILT_IN[key]?.id ? BUILT_IN[key]! : null;
}

/** The providers Friday can sign in to with its own app now, for the page. */
export const builtInKeys = (): ProviderKey[] => (["GOOGLE", "SLACK", "GITHUB", "HUBSPOT", "BOX", "ZENDESK", "PAGERDUTY"] as const).filter((k) => !!builtInApp(k));

/**
 * Friday's own Linear app (channels/linear-agent.ts, spec 08): public, signed in with PKCE and no secret, so "Connect Linear" is
 * one button rather than an app of the person's own. Not an MCP provider, so not among builtInKeys.
 */
export const builtInLinear = () => builtInApp("LINEAR");
