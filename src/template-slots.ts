/**
 * Prompts with blanks in them.
 *
 * A template is a sentence somebody has already worked out how to say, with the
 * parts that change marked `{{like this}}`. Starting from one means answering
 * the blanks, not remembering the sentence — and saving your own means writing
 * the sentence once.
 */

const SLOT = /\{\{\s*([^{}]{1,40}?)\s*\}\}/g;

/** The blanks in a prompt, once each, in the order they first appear. */
export function slotsOf(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(SLOT)].map((m) => m[1]!.trim()))];
}

/** The prompt with each blank replaced by what was typed for it; an empty answer leaves the blank visible so it is not lost. */
export function fillSlots(prompt: string, values: Record<string, string>): string {
  return prompt.replace(SLOT, (whole, key: string) => values[key.trim()]?.trim() || whole);
}

export interface PromptTemplate {
  id: string;
  label: string;
  prompt: string;
  /** Saved by a person, as opposed to shipped. */
  team?: boolean;
  /** Whether everyone in the workspace sees it, or only the person who saved it. */
  shared?: boolean;
  ownerId?: string;
  ownerName?: string;
  /** Saved from a session: the agent it ran and the commands allowed in advance come along with the prompt. */
  agentId?: string;
  allow?: string[];
}
