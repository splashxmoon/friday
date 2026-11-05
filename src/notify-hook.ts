import type { Redis } from "ioredis";
import type { Attention, AttentionKind } from "./attention.js";
import { publicFetch } from "./agent/fetch-url.js";
import { mcpPrivateAllowed } from "./private-net.js";

/**
 * "Needs you", sent somewhere you already look.
 *
 * The app notifies while it is open. The moment that matters is the other one: the agent asked you something at four
 * and you were in a meeting with the laptop shut. A person pastes one URL (an ntfy topic for their phone, a chat's incoming
 * webhook, or anything that takes a POST) and each new thing waiting on them is posted there as one line, with a link back
 * where the link opens from anywhere (the hosted service; this computer's own address would not).
 */

export class NotifyHooks {
  /** Who has one, so a server with none set does no work per event. */
  private who = new Set<string>();

  constructor(
    private redis: Redis,
    private prefix: string,
  ) {}

  private key(userId: string) {
    return `${this.prefix}notify-hook:${userId}`;
  }

  /** Called once at start: the people with a hook, so events can be skipped for everyone else. */
  async load(): Promise<void> {
    const keys = await this.redis.keys(`${this.prefix}notify-hook:*`);
    for (const k of keys) this.who.add(k.slice(this.key("").length));
  }

  has(userId: string): boolean {
    return this.who.has(userId);
  }

  get any(): boolean {
    return this.who.size > 0;
  }

  async get(userId: string): Promise<string> {
    return (await this.redis.get(this.key(userId))) ?? "";
  }

  async set(userId: string, url: string): Promise<void> {
    if (url) {
      await this.redis.set(this.key(userId), url);
      this.who.add(userId);
    } else {
      await this.redis.del(this.key(userId));
      this.who.delete(userId);
    }
  }
}

/** A place a POST can go: https anywhere, or http on this machine for trying it out (not on a hosted server). */
export function hookUrlOk(url: string): boolean {
  if (url.length > 500) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && mcpPrivateAllowed() && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
}

const WHY: Record<AttentionKind | "done", string> = { approval: "wants your OK", question: "asked you something", ask: "asked you something", control: "control requested", handover: "handed to you", stopped: "stopped", mention: "mentioned you", done: "finished" };

/**
 * One line, in both fields chat webhooks read (`text` for some, `content` for Discord), plus the parts on their own for a
 * receiver that builds its own message: the session's name, why, and the first words of it.
 */
export function hookPayload(item: Pick<Attention, "title" | "text" | "command"> & { kind: AttentionKind | "done" }, link: string): HookPayload {
  // The command an agent asks to run stays in the app: a topic or a channel may be read by more people than the session is.
  const said = (item.command ? item.text.replace(/ wants to run `[\s\S]*$/, " wants to run a command") : item.text).slice(0, 300);
  const text = `${item.title} — ${WHY[item.kind]}: ${said}${link ? `\n${link}` : ""}`;
  return { text, content: text, session: item.title, why: WHY[item.kind], said, ...(link ? { link } : {}), at: new Date().toISOString() };
}

export interface HookPayload {
  text: string;
  content: string;
  session: string;
  why: string;
  said: string;
  link?: string;
  at: string;
}

/**
 * ntfy (ntfy.sh, or a server of one's own named ntfy.*) shows a JSON body as raw JSON on the phone, so it gets what it reads:
 * the message as plain text, the session as the title, and the link as what a tap opens.
 */
export function isNtfy(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "ntfy.sh" || h.startsWith("ntfy.");
  } catch {
    return false;
  }
}

function request(url: string, payload: object): RequestInit {
  const p = payload as Partial<HookPayload>;
  if (isNtfy(url) && typeof p.said === "string") {
    // Header values must be Latin-1: anything else in a session's name would make fetch refuse the whole post.
    const latin = (v: string) => v.replace(/[^\x20-\x7e\xa0-\xff]/g, "").slice(0, 200);
    const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8", title: latin(`${p.session ?? "Friday"}: ${p.why ?? ""}`) };
    if (p.link) headers.click = p.link;
    return { method: "POST", headers, body: p.said };
  }
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
}

/** Post it and say whether it was taken. Never throws: a webhook that is down is not the session's problem. */
/**
 * Posts a notification. On a hosted server the address and every redirect must be on the public internet: anyone can set a
 * hook, and the test button answered yes or no, which turned it into a way to probe the server's own network (Security
 * AUDIT APP-9). A laptop or the desktop app may still post to localhost.
 */
export async function postHook(url: string, payload: object, fetchImpl: typeof fetch = mcpPrivateAllowed() ? fetch : publicFetch): Promise<boolean> {
  try {
    const r = await fetchImpl(url, { ...request(url, payload), signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}
