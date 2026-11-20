/**
 * Friday's palette in the IDE (Arun, 2026-11-19, wave 4: "Friday command palette: one key for every Friday action from the IDE: new
 * chat, hand off, review, race, switch tool, open a session, search"). The IDE's quick pick (src/vscode-ext/friday/palette.js) runs
 * some actions itself (an IDE command) and hands the rest to Friday's page as a key "action" with one of these ids, over
 * /api/vscode/key; the page runs it (src/client/ide/palette-run.ts). One list of the ids, so the server only passes on what the page
 * knows. The extension is packed apart from src/, so it keeps its own copy of the ids: test/vscode-palette.test.ts holds them equal.
 */
export const PAGE_ACTIONS = ["new-chat", "race", "self-review", "send-to-agents", "hand-to-mate", "switch-tool", "search", "settings", "open-session", "open-folder"] as const;
export type PageAction = (typeof PAGE_ACTIONS)[number];
export const isPageAction = (v: unknown): v is PageAction => typeof v === "string" && (PAGE_ACTIONS as readonly string[]).includes(v);

/** What Friday's page tells the IDE's palette about itself (POST /api/vscode/palette, read back with the IDE's token). */
export interface PaletteFeed {
  /** Agents sessions, newest first: what "Open an Agents session" lists. */
  agents: { sid: string; invite: string; title: string; at: number }[];
  /** The chat Code's column shows for its folder, or null when it shows none (a new chat's box, nothing started). */
  chat: { sid: string; folder: string; title: string } | null;
}

/** A feed as the server keeps it: only what has the right shape, cut to size. */
export function cleanFeed(body: unknown): PaletteFeed {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const agents = (Array.isArray(b.agents) ? b.agents : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({ sid: text(x.sid, 64), invite: text(x.invite, 2000), title: text(x.title, 200), at: typeof x.at === "number" && Number.isFinite(x.at) ? x.at : 0 }))
    .filter((x) => x.sid && x.invite)
    .slice(0, 20);
  const c = b.chat && typeof b.chat === "object" ? (b.chat as Record<string, unknown>) : null;
  const chat = c && text(c.sid, 64) ? { sid: text(c.sid, 64), folder: text(c.folder, 1000), title: text(c.title, 200) } : null;
  return { agents, chat };
}
