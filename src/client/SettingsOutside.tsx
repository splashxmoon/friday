import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon, TerminalSquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Note, SettingsGroup, SettingsRow } from "@/components/dass";
import { api } from "./api.js";
import { EngineMark } from "./BrandMarks.js";
import type { Identity } from "./storage.js";

// ── This computer › Let other agents use Friday ──────────────────────

interface Setup {
  claude: { line: string };
  codex: { line: string; toml: string };
  cursor: { json: string; file: string };
  stdio: { line: string };
  shim: string;
}

/** What is to copy, in a box the line can be read and selected in, with Copy beside it. */
function Copyable({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-start gap-2">
      <pre className="m-0 min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-md border border-[var(--border)] bg-[var(--surface-2,transparent)] px-3 py-2 font-mono text-[12px] leading-relaxed text-[var(--ink)]">{text}</pre>
      <Button
        variant="outline"
        size="sm"
        aria-label={`Copy ${label}`}
        onClick={() => void navigator.clipboard.writeText(text).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/**
 * Agents outside Friday handing it work (outside-agents.ts; Arun, 2026-10-30): Claude Code, Codex and Cursor on this computer,
 * each told about Friday's MCP server with its own line. Add runs that line in a Terminal window of the person's own, where they
 * see it run, as Run in Terminal does for a tool's install; Cursor has no command for it, so its file is what is shown.
 */
export function OutsideAgentsSection({ identity }: { identity: Identity }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    api<Setup>(identity, "/api/outside/setup", { headers: { "x-friday-local": "1" } }).then(
      (s) => live && setSetup(s),
      (e: Error) => live && setNote({ ok: false, text: e.message }),
    );
    return () => {
      live = false;
    };
  }, [identity]);
  const add = async (tool: "claude" | "codex", name: string) => {
    setNote(null);
    try {
      const r = await api<{ opened: boolean; command: string }>(identity, "/api/outside/setup", { method: "POST", headers: { "x-friday-local": "1" }, body: JSON.stringify({ tool }) });
      setNote(r.opened ? { ok: true, text: `Adding Friday to ${name} in a Terminal window. Start a new ${name} session to use it.` } : { ok: false, text: `No terminal opened here. Run the line above in one.` });
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    }
  };
  const addButton = (tool: "claude" | "codex", name: string) => (
    <Button variant="outline" size="sm" onClick={() => void add(tool, name)}>
      <TerminalSquareIcon />
      Add to {name}
    </Button>
  );
  return (
    <section className="flex flex-col gap-5">
      <p className="m-0 max-w-[72ch] text-[13px] leading-snug text-[var(--text-muted)]">
        Your other coding agents can start Friday sessions, tell their agents what to do, wait for them and answer what they ask, through Friday&apos;s MCP server. Only agents on
        this computer, signed in as you, can use it: it needs a key kept in Friday&apos;s own folder. What they do shows in the session as from them.
      </p>
      {setup && (
        <>
          <SettingsGroup title={<span className="inline-flex items-center gap-2"><EngineMark tool="claude" size={16} /> Claude Code</span>} action={addButton("claude", "Claude Code")}>
            <SettingsRow stack label="Run this once in a terminal" hint="It adds Friday for every folder you use Claude Code in.">
              <Copyable text={setup.claude.line} label="the Claude Code line" />
            </SettingsRow>
          </SettingsGroup>
          <SettingsGroup title={<span className="inline-flex items-center gap-2"><EngineMark tool="codex" size={16} /> Codex</span>} action={addButton("codex", "Codex")}>
            <SettingsRow stack label="Run this once in a terminal">
              <Copyable text={setup.codex.line} label="the Codex line" />
            </SettingsRow>
            <SettingsRow stack label="Or add this to ~/.codex/config.toml" hint="It also gives Friday's calls longer than Codex's one-minute default, for long waits.">
              <Copyable text={setup.codex.toml} label="the Codex settings" />
            </SettingsRow>
          </SettingsGroup>
          <SettingsGroup title={<span className="inline-flex items-center gap-2"><EngineMark tool="cursor" size={16} /> Cursor</span>}>
            <SettingsRow stack label={`Add this to ${setup.cursor.file}`} hint="Merge it with any servers already there. Cursor picks it up the next time it starts.">
              <Copyable text={setup.cursor.json} label="the Cursor settings" />
            </SettingsRow>
          </SettingsGroup>
          <SettingsGroup title="Anything else that speaks MCP">
            <SettingsRow stack label="Start this as a stdio server" hint="Friday has to be open for its tools to work. Ask your agent to hand work to Friday, and it uses start_session, wait_for_idle and the rest.">
              <Copyable text={setup.stdio.line} label="the server command" />
            </SettingsRow>
          </SettingsGroup>
        </>
      )}
      {note && <Note ok={note.ok}>{note.text}</Note>}
    </section>
  );
}
