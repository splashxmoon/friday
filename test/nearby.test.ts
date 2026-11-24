import assert from "node:assert/strict";
import test from "node:test";
import { checkNumber, Nearby } from "../src/local/nearby.js";

const FP = "c38d7ba5c746ae731600a41ef637316756ff17587f4fe6934c94fd5c75bb559f";
const LINK = `friday://computer?h=127.0.0.1&p=55214&c=7WYNQBCA&s=https&n=Maya%E2%80%99s+MacBook+Pro&f=${FP}`;

test("the check number comes from the certificate: six digits, the same on both computers", () => {
  assert.match(checkNumber(FP), /^\d{3} \d{3}$/);
  assert.equal(checkNumber(FP), checkNumber(FP.toUpperCase()));
  assert.notEqual(checkNumber(FP), checkNumber(`0${FP.slice(1)}`));
});

test("two Fridays on a network find each other, and an offer reaches only the one it names", async (t) => {
  const ports = [47391 + (process.pid % 200), 47600 + (process.pid % 200)];
  const a = new Nearby({ id: "a".repeat(32), name: () => "Maya's MacBook Pro", version: "0.4.0", pairedWith: async () => null, port: ports[0], ask: ports });
  const b = new Nearby({ id: "b".repeat(32), name: () => "Mac mini", version: "0.4.0", pairedWith: async () => FP, port: ports[1], ask: ports });
  await a.start();
  await b.start();
  t.after(() => (a.stop(), b.stop()));
  const found = await a.find(1500);
  const mini = found.find((f) => f.id === "b".repeat(32));
  if (!mini) return t.skip("broadcast doesn't loop back on this machine");
  assert.equal(mini.pairedWith, FP);
  assert.ok(!found.some((f) => f.id === "a".repeat(32)), "a Friday doesn't find itself");
  await a.offer({ ...mini, address: "127.0.0.1" }, LINK);
  await new Promise((r) => setTimeout(r, 300));
  const waiting = b.pending();
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0]!.name, "Maya's MacBook Pro");
  assert.equal(waiting[0]!.check, checkNumber(FP));
  assert.equal(a.pending().length, 0, "the offer named b, so a keeps nothing");
  assert.equal(b.take("a".repeat(32))?.link, LINK);
  assert.equal(b.take("a".repeat(32)), null, "taken once");
});

test("an offer without a certificate in its link is dropped", async (t) => {
  const port = 47800 + (process.pid % 150);
  const b = new Nearby({ id: "b".repeat(32), name: () => "Mac mini", version: "0.4.0", pairedWith: async () => null, port });
  await b.start();
  t.after(() => b.stop());
  const a = new Nearby({ id: "a".repeat(32), name: () => "Someone", version: "0.4.0", pairedWith: async () => null, port, ask: [port] });
  await a.offer({ id: "b".repeat(32), name: "Mac mini", platform: "darwin", version: "", address: "127.0.0.1", pairedWith: null }, LINK.replace(/&f=[0-9a-f]+/, ""));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(b.pending().length, 0);
});
