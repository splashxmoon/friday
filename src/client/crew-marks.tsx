// A session's agents as small marks in its sidebar row (Sidebar.tsx CrewLine, TeamSessions.tsx): one per agent, its coding tool's
// logo in the tool's own colours, or the face Friday's own agent wears everywhere (agent-face.ts).
import { FACES } from "../agent-face.js";
import { ENGINE_NAMES, type EngineTool } from "../types.js";
import { EngineMark } from "./BrandMarks.js";
import { Mascot } from "./Mascot.js";

/**
 * An agent's name as the lists say it: the main lane's "Main" is its coding tool, or Friday Code when it has none, as the Agent
 * Board names it (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"; the sidebar said "Main", the board
 * "Friday Code" and the rail "Main" for "Claude Code working").
 */
export function agentWord(name: string, tool?: EngineTool | null): string {
  return name === "Main" ? (tool ? ENGINE_NAMES[tool] : "Friday Code") : name;
}

/** The most marks a row shows; the rest are "+N". */
const MARKS_MAX = 5;

/** One agent's mark: its coding tool's, or Friday's agent's own face. */
export function CrewMark({ x }: { x: { tool?: EngineTool | undefined; face?: number | undefined } }) {
  if (x.tool) return <EngineMark tool={x.tool} size={12} />;
  const face = FACES[x.face ?? 0] ?? FACES[0]!;
  return <Mascot kind={face.kind} hue={face.hue} size={12} still className="agent-face" />;
}

/**
 * Several agents' marks in a row, small but visible (Arun, 2026-11-03: "add the icons off the agents working instead of 3 working,
 * make the icons small but visible"), five at most and "+N" for the rest. `names` are each agent's as the row says it, for its tip;
 * `label` says in words what the marks show.
 */
export function CrewTools({ agents, names, label, className = "" }: { agents: { key: string; tool?: EngineTool | undefined; face?: number | undefined }[]; names: string[]; label: string; className?: string }) {
  return (
    <span className={`sb-crew-tools${className ? ` ${className}` : ""}`} role="img" aria-label={label}>
      {agents.slice(0, MARKS_MAX).map((x, i) => (
        <span key={x.key} title={names[i]}>
          <CrewMark x={x} />
        </span>
      ))}
      {agents.length > MARKS_MAX && <span className="sb-crew-more">+{agents.length - MARKS_MAX}</span>}
      {/* A narrow sidebar shows the first mark and how many more (style.css .sb-crew-rest), so the folder keeps its room. */}
      {agents.length > 1 && <span className="sb-crew-rest" aria-hidden="true">+{agents.length - 1}</span>}
    </span>
  );
}
