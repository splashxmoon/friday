/**
 * A coding tool's context, as the session's usage card shows it (Arun, 2026-10-21: "fetching the context for the coding tools
 * too and adding it into the usage limit pop over ... with breakdowns ... just like claude code does it").
 *
 * Claude Code says it itself: `/context` is one of its own commands, answered without the model (no tokens), with the model,
 * how much of its window is used, and an estimate by category (system prompt, tools, MCP tools, skills, messages, free space,
 * the autocompact buffer) and by MCP tool. This reads that report.
 */
export interface ToolContext {
  model: string;
  used: number;
  window: number;
  /** In the order Claude Code lists them. */
  categories: { name: string; tokens: number }[];
  /** The MCP servers whose tools take the most, by server, most first. */
  servers: { name: string; tokens: number }[];
  /** When Claude Code said it, in ms: a report kept from before a turn is shown as of then. */
  at?: number;
}

/** "28.4k", "1m", "660", "1.2M" as a number of tokens. */
export function tokensOf(s: string): number {
  const m = s.trim().match(/^([\d.,]+)\s*([km])?$/i);
  if (!m) return 0;
  const n = Number(m[1]!.replace(/,/g, ""));
  const k = m[2]?.toLowerCase() === "m" ? 1_000_000 : m[2]?.toLowerCase() === "k" ? 1000 : 1;
  return Number.isFinite(n) ? Math.round(n * k) : 0;
}

/** The rows of the Markdown table under a `###` heading, as cells. */
function table(md: string, heading: RegExp): string[][] {
  const lines = md.split(/\r?\n/);
  const at = lines.findIndex((l) => /^#{2,4}\s/.test(l) && heading.test(l));
  if (at < 0) return [];
  const rows: string[][] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^#{2,4}\s/.test(l)) break;
    if (!l.trim().startsWith("|")) {
      if (rows.length) break;
      continue;
    }
    const cells = l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    rows.push(cells);
  }
  // The first row is the header.
  return rows.slice(1);
}

/** Claude Code's `/context` report, or null when it isn't one. */
export function parseContextReport(md: string): ToolContext | null {
  const totals = md.match(/\*\*Tokens:\*\*\s*([\d.,]+\s*[km]?)\s*\/\s*([\d.,]+\s*[km]?)/i);
  if (!totals) return null;
  const model = md.match(/\*\*Model:\*\*\s*([^\s*]+)/)?.[1] ?? "";
  const categories = table(md, /usage by category/i)
    .map(([name, tokens]) => ({ name: name ?? "", tokens: tokensOf(tokens ?? "") }))
    .filter((c) => c.name);
  const byServer = new Map<string, number>();
  for (const [, server, tokens] of table(md, /^#+\s*MCP Tools\b/i)) if (server) byServer.set(server, (byServer.get(server) ?? 0) + tokensOf(tokens ?? ""));
  const servers = [...byServer].map(([name, tokens]) => ({ name: name.replace(/^claude_ai_/, "").replace(/_/g, " "), tokens })).sort((a, b) => b.tokens - a.tokens);
  return { model, used: tokensOf(totals[1]!), window: tokensOf(totals[2]!), categories, servers };
}
