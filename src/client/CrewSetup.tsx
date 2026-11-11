import { useMemo, useState } from "react";
import { PencilIcon, XIcon } from "lucide-react";
import { ENGINE_NAMES, ENGINE_TOOLS, type EngineMode, type EngineTool } from "../types.js";
import { api } from "./api.js";
import { EngineMark } from "./BrandMarks.js";
import { useMachine, type LocalTool } from "./local.js";
import { canRoute } from "./RouteWhy.js";
import type { Identity } from "./storage.js";
import { Face, refreshTeam, type Team } from "./Teammates.js";
import { MenuButton } from "./ui.js";
import "./crew-setup.css";

/**
 * Setting up a crew from one sentence (Arun, 2026-11-11, option 1A of the Crew overhaul, after Paperclip and OpenBot): say what
 * you want help with, Friday suggests the teammates as cards you can change, and they start on a coding tool that is installed
 * and signed in here, said under the cards. The Starter crew it replaces put all three on Codex where Codex wasn't signed in, and
 * every message waited "until Nova is back online" for good.
 */

/** A role a suggested teammate can take: its standing instructions, how far it may go, and names it might have. */
export interface CrewRole {
  key: string;
  label: string;
  /** Read with every turn. `{goal}` is what the person said they want help with. */
  role: string;
  mode: EngineMode;
  names: string[];
  /** Words in the person's sentence that call for it. */
  calls: RegExp;
}

export const CREW_ROLES: CrewRole[] = [
  { key: "lead", label: "Lead", role: "Leads the crew toward: {goal}. Turns my goals into a plan, hands each teammate their part, checks the work and tells me where it stands.", mode: "full", names: ["Nova", "Ada", "Zed"], calls: /(?!)/ },
  { key: "engineer", label: "Engineer", role: "Builds features and fixes bugs in our code. Keeps the tests green and works on a branch of their own for each change.", mode: "full", names: ["Kit", "Rio", "Max"], calls: /\b(build|code|feature|fix|bug|app|ship|api|backend|frontend|implement|refactor|repo|website|site)\w*/i },
  { key: "reviewer", label: "Reviewer", role: "Reviews every change before it ships: reads the diff, runs the tests and says exactly what to fix.", mode: "edits", names: ["Juno", "Iris", "Lev"], calls: /\b(review|pr|pull request|quality|audit|check)\w*/i },
  { key: "qa", label: "QA", role: "Tests every change like a user: runs the app, tries the edge cases and files what breaks with steps to repeat it.", mode: "edits", names: ["Vera", "Tess", "Ola"], calls: /\b(test|qa|bug|break|edge case|regression)\w*/i },
  { key: "writer", label: "Writer", role: "Writes our docs, release notes and posts in our voice: clear, short, no hype.", mode: "edits", names: ["Wren", "Sol", "Ivy"], calls: /\b(doc|write|writing|blog|post|release note|changelog|readme|copy|newsletter|content)\w*/i },
  { key: "researcher", label: "Researcher", role: "Researches what others ship and what our users ask for, and writes it up with links.", mode: "plan", names: ["Sage", "Remy", "Noor"], calls: /\b(research|competitor|market|report|investigat|find out|compare|analy[sz])\w*/i },
  { key: "designer", label: "Designer", role: "Looks after how it looks and reads: screens, copy and polish, in both themes.", mode: "edits", names: ["Mika", "Lux", "Ren"], calls: /\b(design|ui|ux|screen|look|polish|style)\w*/i },
  { key: "ops", label: "Ops", role: "Keeps the build healthy: CI, deploys and dependencies, with a note for each change.", mode: "full", names: ["Teo", "Kai", "Bo"], calls: /\b(ci|deploy|infra|dependenc|ops|release|pipeline|uptime)\w*/i },
];

/** Starting points under the box, as Paperclip and OpenBot offer them: each fills the sentence. */
export const CREW_STARTS: { label: string; text: string }[] = [
  { label: "Ship a web app", text: "Ship our web app: build the features I ask for, review every change and keep the docs current" },
  { label: "Keep a repo healthy", text: "Keep our repo healthy: fix what breaks, review pull requests and keep dependencies up to date" },
  { label: "Write and publish docs", text: "Write and keep our docs and release notes current, checked against the code" },
  { label: "Research and report", text: "Research what others in our space ship and write it up for me each week" },
];

export interface Suggested {
  key: string;
  label: string;
  name: string;
  role: string;
  mode: EngineMode;
}

/**
 * The teammates a sentence calls for: the roles its words name, at most four, a lead first when there is more than one; an
 * engineer and a reviewer when it names none. Each with a name nobody on the crew has. Pure, for its test.
 */
export function suggestCrew(goal: string, taken: string[] = []): Suggested[] {
  const text = goal.trim();
  let keys = CREW_ROLES.filter((r) => r.key !== "lead" && r.calls.test(text)).map((r) => r.key);
  // QA and Reviewer both called by "test": a reviewer already runs the tests, so QA only when asked for by name.
  if (keys.includes("qa") && keys.includes("reviewer") && !/\b(qa|edge case|regression)/i.test(text)) keys = keys.filter((k) => k !== "qa");
  if (!keys.length) keys = ["engineer", "reviewer"];
  keys = keys.slice(0, 3);
  if (keys.length > 1 || !text) keys = ["lead", ...keys];
  const used = new Set(taken.map((n) => n.toLowerCase()));
  return keys.map((k) => {
    const r = CREW_ROLES.find((x) => x.key === k)!;
    const name = r.names.find((n) => !used.has(n.toLowerCase())) ?? `${r.names[0]} ${used.size + 1}`;
    used.add(name.toLowerCase());
    return { key: k, label: r.label, name, role: r.role.replace("{goal}", text.replace(/[.\s]+$/, "") || "what I ask for"), mode: r.mode };
  });
}

/** The coding tools a crew can start on here, best first: installed and signed in, Claude Code then Codex then the rest; then installed only. */
export function readyTools(tools: LocalTool[]): { tool: EngineTool; signedIn: boolean }[] {
  const order = (["claude", "codex", ...ENGINE_TOOLS.filter((t) => t !== "claude" && t !== "codex" && t !== "acp")] as EngineTool[]);
  const here = order.map((t) => tools.find((x) => x.tool === t)).filter((x): x is LocalTool => !!x && !!x.path && !x.unavailable);
  return [...here.filter((x) => x.loggedIn === true), ...here.filter((x) => x.loggedIn === null), ...here.filter((x) => x.loggedIn === false)].map((x) => ({ tool: x.tool, signedIn: x.loggedIn === true }));
}

export default function CrewSetup({ identity, onMade }: { identity: Identity; onMade?: (t: Team) => void }) {
  const machine = useMachine(identity).state;
  const ready = useMemo(() => readyTools(machine.tools), [machine.tools]);
  const [goal, setGoal] = useState("");
  const [picked, setPicked] = useState<EngineTool | null>(null);
  const [cards, setCards] = useState<Suggested[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const tool = picked ?? ready[0]?.tool ?? null;
  const toolSignedIn = ready.find((r) => r.tool === tool)?.signedIn ?? false;
  // Suggested as you type, kept once you change a card.
  const shown = cards ?? suggestCrew(goal);
  const edit = (key: string, patch: Partial<Suggested>) => setCards(shown.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const remove = (key: string) => setCards(shown.filter((c) => c.key !== key));
  const addOne = () => {
    const next = CREW_ROLES.find((r) => !shown.some((c) => c.key === r.key));
    if (!next) return;
    const [s] = suggestCrew(next.label, shown.map((c) => c.name)).filter((x) => x.key === next.key);
    setCards([...shown, s ?? { key: next.key, label: next.label, name: next.names[0]!, role: next.role.replace("{goal}", goal || "what I ask for"), mode: next.mode }]);
  };

  const start = async () => {
    if (!tool) return setErr("Install a coding tool first (Claude Code, Codex, Cursor…) in Settings › Coding tools: each teammate works through one.");
    if (!shown.length) return setErr("Add a teammate first.");
    setBusy(true);
    setErr("");
    let lead: string | null = null;
    let last: Team | null = null;
    try {
      for (const c of shown) {
        const got = await api<Team & { made?: string }>(identity, "/api/teammates", {
          method: "POST",
          body: JSON.stringify({ name: c.name.trim() || c.label, role: c.role, tool, model: canRoute(tool) ? "auto" : "", mode: c.mode, checkins: [] }),
          headers: { "Content-Type": "application/json" },
        });
        last = got;
        if (c.key === "lead") lead = got.made ?? got.teammates.at(-1)?.id ?? null;
      }
      if (lead && shown.length > 1) await api(identity, `/api/teammates/${lead}/lead`, { method: "POST" }).catch(() => {});
      await refreshTeam(identity);
      if (last) onMade?.(last);
    } catch (x) {
      setErr(`${(x as Error).message} Those made so far are on your crew; press again for the rest.`);
      setCards(shown.filter((c) => !(last?.teammates ?? []).some((m) => m.name === c.name)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cs">
      <div className="cs-body">
        <h1>Set up your crew</h1>
        <p className="cs-lead">Say what you want help with. Friday suggests the teammates; change anything before they start.</p>
        <div className="cs-box">
          <label htmlFor="cs-goal" className="sr-only">
            What should your crew help with?
          </label>
          <textarea id="cs-goal" value={goal} rows={2} placeholder="What should your crew help with?" onChange={(e) => setGoal(e.target.value)} />
          <div className="cs-starts" role="group" aria-label="Start from">
            {CREW_STARTS.map((s) => (
              <button key={s.label} type="button" className="cs-start" onClick={() => (setGoal(s.text), setCards(null))}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <h2 className="cs-label">
          {shown.length === 1 ? "Friday suggests one teammate" : `Friday suggests ${["", "one", "two", "three", "four", "five", "six", "seven", "eight"][shown.length] ?? shown.length} teammates`}
        </h2>
        <ul className="cs-cards">
          {shown.map((c) => (
            <li key={c.key} className="cs-card">
              <div className="cs-card-top">
                <Face seed={c.name} size={34} />
                <div className="cs-card-id">
                  {editing === c.key ? (
                    <input className="cs-name-input" aria-label={`${c.label}'s name`} value={c.name} autoFocus onChange={(e) => edit(c.key, { name: e.target.value })} onBlur={() => setEditing(null)} onKeyDown={(e) => e.key === "Enter" && setEditing(null)} />
                  ) : (
                    <b>{c.name}</b>
                  )}
                  <span className="cs-chip">{c.label}</span>
                </div>
                <span className="cs-card-acts">
                  <button type="button" className="cs-icon" aria-label={`Edit ${c.name}`} onClick={() => setEditing(editing === c.key ? null : c.key)}>
                    <PencilIcon aria-hidden="true" />
                  </button>
                  {shown.length > 1 && (
                    <button type="button" className="cs-icon" aria-label={`Leave ${c.name} out`} onClick={() => remove(c.key)}>
                      <XIcon aria-hidden="true" />
                    </button>
                  )}
                </span>
              </div>
              {editing === c.key ? (
                <textarea className="cs-role-input" aria-label={`${c.name}'s role`} value={c.role} rows={4} onChange={(e) => edit(c.key, { role: e.target.value })} />
              ) : (
                <p className="cs-role">{c.role}</p>
              )}
            </li>
          ))}
        </ul>

        <div className="cs-foot">
          {tool ? (
            <span className="cs-tool">
              <EngineMark tool={tool} size={15} />
              <span>{ENGINE_NAMES[tool]}</span>
              <span className={toolSignedIn ? "cs-muted" : "cs-warn"}>{toolSignedIn ? "· signed in on this computer" : "· sign in to it in Settings › Coding tools first"}</span>
              {ready.length > 1 && (
                <MenuButton
                  className="cs-change"
                  label="Pick the coding tool"
                  text="Change"
                  caret="chevronDown"
                  items={() => ready.map((r) => ({ label: ENGINE_NAMES[r.tool], mark: <EngineMark tool={r.tool} size={14} />, sub: r.signedIn ? "Signed in" : "Not signed in yet", checked: r.tool === tool, onSelect: () => setPicked(r.tool) }))}
                />
              )}
            </span>
          ) : (
            <span className="cs-warn">No coding tool is installed yet: add one in Settings › Coding tools.</span>
          )}
          <span className="cs-foot-acts">
            {shown.length < CREW_ROLES.length && (
              <button type="button" className="cs-btn cs-quiet" onClick={addOne}>
                Add one more
              </button>
            )}
            <button type="button" className="cs-btn cs-primary" disabled={busy || !tool || !shown.length} onClick={() => void start()}>
              {busy ? "Starting…" : "Start the crew"}
            </button>
          </span>
        </div>
        {err && (
          <p className="cs-err" role="alert">
            {err}
          </p>
        )}
        <p className="cs-note">Each gets a folder of their own in ~/Friday, works in your project when you give them work, and remembers what you tell them.</p>
      </div>
    </div>
  );
}
