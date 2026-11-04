/**
 * What a teammate with full access may do on its own, what it asks you first, and what it never does (Arun, 2026-11-03: "they
 * have full automatic bypass permissions and will only ask for go aheads on certain things, you will have to decide the
 * guardrails"). Drawn from Grok Bot's suggested boundaries, OpenClaw's auto-reviewer, Hermes Agent's hardline list, Claude Code's
 * auto mode and Codex's auto-review, and agreed with Arun the same day:
 *
 *   Runs on its own: reading anything, its own folder and the projects it was given (edits, builds, tests, installs, commits,
 *   pushing its own branches, draft pull requests), the web, talking to the other teammates.
 *   Asks first (a go-ahead): speaking for you outside, shipping, deleting what isn't its own, money, keys and access, and your
 *   computer beyond its folders. Sign-ins, two-factor and CAPTCHAs are yours to do: a hand-off, not a yes.
 *   Never: the floor no yes opens (wiping a disk or your home folder, piping the web into a shell, your SSH keys, Friday's own data).
 *
 * Pure: the runner calls it for every step a teammate's coding tool wants to take and acts on the answer (runner.ts, "ask").
 */

export type GoAhead = "outside" | "ship" | "delete" | "money" | "keys" | "computer" | "takeover";
export type Verdict = { kind: "run" } | { kind: "ask"; tag: GoAhead; why: string } | { kind: "never"; why: string };

/** What each go-ahead is, as its card says it (the reason the teammate is asking). */
export const GO_AHEAD_WORDS: Record<GoAhead, string> = {
  outside: "Speaks for you outside",
  ship: "Ships",
  delete: "Deletes what isn't its own",
  money: "Spends money",
  keys: "Changes keys or access",
  computer: "Reaches past its folders",
  takeover: "Needs you to sign in",
};

export interface GuardPlace {
  /** Its own folder and its own copies (worktrees): anything goes there. */
  own: string[];
  /** The projects it was given: it works in them, but deleting or resetting there is yours to say. */
  given: string[];
  /** The person's home folder, for ~ and for what lies outside both. */
  home: string;
  /** The branch its folder is on, when known: a plain `git push` from main is a push to main. */
  branch?: string;
  /** The folder its commands run in, for paths they name relatively; its own folder when not said. */
  cwd?: string;
}

const RUN: Verdict = { kind: "run" };
const ask = (tag: GoAhead, why: string): Verdict => ({ kind: "ask", tag, why });
const never = (why: string): Verdict => ({ kind: "never", why });

/** A branch that is shared, or that ships: main, master, trunk, release, production, deploy, live, stable. */
const SHARED_BRANCH = /^(?:(?:origin|upstream)\/)?(?:main|master|trunk|develop|release(?:[/-].*)?|prod(?:uction)?|deploy(?:[/-].*)?|live|stable|gh-pages)$/i;

const norm = (p: string, home: string, cwd?: string) => {
  let s = p.trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/");
  if (cwd && s && !s.startsWith("/") && !s.startsWith("~") && !s.startsWith("$HOME") && !s.startsWith("${HOME}") && !/^[A-Za-z]:\//.test(s)) s = `${cwd.replace(/\\/g, "/").replace(/\/+$/, "")}/${s.replace(/^\.\//, "")}`;
  if (s === "~" || s.startsWith("~/")) s = home.replace(/\/$/, "") + s.slice(1);
  s = s.replace(/\$HOME|\$\{HOME\}/g, home.replace(/\/$/, ""));
  return s.replace(/\/+$/, "") || "/";
};
const under = (p: string, root: string) => {
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return !!r && (p === r || p.startsWith(`${r}/`));
};

/** Places nothing may write, whatever is said: keys, the shell's own startup, Friday's own data. */
function sacred(p: string, home: string): string | null {
  const h = home.replace(/\/$/, "");
  if (under(p, `${h}/.ssh`) || under(p, `${h}/.gnupg`) || under(p, `${h}/.aws`) || under(p, `${h}/.kube`)) return "your keys and credentials";
  if (under(p, `${h}/.friday`) || under(p, `${h}/Library/Application Support/Friday`)) return "Friday's own data";
  if (under(p, `${h}/Library/Keychains`)) return "your keychain";
  return null;
}
/** Files that change how your computer or your accounts behave: a go-ahead to change. */
function keyFile(p: string, home: string): boolean {
  const h = home.replace(/\/$/, "");
  return (
    /(^|\/)\.(zshrc|zprofile|zshenv|bashrc|bash_profile|profile|bash_login|config\/fish\/config\.fish)$/.test(p) ||
    under(p, `${h}/Library/LaunchAgents`) ||
    under(p, "/Library/LaunchAgents") ||
    under(p, "/Library/LaunchDaemons") ||
    p === `${h}/.gitconfig` ||
    p === `${h}/.npmrc` ||
    p === `${h}/.netrc` ||
    /\/\.git\/(config|hooks\/)/.test(p)
  );
}

/** A file's verdict, for writing it (or deleting it, when `deleting`). */
export function guardPath(raw: string, at: GuardPlace, deleting = false): Verdict {
  const p = norm(raw, at.home, at.cwd ?? at.own[0]);
  const holy = sacred(p, at.home);
  if (holy) return never(`It won't touch ${holy}.`);
  if (keyFile(p, at.home)) return ask("keys", `${deleting ? "Deletes" : "Changes"} ${p.split("/").slice(-2).join("/")}, which changes how your computer or accounts behave.`);
  if (at.own.some((r) => under(p, norm(r, at.home)))) return RUN;
  // A project it was given is its to work in, deleting included: what it deletes there Git can bring back. Not the project itself,
  // nor its history.
  const project = at.given.map((r) => norm(r, at.home)).find((r) => under(p, r));
  if (project) return deleting && (p === project || under(p, `${project}/.git`)) ? ask("delete", `Deletes ${p === project ? "the whole project" : "the project's history"} (${short(p, at)}).`) : RUN;
  if (/^\/(tmp|private\/tmp|var\/folders)\//.test(p)) return RUN;
  return deleting ? ask("delete", `Deletes ${short(p, at)}, outside its folders.`) : ask("computer", `Writes ${short(p, at)}, outside its folders.`);
}

const short = (p: string, at: GuardPlace) => p.replace(at.home.replace(/\/$/, ""), "~");

/** Splits a command line into its simple commands, at ; && || | and newlines, outside quotes. Good enough to read intent. */
export function pieces(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (q) {
      cur += c;
      if (c === q && cmd[i - 1] !== "\\") q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if (c === ";" || c === "\n" || (c === "&" && cmd[i + 1] === "&") || (c === "|" && cmd[i + 1] === "|")) {
      out.push(cur);
      cur = "";
      if (c !== ";" && c !== "\n") i++;
      continue;
    }
    if (c === "|") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s && s !== "|");
}

/** The words of a simple command, quotes taken off, a leading `sudo`, `env X=…`, `command` or `time` left in for the rules to see. */
const words = (s: string) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ""));

/** A shell command's verdict: the strictest of its parts. */
export function guardCommand(cmd: string, at: GuardPlace): Verdict {
  const whole = cmd.replace(/\s+/g, " ");
  // The floor, read on the whole line: a pipe into a shell is two pieces.
  if (/\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(whole) || /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(python3?|node|perl|ruby)\b/.test(whole)) return never("It won't pipe something from the web straight into a shell. Download it, read it, then run it.");
  if (/base64\s+(-d|--decode)[^|]*\|\s*(ba|z)?sh\b/.test(whole) || /\beval\s+["']?\$\((curl|wget)/.test(whole)) return never("It won't run code it decoded or downloaded on the fly.");
  if (/:\(\)\s*\{\s*:\|:&\s*\};:/.test(whole)) return never("That's a fork bomb.");
  let worst: Verdict = RUN;
  const rank = (v: Verdict) => (v.kind === "never" ? 2 : v.kind === "ask" ? 1 : 0);
  for (const piece of pieces(cmd)) {
    const v = guardPiece(piece, at);
    if (rank(v) > rank(worst)) worst = v;
    if (worst.kind === "never") break;
  }
  return worst;
}

function guardPiece(piece: string, at: GuardPlace): Verdict {
  let w = words(piece);
  // What actually runs, after the wrappers that only change how.
  while (w.length && /^(env|command|time|nice|nohup|exec|xargs|then|do|else|\w+=\S*)$/.test(w[0]!)) w = w.slice(1);
  const sudo = w[0] === "sudo" || w[0] === "doas";
  if (sudo) w = w.slice(1).filter((x, i) => i > 0 || !x.startsWith("-"));
  const [cmd = "", sub = "", ...rest] = w;
  const args = [sub, ...rest];
  const has = (re: RegExp) => args.some((a) => re.test(a));
  const line = w.join(" ");

  // ── the floor ──
  if (/^mkfs/.test(cmd) || (cmd === "dd" && has(/^of=\/dev\//)) || (cmd === "diskutil" && /^(erase|zero|reformat|partition)/i.test(sub))) return never("It won't erase or overwrite a disk.");
  if (/^(shutdown|reboot|halt|poweroff)$/.test(cmd) || (cmd === "systemctl" && /^(poweroff|reboot|halt|kexec)$/.test(sub))) return never("It won't restart or shut down your computer.");
  if ((cmd === "pkill" || cmd === "killall") && has(/friday/i)) return never("It won't stop Friday itself.");
  if (cmd === "rm" && (has(/^-[a-zA-Z]*r/) || has(/^--recursive$/))) {
    for (const t of args.filter((a) => !a.startsWith("-"))) {
      const p = norm(t, at.home);
      const h = norm(at.home, at.home);
      if (p === "/" || p === "/*" || p === h || p === `${h}/*` || /^\/(etc|usr|bin|sbin|var|System|Library|Applications|Users|opt|boot|lib)(\/\*?)?$/.test(p)) return never("It won't delete your whole home folder or the system's.");
    }
  }
  if (sudo && cmd === "rm") return never("It won't delete with sudo.");

  // ── keys and access ──
  if (sudo) return ask("computer", `Runs ${clip(line)} as administrator.`);
  if (cmd === "crontab" && !has(/^-l$/)) return ask("keys", "Changes what your computer runs on a schedule (crontab).");
  if (cmd === "launchctl" && /^(load|bootstrap|enable|submit)$/.test(sub)) return ask("keys", "Adds something your computer runs by itself (launchctl).");
  if (cmd === "git" && sub === "config" && has(/^--(global|system)$/)) return ask("keys", "Changes your Git settings for every repository.");
  if (cmd === "gh" && (sub === "auth" || sub === "secret" || sub === "ssh-key" || sub === "gpg-key")) return ask("keys", `Changes your GitHub ${sub === "auth" ? "sign-in" : sub.replace("-", " ") + "s"}.`);
  if (cmd === "gh" && sub === "api" && /collaborators|permissions|\/keys|\/secrets|hooks/.test(line) && /-X\s*(PUT|POST|PATCH|DELETE)|--method\s+(PUT|POST|PATCH|DELETE)/i.test(line)) return ask("keys", "Changes who can reach one of your repositories.");
  if (cmd === "security" && /^(add|delete|set|import)-/.test(sub)) return ask("keys", "Changes your keychain.");
  if ((cmd === "npm" || cmd === "pnpm" || cmd === "yarn") && (sub === "token" || sub === "login" || sub === "adduser")) return ask("keys", `Changes your ${cmd} sign-in.`);
  if (cmd === "chmod" && has(/^(-R|--recursive)$/) && has(/^(0?777|a\+w|o\+w)$/)) return ask("keys", "Opens a folder up to everyone on this computer.");

  // ── your computer beyond its folders ──
  if (cmd === "defaults" && /^(write|delete)$/.test(sub)) return ask("computer", "Changes a setting of your Mac or one of its apps.");
  if (/^(networksetup|systemsetup|pmset|scutil|nvram|csrutil|spctl)$/.test(cmd)) return ask("computer", "Changes a system setting.");
  if (cmd === "osascript") return ask("computer", "Drives one of your apps (AppleScript).");
  if (cmd === "brew" && /^(uninstall|remove|rm|untap)$/.test(sub)) return ask("computer", "Removes something installed on your computer.");
  if ((cmd === "npm" || cmd === "pnpm" || cmd === "yarn") && /^(uninstall|remove|rm|un)$/.test(sub) && has(/^(-g|--global)$/)) return ask("computer", "Removes something installed on your computer.");

  // ── speaking for you outside ──
  if (cmd === "gh" && sub === "pr" && /^(comment|review|close|reopen|edit|ready)$/.test(rest[0] ?? "")) return ask("outside", `Posts on a pull request as you (gh pr ${rest[0]}).`);
  if (cmd === "gh" && sub === "issue" && /^(create|comment|close|reopen|edit|delete|transfer|lock)$/.test(rest[0] ?? "")) return ask("outside", `Posts on an issue as you (gh issue ${rest[0]}).`);
  if (cmd === "gh" && (sub === "release" && /^(create|edit|delete|upload)$/.test(rest[0] ?? ""))) return ask("ship", "Publishes a release.");
  if (cmd === "gh" && sub === "pr" && rest[0] === "merge") return ask("ship", "Merges a pull request.");
  if (cmd === "gh" && sub === "repo" && /^(create|delete|archive|rename|edit)$/.test(rest[0] ?? "")) return ask(rest[0] === "delete" ? "delete" : "outside", `Changes a repository on GitHub (gh repo ${rest[0]}).`);
  if (cmd === "gh" && sub === "api" && /-X\s*(POST|PATCH|PUT|DELETE)|--method\s+(POST|PATCH|PUT|DELETE)|\s-f\s|\s-F\s|--field|--raw-field|--input/i.test(` ${line} `)) return ask("outside", "Sends a change to GitHub as you (gh api).");
  if (/^(mail|mailx|sendmail|msmtp|mutt)$/.test(cmd)) return ask("outside", "Sends an email.");
  if ((cmd === "curl" || cmd === "wget" || cmd === "http") && /hooks\.slack\.com|api\.slack\.com\/api\/chat|discord(app)?\.com\/api\/webhooks|api\.sendgrid|api\.mailgun|api\.postmarkapp|api\.resend\.com|api\.twitter\.com|api\.x\.com|graph\.facebook|api\.linkedin|api\.telegram\.org/.test(line)) return ask("outside", "Sends a message to someone outside, as you.");

  // ── shipping ──
  if (cmd === "git" && sub === "push") {
    if (has(/^(-f|--force|--force-with-lease.*|--mirror)$/) || args.some((a) => /^\+/.test(a))) return ask("ship", "Force-pushes, rewriting history others may have.");
    if (has(/^(-d|--delete)$/) || args.some((a) => /^:/.test(a))) return ask("delete", "Deletes a branch on GitHub.");
    if (has(/^--tags$/) || args.some((a) => /^v?\d+\.\d+/.test(a))) return ask("ship", "Pushes release tags.");
    const named = args.filter((a) => !a.startsWith("-")).slice(1);
    const target = named.length ? named[named.length - 1]!.split(":").pop()! : (at.branch ?? "");
    if (SHARED_BRANCH.test(target.replace(/^refs\/heads\//, ""))) return ask("ship", `Pushes to ${target.replace(/^refs\/heads\//, "")}.`);
    return RUN;
  }
  if (/^(npm|pnpm|yarn|bun)$/.test(cmd) && sub === "publish") return ask("ship", "Publishes a package for everyone.");
  if ((cmd === "cargo" && sub === "publish") || (cmd === "twine" && sub === "upload") || (cmd === "gem" && sub === "push") || (cmd === "poetry" && sub === "publish") || (cmd === "pod" && sub === "trunk")) return ask("ship", "Publishes a package for everyone.");
  if (cmd === "docker" && sub === "push") return ask("ship", "Pushes an image to a registry.");
  if (/^(vercel|netlify)$/.test(cmd) && (has(/^--prod$/) || (cmd === "netlify" && sub === "deploy" && has(/^--prod$/)))) return ask("ship", "Deploys to production.");
  if ((cmd === "fly" || cmd === "flyctl") && sub === "deploy") return ask("ship", "Deploys an app.");
  if (cmd === "firebase" && sub === "deploy") return ask("ship", "Deploys an app.");
  if (cmd === "wrangler" && /^(deploy|publish)$/.test(sub)) return ask("ship", "Deploys a worker.");
  if (cmd === "serverless" || cmd === "sls") return /^(deploy|remove)$/.test(sub) ? ask("ship", "Deploys an app.") : RUN;
  if (cmd === "eas" && /^(submit|update)$/.test(sub)) return ask("ship", "Ships an app build.");
  if (cmd === "fastlane" || (cmd === "xcrun" && /^(altool|notarytool)$/.test(sub))) return ask("ship", "Uploads an app build.");
  if (cmd === "terraform" || cmd === "tofu" || cmd === "pulumi") return /^(apply|destroy|up|import)$/.test(sub) ? ask("ship", `Changes live infrastructure (${cmd} ${sub}).`) : RUN;
  if (cmd === "kubectl" && /^(apply|delete|create|replace|rollout|scale|patch|edit|drain)$/.test(sub)) return ask("ship", "Changes a live cluster.");
  if (cmd === "helm" && /^(install|upgrade|uninstall|rollback|delete)$/.test(sub)) return ask("ship", "Changes a live cluster.");
  if (/migrate/.test(line) && /\b(prod|production)\b|DATABASE_URL=\S*prod|--env[= ]prod/i.test(line)) return ask("ship", "Migrates a production database.");

  // ── deleting what isn't its own ──
  if (cmd === "rm") {
    for (const t of args.filter((a) => !a.startsWith("-"))) {
      const v = guardPath(t, at, true);
      if (v.kind !== "run") return v;
    }
    return RUN;
  }
  if (cmd === "git" && ((sub === "reset" && has(/^--hard$/)) || (sub === "clean" && has(/^-[a-zA-Z]*f/)) || ((sub === "checkout" || sub === "restore") && has(/^\.$/)) || (sub === "stash" && /^(drop|clear)$/.test(rest[0] ?? "")))) {
    return inOwn(at) ? RUN : ask("delete", `Throws away uncommitted work in your project (git ${sub}${rest[0] ? ` ${rest[0]}` : ""}).`);
  }
  if (/\b(drop\s+(table|database|schema)|truncate\s+table)\b/i.test(line) || (/\bdelete\s+from\b/i.test(line) && !/\bwhere\b/i.test(line))) return ask("delete", "Deletes data from a database.");
  if ((cmd === "aws" && /\b(delete|rm|rb|terminate|remove|purge)/.test(line)) || (cmd === "gcloud" && /\bdelete\b/.test(line)) || (cmd === "az" && /\bdelete\b/.test(line))) return ask("delete", "Deletes something in the cloud.");

  // ── money ──
  if (cmd === "stripe" && /\b(charges|payment_intents|payouts|transfers|refunds|subscriptions)\b/.test(line) && /\b(create|confirm|capture|cancel|update)\b/.test(line)) return ask("money", "Moves money (Stripe).");

  // ── writing past its folders, by redirection ──
  for (const m of piece.matchAll(/(?:^|[^<>&\d])>>?\s*("[^"]+"|'[^']+'|[^\s;|&]+)/g)) {
    const t = m[1]!;
    if (/^\/dev\/(null|stdout|stderr|tty)$/.test(t) || t.startsWith("&")) continue;
    if (/^\/dev\//.test(t)) return never("It won't write straight to a device.");
    if (t.startsWith("/") || t.startsWith("~") || t.startsWith("$HOME")) {
      const v = guardPath(t, at);
      if (v.kind !== "run") return v;
    }
  }
  if ((cmd === "tee" || cmd === "cp" || cmd === "mv" || cmd === "ln" || cmd === "install") && args.length) {
    const t = args.filter((a) => !a.startsWith("-")).at(-1);
    if (t && (t.startsWith("/") || t.startsWith("~") || t.startsWith("$HOME"))) {
      const v = guardPath(t, at);
      if (v.kind !== "run") return v;
    }
  }
  return RUN;
}

/** Whether it is working in a folder of its own (git's reset and clean act on the folder it is in). */
const inOwn = (at: GuardPlace) => at.given.length === 0 && at.own.length > 0;

const clip = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s);

/** A tool a coding tool calls by name: an MCP server's, or its own. */
export function guardTool(name: string, input: Record<string, unknown>, at: GuardPlace): Verdict {
  const n = name.toLowerCase();
  // Friday's own (talking to the other teammates, the board, its memory) and a browser it only reads with.
  if (n.startsWith("mcp__friday")) return RUN;
  if (n.startsWith("mcp__")) {
    const verb = n.split("__").slice(2).join("_");
    if (/(pay|purchase|checkout|buy|charge|order_create|place_order|transfer_funds|refund)/.test(verb)) return ask("money", `Spends money (${name}).`);
    if (/(password|credential|2fa|mfa|totp|secret|token|permission|share|invite|grant|add_member|collaborator)/.test(verb)) return ask("keys", `Changes access (${name}).`);
    if (/(send|post|reply|comment|message|email|mail|tweet|publish|dm|notify|create_issue|create_pull_request_review|submit_review|react)/.test(verb)) return ask("outside", `Sends something as you (${name}).`);
    if (/(merge|deploy|release)/.test(verb)) return ask("ship", `Ships (${name}).`);
    if (/(delete|remove|archive|destroy|drop|purge|trash)/.test(verb)) return ask("delete", `Deletes something (${name}).`);
    return RUN;
  }
  const path = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : typeof input.notebook_path === "string" ? input.notebook_path : "";
  if (/^(write|edit|multiedit|notebookedit|apply_patch|create|str_replace_based_edit_tool)$/i.test(name) && path) return guardPath(path, at);
  if (/^(bash|shell|powershell|run_command|exec_command|local_shell)$/i.test(name)) {
    const c = typeof input.command === "string" ? input.command : Array.isArray(input.command) ? (input.command as unknown[]).map(String).join(" ") : "";
    return c ? guardCommand(c, at) : RUN;
  }
  return RUN;
}
