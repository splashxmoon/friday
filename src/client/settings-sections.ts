import type { Icon } from "./icons.js";

/**
 * Settings' sections, by name, and how a search or an old link finds one: what the app's start needs of Settings (App's routes,
 * the command palette), kept apart from the page itself so that loads only when Settings opens (Settings.tsx, lazy in App).
 */
export type Group = "You" | "Workspace" | "This computer" | "More";

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
  // No Profile on your own computer: there is no account (Arun, 2026-10-26: "get rid of ... the profile page in settings").
  {
    id: "appearance",
    label: "Appearance",
    group: "You",
    icon: "sun",
    blurb: "How Friday looks on this device.",
    // Each thing on its page, by the word on it: a search for accent or layout found nothing (audit e2e, Arun 2026-11-04).
    keywords:
      "theme dark light mode color colour look system size zoom text font scale motion animation accent contrast layout session focus classic",
  },
  {
    id: "notifications",
    label: "Notifications",
    group: "You",
    icon: "bell",
    blurb:
      "Only when something waits on you: a question, a finished run, a failure. Banners come while Friday's window is hidden; the chime, if you want it, either way.",
    keywords: "alerts away banner chime sound permission",
  },
  // Not a section: a row to the Usage page, so a search for usage, a budget or a limit finds it (audit REST-21, Arun 2026-11-04).
  // App.tsx opens the page for it.
  {
    id: "usage-limits",
    label: "Usage & limits",
    group: "You",
    icon: "usage",
    blurb: "Your coding tools' limits, what your plans cost, and the tokens your agents used.",
    keywords: "usage limits limit budget spend cost price plan tokens 5-hour weekly alert reset heatmap busiest hours history",
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    group: "You",
    icon: "keyboard",
    blurb: "Every key that does something.",
    keywords: "keyboard keys hotkeys command",
  },
  {
    id: "memory",
    label: "Memory",
    group: "You",
    icon: "bulb",
    blurb: "What your agents learned in each repository.",
    keywords: "memory project lessons learned corrections checks brain remember forget",
  },
  {
    id: "computer",
    label: "Computer & coding tools",
    group: "This computer",
    icon: "plug",
    blurb: "The computer your coding agents run on, and the tools on it.",
    keywords: "computer machine connect link claude code codex cursor sign in install account folder runner acp github git ssh keep awake phone iphone mobile tailscale other computers",
  },
  {
    id: "own-models",
    label: "Your models",
    group: "This computer",
    icon: "key",
    blurb:
      "Your own API keys, and models running on this computer, for Friday's agent.",
    keywords: "own model api key byok bring your own ollama lm studio local openai anthropic gemini groq deepseek mistral friday code",
  },
  // Only on this computer's Friday: the hosted one has its own MCP server, for apps with a token (public-mcp.ts).
  {
    id: "outside-agents",
    label: "Let other agents use Friday",
    group: "This computer",
    icon: "agent",
    blurb: "Claude Code, Codex, Cursor and other agents on this computer handing work to Friday.",
    keywords: "mcp server outside agents claude code codex cursor hand off delegate start session tools api",
  },
  {
    id: "data",
    label: "Data & backup",
    group: "More",
    icon: "download",
    blurb: "Carry your settings to another computer, or start them over.",
    keywords:
      "export import backup reset file analytics usage privacy share telemetry",
  },
  {
    id: "about",
    label: "About",
    group: "More",
    icon: "help",
    blurb: "Updates, release notes and setup.",
    keywords: "version update release notes desktop app welcome setup set up onboarding what's new whats changelog feedback bug report",
  },
];
export const GROUPS: Group[] = ["You", "Workspace", "This computer", "More"];

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
    tools: "computer",
  };
  const s = aliases[id ?? ""] ?? id ?? "";
  return SECTIONS.some((x) => x.id === s) ? s : "appearance";
}
