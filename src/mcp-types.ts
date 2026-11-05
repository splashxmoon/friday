/** A connected MCP server, as the pages see it (mcp.ts keeps the connections). */
export interface McpConnection {
  id: string;
  name: string;
  url: string;
  token?: string;
  /** Signed in through the browser rather than with a pasted token. */
  oauth?: boolean;
  enabled: boolean;
  createdAt: number;
  /** Who connected it: added it, or last signed it in or gave it its token. Unknown on one added before this was kept. */
  addedBy?: { id: string; name: string };
  /**
   * Whoever connected it left the workspace (offboard.ts): its credentials were theirs, so they are dropped and it is used by
   * nobody until an admin reconnects it as themself (signs in again, or gives it a token) or removes it.
   */
  left?: { person: { id: string; name: string }; by: { id: string; name: string }; at: number };
  /** Who started the sign-in under way: they become `addedBy` once it completes. */
  signingIn?: { id: string; name: string };
}

export interface McpToolInfo {
  name: string;
  description: string;
  readOnly: boolean;
}

export interface McpStatus {
  state: "connected" | "error" | "disabled" | "unknown";
  error?: string;
  tools: McpToolInfo[];
  checkedAt?: number;
}

/** What the browser sees: never the token. */
export type McpPublic = Omit<McpConnection, "token"> & { hasToken: boolean; status: McpStatus };
