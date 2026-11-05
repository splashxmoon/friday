// Its own file so what needs only this rule (a webhook post, notify-hook.ts) doesn't bring every MCP sign-in along with it.
/**
 * Whether connections may reach private addresses (localhost, 10.x, 169.254.169.254 and the like). On a laptop or the
 * desktop app they may: a local MCP server is an ordinary thing to connect. On a hosted server they may not, or anyone who
 * signs up could point it at the server's own network (Security AUDIT APP-2). MCP_PRIVATE=allow|block decides it outright.
 */
export function mcpPrivateAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MCP_PRIVATE === "allow") return true;
  if (env.MCP_PRIVATE === "block") return false;
  return env.NODE_ENV !== "production" || env.FRIDAY_LOCAL_RUNNER === "1";
}
