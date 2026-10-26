import { useCallback, useEffect, useState } from "react";
import type { SessionState } from "../session/projection.js";
import {
  CLAUDE_POINTER,
  isMissing,
  READ_BY,
  RULES_TEMPLATE,
  RULE_FILES,
  type RuleFile,
  unnumbered,
  withMemoryRules,
} from "../project-rules.js";
import type { Member } from "../types.js";
import { isLocal } from "./edition.js";
import { Icon } from "./icons.js";
import type { Send } from "./useSession.js";

/**
 * The project's standing instructions, where the whole room can read and change them.
 *
 * Coding agents are only as good as the rules they are given about a codebase: how to run the tests, what not to touch,
 * how the team writes things. Those live in `AGENTS.md` and `CLAUDE.md` in the repository, which is where each tool looks,
 * and Friday's agent reads them too. This is the same file, shown beside the conversation, so what the agent was told to do
 * is not a thing somebody has to go and find.
 */

type Loaded = Record<RuleFile, string | null>;

export function RulesPanel({
  state,
  sid,
  invite,
  me,
  send,
  lane,
}: {
  state: SessionState;
  sid: string;
  invite: string;
  me: Member;
  send: Send;
  lane?: string;
}) {
  const hasFolder =
    Object.values(state.engines).some((e) => e.online) || !!state.upload;
  const viewer = me.role === "viewer";
  const mayEdit =
    !viewer &&
    (me.role === "owner" || state.driver?.id === me.id || !state.driver);
  const [files, setFiles] = useState<Loaded | null>(null);
  const [open, setOpen] = useState<RuleFile>("AGENTS.md");
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const got: Loaded = { "AGENTS.md": null, "CLAUDE.md": null };
    await Promise.all(
      RULE_FILES.map(async (f) => {
        try {
          const r = await fetch(
            `/api/sessions/${encodeURIComponent(sid)}/repo?op=read${viewer ? "" : "&raw=1"}&path=${encodeURIComponent(f)}&invite=${encodeURIComponent(invite)}${lane ? `&lane=${encodeURIComponent(lane)}` : ""}`,
          );
          const j = (await r.json()) as { output?: string; error?: string };
          if (!j.error && typeof j.output === "string" && !isMissing(j.output))
            got[f] = viewer ? unnumbered(j.output) : j.output;
        } catch {
          // Unreadable is the same as absent here: the panel offers to create it.
        }
      }),
    );
    setFiles(got);
    setOpen((cur) =>
      got[cur] !== null
        ? cur
        : (RULE_FILES.find((f) => got[f] !== null) ?? "AGENTS.md"),
    );
  }, [sid, invite, lane, viewer]);

  useEffect(() => {
    if (hasFolder) void load();
  }, [hasFolder, load]);
  // Another file drops the draft of the last one. Said while drawing, not in an effect: effects run again each time a panel
  // kept in the workbench is shown, and that wiped the draft somebody had left there to look at something else.
  const [draftOf, setDraftOf] = useState(open);
  if (draftOf !== open) {
    setDraftOf(open);
    setDraft(undefined);
    setErr("");
  }

  if (!hasFolder) {
    return (
      <div className="rules rules-empty">
        <p className="rules-empty-title">No folder yet</p>
        <p className="rules-empty-sub">
          Connect a folder to this session and its AGENTS.md or CLAUDE.md shows
          up here, for everyone to read and change.
        </p>
      </div>
    );
  }
  if (!files)
    return (
      <div className="rules rules-empty">
        <p className="rules-empty-sub">Reading the folder…</p>
      </div>
    );

  const existing = RULE_FILES.filter((f) => files[f] !== null);
  const write = async (path: RuleFile, content: string) => {
    setSaving(true);
    setErr("");
    const r = await send({ type: "folder.write", path, content, quiet: true });
    setSaving(false);
    if (!r.ok)
      return setErr(
        r.error ??
          "Couldn't save that file. Check the computer is still connected, then try again.",
      );
    setFiles((f) => (f ? { ...f, [path]: content } : f));
    setOpen(path);
    setDraft(undefined);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  if (!existing.length) {
    return (
      <div className="rules rules-empty">
        <span className="rules-empty-mark">
          <Icon name="book" size={20} />
        </span>
        <p className="rules-empty-title">No project instructions yet</p>
        <p className="rules-empty-sub">
          An AGENTS.md at the top of the repository tells every agent how work
          is done here: how to run the tests, what not to touch, how the team
          writes things. Friday Code, Codex and Cursor read it. Claude Code
          reads CLAUDE.md.
        </p>
        {err && <p className="rules-err">{err}</p>}
        <button
          type="button"
          className="btn primary small"
          disabled={!mayEdit || saving}
          title={mayEdit ? "" : "Only the driver or an owner can create it"}
          onClick={() => void write("AGENTS.md", RULES_TEMPLATE)}
        >
          Create AGENTS.md
        </button>
      </div>
    );
  }

  const text = files[open] ?? "";
  const value = draft ?? text;
  const dirty = draft !== undefined && draft !== text;
  const other = RULE_FILES.find((f) => f !== open)!;
  const pointer = open === "AGENTS.md" && files["CLAUDE.md"] === null;

  return (
    <div className="rules">
      <div className="rules-head">
        <div className="rules-tabs" role="tablist">
          {existing.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={f === open}
              className={f === open ? "on" : ""}
              onClick={() => setOpen(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <span className="rules-by">Read by {READ_BY[open]}</span>
      </div>
      <textarea
        className="rules-edit"
        spellCheck={false}
        value={value}
        readOnly={!mayEdit}
        aria-label={`${open}, the project's standing instructions`}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (
            (e.metaKey || e.ctrlKey) &&
            e.key.toLowerCase() === "s" &&
            dirty &&
            mayEdit
          ) {
            e.preventDefault();
            void write(open, value);
          }
        }}
      />
      {err && <p className="rules-err">{err}</p>}
      <div className="rules-foot">
        {mayEdit ? (
          <>
            <span className="rules-state">
              {saving
                ? "Saving…"
                : saved
                  ? "Saved"
                  : dirty
                    ? "Unsaved changes"
                    : "Everyone's agents read this at the start of each run"}
            </span>
            {dirty && (
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setDraft(undefined)}
              >
                Revert
              </button>
            )}
            <button
              type="button"
              className="btn primary small"
              disabled={!dirty || saving}
              onClick={() => void write(open, value)}
            >
              Save
            </button>
          </>
        ) : (
          <span className="rules-state">
            Only the driver or an owner can change this
          </span>
        )}
      </div>
      {/* What Friday remembers about this team, written where every tool reads it: one press, then save. */}
      {mayEdit && open === "AGENTS.md" && !isLocal() && (
        <button
          type="button"
          className="rules-add"
          onClick={() =>
            void fetch("/api/memory", { credentials: "same-origin" })
              .then(
                (r) =>
                  r.json() as Promise<{
                    enabled?: boolean;
                    entries?: { text: string; scope: string }[];
                  }>,
              )
              .then((r) => {
                const entries = (r.entries ?? []).filter(
                  (e) => e.scope === "workspace" || e.scope === "personal",
                );
                if (!entries.length)
                  return setErr(
                    "Friday has nothing remembered yet. It learns as you work, and you can add to it under Settings › Memory.",
                  );
                const next = withMemoryRules(text, entries);
                if (next === text)
                  return setErr(
                    "Everything Friday remembers is already in this file.",
                  );
                setDraft(next);
              })
              .catch(() => setErr("Couldn't read what Friday remembers."))
          }
        >
          <Icon name="book" size={13} /> Add what Friday remembers, so the rules
          travel with the code
        </button>
      )}
      {mayEdit && pointer && (
        <button
          type="button"
          className="rules-add"
          onClick={() => void write("CLAUDE.md", CLAUDE_POINTER)}
        >
          <Icon name="plus" size={13} /> Add a CLAUDE.md that points here, so
          Claude Code follows the same rules
        </button>
      )}
      {mayEdit && files[other] === null && open === "CLAUDE.md" && (
        <button
          type="button"
          className="rules-add"
          onClick={() =>
            void write(
              "AGENTS.md",
              text.trim() === CLAUDE_POINTER.trim() ? RULES_TEMPLATE : text,
            )
          }
        >
          <Icon name="plus" size={13} /> Add an AGENTS.md too, for Codex and
          Cursor
        </button>
      )}
    </div>
  );
}
