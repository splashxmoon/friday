/**
 * When the app itself can't be drawn: what went wrong, said plainly, with Reload, instead of a blank window (Arun, 2026-11-01:
 * "production screen app is blank after reloading for update"). React leaves the root empty after an error nothing caught;
 * this draws into it with the DOM alone, so it shows even when the app's own components are what failed. The error's own
 * words and the first lines of its stack, so a screenshot of it says where.
 */
export function showCrash(error: unknown): void {
  // After React has taken its tree down: drawn before, it was cleared with the rest.
  setTimeout(() => draw(error), 0);
}

function draw(error: unknown): void {
  const root = document.getElementById("root");
  if (!root) return;
  const e = error instanceof Error ? error : new Error(String(error));
  const box = document.createElement("div");
  box.setAttribute("role", "alert");
  box.style.cssText = "max-width:560px;margin:15vh auto 0;padding:0 24px;font:14px/1.5 var(--font, system-ui);color:var(--ink, #ededed)";
  const title = document.createElement("div");
  title.textContent = "Friday couldn't draw this screen";
  title.style.cssText = "font-size:17px;font-weight:600;margin-bottom:8px";
  const what = document.createElement("div");
  what.textContent = e.message || "Something went wrong.";
  what.style.cssText = "color:var(--ink-2, #b5b5b5);margin-bottom:12px";
  const stack = document.createElement("pre");
  stack.textContent = (e.stack ?? "").split("\n").slice(0, 6).join("\n");
  stack.style.cssText = "white-space:pre-wrap;font:11.5px/1.45 ui-monospace,monospace;color:var(--text-muted, #929292);background:rgb(127 127 127 / .08);border-radius:8px;padding:10px 12px;margin:0 0 16px;max-height:40vh;overflow:auto";
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px";
  const button = (label: string, primary: boolean, act: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText = `height:32px;padding:0 14px;border-radius:999px;font:inherit;font-size:13px;font-weight:500;cursor:pointer;border:1px solid ${primary ? "transparent" : "rgb(127 127 127 / .35)"};background:${primary ? "var(--ink, #ededed)" : "transparent"};color:${primary ? "var(--bg, #191919)" : "var(--ink, #ededed)"}`;
    b.onclick = act;
    return b;
  };
  row.append(
    button("Reload", true, () => location.reload()),
    button("Copy the error", false, () => void navigator.clipboard?.writeText(`${e.message}\n${e.stack ?? ""}`)),
  );
  box.append(title, what, stack, row);
  root.replaceChildren(box);
}
