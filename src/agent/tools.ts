import { MAIN_LANE, type EventBody, type RepoCall, type SkillBrief } from "../types.js";
import { MESH_TOOLS } from "../agent-mesh.js";
import { testFailedInChain } from "../receipt.js";
import { driverOf, type SessionState } from "../session/projection.js";
import type { LLM, ToolSchema } from "./llm.js";
import { fetchUrl as getUrl } from "./fetch-url.js";

export interface ToolContext {
  sid: string;
  /** The agent's own lane; absent means the main one. */
  lane?: string;
  signal: AbortSignal;
  llm: LLM;
  state(): Promise<SessionState>;
  /** Appends an event as the agent. Unconditional: tool side effects are facts. */
  append(body: EventBody): Promise<unknown>;
  /**
   * Read the folder a connected coding agent has open, on this session's
   * behalf. Absent when nothing is connected, which is what decides whether
   * the repo tools are offered at all.
   */
  /**
   * Pass the work to another agent in the session. Resolves with who took it,
   * or a sentence saying why it couldn't be handed over.
   */
  /** Keep something across sessions. Refused when the person has memory turned off. */
  saveMemory?(text: string, scope: "personal" | "workspace"): Promise<{ ok: true } | { ok: false; reason: string }>;
  handOff?(req: { to: string; reason: string; carried: string[]; task: string }): Promise<{ ok: true; toName: string; note?: string } | { ok: false; error: string }>;
  /** The other agents in this session (agent-mesh.ts): list them, message one, ask one and wait, answer one. */
  mesh?: { call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ output: string; isError?: boolean; endTurn?: boolean }> };
  /** The other sessions its person is in (peers.ts): list them, read where one is, tell one something. */
  peers?: {
    list(): Promise<string>;
    read(to: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
    send(req: { to: string; agent?: string; text: string }): Promise<{ ok: true; sid: string; title: string; lane: string; name: string; held: boolean; text: string } | { ok: false; error: string }>;
  };
  /** Plan the work for several coding agents at once (hubs.ts); the session's owner approves the plan before anything runs. */
  startHub?(goal: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  /** Put one of this agent's specialists to work in a lane of its own. */
  deployAgent?(req: { agent: string; reason: string; carried: string[]; task: string }): Promise<{ ok: true; name: string; reused: boolean } | { ok: false; error: string }>;
  readRepo?(req: RepoCall): Promise<{ output: string; where?: { host: string; cwd: string; branch?: string } }>;
  /**
   * Whether a shell command may run now. On a machine in Manual mode it is a question for a person: the first time it
   * asks, and the answer arrives as the next instruction; after a yes it lets the command through. `approved` says a
   * person (or the driver's list, in advance) really did say yes, which is the only thing a Manual machine runs on: a
   * plain go means "this machine doesn't ask", and is not passed on as a yes.
   */
  commandGate?(command: string): Promise<{ go: true; approved?: true } | { go: false; output: string; endTurn?: boolean }>;
  /** The brief of a skill that is fetched when used rather than carried, as the person who owns it. */
  skillBrief?(id: string, owner: string, collection?: string): Promise<string | null>;
  /** Bring skills in from a GitHub repository, for the person driving. */
  importSkills?(req: { url: string; only?: string[] }): Promise<string>;
}

export interface ToolOutcome {
  output: string;
  isError?: boolean;
  /** End the agent's turn after this batch (used by ask_human). */
  endTurn?: boolean;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * Cancellable tools get the run's abort signal and are cut off by pause,
   * cancel or an interrupting instruction. Non-cancellable tools always run to
   * completion and their real result is recorded, because once a side effect
   * starts, the log has to say what actually happened.
   */
  cancellable: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext, callId: string): Promise<ToolOutcome>;
}

export function toolSchemas(tools: AgentTool[]): ToolSchema[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
/**
 * An agent's skills, fetched one at a time.
 *
 * The prompt lists what each skill is *for*; the brief itself only arrives when
 * the agent decides the job matches. That keeps every prompt small however many
 * skills an agent carries, and â€” because it is a tool call â€” the room sees
 * which brief the agent is working from, in the log, at the moment it picked it.
 */
export function useSkillTool(skills: SkillBrief[]): AgentTool {
  const names = skills.map((s) => s.name);
  // A long menu is in the prompt already, grouped; repeating it as an enum on
  // the tool would put hundreds of names in every request a second time.
  const big = names.length > 60;
  return {
    name: "use_skill",
    description:
      // The enum below already carries every name, and the prompt carries them
      // with their triggers: a third copy of a forty-item list is tokens spent
      // saying nothing new.
      `Fetch the brief for one of your skills and follow it. Use it when the job in front of you matches what that skill is for.${names.length > 12 ? " The names are in your skills menu, grouped by the kind of job." : ` Available: ${names.join(", ")}.`}`,
    parameters: {
      type: "object",
      properties: { skill: big ? { type: "string", description: "The skill's name, exactly as in your skills menu." } : { type: "string", enum: names, description: "The skill's name, exactly as listed." } },
      required: ["skill"],
      additionalProperties: false,
    },
    cancellable: true,
    async run(args, ctx) {
      const want = str(args.skill).trim().toLowerCase();
      const s = skills.find((x) => x.name.toLowerCase() === want) ?? skills.find((x) => x.name.toLowerCase().includes(want));
      if (!s) return { output: `No skill called "${str(args.skill)}".${big ? " Check the name against your skills menu." : ` You have: ${names.join(", ")}.`}`, isError: true };
      let text = s.instructions;
      if (s.lazy) {
        const got = await ctx.skillBrief?.(s.id, s.lazy.owner, s.lazy.collection).catch(() => null);
        if (!got) return { output: `The skill "${s.name}" couldn't be loaded. It may have been removed.`, isError: true };
        text = got;
      }
      return { output: `Skill: ${s.name}
Use when: ${s.description}

${text}

Follow this brief for this piece of work. If it conflicts with what the driver asked for, the driver wins — say which part you set aside.` };
    },
  };
}

/**
 * Skills from a GitHub repository, added to the driver's own.
 *
 * Naming particular skills adds just those; naming none adds the whole
 * repository as a collection, which is what "add the skills from this repo"
 * means almost every time. The result goes back to the agent as a sentence so
 * it can say what happened, and the skills are there for the next message.
 */
export const addSkillsFromGithub: AgentTool = {
  name: "add_skills_from_github",
  description:
    "Add skills from a public GitHub repository to the user's Skills page, so they (and you) can use them. A skill is a folder with a SKILL.md in it. " +
    "Give the repository address. Leave 'only' out to add the whole repository as one collection; give names to add just those skills. Use this when the user asks to add, import or install skills from a repo.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The repository address, e.g. https://github.com/owner/repo, or a folder inside it." },
      only: { type: "array", items: { type: "string" }, description: "Optional: skill names (or folder names) to add instead of the whole repository." },
    },
    required: ["url"],
    additionalProperties: false,
  },
  cancellable: false,
  async run(args, ctx) {
    const url = str(args.url).trim();
    if (!url) return { output: "Give the repository address.", isError: true };
    if (!ctx.importSkills) return { output: "Importing skills isn't available in this session.", isError: true };
    const only = Array.isArray(args.only) ? args.only.map(str).filter(Boolean).slice(0, 25) : undefined;
    try {
      return { output: await ctx.importSkills({ url, ...(only?.length ? { only } : {}) }) };
    } catch (e) {
      return { output: e instanceof Error ? e.message : "Couldn't import those skills.", isError: true };
    }
  },
};

/**
 * Memory is what survives the context window.
 *
 * A long session's oldest turns are trimmed out of the model's context, which
 * is fine for the back-and-forth and not fine for the decision that was made in
 * it. Anything the agent writes here is replayed in every later step, and in
 * the digest a returning teammate reads, so a session keeps what it settled.
 */
export const remember: AgentTool = {
  name: "remember",
  description:
    "Save something this session must not lose: a decision, a constraint, a correction, a number the team agreed on, or a fact discovered that changes the work. " +
    "It stays in your context for the rest of the session even after earlier turns are trimmed. Reuse a key to update what you saved under it.",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "Short slug naming the thing, e.g. 'pricing-decision'. Reuse it to correct what you saved." },
      note: { type: "string", description: "One or two sentences. Write what was decided and why, not a summary of the conversation." },
      scope: { type: "string", enum: ["session", "personal", "workspace"], description: "session (default): only this session. personal: true about this person, kept for all their future sessions. workspace: true about the team or project, kept for everyone here." },
    },
    required: ["key", "note"],
    additionalProperties: false,
  },
  cancellable: false,
  async run(args, ctx) {
    const key = str(args.key).trim().toLowerCase().replace(/\s+/g, "-").slice(0, 48);
    const text = str(args.note).trim().slice(0, 600);
    if (!key || !text) return { output: "Both key and note are required.", isError: true };
    await ctx.append({ type: "memory.saved", key, text });
    const scope = args.scope === "personal" || args.scope === "workspace" ? args.scope : null;
    if (scope && ctx.saveMemory) {
      const r = await ctx.saveMemory(text, scope);
      if (!r.ok) return { output: `Noted for this session under "${key}". Not kept for later: ${r.reason}` };
      return { output: `Noted under "${key}", and kept for ${scope === "personal" ? "this person's" : "everyone's"} future sessions.` };
    }
    return { output: `Noted under "${key}".` };
  },
};

/**
 * The plan, kept where the room can see it.
 *
 * A long run is otherwise a wall of tool calls that only says what has already
 * happened. One list of steps says what is left, which is the thing people
 * watching actually want to know — and it makes the agent commit to an order
 * before it starts, which is worth something on its own.
 *
 * Deliberately cheap: rewriting the list is one call and no model output, so
 * the discipline about pointless calls doesn't need an exception for it.
 */
export const updatePlan: AgentTool = {
  name: "update_plan",
  description:
    "Show the team your plan for a multi-step task, and keep it current. Call it once with the steps before you start, then again each time one finishes so the room can see what is left. " +
    "Three to seven steps, each a few words, in the order you'll do them. Exactly one step may be in_progress at a time. Skip it for anything you'll finish in a single step.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description: "The whole plan every time, not just what changed.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "What this step does, in a few words." },
            status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"], description: "Where this step is now." },
          },
          required: ["title", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["steps"],
    additionalProperties: false,
  },
  cancellable: false,
  async run(args) {
    const raw = Array.isArray(args.steps) ? args.steps : [];
    const steps = raw.slice(0, 12).flatMap((x) => {
      const o = (x ?? {}) as { title?: unknown; status?: unknown };
      const title = str(o.title).trim().slice(0, 120);
      const status = String(o.status ?? "pending");
      return title ? [{ title, status: ["pending", "in_progress", "completed", "cancelled"].includes(status) ? status : "pending" }] : [];
    });
    if (!steps.length) return { output: "Give the plan at least one step.", isError: true };
    const left = steps.filter((s) => s.status === "pending" || s.status === "in_progress").length;
    // The result is for the model, which can already see the list it just
    // sent: it needs the count, not the list read back to it.
    return { output: left ? `Plan updated. ${left} of ${steps.length} steps still to do.` : `Plan updated. All ${steps.length} steps done.` };
  },
};

export const webSearch: AgentTool = {
  name: "web_search",
  description: "Search the web. Returns a summary of findings with source URLs.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  cancellable: true,
  async run(args, ctx) {
    const q = str(args.query).trim();
    if (!q) return { output: "Query is empty.", isError: true };
    return { output: await ctx.llm.search(q, ctx.signal) };
  },
};

export const fetchUrl: AgentTool = {
  name: "fetch_url",
  description:
    "Open a web page and read it as text. Use it for a link someone gave you, or for a result web_search turned up and you need the detail of. Follows redirects; returns the page's words, not its markup.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "A full URL, starting with https://." } },
    required: ["url"],
    additionalProperties: false,
  },
  cancellable: true,
  async run(args, ctx) {
    const u = str(args.url).trim();
    if (!u) return { output: "Which URL?", isError: true };
    return { output: await getUrl(u, ctx.signal) };
  },
};

export const askHuman: AgentTool = {
  name: "ask_human",
  description:
    "Ask the person driving the session for a decision you can't make yourself. Your turn ends; their answer arrives as the next instruction. " +
    "Keep the question to one short line — what you need to know, not why you need it. Give the answers as options whenever the choice is between known alternatives, and mark the one you'd pick.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "One short line, under about 15 words. No preamble, no explanation of what you already tried." },
      options: {
        type: "array",
        description: "The answers to choose from, when the choice is between known alternatives. Two to four, each a few words, each a complete answer on its own — never a sentence fragment.",
        items: { type: "string" },
      },
      recommended: { type: "string", description: "The option you would pick, copied exactly. Only when you actually have a view." },
      detail: { type: "string", description: "One extra line, only if the question genuinely needs context to answer." },
    },
    required: ["question"],
    additionalProperties: false,
  },
  cancellable: false,
  async run(args, ctx, callId) {
    const s = await ctx.state();
    // Route to whoever can actually act on the answer: this agent's driver, or the owner if nobody is driving it. The main
    // agent's driver was asked a second agent's questions, and could not answer them there.
    const to = driverOf(s, ctx.lane ?? MAIN_LANE) ?? { id: s.ownerId, name: s.members[s.ownerId]?.name ?? "the owner" };
    // Short and separate: a question that arrives as one paragraph has to be
    // cut back into choices by a parser that guesses, and guesses produce the
    // sentence fragments ending in ", or" that used to show up on the card.
    const options = (Array.isArray(args.options) ? args.options : [])
      .map((o) => str(o).trim().replace(/[,;]?\s*(or)?\s*$/i, "").slice(0, 120))
      .filter(Boolean)
      .slice(0, 4);
    const recommended = str(args.recommended).trim();
    const detail = str(args.detail).trim().slice(0, 240);
    await ctx.append({
      type: "agent.question",
      callId,
      question: str(args.question).trim().slice(0, 300),
      ...(detail ? { detail } : {}),
      ...(options.length > 1 ? { options } : {}),
      ...(options.length > 1 && options.includes(recommended) ? { recommended } : {}),
      to: to.id,
      toName: to.name,
    });
    return { output: `Question sent to ${to.name}. Their answer will arrive as the next instruction.`, endTurn: true };
  },
};


/**
 * Reading the code a session is working on.
 *
 * Friday's own agent runs on a server that has never seen anybody's files, so
 * asked to write about a repo it could only ask for the repo. These three
 * route through the coding agent already connected to the session, which does
 * have the folder open. Read-only: writing is the CLI's job, under whatever
 * mode its host chose.
 *
 * They are only offered when a session actually has one connected, so the
 * agent is never holding a tool that answers "nobody is connected".
 */
const repoUnavailable = "No coding agent is connected to this session, so there's no code to read.";

export const listFiles: AgentTool = {
  name: "list_files",
  description: "List the files in the repository this session's coding agent is working in. Start here before reading anything.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "A folder within the repository. Omit for the whole thing." } },
    additionalProperties: false,
  },
  cancellable: true,
  async run(args, ctx) {
    if (!ctx.readRepo) return { output: repoUnavailable, isError: true };
    const r = await ctx.readRepo({ op: "tree", path: str(args.path) });
    return { output: r.where ? `${r.where.cwd}${r.where.branch ? ` on ${r.where.branch}` : ""}, via ${r.where.host}'s machine\n\n${r.output}` : r.output };
  },
};

export const readRepoFile: AgentTool = {
  name: "read_file",
  description: "Read one file from the repository this session's coding agent is working in. Lines are numbered; large files come back in pieces.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path within the repository, e.g. 'src/app.ts'." },
      offset: { type: "number", description: "Line to start at, for reading the rest of a long file." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  cancellable: true,
  async run(args, ctx) {
    if (!ctx.readRepo) return { output: repoUnavailable, isError: true };
    const path = str(args.path);
    if (!path) return { output: "Which file?", isError: true };
    return { output: (await ctx.readRepo({ op: "read", path, offset: Number(args.offset) || 0 })).output };
  },
};

export const searchRepo: AgentTool = {
  name: "search_code",
  description: "Find a string in the repository this session's coding agent is working in. Case-insensitive, plain text rather than a regex.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      path: { type: "string", description: "Limit the search to this folder." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  cancellable: true,
  async run(args, ctx) {
    if (!ctx.readRepo) return { output: repoUnavailable, isError: true };
    return { output: (await ctx.readRepo({ op: "search", query: str(args.query), path: str(args.path) })).output };
  },
};

/**
 * Changing the code, and running things against it.
 *
 * The same channel as reading, and the same gate: the machine on the other end
 * refuses anything past the mode its host picked in the session header, so
 * "plan only" really does mean the agent can look and nothing else. The refusal
 * comes back as the tool's answer rather than an error, because the agent's
 * next move -- say so, and ask the host -- is the same either way.
 */
export const writeRepoFile: AgentTool = {
  name: "write_file",
  description:
    "Create a file, or replace one entirely, in the repository this session's coding agent is working in. Read it first unless you are creating it. For a small change to a big file, prefer edit_file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path within the repository, e.g. 'src/app.ts'." },
      content: { type: "string", description: "The complete new contents of the file." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  cancellable: false,
  async run(args, ctx) {
    if (!ctx.readRepo) return { output: repoUnavailable, isError: true };
    const path = str(args.path);
    if (!path) return { output: "Which file?", isError: true };
    return { output: (await ctx.readRepo({ op: "write", path, content: str(args.content) })).output };
  },
};

export const editRepoFile: AgentTool = {
  name: "edit_file",
  description:
    "Replace one exact stretch of text in a file. The text must appear exactly once, so include enough surrounding lines to be unambiguous. Read the file first and copy the lines exactly, whitespace included.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path within the repository." },
      find: { type: "string", description: "The exact existing text, copied from the file." },
      content: { type: "string", description: "What to put in its place. Empty string deletes it." },
    },
    required: ["path", "find", "content"],
    additionalProperties: false,
  },
  cancellable: false,
  async run(args, ctx) {
    if (!ctx.readRepo) return { output: repoUnavailable, isError: true };
    const path = str(args.path);
    if (!path) return { output: "Which file?", isError: true };
    return { output: (await ctx.readRepo({ op: "edit", path, find: str(args.find), content: str(args.content) })).output };
  },
};

export const runCommand: AgentTool = {
  name: "run_command",
  description:
    "Run a shell command in the repository, on the machine hosting this session's coding agent. Use it to build, test, lint, inspect git, or install what the work needs. Returns the exit status and the output; a long output keeps its start and its end. Which shell it is (sh, Git Bash or PowerShell) is said where the folder is described. Each call is a fresh shell in the repository root, so cd and variables don't carry over to the next one. Its input is closed and git won't open an editor or ask for a password, so pass -m, -y or --no-edit rather than waiting on a prompt. It stops after 2 minutes unless you pass timeout_seconds (up to 1800, thirty minutes). At its time limit it is stopped along with everything it started. Don't leave anything running with &; use run_background for that. Pause and cancel wait for it to finish, so only raise the limit for a build, install or test run you expect to be long. Anything that never exits (a watcher, a server) belongs in run_background.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line, e.g. 'npm test' or 'git diff --stat'. Runs in the repository root." },
      timeout_seconds: { type: "number", description: "How long it may run before it is stopped, 10 to 1800. Default 120." },
    },
    required: ["command"],
    additionalProperties: false,
  },
  cancellable: false,
  async run(args, ctx) {
    if (!ctx.readRepo) return { output: repoUnavailable, isError: true };
    const command = str(args.command);
    if (!command.trim()) return { output: "Give a command to run.", isError: true };
    const gate = await ctx.commandGate?.(command);
    // Waiting on a person, or told no: either way nothing ran, which is not a success.
    if (gate && !gate.go) return { output: gate.output, isError: true, ...(gate.endTurn ? { endTurn: true } : {}) };
    const timeoutSec = Number(args.timeout_seconds) || 0;
    const { output } = await ctx.readRepo({ op: "shell", command, ...(gate?.go && gate.approved ? { approved: true } : {}), ...(timeoutSec ? { timeoutSec } : {}) });
    // A command that exits non-zero failed, and saying so is what lets the
    // Terminal tab count it and the run offer to fix it. The output is the
    // same either way; only the flag is new. Every command that ran answers
    // with a transcript starting "$ "; anything else (a refusal, a machine
    // that didn't answer) never ran, and that is not a success either.
    return { output, isError: !/^\$ /.test(output) || /^\((exited (?!0\))[^)]+|timed out[^)]*)\)$/m.test(output) || testFailedInChain(command, output) };
  },
};

export const showPreview: AgentTool = {
  name: "show_preview",
  description:
    "Show the person something running, in the Preview panel beside the chat, which opens for them. By default it runs the project's own dev server (installing its dependencies first if they are missing) and shows the site: use it for a website or app (Vite, React, Next, plain HTML) once there is something to look at, and again after a change that needs a restart. Don't start that server yourself with run_command: it never exits. With url it opens that address instead, such as a server you started with run_background. With ios it builds the folder's iOS app with Xcode, runs it in an iOS simulator and shows its screen (on a Mac with Xcode); call it again with ios to see how the build is going. When someone asks to see, preview or load up the app, this is the tool.",
  parameters: {
    type: "object",
    properties: {
      script: { type: "string", description: "Which package.json script to run: dev, start, preview or serve. Omit to use the project's own first choice." },
      url: { type: "string", description: "An address to show instead of starting anything, such as http://localhost:4000 from a server you started with run_background." },
      ios: { type: "boolean", description: "Build and run the folder's iOS app in a simulator (a Mac with Xcode), and show its screen." },
    },
    additionalProperties: false,
  },
  cancellable: false,
  async run(args, ctx) {
    if (!ctx.readRepo) return { output: repoUnavailable, isError: true };
    // An address already serving: nothing to start, only to show (the session's page opens it, Activity.tsx).
    const url = str(args.url);
    if (url) {
      if (!/^https?:\/\/[^\s]+$/i.test(url)) return { output: "That isn't a web address. Pass one like http://localhost:4000.", isError: true };
      return { output: `Showing ${url} in the Preview panel for the person. Tell them what to look at.` };
    }
    if (args.ios === true) return iosPreview(ctx);
    const query = str(args.script) ? { query: str(args.script) } : {};
    let { output } = await ctx.readRepo({ op: "preview", ...query });
    let r: { preview?: { url: string; command: string; ready: boolean; log: string[] }; error?: string; needsApproval?: string } | null = null;
    try {
      r = JSON.parse(output);
      // A Manual machine says what it would run, and runs it once that exact command has been approved like any other.
      if (r?.needsApproval) {
        const command = r.needsApproval;
        const gate = await ctx.commandGate?.(command);
        if (gate && !gate.go) return { output: gate.output, isError: true, ...(gate.endTurn ? { endTurn: true } : {}) };
        ({ output } = await ctx.readRepo({ op: "preview", ...query, command, ...(gate?.go && gate.approved ? { approved: true } : {}) }));
        r = JSON.parse(output);
        if (r?.needsApproval) return { output: `What would run has changed since it was approved: it is now "${r.needsApproval}". Call show_preview again to ask about that.`, isError: true };
      }
    } catch {
      return { output, isError: true };
    }
    if (r?.error || !r?.preview) return { output: r?.error ?? "Couldn't start the preview.", isError: true };
    const p = r.preview;
    return {
      output: p.ready
        ? `Running (${p.command}) at ${p.url}, and open in the Preview panel for the person. Tell them what to look at.`
        : `Still starting (${p.command}) — installing or booting can take a minute. It is open in the Preview panel and will appear when it is ready; calling show_preview again shows where it has got to. Don't start it again with run_command.\n${p.log.join("\n")}`,
    };
  },
};

/** show_preview with ios: the folder's iOS app built and run in a simulator on the Mac it is on, asked about first on a Manual machine. */
async function iosPreview(ctx: Parameters<AgentTool["run"]>[1]): Promise<{ output: string; isError?: boolean; endTurn?: boolean }> {
  type IosAnswer = { ios?: { stage: string; scheme: string; error?: string; log: string[] } | null; error?: string; needsApproval?: string };
  let { output } = await ctx.readRepo!({ op: "ios" });
  let r: IosAnswer;
  try {
    r = JSON.parse(output) as IosAnswer;
    if (r.needsApproval) {
      const command = r.needsApproval;
      const gate = await ctx.commandGate?.(command);
      if (gate && !gate.go) return { output: gate.output, isError: true, ...(gate.endTurn ? { endTurn: true } : {}) };
      ({ output } = await ctx.readRepo!({ op: "ios", command, ...(gate?.go && gate.approved ? { approved: true } : {}) }));
      r = JSON.parse(output) as IosAnswer;
      if (r.needsApproval) return { output: `What would run has changed since it was approved: it is now "${r.needsApproval}". Call show_preview with ios again to ask about that.`, isError: true };
    }
  } catch {
    return { output, isError: true };
  }
  if (r.error || !r.ios) return { output: r.error ?? "The iOS app didn't start building.", isError: true };
  const b = r.ios;
  if (b.stage === "failed") return { output: `The build of ${b.scheme} failed: ${b.error ?? "see the log"}\n${b.log.join("\n")}`, isError: true };
  if (b.stage === "running") return { output: `${b.scheme} is running in the iOS simulator and showing in the Preview panel's iOS side. Tell the person what to look at; they can touch it in Simulator.` };
  return { output: `Building ${b.scheme} for the iOS simulator (${b.stage}). It shows in the Preview panel's iOS side when it is running; call show_preview with ios again to see how it is going.\n${b.log.join("\n")}` };
}

/** What the agent is told about a background command, from the runner's answer. */
function bgText(r: { background?: { id: string; command: string; running: boolean; exitCode?: number | null; stopped?: boolean; log: string[] }; error?: string }): { text: string; isError: boolean } {
  if (r.error || !r.background) return { text: r.error ?? "Couldn't reach the background command.", isError: true };
  const b = r.background;
  const state = b.running ? "still running" : b.stopped ? "stopped" : `exited ${b.exitCode ?? "without a code"}`;
  const log = b.log.length ? b.log.join("\n") : "(nothing printed yet)";
  return { text: `${b.id}: ${b.command}\n(${state})\n${log}`, isError: !b.running && !b.stopped && b.exitCode !== 0 };
}

export const runBackground: AgentTool = {
  name: "run_background",
  description:
    "Start a command and leave it running while you carry on: a test watcher, a build in watch mode, a worker, a log tail. Returns at once with an id and whatever it printed first. Read what it has printed since with read_background, and stop it with stop_background. Use run_command for anything that finishes by itself, giving a long build or install a longer timeout_seconds. Not for the project's dev server, which show_preview runs and shows.",
  parameters: {
    type: "object",
    properties: { command: { type: "string", description: "The command line, e.g. 'npm test -- --watch'. Runs in the repository root and keeps running." } },
    required: ["command"],
    additionalProperties: false,
  },
  cancellable: false,
  async run(args, ctx) {
    if (!ctx.readRepo) return { output: repoUnavailable, isError: true };
    const command = str(args.command);
    if (!command.trim()) return { output: "Give a command to run.", isError: true };
    const gate = await ctx.commandGate?.(command);
    if (gate && !gate.go) return { output: gate.output, isError: true, ...(gate.endTurn ? { endTurn: true } : {}) };
    const { output } = await ctx.readRepo({ op: "bgstart", command, ...(gate?.go && gate.approved ? { approved: true } : {}) });
    return parseBg(output);
  },
};

export const readBackground: AgentTool = {
  name: "read_background",
  description: "Read the latest output of a command started with run_background, and whether it is still running. Use it to check on a watcher after you have changed something.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The id run_background gave, like bg1." },
      lines: { type: "number", description: "How many of the latest lines to read. Default 80." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  cancellable: false,
  async run(args, ctx) {
    if (!ctx.readRepo) return { output: repoUnavailable, isError: true };
    const { output } = await ctx.readRepo({ op: "bgread", query: str(args.id), offset: Math.max(1, Math.min(400, Number(args.lines) || 80)) });
    return parseBg(output);
  },
};

export const stopBackground: AgentTool = {
  name: "stop_background",
  description: "Stop a command started with run_background. Stop what you no longer need: a watcher left running keeps using the person's machine.",
  parameters: { type: "object", properties: { id: { type: "string", description: "The id run_background gave, like bg1." } }, required: ["id"], additionalProperties: false },
  cancellable: false,
  async run(args, ctx) {
    if (!ctx.readRepo) return { output: repoUnavailable, isError: true };
    const { output } = await ctx.readRepo({ op: "bgstop", query: str(args.id) });
    return parseBg(output);
  },
};

function parseBg(output: string): { output: string; isError: boolean } {
  // A machine that is too old to know the command answers in a sentence rather than JSON; so does a refusal for its mode.
  try {
    const r = bgText(JSON.parse(output));
    return { output: r.text, isError: r.isError };
  } catch {
    return { output, isError: true };
  }
}

export const repoTools: AgentTool[] = [listFiles, readRepoFile, searchRepo, writeRepoFile, editRepoFile, runCommand, runBackground, readBackground, stopBackground, showPreview];

/** Everything Friday's own agent can do, before the session narrows it. */
export const handOff: AgentTool = {
  name: "hand_off",
  description:
    "Pass this work to another agent in the session when it is better placed to do it — for example, one that can write and verify a patch after you have reproduced a bug. Say why, list what you already established so it doesn't start over, and state the task. Your turn ends; the other agent picks it up.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "The other agent's name, as the session shows it. A recognisable part of it works too (\"claude\", \"review\"); leave it empty to let the session pick the best fit for the task." },
      reason: { type: "string", description: "One or two sentences: why this agent, why now." },
      carried: { type: "array", items: { type: "string" }, description: "Short lines it should start from: findings, the files involved, the failing test and its output." },
      task: { type: "string", description: "What it should do, as an instruction." },
    },
    required: ["to", "reason", "task"],
    additionalProperties: false,
  },
  cancellable: false,
  async run(args, ctx) {
    if (!ctx.handOff) return { output: "There is no other agent in this session to hand off to.", isError: true };
    const carried = Array.isArray(args.carried) ? args.carried.filter((c): c is string => typeof c === "string") : [];
    const r = await ctx.handOff({ to: str(args.to), reason: str(args.reason), carried, task: str(args.task) });
    if (!r.ok) return { output: r.error, isError: true };
    return { output: `Handed off to ${r.toName}.${r.note ? ` ${r.note}` : ""} It has your reason, what you carried over (plus the files you changed) and the task. Stop here and say in a sentence that you handed it over.`, endTurn: true };
  },
};

/**
 * Deploy a specialist.
 *
 * The agent's own team, named when it was built, put to work in a lane beside
 * it. It does not end the turn: the piece it hands off is separate work, and
 * the agent may have other pieces to hand to other specialists, so the next
 * step is its own to take.
 */
export const deployAgent: AgentTool = {
  name: "deploy_agent",
  description:
    "Put one of your team's specialists to work on a separate piece of the job. It runs in its own lane alongside you, with the task and context you give it, and its results appear in the session as it finishes. Give everything it needs so it doesn't start from nothing. You can deploy several for separate pieces; you don't wait for them.",
  parameters: {
    type: "object",
    properties: {
      agent: { type: "string", description: "The specialist's name, as listed in your team." },
      reason: { type: "string", description: "One sentence: why this specialist for this piece." },
      carried: { type: "array", items: { type: "string" }, description: "Short lines it should start from: findings, files involved, constraints." },
      task: { type: "string", description: "What it should do, as an instruction." },
    },
    required: ["agent", "reason", "task"],
    additionalProperties: false,
  },
  cancellable: false,
  async run(args, ctx) {
    if (!ctx.deployAgent) return { output: "You have no team to deploy from here.", isError: true };
    const carried = Array.isArray(args.carried) ? args.carried.filter((c): c is string => typeof c === "string") : [];
    const r = await ctx.deployAgent({ agent: str(args.agent), reason: str(args.reason), carried, task: str(args.task) });
    if (!r.ok) return { output: r.error, isError: true };
    return { output: `${r.reused ? `${r.name} was already in the session, so it has the new task.` : `Deployed ${r.name}.`} It is working on it now. Deploy others for separate pieces if there are any; otherwise say in a sentence who is doing what and stop.` };
  },
};

/** The other sessions this agent can reach, related ones first (peers.ts). */
export const listSessions: AgentTool = {
  name: "list_sessions",
  description: "List the other sessions in this workspace you can reach: the ones the person you work for is in, and teammates' sessions from the team's library that aren't private (read only). Each with what it is doing; ones on the same repo, or that changed the same files as you, come first. Use it to find a session before read_session or message_session, and to check whether a teammate already worked something out before you start on it.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  cancellable: false,
  async run(_args, ctx) {
    if (!ctx.peers) return { output: "Other sessions can't be reached from here.", isError: true };
    return { output: await ctx.peers.list() };
  },
};

export const readSession: AgentTool = {
  name: "read_session",
  description: "Read where another session is: its agents, what each last said, and the files it has changed. Works on the person's own sessions and on teammates' sessions from the team's library. Use it to see what another session decided or did before you build on it or tell it something.",
  parameters: {
    type: "object",
    properties: { to: { type: "string", description: "The session's id or title, from list_sessions." } },
    required: ["to"],
    additionalProperties: false,
  },
  cancellable: false,
  async run(args, ctx) {
    if (!ctx.peers) return { output: "Other sessions can't be reached from here.", isError: true };
    const r = await ctx.peers.read(str(args.to));
    return r.ok ? { output: r.text } : { output: r.error, isError: true };
  },
};

export const messageSession: AgentTool = {
  name: "message_session",
  description:
    "Tell another session's agent something it needs to know: a change of yours that affects its work, something you found, a question for it. It reaches that agent as a message from you, not as an instruction from its people, and it may not answer. One to an agent the person you work for can't steer waits there until someone who can lets it through. Be short and specific, and name files and functions exactly. Don't wait for a reply.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "The session's id or title, from list_sessions." },
      agent: { type: "string", description: "Which agent there, by name. Leave empty for its main agent." },
      text: { type: "string", description: "The message." },
    },
    required: ["to", "text"],
    additionalProperties: false,
  },
  cancellable: false,
  async run(args, ctx) {
    if (!ctx.peers) return { output: "Other sessions can't be reached from here.", isError: true };
    const r = await ctx.peers.send({ to: str(args.to), agent: str(args.agent), text: str(args.text) });
    if (!r.ok) return { output: r.error, isError: true };
    await ctx.append({ type: "peer.sent", to: { sid: r.sid, title: r.title, lane: r.lane, name: r.name }, text: r.text, held: r.held });
    return {
      output: r.held
        ? `Sent to ${r.name} in "${r.title}". The person you work for can't steer that agent, so it waits there until someone who can lets it through. Carry on with your own work.`
        : `Sent to ${r.name} in "${r.title}". It reads it at its next step, or starts on it now if it was idle. Carry on with your own work; don't wait for an answer.`,
    };
  },
};

/**
 * The agents in this session talking to each other (agent-mesh.ts), as Friday Code's own tools: the same ones every coding tool
 * here gets from its `friday` MCP server. Its hand_off and remember already cover handing off and the notes. Not cut off by a
 * pause or a stop: a message sent is sent, and an ask stops waiting by itself when its run is paused or stopped.
 */
// Not check_messages: Friday Code reads what came in between its own steps already, and the team's updates are in what it reads.
export const meshTools: AgentTool[] = MESH_TOOLS.filter((t) => ["list_agents", "message_agent", "message_team", "ask_agent", "reply_to_agent", "post_update", "wait_for_agent", "assign_task", "post_tasks", "list_tasks", "claim_task", "finish_task", "claim_files", "release_files", "wake_me_when"].includes(t.name)).map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.inputSchema,
  cancellable: false,
  async run(args, ctx) {
    if (!ctx.mesh) return { output: "There are no other agents to reach from here.", isError: true };
    const r = await ctx.mesh.call(t.name, args, ctx.signal);
    return { output: r.output, ...(r.isError ? { isError: true } : {}), ...(r.endTurn ? { endTurn: true } : {}) };
  },
}));

/** A hub: the work split into pieces that several coding agents do at once, each in its own copy of the folder (hubs.ts). */
export const startHub: AgentTool = {
  name: "start_hub",
  description:
    "Split a big piece of work into independent tasks and have several coding agents do them at once, each in its own copy of the folder, with the results checked, brought together and sent as one pull request. For work with parts that can be done separately (several features, several modules, a change across many files); not for one small change. A card with the plan goes to the session's owner, who approves it before anything runs. Your turn ends here; say in a sentence what you asked for.",
  parameters: {
    type: "object",
    properties: { goal: { type: "string", description: "The whole of the work, as if to an engineer who hasn't read this conversation: what, where, and what done looks like." } },
    required: ["goal"],
    additionalProperties: false,
  },
  cancellable: false,
  async run(args, ctx) {
    if (!ctx.startHub) return { output: "A hub can't be started from here.", isError: true };
    const r = await ctx.startHub(str(args.goal));
    if (!r.ok) return { output: r.error, isError: true };
    return { output: "The plan is on a card in the session for the people here to approve. Nothing runs until they do. Stop here and say in a sentence what the hub will do.", endTurn: true };
  },
};

export const defaultTools: AgentTool[] = [webSearch, fetchUrl, askHuman, remember, updatePlan, handOff, deployAgent, ...meshTools, listSessions, readSession, messageSession, startHub, addSkillsFromGithub, ...repoTools];
