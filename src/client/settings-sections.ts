import type { Icon } from "./icons.js";

/**
 * Settings' sections, by name, and how a search or an old link finds one: what the app's start needs of Settings (App's routes,
 * the command palette), kept apart from the page itself so that loads only when Settings opens (Settings.tsx, lazy in App).
 *
 * Grouped by what somebody comes to change (Arun, 2026-11-08: "regroup tabs and add proper categories for users to find
 * everything quickly… think about this from a user stand point"): the app itself (General), how the agents work (Agents), the
 * machines they run on (Computers), the services Friday talks to (Connections), the team (Workspace), what leaves this computer
 * and the settings file (Privacy & data), and updates and help (Help). One thing a tab; nothing parked where it happened to fit.
 */
export type Group = "General" | "Agents" | "Computers" | "Connections" | "Workspace" | "Privacy & data" | "Help";

export interface SectionDef {
  id: string;
  label: string;
  group: Group;
  icon: Parameters<typeof Icon>[0]["name"];
  /** One sentence under the title: what this section is for. */
  blurb: string;
  /** What is in it, for the search box: a setting is found by what it does, not only by which section it is in. */
  keywords: string;
}

export const SECTIONS: SectionDef[] = [
  // ── General: you, and how Friday looks and talks to you ──
  // No Profile on your own computer: there is no account (Arun, 2026-10-26: "get rid of ... the profile page in settings").
  {
    id: "appearance",
    label: "Appearance",
    group: "General",
    icon: "sun",
    blurb: "How Friday looks on this device.",
    // Each thing on its page, by the word on it: a search for accent or layout found nothing (audit e2e, Arun 2026-11-04).
    keywords:
      "theme dark light mode color colour look system size zoom text font scale motion animation accent contrast layout session focus classic",
  },
  {
    id: "notifications",
    label: "Notifications",
    group: "General",
    icon: "bell",
    blurb:
      "Only when something waits on you: a question, a finished run, a failure. Banners come while Friday's window is hidden; the chime, if you want it, either way.",
    keywords: "alerts away banner chime sound permission",
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    group: "General",
    icon: "keyboard",
    blurb: "Every key that does something.",
    keywords: "keyboard keys hotkeys command",
  },

  // ── Agents: which tools and models do the work, what they remember, what they may touch, and how much they have used ──
  {
    id: "coding-tools",
    label: "Coding tools",
    group: "Agents",
    icon: "code",
    blurb: "The coding tools on this computer, and the accounts each one uses.",
    keywords: "coding tools tool claude code codex cursor copilot opencode antigravity agy devin junie kiro droid amp muse sign in sign out install account accounts login acp other agent command fewer more",
  },
  {
    id: "own-models",
    label: "Your models",
    group: "Agents",
    icon: "key",
    blurb:
      "Your own API keys, and models running on this computer, for Friday's agent.",
    keywords: "own model api key byok bring your own ollama lm studio local openai anthropic gemini groq deepseek mistral friday code",
  },
  {
    id: "memory",
    label: "Memory",
    group: "Agents",
    icon: "bulb",
    blurb: "What your agents learned in each repository.",
    keywords: "memory project lessons learned corrections checks brain remember forget",
  },
  // What agents may do on the computer beyond its folders: see the screen and use the mouse and keyboard (ComputerUse.tsx). It
  // sat under Computer, beside keeping it awake; it is a permission somebody comes looking for as one.
  {
    id: "permissions",
    label: "Permissions",
    group: "Agents",
    icon: "shield",
    blurb: "What agents may do on this computer beyond the folders you give them.",
    keywords: "permission permissions computer use screen mouse keyboard control click type allow access safety",
  },
  // Not a section: a row to the Usage page, so a search for usage, a budget or a limit finds it (audit REST-21, Arun 2026-11-04).
  // App.tsx opens the page for it.
  {
    id: "usage-limits",
    label: "Usage & limits",
    group: "Agents",
    icon: "usage",
    blurb: "Your coding tools' limits, what your plans cost, and the tokens your agents used.",
    keywords: "usage limits limit budget spend cost price plan tokens 5-hour weekly alert reset heatmap busiest hours history",
  },

  // ── Computers: this one, and the others agents can run on ──
  // "Computer & coding tools" was one page; now the computer and the tools on it are two (Arun, 2026-11-04: "split up the coding
  // tools and computer in the settings into two seperate tabs"). Old links to "computer" land on the computer, "tools" on the tools.
  {
    id: "computer",
    label: "This computer",
    group: "Computers",
    icon: "server",
    blurb: "The computer your coding agents run on, and keeping it awake while they do.",
    keywords: "computer machine connect connected link folder runner keep awake sleep",
  },
  // Your other computers, linked to this one's Friday (Computers.tsx): only on this computer's Friday.
  {
    id: "other-computers",
    label: "Other computers",
    group: "Computers",
    icon: "columns",
    blurb: "Run agents on another computer of yours, or use this one from another Friday.",
    keywords: "other computers machine remote ssh tailscale wi-fi link pair add computer hub runs on server",
  },

  // ── Connections: the services Friday works with ──
  {
    id: "github",
    label: "GitHub",
    group: "Connections",
    icon: "gitPullRequest",
    blurb: "The GitHub login your agents clone, push and open pull requests with.",
    keywords: "github git login sign in pull request pr repos clone push token gh",
  },
  // Only on this computer's Friday: the hosted one has its own MCP server, for apps with a token (public-mcp.ts).
  {
    id: "outside-agents",
    label: "Other agents (MCP)",
    group: "Connections",
    icon: "agent",
    blurb: "Let Claude Code, Codex, Cursor and other agents on this computer hand work to Friday.",
    keywords: "mcp server outside other agents let use friday claude code codex cursor hand off delegate start session tools api",
  },

  // ── Workspace: the team, and what it pays ──

  // ── Privacy & data: what leaves this computer, and the settings file ──
  {
    id: "privacy",
    label: "Privacy",
    group: "Privacy & data",
    icon: "eye",
    blurb: "What Friday sends about how it's used, and what it never sends.",
    keywords: "privacy analytics usage share telemetry anonymous data collect send tracking",
  },
  {
    id: "data",
    label: "Backup & reset",
    group: "Privacy & data",
    icon: "download",
    blurb: "Carry your settings to another computer, or start them over.",
    keywords: "export import backup reset restore file defaults start over",
  },

  // ── Help: staying current, and getting help ──
  {
    id: "updates",
    label: "Updates",
    group: "Help",
    icon: "refresh",
    blurb: "Which version you have, newer ones, and what each one changed.",
    keywords: "version update updates release notes what's new whats changelog desktop app restart download",
  },
  {
    id: "help",
    label: "Help & feedback",
    group: "Help",
    icon: "help",
    blurb: "Set this computer up again, or tell us what's broken.",
    keywords: "help feedback bug report issue setup set up onboarding welcome",
  },
];
export const GROUPS: Group[] = ["General", "Agents", "Computers", "Connections", "Workspace", "Privacy & data", "Help"];

/**
 * The sections a search finds: those holding the most of its words. Every word used to be required, so "dark mode" found
 * nothing because no section said "mode"; now a section with more of the words wins, and one word is enough.
 */
export function sectionsMatching<
  T extends { label: string; group: string; blurb: string; keywords: string },
>(list: T[], query: string): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  const scored = list.map((s) => {
    const text = `${s.label} ${s.group} ${s.blurb} ${s.keywords}`.toLowerCase();
    return { s, n: words.filter((w) => text.includes(w)).length };
  });
  const best = Math.max(...scored.map((x) => x.n));
  return best ? scored.filter((x) => x.n === best).map((x) => x.s) : [];
}

/** A section by any name it has had: the old tab names keep working for links and for openSettings("account"). */
export function settingsSection(id: string | null | undefined): string {
  const aliases: Record<string, string> = {
    account: "appearance",
    team: "members",
    people: "members",
    machine: "computer",
    computers: "other-computers",
    tools: "coding-tools",
    about: "updates",
    feedback: "help",
    analytics: "privacy",
  };
  const s = aliases[id ?? ""] ?? id ?? "";
  return SECTIONS.some((x) => x.id === s) ? s : "appearance";
}
