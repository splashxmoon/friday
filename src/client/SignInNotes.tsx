import { useState } from "react";
import { Icon } from "./icons.js";
import { openOutside } from "./openOutside.js";
import { SignInShell } from "./Terminal.js";

/**
 * What a coding tool's sign-in says under its row while it waits (MachineBadge ToolRow), in a chunk of its own: loaded only
 * while one waits, so the first screen doesn't carry it.
 */

/**
 * A sign-in that opened in a terminal window: finish it there, and the row updates by itself. If no window showed (a window
 * hidden behind others, or a terminal that couldn't be started), the same command runs from any terminal (splashxmoon/friday#21).
 */
export function TerminalSignIn({ name, command, onDone }: { name: string; command: string; /** Proven when pressed. */ onDone?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <p className="mb-login">
      Finish signing in to {name} in the terminal window that opened, and this updates by itself. No window? Run <code className="mb-login-cmd">{command}</code> in a terminal.{" "}
      <button
        type="button"
        className="link-btn mb-login-copy"
        aria-label={copied ? "Copied" : "Copy the command"}
        title={copied ? "Copied" : "Copy the command"}
        onClick={() =>
          void navigator.clipboard.writeText(command).then(
            () => (setCopied(true), setTimeout(() => setCopied(false), 1500)),
            () => {},
          )
        }
      >
        <Icon name={copied ? "check" : "copy"} size={12} />
      </button>
      {onDone && (
        <>
          {" "}
          <button type="button" className="link-btn" onClick={onDone}>
            Done signing in
          </button>
        </>
      )}
    </p>
  );
}

/** A sign-in running in a shell of Friday's own, drawn under the row: the tool's own screen, typed into there. */
export function ShellSignIn({ name, shell, onOutside, onEnd }: { name: string; shell: { id: string; line: string }; onOutside?: () => void; onEnd?: () => void }) {
  return (
    <div className="mb-login-shell">
      <p className="mb-login">
        Finish signing in to {name} here, and this updates by itself.{" "}
        {onOutside && (
          <button type="button" className="link-btn" onClick={onOutside}>
            Use a terminal window instead
          </button>
        )}
      </p>
      <div className="mb-login-term">
        <SignInShell id={shell.id} run={shell.line} {...(onEnd ? { onEnd } : {})} />
      </div>
    </div>
  );
}

/** The page a sign-in sends the browser back to on the tool's computer, when it has one (http://127.0.0.1:<port>/…). */
const loopback = (url: string) => {
  try {
    const back = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
    return back.protocol === "http:" && ["127.0.0.1", "localhost"].includes(back.hostname);
  } catch {
    return false;
  }
};

/**
 * A sign-in in the browser: finish it in the page that opened, its link offered again. `ours`: one Friday carries out with the
 * tool (its link may come a moment later). Where the page sends the browser back to the tool's computer, a browser on another
 * device can't get there: its address is pasted here instead (as T3 Code and Orca take it), and sent on.
 */
export function PageSignIn({ name, url, ours, onPaste }: { name: string; url: string; ours: boolean; onPaste?: (url: string) => Promise<void> }) {
  const [pasting, setPasting] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  return (
    <>
      <p className="mb-login">
        Sign in to {name} in the page that opened, and this updates by itself.{" "}
        {url ? (
          <button type="button" className="link-btn" onClick={() => openOutside(url)}>
            {ours ? "No page? Open it" : "Open it again"}
          </button>
        ) : (
          ours && <span className="muted">Its page can take a few seconds to open.</span>
        )}
        {url && onPaste && loopback(url) && !pasting && (
          <>
            {" · "}
            <button type="button" className="link-btn" onClick={() => setPasting(true)}>
              Signing in on another device?
            </button>
          </>
        )}
      </p>
      {pasting && onPaste && (
        <form
          className="mb-login-paste"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setNote("");
            onPaste(value)
              .then(
                () => setNote("Sent. This updates in a moment."),
                (err) => setNote((err as Error).message),
              )
              .finally(() => setBusy(false));
          }}
        >
          <p className="mb-login">Open the link there and approve. Its browser ends on a page that won't load: paste that page's address here.</p>
          <span className="mb-login-paste-row">
            <input className="mb-acp-input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="http://127.0.0.1:…" aria-label="The address the browser ended on" spellCheck={false} autoFocus />
            <button type="submit" className="btn primary small" disabled={busy || !value.trim()}>
              {busy ? <span className="spinner tiny" /> : null} Finish
            </button>
          </span>
          {note && (
            <p className="mb-acp-note" role="status">
              {note}
            </p>
          )}
        </form>
      )}
    </>
  );
}
