import type { AgentNow } from "./agent-state.js";

// The sidebar's row says each agent in these words, and the sidebar is in every page's first load: kept apart from agent-state.ts,
// whose plain-words error rules wait for the session screen (test/client-bundle.test.ts).

/** Lowercased for after a name and a dot ("Rio · waiting on Ada"), names left as they are. */
export const lowerWord = (word: string): string => word.replace(/^[A-Z](?=[a-z ])/, (c) => c.toLowerCase());

/** One line for one agent, its name first: "Rio hit an error · too many requests, try again in a minute", "Rio · waiting on Ada". */
export function agentLine(name: string, a: AgentNow): string {
  if (a.phase === "failed") return `${name} hit an error · ${a.error?.plain ?? "something went wrong"}`;
  return `${name} · ${lowerWord(a.word)}`;
}
