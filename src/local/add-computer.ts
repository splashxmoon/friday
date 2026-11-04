
/**
 * An extra machine, easily (Arun, 2026-11-03: "also look into easy extra machine running too"; docs/plans/dev-essentials.md §4).
 *
 * A computer joined this Friday only by installing the Friday app there and pasting a link. A spare Mac mini, a Linux box or a
 * cloud VM shouldn't need the app, a screen, or a trip to it, so it can now be added two more ways from Settings › Your computers:
 *
 * - over SSH, with this computer's own ssh (its ~/.ssh/config, keys and agent): Friday installs the open-source Friday there in a
 *   folder of its own, pairs it with this one, and leaves it running as a service (systemd, launchd) that comes back after a
 *   restart, and stops for good when it is removed here;
 * - with one command to paste in a terminal there, any system with Node.js 22: `npx -y github:splashxmoon/friday --join '…'`.
 *
 * Either way the machine runs headless and holds a link here, pinned to this computer's certificate, over Wi-Fi or Tailscale, as
 * a computer paired by the app does: its coding tools show up in "runs on" for Code sessions and teammates. Nothing goes
 * through Friday's servers. The link's code works once, for ten minutes.
 */

/** A pairing link as Settings › Your computers makes it: checked before it goes into a command or a script, so it can't end a quote. */
export const JOIN_LINK = /^friday:\/\/computer\?[\w=&%.:,~+-]{10,1500}$/;

/** The package the extra machine runs: the open-source Friday, from its repository. */
export const PACKAGE = "github:splashxmoon/friday";

/** The one command to paste on the other machine, for its shell. */
export function joinCommand(link: string): { unix: string; windows: string } {
  if (!JOIN_LINK.test(link)) throw new Error("That isn't a link from Your computers.");
  return { unix: `npx -y ${PACKAGE} --join '${link}'`, windows: `npx -y ${PACKAGE} --join "${link}"` };
}

/**
 * The script `ssh <host> sh -s` runs to make the machine an extra one: Node.js 22 found (the login shell's PATH, nvm, fnm, volta,
 * mise, Homebrew), the open-source Friday installed into ~/.friday-linked (no sudo), then a service started with the link, its
 * data kept apart from any Friday already there (FRIDAY_HOME), and FRIDAY_SERVICE set so a removal ends it with 0, which neither
 * systemd (Restart=on-failure) nor launchd (KeepAlive SuccessfulExit false) starts again. Lines starting FRIDAY_ are read by
 * joinSshResult; the rest is shown if something goes wrong.
 *
 * In two parts, run one after the other (app.ts): "install", then "service" with a code made only once the install is done, so
 * a slow install can't outlive the code's ten minutes (2026-11-04 linking research). "all" is both at once.
 */
export function joinScript(link: string, name: string, part: "all" | "install" | "service" = "all"): string {
  if (part !== "install" && !JOIN_LINK.test(link)) throw new Error("That isn't a link from Your computers.");
  const label = name.replace(/[^\w.-]/g, "").slice(0, 40) || "this";
  const head = `set -e
${part === "install" ? "" : `LINK='${link}'\n`}say() { printf '%s\\n' "$*"; }
LOGIN_PATH=$("\${SHELL:-/bin/sh}" -lc 'printf %s "$PATH"' 2>/dev/null || true)
[ -n "$LOGIN_PATH" ] && PATH="$LOGIN_PATH:$PATH"
export PATH
NODE=$(command -v node || true)
if [ -z "$NODE" ]; then
  for f in "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node "$HOME"/Library/Application\\ Support/fnm/node-versions/*/installation/bin/node "$HOME"/.fnm/node-versions/*/installation/bin/node "$HOME"/.volta/bin/node "$HOME"/.local/share/mise/installs/node/*/bin/node "$HOME"/.local/share/mise/shims/node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do [ -x "$f" ] && NODE="$f"; done
fi
[ -n "$NODE" ] || { say "FRIDAY_ERROR no-node"; exit 20; }
MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$MAJOR" -ge 22 ] || { say "FRIDAY_ERROR old-node $MAJOR"; exit 21; }
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM=$(command -v npm || true)
[ -n "$NPM" ] || { say "FRIDAY_ERROR no-npm"; exit 23; }
DIR="$HOME/.friday-linked"
`;
  // git itself, not only a git on the PATH: macOS's /usr/bin/git is a placeholder that asks for the developer tools.
  const install = `git --version >/dev/null 2>&1 || { say "FRIDAY_ERROR no-git"; exit 24; }
mkdir -p "$DIR"
chmod 700 "$DIR"
say "FRIDAY_STEP install"
PATH="$(dirname "$NODE"):$PATH" "$NPM" install --prefix "$DIR" --no-audit --no-fund --loglevel=error ${PACKAGE} >"$DIR/install.log" 2>&1 || { tail -n 20 "$DIR/install.log"; say "FRIDAY_ERROR install"; exit 25; }
[ -e "$DIR/node_modules/.bin/friday" ] || { say "FRIDAY_ERROR install"; exit 25; }
say "FRIDAY_INSTALLED"
`;
  const service = `BIN="$DIR/node_modules/.bin/friday"
[ -e "$BIN" ] || { say "FRIDAY_ERROR install"; exit 25; }
LOG="$DIR/friday.log"
ENVS="FRIDAY_HOME=$DIR/data FRIDAY_SERVICE=1 FRIDAY_NO_OPEN=1"
say "FRIDAY_STEP service"
if [ "$(uname -s)" = "Linux" ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  UNIT="$HOME/.config/systemd/user/friday-linked.service"
  mkdir -p "$(dirname "$UNIT")"
  {
    printf '[Unit]\\nDescription=Friday, an extra machine for %s\\nAfter=network-online.target\\n\\n' '${label}'
    printf '[Service]\\nEnvironment="PATH=%s" "FRIDAY_HOME=%s/data" "FRIDAY_SERVICE=1" "FRIDAY_NO_OPEN=1"\\nWorkingDirectory=%s\\n' "$(dirname "$NODE"):$PATH" "$DIR" "$HOME"
    # systemd reads % as the start of a specifier: the link's own (%2C) are doubled.
    printf 'ExecStart="%s" "%s" --join "%s"\\n' "$NODE" "$BIN" "$(printf %s "$LINK" | sed 's/%/%%/g')"
    printf 'Restart=on-failure\\nRestartSec=5\\n\\n[Install]\\nWantedBy=default.target\\n'
  } > "$UNIT"
  chmod 600 "$UNIT"
  systemctl --user daemon-reload
  systemctl --user enable --now friday-linked.service >/dev/null 2>&1
  systemctl --user restart friday-linked.service
  loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || say "FRIDAY_WARN linger"
  say "FRIDAY_DONE systemd"
elif [ "$(uname -s)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.tryfriday.linked.plist"
  mkdir -p "$(dirname "$PLIST")"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\\n'
    printf '<plist version="1.0"><dict>\\n<key>Label</key><string>com.tryfriday.linked</string>\\n'
    printf '<key>ProgramArguments</key><array><string>%s</string><string>%s</string><string>--join</string><string>%s</string></array>\\n' "$NODE" "$BIN" "$(printf %s "$LINK" | sed 's/&/\\&amp;/g')"
    printf '<key>EnvironmentVariables</key><dict><key>PATH</key><string>%s</string><key>FRIDAY_HOME</key><string>%s/data</string><key>FRIDAY_SERVICE</key><string>1</string><key>FRIDAY_NO_OPEN</key><string>1</string></dict>\\n' "$(dirname "$NODE"):$PATH" "$DIR"
    printf '<key>WorkingDirectory</key><string>%s</string>\\n<key>RunAtLoad</key><true/>\\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\\n' "$HOME"
    printf '<key>StandardOutPath</key><string>%s</string>\\n<key>StandardErrorPath</key><string>%s</string>\\n</dict></plist>\\n' "$LOG" "$LOG"
  } > "$PLIST"
  chmod 600 "$PLIST"
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1 || true
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || launchctl load -w "$PLIST" >/dev/null 2>&1; then say "FRIDAY_DONE launchd"
  else
    env $ENVS nohup "$NODE" "$BIN" --join "$LINK" >> "$LOG" 2>&1 &
    say "FRIDAY_DONE background"
  fi
else
  cd "$HOME"
  env $ENVS nohup "$NODE" "$BIN" --join "$LINK" >> "$LOG" 2>&1 &
  say "FRIDAY_DONE background"
fi
`;
  return head + (part === "service" ? "" : install) + (part === "install" ? "" : service);
}

/** The last lines of a machine's Friday log, for setup to show when it set up but didn't link (its service's, else its file). */
export const logTailScript = `journalctl --user -u friday-linked.service -n 12 --no-pager -o cat 2>/dev/null | grep . || tail -n 12 "$HOME/.friday-linked/friday.log" 2>/dev/null || true
`;

export type SshOutcome = { ok: true; how: "systemd" | "launchd" | "background"; warn?: string } | { ok: false; error: string };

/** What `ssh <host> …` may be given as the host: an alias from ~/.ssh/config, a name, or user@host. Never an option (`-o…`). */
export const SSH_HOST = /^(?!-)[\w.-]+(@[\w.-]+)?$/;

/** The host aliases in an ~/.ssh/config, for the host field to suggest. Patterns (*, ?, !) are left out: they aren't one host. */
export function sshConfigHosts(config: string): string[] {
  const out: string[] = [];
  for (const line of config.split(/\r?\n/)) {
    const m = line.match(/^\s*Host\s+(.+)$/i);
    if (!m) continue;
    for (const h of m[1]!.trim().split(/\s+/)) if (h && !/[*?!]/.test(h) && SSH_HOST.test(h) && !out.includes(h)) out.push(h);
  }
  return out;
}

/** What came back from ssh, in words for the person: what was set up, or why it wasn't and what to do about it. */
export function joinSshResult(code: number | null, out: string, host: string): SshOutcome {
  const done = out.match(/^FRIDAY_DONE (systemd|launchd|background)$/m);
  if (done) {
    const how = done[1] as "systemd" | "launchd" | "background";
    const warn = /^FRIDAY_WARN linger$/m.test(out)
      ? `It stops when you log out of ${host}, unless someone with admin rights there runs: sudo loginctl enable-linger $USER`
      : how === "background"
        ? `It runs in the background on ${host}, but won't come back by itself after a restart. Add it again after one.`
        : undefined;
    return { ok: true, how, ...(warn ? { warn } : {}) };
  }
  const old = out.match(/^FRIDAY_ERROR old-node (\d+)$/m);
  if (old) return { ok: false, error: `${host} has Node ${old[1]}. Friday needs Node 22 or newer there: update it, then try again.` };
  if (/^FRIDAY_ERROR no-node$/m.test(out)) return { ok: false, error: `${host} doesn't have Node. Install Node 22 or newer there, then try again.` };
  if (/^FRIDAY_ERROR no-npm$/m.test(out)) return { ok: false, error: `${host} has Node but no npm beside it. Install Node from nodejs.org there, then try again.` };
  if (/^FRIDAY_ERROR no-git$/m.test(out)) return { ok: false, error: `${host} doesn't have git, which installing Friday needs. Install it there, then try again.` };
  if (/^FRIDAY_ERROR install$/m.test(out)) return { ok: false, error: `Friday couldn't be installed on ${host}: ${out.split("\n").filter((l) => l.trim() && !/^FRIDAY_/.test(l)).slice(-2).join(" ").slice(0, 300) || "npm said no"}` };
  if (/Permission denied|publickey/i.test(out)) return { ok: false, error: `${host} didn't accept your key. If your key has a passphrase, run ssh-add once so it's remembered, then try again. Check you can run ssh ${host} in a terminal.` };
  if (/Could not resolve hostname|Name or service not known/i.test(out)) return { ok: false, error: `Couldn't find ${host}. Check the name, or add it to your ~/.ssh/config.` };
  // Changed since you last connected, said so; never connected before is something else (2026-11-04 linking test: a first-time
  // host was told its identity had changed). Friday's own ssh accepts a new host's key (accept-new), so this is an older run.
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(out)) return { ok: false, error: `${host}'s identity has changed since you last connected, so Friday stopped. If you expected that, update ~/.ssh/known_hosts, then try again.` };
  if (/Host key verification failed/i.test(out)) return { ok: false, error: `You haven't connected to ${host} over SSH before, and its key couldn't be checked. Run ssh ${host} once in a terminal and accept its key, then try again.` };
  if (/timed out|Connection refused|No route to host/i.test(out)) return { ok: false, error: `Couldn't reach ${host}. Check it's on and that SSH is open, then try again.` };
  if (/'sh' is not recognized|is not recognized as an internal or external command/i.test(out)) return { ok: false, error: `${host} looks like a Windows machine. Over SSH works for macOS and Linux; on Windows, paste the command instead.` };
  const last = out.trim().split(/\r?\n/).filter((l) => !l.startsWith("FRIDAY_")).slice(-3).join(" ").slice(0, 300);
  return { ok: false, error: `Setting up ${host} didn't finish${code !== null ? ` (exit ${code})` : ""}${last ? `: ${last}` : "."}` };
}
