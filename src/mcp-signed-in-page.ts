import { MCP_CATALOG } from "./client/mcp-catalog.js";

/**
 * The page a browser lands on after signing in to an MCP server from this computer (app.ts /api/mcp/signed-in; Arun, 2026-11-17:
 * "also design the signed in page better in the browser too, with the mascots together and stuff"): three of Friday's faces in a
 * small group beside the service's own logo, what happened in a line, and what happens next. Its faces are the app's own drawing
 * (teammate-face.tsx), drawn here once to SVG; awake when it worked, eyes shut when it didn't. Light or dark, as the browser is.
 */

// Three of different colours: peach in front, violet and blue beside it.
const SEEDS = ["v2:rail-a", "v2:mcp-4", "v2:friday-a"];

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/** The three faces, as SVG markup: the middle one larger and in front. Loaded only when this page is drawn. */
async function faces(ok: boolean): Promise<string[]> {
  try {
    const [{ createElement }, { renderToStaticMarkup }, { BlobFace }] = await Promise.all([import("react"), import("react-dom/server"), import("./client/teammate-face.js")]);
    return SEEDS.map((seed, i) => renderToStaticMarkup(createElement(BlobFace, { seed, size: i === 0 ? 64 : 50, eyes: ok ? "open" : "closed" })));
  } catch {
    return [];
  }
}

export async function signedInPage(o: { ok: boolean; text: string; /** The server signed in to, when it got that far. */ server?: { name: string; catalog?: string } }): Promise<string> {
  const [front, left, right] = await faces(o.ok);
  const entry = o.server?.catalog ? MCP_CATALOG.find((e) => e.id === o.server!.catalog) : undefined;
  const name = entry?.name ?? o.server?.name;
  const title = o.ok ? `${name ?? "It"} is connected` : name ? `${name} didn't answer` : "Not signed in";
  const logo = entry?.logo ?? (entry?.domain ? `https://www.google.com/s2/favicons?domain=${entry.domain}&sz=128` : "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Friday</title>
<style>
  :root { --bg: #f6f5f2; --card: #ffffff; --ink: #1b1b1a; --muted: #6c6b67; --line: rgba(27, 27, 26, 0.09); --ok: #1f8a4c; --bad: #c2412d; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151514; --card: #1e1e1d; --ink: #ecebe8; --muted: #9a9994; --line: rgba(236, 235, 232, 0.1); --ok: #4cc27c; --bad: #ef7a64; color-scheme: dark; } }
  * { box-sizing: border-box; }
  body { display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 24px 16px; background: var(--bg); color: var(--ink); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  main { width: 100%; max-width: 440px; padding: 40px 32px 30px; border: 1px solid var(--line); border-radius: 20px; background: var(--card); box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 12px 40px -18px rgba(0,0,0,.18); text-align: center; animation: rise .5s cubic-bezier(.2,.8,.2,1) both; }
  .scene { display: flex; align-items: center; justify-content: center; gap: 18px; margin-bottom: 26px; }
  .crew { position: relative; width: 132px; height: 74px; }
  .crew > span { position: absolute; bottom: 0; display: block; line-height: 0; }
  .crew > span svg { display: block; overflow: visible; }
  .crew .l { left: 0; animation: bob 3.2s ease-in-out .2s infinite; }
  .crew .r { right: 0; animation: bob 3.2s ease-in-out .9s infinite; }
  .crew .f { left: 50%; z-index: 1; margin-left: -32px; animation: bob 3.2s ease-in-out infinite; }
  .link { display: flex; align-items: center; gap: 5px; color: var(--muted); }
  .link i { display: block; width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .45; }
  .link i:nth-child(2) { opacity: .7; }
  .ok .link { color: var(--ok); }
  .logo { display: grid; place-items: center; width: 64px; height: 64px; border: 1px solid var(--line); border-radius: 18px; background: #fff; }
  .logo img { width: 36px; height: 36px; object-fit: contain; }
  .badge { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 10px; padding: 3px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 600; }
  .ok .badge { background: color-mix(in srgb, var(--ok) 12%, transparent); color: var(--ok); }
  .bad .badge { background: color-mix(in srgb, var(--bad) 12%, transparent); color: var(--bad); }
  .badge svg { width: 13px; height: 13px; }
  h1 { margin: 0 0 8px; font-size: 21px; font-weight: 650; letter-spacing: -0.015em; line-height: 1.25; text-wrap: balance; }
  p { margin: 0; color: var(--muted); text-wrap: pretty; }
  .next { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 13px; }
  @keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
  @keyframes rise { from { opacity: 0; transform: translateY(8px); } }
  @media (prefers-reduced-motion: reduce) { main, .crew > span { animation: none; } }
</style>
</head>
<body class="${o.ok ? "ok" : "bad"}">
<main>
  <div class="scene" aria-hidden="true">
    ${front ? `<div class="crew"><span class="l">${left}</span><span class="r">${right}</span><span class="f">${front}</span></div>` : ""}
    ${logo ? `<span class="link"><i></i><i></i><i></i></span><span class="logo"><img src="${esc(logo)}" alt="" referrerpolicy="no-referrer"></span>` : ""}
  </div>
  <span class="badge">${o.ok ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-7"/></svg>Signed in' : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 4v5M8 12v.01"/></svg>Not signed in'}</span>
  <h1>${esc(title)}</h1>
  <p>${esc(o.text)}</p>
  <p class="next">${o.ok ? "You can close this tab and go back to Friday." : "Close this tab and start the sign-in again from Friday."}</p>
</main>
</body>
</html>`;
}
