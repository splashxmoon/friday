// A stand-in for code-server, for e2e/local-vscode.spec.ts and test/vscode-runner.test.ts (FRIDAY_CODE_SERVER_BIN). It behaves like
// code-server started with `--auth password`: /healthz is open, /login signs in with the PASSWORD it was started with (a form post
// sets a session cookie and redirects to ?to=), and every other page is refused without that cookie. Behind it, a page titled
// "VS Code stand-in" that echoes the folder query and follows prefers-color-scheme. Two test affordances, open on purpose:
// /token (the FRIDAY_VSCODE_TOKEN Friday gave it, so a spec can post an ask as the extension would) and /started-with (its
// --auth value and whether PASSWORD was set, so a test can see Friday did not start it open).
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const bind = arg("--bind-addr") ?? `127.0.0.1:${process.env.PORT ?? 0}`;
const [host, port] = [bind.slice(0, bind.lastIndexOf(":")), Number(bind.slice(bind.lastIndexOf(":") + 1))];
const auth = arg("--auth") ?? "password";
const password = process.env.PASSWORD ?? "";
const session = createHash("sha256").update(`standin:${password}`).digest("hex");
const signedIn = (req) => auth === "none" || (req.headers.cookie ?? "").split(/;\s*/).includes(`standin-session=${session}`);
const esc = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const shell = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>VS Code stand-in</title>
<style>html,body{margin:0;height:100%;background:#fafaf9;color:#1a1a1a;font:14px ui-monospace,Menlo,monospace}main{padding:24px}h1{font-size:15px;font-weight:600}
@media (prefers-color-scheme: dark){html,body{background:#191919;color:#ededed}}</style></head><body><main>${body}</main></body></html>`;
const page = (folder) => shell(`<h1>VS Code stand-in</h1><p id="folder">${esc(folder)}</p>`);
const loginPage = (to, bad) => shell(`<h1>Sign in</h1>${bad ? "<p>Incorrect password</p>" : ""}<form method="post" action="/login?to=${encodeURIComponent(to)}"><input type="password" name="password"><button>Go</button></form>`);

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const html = (body, status = 200) => void res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
  if (url.pathname === "/healthz") return void res.setHeader("content-type", "application/json").end('{"status":"alive"}');
  if (url.pathname === "/token") return void res.setHeader("content-type", "text/plain").end(process.env.FRIDAY_VSCODE_TOKEN ?? "");
  if (url.pathname === "/started-with") return void res.setHeader("content-type", "application/json").end(JSON.stringify({ auth, password: !!password, args: process.argv.slice(2) }));
  if (url.pathname === "/login") {
    const to = url.searchParams.get("to") || "/";
    if (req.method !== "POST") return html(loginPage(to, false));
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!password || new URLSearchParams(body).get("password") !== password) return html(loginPage(to, true), 401);
      res.writeHead(302, { "set-cookie": `standin-session=${session}; Path=/; HttpOnly; SameSite=Lax`, location: to.startsWith("/") ? to : "/" }).end();
    });
    return;
  }
  if (!signedIn(req)) return void res.writeHead(302, { location: `/login?to=${encodeURIComponent(url.pathname + url.search)}` }).end();
  html(page(url.searchParams.get("folder") ?? ""));
}).listen(port, host);
