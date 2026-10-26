import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { heartbeat, keepAlive } from "../src/heartbeat.js";

/**
 * Why a link that looks fine is not.
 *
 * A socket nobody writes to has no timeout. When a laptop sleeps or a
 * network changes, no `close` fires on either side: the server keeps a
 * machine in its list that is not there, and the runner sits linked to
 * nothing until somebody tries to use it. That is the shape of "it
 * disconnects randomly" — it disconnects while idle, and nothing notices.
 */

async function pair(): Promise<{ wss: WebSocketServer; url: string; close: () => Promise<void> }> {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    wss,
    url: `ws://127.0.0.1:${port}`,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

test("an idle socket is pinged, so nothing in the middle sees silence", async (t) => {
  const { wss, url, close } = await pair();
  const stop = heartbeat(wss, 30);
  t.after(async () => {
    stop();
    await close();
  });

  const ws = new WebSocket(url);
  await new Promise((r) => ws.on("open", r));
  const pinged = await new Promise<boolean>((r) => {
    ws.on("ping", () => r(true));
    setTimeout(() => r(false), 500);
  });
  assert.equal(pinged, true, "the server asks, rather than waiting to be told");
  assert.equal(ws.readyState, WebSocket.OPEN, "and an answering client stays");
  ws.terminate();
});

/**
 * The case that matters. A client that has stopped answering is gone
 * whatever its socket still claims, and the only way to find out is that it
 * did not answer.
 */
test("a client that stops answering is dropped rather than kept in the list", async (t) => {
  const { wss, url, close } = await pair();
  const stop = heartbeat(wss, 40);
  t.after(async () => {
    stop();
    await close();
  });

  const ws = new WebSocket(url);
  await new Promise((r) => ws.on("open", r));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(wss.clients.size, 1);

  // Stop answering without closing: exactly what a sleeping laptop does.
  const server = [...wss.clients][0]!;
  server.pong = () => {};
  ws.pong = () => {};

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(wss.clients.size, 0, "a socket nobody answers on is not a connection");
});

/** The runner's own side, so a dead link becomes a reconnect and not a wait. */
test("the client half tears down a link that has gone quiet", async (t) => {
  const { wss, url, close } = await pair();
  t.after(close);

  const ws = new WebSocket(url);
  await new Promise((r) => ws.on("open", r));
  // A server that never answers a ping, which is what a half-open path is.
  for (const c of wss.clients) c.pong = () => {};
  keepAlive(ws, 40);

  const closed = await new Promise<boolean>((r) => {
    ws.on("close", () => r(true));
    setTimeout(() => r(false), 500);
  });
  assert.equal(closed, true, "so the reconnect loop gets to run");
});

/** Held up without answering: what a busy loop does to everything else in its process. */
const hold = (ms: number) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Nothing: the point is that nothing else runs.
  }
};

/**
 * A server that stalls for one round (a big session loading, on half a CPU) answers late, not never. Ending the link on the
 * first missed answer cut every runner on a computer, and every agent's coding tool with it, at the same moment.
 */
test("the client half forgives one missed answer, as the server does", async (t) => {
  const { wss, url, close } = await pair();
  t.after(close);

  const ws = new WebSocket(url);
  await new Promise((r) => ws.on("open", r));
  // The first ping goes unanswered, and the ones after it are answered.
  const server = [...wss.clients][0]!;
  const pong = server.pong.bind(server);
  let first = true;
  server.pong = (...a: Parameters<typeof pong>) => {
    if (first) return void (first = false);
    pong(...a);
  };
  keepAlive(ws, 40);

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(ws.readyState, WebSocket.OPEN, "one late round is a slow server, not a dead link");
  ws.terminate();
});

test("after a pause of its own, the client asks before it gives up, and keeps a link that answers", async (t) => {
  const { url, close } = await pair();
  t.after(close);

  const ws = new WebSocket(url);
  await new Promise((r) => ws.on("open", r));
  let why = "";
  keepAlive(ws, 40, (w) => (why = w));
  await new Promise((r) => setTimeout(r, 50));
  // This process held up for several rounds, the way a stall or App Nap holds it: the link itself is fine.
  hold(150);

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(ws.readyState, WebSocket.OPEN, "the pause was this process's, and the server still answers");
  assert.equal(why, "");
  ws.terminate();
});

test("after a pause, a link that doesn't answer is ended at once, and says why", async (t) => {
  const { wss, url, close } = await pair();
  t.after(close);

  const ws = new WebSocket(url);
  await new Promise((r) => ws.on("open", r));
  let why = "";
  keepAlive(ws, 40, (w) => (why = w));
  await new Promise((r) => setTimeout(r, 50));
  // What a computer waking from sleep finds: nothing answers on the other end any more.
  for (const c of wss.clients) c.pong = () => {};
  hold(150);

  const closed = await new Promise<boolean>((r) => {
    ws.on("close", () => r(true));
    setTimeout(() => r(false), 300);
  });
  assert.equal(closed, true, "so the reconnect starts now, not a minute later");
  assert.match(why, /paused/);
});

test("stopping the heartbeat stops the timer, so shutting down isn't held open", async (t) => {
  const { wss, close } = await pair();
  t.after(close);
  const stop = heartbeat(wss, 20);
  stop();
  // Nothing to assert beyond it not throwing and not keeping the loop alive;
  // an unref'd timer wouldn't hold the process, but a cleared one is honest.
  assert.doesNotThrow(stop);
});
