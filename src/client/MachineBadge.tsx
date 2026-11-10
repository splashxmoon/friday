import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
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
import { isLocal } from "./edition.js";
import { openOutside } from "./openOutside.js";
import { ENGINE_INFO, installStep, osOf, splitTools, toolOrder } from "./engines.js";
import { Icon } from "./icons.js";
import { NoMachine, hostApi, machineRefusal, type LocalTool, type MachineState } from "./local.js";
import type { Identity } from "./storage.js";
import { floating, MenuButton, MoreTools, useDismiss } from "./ui.js";
import { openSettings } from "./openSettings.js";
import { useToolLimits } from "./toolLimits.js";
import { isFiveHour, isWeekly, windowsOf } from "./limitHistory.js";
import { Button } from "@/components/ui/button";

// What a waiting sign-in says under its row, loaded only while one waits (SignInNotes.tsx).
const TerminalSignIn = lazy(() => import("./SignInNotes.js").then((m) => ({ default: m.TerminalSignIn })));
const ShellSignIn = lazy(() => import("./SignInNotes.js").then((m) => ({ default: m.ShellSignIn })));
const PageSignIn = lazy(() => import("./SignInNotes.js").then((m) => ({ default: m.PageSignIn })));
const endSignInShell = (id: string) => void import("./Terminal.js").then((m) => m.endSignInShell(id));
// The ACP registry's agents, for "Other ACP agent": its own chunk, loaded when that form opens.
const RegistryPicker = lazy(() => import("./RegistryPicker.js").then((m) => ({ default: m.RegistryPicker })));
type RegistryRow = import("./RegistryPicker.js").RegistryRow;

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

/**
 * Whether a sign-in someone started is over: nothing on this computer needs one any more, or the tool they signed in to (by a page
 * or in a terminal window) is signed in, having been seen signed out first (a refresh that hasn't caught up reads "still in").
 */
export function signInFinished(o: { needsSignIn: boolean; waiting: boolean; sawSignedOut: boolean; pending: boolean | null | undefined }): boolean {
  return !o.needsSignIn || (o.waiting && o.sawSignedOut && o.pending !== undefined && o.pending !== false);
}

export function MachineBadge({ identity, machine, refresh, inline = false, welcome = false, part }: { identity: Identity; machine: MachineState; refresh: () => void; /** Always shown, compact, with no pill to open it: the new-session page's corner. */ inline?: boolean; /** In the welcome (Setup.tsx): the well-known tools always listed, ready ones first, and no line about where it runs. */ welcome?: boolean; /** Inline, one half only: the computer (Settings › Computer), or the tools on it (Settings › Coding tools). */ part?: "computer" | "tools" }) {
  const [open, setOpen] = useState(false);
  // What stays here, said for the kind of work in front of you (w1 #4: "The code, the terminal and your coding tool" in Work).
  const topLine = "The code, the terminal and your coding tool stay here. Nothing is uploaded.";
  const [step, setStep] = useState<Step>("idle");
  const [err, setErr] = useState("");
  const [signInUrl, setSignInUrl] = useState("");
  const [signInTool, setSignInTool] = useState("");
  /** A sign-in that opened in a terminal window (the tools that sign in as they start): the command it runs, to run by hand too. */
  const [signInCmd, setSignInCmd] = useState("");
  /** A sign-in Friday is carrying out with the tool, in the browser (Antigravity's, runner agy-signin.ts): its link may come later. */
  const [signInBrowser, setSignInBrowser] = useState(false);
  /** A sign-in running in a shell of Friday's own under the tool's row (the desktop app): its shell, and the line typed into it. */
  const [signInShell, setSignInShell] = useState<{ id: string; line: string } | null>(null);
  /** A terminal sign-in to prove once it is over (runner login.verify), and that proof under way. */
  const [signInVerify, setSignInVerify] = useState(false);
  const [checking, setChecking] = useState(false);
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
  // "Other ACP agent" picked from the ACP registry: installed into Friday's own folder on this computer and set as its command
  // (runner acp-registry.ts), after T3 Code, which installs any agent the registry lists.
  const registry = {
    load: () => hostApi<{ agents: RegistryRow[] }>(identity, "/api/runner/acp.registry", { method: "POST", body: "{}" }).then((r) => r.agents),
    add: async (id: string) => {
      setErr("");
      setAcpNote("");
      const r = await hostApi<{ ok: boolean; line: string; name: string; version: string; found?: boolean }>(identity, "/api/runner/acp.install", { method: "POST", body: JSON.stringify({ id }) });
      setAcpLine(r.line);
      refresh();
      setAcpNote(`${r.name} ${r.version} is installed and set. Sign in to it from its row if it asks.`);
    },
  };
  // The installed ones up top. The one whose install line is open stays where it was clicked: one opened from the tools folded
  // away stays among them, not moved up the list as its form opens (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL").
  // Settings › Coding tools lists the ones not here in the open (below), so one being installed stays where it is.
  let shown = splitTools(here ? (t) => tools.some((x) => x.tool === t) : null, moreTools || part === "tools" ? "" : installing);
  // One order, in the welcome, Settings and the agent picker alike (toolOrder).
  const order = toolOrder((t) => {
    const f = tools.find((x) => x.tool === t);
    return !f ? "absent" : f.loggedIn === false ? "signed out" : "ready";
  });
  const inOrder = (list: EngineTool[]) => [...list].sort(order);
  shown = { here: inOrder(shown.here), away: inOrder(shown.away) };
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
    // A sign-in in a terminal window waits on its own tool the same way: it waited on every tool being signed in, so with Claude
    // Code still signed out, Antigravity's row said "Opening the sign-in…" for good after it had signed in (splashxmoon/friday#21).
    const waiting = !!signInUrl || !!signInCmd || signInBrowser || !!signInShell;
    const pending = tools.find((t) => t.tool === signInTool);
    if (!waiting) sawSignedOut.current = false;
    else if (pending?.loggedIn === false) sawSignedOut.current = true;
    if (signInFinished({ needsSignIn: !!needsSignIn, waiting, sawSignedOut: sawSignedOut.current, pending: pending?.loggedIn })) {
      // A terminal sign-in the tool's own check now says is done is proven as well, by a conversation that opens (verify).
      if (waiting && pending?.loggedIn && signInVerify) {
        sawSignedOut.current = false;
        return void verify(pending.tool);
      }
      if (waiting && pending?.loggedIn) setJustIn(pending.tool);
      sawSignedOut.current = false;
      setSignInUrl("");
      setSignInCmd("");
      setSignInBrowser(false);
      setSignInShell(null);
      setSignInVerify(false);
      setSignInTool("");
      setActing((a) => (a?.what === "in" ? null : a));
      setStep((s) => (s === "signing" ? "idle" : s));
    }
  }, [here, needsSignIn, signInUrl, signInCmd, signInBrowser, !!signInShell, signInTool, tools.map((t) => `${t.tool}:${t.loggedIn}`).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  // A sign-in Friday carries out with the tool (Antigravity's): its link, once the tool prints it, and a failure said on the row
  // rather than a wait that never ends. Signed in still comes from the tool's own check, as for every other sign-in.
  useEffect(() => {
    if (!signInBrowser || !signInTool) return;
    let on = true;
    const look = () =>
      void hostApi<{ state: { phase: string; url?: string; error?: string } | null }>(identity, "/api/runner/login.state", { method: "POST", body: JSON.stringify({ tool: signInTool }) }).then(
        ({ state }) => {
          if (!on || !state) return;
          if (state.url) setSignInUrl((u) => u || state.url!);
          if (state.phase === "done") refresh();
          if (state.phase === "failed") {
            setErr(state.error || "The sign-in didn't finish. Try again.");
            setSignInUrl("");
            setSignInBrowser(false);
            setSignInTool("");
            setActing(null);
            setStep("idle");
          }
        },
        () => {},
      );
    look();
    const t = setInterval(look, 2000);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [signInBrowser, signInTool]); // eslint-disable-line react-hooks/exhaustive-deps

  // A sign-in's own shell goes when the sign-in is over, finished or given up on, and when this card goes.
  const shellId = signInShell?.id;
  useEffect(() => (shellId ? () => endSignInShell(shellId) : undefined), [shellId]);

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
  const signIn = async (tool: EngineTool, outside = false) => {
    setStep("signing");
    setActing({ tool, what: "in" });
    setErr("");
    setSignInShell(null);
    setSignInCmd("");
    try {
      // On this computer in the desktop app, a sign-in that needs a terminal runs in one of Friday's own, under the row.
      // In the desktop app its own shells, and in the open-source edition in a browser this computer's, over its own Friday.
      const inApp = !outside && machine.mode === "local" && (!!window.fridayDesktop?.terminal || isLocal());
      const r = await hostApi<{ opened?: boolean; command: string; url?: string; browser?: boolean; open?: boolean; inApp?: boolean; line?: string; verify?: boolean }>(identity, "/api/runner/login", {
        method: "POST",
        body: JSON.stringify({ tool, ...(inApp ? { inApp: true } : {}) }),
      });
      setSignInVerify(!!r.verify);
      if (r.inApp && r.line) {
        setSignInShell({ id: `signin-${tool}-${Date.now().toString(36)}`, line: r.line });
        setSignInTool(tool);
      } else if (r.browser) {
        // Friday is signing in with the tool itself, which opened its page in the browser: nothing to open from here. Unless the
        // tool asked Friday to open it (ACP's URL elicitation): then once, here.
        if (r.open && r.url) openOutside(r.url);
        setSignInUrl(r.url ?? "");
        setSignInBrowser(true);
        setSignInTool(tool);
      } else if (r.url) {
        // Not opened from here: the CLI opens the page itself, and doing it
        // again is a second tab for one sign-in.
        setSignInUrl(r.url);
        setSignInTool(tool);
      } else if (r.opened) {
        // A terminal window opened with it: waited on as a page is, with the command there to run by hand if no window shows.
        setSignInCmd(r.command);
        setSignInTool(tool);
      } else {
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
    setSignInCmd("");
    setSignInBrowser(false);
    setSignInShell(null);
    setSignInVerify(false);
    setSignInTool("");
    setActing(null);
    setStep("idle");
    refresh();
  };

  /** The address a browser on another device ended on, for the computer where the tool waits (runner login.callback). */
  const pasteBack = (tool: EngineTool, url: string) => hostApi(identity, "/api/runner/login.callback", { method: "POST", body: JSON.stringify({ tool, url }) }).then(() => {});

  /**
   * A sign-in run in a terminal is over (its shell ended, or the person says so): proven by a conversation that opens, for a tool
   * spoken to over ACP, as T3 Code proves it. Signed in, or what the tool said, on its row.
   */
  const verify = async (tool: EngineTool) => {
    if (checking) return;
    setChecking(true);
    setSignInShell(null);
    try {
      const r = await hostApi<{ ok: boolean; error?: string }>(identity, "/api/runner/login.verify", { method: "POST", body: JSON.stringify({ tool }) });
      if (r.ok) setJustIn(tool);
      else setErr(r.error ?? "The sign-in didn't take. Try again.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setChecking(false);
      setSignInUrl("");
      setSignInCmd("");
      setSignInBrowser(false);
      setSignInVerify(false);
      setSignInTool("");
      setActing(null);
      setStep("idle");
      refresh();
    }
  };

  // Settings › Coding tools: each signed-in tool says how much of its limit is left, from the same reading the Usage page has
  // (Arun, 2026-11-08: "utilize the height of this too").
  const limitsRead = useToolLimits(identity, part !== "tools");
  const left = (tool: EngineTool): string | undefined => {
    const w = windowsOf(limitsRead).filter((x) => x.tool === tool).sort((a, b) => b.used - a.used)[0];
    if (!w) return undefined;
    if (w.used >= 100) return "out until it resets";
    const of = isFiveHour(w) ? "5 hours" : isWeekly(w) ? "week" : w.minutes && w.minutes >= 40_000 ? "month" : w.label.toLowerCase();
    return `${Math.round(100 - w.used)}% of its ${of} left`;
  };

  // Ready means installed and not known to be signed out. Any one is enough to
  // work with; how many there are is the useful thing to say.
  const ready = tools.filter((t) => t.loggedIn !== false);
  const connecting = !here && auto === "trying";
  const look = !here
    ? { tone: connecting || isLocal() ? "warn" : "off", text: connecting ? "Connecting…" : isLocal() ? "Reconnecting…" : desktop ? "Not connected" : "No computer connected" }
    : ready.length >= 1
      ? { tone: "on", text: `${ready.length} coding tool${ready.length === 1 ? "" : "s"} connected`, short: `${ready.length} tool${ready.length === 1 ? "" : "s"}` }
      : needsSignIn
        ? { tone: "warn", text: `Sign in to ${needsSignIn.name}` }
        : { tone: "warn", text: "No coding tools found" };

  // Settings › Computer: this computer as the first row of its group, named, with its system and how it stays connected under
  // the name, and its state, or the one thing to do, on the right (Arun, 2026-11-04: "design this better": a lone status strip
  // over three cards in three styles, and a fact line on its own at the foot).
  if (inline && part === "computer") {
    const app = typeof window !== "undefined" && !!window.fridayDesktop;
    const os = machine.machine?.platform ? { mac: "macOS", windows: "Windows", linux: "Linux" }[osOf(machine.machine.platform)] : "";
    const linking = step === "linking" || connecting;
    const how =
      machine.mode === "checking"
        ? ""
        : here
          ? app
            ? "Connects by itself when Friday starts"
            : machine.mode === "local"
              ? "This browser reaches it directly. The desktop app keeps it connected for you."
              : "Linked to your Friday"
          : linking
            ? "There's nothing to do. It's ready in a moment."
            : isLocal()
              ? "Friday's runner here isn't answering. It comes back by itself; Retry looks now."
              : desktop
                ? "Until it is, Friday can't open its folders or run anything here."
                : "Connect it below, or open the desktop app, which connects it by itself.";
    return (
      <div className="set-mark-row" data-set-row="" role="group" aria-label="This computer">
        <span className="set-mark" aria-hidden>
          <Icon name="server" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          {/* Its name once it answers; until then, what is happening, said once: not "This computer" again under the group's title. */}
          <div className="truncate text-[13px] font-medium text-[var(--ink)]" title={here && machine.home ? machine.home : undefined}>
            {here ? machine.machine?.name || "This computer" : machine.mode === "checking" ? "Looking for this computer…" : linking ? "Connecting…" : isLocal() ? "Reconnecting…" : "Not connected"}
          </div>
          {how && <div className="mt-0.5 text-[13px] leading-snug text-[var(--text-muted)]">{[here ? os : "", how].filter(Boolean).join(" · ")}</div>}
          {autoError && (connecting || auto === "failed") && <p className="mt-1 mb-0 text-[13px] text-[var(--text-muted)]">Last try didn’t work: {autoError}</p>}
          {err && (
            <p className="mt-1 mb-0 text-[13px] text-[var(--red)]" role="alert">
              {err}
            </p>
          )}
        </div>
        <div className="ml-3 flex shrink-0 items-center gap-3">
          {here ? (
            <span className="set-state on">Connected</span>
          ) : machine.mode === "checking" || linking ? (
            <span className="spinner" aria-hidden />
          ) : desktop ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void connect()}>
              <Icon name="plug" size={13} />
              {auto === "failed" ? "Try again" : "Connect this computer"}
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" title="Looks again for a computer running the Friday desktop app" onClick={refresh}>
              <Icon name="refresh" size={13} /> Retry
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (inline)
    return (
      <section className={`mb-inline ${look.tone}${welcome ? " mb-welcome" : ""}`} aria-label={part === "computer" ? "This computer" : "Coding tools on this computer"}>
        {/* Settings › Coding tools says where only while there is no computer to list the tools of: Computer says it once. */}
        {!(welcome && here) && !(part === "tools" && here) && <div className="mb-where">
          {machine.mode === "checking" || step !== "idle" || connecting ? <span className="spinner" /> : <span className={`mb-dot ${look.tone}`} aria-hidden />}
          <span className="mb-where-text" title={here && machine.home ? machine.home : undefined}>
            {machine.mode === "checking" ? "Looking for your computer…" : here ? "Connected" : look.text}
          </span>
          {/* The computer by its name, its folder on hover: a raw path led the card (audit REST-16, Arun 2026-11-04). */}
          {here && machine.machine?.name && (
            <span className="mb-where-name" title={machine.home || undefined}>
              · {machine.machine.name}
            </span>
          )}
        </div>}
        {here && part === "computer" ? null : here && part === "tools" ? (
          <>
            <ul className="mb-tools">
              {shown.here.map((tool) => (
                <ToolRow
                  {...(part === "tools" ? { settings: true, left: left(tool) } : {})}
                  key={tool}
                  tool={tool}
                  found={tools.find((x) => x.tool === tool) ?? machine.tools.find((x) => x.tool === tool) ?? null}
                  accounts={ACCOUNT_TOOLS.includes(tool) ? <AccountList identity={identity} tool={tools.find((x) => x.tool === tool) ?? machine.tools.find((x) => x.tool === tool) ?? { tool, name: "", path: null, loggedIn: null, source: null }} onChanged={refresh} /> : undefined}
                  busy={step === "signing" && acting?.tool !== tool}
                  acting={acting?.tool === tool ? acting.what : null}
                  justIn={justIn === tool}
                  {...(signInUrl && signInTool === tool ? { loginUrl: signInUrl } : {})}
                  {...(signInCmd && signInTool === tool ? { loginCmd: signInCmd } : {})}
                  {...(signInBrowser && signInTool === tool ? { loginPage: true } : {})}
                  {...(signInShell && signInTool === tool ? { loginShell: signInShell, onOutside: () => void signIn(tool, true), onShellEnd: () => void verify(tool) } : {})}
                  {...(signInTool === tool && signInVerify && signInCmd ? { onDone: () => void verify(tool) } : {})}
                  {...(signInTool === tool && signInBrowser ? { onPaste: (url: string) => pasteBack(tool, url) } : {})}
                  {...(checking && signInTool === tool ? { checking: true } : {})}
                  installing={installing === tool}
                  onInstall={() => setInstalling(installing === tool ? "" : tool)}
                  onRunInstall={() => hostApi<{ opened: boolean; command: string }>(identity, "/api/runner/install", { method: "POST", body: JSON.stringify({ tool }) })}
                  onSignIn={() => void signIn(tool)}
                  onSignOut={(thenIn) => void signOut(tool, thenIn)}
                  onCancel={() => cancelSignIn(tool)}
                  {...(tool === "acp" ? { acpLine, acpNote, onSetCommand: setCommand, registry } : {})}
                />
              ))}
            </ul>
            {shown.away.length > 0 && (
              <section className="mb-away" aria-label="More coding tools">
                <header className="mb-away-head">
                  <h3>More coding tools</h3>
                  <p>Friday works with these too. Install one, and it's listed above, ready to sign in.</p>
                </header>
                <ul className="mb-tools">
                  {shown.away.map((tool) => (
                    <ToolRow
                      {...(part === "tools" ? { settings: true, left: left(tool) } : {})}
                      key={tool}
                      tool={tool}
                      found={tools.find((x) => x.tool === tool) ?? machine.tools.find((x) => x.tool === tool) ?? null}
                      accounts={ACCOUNT_TOOLS.includes(tool) ? <AccountList identity={identity} tool={tools.find((x) => x.tool === tool) ?? machine.tools.find((x) => x.tool === tool) ?? { tool, name: "", path: null, loggedIn: null, source: null }} onChanged={refresh} /> : undefined}
                      busy={step === "signing" && acting?.tool !== tool}
                      acting={acting?.tool === tool ? acting.what : null}
                      justIn={justIn === tool}
                      {...(signInUrl && signInTool === tool ? { loginUrl: signInUrl } : {})}
                  {...(signInCmd && signInTool === tool ? { loginCmd: signInCmd } : {})}
                  {...(signInBrowser && signInTool === tool ? { loginPage: true } : {})}
                  {...(signInShell && signInTool === tool ? { loginShell: signInShell, onOutside: () => void signIn(tool, true), onShellEnd: () => void verify(tool) } : {})}
                  {...(signInTool === tool && signInVerify && signInCmd ? { onDone: () => void verify(tool) } : {})}
                  {...(signInTool === tool && signInBrowser ? { onPaste: (url: string) => pasteBack(tool, url) } : {})}
                  {...(checking && signInTool === tool ? { checking: true } : {})}
                      installing={installing === tool}
                      onInstall={() => setInstalling(installing === tool ? "" : tool)}
                      onRunInstall={() => hostApi<{ opened: boolean; command: string }>(identity, "/api/runner/install", { method: "POST", body: JSON.stringify({ tool }) })}
                      onSignIn={() => void signIn(tool)}
                      onSignOut={(thenIn) => void signOut(tool, thenIn)}
                      onCancel={() => cancelSignIn(tool)}
                      {...(tool === "acp" ? { acpLine, acpNote, onSetCommand: setCommand, registry } : {})}
                    />
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : here ? (
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
                  {...(signInCmd && signInTool === tool ? { loginCmd: signInCmd } : {})}
                  {...(signInBrowser && signInTool === tool ? { loginPage: true } : {})}
                  {...(signInShell && signInTool === tool ? { loginShell: signInShell, onOutside: () => void signIn(tool, true), onShellEnd: () => void verify(tool) } : {})}
                  {...(signInTool === tool && signInVerify && signInCmd ? { onDone: () => void verify(tool) } : {})}
                  {...(signInTool === tool && signInBrowser ? { onPaste: (url: string) => pasteBack(tool, url) } : {})}
                  {...(checking && signInTool === tool ? { checking: true } : {})}
                installing={installing === tool}
                onInstall={() => setInstalling(installing === tool ? "" : tool)}
                onRunInstall={() => hostApi<{ opened: boolean; command: string }>(identity, "/api/runner/install", { method: "POST", body: JSON.stringify({ tool }) })}
                onSignIn={() => void signIn(tool)}
                onSignOut={(thenIn) => void signOut(tool, thenIn)}
                onCancel={() => cancelSignIn(tool)}
                {...(tool === "acp" ? { acpLine, acpNote, onSetCommand: setCommand, registry } : {})}
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
        {/* The ready tools' marks, side by side, each at rest in a thin dashed circle, then how many: "2 tools" wears two marks, no
            dot and no rings (audit REST-5, Arun 2026-11-04). One signed out is in the card behind it, not here. */}
        {(() => {
          const marks = here ? shown.here.filter((t) => ready.some((r) => r.tool === t)).slice(0, 3) : [];
          if (machine.mode === "checking" || step !== "idle" || connecting) return <span className="spinner" />;
          if (!marks.length) return <span className="mb-dot" aria-hidden />;
          return (
            <span className="mb-marks" aria-hidden>
              {marks.map((t) => (
                <span key={t} className="mb-mark">
                  <EngineMark tool={t} size={11} />
                </span>
              ))}
            </span>
          );
        })()}
        <span className="mb-text" title={here ? look.text : undefined}>
          {machine.mode === "checking" ? "Looking for your computer…" : "short" in look && look.short ? look.short : look.text}
        </span>
        <Icon name="chevronDown" size={12} />
      </button>

      {open &&
        floating(
          // A modal, centred over a dimmed page, where it was a dropdown under the pill (Arun, 2026-11-10: "can we make this into a
          // modal pop up instead of a dropdown.... properly designed"): room for every tool's row, its sign-in under it, and a
          // way to Settings, with the page behind it still. Esc, the close button or a press outside closes it.
          <div className="overlay mb-overlay">
            <ToolsModal onClose={() => setOpen(false)} trigger={btn.current}>
              <header className="mb-modal-head">
                <div className="mb-modal-titles">
                  <h2 id="mb-modal-title">{here ? "Coding tools" : "Your computer"}</h2>
                  {here ? (
                    <p className="mb-modal-where" title={machine.home || undefined}>
                      <span className="mb-dot on" aria-hidden />
                      <span className="mb-where-text">Connected</span>
                      {machine.machine?.name && <span className="mb-where-name">· {machine.machine.name}</span>}
                    </p>
                  ) : null}
                </div>
                <button type="button" className="icon-btn tiny" aria-label="Close" onClick={() => setOpen(false)}>
                  <Icon name="x" size={15} />
                </button>
              </header>
              <p className="mb-modal-lead">{topLine}</p>

              <div className="mb-modal-body">
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
                  <>
                    <section className="mb-modal-group" aria-labelledby="mb-here-title">
                      <h3 id="mb-here-title" className="mb-modal-label">
                        On this computer <span className="mb-modal-count">{shown.here.length}</span>
                      </h3>
                      <ul className="mb-tools">
                  {shown.here.map((tool) => (
                        <ToolRow
                            key={tool}
                            tool={tool}
                            found={tools.find((x) => x.tool === tool) ?? machine.tools.find((x) => x.tool === tool) ?? null}
                        accounts={ACCOUNT_TOOLS.includes(tool) ? <AccountList identity={identity} tool={tools.find((x) => x.tool === tool) ?? machine.tools.find((x) => x.tool === tool) ?? { tool, name: "", path: null, loggedIn: null, source: null }} onChanged={refresh} /> : undefined}
                            busy={step === "signing" && acting?.tool !== tool}
                            acting={acting?.tool === tool ? acting.what : null}
                            justIn={justIn === tool}
                            {...(signInUrl && signInTool === tool ? { loginUrl: signInUrl } : {})}
                          {...(signInCmd && signInTool === tool ? { loginCmd: signInCmd } : {})}
                          {...(signInBrowser && signInTool === tool ? { loginPage: true } : {})}
                          {...(signInShell && signInTool === tool ? { loginShell: signInShell, onOutside: () => void signIn(tool, true), onShellEnd: () => void verify(tool) } : {})}
                          {...(signInTool === tool && signInVerify && signInCmd ? { onDone: () => void verify(tool) } : {})}
                          {...(signInTool === tool && signInBrowser ? { onPaste: (url: string) => pasteBack(tool, url) } : {})}
                          {...(checking && signInTool === tool ? { checking: true } : {})}
                            installing={installing === tool}
                            onInstall={() => setInstalling(installing === tool ? "" : tool)}
                            onSignIn={() => void signIn(tool)}
                            onSignOut={(thenIn) => void signOut(tool, thenIn)}
                            onCancel={() => cancelSignIn(tool)}
                            {...(tool === "acp" ? { acpLine, acpNote, onSetCommand: setCommand, registry } : {})}
                          />
                      ))}
                      </ul>
                    </section>
                    {shown.away.length > 0 && (
                      <section className="mb-modal-group" aria-label="More coding tools">
                        <button type="button" className="mb-modal-label mb-modal-toggle" aria-expanded={moreTools} onClick={() => setMoreTools((v) => !v)}>
                          <span>
                            More coding tools <span className="mb-modal-count">{shown.away.length}</span>
                          </span>
                          {!moreTools && (
                            <span className="mb-modal-peek" aria-hidden>
                              {shown.away.slice(0, 8).map((t) => (
                                <EngineMark key={t} tool={t} size={13} />
                              ))}
                            </span>
                          )}
                          <Icon name="chevronDown" size={13} className={moreTools ? "mb-modal-caret open" : "mb-modal-caret"} />
                        </button>
                        {moreTools && (
                          <ul className="mb-tools">
                  {shown.away.map((tool) => (
                            <ToolRow
                                key={tool}
                                tool={tool}
                                found={tools.find((x) => x.tool === tool) ?? machine.tools.find((x) => x.tool === tool) ?? null}
                            accounts={ACCOUNT_TOOLS.includes(tool) ? <AccountList identity={identity} tool={tools.find((x) => x.tool === tool) ?? machine.tools.find((x) => x.tool === tool) ?? { tool, name: "", path: null, loggedIn: null, source: null }} onChanged={refresh} /> : undefined}
                                busy={step === "signing" && acting?.tool !== tool}
                                acting={acting?.tool === tool ? acting.what : null}
                                justIn={justIn === tool}
                                {...(signInUrl && signInTool === tool ? { loginUrl: signInUrl } : {})}
                              {...(signInCmd && signInTool === tool ? { loginCmd: signInCmd } : {})}
                              {...(signInBrowser && signInTool === tool ? { loginPage: true } : {})}
                              {...(signInShell && signInTool === tool ? { loginShell: signInShell, onOutside: () => void signIn(tool, true), onShellEnd: () => void verify(tool) } : {})}
                              {...(signInTool === tool && signInVerify && signInCmd ? { onDone: () => void verify(tool) } : {})}
                              {...(signInTool === tool && signInBrowser ? { onPaste: (url: string) => pasteBack(tool, url) } : {})}
                              {...(checking && signInTool === tool ? { checking: true } : {})}
                                installing={installing === tool}
                                onInstall={() => setInstalling(installing === tool ? "" : tool)}
                                onSignIn={() => void signIn(tool)}
                                onSignOut={(thenIn) => void signOut(tool, thenIn)}
                                onCancel={() => cancelSignIn(tool)}
                                {...(tool === "acp" ? { acpLine, acpNote, onSetCommand: setCommand, registry } : {})}
                              />
                          ))}
                          </ul>
                        )}
                      </section>
                    )}
                  </>
                )}
              </div>

              {err && <p className="mb-err">{err}</p>}
              {here && (
                <footer className="mb-modal-foot">
                  <span>Friday uses your own sign-ins, and never holds a key.</span>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      setOpen(false);
                      openSettings("coding-tools");
                    }}
                  >
                    Open in Settings
                  </button>
                </footer>
              )}
            </ToolsModal>
          </div>,
        )}
    </div>
  );
}

/**
 * Scrolls the list a row sits in (or the sheet, in the welcome) just enough to show all of the row, its top first when it is
 * taller than the room: never past its top. The list's sticky "Fewer coding tools" row at its foot is not room.
 */
function showRowIn(li: HTMLElement): void {
  let box: HTMLElement | null = li.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  if (!box) return;
  const foot = box.querySelector<HTMLElement>(":scope > .mb-more");
  const b = box.getBoundingClientRect();
  const r = li.getBoundingClientRect();
  const bottom = b.bottom - (foot && getComputedStyle(foot).position === "sticky" ? foot.offsetHeight : 0);
  let by = r.bottom > bottom ? r.bottom - bottom : 0;
  if (r.top - by < b.top) by = r.top - b.top;
  if (Math.abs(by) < 1) return;
  const calm = document.documentElement.classList.contains("reduce-motion") || matchMedia("(prefers-reduced-motion: reduce)").matches;
  box.scrollBy({ top: by, behavior: calm ? "auto" : "smooth" });
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
  loginCmd,
  loginPage = false,
  loginShell,
  onOutside,
  onShellEnd,
  onDone,
  onPaste,
  checking = false,
  installing,
  onInstall,
  onRunInstall,
  onSignIn,
  onSignOut,
  onCancel,
  acpLine,
  acpNote,
  onSetCommand,
  registry,
  accounts,
  settings = false,
  left,
}: {
  /** Settings › Coding tools: a tool not here says what it is, under its name, in place of "Not installed". */
  settings?: boolean;
  /** How much of its limit is left, said after "Signed in". */
  left?: string | undefined;
  tool: EngineTool;
  found: LocalTool | null;
  busy: boolean;
  /** Being signed out, switched or signed in right now: said here, on this tool's row, while it happens. */
  acting?: Acting | null;
  /** Signed in a moment ago. */
  justIn?: boolean;
  /** The sign-in page the CLI opened, while it waits for the person to finish there. */
  loginUrl?: string;
  /** The sign-in command a terminal window was opened with, while it waits for the person to finish there. */
  loginCmd?: string;
  /** A sign-in in the browser that Friday is carrying out with the tool (Antigravity's), its link in `loginUrl` once known. */
  loginPage?: boolean;
  /** A sign-in running in a shell of Friday's own, drawn under the row. */
  loginShell?: { id: string; line: string };
  /** The same sign-in in a terminal window of its own instead. */
  onOutside?: () => void;
  /** Its shell ended: the sign-in's command is over, to be proven. */
  onShellEnd?: () => void;
  /** "Done" for a sign-in in a terminal window: proven when pressed. */
  onDone?: () => void;
  /** A browser sign-in finished on another device: the address its browser ended on, sent to the computer. */
  onPaste?: (url: string) => Promise<void>;
  /** The sign-in being proven by a conversation that opens. */
  checking?: boolean;
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
  /** The ACP registry's agents, and one of them installed and set. */
  registry?: { load: () => Promise<RegistryRow[]>; add: (id: string) => Promise<void> };
  /** Its accounts on the computer, for Claude Code and Codex (Accounts.tsx), under its row. */
  accounts?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  // What opens under the row (an install line, Other ACP agent's form) is brought into view, opening at its top: in the capped
  // list on Settings it opened under the visible part, behind "Fewer coding tools" (audit e2e, Arun 2026-11-04).
  const row = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!installing) return;
    const raf = requestAnimationFrame(() => {
      const li = row.current;
      if (li) showRowIn(li);
    });
    return () => cancelAnimationFrame(raf);
  }, [installing]);
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
  const word = checking
    ? "Checking the sign-in…"
    : acting === "out"
      ? "Signing out…"
      : acting === "switch"
        ? "Signing out, then back in…"
        : acting === "in"
          ? loginUrl || loginPage
            ? "Finish in the page that opened"
            : loginShell
              ? "Finish signing in below"
              : loginCmd
              ? "Finish in the terminal that opened"
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
    <li ref={row} className={`mb-tool ${state} ${acting ? "acting" : ""} ${justIn ? "just-in" : ""}`}>
      <span className="mb-tool-line">
        <span className="mb-tool-mark">
          <EngineMark tool={tool} size={18} />
        </span>
        <span className="mb-tool-id">
          <span className="mb-tool-name">{name}</span>
          <span className="mb-tool-state" title={state === "missing" ? (found?.app ? `${name} is installed, but Friday needs its command-line agent` : info.blurb) : state === "unavailable" ? found?.unavailable : undefined}>
            {acting && <span className="spinner tiny" aria-hidden />}
            {state === "missing" && !acting ? (custom ? (settings ? "Any agent that speaks ACP, by its command" : "Not set up") : found?.app ? "Needs its command-line agent" : settings ? info.blurb : "Not installed") : word}
            {state === "in" && !acting && !justIn && left && <span className="mb-tool-left"> · {left}</span>}
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
      ) : state === "unknown" && !custom ? (
        // Installed, its sign-in something it doesn't let Friday check (Gemini CLI without its Google file, Qwen, Droid): a sign-in
        // offered all the same, quieter, since it may not need one, and proven by a conversation that opens once it's done.
        <button type="button" className="btn ghost small mb-tool-go" disabled={busy} onClick={onSignIn}>
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
      {(loginCmd || loginShell || loginUrl || loginPage) && (
        // Only while a sign-in waits, so its own chunk (SignInNotes.tsx), loaded then: the first screen doesn't carry it.
        <Suspense fallback={null}>
          {loginCmd && !loginUrl && <TerminalSignIn name={name} command={loginCmd} {...(onDone ? { onDone } : {})} />}
          {loginShell && <ShellSignIn name={name} shell={loginShell} {...(onOutside ? { onOutside } : {})} {...(onShellEnd ? { onEnd: onShellEnd } : {})} />}
          {(loginUrl || loginPage) && <PageSignIn name={name} url={loginUrl ?? ""} ours={loginPage} {...(onPaste ? { onPaste } : {})} />}
        </Suspense>
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
          {registry && (
            <Suspense fallback={null}>
              <RegistryPicker registry={registry} />
            </Suspense>
          )}
          <p>Or the command that starts it in ACP mode, as its docs give it. Install the agent first.</p>
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



/**
 * The tools' modal itself, mounted only while open, so that it closes on Esc or a press outside, takes the keyboard's focus as it
 * opens, keeps Tab inside, and hands focus back to the pill as it closes (useDismiss). A dismiss set up on the badge itself ran
 * before there was anything to focus.
 */
function ToolsModal({ onClose, trigger, children }: { onClose: () => void; trigger: HTMLElement | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose, trigger);
  return (
    <div ref={ref} className="modal mb-modal" role="dialog" aria-modal="true" aria-labelledby="mb-modal-title">
      {children}
    </div>
  );
}
