import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { EngineTool } from "../types.js";

/**
 * Whether a coding tool on this computer runs on a key its owner pays for by use (an Anthropic or OpenAI API key, or a cloud
 * provider's) or on a person's own plan (Claude Free, Pro or Max; a ChatGPT plan; Cursor's, Copilot's and the rest).
 *
 * The answer decides whose work it may take (src/own-plan.ts). Anthropic's terms keep a personal Claude plan to its owner's own
 * use: a product may not "route requests through Free, Pro, or Max plan credentials on behalf of their users", and the plans'
 * limits "assume ordinary, individual usage" (code.claude.com/docs/en/legal-and-compliance, read 2026-10-27). OpenAI's terms say
 * the same of a ChatGPT plan. A key, set up by its owner for their own team, is theirs to share (the same page).
 *
 * Only the setting is read, never a key or a token: whether one is configured, not what it is. Anything not plainly a key is a
 * personal plan, so a mistake here keeps an account to its owner rather than opening it to a session.
 */
export async function usesApiKey(tool: EngineTool | undefined, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const set = (k: string) => !!env[k]?.trim();
  const on = (k: string) => /^(1|true|yes)$/i.test(env[k]?.trim() ?? "");
  if (tool === "claude") {
    // Claude Code takes a key from its environment before any sign-in, or runs on Bedrock, Vertex or Foundry.
    if (set("ANTHROPIC_API_KEY") || set("ANTHROPIC_AUTH_TOKEN") || on("CLAUDE_CODE_USE_BEDROCK") || on("CLAUDE_CODE_USE_VERTEX") || on("CLAUDE_CODE_USE_FOUNDRY")) return true;
    // Or from a helper its settings name (apiKeyHelper), in its own folder for this account.
    const dir = env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
    const helper = await readFile(path.join(dir, "settings.json"), "utf8")
      .then((t) => !!(JSON.parse(t) as { apiKeyHelper?: unknown }).apiKeyHelper)
      .catch(() => false);
    return helper;
  }
  if (tool === "codex") {
    // Codex signed in with an API key keeps it in auth.json with no ChatGPT tokens beside it; with a ChatGPT plan, the tokens.
    const file = path.join(env.CODEX_HOME || path.join(homedir(), ".codex"), "auth.json");
    return readFile(file, "utf8")
      .then((t) => {
        const a = JSON.parse(t) as { OPENAI_API_KEY?: unknown; tokens?: unknown; auth_mode?: unknown };
        if (typeof a.auth_mode === "string") return /api/i.test(a.auth_mode);
        return typeof a.OPENAI_API_KEY === "string" && !!a.OPENAI_API_KEY && !a.tokens;
      })
      .catch(() => false);
  }
  return false;
}
