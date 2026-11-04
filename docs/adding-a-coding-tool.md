# Adding a Non-ACP Coding Tool Adapter

Friday supports multiple AI coding tools. When a tool natively implements the Agent Client Protocol (ACP), adding it is straightforward using the `acp({...})` helper. However, several major coding assistants—such as **Claude Code**, **Codex**, and **Cursor**—do not speak ACP. Instead, Friday interacts with them by launching their CLI binaries directly, communicating over `stdio`, parsing their output lines, and managing their permission policies.

This document walks through the architecture of coding tool integration in Friday (evaluated at commit `7abfb71b06c15b4464965fe0107d1e5bde6561c1`). It covers:
1. The **three essential places** every new tool must touch (`src/types.ts`, `src/client/BrandMarks.tsx`, and `src/runner/adapters.ts`).
2. The core non-ACP `Adapter` architecture (auth lifecycle, process spawning, `stdio` streaming, output parsing, and permission mode mappings).
3. Worked examples from existing tools, including Qwen Code's integration ([PR #10](https://github.com/splashxmoon/friday/pull/10)).

---

## 1. The Three Integration Points

Regardless of whether a tool speaks ACP or uses a custom CLI adapter, registering a new tool in Friday requires entries in three places across the codebase. [PR #10](https://github.com/splashxmoon/friday/pull/10) (which added Qwen Code) serves as a canonical reference.

### 1.1 Type Definitions and Metadata (`src/types.ts`)

`src/types.ts` is the single source of truth for tool identity and installation instructions.

1. **`EngineTool` union**: Add the tool identifier slug:
   ```typescript
   export type EngineTool =
     | "claude"
     | "codex"
     | "cursor"
     // ...
     | "qwen"
     | "mytool"
     | "acp";
   ```
2. **`TOOL_INFO` entry**: Define user-facing labels, documentation links, install commands for each OS, and branding tint color:
   ```typescript
   export const TOOL_INFO: Record<EngineTool, ToolInfo> = {
     // ...
     mytool: {
       name: "MyTool",
       blurb: "Vendor's coding assistant",
       docs: "https://example.com/docs",
       install: {
         npm: "@vendor/mytool-cli", // or { windows: "irm ... | iex", unix: "curl ... | bash" }
       },
       tint: "#4a90e2",
     },
   };
   ```
3. **Derived Lists**: Friday automatically derives `ENGINE_TOOLS` and `ENGINE_NAMES` from `TOOL_INFO`:
   ```typescript
   export const ENGINE_TOOLS = Object.keys(TOOL_INFO) as EngineTool[];
   export const ENGINE_NAMES = Object.fromEntries(
     ENGINE_TOOLS.map((t) => [t, TOOL_INFO[t].name])
   ) as Record<EngineTool, string>;
   ```
4. **`ENGINE_MODEL_INFO`**: Provide offered models or an empty array `[]` if the tool discovers models dynamically via its CLI or protocol:
   ```typescript
   export const ENGINE_MODEL_INFO: Record<EngineTool, EngineModelInfo[]> = {
     // ...
     mytool: [],
   };
   ```

### 1.2 UI Brand Mark (`src/client/BrandMarks.tsx`)

Every tool displays an icon beside its name across menus, agent handoffs, and lane headers.

In `src/client/BrandMarks.tsx`:
- If the tool has a vendor SVG logo, provide a dedicated component (e.g. `ClaudeMark`, `CursorMark`) or define its SVG path in `TOOL_COLOR` or `TOOL_PATHS`.
- If the tool uses a generic icon or open icon set, map it in `EngineMark`:
  ```typescript
  export function EngineMark({ tool, size = 15, className }: { tool: EngineTool | ""; size?: number; className?: string }) {
    if (tool === "claude") return <ClaudeMark size={size} className={className} />;
    if (tool === "cursor") return <CursorMark size={size} className={className} />;
    // Generic fallback or icon:
    if (tool === "qwen") return <BotIcon size={size} className={className} role="img" aria-label={ENGINE_NAMES.qwen} style={{ flex: "none" }} />;
    if (tool === "mytool") return <BotIcon size={size} className={className} role="img" aria-label={ENGINE_NAMES.mytool} style={{ flex: "none" }} />;
    // ...
  }
  ```

### 1.3 The Runner Adapter (`src/runner/adapters.ts`)

This is where Friday communicates with the tool process.
- For ACP tools: declare an `acp({...})` profile (see Qwen in PR #10, Kilo, or Grok).
- For non-ACP tools: implement the full `Adapter` interface described below.
- Finally, register the adapter in `ADAPTERS`:
  ```typescript
  export const ADAPTERS: Record<EngineTool, Adapter> = {
    claude,
    codex,
    cursor,
    // ...
    mytool,
    acp: custom,
  };
  ```

---

## 2. The `Adapter` Interface

Every tool adapter implements the `Adapter` interface defined in `src/runner/adapters.ts` (around line 229):

```typescript
export interface Adapter {
  tool: EngineTool;
  bins: string[];
  login: string[];
  logout: string[];
  args(t: TurnSpec): string[];
  stdin(t: TurnSpec): string;
  prespawn?: boolean;
  interactive?: boolean;
  dirs?: boolean;
  dialect?: "codex";
  perTurn?: true;
  modes?: EngineMode[];
  optional?: string[];
  env?(t: TurnSpec): Record<string, string>;
  unavailable?(): string | null;
  status?: { args: string[]; signedIn?: RegExp; signedOut?: RegExp } | ((bin: string) => Promise<boolean | null>);
  parser(t?: TurnSpec, io?: TurnIO): Parser;
  explain(error: string): string;
}
```

Key fields:
- **`bins`**: Executable binary names to locate on the host `$PATH` (e.g. `["claude"]`, `["codex"]`, `["cursor-agent"]`).
- **`login` / `logout`**: Arguments passed to the binary to authenticate or de-authenticate.
- **`status`**: How Friday checks whether the user is already signed in without inspecting raw credentials.
- **`args(t)`**: Function producing CLI arguments for a turn based on the turn specification (`TurnSpec`).
- **`stdin(t)`**: Payload written to the process's standard input (prompts, initial handshake, or empty string).
- **`parser(t, io)`**: Factory returning a line parser `(line: string) => AdapterOut[]` for the turn.

---

## 2. Authentication Lifecycle (`login`, `logout`, and `status`)

Friday does not store or manage third-party API tokens directly. Instead, it delegates account management to the CLI tool itself.

### `login` and `logout`

- **`login`**: Interactive command arguments. Friday opens an interactive terminal for the user if necessary.
- **`logout`**: Non-interactive command arguments to revoke or clear stored credentials.

Examples from `src/runner/adapters.ts`:
```typescript
// Claude Code (line 490)
login: ["auth", "login"],
logout: ["auth", "logout"],

// Codex (line 972)
login: ["login"],
logout: ["logout"],

// Cursor (line 1375)
login: ["login"],
logout: ["logout"],
```

### `status` Checking

Friday checks authentication status periodically or when loading settings:

- **Command with status check**:
  ```typescript
  // Claude Code (line 492): runs `claude auth status --json`
  status: { args: ["auth", "status", "--json"] },

  // Codex (line 974): runs `codex login status`
  status: { args: ["login", "status"] },

  // Cursor (line 1377): runs `cursor-agent status`
  status: { args: ["status"] },
  ```

- **File-based / Env-based check**:
  Some tools (like Gemini or Grok) verify local credentials files or environment variables via the `anyOf` helper (line 2076).

---

## 3. Starting a Turn (`args` and `stdin`)

When a user or agent submits a prompt, the runner builds a `TurnSpec` containing the target model, working directory, extra directories (`dirs`), permission mode (`plan`, `edits`, `full`), prompt text, system prompts, and resume IDs.

### Claude Code (`claude`)

Claude Code runs in headless print mode (`-p`) with streaming JSON (`--output-format stream-json`). The prompt is passed via `stdin` to avoid OS command-line length limits and shell escaping bugs.

Excerpt from `src/runner/adapters.ts` (`claude`, line 494):
```typescript
args: (t) => [
  "-p",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  ...(t.model ? ["--model", t.model] : []),
  ...(t.effort ? ["--effort", t.effort] : []),
  "--permission-mode", claudeMode(t),
  ...(t.dirs ?? []).flatMap((d) => ["--add-dir", d]),
  ...(t.ask ? ["--permission-prompt-tool", "stdio"] : []),
  // ... allowed tools and system prompts
  ...(t.systemFile ? ["--append-system-prompt-file", t.systemFile] : ["--append-system-prompt", t.system]),
  ...(t.resumeId ? ["--resume", t.resumeId, ...(t.fork ? ["--fork-session"] : [])] : []),
],
stdin: (t) => t.prompt,
```

### Codex (`codex`)

Codex is run as an interactive long-lived server (`app-server`) communicating over JSON-RPC 2.0:

Excerpt from `src/runner/adapters.ts` (`codex`, line 968):
```typescript
dialect: "codex",
args: (t) => [...(t.friday ? codexConfig(t.friday) : []), ...codexExtras(t), "app-server"],
interactive: true,
stdin: () => `${JSON.stringify({ id: 0, method: "initialize", params: { clientInfo: { name: "friday", title: "Friday", version: "1" } } })}\n`,
```
Because `interactive: true` is set, `stdin` stays open, and Friday sends turns and interrupts dynamically via JSON-RPC.

### Cursor (`cursor`)

Cursor CLI (`cursor-agent`) runs headless with `-p --output-format stream-json --stream-partial-output --trust`.

Excerpt from `src/runner/adapters.ts` (`cursor`, line 1378):
```typescript
args: (t) => [
  "-p",
  "--output-format", "stream-json",
  "--stream-partial-output",
  "--trust",
  ...(t.model ? ["--model", t.model] : []),
  ...(t.mode === "full" || (t.mode === "edits" && t.grant) ? ["--force"] : []),
  ...(t.mode === "full" && offered(t, "--approve-mcps") ? ["--approve-mcps"] : []),
  ...(t.mode === "plan" && offered(t, "--mode") ? ["--mode", "plan"] : []),
  ...(t.resumeId ? ["--resume", t.resumeId] : []),
  ...(t.stdinPrompt || tooLongForArgv(notedPrompt(t)) ? [] : [` ${notedPrompt(t)}`]),
],
stdin: (t) => (t.stdinPrompt || tooLongForArgv(notedPrompt(t)) ? notedPrompt(t) : ""),
```

---

## 4. Output Parsing into Friday Events (`parser`)

The `parser` function transforms raw stdout lines into Friday's internal `AdapterOut` events (`src/runner/adapters.ts`, line 28):
- `kind: "delta"`: Real-time streamed text or reasoning chunks.
- `kind: "message"`: Completed text response or tool calls.
- `kind: "result"`: Output of a tool call or command execution.
- `kind: "ask"`: Tool requesting permission to run a command or access an MCP resource.
- `kind: "task"`: Background subagents or long-running tasks.
- `kind: "usage"`: Token counts (input, cached, output, context size).

### Claude Code Parser

Claude outputs line-delimited JSON objects with types like `system`, `assistant`, `tool_use`, and `control_request`.

Excerpt from `src/runner/adapters.ts` (line 538):
```typescript
parser(t) {
  return (line) => {
    const m = json(line);
    if (!m) return [];
    switch (m.type) {
      case "assistant": {
        // Yields deltas and message blocks
        return [{ kind: "delta", text: m.text, channel: "text" }];
      }
      case "control_request": {
        // Maps mid-turn permission requests to Friday's `ask` event
        return [{
          kind: "ask",
          requestId: m.request_id,
          tool: m.tool_name,
          input: m.input,
          why: m.reason,
        }];
      }
      // Handles system events, tasks, tool results, and usage
    }
  };
}
```

### Cursor Parser

Cursor streams lines containing event types like `system` (yielding session IDs), `assistant` (streaming text chunks), and `tool_call` (with `subtype: "started"` or `"completed"`).

Excerpt from `src/runner/adapters.ts` (line 1417):
```typescript
case "tool_call": {
  const tc = m.tool_call && typeof m.tool_call === "object" ? m.tool_call : {};
  const key = Object.keys(tc)[0] ?? "tool";
  const inner = tc[key] ?? {};
  const { name, args } = cursorTool(key, inner.args);
  const id = str(m.call_id);

  if (m.subtype === "started") {
    return [
      ...flush(),
      { kind: "message", text: "", toolCalls: [call(id, name, args)] },
    ];
  }
  if (m.subtype === "completed") {
    const out = str(inner.result?.success?.stdout) || str(inner.result?.content);
    return [result(id, name, out, !inner.result?.success)];
  }
}
```

---

## 5. Permission Modes (Plan, Manual, Auto)

Friday defines three user-facing permission modes (`EngineMode` in `src/types.ts`, line 336):
1. **`plan` (Plan)**: Read and propose changes only; no file edits or shell executions.
2. **`edits` (Manual)**: Edits allowed to files, but asks the user before executing shell commands or tools.
3. **`full` (Auto)**: Full autonomous execution; file edits and shell commands run without interactive prompts.

Non-ACP adapters map these modes to their CLI flags:

### Claude Code Permission Mapping
Function `claudeMode(t: TurnSpec)` (line 480):
- If `t.mode === "plan"` -> returns `"plan"`.
- If `t.mode === "full"` and supported -> returns `"auto"`.
- Otherwise (Manual / edits) -> returns `"acceptEdits"`.
- In addition, `--allowedTools` restricts which tools Claude may invoke unasked (e.g. `AUTO_TOOLS` vs read-only tools).

### Cursor Permission Mapping
Cursor does not support per-action prompt callbacks in headless mode:
- In `plan`: passes `--mode plan` (when supported) without `--force`.
- In `full` or `edits` with grant: passes `--force` and `--approve-mcps`.
- In `edits` without grant: omits `--force`, causing Cursor to output suggested edits rather than writing directly to disk.

### Codex Permission Mapping
Function `codexPolicy(t: TurnSpec)` (line 920):
- Maps sandbox level:
  - `read-only` for Plan or safe viewing.
  - `workspace-write` for Manual / Auto (on Windows, `danger-full-access` is used when write access is granted due to Windows sandbox account isolation).
- Sets `approvalPolicy`: `"never"`, `"on-request"`, or `"untrusted"`.

---

## 6. How to Implement a New Non-ACP Adapter

To add a new CLI-based tool adapter:

1. **Register the Tool Type**:
   In `src/types.ts`, add the tool key to `EngineTool` and metadata to `TOOL_INFO`.
2. **Implement the `Adapter`**:
   In `src/runner/adapters.ts`, declare your adapter constant:
   ```typescript
   export const mytool: Adapter = {
     tool: "mytool",
     bins: ["mytool-cli"],
     login: ["auth", "login"],
     logout: ["auth", "logout"],
     status: { args: ["auth", "status"] },
     args: (t) => [
       "--output-format", "json",
       ...(t.mode === "plan" ? ["--read-only"] : []),
       // Add flags for model, directories, and permission modes
     ],
     stdin: (t) => t.prompt,
     parser(t) {
       return (line) => {
         // Parse stdout lines and map to AdapterOut[]
         return [];
       };
     },
     explain: (error) => error,
   };
   ```
3. **Register in `ADAPTERS`**:
   Add your adapter to the `ADAPTERS` object at the bottom of `src/runner/adapters.ts`.
4. **Write Unit Tests**:
   Create a test file in `test/mytool.test.ts` verifying that `parser()` transforms sample output lines into expected `AdapterOut` events.
5. **Verify**:
   Run `npm run typecheck` and `npm test` before submitting your pull request.
