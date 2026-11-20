"use strict";
// The Stack view in Friday's activity bar (Arun, 2026-11-19, wave 3: "Stacked PRs: split a big change into a stack of small PRs, each
// based on the last, kept rebased for you."): each stack of pull requests the folder has, its parts bottom first with the pull
// request's number, its checks, and how far it is from the part below, and Restack, which rebases each part onto the one below
// after the bottom one changed or merged. A conflict stops it and is handed to the agent. Everything is read and done by Friday
// (/api/vscode/stack, src/runner/stack-pr.ts): the view only draws it. Plain CommonJS; the vscode API is passed in.

/** The stacks of a folder and where each part stands, as Friday says; {stacks: [], error} when it can't say. */
async function fetchStatus(root) {
  const base = process.env.FRIDAY_URL;
  const token = process.env.FRIDAY_VSCODE_TOKEN;
  if (!base || !token || !root) return { stacks: [] };
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/vscode/stack?root=${encodeURIComponent(root)}`, { headers: { "x-friday-vscode": token } });
    if (!res.ok) return { stacks: [], error: `Friday answered ${res.status}` };
    const body = await res.json();
    return { stacks: Array.isArray(body.stacks) ? body.stacks : [], ...(body.error ? { error: String(body.error) } : {}) };
  } catch (e) {
    return { stacks: [], error: e && e.message ? e.message : String(e) };
  }
}

/** Restack one stack (by its id) or every stack of the folder. */
async function postRestack(root, id) {
  const base = process.env.FRIDAY_URL;
  const token = process.env.FRIDAY_VSCODE_TOKEN;
  if (!base || !token) return { ok: false, error: "Friday is not connected to this editor. Reopen Code in Friday." };
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/vscode/stack`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-friday-vscode": token },
      body: JSON.stringify({ root, ...(id ? { id } : {}) }),
    });
    if (!res.ok) return { ok: false, error: `Friday answered ${res.status}` };
    return await res.json();
  } catch (e) {
    return { ok: false, error: `Could not reach Friday: ${e && e.message ? e.message : e}` };
  }
}

/** "feat-1" is the stack "feat": the name a stack goes by in the view. */
const stackName = (s) => String(s.id || "").replace(/-\d+$/, "") || "Stack";

/** The words for what a restack came to, from its answer. Pure, so it is tested without an IDE. */
function restackSummary(r) {
  const parts = r.parts || [];
  const rebased = parts.filter((p) => p.did === "rebased").length;
  const merged = parts.filter((p) => p.did === "merged").length;
  const bits = [];
  if (rebased) bits.push(`${rebased} part${rebased === 1 ? "" : "s"} rebased`);
  else bits.push("every part already sits on the one below");
  if (merged) bits.push(`${merged} merged and left out`);
  const pushed = parts.filter((p) => p.pushed).length;
  if (pushed) bits.push(`${pushed} pushed`);
  return `Restacked onto ${r.base || "the base branch"}: ${bits.join(", ")}. Your own branch isn't touched.`;
}

/** The icon for a part: merged, closed, checks failing / running / passing, else a plain pull request. Pure over the status row. */
function partIcon(p) {
  if (p.state === "merged") return { id: "git-merge", color: "charts.purple" };
  if (p.state === "closed") return { id: "git-pull-request-closed", color: "charts.red" };
  if (!p.pr && !p.pushed) return { id: "cloud-upload" };
  if (p.checks === "fail") return { id: "error", color: "testing.iconFailed" };
  if (p.checks === "pending") return { id: "loading~spin", color: "charts.yellow" };
  if (p.checks === "pass") return { id: "pass", color: "testing.iconPassed" };
  return { id: p.pr ? "git-pull-request" : "git-branch" };
}

function register(context, vscode, { postAsk, roots }) {
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  if (!vscode.window.createTreeView || !vscode.EventEmitter) {
    for (const id of ["friday.showStack", "friday.refreshStack", "friday.restack", "friday.openStackPr"]) reg(id, () => vscode.window.showInformationMessage("The Stack view isn't available in this window."));
    return;
  }
  const changed = new vscode.EventEmitter();
  /** [{root, stacks}] as last read; the tree is drawn from it. */
  let state = [];
  let view;
  /** What went wrong reading each folder: with several folders, the first one's trouble isn't hidden by the last one's answer. */
  let errors = [];
  // Said only when it changes: the IDE redraws Friday's side bar on each, and a redraw mid-fold of another view throws in it.
  let hasShown = null;
  const setContext = (v) => {
    if (v === hasShown) return;
    hasShown = v;
    void vscode.commands.executeCommand("setContext", "friday.hasStack", v);
  };

  const read = async () => {
    const folders = roots();
    const next = [];
    const errs = [];
    for (const root of folders) {
      const r = await fetchStatus(root);
      if (r.error) errs.push(folders.length > 1 ? `${String(root).split(/[\\/]/).filter(Boolean).pop() || root}: ${r.error}` : r.error);
      next.push({ root, stacks: r.stacks });
    }
    errors = errs;
    return next;
  };
  const refresh = async () => {
    state = await read();
    const all = state.flatMap((x) => x.stacks);
    setContext(all.length > 0);
    if (view) {
      const behind = all.flatMap((s) => s.parts.map((p, i) => ({ s, p, i }))).filter((x) => x.p.state !== "merged" && x.p.behind > 0);
      // The first part still open sits on the base branch; every other on the part before it.
      const first = behind[0] && behind[0].s.parts.findIndex((p) => p.state !== "merged") === behind[0].i ? `behind ${behind[0].s.base}` : "behind the part below it";
      view.message = errors.length ? `Couldn't read the stack: ${errors.join("; ")}` : behind.length ? `Part ${behind[0].i + 1} is ${first}. Restack brings it up to date.` : undefined;
      view.badge = behind.length ? { value: behind.length, tooltip: `${behind.length} behind` } : undefined;
    }
    changed.fire();
  };

  const provider = {
    onDidChangeTreeData: changed.event,
    getChildren(el) {
      if (!el) return state.flatMap((x) => x.stacks.map((s) => ({ kind: "stack", root: x.root, s })));
      if (el.kind === "stack") return el.s.parts.map((p, i) => ({ kind: "part", root: el.root, s: el.s, p, i }));
      return [];
    },
    getTreeItem(el) {
      if (el.kind === "stack") {
        const item = new vscode.TreeItem(stackName(el.s), vscode.TreeItemCollapsibleState.Expanded);
        item.id = `stack-${el.root}-${el.s.id}`;
        const open = el.s.parts.filter((p) => p.state !== "merged").length;
        item.description = `${el.s.parts.length} part${el.s.parts.length === 1 ? "" : "s"} · onto ${el.s.base}${open < el.s.parts.length ? ` · ${el.s.parts.length - open} merged` : ""}`;
        item.contextValue = "friday.stack";
        if (vscode.ThemeIcon) item.iconPath = new vscode.ThemeIcon("repo");
        item.tooltip = `${el.s.parts.length} pull requests, each based on the one before. The first merges into ${el.s.base}.`;
        return item;
      }
      const { p, i, s } = el;
      // The branch is the label and what matters (pull request, checks, behind) leads the description, so a narrow side bar cuts the
      // title, never the state.
      const item = new vscode.TreeItem(`${i + 1}  ${p.branch}`, vscode.TreeItemCollapsibleState.None);
      item.id = `part-${el.root}-${s.id}-${p.branch}`;
      item.description = [p.detail, p.title].filter(Boolean).join(" · ");
      item.contextValue = p.url ? "friday.stackPart.pr" : "friday.stackPart";
      const icon = partIcon(p);
      if (vscode.ThemeIcon) item.iconPath = icon.color && vscode.ThemeColor ? new vscode.ThemeIcon(icon.id, new vscode.ThemeColor(icon.color)) : new vscode.ThemeIcon(icon.id);
      const checks = { pass: "Checks passing", fail: "Checks failing", pending: "Checks running", none: "No checks" }[p.checks];
      item.tooltip = [`Part ${i + 1} of ${s.parts.length}: ${p.title}`, `Branch ${p.branch}${p.current ? " (checked out here)" : ""}`, p.pr && p.state !== "merged" ? checks : "", p.state !== "merged" ? `${p.ahead} ahead, ${p.behind} behind ${i === 0 || s.parts.slice(0, i).every((x) => x.state === "merged") ? s.base : "the part below"}${p.behind > 0 ? ": Restack brings it up to date." : "."}` : "", p.url].filter(Boolean).join("\n");
      if (p.url) item.command = { command: "friday.openStackPr", title: "Open the pull request", arguments: [el] };
      return item;
    },
  };
  view = vscode.window.createTreeView("friday.stack", { treeDataProvider: provider, showCollapseAll: false });
  view.title = "Stack";
  context.subscriptions.push(view, changed);

  let timer;
  const tick = async () => {
    clearTimeout(timer);
    await refresh();
    // Slow: gh is asked for each part's pull request. Faster only while the view is on screen.
    timer = setTimeout(tick, view.visible ? 60_000 : 5 * 60_000);
  };
  void tick();
  context.subscriptions.push({ dispose: () => clearTimeout(timer) }, view.onDidChangeVisibility((e) => e.visible && void tick()));
  if (vscode.window.onDidChangeWindowState) context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => s.focused && view.visible && void tick()));

  let restacking = false;
  reg("friday.restack", async (node) => {
    if (restacking) return;
    const targets = node && node.kind === "stack" ? [{ root: node.root, id: node.s.id }] : node && node.root ? [{ root: node.root, id: node.s.id }] : state.filter((x) => x.stacks.length).map((x) => ({ root: x.root, id: "" }));
    if (!targets.length) return void vscode.window.showInformationMessage("There is no stack here to restack.");
    restacking = true;
    try {
      for (const t of targets) {
        const run = () => postRestack(t.root, t.id);
        const r = vscode.window.withProgress && vscode.ProgressLocation ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Restacking" }, run) : await run();
        await refresh();
        if (r.ok) {
          vscode.window.showInformationMessage(restackSummary(r));
        } else if (r.conflict) {
          const c = r.conflict;
          const files = (c.files || []).slice(0, 3).join(", ");
          const pick = await vscode.window.showWarningMessage(`Part ${c.part} of ${c.total} conflicts with the part below it${files ? ` in ${files}` : ""}. Nothing was changed on it, and your own branch is untouched.`, "Hand to the agent");
          if (pick === "Hand to the agent") await postAsk({ kind: "restack", path: "", from: 1, to: 1, text: "", root: t.root, problem: c.handoff, source: "the stack" });
          break;
        } else {
          vscode.window.showErrorMessage(r.error || "The restack didn't finish.");
          break;
        }
      }
    } finally {
      restacking = false;
    }
  });
  reg("friday.refreshStack", () => void tick());
  reg("friday.openStackPr", (el) => {
    const url = el && el.p && el.p.url;
    if (typeof url === "string" && /^https:\/\//.test(url) && vscode.env && vscode.env.openExternal && vscode.Uri) void vscode.env.openExternal(vscode.Uri.parse(url));
  });
  reg("friday.showStack", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.friday");
    await vscode.commands.executeCommand("friday.stack.focus");
    void tick();
  });
  return { refresh, restackSummary };
}

module.exports = { register, fetchStatus, restackSummary, partIcon, stackName };
