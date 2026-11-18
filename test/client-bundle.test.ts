// What every first screen downloads before it can draw: app.js and the chunks it imports statically (the eager closure), built
// as the production build builds it. The Markdown and motion stack behind an answer (~300 KB packed) once slipped into it through
// one static import (Teammates.tsx -> message.tsx), doubling the first load between Oct 22 and Nov 4 2026 (327 -> 637 KB
// brotli). These keep it out, and keep the whole first load under a budget. Re-measure in detail: engineering/PERF.md.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { brotliCompressSync, constants } from "node:zlib";
import { build, type Metafile } from "esbuild";
import { clientBuildOptions } from "../src/client-build.js";

type Load = { kb: number; modules: string[] };

/**
 * Brotli KB and modules of app.js's eager closure (`first`), and of that with the session screen's chunk and its static imports
 * (`session`: what a session link waits on), for one edition.
 */
async function loads(edition: "hosted" | "local"): Promise<{ first: Load; session: Load }> {
  const was = process.env.FRIDAY_EDITION;
  if (edition === "local") process.env.FRIDAY_EDITION = "local";
  else delete process.env.FRIDAY_EDITION;
  try {
    const out = path.resolve("desktop/.bundle-test");
    const r = await build({ ...clientBuildOptions(out, false), metafile: true, write: false });
    const rel = (p: string) => path.relative(out, path.resolve(p));
    const outputs = new Map<string, Metafile["outputs"][string]>(Object.entries(r.metafile!.outputs).map(([k, v]) => [rel(k), v]));
    const files = new Map(r.outputFiles!.map((f) => [path.relative(out, f.path), f.contents]));
    const closure = (from: string[]): Load => {
      const seen = new Set<string>();
      const walk = (p: string) => {
        if (seen.has(p)) return;
        seen.add(p);
        for (const i of outputs.get(p)?.imports ?? []) if (i.kind === "import-statement") walk(rel(i.path));
      };
      from.forEach(walk);
      let bytes = 0;
      const modules = new Set<string>();
      for (const p of seen) {
        bytes += brotliCompressSync(files.get(p)!, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
        for (const m of Object.keys(outputs.get(p)!.inputs)) modules.add(m);
      }
      return { kb: bytes / 1024, modules: [...modules] };
    };
    const sessionChunk = [...outputs].find(([k, v]) => k.endsWith(".js") && v.entryPoint?.endsWith("client/SessionView.tsx"))?.[0];
    assert.ok(sessionChunk, "the session screen is a chunk of its own");
    return { first: closure(["app.js"]), session: closure(["app.js", sessionChunk!]) };
  } finally {
    if (was === undefined) delete process.env.FRIDAY_EDITION;
    else process.env.FRIDAY_EDITION = was;
  }
}

// Each loads with the session screen (or later), never with the app itself.
const LATER = [/node_modules\/streamdown\//, /node_modules\/parse5\//, /node_modules\/marked\//, /node_modules\/framer-motion\//, /node_modules\/katex\//, /node_modules\/@codemirror\//, /src\/client\/AnswerParts\.tsx$/, /src\/client\/Activity\.tsx$/, /src\/client\/Settings\.tsx$/, /node_modules\/qrcode-generator\//, /src\/client\/(TeammatePage|TeamBrief|CrewSkills|RunReview)\.tsx$/];

for (const edition of ["hosted", "local"] as const) {
  test(`${edition}: the first load has no answer rendering, motion, editor or Settings page in it, a session's has no CodeMirror, and both stay under budget`, async (t) => {
    const { first, session } = await loads(edition);
    const { kb, modules } = first;
    t.diagnostic(`app.js first load: ${kb.toFixed(1)} KB brotli, ${modules.length} modules; with the session screen ${session.kb.toFixed(1)} KB`);
    for (const re of LATER) assert.deepEqual(modules.filter((m) => re.test(m)).slice(0, 3), [], `${re} is in app.js's first load: import it lazily (see lazy-answer.tsx)`);
    // Brotli at the build's quality 11 (src/pack-built.ts). Nov 5 2026: 427 KB hosted and local (443 before the teammate page, team
    // brief, skills and run review left it). Raise it only on purpose. Nov 9 2026: 444.8 hosted, 446.4 local (444.4 before), with
    // voice input's mic and key in the home box (VoiceMic.tsx, ~2 KB; its engine and the model's worker load at the first press):
    // raised to 448 on purpose. Nov 10 2026: 446.8 hosted, 448.7 local (447.9 before), with Qwen's own mark in place of a bot
    // (BrandMarks.tsx, one path of ~1.9 KB, shown wherever a tool is named; Arun: "use this for the qwen code icon"), the sign-in
    // notes and the ACP registry already moved to chunks of their own: raised to 450 on purpose. Nov 11 2026: 449.2 hosted, 450.8
    // local (448.5 and 450.1 before 3A), with the production sidebar's rail and agents list in the open-source build (Sidebar.tsx
    // OssRail, AgentsSection) and a lead's hand-outs as one line (Teammates.tsx TeamTalk); the Agents page, crew setup and the
    // plan are chunks of their own, and the plain words for a teammate's ask stay with the Agents page: raised to 452 on purpose.
    // Nov 13 2026: 450.7 hosted, 452.4 local (448.9 and 450.6 before), with Code and Crew, connected in a coding session's box: your
    // crew in Add an agent, "@Kit" and "@Checkout" with their faces and colours, Keep this going from a run and a row (crew-at.tsx,
    // mention-tint.tsx); the hand-off lines, the sheet and the fetches load on their own: raised to 454 on purpose; to 456 for the crew typing in the chat and a room's own folders (2026-11-15); to 458 for the menu bar's own page (its entry beside the app's) and the permissions' marks (2026-11-16); to 459 for the "@" list
    // in a session's box following the crew live, a crew mate or room taken away never offered (crew-at.tsx useCrewTargets; 458.1
    // local, 2026-11-16); to 461 for a room's Project and its repo picker (RoomProject.tsx, and Workspace.tsx RepoPicker, the
    // folder picker refined for repos; 460.3 local, 2026-11-17: a chunk of its own measured 0.4 KB worse, so it stays); to 462 for
    // the room's branch picker and the session list folding for the side panel in a small window (list-yield.ts; 461.1 local,
    // 2026-11-17); to 467 for the rail's limit rings and each tool's accounts on them and in their card (gauge.tsx RailRing,
    // account-glance.tsx; Accounts.tsx useAccountActions) and Deep Dive's finder (465.7 local, 2026-11-17: loading the card and the
    // finder on their own measured no smaller, so they stay); to 468 for a room's Project as a folder too (the picker's Folders,
    // RoomProject.tsx) and a thread laid out as a chat of its own (Teammates.tsx ThreadPanel; 467.5 local, 2026-11-17); to 470 for
    // hand-offs to a crew mate's page (Teammates.tsx, +1.0 KB raw), no tooltip left up after a press (Tooltips.tsx, +0.5) and the
    // sidebar's (+0.3): 468.2 local, 2026-11-18, from 467.45 at 324de1e0; no one piece is big enough to be worth loading later.
    // To 473 for the compact model picker (its rail, favourites, your keys and local models, the plan and effort rows; the
    // composer's picker is on the first screen) and Muse Code's own mark: 471.6 local, 2026-11-18.
    assert.ok(kb < 473, `app.js and its static imports are ${kb.toFixed(0)} KB brotli, over the 473 KB budget`);
    // A session link waits on the session screen too: CodeMirror (~150 KB packed) loads with the first file opened, not here
    // (mirror-editor.tsx). Nov 4 2026, merged with build/e2e-hardening: 890 KB hosted (1,048 KB before; Oct 22: 710 KB).
    assert.deepEqual(session.modules.filter((m) => /node_modules\/@codemirror\//.test(m)).slice(0, 3), [], "CodeMirror is in the session screen's first load: keep it in mirror-editor.tsx, loaded lazily");
    // Nov 8 2026: 922 KB hosted, 919 local, with the folder picker's sources and rows (Workspace.tsx, 0.2.19): raised to 930 on purpose.
    // Nov 11 2026: 934.6 hosted, 931.8 local (930.6 and 927.6 before), with a crew chat's folded steps, result card and plain-words
    // permission card (Activity.tsx; a chunk of their own saved 0.3 KB and flashed the old card while it loaded): raised to 936.
    // Nov 11 2026, later: 936.0 hosted, 933.4 local, with a run's NO_UPDATE said in words and a lead's hand-out lines able to move a
    // piece (Activity.tsx, AgentTalk.tsx); the plan and its actions load on their own: raised to 940 on purpose.
    // Nov 13 2026: 941.5 hosted, 938.7 local (936.5 and 933.6 before), with the same: raised to 943 on purpose.
    // Nov 13 2026, the Friday Teams port (Code and Crew connected, the allowlist read as a shell reads it): 944.5 hosted, 941.6
    // local, with the 16 KB allowlist loaded at the first card that offers Always allow rather than here: raised to 946 on purpose.
    // Nov 14 2026, the session screen matched to Friday Teams: 947.9 hosted, 945.3 local (944.2 and 941.3 before), with one agent
    // state for every view and plain-words errors (agent-state.ts) and the status bar's agent list; the row's words (agent-line.ts)
    // stay in the first load without the rest, and the crew's rows in the list load when it opens: raised to 949 on purpose.
    // Nov 15 2026: 949.8 hosted, 947.2 local, with a crew mate's chat as a teammate's: the line its crew work folds to, its threads
    // found by session, and "This chat" opened as it makes something (Activity.tsx, Teammates.tsx); the panel and the thread strip
    // load on their own (ChatPanel.tsx, TeammatePage.tsx): raised to 952 on purpose; to 956 for room replies drawn as a crew mate's chat draws them and Friday's own time field; to 962 for crew replies as chat messages (their files as cards, typing in the chat) and the crew's Browser tab; to 966 for the crew's audit (claims checked, quiet and why lines, Do this again) (2026-11-15); to 968 for the side panel's merge of Git into Changes and its opening by itself after a turn (the Pull request panel loads on its own) (2026-11-16); to 972 for several agents in one thread (the team card, the done row and the take-over line load on their own, only in a thread with two or more agents; the team's grouping, @all and @idle stay) (2026-11-16); to 976 for the thread card (it loads on its own; the environment panel it shares with the session screen becomes a chunk of its own, which packs a little worse) (2026-11-16); to 980 for a team put to you before it starts, @all and @idle, starting a thread from an issue, a pull request or a branch, and a done agent's proof on its row (each card loads on its own; their wiring stays) (2026-11-16); to 982 for the same room Project picker (980.3 hosted, 2026-11-17); to 987 for the same rail rings and accounts (985.9 hosted, 2026-11-17); to 989 for the crew's working line (986.7 hosted) and the MCP servers page, whose controls it shares move a chunk the session screen loads (988.5 hosted, 2026-11-17); to 991 for the crew talking in a room as a group chat (crew-talk.tsx), the coding session's working line and an agent's question in the chat as quick replies (decision-card.tsx; 989.3 hosted, 2026-11-17); to 992 once a thread's chat layout left it at 991.0 hosted and the MCP directory's Cloudflare addresses moved from /sse to /mcp, which packs 0.1 KB differently (991.1 hosted, 2026-11-17); to 993 for the subagents card's stop mark, code in reports and its tray there only while one works (992.1 hosted, 2026-11-17); to 995 for pictures from coding tools in the chat (a step's pictures in a row, picture paths in the words shown, the Lightbox going between several; 993.6 hosted, 2026-11-18); to 997 for pictures in the side panels (the file tree's viewer and a changed picture in Changes, its view loading on its own; 995.8 hosted, after 51655973's chat fixes had left it at 995.2, 2026-11-18); to 999 for the team's tasks in the side panel's Tasks tab with their controls: add, edit, move, assign, hold, mark done (TaskBoard.tsx, in place of the header's pill; 997.1 hosted, 2026-11-18).
    // To 1002 for the same compact model picker (1000.9 hosted, 2026-11-18).
    assert.ok(session.kb < 1002, `a session screen's first load is ${session.kb.toFixed(0)} KB brotli, over the 1002 KB budget`);
  });
}
