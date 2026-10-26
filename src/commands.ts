import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

/**
 * Saved commands: a prompt the team keeps and runs with `/name`.
 *
 * The eight built-in asks (`/test`, `/review`…) are the same for everybody. A team has its own: "prepare the release notes
 * the way we write them", "triage this bug using our checklist". A command is only words. Choosing one writes them into the
 * message box where they can be read and changed before sending, so nothing happens that the room cannot see in the message.
 *
 * Two scopes, like memory: yours, which only you see, and the workspace's, which everyone in it can run. Whoever saved a
 * command can change or delete it.
 */

export type CommandScope = "personal" | "workspace";

export interface SavedCommand {
  id: string;
  /** What follows the slash: lowercase letters, digits and dashes. */
  name: string;
  /** A short line for the list. */
  hint: string;
  /** What goes in the box. */
  text: string;
  scope: CommandScope;
  ownerId: string;
  ownerName: string;
  at: number;
}

export class CommandError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Taken: a saved command with one of these names would hide the built-in. Kept in step with the client's list by a test. */
export const BUILTIN_COMMANDS = ["test", "fix", "review", "plan", "explain", "tests", "lint", "commit-msg"];

const MAX_TEXT = 4000;
const MAX_HINT = 80;
/** Per scope and person. */
const MAX_PER_SCOPE = 40;

export const cleanName = (s: unknown): string =>
  String(s ?? "")
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);

export class CommandRegistry {
  constructor(
    private redis: Redis,
    private prefix: string,
  ) {}

  private get key() {
    return `${this.prefix}slash`;
  }

  private async all(): Promise<SavedCommand[]> {
    return Object.values(await this.redis.hgetall(this.key)).map((v) => JSON.parse(v) as SavedCommand);
  }

  /** What this person can run: their own, then the workspace's, by name. */
  async list(userId: string): Promise<SavedCommand[]> {
    return (await this.all()).filter((c) => c.scope === "workspace" || c.ownerId === userId).sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(user: { id: string; name: string }, input: { id?: string; name: unknown; text: unknown; hint?: unknown; scope?: unknown }): Promise<SavedCommand> {
    const name = cleanName(input.name);
    const text = String(input.text ?? "").replace(/\r\n/g, "\n").trim().slice(0, MAX_TEXT);
    if (!name) throw new CommandError(400, "Give it a name: letters, numbers and dashes.");
    if (!text) throw new CommandError(400, "Write what it should say.");
    if (BUILTIN_COMMANDS.includes(name)) throw new CommandError(400, `/${name} is one of the built-in commands. Pick another name.`);
    const scope: CommandScope = input.scope === "workspace" ? "workspace" : "personal";
    const all = await this.all();
    const existing = input.id ? all.find((c) => c.id === input.id) : undefined;
    if (input.id && !existing) throw new CommandError(404, "That command is already gone.");
    if (existing && existing.ownerId !== user.id) throw new CommandError(403, `Only ${existing.ownerName} can change that.`);
    // One name per person at a time: the name is what they type, so two of them would be a coin toss.
    const visible = all.filter((c) => c.id !== existing?.id && (c.scope === "workspace" || c.ownerId === user.id));
    const clash = visible.find((c) => c.name === name);
    if (clash) throw new CommandError(409, clash.ownerId === user.id ? `You already have a /${name}.` : `${clash.ownerName} already shared a /${name} with the workspace.`);
    if (!existing && all.filter((c) => c.ownerId === user.id && c.scope === scope).length >= MAX_PER_SCOPE) throw new CommandError(400, `That's ${MAX_PER_SCOPE} commands. Delete some you no longer use.`);
    const hint = String(input.hint ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_HINT) || text.replace(/\s+/g, " ").slice(0, MAX_HINT);
    const cmd: SavedCommand = { id: existing?.id ?? randomBytes(5).toString("base64url"), name, hint, text, scope, ownerId: user.id, ownerName: user.name, at: Date.now() };
    await this.redis.hset(this.key, cmd.id, JSON.stringify(cmd));
    return cmd;
  }

  async remove(userId: string, id: string): Promise<void> {
    const v = await this.redis.hget(this.key, id);
    if (!v) throw new CommandError(404, "That command is already gone.");
    const c = JSON.parse(v) as SavedCommand;
    if (c.ownerId !== userId) throw new CommandError(403, `Only ${c.ownerName} can delete that.`);
    await this.redis.hdel(this.key, id);
  }
}
