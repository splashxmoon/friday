import { useEffect, useRef, useState, type ReactNode } from "react";
import { ACCOUNT_TOOLS, AccountList } from "./Accounts.js";
import { ENGINE_NAMES, ENGINE_TOOLS, type EngineTool } from "../types.js";

/**
 * The desktop app linking this computer to the hosted Friday (desktop-link.ts). The local edition has nothing to link: its runner
 * is part of the app, so the computer is always connected, and these say so.
 */
const link: { useAutoLink: () => "idle" | "trying" | "ok" | "failed"; useAutoLinkError: () => string; linkNow: (identity: Identity) => Promise<void> } = {
  useAutoLink: () => "idle",
  useAutoLinkError: () => "",
  linkNow: async () => {},
};
import { EngineMark } from "./BrandMarks.js";
import { openOutside } from "./openOutside.js";
import { ENGINE_INFO, installStep, osOf, splitTools } from "./engines.js";
import { Icon } from "./icons.js";
import { useWorkMode } from "./WorkMode.js";
import { NoMachine, hostApi, machineRefusal, type LocalTool, type MachineState } from "./local.js";
import type { Identity } from "./storage.js";
import { MenuButton, MoreTools, useDismiss } from "./ui.js";

/**
 * This computer, and whether Friday can work on it.
 *
 * Connecting it is a button, and usually not even that: the app makes the link
 * token itself and starts the bundled runner, and the only thing left for a
 * person to do is the one thing nobody can do for them, which is sign in to
 * their coding agent.
 *
 * It sits in the corner of the new-session page because that is where the
 * question is asked — "can it actually do this?" — and it answers in one line
 * whether or not anything needs doing.
 */

type Step = "idle" | "linking" | "signing";
/** What is happening to one tool's sign-in. */
type Acting = "out" | "switch" | "in";

export function MachineBadge({ identity, machine, refresh, inline = false }: { identity: Identity; machine: MachineState; refresh: () => void; /** Always shown, compact, with no pill to open it: the new-session page's corner. */ inline?: boolean }) {
  const [open, setOpen] = useState(false);
  // What stays here, said for the kind of work in front of you (w1 #4: "The code, the terminal and your coding tool" in Work).
  let topLine = "The code, the terminal and your coding tool stay here. Nothing is uploaded.";
  const [workOn] = useWorkMode();
  if (workOn) topLine = "Your folders, your files and your coding tools stay on this computer. Nothing is uploaded.";
  const [step, setStep] = useState<Step>("idle");
  const [err, setErr] = useState("");
  const [signInUrl, setSignInUrl] = useState("");
  const [signInTool, setSignInTool] = useState("");
  const sawSignedOut = useRef(false);
  /** The tool being signed out, switched or signed in, said on its own row while it happens. */
  const [acting, setActing] = useState<{ tool: EngineTool; what: Acting } | null>(null);
  /** A sign-out the computer confirmed, shown at once rather than when the next look comes back. */
  const [signedOut, setSignedOut] = useState<EngineTool | "">("");
  /** A sign-in that just finished, said for a moment. */
  const [justIn, setJustIn] = useState<EngineTool | "">("");
  // Which missing agent's install line is open.
  const [installing, setInstalling] = useState<EngineTool | "">("");
  // The app connecting this computer on its own, which is not "not connected".
  const auto = link.useAutoLink();
  const autoError = link.useAutoLinkError();
  const btn = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  useDismiss(card, () => setOpen(false), btn.current);

  const desktop = typeof window !== "undefined" && !!window.fridayDesktop?.link;
  const here = machine.mode === "local" || machine.mode === "linked";
  const tools = machine.tools.filter((t) => t.path).map((t) => (t.tool === signedOut ? { ...t, loggedIn: false } : t));
  const [moreTools, setMoreTools] = useState(false);
  // "Other ACP agent": its command line on this computer, read when the card is open.
  const [acpLine, setAcpLine] = useState("");
  useEffect(() => {
    if (!open || !here) return;
    void hostApi<{ line: string }>(identity, "/api/runner/acp.get").then((r) => setAcpLine(r.line), () => {});
  }, [open, here, identity]);
  // What saving it came to, said in its form: a command nothing on this computer answers to was kept without a word, and the row
  // went on saying "Not set up" (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
  const [acpNote, setAcpNote] = useState("");
  const setCommand = async (next: string) => {
    setErr("");
    setAcpNote("");
    try {
      const r = await hostApi<{ ok: boolean; found?: boolean }>(identity, "/api/runner/acp.set", { method: "POST", body: JSON.stringify({ line: next }) });
      setAcpLine(next.trim());
      refresh();
      const cmd = next.trim().split(/\s+/)[0] ?? "";
      if (next.trim() && r.found === false) setAcpNote(`Saved, but nothing called ${cmd} is on this computer yet. Install the agent, or check the command.`);
      else setInstalling("");
    } catch (e) {
      setAcpNote(`Couldn't save that: ${(e as Error).message}`);
    }
  };
  // The installed ones up top. The one whose install line is open stays where it was clicked: one opened from the tools folded
  // away stays among them, not moved up the list as its form opens (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
  const shown = splitTools(here ? (t) => tools.some((x) => x.tool === t) : null, moreTools ? "" : installing);
  const needsSignIn = tools.find((t) => t.loggedIn === false);

  // While something is being set up, keep asking — the runner arrives on its
  // own schedule and a badge that needs a refresh to notice is worse than none.
  useEffect(() => {
    if (step === "idle") return;
    const t = setInterval(refresh, 1200);
    // The runner takes a moment to start and say hello, but not forever. A
    // spinner still turning after that is a failure nobody is being told
    // about. Generous, because the first launch installs nothing but does have
    // to start a process and reach the server.
    const giveUp = setTimeout(() => {
      setStep("idle");
      setErr(machineRefusal() || "This computer didn't answer. It may still be starting — try again, or reopen the app.");
    }, 40_000);
    return () => {
      clearInterval(t);
      clearTimeout(giveUp);
    };
  }, [step, refresh]);

  useEffect(() => {
    if (!signedOut) return;
    if (machine.tools.find((t) => t.tool === signedOut)?.loggedIn === false) return setSignedOut("");
    const t = setTimeout(() => setSignedOut(""), 8000);
    return () => clearTimeout(t);
  }, [signedOut, machine.tools.map((t) => `${t.tool}:${t.loggedIn}`).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!justIn) return;
    const t = setTimeout(() => setJustIn(""), 2500);
    return () => clearTimeout(t);
  }, [justIn]);

  // With the card open, look now and keep looking. Somebody who opened it to
  // install or sign in to an agent is about to go and do that elsewhere; when
  // they come back it should already know, not wait for a focus event that the
  // thirty-second throttle may swallow.
  // Shown all the time, it looks less often unless something is being installed or signed in to.
  useEffect(() => {
    if (!open && !inline) return;
    refresh();
    const t = setInterval(refresh, installing || needsSignIn ? 3000 : inline ? 30_000 : 10_000);
    return () => clearInterval(t);
  }, [open, inline, installing, !!needsSignIn, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  // Arriving late is still arriving: a warning about something that has since
  // worked is worse than no warning, because it sits under the proof it's wrong.
  useEffect(() => {
    if (here) {
      setErr("");
      setStep((s) => (s === "linking" ? "idle" : s));
    }
    // Done is the tool we sent them to sign in to now being signed in, not nothing being left to sign in to: with Cursor
    // still signed out, Codex finishing used to leave "Finish signing in to Codex" and its spinner up for good.
    // Only after it was seen signed out first: switching account signs out and then in, and a refresh that has not caught
    // up yet would otherwise read "still signed in" as "finished".
    const pending = tools.find((t) => t.tool === signInTool);
    if (!signInUrl) sawSignedOut.current = false;
    else if (pending?.loggedIn === false) sawSignedOut.current = true;
    if (!needsSignIn || (signInUrl && sawSignedOut.current && pending && pending.loggedIn !== false)) {
      if (signInUrl && pending?.loggedIn) setJustIn(pending.tool);
      sawSignedOut.current = false;
      setSignInUrl("");
      setSignInTool("");
      setActing((a) => (a?.what === "in" ? null : a));
      setStep((s) => (s === "signing" ? "idle" : s));
    }
  }, [here, needsSignIn, signInUrl, signInTool, tools.map((t) => `${t.tool}:${t.loggedIn}`).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The desktop app links itself: find or make a token, hand it over, let it run. Through linkNow, so it waits on signing out. */
  const connect = async () => {
    if (step === "linking") return;
    setStep("linking");
    setErr("");
    try {
      await link.linkNow(identity);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
      setStep("idle");
    }
  };

  /** The one part nobody can do for them. */
  const signIn = async (tool: EngineTool) => {
    setStep("signing");
    setActing({ tool, what: "in" });
    setErr("");
    try {
      const r = await hostApi<{ opened?: boolean; command: string; url?: string }>(identity, "/api/runner/login", {
        method: "POST",
        body: JSON.stringify({ tool }),
      });
      if (r.url) {
        // Not opened from here: the CLI opens the page itself, and doing it
        // again is a second tab for one sign-in.
        setSignInUrl(r.url);
        setSignInTool(tool);
      } else if (!r.opened) {
        setErr(`Run this on that computer to sign in: ${r.command}`);
        setActing(null);
        setStep("idle");
      }
    } catch (e) {
      setErr((e as Error).message);
      setActing(null);
      setStep("idle");
    }
  };

  /** Sign out on that machine, optionally straight back in as someone else. The row says so from the press. */
  const signOut = async (tool: EngineTool, thenIn: boolean) => {
    setStep("signing");
    setActing({ tool, what: thenIn ? "switch" : "out" });
    setErr("");
    try {
      // The machine checks it really signed out before it answers, so the row can say so now.
      await hostApi(identity, "/api/runner/logout", { method: "POST", body: JSON.stringify({ tool }) });
      setSignedOut(tool);
      if (thenIn) return void signIn(tool);
      setActing(null);
      setStep("idle");
      refresh();
    } catch (e) {
      setErr((e as Error).message);
      setActing(null);
      setStep("idle");
    }
  };

  /** Stop waiting for a sign-in that isn't going to happen: the CLI's login is ended, and the row is back as it was. */
  const cancelSignIn = (tool: EngineTool) => {
    void hostApi(identity, "/api/runner/login.cancel", { method: "POST", body: JSON.stringify({ tool }) }).catch(() => {});
    setSignInUrl("");
    setSignInTool("");
    setActing(null);
    setStep("idle");
    refresh();
  };

  // Ready means installed and not known to be signed out. Any one is enough to
  // work with; how many there are is the useful thing to say.
  const ready = tools.filter((t) => t.loggedIn !== false);
  const connecting = !here && auto === "trying";
  const look = !here
    ? { tone: connecting ? "warn" : "off", text: connecting ? "Connecting…" : desktop ? "Not connected" : "No computer connected" }
    : ready.length >= 1
      ? { tone: "on", text: `${ready.length} coding tool${ready.length === 1 ? "" : "s"} connected`, short: `${ready.length} tool${ready.length === 1 ? "" : "s"}` }
      : needsSignIn
        ? { tone: "warn", text: `Sign in to ${needsSignIn.name}` }
        : { tone: "warn", text: "No coding tools found" };

  if (inline)
    return (
      <section className={`mb-inline ${look.tone}`} aria-label="Coding tools on this computer">
        <div className="mb-where">
          {machine.mode === "checking" || step !== "idle" || connecting ? <span className="spinner" /> : <span className={`mb-dot ${look.tone}`} aria-hidden />}
          <span className="mb-where-text">{machine.mode === "checking" ? "Looking for your computer…" : here ? "Connected" : look.text}</span>
          {here && machine.home && (
            <code className="mb-path" title={machine.home}>
              {machine.home}
            </code>
          )}
        </div>
        {here ? (
          <ul className="mb-tools">
            {[...shown.here, ...(moreTools ? shown.away : [])].map((tool) => (
              <ToolRow
                key={tool}
                tool={tool}
                found={tools.find((x) => x.tool === tool) ?? machine.tools.find((x) => x.tool === tool) ?? null}
                accounts={ACCOUNT_TOOLS.includes(tool) ? <AccountList identity={identity} tool={tools.find((x) => x.tool === tool) ?? machine.tools.find((x) => x.tool === tool) ?? { tool, name: "", path: null, loggedIn: null, source: null }} onChanged={refresh} /> : undefined}
                busy={step === "signing" && acting?.tool !== tool}
                acting={acting?.tool === tool ? acting.what : null}
                justIn={justIn === tool}
                {...(signInUrl && signInTool === tool ? { loginUrl: signInUrl } : {})}
                installing={installing === tool}
                onInstall={() => setInstalling(installing === tool ? "" : tool)}
                onRunInstall={() => hostApi<{ opened: boolean; command: string }>(identity, "/api/runner/install", { method: "POST", body: JSON.stringify({ tool }) })}
                onSignIn={() => void signIn(tool)}
                onSignOut={(thenIn) => void signOut(tool, thenIn)}
                onCancel={() => cancelSignIn(tool)}
                {...(tool === "acp" ? { acpLine, acpNote, onSetCommand: setCommand } : {})}
              />
            ))}
            <li className="mb-more">
              <MoreTools open={moreTools} count={shown.away.length} onToggle={() => setMoreTools((v) => !v)} />
            </li>
          </ul>
        ) : desktop ? (
          <>
            {autoError && (connecting || auto === "failed") && <p className="mb-fail">Last try didn’t work: {autoError}</p>}
            <button type="button" className="btn small mb-go" disabled={step === "linking" || connecting} onClick={() => void connect()}>
              {step === "linking" || connecting ? <span className="spinner" /> : <Icon name="plug" size={13} />}
              {step === "linking" || connecting ? "Connecting…" : auto === "failed" ? "Try again" : "Connect this computer"}
            </button>
          </>
        ) : (
          <button type="button" className="btn small mb-go" disabled={machine.mode === "checking"} title="Looks again for a computer running the Friday desktop app" onClick={refresh}>
            <Icon name="refresh" size={13} /> Retry
          </button>
        )}
        {err && <p className="mb-err">{err}</p>}
      </section>
    );

  return (
    <div className="mb-anchor">
      <button
        ref={btn}
        type="button"
        className={`mb-pill ${look.tone} ${open ? "on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {machine.mode === "checking" || step !== "idle" || connecting ? <span className="spinner" /> : <span className="mb-dot" aria-hidden />}
        {/* Three of the installed tools' marks, overlapping, then how many there are: a pill, not a row of fourteen. Signed-in
            ones first; one that needs signing in wears an amber ring. Every one is in the card behind it. */}
        {here && (() => {
          const marks = [...shown.here].sort((a, b) => Number(machine.tools.find((x) => x.tool === a)?.loggedIn === false) - Number(machine.tools.find((x) => x.tool === b)?.loggedIn === false));
          return (
            <span className="mb-marks" aria-hidden>
              {marks.slice(0, 3).map((t) => {
                const f = machine.tools.find((x) => x.tool === t);
                return (
                  <span key={t} className={`mb-mark ${!f?.path ? "missing" : f.loggedIn === false ? "out" : "in"}`}>
                    <EngineMark tool={t} size={11} />
                  </span>
                );
              })}
            </span>
          );
        })()}
        <span className="mb-text" title={here ? look.text : undefined}>
          {machine.mode === "checking" ? "Looking for your computer…" : "short" in look && look.short ? look.short : look.text}
        </span>
        <Icon name="chevronDown" size={12} />
      </button>

      {open && (
        <div ref={card} className="mb-card surface" role="dialog" aria-label="Your computer">
          <header className="mb-top">
            <h3>Your computer</h3>
            <p>{topLine}</p>
          </header>

          {!here ? (
            <section className="mb-body">
              {desktop ? (
                <>
                  <p className="mb-lead">
                    {connecting
                      ? "Connecting this computer now — you don’t need to do anything. This card updates the moment it’s ready."
                      : "Friday isn’t connected to this computer yet, so it can’t open your folders or run anything."}
                  </p>
                  {autoError && (connecting || auto === "failed") && <p className="mb-fail">Last try didn’t work: {autoError}</p>}
                  <ul className="mb-preview" aria-label="Coding tools Friday can work with">
                    {shown.here.map((t) => (
                      <li key={t}>
                        <EngineMark tool={t} size={16} />
                        <span>{ENGINE_NAMES[t]}</span>
                      </li>
                    ))}
                    {shown.away.length > 0 && <li className="muted">and {shown.away.length} more</li>}
                  </ul>
                  <button type="button" className="btn primary mb-go" disabled={step === "linking" || connecting} onClick={() => void connect()}>
                    {step === "linking" || connecting ? <span className="spinner" /> : <Icon name="plug" size={15} />}
                    {step === "linking" || connecting ? "Connecting…" : auto === "failed" ? "Try again" : "Connect this computer"}
                  </button>
                  <p className="mb-fine">Friday then finds whichever of these you already have and are signed in to. It never holds a key for any of them.</p>
                </>
              ) : (
                <NoMachine className="mb-lead" />
              )}
            </section>
          ) : (
            <section className="mb-body">
              <div className="mb-where">
                <span className="mb-dot on" aria-hidden />
                <span className="mb-where-text">Connected</span>
                {machine.home && (
                  <code className="mb-path" title={machine.home}>
                    {machine.home}
                  </code>
                )}
              </div>

              {/* The ones here, then the rest one click away: the ones not here yet are what a person may have come to install,
                  and with fourteen of them they buried the few somebody has. */}
              <ul className="mb-tools">
                {[...shown.here, ...(moreTools ? shown.away : [])].map((tool) => (
                  <ToolRow
                    key={tool}
                    tool={tool}
                    found={tools.find((x) => x.tool === tool) ?? machine.tools.find((x) => x.tool === tool) ?? null}
                accounts={ACCOUNT_TOOLS.includes(tool) ? <AccountList identity={identity} tool={tools.find((x) => x.tool === tool) ?? machine.tools.find((x) => x.tool === tool) ?? { tool, name: "", path: null, loggedIn: null, source: null }} onChanged={refresh} /> : undefined}
                    busy={step === "signing" && acting?.tool !== tool}
                    acting={acting?.tool === tool ? acting.what : null}
                    justIn={justIn === tool}
                    {...(signInUrl && signInTool === tool ? { loginUrl: signInUrl } : {})}
                    installing={installing === tool}
                    onInstall={() => setInstalling(installing === tool ? "" : tool)}
                    onSignIn={() => void signIn(tool)}
                    onSignOut={(thenIn) => void signOut(tool, thenIn)}
                    onCancel={() => cancelSignIn(tool)}
                    {...(tool === "acp" ? { acpLine, acpNote, onSetCommand: setCommand } : {})}
                  />
                ))}
                <li className="mb-more">
                  <MoreTools open={moreTools} count={shown.away.length} onToggle={() => setMoreTools((v) => !v)} />
                </li>
              </ul>

            </section>
          )}

          {err && <p className="mb-err">{err}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * One coding agent, and what to do about it from wherever it is.
 *
 * Installed and signed in: nothing, except the way to use another account —
 * the real fix for "it is using the wrong one". Installed and signed out: sign
 * in. Not here at all: the one line that puts it here, to copy, and where its
 * own documentation is. Friday never installs anything on someone's computer;
 * it says what to run.
 */
function ToolRow({
  tool,
  found,
  busy,
  acting = null,
  justIn = false,
  loginUrl,
  installing,
  onInstall,
  onRunInstall,
  onSignIn,
  onSignOut,
  onCancel,
  acpLine,
  acpNote,
  onSetCommand,
  accounts,
}: {
  tool: EngineTool;
  found: LocalTool | null;
  busy: boolean;
  /** Being signed out, switched or signed in right now: said here, on this tool's row, while it happens. */
  acting?: Acting | null;
  /** Signed in a moment ago. */
  justIn?: boolean;
  /** The sign-in page the CLI opened, while it waits for the person to finish there. */
  loginUrl?: string;
  installing: boolean;
  onInstall: () => void;
  /** Run its install line in a Terminal window here (runner install), and what that came to. */
  onRunInstall?: () => Promise<{ opened: boolean; command: string }>;
  onSignIn: () => void;
  onSignOut: (thenIn: boolean) => void;
  onCancel: () => void;
  /** "Other ACP agent": what starts it, as a command line, and setting it. */
  acpLine?: string;
  /** What the last save of it came to, when there is something to say. */
  acpNote?: string;
  onSetCommand?: (line: string) => Promise<void>;
  /** Its accounts on the computer, for Claude Code and Codex (Accounts.tsx), under its row. */
  accounts?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  // Run in Terminal: running, then what happened, said under the line.
  const [ran, setRan] = useState<"" | "running" | "opened" | "failed">("");
  const [line, setLine] = useState(acpLine ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => setLine(acpLine ?? ""), [acpLine]);
  const custom = tool === "acp";
  const info = ENGINE_INFO[tool];
  const step = installStep(tool, osOf(typeof window !== "undefined" ? window.fridayDesktop?.platform : undefined));
  const install = step.command;
  const name = ENGINE_NAMES[tool];
  const state = !found?.path ? "missing" : found.unavailable ? "unavailable" : found.loggedIn === false ? "out" : found.loggedIn ? "in" : "unknown";
  const word =
    acting === "out"
      ? "Signing out…"
      : acting === "switch"
        ? "Signing out, then back in…"
        : acting === "in"
          ? loginUrl
            ? "Finish in the page that opened"
            : "Opening the sign-in…"
          : justIn
            ? "Signed in ✓"
            : state === "missing"
              ? "Not installed"
              : state === "unavailable"
                ? "Can't run here yet"
              : state === "out"
                ? "Not signed in"
                : state === "in"
                  ? found?.source === "claude-app"
                    ? "Signed in · Claude app"
                    : "Signed in"
                  : // Found, its sign-in not something the tool lets us check: said as found, not promised as ready.
                    "Installed";
  return (
    <li className={`mb-tool ${state} ${acting ? "acting" : ""} ${justIn ? "just-in" : ""}`}>
      <span className="mb-tool-line">
        <span className="mb-tool-mark">
          <EngineMark tool={tool} size={18} />
        </span>
        <span className="mb-tool-id">
          <span className="mb-tool-name">{name}</span>
          <span className="mb-tool-state" title={state === "missing" ? (found?.app ? `${name} is installed, but Friday needs its command-line agent` : info.blurb) : state === "unavailable" ? found?.unavailable : undefined}>
            {acting && <span className="spinner tiny" aria-hidden />}
            {state === "missing" && !acting ? (custom ? "Not set up" : found?.app ? "Needs its command-line agent" : "Not installed") : word}
          </span>
        </span>
      </span>

      {acting === "in" ? (
        // Waiting on the person, in another window: the way out of that is here, beside the wait.
        <button type="button" className="btn ghost small mb-tool-go" onClick={onCancel}>
          Cancel
        </button>
      ) : acting ? null : custom ? (
        <button type="button" className="btn small mb-tool-go" aria-expanded={installing} onClick={onInstall}>
          {installing ? "Hide" : state === "missing" ? "Set up" : "Change"}
        </button>
      ) : state === "missing" ? (
        <button type="button" className="btn small mb-tool-go" aria-expanded={installing} onClick={onInstall}>
          {installing ? "Hide" : found?.app ? "Add agent" : "Install"}
        </button>
      ) : state === "out" ? (
        <button type="button" className="btn primary small mb-tool-go" disabled={busy} onClick={onSignIn}>
          Sign in
        </button>
      ) : state === "in" && !accounts ? (
        // Changing account is rare and reaches past Friday, so it is a small menu, not a button. A tool with accounts of its own
        // (Claude Code, Codex) has each one's sign-in and sign-out on its own row below instead, so nothing opens over its name.
        <MenuButton
          className="icon-btn tiny mb-tool-more"
          label={`${name} account`}
          icon="more"
          end
          compact
          items={() => [
            { heading: name },
            { label: "Use another account", disabled: busy, onSelect: () => onSignOut(true) },
            { label: "Sign out", danger: true, disabled: busy, onSelect: () => onSignOut(false) },
          ]}
        />
      ) : null}

      {state === "in" && !acting && accounts}
      {loginUrl && (
        <p className="mb-login">
          Sign in to {name} in the page that opened, and this updates by itself.{" "}
          <button type="button" className="link-btn" onClick={() => openOutside(loginUrl)}>
            Open it again
          </button>
        </p>
      )}

      {installing && custom && (
        <form
          className="mb-install mb-acp"
          onSubmit={(e) => {
            e.preventDefault();
            setSaving(true);
            void onSetCommand?.(line).finally(() => setSaving(false));
          }}
        >
          <p>The command that starts it in ACP mode, as its docs or the ACP registry give it. Install the agent first.</p>
          <input className="mb-acp-input" value={line} onChange={(e) => setLine(e.target.value)} placeholder="qwen --acp" spellCheck={false} aria-label="Command that starts the agent" />
          <p className="mb-cmd-needs">For example: qwen --acp · goose acp · vibe-acp · auggie --acp</p>
          {acpNote && (
            <p className="mb-acp-note" role="status">
              {acpNote}
            </p>
          )}
          <div className="mb-acp-actions">
            {acpLine && (
              <button type="button" className="btn ghost small" disabled={saving} onClick={() => (setLine(""), setSaving(true), void onSetCommand?.("").finally(() => setSaving(false)))}>
                Remove
              </button>
            )}
            <button type="submit" className="btn primary small" disabled={saving || !line.trim()}>
              {saving ? <span className="spinner tiny" /> : null} Save
            </button>
          </div>
        </form>
      )}

      {installing && state === "missing" && !custom && (
        <div className="mb-install">
          <p>Run this on this computer, then come back — this card notices on its own.</p>
          <div className="mb-cmd">
            <div className="mb-cmd-head">
              <span className="mb-cmd-shell">
                <span className="mb-cmd-prompt" aria-hidden>&gt;_</span> {step.shell}
              </span>
              <button
                type="button"
                className={`mb-cmd-copy ${copied ? "done" : ""}`}
                aria-label={copied ? "Copied" : `Copy the ${name} install command`}
                onClick={() =>
                  void navigator.clipboard.writeText(install).then(
                    () => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    },
                    () => {},
                  )
                }
              >
                <Icon name={copied ? "check" : "copy"} size={13} /> {copied ? "Copied" : "Copy"}
              </button>
              {onRunInstall && (
                <button
                  type="button"
                  className="mb-cmd-copy mb-cmd-run"
                  disabled={ran === "running"}
                  aria-label={`Run the ${name} install command in Terminal`}
                  onClick={() => {
                    setRan("running");
                    onRunInstall().then(
                      (r) => setRan(r.opened ? "opened" : "failed"),
                      () => setRan("failed"),
                    );
                  }}
                >
                  <Icon name="terminal" size={13} /> Run in Terminal
                </button>
              )}
            </div>
            <pre className="mb-cmd-code">
              <code>{install}</code>
            </pre>
          </div>
          {ran === "opened" && <p className="mb-cmd-needs">A Terminal window is installing {name}. When it's done, this card notices on its own.</p>}
          {ran === "failed" && <p className="mb-cmd-needs">Couldn't open a Terminal window here. Copy the line and run it yourself.</p>}
          {step.needs && <p className="mb-cmd-needs">{step.needs}</p>}
          <a className="mb-install-docs" href={info.docs} target="_blank" rel="noreferrer">
            {name} documentation
          </a>
        </div>
      )}
    </li>
  );
}
