import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A stand-in for Claude Code, for tests that run a whole local Friday (Slack and Linear, spec 08): it writes a finished plan
 * (TodoWrite), then says "Got MARKER-x" for the last marker it was given. MARKER-slow takes twenty seconds the first time, for
 * a stop to land in. Set as FRIDAY_CLAUDE_BIN.
 */
export async function writeFakeClaude(root: string): Promise<string> {
  const fake = path.join(root, "fake-claude.mjs");
  await writeFile(
    fake,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
if (args[0] === "auth") { out({ loggedIn: true, authMethod: "claude.ai" }); process.exit(0); }
if (args.includes("--version")) { console.log("2.0.0 (Claude Code)"); process.exit(0); }
const sid = "fake-" + process.pid;
const answer = (input) => {
  if (/MARKER-slow/.test(input) && !answer.slept) { answer.slept = true; return void setTimeout(() => answer(input), 20000); }
  const marks = input.match(/MARKER-\\w+/g) || [];
  const said = "Got " + (marks[marks.length - 1] || "nothing");
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t" + Date.now(), name: "TodoWrite", input: { todos: [{ content: "Read the issue", status: "completed" }, { content: "Fix it", status: "completed" }] } }] }, parent_tool_use_id: null, session_id: sid });
  out({ type: "assistant", message: { content: [{ type: "text", text: said }] }, parent_tool_use_id: null, session_id: sid });
  out({ type: "result", subtype: "success", is_error: false, result: said, session_id: sid });
};
out({ type: "system", subtype: "init", session_id: sid, cwd: process.cwd() });
let input = "";
if (args.includes("--input-format")) {
  process.stdin.on("data", (d) => {
    input += d;
    let i;
    while ((i = input.indexOf("\\n")) >= 0) {
      const line = input.slice(0, i);
      input = input.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type !== "user") continue;
      out({ ...m, session_id: sid });
      answer(typeof m.message.content === "string" ? m.message.content : JSON.stringify(m.message.content));
    }
  });
} else {
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => answer(input));
}
`,
  );
  await chmod(fake, 0o755);
  return fake;
}
