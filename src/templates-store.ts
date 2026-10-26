import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import type { PromptTemplate } from "./template-slots.js";

/**
 * The prompts a team has saved.
 *
 * Kept per workspace. Each is either the saver's own or shared with everyone
 * in it, and only the person who saved one can delete it: a shared template is
 * something the team leans on, and it should not vanish because somebody else
 * was tidying.
 */
export class TemplateError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX = 40;

export class TemplateRegistry {
  constructor(
    private redis: Redis,
    private prefix: string,
  ) {}

  private get key() {
    return `${this.prefix}templates`;
  }

  private async all(): Promise<PromptTemplate[]> {
    return Object.values(await this.redis.hgetall(this.key)).map((v) => JSON.parse(v) as PromptTemplate);
  }

  /** Everything this person can use: the workspace's shared ones, and their own. */
  async listFor(userId: string): Promise<PromptTemplate[]> {
    return (await this.all()).filter((t) => t.shared || t.ownerId === userId).sort((a, b) => a.label.localeCompare(b.label));
  }

  async create(user: { id: string; name: string }, input: { label?: unknown; prompt?: unknown; shared?: unknown; agentId?: unknown; allow?: unknown }): Promise<PromptTemplate> {
    const label = String(input.label ?? "").trim().slice(0, 40);
    const prompt = String(input.prompt ?? "").trim().slice(0, 2000);
    if (!label) throw new TemplateError(400, "Give the template a name.");
    if (prompt.length < 8) throw new TemplateError(400, "Write the prompt it should start from.");
    const all = await this.all();
    if (all.length >= MAX) throw new TemplateError(400, `A workspace keeps ${MAX} templates. Delete some you no longer use.`);
    const agentId = typeof input.agentId === "string" && input.agentId ? input.agentId.slice(0, 40) : undefined;
    const allow = Array.isArray(input.allow) ? input.allow.filter((a): a is string => typeof a === "string" && !!a.trim()).map((a) => a.trim().slice(0, 200)).slice(0, 40) : [];
    const t: PromptTemplate = { id: randomBytes(5).toString("base64url"), label, prompt, team: true, shared: input.shared === true, ownerId: user.id, ownerName: user.name, ...(agentId ? { agentId } : {}), ...(allow.length ? { allow } : {}) };
    await this.redis.hset(this.key, t.id, JSON.stringify(t));
    return t;
  }

  async remove(userId: string, id: string): Promise<void> {
    const v = await this.redis.hget(this.key, id);
    if (!v) throw new TemplateError(404, "That template is already gone.");
    const t = JSON.parse(v) as PromptTemplate;
    if (t.ownerId !== userId) throw new TemplateError(403, `Only ${t.ownerName ?? "its owner"} can delete that template.`);
    await this.redis.hdel(this.key, id);
  }
}
