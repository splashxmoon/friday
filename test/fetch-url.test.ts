import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { fetchUrl, toText } from "../src/agent/fetch-url.js";

/**
 * The agent reads pages whose URLs came from other pages. What matters is not
 * that it can fetch, but that it will not be talked into fetching something on
 * the network Friday itself lives on.
 */

const never = new AbortController().signal;
let server: Server;
let port = 0;

before(
  () =>
    new Promise<void>((done) => {
      server = createServer((req, res) => {
        if (req.url === "/page") {
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<html><head><style>b{}</style></head><body><h1>Title</h1><script>evil()</script><p>Body text.</p></body></html>");
        } else if (req.url === "/away") {
          res.writeHead(302, { location: "http://127.0.0.1:1/secret" });
          res.end();
        } else {
          res.writeHead(404).end("no");
        }
      }).listen(0, "127.0.0.1", () => {
        port = (server.address() as { port: number }).port;
        done();
      });
    }),
);
after(() => new Promise<void>((done) => server.close(() => done())));

test("loopback and private networks are refused, whatever the spelling", async () => {
  for (const u of ["http://127.0.0.1/", "http://localhost/", "http://10.0.0.5/", "http://192.168.1.1/", "http://172.20.1.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/"]) {
    assert.match(await fetchUrl(u, never), /private network|doesn't resolve/, `${u} must not be fetchable`);
  }
});

test("only http and https, and only a real URL", async () => {
  assert.match(await fetchUrl("file:///etc/passwd", never), /Only http and https/);
  assert.match(await fetchUrl("not a url", never), /isn't a URL/);
});

test("a redirect into the private network is caught at the hop, not followed", async () => {
  // The first URL is allowed only because the test server is deliberately
  // reachable; the point is that the 302's target gets its own check.
  const out = await fetchUrl(`http://127.0.0.1:${port}/away`, never);
  assert.match(out, /private network/);
});

test("a page comes back as its words, not its markup", () => {
  const out = toText('<html><head><style>b{color:red}</style></head><body><h1>Title</h1><script>evil()</script><p>Body &amp; more.</p><p>Second.</p></body></html>');
  assert.match(out, /Title/);
  assert.match(out, /Body & more\./, "entities are decoded");
  assert.doesNotMatch(out, /evil|color:red/, "script and style are contents nobody wants to read");
  assert.doesNotMatch(out, /</, "and no tags survive");
  assert.match(out, /more\.[\s\S]*Second/, "block ends become line breaks, so paragraphs stay apart");
});
