// Your other computers (local/computers.ts, local/join.ts, local/phone.ts): the link a computer pairs with, what it may reach,
// and a link to this one's Friday from anything that isn't a paired computer.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { parseComputerLink } from "../src/local/join.js";
import { computerAllowed, COMPUTER_SOCKETS, passedHeaders } from "../src/local/phone.js";
import { LocalLinks } from "../src/local/computers.js";

const FP = "c38d7ba5c746ae731600a41ef637316756ff17587f4fe6934c94fd5c75bb559f";

test("a computer's pairing link says where the other Friday is and which certificate it must show", () => {
  const got = parseComputerLink(`friday://computer?h=192.168.1.180,100.88.1.2&p=55214&c=7WYNQBCA&s=https&n=Maya%E2%80%99s+MacBook+Pro&f=${FP}`);
  assert.deepEqual(got, { hub: { name: "Maya’s MacBook Pro", addresses: ["192.168.1.180", "100.88.1.2"], port: 55214, scheme: "https", fingerprint: FP }, code: "7WYNQBCA" });
  // A phone's link, a secure link with no certificate to pin, and an address a shell or URL would read as more are refused.
  assert.equal(parseComputerLink(`friday://pair?h=192.168.1.180&p=55214&c=7WYNQBCA&s=https&f=${FP}`), null);
  assert.equal(parseComputerLink("friday://computer?h=192.168.1.180&p=55214&c=7WYNQBCA&s=https"), null);
  assert.equal(parseComputerLink(`friday://computer?h=evil.com/x?y&p=55214&c=7WYNQBCA&s=https&f=${FP}`), null);
  assert.equal(parseComputerLink("not a link"), null);
  // Tailscale-only: plain http, which Tailscale encrypts itself.
  assert.equal(parseComputerLink("friday://computer?h=100.88.1.2&p=4390&c=7WYNQBCA&s=http")?.hub.scheme, "http");
});

test("another computer reaches its link, its agents' runners and a turn's files: nothing a phone or a page reaches", () => {
  assert.deepEqual([...COMPUTER_SOCKETS], ["/link", "/runner"]);
  assert.ok(computerAllowed("GET", "/api/sessions/abc123/files/f-1"));
  for (const [m, p] of [["GET", "/api/sessions/mine"], ["POST", "/api/sessions"], ["GET", "/api/me"], ["POST", "/api/runner/start"], ["GET", "/api/sessions/abc123/files/../x"], ["POST", "/api/sessions/abc123/files/f-1"]] as const) {
    assert.ok(!computerAllowed(m, p), `${m} ${p}`);
  }
  // It is said which computer it is, as only the listener can: whatever it sent of its own is dropped.
  const h = passedHeaders({ "x-friday-device": "forged", authorization: "Bearer x" }, 4321, { id: "0123456789abcdef", name: "Maya’s Mac mini", kind: "computer", hash: "", at: 0, seen: 0 });
  assert.equal(h["x-friday-via"], "computer");
  assert.equal(h["x-friday-device"], "0123456789abcdef");
  assert.equal(decodeURIComponent(String(h["x-friday-device-name"])), "Maya’s Mac mini");
  assert.equal(h.authorization, undefined);
  assert.equal(passedHeaders({}, 4321)["x-friday-via"], "phone");
});

/** A socket as far as LocalLinks sees one. */
class FakeWs extends EventEmitter {
  readyState = 1;
  sent: unknown[] = [];
  closed: [number, string] | null = null;
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close(code: number, reason: string) {
    this.closed = [code, reason];
    this.readyState = 3;
    this.emit("close", code);
  }
}

test("only a paired computer links, and calls go to it and come back with its answer", async () => {
  const links = new LocalLinks({ id: "local", name: "Maya" });
  const stranger = new FakeWs();
  links.accept(stranger as never, { headers: {} } as never);
  assert.equal(stranger.closed?.[0], 4003);

  const ws = new FakeWs();
  links.accept(ws as never, { headers: { "x-friday-via": "computer", "x-friday-device": "0123456789abcdef", "x-friday-device-name": encodeURIComponent("Mac mini") } } as never);
  ws.emit("message", JSON.stringify({ kind: "hello", machine: { name: "mini", platform: "darwin" }, tools: [{ tool: "claude", name: "Claude Code", loggedIn: true }] }));
  assert.deepEqual(ws.sent[0], { kind: "linked", owner: { id: "local", name: "Maya" } });
  assert.deepEqual(await links.machineToken("local", "0123456789abcdef"), { token: "0123456789abcdef", label: "Mac mini" });
  assert.equal(links.list()[0]?.tools?.[0]?.tool, "claude");

  const answer = links.call<{ recent: unknown[] }>("0123456789abcdef", "folders", {});
  const asked = ws.sent[1] as { kind: string; id: string; method: string };
  assert.equal(asked.method, "folders");
  ws.emit("message", JSON.stringify({ kind: "result", id: asked.id, ok: true, value: { recent: [] } }));
  assert.deepEqual(await answer, { recent: [] });

  // Removed in Settings: its link closes, and what waited on it hears why.
  const waiting = links.call("0123456789abcdef", "tools", {});
  links.forget("0123456789abcdef");
  await assert.rejects(waiting, /removed/);
  assert.equal(links.connected("0123456789abcdef"), false);
  await assert.rejects(links.call("0123456789abcdef", "tools", {}), /isn't connected/);
});

test("a teammate can run on another computer of yours: its id is kept, its folders are that computer's, and it comes back to this one", async () => {
  const { cleanTeammate } = await import("../src/teammates.js");
  const there = cleanTeammate({ name: "Mini", role: "Billing checks", tool: "claude", machine: "0123456789abcdef", projects: ["~/code/billing-api"] });
  assert.equal(there.machine, "0123456789abcdef");
  // Kept as written: ~ is that computer's home, not this one's.
  assert.deepEqual(there.projects, ["~/code/billing-api"]);
  // Back on this computer: said, so it is cleared; not said, so it is left as it was; anything else isn't a computer.
  assert.ok("machine" in cleanTeammate({ name: "Mini", tool: "claude", machine: "" }) && cleanTeammate({ name: "Mini", tool: "claude", machine: "" }).machine === undefined);
  assert.ok(!("machine" in cleanTeammate({ name: "Mini", tool: "claude" })));
  assert.equal(cleanTeammate({ name: "Mini", tool: "claude", machine: "../../etc" }).machine, undefined);
});
