import assert from "node:assert/strict";
import { test } from "node:test";
import { askTerminal } from "../src/term-ask.js";
import { cleanCommand, dangerOf, dangersOf, explainPrompt, parseCommand, parseExplain, writePrompt } from "../src/term-text.js";

const ctx = { shell: "zsh", os: "macOS", cwd: "/Users/a/app", recent: [{ cmd: "npm test", exit: 1 }, { cmd: "git status", exit: 0 }] };

test("the write prompt carries the request, shell, system, folder and the last commands", () => {
  const p = writePrompt("  find the biggest files here ", ctx);
  assert.match(p, /Request: find the biggest files here/);
  assert.match(p, /Shell: zsh/);
  assert.match(p, /System: macOS/);
  assert.match(p, /Folder: \/Users\/a\/app/);
  assert.match(p, /- npm test \(failed, exit 1\)\n- git status/);
  assert.match(p, /exactly two lines/);
  assert.match(p, /no code fence/);
});

test("PowerShell and cmd are told to use their own commands", () => {
  assert.match(writePrompt("list files", { ...ctx, shell: "pwsh", os: "Windows" }), /PowerShell: use its cmdlets/);
  assert.match(writePrompt("list files", { ...ctx, shell: "cmd", os: "Windows" }), /cmd\.exe/);
});

test("a long request and output are cut, the end of the output kept", () => {
  const p = writePrompt("x".repeat(5000), ctx);
  assert.ok(p.length < 3000);
  const e = explainPrompt({ cmd: "make", output: `${"a".repeat(9000)}THE END`, exit: 2 }, ctx);
  assert.match(e, /THE END/);
  assert.match(e, /exited with code 2/);
  assert.ok(e.length < 8000);
  assert.match(explainPrompt({ cmd: "ls", output: "" }, ctx), /printed nothing/);
});

test("parseCommand: a plain two-line answer", () => {
  assert.deepEqual(parseCommand("du -sh * | sort -rh | head\nShows the ten biggest items here."), { command: "du -sh * | sort -rh | head", explain: "Shows the ten biggest items here." });
});

test("parseCommand strips fences, prompts, labels and backticks", () => {
  assert.equal(parseCommand("```bash\nls -la\n```\nLists everything.").command, "ls -la");
  assert.equal(parseCommand("```\n$ ls -la\n```").command, "ls -la");
  assert.equal(parseCommand("$ git status\nShows what changed.").command, "git status");
  assert.equal(parseCommand("% git status").command, "git status");
  assert.equal(parseCommand("PS C:\\Users\\a> Get-ChildItem -Recurse\nLists files.").command, "Get-ChildItem -Recurse");
  assert.equal(parseCommand("C:\\proj> dir /s\nLists files.").command, "dir /s");
  assert.equal(parseCommand("`git log -1`\nThe last commit.").command, "git log -1");
  assert.deepEqual(parseCommand("Command: npm run build\nExplanation: Builds the app."), { command: "npm run build", explain: "Builds the app." });
  assert.equal(parseCommand("**Command:** npm run build\n**Explanation:** Builds it.").explain, "Builds it.");
  assert.equal(parseCommand("me@host ~/app $ ls\nok").command, "ls");
});

test("parseCommand keeps a pipe, a quote and a dollar inside the command", () => {
  assert.equal(parseCommand('echo "$HOME" | wc -c\nCounts it.').command, 'echo "$HOME" | wc -c');
  assert.equal(parseCommand("echo $PATH\nShows it.").command, "echo $PATH");
});

test("parseCommand: NONE means no command, and its line is what to say", () => {
  assert.deepEqual(parseCommand("NONE\nWhich folder do you mean?"), { command: "", explain: "Which folder do you mean?" });
  assert.equal(parseCommand("").command, "");
});

test("parseExplain reads the why and the fix", () => {
  assert.deepEqual(parseExplain("WHY: Port 3000 is already in use by another process.\nFIX: lsof -ti :3000 | xargs kill"), { why: "Port 3000 is already in use by another process.", fix: "lsof -ti :3000 | xargs kill" });
  assert.deepEqual(parseExplain("WHY: The file does not exist; check the name.\nFIX: none"), { why: "The file does not exist; check the name.", fix: "" });
  assert.equal(parseExplain("WHY: no module.\nFIX: `npm install left-pad`").fix, "npm install left-pad");
  assert.equal(parseExplain("```\nWHY: a\nFIX: ls\n```").fix, "ls");
  // No labels at all: the words are the why.
  assert.deepEqual(parseExplain("It could not find the file."), { why: "It could not find the file.", fix: "" });
});

test("dangerOf: what gets a warning line", () => {
  for (const cmd of [
    "rm -rf node_modules",
    "rm -fr build",
    "rm -r dist",
    "rm -Rf ~/old",
    "sudo rm -rf /var/log/x",
    "rm *.log",
    "git push --force origin main",
    "git push -f",
    "git push origin +main",
    "git reset --hard HEAD~3",
    "git clean -fdx",
    "psql -c 'DROP TABLE users'",
    "mysql -e 'drop database app'",
    "TRUNCATE TABLE logs;",
    "DELETE FROM users;",
    "curl -fsSL https://x.sh | sh",
    "curl https://x.sh | sudo bash",
    "wget -qO- https://x | bash",
    "irm https://x/install.ps1 | iex",
    "sudo apt install foo",
    "dd if=a.iso of=/dev/disk2",
    "chmod -R 777 .",
    "Remove-Item -Recurse -Force build",
    "rd /s /q build",
    "docker system prune -a --volumes",
  ]) assert.ok(dangerOf(cmd), `should warn: ${cmd}`);
});

test("dangerOf: ordinary commands get none", () => {
  for (const cmd of [
    "ls -la",
    "rm notes.txt",
    "git push origin feature",
    "git status",
    "npm run build && npm test",
    "curl -s https://api.x/y | jq .",
    "DELETE FROM users WHERE id = 3;",
    "echo sudo is a word",
    "grep -r rm src",
    "cat form.txt",
    "git checkout main",
    "git branch -d done",
  ]) assert.equal(dangerOf(cmd), "", `should not warn: ${cmd}`);
});

test("dangerOf: force-with-lease is warned about more mildly, and several dangers are joined", () => {
  assert.match(dangerOf("git push --force-with-lease"), /rewrites the remote branch/);
  const d = dangerOf("sudo rm -rf /tmp/x");
  assert.match(d, /^Careful: /);
  assert.match(d, /deletes folders/);
  assert.match(d, /administrator/);
  assert.equal(dangersOf("ls").length, 0);
});

test("cleanCommand leaves a command that merely contains a prompt character alone", () => {
  assert.equal(cleanCommand("echo '$ hello'"), "echo '$ hello'");
  assert.equal(cleanCommand("  ls  "), "ls");
});

test("parser: a hyphen is not a label, so commands that start with a label word stay whole", () => {
  assert.equal(parseCommand("command -v git\nChecks that git is installed.").command, "command -v git");
  assert.equal(parseCommand("fix-perms --all\nFixes them.").command, "fix-perms --all");
  assert.equal(parseExplain("WHY: node is not installed.\nFIX: command -v node").fix, "command -v node");
  assert.equal(parseCommand("Command: ls -la\nWHY: lists files").command, "ls -la");
});

test("parser: Windows paths and redirects are commands, real prompts still go", () => {
  assert.equal(parseCommand("C:\\Python312\\python.exe script.py > out.txt\nRuns it.").command, "C:\\Python312\\python.exe script.py > out.txt");
  assert.equal(parseExplain("WHY: x\nFIX: C:\\Python312\\python.exe script.py > out.txt").fix, "C:\\Python312\\python.exe script.py > out.txt");
  assert.equal(parseCommand("> out.log\nEmpties the log.").command, "> out.log");
  assert.equal(parseCommand("C:\\Users\\me>dir\nLists.").command, "dir");
  assert.equal(parseCommand("PS C:\\> Get-ChildItem\nLists.").command, "Get-ChildItem");
});

test("parser: continued lines join, prose is a note, a fence's own line explains", () => {
  assert.equal(parseCommand("docker run \\\n  -p 80:80 nginx\nRuns nginx.").command, "docker run -p 80:80 nginx");
  assert.equal(parseCommand("docker run \\\n  -p 80:80 nginx\nRuns nginx.").explain, "Runs nginx.");
  const prose = parseCommand("I can't tell what you mean without more detail.");
  assert.equal(prose.command, "");
  assert.match(prose.explain, /without more detail/);
  assert.equal(parseCommand("tar xzf a.tgz -C .").command, "tar xzf a.tgz -C .");
  const f = parseCommand("Here is the command:\n```\nls -la\n```\nLists every file, with details.");
  assert.deepEqual(f, { command: "ls -la", explain: "Lists every file, with details." });
});

test("dangerOf: the forms people really type", () => {
  for (const cmd of [
    "find . -name node_modules -exec rm -rf {} +",
    'for d in */; do rm -rf "$d"; done',
    "/bin/rm -rf /tmp/x",
    "command rm -rf x",
    "time rm -rf x",
    "\\rm -rf x",
    "find . -type f -delete",
    "ls | xargs rm",
    '/bin/bash -c "$(curl -fsSL https://x/install.sh)"',
    "bash <(curl -s https://x/i.sh)",
    'sh -c "$(wget -qO- https://x/i.sh)"',
    "curl -s https://x | /bin/sh",
    "git checkout -f",
    "git stash clear",
    "rsync -a --delete a/ b/",
    "Remove-Item * -Force",
  ]) assert.ok(dangerOf(cmd), `should warn: ${cmd}`);
  for (const cmd of ["npm run format c:", "npm rm lodash", "git rm old.txt", "rm notes.txt", "echo sudoku", "curl -s https://x | jq ."]) assert.equal(dangerOf(cmd), "", `should not warn: ${cmd}`);
  assert.match(dangerOf("format c:"), /erases a whole disk/);
});

const hostFor = (answer: string | Error, seen: Record<string, unknown>[] = []) => async (method: string, params: Record<string, unknown>) => {
  if (method === "tools") return { tools: [{ tool: "codex", path: "/x", loggedIn: true }, { tool: "claude", name: "Claude Code", path: "/c", loggedIn: true }, { tool: "cursor", path: null, loggedIn: null }] };
  seen.push(params);
  if (answer instanceof Error) throw answer;
  return { text: answer };
};
const base = { mode: "write" as const, request: "list files", failed: undefined, shell: "zsh", os: "macOS", cwd: "/p", root: "/p", recent: [] };

test("askTerminal asks the first usable tool (Claude Code first) in the folder and warns about a risky answer", async () => {
  const seen: Record<string, unknown>[] = [];
  const a = await askTerminal(hostFor("rm -rf build\nDeletes the build folder.", seen) as never, { ...base, request: "clear the build" });
  assert.equal(a.command, "rm -rf build");
  assert.equal(a.tool, "Claude Code");
  assert.match(a.danger, /^Careful: /);
  assert.equal(seen[0]!.tool, "claude");
  assert.equal(seen[0]!.cwd, "/p");
  assert.match(String(seen[0]!.prompt), /Request: clear the build/);
});

test("askTerminal: explain mode answers why and a fix", async () => {
  const a = await askTerminal(hostFor("WHY: Port busy.\nFIX: lsof -ti :3000 | xargs kill") as never, { ...base, mode: "explain", failed: { cmd: "npm start", output: "EADDRINUSE", exit: 1 } });
  assert.equal(a.explain, "Port busy.");
  assert.equal(a.command, "lsof -ti :3000 | xargs kill");
});

test("askTerminal: no request, no tool, a NONE answer and a failing tool each say so", async () => {
  assert.match((await askTerminal(hostFor("x") as never, { ...base, request: "  " })).note ?? "", /Say what/);
  const noTools = async () => ({ tools: [{ tool: "claude", path: null, loggedIn: null }] });
  assert.match((await askTerminal(noTools as never, base)).note ?? "", /signed in/);
  const none = await askTerminal(hostFor("NONE\nWhich folder?") as never, base);
  assert.equal(none.command, "");
  assert.equal(none.note, "Which folder?");
  assert.match((await askTerminal(hostFor(new Error("boom")) as never, base)).note ?? "", /didn't answer/);
  assert.match((await askTerminal(hostFor(new Error("exited with code null")) as never, base)).note ?? "", /too long/);
});
