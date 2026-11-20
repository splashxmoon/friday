import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pickServer } from "../src/runner/preview-check.js";

const cwd = path.resolve("/work/app");
const up = (...ports: number[]) => async (p: number) => ports.includes(p);

test("the server for a check: this folder's own, serving a page, lowest port first", async () => {
  const servers = [
    { port: 3000, cwd: path.join(cwd, "api"), here: true },
    { port: 5173, cwd, here: true },
  ];
  // The API on the lower port answers JSON, not a page: the Vite app on 5173 is the one.
  assert.equal(await pickServer(servers, cwd, up(5173)), 5173);
  assert.equal(await pickServer(servers, cwd, up(3000, 5173)), 3000);
});

test("the server for a check: not another agent's copy of the repo, not one that isn't here", async () => {
  const servers = [
    { port: 3001, cwd: path.resolve("/work/app-copy"), here: true },
    { port: 3002, cwd: path.resolve("/work"), here: true },
    { port: 3003, cwd, here: false },
    { port: 3004, cwd: null, here: true },
  ];
  assert.equal(await pickServer(servers, cwd, up(3001, 3002, 3003, 3004)), null);
});
