import type { CSSProperties } from "react";
import { ArrowRightIcon } from "lucide-react";
import type { EngineTool } from "../types.js";
import { ENGINE_NAMES } from "../types.js";
import { EngineMark } from "./BrandMarks.js";
import { Face } from "./Teammates.js";
import "./auto-week.css";

/**
 * Automations' ways in and its marks (Arun, 2026-11-15: "since we have crew and coding tools combined in this page now"): who runs
 * a schedule, as a mark, and the two doors, your crew and a coding tool. The week card that stood over them was taken off ("get
 * rid of this").
 */

export type WeekWho = { kind: "mate"; seed: string; name: string } | { kind: "tool"; tool: EngineTool } | { kind: "crew"; seeds: string[]; name: string };
export interface WeekSched {
  every: "hourly" | "every" | "daily" | "weekdays" | "weekly";
  /** HH:MM. */
  at: string;
  /** For weekly: 0 = Sunday. */
  days: number[];
  /** For "every": the hours between. */
  hours?: number;
  /** An IANA zone; this computer's when absent. */
  tz?: string;
}
export interface WeekItem {
  key: string;
  name: string;
  who: WeekWho;
  sched: WeekSched;
  /** What it is: "Routine", "Crew workflow", "Automation". */
  kind: string;
  open?: () => void;
}

/** Who runs it, as a mark: a crew mate's face, a crew's faces stacked, a coding tool's mark. */
export function WhoMark({ who, size = 18 }: { who: WeekWho; size?: number }) {
  if (who.kind === "tool")
    return (
      <span className="aw-tool" style={{ width: size, height: size }}>
        <EngineMark tool={who.tool} size={Math.round(size * 0.72)} />
      </span>
    );
  if (who.kind === "mate") return <Face seed={who.seed} size={size} />;
  return (
    <span className="aw-stack">
      {who.seeds.slice(0, 3).map((s, i) => (
        <span key={i}>
          <Face seed={s} size={size} />
        </span>
      ))}
    </span>
  );
}
/**
 * The two ways in, side by side: your crew (crew mates in steps that hand on to each other, a board in a room each run) and a coding
 * tool (one tool, one job, a session each run), each with who is there to do it and how many already run.
 */
export function AutoDoors({ crew, tools, crewCount, toolCount, onCrew, onTool }: { crew: { seed: string; name: string }[]; tools: EngineTool[]; crewCount: number; toolCount: number; onCrew?: () => void; onTool: () => void }) {
  return (
    <div className="aw-doors">
      {onCrew && (
        <button type="button" className="aw-door" onClick={onCrew}>
          <span className="aw-door-faces" aria-hidden="true">
            {(crew.length ? crew : [{ seed: "Sage", name: "" }, { seed: "Nova", name: "" }, { seed: "Ivy", name: "" }]).slice(0, 5).map((m, i) => (
              <span key={i} style={{ "--i": i } as CSSProperties}>
                <Face seed={m.seed} size={30} />
              </span>
            ))}
          </span>
          <span className="aw-door-text">
            <b>Your crew</b>
            <span>Crew mates in steps that hand on to each other: one researches, one writes, one checks. Each run is a board in a room.</span>
          </span>
          <span className="aw-door-foot">
            <span>{crewCount ? `${crewCount} on autopilot` : crew.length ? `${crew.length} crew ${crew.length === 1 ? "mate" : "mates"} ready` : "Make a crew mate first"}</span>
            <span className="aw-door-go">
              New crew workflow <ArrowRightIcon aria-hidden="true" />
            </span>
          </span>
        </button>
      )}
      <button type="button" className="aw-door" onClick={onTool}>
        <span className="aw-door-faces aw-door-tools" aria-hidden="true">
          {(tools.length ? tools : (["claude", "codex"] as EngineTool[])).slice(0, 5).map((t, i) => (
            <span key={t} className="aw-tool big" style={{ "--i": i } as CSSProperties}>
              <EngineMark tool={t} size={18} />
            </span>
          ))}
        </span>
        <span className="aw-door-text">
          <b>A coding tool</b>
          <span>One tool, one job, on a schedule, a webhook or another agent finishing. Each run is a session you can step into.</span>
        </span>
        <span className="aw-door-foot">
          <span>{toolCount ? `${toolCount} on autopilot` : tools.length ? `${tools.map((t) => ENGINE_NAMES[t]).slice(0, 2).join(" and ")}${tools.length > 2 ? ` and ${tools.length - 2} more` : ""} ready` : "Install a coding tool first"}</span>
          <span className="aw-door-go">
            New coding tool job <ArrowRightIcon aria-hidden="true" />
          </span>
        </span>
      </button>
    </div>
  );
}
