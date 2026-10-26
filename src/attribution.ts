import { MAIN_LANE, type SessionEvent } from "./types.js";

/**
 * Who wrote each added line of a change: the agent, or a person by hand (Arun, 2026-10-25, tier 2: "AI-versus-human line
 * attribution in diffs").
 *
 * The runner sends the folder's whole change set whenever it moves (agent.diff): during a run as the agent edits, and between
 * runs when somebody saves a file from the editor, types in the terminal or edits in another tool. A change set that lands
 * while the lane's run is going is the agent's; one that lands between runs carries the person's edits, read as the added
 * lines that weren't in the agent's last set. Lines are told apart by their text, which is what a diff has; two identical
 * lines are the same line to it, and that is good enough for a mark in the gutter.
 */

export interface FileAttribution {
  /** Added lines written by hand, by their text. */
  human: Set<string>;
  /** Who, when the log says: the person whose save came before the change set. */
  by?: string;
}

export type Attribution = Map<string, FileAttribution>;

/** The added lines of a unified diff, by text. */
export function addedLines(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) if (line.startsWith("+") && !line.startsWith("+++")) out.push(line.slice(1));
  return out;
}

const counts = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};

/** Who wrote what, per file, as the lane's log tells it. */
export function attributionOf(events: SessionEvent[], lane = MAIN_LANE): Attribution {
  let running = false;
  let lastHuman: string | undefined;
  /** The agent's latest set per file: the added lines of the last change set that landed during a run. */
  const agent = new Map<string, Map<string, number>>();
  const out: Attribution = new Map();
  for (const e of events) {
    if ((e.lane ?? MAIN_LANE) !== lane) continue;
    const b = e.body;
    if (b.type === "run.started") running = true;
    else if (b.type === "run.ended") running = false;
    else if (b.type === "folder.edited" && e.actor.kind === "human") lastHuman = e.actor.name;
    else if (b.type === "agent.diff") {
      const seen = new Set<string>();
      for (const f of b.files) {
        seen.add(f.path);
        const added = addedLines(f.patch);
        if (running) {
          agent.set(f.path, counts(added));
          out.delete(f.path);
          continue;
        }
        // Between runs: what is here now that the agent's set didn't have is the person's.
        const was = agent.get(f.path) ?? new Map<string, number>();
        const human = new Set<string>();
        const left = new Map(was);
        for (const line of added) {
          const n = left.get(line) ?? 0;
          if (n > 0) left.set(line, n - 1);
          else human.add(line);
        }
        if (human.size) out.set(f.path, { human, ...(lastHuman ? { by: lastHuman } : {}) });
        else out.delete(f.path);
      }
      // A file gone from the change set has nothing to attribute.
      for (const p of [...out.keys()]) if (!seen.has(p)) out.delete(p);
      for (const p of [...agent.keys()]) if (!seen.has(p)) agent.delete(p);
    }
  }
  return out;
}

/** Whether an added line of this file was written by hand. */
export function byHand(attr: Attribution, path: string, text: string): boolean {
  return attr.get(path)?.human.has(text) ?? false;
}

/** "3 lines by hand", or "" when none: for a file's header. */
export function handWord(attr: Attribution, path: string): string {
  const n = attr.get(path)?.human.size ?? 0;
  return n ? `${n} line${n === 1 ? "" : "s"} by hand${attr.get(path)?.by ? ` (${attr.get(path)!.by})` : ""}` : "";
}
