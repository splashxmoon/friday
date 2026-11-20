import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { afterExit, BACKOFF_MS, composeServices, detectServers, MAX_TRIES, portInCommand, STABLE_MS } from "../src/dev-servers.js";

const require = createRequire(import.meta.url);
const dir = path.resolve(import.meta.dirname, "..", "src", "vscode-ext", "friday");
const parse = require(path.join(dir, "servers-parse.js"));
const pkg = require(path.join(dir, "package.json"));

const ids = (d: { id: string }[]) => d.map((x) => x.id);

test("scripts: dev, start, serve and preview are servers, in that order; build and test are not", () => {
  const d = detectServers({ packageJson: JSON.stringify({ scripts: { test: "x", start: "node a", build: "x", dev: "vite --port 5173", serve: "http-server" } }) });
  assert.deepEqual(ids(d), ["script:dev", "script:start", "script:serve"]);
  assert.equal(d[0]!.command, "npm run dev");
  assert.equal(d[0]!.port, 5173);
});

test("the package manager follows the lock file", () => {
  const pj = JSON.stringify({ scripts: { dev: "next dev" } });
  assert.equal(detectServers({ packageJson: pj, locks: ["pnpm-lock.yaml"] })[0]!.command, "pnpm run dev");
  assert.equal(detectServers({ packageJson: pj, locks: ["yarn.lock"] })[0]!.command, "yarn run dev");
});

test("a broken or empty package.json declares nothing", () => {
  assert.deepEqual(detectServers({ packageJson: "{nope" }), []);
  assert.deepEqual(detectServers({ packageJson: JSON.stringify({ scripts: { dev: "" } }) }), []);
  assert.deepEqual(detectServers({ packageJson: JSON.stringify({ scripts: null }) }), []);
  assert.deepEqual(detectServers({}), []);
});

test("Procfile: each process is a server except release steps, comments are skipped", () => {
  const d = detectServers({ procfile: "# processes\nweb: node server.js --port 4000\nworker: node worker.js\nrelease: node migrate.js\n" });
  assert.deepEqual(ids(d), ["proc:web", "proc:worker"]);
  assert.equal(d[0]!.port, 4000);
  assert.equal(d[0]!.command, "node server.js --port 4000");
});

test("compose: services and their first published port, short and long forms", () => {
  const yml = `version: "3"
services:
  web:
    build: .
    ports:
      - "3000:3000"
      - "9229:9229"
  db:
    image: postgres
    ports:
      - 127.0.0.1:5432:5432/tcp
  api:
    image: x
    ports:
      - target: 80
        published: 8080
  worker:
    image: y # no ports
volumes:
  data:
`;
  assert.deepEqual(composeServices(yml), [{ name: "web", port: 3000 }, { name: "db", port: 5432 }, { name: "api", port: 8080 }, { name: "worker" }]);
  const d = detectServers({ compose: yml });
  assert.equal(d[0]!.command, "docker compose up web");
  assert.deepEqual(ids(d), ["compose:web", "compose:db", "compose:api", "compose:worker"]);
});

test("ports named in a command", () => {
  assert.equal(portInCommand("vite --port=5174"), 5174);
  assert.equal(portInCommand("next dev -p 3001"), 3001);
  assert.equal(portInCommand("PORT=8081 node s.js"), 8081);
  assert.equal(portInCommand("node s.js"), undefined);
  assert.equal(portInCommand("x --port 99999"), undefined);
});

test("crash and backoff: three restarts with growing waits, then it gives up and says so", () => {
  let tries = 0;
  const waits: number[] = [];
  for (let i = 1; i <= MAX_TRIES; i++) {
    const v = afterExit({ tries, ranMs: 500, stoppedByUser: false, code: 1 });
    assert.equal(v.phase, "restarting");
    assert.equal(v.try, i);
    assert.match(v.say, new RegExp(`try ${i} of ${MAX_TRIES}`));
    waits.push(v.delayMs!);
    tries = v.tries;
  }
  assert.deepEqual(waits, BACKOFF_MS);
  const last = afterExit({ tries, ranMs: 500, stoppedByUser: false, code: 1 });
  assert.equal(last.phase, "crashed");
  assert.match(last.say, /gave up after 3 restarts/);
});

test("a server that stayed up a while before it fell over starts the count again", () => {
  const v = afterExit({ tries: 3, ranMs: STABLE_MS + 1, stoppedByUser: false, code: 137 });
  assert.equal(v.phase, "restarting");
  assert.equal(v.tries, 1);
});

test("stopping it on purpose is never a crash; a clean end by itself is left ended; a signal is a crash", () => {
  assert.equal(afterExit({ tries: 2, ranMs: 10, stoppedByUser: true, code: null, signal: "SIGTERM" }).phase, "stopped");
  assert.equal(afterExit({ tries: 0, ranMs: 10, stoppedByUser: false, code: 0 }).phase, "stopped");
  const sig = afterExit({ tries: 0, ranMs: 10, stoppedByUser: false, code: null, signal: "SIGSEGV" });
  assert.equal(sig.phase, "restarting");
  assert.match(sig.say, /signal SIGSEGV/);
});

test("the IDE's words: status bar, list, notices", () => {
  const web = { id: "script:dev", name: "web", kind: "script", command: "npm run dev", phase: "running", port: 3000, tries: 0 };
  assert.deepEqual(parse.statusWords([web], []), { icon: "circle-filled", text: ":3000 web", state: "up" });
  assert.equal(parse.statusWords([web, { ...web, id: "b", name: "api", port: 4000 }], []).text, ":3000 web +1");
  assert.equal(parse.statusWords([{ ...web, phase: "stopped" }], []).text, "no server");
  assert.equal(parse.statusWords([{ ...web, phase: "restarting", tries: 1 }], []).text, "web restarting");
  assert.equal(parse.statusWords([{ ...web, phase: "crashed" }], []).state, "crashed");
  assert.equal(parse.statusWords([], [{ port: 5000 }]).text, ":5000");
  assert.equal(parse.describe({ ...web, phase: "restarting", tries: 2 }), "crashed · restarting, try 2 of 3");
  assert.equal(parse.describe(web), ":3000 · running");

  const down = { ...web, phase: "restarting", tries: 1 };
  assert.deepEqual(parse.notices([web], [down], false), []);
  assert.equal(parse.notices([web], [down], true)[0].kind, "restarting");
  assert.deepEqual(parse.notices([down], [down], true), []);
  assert.equal(parse.notices([down], [{ ...down, tries: 2 }], true).length, 1);
  assert.equal(parse.notices([down], [{ ...web, phase: "crashed" }], true)[0].kind, "crashed");
  // A restart that came and went between two looks is still said, from the note; a worker has no port to show.
  const back = { ...web, tries: 1, note: "Back up after 1 restart." };
  assert.match(parse.notices([web], [back], true)[0].text, /web is back up after 1 restart/);
  assert.equal(parse.notices([back], [back], true).length, 0);
  assert.equal(parse.statusWords([{ ...web, port: null, name: "worker" }], []).text, "worker");
  assert.equal(parse.describe({ ...web, port: null }), "running");
  // The same script in two folders is two servers.
  assert.equal(parse.notices([{ ...web, root: "/a" }, { ...web, root: "/b" }], [{ ...down, root: "/a" }, { ...web, root: "/b" }], true).length, 1);
  assert.ok(parse.nextDelay([down]) < parse.nextDelay([web]) && parse.nextDelay([web]) < parse.nextDelay([]));
});

test("the extension declares the Servers view, its commands and its menus", () => {
  assert.ok(pkg.contributes.views.friday.some((v: { id: string }) => v.id === "friday.servers"));
  const cmds = pkg.contributes.commands.map((c: { command: string }) => c.command);
  for (const c of ["start", "stop", "restart", "open", "openInIde", "logs", "refresh", "menu"]) assert.ok(cmds.includes(`friday.servers.${c}`), c);
  const inline = pkg.contributes.menus["view/item/context"].filter((m: { when: string }) => /friday\.servers/.test(m.when)).map((m: { command: string }) => m.command);
  for (const c of ["start", "stop", "restart", "open"]) assert.ok(inline.includes(`friday.servers.${c}`), c);
});
