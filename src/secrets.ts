/**
 * The secret shield: keys, tokens and passwords never reach the room.
 *
 * A shared session shows everything its agents do: a `cat .env`, a command with a token in it, a diff of a config file, a
 * key somebody pasted into a message. Everyone in the session sees it, and so does anyone with its viewer or replay link,
 * and it is kept in the log. So every event is passed through here before it is stored or sent (SessionStore.append,
 * Bus.publish), and what looks like a secret is replaced. A key of a known kind keeps the start that says which kind it was
 * ("sk-ant-…[secret hidden]"); anything else becomes "[secret hidden]". The coding tool keeps the real values that are
 * already on its own computer (files, environment), but a key typed into a message is hidden from the agent too.
 *
 * ponytail: a pattern list, not entropy detection. It catches the formats people actually leak (provider keys, tokens,
 * private keys, passwords in connection strings and in KEY=value lines); a secret of no known shape in free text gets through.
 */

export const HIDDEN = "[secret hidden]";

/** What an agent is told when its prompt holds the placeholder, or it writes it into a config as if it were the value. */
export const SHIELD_NOTE = `[Friday] Friday's secret shield hid a key or password above and put "${HIDDEN}" in its place. That is not the value. Never write the placeholder into a file, config or command. If the task needs the value, use it by its environment-variable name (from the environment or the project's .env on this computer) and never print, echo or cat it. If it isn't set, stop and ask the person to add it on this computer and tell you the variable name.`;

/** The prompt with the note once at its end if any of it holds the placeholder (a held prompt's earlier note is dropped first). */
export function withShieldNote(prompt: string): string {
  const text = prompt.replaceAll(`\n\n${SHIELD_NOTE}`, "");
  return text.includes(HIDDEN) ? `${text}\n\n${SHIELD_NOTE}` : text;
}

/** Keys with a recognisable shape: the part kept (it says which kind of key it was), then the rest, which is hidden. */
const KEYED: RegExp[] = [
  /\b(sk-ant-(?:api|admin)\d{2}-)[A-Za-z0-9_-]{20,}/g, // Anthropic
  /\b(sk-or-v1-)[a-f0-9]{32,}/g, // OpenRouter, before the general sk- below takes it
  /\b(sk-(?:proj-|svcacct-|admin-)?)[A-Za-z0-9_-]{32,}/g, // OpenAI and the like
  /\b(gh[pousr]_)[A-Za-z0-9]{30,}/g, // GitHub tokens
  /\b(github_pat_)[A-Za-z0-9_]{40,}/g,
  /\b(glpat-)[A-Za-z0-9_-]{20,}/g, // GitLab
  /\b(xox[abposr]-)[A-Za-z0-9-]{10,}/g, // Slack
  /\b((?:sk|rk)_(?:live|test)_)[A-Za-z0-9]{16,}/g, // Stripe
  /\b(whsec_)[A-Za-z0-9]{16,}/g,
  /\b(AIza)[0-9A-Za-z_-]{35}/g, // Google API keys
  /\b((?:AKIA|ASIA))[0-9A-Z]{16}\b/g, // AWS access key ids
  /\b(phx_)[A-Za-z0-9]{30,}/g, // PostHog personal keys (a project key, phc_, is public)
  /\b(npm_)[A-Za-z0-9]{36}\b/g,
  /\b(hf_)[A-Za-z0-9]{30,}/g, // Hugging Face
  /\b(gsk_)[A-Za-z0-9]{40,}/g, // Groq
  /\b(xai-)[A-Za-z0-9]{40,}/g,
  /\b(re_)[A-Za-z0-9_]{24,}/g, // Resend
  /\b(SG\.)[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /\b(eyJ)[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs, Supabase keys among them
];

/** A private key, whole. */
const PRIVATE_KEY = /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g;
/** The password in a connection string: postgres://user:password@host. */
const URL_PASSWORD = /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|https?|ftp):\/\/[^:\s/@]+:)([^@\s/]{3,})@/g;
/**
 * A value assigned to a name that says it is a secret: `API_KEY=…`, `"client_secret": "…"`, `password: …`. The value has to
 * look like one: not a reference to where it comes from (`process.env.X`, `${X}`, `os.environ[...]`), which is what a diff of
 * code that reads a secret is full of, and which hides nothing.
 */
const ASSIGNED = /((?:^|[\s"'{,(])["']?[A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|AUTH[_-]?KEY|CREDENTIALS?)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)([^\s"'`,;)}\]]{8,})/gi;
const REFERENCE = /^(?:process\.env|os\.environ|import\.meta|env\.|config\.|settings\.|secrets\.|\$\{|\$[A-Z_]|<|\(|\[|[A-Za-z_$][\w$]*\(|[A-Za-z_$][\w$]*(?:\.[\w$]+)+$)/;

/**
 * Whatever any pattern above could start with, in one pass: a text without any of it holds nothing they would hide, and is
 * left without running the two dozen of them. Every log read whole goes through here, a long session's 22 MB of it, and the
 * patterns one after another were most of a three-second stall of the whole server (Arun, 2026-10-23). It must stay a
 * superset of the patterns: one added above is added here too (secrets.test.ts checks every pattern's examples).
 */
const MAYBE =
  /sk-|rk_|gh[pousr]_|github_pat_|glpat-|xox[abposr]-|_(?:live|test)_|whsec_|AIza|AKIA|ASIA|phx_|npm_|hf_|gsk_|xai-|re_|SG\.|eyJ|PRIVATE KEY|:\/\/[^\s/@]*:[^\s/@]*@|secret|token|passw|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?key|credential/i;

/** The text with every secret it holds hidden, and how many there were. */
export function hideSecrets(text: string): { text: string; hidden: number } {
  if (text.length < 8 || !MAYBE.test(text)) return { text, hidden: 0 };
  let hidden = 0;
  // Already hidden stays as it is, so a second pass (the composer checking what "Send without it" left) finds nothing.
  let out = text.replace(PRIVATE_KEY, (m) => (m.includes(HIDDEN) ? m : (hidden++, `-----BEGIN PRIVATE KEY----- ${HIDDEN} -----END PRIVATE KEY-----`)));
  for (const re of KEYED) out = out.replace(re, (_m, keep: string) => (hidden++, `${keep}…${HIDDEN}`));
  out = out.replace(URL_PASSWORD, (_m, before: string) => (hidden++, `${before}${HIDDEN}@`));
  out = out.replace(ASSIGNED, (m, name: string, value: string) => {
    // A plain word (`token: tokenFromHeader`, `password: string`) is a name, not a secret.
    if (value.includes(HIDDEN) || REFERENCE.test(value) || /^[A-Za-z_$]+$/.test(value)) return m;
    hidden++;
    return `${name}${HIDDEN}`;
  });
  return { text: out, hidden };
}

/** Every string in a value (an event body, a bus message) with its secrets hidden. The value itself is not changed. */
export function hideSecretsIn<T>(value: T): T {
  if (typeof value === "string") return hideSecrets(value).text as T;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => {
      const h = hideSecretsIn(v);
      if (h !== v) changed = true;
      return h;
    });
    return (changed ? next : value) as T;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const h = hideSecretsIn(v);
      if (h !== v) changed = true;
      next[k] = h;
    }
    return (changed ? next : value) as T;
  }
  return value;
}
