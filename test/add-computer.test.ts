// An extra machine, easily (src/local/add-computer.ts; Arun, 2026-11-03: "also look into easy extra machine running too").
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { joinCommand, joinScript, joinSshResult, JOIN_LINK, sshConfigHosts } from "../src/local/add-computer.js";

const FP = "c38d7ba5c746ae731600a41ef637316756ff17587f4fe6934c94fd5c75bb559f";
const LINK = `friday://computer?${new URLSearchParams({ h: "192.168.1.180,100.88.1.2", p: "55214", c: "7WYNQBCA", s: "https", n: "Maya’s MacBook Pro", f: FP })}`;

test("one command to paste on the other machine, quoted for its shell; a link that could end the quote is refused", () => {
  assert.ok(JOIN_LINK.test(LINK), LINK);
  assert.deepEqual(joinCommand(LINK), { unix: `npx -y github:splashxmoon/friday --join '${LINK}'`, windows: `npx -y github:splashxmoon/friday --join "${LINK}"` });
  assert.throws(() => joinCommand("friday://computer?h=x'; rm -rf ~; '"), /isn't a link/);
  assert.throws(() => joinCommand("https://evil.example/x"), /isn't a link/);
});

test("the SSH setup script is sound shell, starts Friday with the link as a service that a removal ends, and asks for Node 22", () => {
  const script = joinScript(LINK, "mini");
  const dir = mkdtempSync(path.join(tmpdir(), "fb-join-"));
  writeFileSync(path.join(dir, "join.sh"), script);
  execFileSync("sh", ["-n", path.join(dir, "join.sh")]);
  assert.match(script, /"\$NPM" install --prefix "\$DIR"[^\n]*github:splashxmoon\/friday/);
  assert.match(script, /sed 's\/%\/%%\/g'/, "systemd's % specifiers: the link's own doubled");
  assert.match(script, /"\$MAJOR" -ge 22/);
  assert.match(script, /FRIDAY_SERVICE=1/);
  assert.match(script, /Restart=on-failure/, "systemd: a removal's exit 0 isn't restarted");
  assert.match(script, /<key>SuccessfulExit<\/key><false\/>/, "nor launchd's");
  assert.match(script, /FRIDAY_HOME=%s\/data/, "its data apart from a Friday already there");
  assert.throws(() => joinScript("friday://computer?h=1'2", "x"), /isn't a link/);
});

test("what ssh came back with, in words", () => {
  assert.deepEqual(joinSshResult(0, "FRIDAY_STEP install\nFRIDAY_DONE launchd\n", "mini"), { ok: true, how: "launchd" });
  assert.match((joinSshResult(0, "FRIDAY_DONE systemd\nFRIDAY_WARN linger\n", "box") as { warn?: string }).warn ?? "", /enable-linger/);
  assert.match((joinSshResult(21, "FRIDAY_ERROR old-node 20\n", "mini") as { error: string }).error, /Node 20\. Friday needs Node 22/);
  assert.match((joinSshResult(24, "FRIDAY_ERROR no-git\n", "mini") as { error: string }).error, /doesn't have git/);
  assert.match((joinSshResult(255, "Permission denied (publickey).", "mini") as { error: string }).error, /didn't accept your key/);
  assert.match((joinSshResult(25, "npm ERR! code E404\nFRIDAY_ERROR install\n", "mini") as { error: string }).error, /couldn't be installed on mini: npm ERR! code E404/);
  assert.deepEqual(sshConfigHosts("Host mini box\n  HostName 10.0.0.4\nHost *.corp\nHost -oProxyCommand=x\n"), ["mini", "box"]);
});
