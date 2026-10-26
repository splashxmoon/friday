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
