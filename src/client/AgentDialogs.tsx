import { useRef, useState, type ReactNode } from "react";
import type { AgentView } from "../agents.js";
import type { McpPublic } from "../mcp-types.js";
import type { AgentTools } from "../types.js";
import { api } from "./api.js";
import { Icon, type IconName } from "./icons.js";
import type { Identity } from "./storage.js";
import { Switch, useDismiss } from "./ui.js";

export function Dialog({ title, sub, onClose, onSubmit, children, actions, className = "" }: { className?: string; title: string; sub: string; onClose: () => void; onSubmit: () => void; children: ReactNode; actions: ReactNode }) {
  const ref = useRef<HTMLFormElement>(null);
  useDismiss(ref, onClose);
  return (
    <div className="overlay">
      <form
        ref={ref}
        className={`modal manual-form ${className}`}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <div className="pop-head">
          <div>
            <h2>{title}</h2>
            <p className="muted small">{sub}</p>
          </div>
          <button className="icon-btn tiny" type="button" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        {children}
        <div className="modal-actions">{actions}</div>
      </form>
    </div>
  );
}

/** Starting points, so a first agent is a click and a sentence rather than a blank page. */
const STARTERS: { icon: IconName; name: string; description: string; instructions: string }[] = [
  { icon: "search", name: "Researcher", description: "Finds answers and cites where they came from.", instructions: "You research questions thoroughly. Search, read the sources, and answer with what you found and where. Say plainly when the evidence is thin." },
  { icon: "shield", name: "Reviewer", description: "Reviews changes before they ship.", instructions: "You review changes before they ship. Order findings by what they cost, name the file and the failing case, and say when the change is fine. You report; a person decides." },
  { icon: "pencil", name: "Writer", description: "Drafts and edits in your voice.", instructions: "You draft and edit writing. Keep the author's voice, cut what does not earn its place, and explain any change that alters the meaning." },
  { icon: "chart", name: "Analyst", description: "Turns raw numbers into a clear read.", instructions: "You analyse data. State the question, show the numbers that answer it, and flag what you could not check." },
  { icon: "flask", name: "Tester", description: "Writes the tests first, then makes them pass.", instructions: "You test. For every change, write the test that would catch it breaking before you touch the code, run the suite, and report what passed and what did not. Never skip or weaken a test to get to green; say so instead." },
  { icon: "book", name: "Explainer", description: "Walks through code in plain words.", instructions: "You explain code to people who did not write it. Say what it does, why it is this way, and what would surprise a newcomer, in plain words and short paragraphs. Change nothing unless asked; questions get answers, not patches." },
];

const ICONS: IconName[] = ["agent", "search", "chart", "scale", "pencil", "flask", "shield", "megaphone", "users", "compass", "bulb", "book", "briefcase", "headset", "card"];

/** Create an agent, or edit one. The same form, since setting one up is editing an empty one. */
export function AgentForm({
  identity,
  agent,
  connections,
  onClose,
  onSaved,
  solo = false,
}: {
  identity: Identity;
  agent: AgentView | null;
  connections: McpPublic[];
  onClose: () => void;
  onSaved: (a: AgentView) => void;
  /** Solo: the agent runs on a coding tool, which takes its instructions; what Friday's own agent can use isn't asked. */
  solo?: boolean;
}) {
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [icon, setIcon] = useState(agent?.icon ?? "agent");
  const [tools, setTools] = useState<AgentTools>(agent?.tools ?? { webSearch: true, askHuman: true, connections: "none" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const picked = tools.connections === "all" ? connections.map((c) => c.id) : tools.connections === "none" ? [] : tools.connections;
  const toggle = (id: string) => setTools({ ...tools, connections: picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id] });

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const body = JSON.stringify({ name: name.trim(), description: description.trim(), instructions, icon, tools: { ...tools, connections: picked.length ? picked : "none" } });
      const r = agent
        ? await api<{ agent: AgentView }>(identity, `/api/agents/${agent.id}`, { method: "PATCH", body })
        : await api<{ agent: AgentView }>(identity, "/api/agents", { method: "POST", body });
      onSaved(r.agent);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={agent ? "Edit agent" : "New agent"}
      sub={agent ? "Change what it does and what it can use." : "Name it and say what it should do. You can change anything later."}
      onClose={onClose}
      onSubmit={() => void save()}
      actions={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim() || busy}>
            {agent ? "Save" : "Create agent"}
          </button>
        </>
      }
    >
      {!agent && (
        <div className="ag-starters" role="group" aria-label="Start from">
          {STARTERS.map((s) => (
            <button
              key={s.name}
              type="button"
              className="ag-starter"
              onClick={() => (setName(s.name), setDescription(s.description), setInstructions(s.instructions), setIcon(s.icon))}
            >
              <Icon name={s.icon} size={14} /> {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="ag-name-row">
        <div className="ag-icon-pick" role="radiogroup" aria-label="Icon">
          {ICONS.slice(0, 8).map((i) => (
            <button key={i} type="button" role="radio" aria-checked={icon === i} className={`icon-btn tiny ${icon === i ? "on" : ""}`} onClick={() => setIcon(i)}>
              <Icon name={i} size={14} />
            </button>
          ))}
        </div>
        <label className="field">
          <span>Name</span>
          <input autoFocus value={name} maxLength={40} placeholder="Product researcher" onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>What should it do?</span>
        <textarea rows={5} value={instructions} placeholder="Describe the job in plain words. It reads this before every run." onChange={(e) => setInstructions(e.target.value)} />
      </label>
      <label className="field">
        <span>
          Short description <span className="muted small">optional</span>
        </span>
        <input value={description} maxLength={140} placeholder={solo ? "One line about what it is for" : "Shown to people you share it with"} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {!solo && (
      <div className="field">
        <span>What it can use</span>
        <div className="ag-tool-row">
          <Icon name="globe" size={14} /> Search the web
          <Switch label="Search the web" on={tools.webSearch} onChange={(v) => setTools({ ...tools, webSearch: v })} />
        </div>
        <div className="ag-tool-row">
          <Icon name="hand" size={14} /> Ask a person when unsure
          <Switch label="Ask a person when unsure" on={tools.askHuman} onChange={(v) => setTools({ ...tools, askHuman: v })} />
        </div>
        {connections.length > 0 && (
          <div className="ag-conn-chips">
            {connections.map((c) => (
              <button key={c.id} type="button" aria-pressed={picked.includes(c.id)} className={`ag-conn ${picked.includes(c.id) ? "on" : ""}`} onClick={() => toggle(c.id)}>
                {picked.includes(c.id) && <Icon name="check" size={12} />} {c.name}
              </button>
            ))}
          </div>
        )}
      </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </Dialog>
  );
}
