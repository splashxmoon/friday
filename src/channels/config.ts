import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * What Slack and Linear need kept on this computer: their tokens, and what the person picked (which Linear team works in which
 * folder). One file beside Friday's data, this person's alone (0600), as the coding tools' MCP connections are
 * (runner/connections.ts). Nothing of it goes to the page but whether each is connected and what to show.
 */

export interface LinearConfig {
  clientId: string;
  clientSecret?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  /** The app's own user in the Linear workspace, and the workspace. */
  app?: { id: string; name: string; org: string; urlKey: string };
  /** The person at this computer, in Linear: only their asks run straight away. */
  me?: { id: string; name: string };
  /** A Linear team's folder on this computer, by team id: picked once, kept. */
  teams?: Record<string, string>;
  /** Those teams' names, for Settings. */
  teamNames?: Record<string, string>;
  /** When it was connected: sessions older than this are left alone. */
  since?: number;
  /** Sessions waiting for "which project": the ask and the folders offered, kept so a restart doesn't strand them. */
  choosing?: Record<string, { ask: string; folders: string[]; after: string }>;
  /** Signed in with Friday's own Linear app (builtin-apps.ts), not one of the person's. */
  builtIn?: boolean;
}

export interface SlackConfig {
  /** xoxb-: the bot's token. */
  bot: string;
  /** xapp-: the app-level token Socket Mode connects with. */
  app: string;
  team?: { id: string; name: string; url?: string };
  botUser?: string;
  /** The person at this computer, in Slack. */
  me?: { id: string; name: string };
  /** A channel's folder on this computer, by channel id. */
  channels?: Record<string, string>;
  channelNames?: Record<string, string>;
  /** "Needs you" DMs from every thread, not only Slack's (spec 08: off unless turned on). */
  dms?: boolean;
}

export interface ChannelsFile {
  linear?: LinearConfig;
  slack?: SlackConfig;
}

export class ChannelsConfig {
  private cache: ChannelsFile | null = null;

  constructor(readonly file: string) {}

  read(): ChannelsFile {
    if (this.cache) return this.cache;
    try {
      this.cache = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as ChannelsFile) : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  write(next: ChannelsFile): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    if (process.platform !== "win32") chmodSync(this.file, 0o600);
    this.cache = next;
  }

  patch<K extends keyof ChannelsFile>(key: K, v: ChannelsFile[K] | null): void {
    const cur = { ...this.read() };
    if (v === null) delete cur[key];
    else cur[key] = v;
    this.write(cur);
  }
}
