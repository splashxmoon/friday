// Two stand-ins for the GitHub CLI in one file, picked by what the test sets:
// - FAKE_GH_DIR (CI in the IDE, Arun, 2026-11-19, wave 3): answers from files in that folder, so a spec can turn a check from running
//   to failed, or take the pull request away, while it runs: pr.json (gh pr view), checks.json (gh pr checks, exit 8 on a failure),
//   log-<job>.txt (gh run view --job <job> --log-failed).
// - FAKE_GH_STATE (stacked pull requests): keeps its pull requests and every call it was given in that JSON file, and answers the
//   few calls Friday makes: auth status, pr create, pr edit, pr view.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

if (process.env.FAKE_GH_DIR) {
  const dir = process.env.FAKE_GH_DIR || "";
  const args = process.argv.slice(2);
  if (dir) appendFileSync(path.join(dir, "calls.log"), `${args.join(" ")}\n`);
  const read = (name) => (dir && existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), "utf8") : null);

  if (args[0] === "pr" && args[1] === "view") {
    const pr = read("pr.json");
    if (pr === null) {
      process.stderr.write('no pull requests found for branch "refunds"\n');
      process.exit(1);
    }
    process.stdout.write(pr);
  } else if (args[0] === "pr" && args[1] === "checks") {
    const checks = read("checks.json") ?? "[]";
    process.stdout.write(checks);
    process.exit(JSON.parse(checks).some((c) => c.bucket === "fail") ? 8 : 0);
  } else if (args[0] === "run" && args[1] === "view") {
    const job = args[args.indexOf("--job") + 1];
    const log = read(`log-${job}.txt`);
    if (log === null) {
      process.stderr.write("no log\n");
      process.exit(1);
    }
    process.stdout.write(log);
  } else {
    process.stderr.write(`fake gh: not handled: ${args.join(" ")}\n`);
    process.exit(1);
  }
} else {
  const file = process.env.FAKE_GH_STATE;
  const args = process.argv.slice(2);
  // The Stack view asks about every part at once: a read can land beside another call's write, so a write is a rename and a torn read is tried again.
  const load = () => {
    for (let i = 0; i < 20; i++) {
      try {
        return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { prs: [], calls: [] };
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    return { prs: [], calls: [] };
  };
  const state = load();
  // One line per call, with the body's text (a file when the call ends), so a test can read what was said.
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const body = flag("--body-file") && existsSync(flag("--body-file")) ? readFileSync(flag("--body-file"), "utf8") : undefined;
  state.calls.push({ args, ...(body !== undefined ? { body } : {}) });
  const save = () => {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, file);
  };
  const find = (x) => state.prs.find((p) => p.url === x || String(p.number) === String(x) || p.head === x);
  const fail = (msg) => {
    save();
    process.stderr.write(msg + "\n");
    process.exit(1);
  };

  if (args[0] === "auth") {
    if (process.env.FAKE_GH_AUTH === "no") fail("You are not logged into any GitHub hosts.");
    save();
  } else if (args[0] === "pr" && args[1] === "create") {
    const number = state.prs.length + 1;
    const url = `https://github.com/acme/widgets/pull/${number}`;
    state.prs.push({ number, url, head: flag("--head"), base: flag("--base"), title: flag("--title"), body, state: "OPEN", checks: [{ status: "COMPLETED", conclusion: "SUCCESS" }] });
    save();
    console.log(url);
  } else if (args[0] === "pr" && args[1] === "edit") {
    const pr = find(args[2]);
    if (!pr) fail("no pull request found");
    if (flag("--base")) pr.base = flag("--base");
    if (body !== undefined) pr.body = body;
    save();
  } else if (args[0] === "pr" && args[1] === "view") {
    const pr = find(args[2]);
    if (!pr) fail("no pull requests found for branch");
    save();
    console.log(JSON.stringify({ number: pr.number, state: pr.state, url: pr.url, statusCheckRollup: pr.checks, baseRefName: pr.base }));
  } else {
    fail(`fake gh: unknown call ${args.join(" ")}`);
  }
}
