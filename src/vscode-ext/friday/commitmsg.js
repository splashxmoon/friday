"use strict";
// "✳ Write message" in the Source Control box (Arun, 2026-11-19, wave 3: "Commit messages and PR descriptions written from what the
// agent did and why, in your repo's style"). It reads what is staged (or everything changed when nothing is staged) and the last 30
// commits' subjects, sends them to Friday (POST /api/vscode/commit-message, src/commit-ask.ts), which has the person's own coding
// tool write the message in the repo's voice, using the ask and decisions of the Code chat that made the changes. The answer fills
// the box. Nothing is committed: the person reads it and presses Commit.
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

// Friday reads about 16,000 characters of the diff and refuses a request over 256 KB (JSON escaping and non-ASCII text can double
// the size), so the diff is cut here, every file keeping a share, well under both.
const MAX_DIFF = 60000;
const MAX_FILES = 500;
const MAX_NEW_FILE = 6000;

function git(gitPath, cwd, args, max = 16 * 1024 * 1024) {
  return new Promise((resolve) => {
    execFile(gitPath || "git", ["-c", "core.quotepath=off", ...args], { cwd, maxBuffer: max, timeout: 30000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } }, (err, out) => resolve(err ? null : String(out)));
  });
}

/** `git diff --name-status -z` as [{ status, path }]: a rename or copy has two paths, the new one is the file. Pure. */
function parseNameStatus(out) {
  const parts = String(out || "").split("\0");
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const to = parts[i + 2];
      i += 2;
      if (to) files.push({ status: letter === "R" ? "renamed" : "copied", path: to });
    } else {
      const p = parts[++i];
      if (p) files.push({ status: { A: "added", M: "modified", D: "deleted", T: "changed" }[letter] || "modified", path: p });
    }
  }
  return files;
}

/** `git log --format=%s%x1f%b%x1e` as [{ subject, body }], newest first. Pure. */
function parseLog(out) {
  return String(out || "")
    .split("\x1e")
    .map((rec) => rec.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [subject = "", body = ""] = rec.split("\x1f");
      return { subject: subject.trim(), body: body.trim().length > 0 };
    })
    .filter((c) => c.subject);
}

/** A diff cut to `max` characters with every file given its share, so one big file can't leave the rest out. Pure. */
function fairCut(diff, max) {
  if (diff.length <= max) return diff;
  const per = diff.split(/^(?=diff --git )/m).filter(Boolean);
  const share = Math.max(300, Math.floor(max / Math.max(1, per.length)));
  const small = per.filter((d) => d.length <= share);
  const room = per.length > small.length ? Math.floor((max - small.reduce((n, d) => n + d.length, 0)) / (per.length - small.length)) : share;
  let left = max;
  let out = "";
  for (const d of per) {
    const take = Math.min(left, d.length <= share ? d.length : Math.max(share, room));
    if (take <= 0) break;
    out += d.length > take ? `${d.slice(0, take).replace(/\n[^\n]*$/, "")}\n… (rest of this file's diff cut)\n` : d;
    left -= take;
  }
  return out;
}

/** A file that isn't tracked yet, as the start of a "new file" diff, so the message can say what it is. Binary or huge files are only named. */
function newFileDiff(root, rel) {
  try {
    const full = path.join(root, rel);
    // lstat, not stat: a link to a file outside the repository is not the repository's, and its content is not sent.
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink() || !st.isFile()) return "";
    const head = `diff --git a/${rel} b/${rel}\nnew file\n`;
    if (st.size > 200000) return `${head}(too big to show)\n`;
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) return `${head}(binary file)\n`;
    const text = buf.toString("utf8").slice(0, MAX_NEW_FILE);
    return `${head}--- /dev/null\n+++ b/${rel}\n${text.split("\n").map((l) => `+${l}`).join("\n")}\n`;
  } catch {
    return "";
  }
}

/**
 * What the box is about: the staged changes, or (nothing staged) every change, untracked files included. `gitPath` is the git the
 * IDE found. Answers { staged, files, diff, log } or { error }.
 */
async function collect(gitPath, root) {
  const inside = await git(gitPath, root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside === null) return { error: "This folder isn't a git repository." };
  const stagedNames = await git(gitPath, root, ["diff", "--cached", "--name-status", "-z", "--no-renames"]);
  const staged = !!stagedNames && stagedNames.replace(/\0/g, "").trim().length > 0;
  let files;
  let diff;
  if (staged) {
    files = parseNameStatus(stagedNames);
    diff = (await git(gitPath, root, ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-renames", "-U3"])) || "";
  } else {
    // Against HEAD; a repository with no commit yet has no HEAD, so the working files against the index.
    const hasHead = (await git(gitPath, root, ["rev-parse", "--verify", "HEAD"])) !== null;
    const ref = hasHead ? ["HEAD"] : [];
    files = parseNameStatus((await git(gitPath, root, ["diff", ...ref, "--name-status", "-z", "--no-renames"])) || "");
    diff = (await git(gitPath, root, ["diff", ...ref, "--no-color", "--no-ext-diff", "--no-renames", "-U3"])) || "";
    const fresh = ((await git(gitPath, root, ["ls-files", "--others", "--exclude-standard", "-z"])) || "").split("\0").filter(Boolean).slice(0, 40);
    for (const rel of fresh) {
      files.push({ status: "added", path: rel });
      diff += newFileDiff(root, rel);
    }
  }
  const log = parseLog(await git(gitPath, root, ["log", "-30", "--no-color", "--format=%s%x1f%b%x1e"]));
  return { staged, files: files.slice(0, MAX_FILES), diff: fairCut(diff, MAX_DIFF), log };
}

/** The ask to Friday for what `collect` found. */
function messageAsk(root, found) {
  return { root, staged: found.staged, files: found.files, diff: found.diff, log: found.log };
}

async function askFriday(body) {
  const base = process.env.FRIDAY_URL;
  const token = process.env.FRIDAY_VSCODE_TOKEN;
  if (!base || !token) throw new Error("Friday is not connected to this editor. Reopen Code in Friday.");
  const res = await fetch(`${base.replace(/\/+$/, "")}/api/vscode/commit-message`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-friday-vscode": token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Friday answered ${res.status}`);
  return json;
}

/** The repository a command was run for: the source control it came from, else the first open one. */
function repoFor(api, arg) {
  const repos = (api && api.repositories) || [];
  const at = arg && (arg.rootUri || (arg.fsPath ? arg : null));
  const fs0 = at && (at.fsPath || "");
  return repos.find((r) => fs0 && r.rootUri && r.rootUri.fsPath === fs0) || repos[0] || null;
}

/** What to tell the person once the box is filled: where the words came from, so a plain summary isn't taken for a model's. */
function doneNote(answer) {
  if (answer.source === "tool") return `✳ Written by ${answer.tool || "your coding tool"}${answer.chat ? " from the chat's reason" : ""}. Read it, then Commit.`;
  // The longer reason (answer.note) is a notice beside it; the status bar keeps to a short line.
  return "✳ A plain summary, no coding tool wrote it. Read it, then Commit.";
}

function register(vscode, context, roots) {
  // One ask at a time: a second press while the first is being written does nothing but say so.
  let busy = false;
  const run = async (arg) => {
    if (busy) return void vscode.window.showInformationMessage("Still writing the message. One moment.");
    busy = true;
    try {
      await go(arg);
    } finally {
      busy = false;
    }
  };
  const go = async (arg) => {
    let api = null;
    try {
      const ext = vscode.extensions && vscode.extensions.getExtension && vscode.extensions.getExtension("vscode.git");
      api = ext ? (ext.isActive ? ext.exports : await ext.activate()).getAPI(1) : null;
    } catch {
      return void vscode.window.showInformationMessage("The Git tools are switched off in this IDE, so there is no commit box to fill. Turn them on, then try again.");
    }
    const repo = repoFor(api, arg);
    const root = (repo && repo.rootUri && repo.rootUri.fsPath) || (roots()[0] || "");
    if (!root) return void vscode.window.showInformationMessage("Open a folder with changes first, then write its message.");
    const found = await collect(api && api.git && api.git.path, root);
    if (found.error) return void vscode.window.showInformationMessage(found.error);
    if (!found.files.length) return void vscode.window.showInformationMessage("There are no changes to write a message about.");
    const work = async () => {
      try {
        return await askFriday(messageAsk(root, found));
      } catch (e) {
        vscode.window.showErrorMessage(`Could not write the message: ${e && e.message ? e.message : e}`);
        return null;
      }
    };
    const answer = vscode.window.withProgress ? await vscode.window.withProgress({ location: vscode.ProgressLocation && vscode.ProgressLocation.SourceControl, title: "✳ Writing the commit message…" }, work) : await work();
    if (!answer || !answer.message) {
      if (answer && answer.note) vscode.window.showInformationMessage(answer.note);
      return;
    }
    const box = repo && repo.inputBox;
    if (!box) return void vscode.window.showInformationMessage(answer.message);
    // A message already typed is the person's: replaced only when they say so.
    if (box.value && box.value.trim() && box.value.trim() !== answer.message.trim()) {
      const pick = await vscode.window.showInformationMessage("Replace the message you started with the one Friday wrote?", "Replace", "Keep mine");
      if (pick !== "Replace") return;
    }
    box.value = answer.message;
    vscode.window.setStatusBarMessage(doneNote(answer), 8000);
    if (answer.source !== "tool" && answer.note) vscode.window.showInformationMessage(answer.note);
    // The git view's own focus command: the box itself, so the person can edit before pressing Commit.
    vscode.commands.executeCommand("workbench.scm.focus").then(undefined, () => {});
  };
  context.subscriptions.push(vscode.commands.registerCommand("friday.writeCommitMessage", run));
}

module.exports = { register, collect, fairCut, parseNameStatus, parseLog, messageAsk, repoFor, doneNote, newFileDiff };
