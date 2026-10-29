import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CustomRendererProps } from "streamdown";
import { Icon } from "./icons.js";
import { Lightbox } from "./Lightbox.js";

/**
 * What an agent shows rather than says: a chart, a diagram, a small app, a picture, drawn live in the conversation.
 *
 * An agent writes it as a fenced block — ```html for a page (a chart, a calculator, a mock-up), ```svg for a drawing,
 * ```mermaid for a diagram — and it renders where the block is, with its code a press away. It runs in a frame of its own
 * with no origin (sandbox without allow-same-origin): it can draw and run its scripts, load a library from a public CDN,
 * and nothing else. It can't read Friday's cookies or storage, reach the page around it, submit a form, open a window or
 * send anything anywhere (connect-src 'none'). Agents write what is in a repository, and a repository can be anyone's, so
 * that fence is what makes drawing it safe for everyone watching the session.
 */

export type LiveKind = "html" | "svg" | "mermaid";
const KINDS: Record<LiveKind, { label: string; icon: "browser" | "image" | "diagram" }> = {
  html: { label: "Live page", icon: "browser" }, // As the Work rail says it (QA, 2026-10-28: "Live view" here, "Live page" there).
  svg: { label: "Drawing", icon: "image" },
  mermaid: { label: "Diagram", icon: "diagram" },
};

/** Where libraries may come from: the public CDNs, nowhere else. */
const CDNS = "https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://esm.sh";
const CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${CDNS}`,
  `style-src 'unsafe-inline' ${CDNS} https://fonts.googleapis.com`,
  "font-src https://fonts.gstatic.com data:",
  `img-src data: blob: https:`,
  "media-src data: blob: https:",
  "connect-src 'none'",
  "form-action 'none'",
].join("; ");

/** Tells the conversation how tall the page is, so the frame grows to fit it rather than scrolling inside a box. */
// Moved or zoomed (panZoom marks the body), only the layout's height counts: what the picture covers then is not the page.
// The body's own height, not the document's scroll height: that one is never less than the frame, so a frame never shrank
// to its content, and a diagram that measured itself before it was drawn stayed a sliver. Asked again as the page changes
// (a library drawing, fonts arriving) and every quarter second for the first few, which is when that happens.
const SIZER = `<script>(()=>{let last=0;const say=()=>{const b=document.body;const h=Math.ceil(b.dataset.pz?b.getBoundingClientRect().height:Math.max(b.scrollHeight,b.getBoundingClientRect().height));if(h&&h!==last){last=h;parent.postMessage({friday:"live-size",h},"*")}};new ResizeObserver(say).observe(document.body);new MutationObserver(say).observe(document.body,{subtree:true,childList:true,attributes:true});addEventListener("load",say);let n=0;const t=setInterval(()=>{say();if(++n>24)clearInterval(t)},250);say()})()</script>`;

/**
 * Moving around a drawing or a diagram (Arun, 2026-10-20: "able to drag and zoom into the live diagram"): drag to move it,
 * pinch or ⌘/Ctrl-scroll to zoom about the pointer (plain scrolling still moves the conversation; opened full screen, plain
 * scrolling zooms), double-click or the last button to put it back, and + / − on hover. The picture is moved with a transform,
 * so the frame keeps its height and nothing about it is lost. Found again when a diagram draws itself again.
 */
const panZoom = (big: boolean) =>
  `<style>.pz-tools{position:fixed;right:8px;bottom:8px;display:flex;gap:2px;padding:2px;border-radius:9px;background:var(--raised);border:1px solid var(--border);opacity:0;transition:opacity .15s}body:hover .pz-tools,.pz-tools:focus-within{opacity:1}.pz-tools button{width:26px;height:26px;padding:0;display:grid;place-items:center;border:0;background:transparent;border-radius:7px;font:600 14px/1 var(--font);color:var(--muted)}.pz-tools button:hover{background:var(--surface);color:var(--fg)}body.pz-on{cursor:grab;-webkit-user-select:none;user-select:none;touch-action:none;overflow:hidden!important}body.pz-drag{cursor:grabbing}</style><script>(()=>{const BIG=${big};let s=1,x=0,y=0,el=null,drag=null;` +
  `const apply=()=>{if(!el)return;document.body.dataset.pz=s!==1||x||y?"1":"";el.style.transformOrigin="0 0";el.style.transition=drag?"none":"transform .12s ease-out";el.style.transform="translate("+x+"px,"+y+"px) scale("+s+")"};` +
  `const zoomAt=(f,cx,cy)=>{if(!el)return;const r=el.getBoundingClientRect(),bl=r.left-x,bt=r.top-y,ns=Math.min(8,Math.max(.25,s*f)),px=(cx-bl-x)/s,py=(cy-bt-y)/s;x=cx-bl-px*ns;y=cy-bt-py*ns;s=ns;apply()};` +
  `const reset=()=>{s=1;x=0;y=0;apply()};` +
  `addEventListener("wheel",e=>{if(!el||(!BIG&&!e.ctrlKey&&!e.metaKey))return;e.preventDefault();zoomAt(Math.exp(-e.deltaY*(e.ctrlKey?.01:.002)),e.clientX,e.clientY)},{passive:false});` +
  `addEventListener("pointerdown",e=>{if(!el||e.button!==0||e.target.closest(".pz-tools"))return;drag={px:e.clientX,py:e.clientY,x,y};document.body.classList.add("pz-drag");try{document.body.setPointerCapture(e.pointerId)}catch{}});` +
  `addEventListener("pointermove",e=>{if(!drag)return;x=drag.x+e.clientX-drag.px;y=drag.y+e.clientY-drag.py;apply()});` +
  `const end=()=>{if(!drag)return;drag=null;document.body.classList.remove("pz-drag");apply()};addEventListener("pointerup",end);addEventListener("pointercancel",end);` +
  `addEventListener("dblclick",e=>{if(!e.target.closest(".pz-tools"))reset()});` +
  `const tools=document.createElement("div");tools.className="pz-tools";[["+","Zoom in",()=>zoomAt(1.25,innerWidth/2,innerHeight/2)],["\u2212","Zoom out",()=>zoomAt(.8,innerWidth/2,innerHeight/2)],["\u21ba","Put it back",reset]].forEach(([t,l,f])=>{const b=document.createElement("button");b.type="button";b.textContent=t;b.title=l;b.setAttribute("aria-label",l);b.onclick=f;tools.append(b)});` +
  `const hook=()=>{const n=[...document.querySelectorAll("body svg")].find(g=>!g.closest(".pz-tools"));if(n&&n!==el){el=n;apply();document.body.classList.add("pz-on");if(!tools.isConnected)document.body.append(tools)}};new MutationObserver(hook).observe(document.body,{childList:true,subtree:true});hook()})()</script>`;

/**
 * Friday's look, inside the page: the app's colours as variables, and a series palette validated for colour-blind
 * separation on Friday's own cards (the dataviz reference eight, which Friday's tool colours already come from).
 */
const THEME = {
  dark: { fg: "#ededed", muted: "#a0a0a0", surface: "#2d2d2d", raised: "#333336", border: "#3a3a3a", grid: "rgba(255,255,255,.07)", accent: "#4fd1a1", good: "#3fb67b", warn: "#f2b453", bad: "#ff7b72", inverse: "#131315", series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"] },
  light: { fg: "#18181b", muted: "#55555e", surface: "#ebebef", raised: "#ffffff", border: "#c6c6cf", grid: "rgba(17,17,24,.08)", accent: "#0b6c55", good: "#126c34", warn: "#855500", bad: "#b0331f", inverse: "#ffffff", series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"] },
};
type Theme = (typeof THEME)["dark"];

/** The kit an agent's page can lean on: variables, a type scale, and a few parts (cards, stat tiles, tables, badges, controls). */
const kitCss = (t: Theme) => `:root{--fg:${t.fg};--muted:${t.muted};--surface:${t.surface};--raised:${t.raised};--border:${t.border};--grid:${t.grid};--accent:${t.accent};--good:${t.good};--warn:${t.warn};--bad:${t.bad};${t.series.map((c, i) => `--series-${i + 1}:${c}`).join(";")};--radius:12px;--font:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--fg);font:14px/1.55 var(--font);-webkit-font-smoothing:antialiased}body{padding:16px}
h1,h2,h3,h4{margin:0 0 8px;font-weight:600;letter-spacing:-.01em;line-height:1.3}h1{font-size:20px}h2{font-size:16px}h3{font-size:14px}h4{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
p{margin:0 0 10px}small,.muted{color:var(--muted)}a{color:var(--accent)}code{font:13px var(--mono)}hr{border:0;border-top:1px solid var(--border);margin:14px 0}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(170px,100%),1fr))}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.stack{display:flex;flex-direction:column;gap:12px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px}
.stat .label{font-size:12px;color:var(--muted)}.stat .value{margin-top:2px;font-size:26px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}.stat .delta{font-size:12px;font-weight:500}.up{color:var(--good)}.down{color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;font-weight:500;color:var(--muted);padding:8px 10px;border-bottom:1px solid var(--border)}td{padding:8px 10px;border-bottom:1px solid var(--grid)}tr:last-child td{border-bottom:0}.num{text-align:right;font-variant-numeric:tabular-nums}
.badge{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:500;background:var(--surface);border:1px solid var(--border)}.badge.good{color:var(--good)}.badge.warn{color:var(--warn)}.badge.bad{color:var(--bad)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--series-1)}
button{font:500 13px var(--font);padding:7px 13px;border-radius:9px;border:1px solid var(--border);background:var(--surface);color:var(--fg);cursor:pointer}button:hover{border-color:var(--muted)}button.primary{background:var(--fg);border-color:var(--fg);color:${t.inverse}}
input,select,textarea{font:13px var(--font);padding:7px 10px;border-radius:9px;border:1px solid var(--border);background:transparent;color:var(--fg)}input[type=range]{padding:0;accent-color:var(--accent)}
canvas,svg,img{max-width:100%}.chart{position:relative;height:260px}`;

/**
 * Chart.js in Friday's look without the agent asking: the library sets `window.Chart` when it loads, before any chart is
 * made, so defaults and the series colours are set at that moment. A chart that names its own colours keeps them.
 */
const chartTheme = (t: Theme) => `<script>(()=>{const T=${JSON.stringify(t)};let C;Object.defineProperty(window,"Chart",{configurable:true,get(){return C},set(v){C=v;try{const d=v.defaults;d.font.family='Inter,ui-sans-serif,system-ui,sans-serif';d.font.size=12;d.color=T.muted;d.borderColor=T.grid;d.maintainAspectRatio=false;d.animation.duration=500;
const p=d.plugins;p.legend.labels.usePointStyle=true;p.legend.labels.boxWidth=8;p.legend.labels.padding=14;p.legend.labels.color=T.muted;Object.assign(p.tooltip,{backgroundColor:T.raised,titleColor:T.fg,bodyColor:T.fg,borderColor:T.border,borderWidth:1,padding:10,cornerRadius:8,boxPadding:4,usePointStyle:true});if(p.colors)p.colors.enabled=false;
d.elements.bar.borderRadius=4;d.elements.bar.borderSkipped="start";d.elements.line.borderWidth=2;d.elements.line.tension=.3;d.elements.point.radius=0;d.elements.point.hoverRadius=4;d.elements.arc.borderWidth=2;d.elements.arc.borderColor=T.surface;
d.scale.grid.color=T.grid;d.scale.border.display=false;d.scale.ticks.color=T.muted;
v.register({id:"friday",beforeUpdate(ch){const round=["pie","doughnut","polarArea"].includes(ch.config.type);ch.data.datasets.forEach((ds,i)=>{if(ds.backgroundColor||ds.borderColor)return;if(round){ds.backgroundColor=ch.data.labels.map((_,j)=>T.series[j%8]);return}const c=T.series[i%8];ds.borderColor=c;ds.backgroundColor=(ds.type||ch.config.type)==="line"?c+"22":c;if((ds.type||ch.config.type)==="line"&&ds.fill===undefined)ds.fill=ch.data.datasets.length===1})}})}catch(e){}}})})()</script>`;

/** Mermaid in Friday's look: its own surfaces, borders and type, rounded boxes and soft curves. */
const mermaidInit = (t: Theme, dark: boolean) =>
  JSON.stringify({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    themeVariables: { darkMode: dark, background: "transparent", fontSize: "13px", primaryColor: t.surface, primaryTextColor: t.fg, primaryBorderColor: t.border, mainBkg: t.surface, nodeBorder: t.border, lineColor: t.muted, secondaryColor: t.raised, tertiaryColor: t.raised, clusterBkg: "transparent", clusterBorder: t.border, edgeLabelBackground: dark ? "#262626" : "#f5f5f7", titleColor: t.fg, textColor: t.fg, noteBkgColor: t.raised, noteBorderColor: t.border, noteTextColor: t.fg, actorBkg: t.surface, actorBorder: t.border, actorTextColor: t.fg, signalColor: t.muted, signalTextColor: t.fg, labelBoxBkgColor: t.surface, labelBoxBorderColor: t.border, pie1: t.series[0], pie2: t.series[1], pie3: t.series[2], pie4: t.series[3], pie5: t.series[4], pie6: t.series[5], pie7: t.series[6], pie8: t.series[7], git0: t.series[0], git1: t.series[1], git2: t.series[2], git3: t.series[3] },
    flowchart: { curve: "basis", padding: 16, nodeSpacing: 44, rankSpacing: 54, htmlLabels: true },
    sequence: { mirrorActors: false, actorMargin: 60 },
  });

/** The page the frame shows, from the block's code: the agent's page, or a drawing or diagram set on one, all in Friday's look. */
export function liveDocument(kind: LiveKind, code: string, dark: boolean, big = false): string {
  const scheme = dark ? "dark" : "light";
  const t = dark ? THEME.dark : THEME.light;
  const base = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="color-scheme" content="${scheme}"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"><style>${kitCss(t)}</style>${chartTheme(t)}`;
  // Opened large, a drawing or a diagram fills the space it is given, keeping its shape, and follows that space as it changes:
  // drawn at its own size it sat small in a corner of a window-sized frame.
  const fill = "html,body{height:100%}body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;overflow:hidden}";
  if (kind === "svg") return `<!doctype html><html><head>${base}<style>${big ? `${fill}svg{width:100%!important;height:100%!important;max-width:none;max-height:none}` : "body{display:grid;place-items:center}svg{width:auto;height:auto;max-width:min(100%,760px);max-height:520px}"}</style></head><body>${code}${panZoom(big)}${SIZER}</body></html>`;
  if (kind === "mermaid") {
    // The source goes in as text, never as markup: a diagram is drawn from it, and nothing in it runs.
    const src = code.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    // Drawn again when it comes out empty: mermaid measures its labels, and a frame the browser isn't painting (scrolled away,
    // a hidden window) measures everything as 0 and gets a 16px nothing. The next frame painted is the one to draw it in.
    const draw = `const p=document.querySelector(".mermaid"),s=p.textContent;let n=0;const draw=async()=>{await document.fonts.ready;p.removeAttribute("data-processed");p.textContent=s;await m.run({nodes:[p]});const w=p.querySelector("svg")?.viewBox?.baseVal?.width??99;if(w<=16&&++n<30)requestAnimationFrame(()=>setTimeout(draw,150))};await draw();`;
    // Says when it has drawn: until then the page is the diagram's source as text, which is not worth showing.
    // In the chat, a wide diagram shrinks to fit only so far: past 70% of its size its labels stop being readable, so it keeps
    // that size and scrolls sideways instead, and looks again whenever the column changes width.
    const fit = big
      ? ""
      : `const fit=()=>{const g=p.querySelector("svg");if(!g)return;const w=g.viewBox.baseVal.width;if(!w)return;const narrow=w*0.7>document.body.clientWidth;g.style.maxWidth=narrow?"none":w+"px";g.style.width=narrow?Math.round(w*0.7)+"px":"";g.style.flex=narrow?"none":"";document.body.style.overflowX=narrow?"auto":"";p.style.justifyContent=narrow?"flex-start":"center"};fit();new ResizeObserver(fit).observe(document.body);`;
    return `<!doctype html><html><head>${base}<style>${big ? `${fill}.mermaid{width:100%;height:100%}.mermaid svg{width:100%!important;height:100%!important;max-width:none!important}` : ""}.mermaid{display:flex;justify-content:center;margin:0;font:inherit}.mermaid svg{height:auto}.mermaid .node rect,.mermaid .node polygon,.mermaid .cluster rect{rx:9px;ry:9px}.mermaid .edgeLabel{font-size:12px;color:var(--muted)}</style></head><body><pre class="mermaid">${src}</pre><script type="module">import m from "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";m.initialize(${mermaidInit(t, dark)});${draw}${fit}addEventListener("message",e=>{if(e.data&&e.data.friday==="live-export")parent.postMessage({friday:"live-svg",svg:(p.querySelector("svg")||{}).outerHTML||""},"*")});parent.postMessage({friday:"live-drawn"},"*");</script>${panZoom(big)}${SIZER}</body></html>`;
  }
  // A page: the agent's own, with Friday's policy first in its head (a policy can only be narrowed by another, never widened).
  const doc = /<html[\s>]/i.test(code) ? code : `<!doctype html><html><head></head><body>${code}</body></html>`;
  const withHead = /<head[^>]*>/i.test(doc) ? doc.replace(/<head[^>]*>/i, (h) => `${h}${base}`) : doc.replace(/<html[^>]*>/i, (h) => `${h}<head>${base}</head>`);
  return /<\/body>/i.test(withHead) ? withHead.replace(/<\/body>/i, `${SIZER}</body>`) : `${withHead}${SIZER}`;
}

/** The height a block is drawn from, before it says its own: a page is usually taller than a diagram. */
const startHeight = (kind: LiveKind) => (kind === "html" ? 320 : 180);

/**
 * How tall each visual turned out, by what it is. A visual is drawn again whenever its place in the chat is redrawn: as it
 * finishes streaming, as its part of the answer is set aside as done, and when the saved message takes the stream's place.
 * Each of those used to start from the default height with a loading shimmer and jump to its own, so a finished chart
 * flickered two or three times. Drawn again, it now starts at its own height with no shimmer, and fades in where it was.
 */
const SEEN = new Map<string, number>();
// Trimmed: the block as it streamed and as it was saved can differ by the whitespace at their ends, and are the same visual.
const seenKey = (kind: LiveKind, code: string, tall: boolean) => `${kind}${tall ? ":big" : ""}\n${code.trim()}`;

const isDark = () => typeof document !== "undefined" && document.documentElement.classList.contains("dark");

/** Asks a drawn diagram for the SVG it became: set by the frame while it is showing, for Download. */
type Exporter = { current: (() => Promise<string>) | null };

function LiveFrame({ kind, code, tall, exporter }: { kind: LiveKind; code: string; tall?: boolean; exporter?: Exporter }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!exporter) return;
    exporter.current = () =>
      new Promise<string>((done) => {
        const w = frame.current?.contentWindow;
        if (!w) return done("");
        const on = (e: MessageEvent) => {
          if (e.source !== w || (e.data as { friday?: string })?.friday !== "live-svg") return;
          removeEventListener("message", on);
          done(String((e.data as { svg?: string }).svg ?? ""));
        };
        addEventListener("message", on);
        w.postMessage({ friday: "live-export" }, "*");
        setTimeout(() => (removeEventListener("message", on), done("")), 3000);
      });
    return () => {
      exporter.current = null;
    };
  }, [exporter]);
  const stage = useRef<HTMLDivElement>(null);
  const key = seenKey(kind, code, !!tall);
  const known = SEEN.get(key);
  const [h, setH] = useState(known ?? startHeight(kind));
  // Made once its place comes within a screen of being seen: every frame in a long conversation used to start loading its
  // libraries at once, far off screen. The stage keeps its height meanwhile, so the conversation doesn't move when it comes.
  // One already shown is drawn again at once.
  const [near, setNear] = useState(!!tall || known !== undefined);
  useEffect(() => {
    const el = stage.current;
    if (near || !el) return;
    // scrollMargin reaches through the conversation's own scroller, which rootMargin (the window's edge) does not.
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: "100% 0px", scrollMargin: "100% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  // The theme it was drawn in: redrawn when the app's changes, so a diagram is never dark text on a dark page.
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(isDark()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const d = e.data as { friday?: string; h?: number };
      if (d?.friday === "live-size" && typeof d.h === "number") {
        const next = Math.max(48, Math.min(d.h, 4000));
        SEEN.set(key, next);
        if (SEEN.size > 200) SEEN.delete(SEEN.keys().next().value!);
        setH(next);
        // Shown once it has said how tall it is; a diagram waits until it has drawn, since before that it is its source.
        if (kind !== "mermaid") setReady(true);
      }
      if (d?.friday === "live-drawn") setReady(true);
    };
    addEventListener("message", on);
    return () => removeEventListener("message", on);
  }, [kind, key]);
  const doc = useMemo(() => liveDocument(kind, code, dark, !!tall), [kind, code, dark, tall]);
  // Before it is ready it is a blank box while a library loads from the CDN; four seconds is as long as that is kept up.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(false), [doc]);
  useEffect(() => {
    if (ready || !near) return;
    const t = setTimeout(() => setReady(true), 4000);
    return () => clearTimeout(t);
  }, [ready, near, doc]);
  return (
    <div ref={stage} className={`live-stage ${ready ? "ready" : ""}`} style={{ height: tall ? "100%" : Math.min(h, 900) }}>
      {/* The shimmer is for a first drawing only: one drawn before waits at its own size and fades in. */}
      {!ready && known === undefined && <div className="live-loading" aria-hidden />}
      {/* What is on its way, said over the shimmer: an unlabelled grey slab sat there for seconds (the 2026-10-28 critique). */}
      {!ready && known === undefined && <div className="live-wait live-wait-soft" role="status"><Icon name={KINDS[kind].icon} size={13} /> {kind === "mermaid" ? "Drawing the diagram…" : kind === "svg" ? "Drawing it…" : "Loading the page…"}</div>}
      {near && (
        <iframe
          ref={frame}
          className="live-frame"
          title={KINDS[kind].label}
          // Scripts, and nothing else: no origin of its own, no forms, no popups, no navigating the app.
          sandbox="allow-scripts"
          srcDoc={doc}
          // The same scheme as the page around it, or the browser paints the frame's own opaque canvas behind it.
          style={{ colorScheme: dark ? "dark" : "light" }}
        />
      )}
    </div>
  );
}

/** A name for the file, from what the visual calls itself (its <title>, first heading or diagram title), else what it is. */
function fileName(kind: LiveKind, code: string): string {
  const said =
    code.match(/<title[^>]*>([^<]{1,80})<\/title>/i)?.[1] ??
    code.match(/<h[12][^>]*>([^<]{1,80})<\/h[12]>/i)?.[1] ??
    code.match(/^\s*title\s*:?\s*(.{1,80})$/im)?.[1] ??
    (kind === "html" ? "visual" : kind === "svg" ? "drawing" : "diagram");
  const slug = said.toLowerCase().replace(/&[a-z]+;/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "visual";
  return `${slug}.${kind === "html" ? "html" : "svg"}`;
}

function save(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** A fenced ```html, ```svg or ```mermaid block, drawn instead of printed (AnswerParts routes them here). */
export function LiveBlock({ code, language, isIncomplete }: CustomRendererProps) {
  const kind = (language.toLowerCase() === "svg" ? "svg" : language.toLowerCase() === "mermaid" ? "mermaid" : "html") as LiveKind;
  const [showCode, setShowCode] = useState(false);
  const [big, setBig] = useState(false);
  const [copied, setCopied] = useState(false);
  const meta = KINDS[kind];
  const exporter = useRef<(() => Promise<string>) | null>(null);
  /**
   * Download: a page as a page that opens on its own (in Friday's look, its libraries from the same CDNs), a drawing as its SVG,
   * a diagram as the SVG it was drawn to. A diagram not drawn yet (its code showing) goes as its source, still a valid file.
   */
  const download = async () => {
    const name = fileName(kind, code);
    if (kind === "html") return save(name, "text/html", liveDocument("html", code, isDark()));
    if (kind === "svg") return save(name, "image/svg+xml", /xmlns=/.test(code) ? code : code.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"'));
    const svg = (await exporter.current?.()) ?? "";
    if (svg) return save(name, "image/svg+xml", svg.includes("xmlns=") ? svg : svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"'));
    save(name.replace(/\.svg$/, ".mmd"), "text/plain", code);
  };
  // Full screen for real where the browser allows it (the desktop app does), the large view inside the window otherwise.
  // Leaving full screen (Esc) closes it, so one press is always the way back.
  const bigEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!big) return;
    const el = bigEl.current;
    let entered = false;
    void el?.requestFullscreen?.().then(() => (entered = true), () => {});
    const left = () => entered && !document.fullscreenElement && setBig(false);
    document.addEventListener("fullscreenchange", left);
    return () => {
      document.removeEventListener("fullscreenchange", left);
      if (document.fullscreenElement === el) void document.exitFullscreen().catch(() => {});
    };
  }, [big]);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  useEffect(() => {
    if (!big) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setBig(false);
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [big]);
  /** The block's header: in the chat, or (`inBig`) on the full-screen view, where its last button is the way out. */
  const head = (inBig: boolean) => (
    <div className="live-head">
      <span className="live-kind">
        <Icon name={meta.icon} size={13} />
        {meta.label}
      </span>
      {!isIncomplete && (
        <span className="live-acts">
          <button type="button" className={`live-btn ${showCode ? "on" : ""}`} aria-pressed={showCode} onClick={() => setShowCode((v) => !v)}>
            <Icon name="code" size={13} />
            Code
          </button>
          <button type="button" className="icon-btn tiny" title={copied ? "Copied" : "Copy the code"} aria-label="Copy the code" onClick={copy}>
            <Icon name={copied ? "check" : "copy"} size={13} />
          </button>
          <button type="button" className="icon-btn tiny" title={kind === "html" ? "Download it as a page" : "Download it as an SVG"} aria-label="Download" onClick={() => void download()}>
            <Icon name="download" size={13} />
          </button>
          {/* Full screen, the way out is a button that says so, as the Code toggle beside it does: a lone 13px shrink icon in a
              corner read as no way out but Esc (2026-10-28 QA; Arun: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"). */}
          {inBig ? (
            <button type="button" className="live-btn live-close" title="Leave full screen (Esc)" onClick={() => setBig(false)}>
              <Icon name="x" size={13} />
              Close
              <kbd>Esc</kbd>
            </button>
          ) : (
            <button type="button" className="icon-btn tiny" title="Full screen" aria-label="Full screen" onClick={() => setBig(true)}>
              <Icon name="expand" size={13} />
            </button>
          )}
        </span>
      )}
    </div>
  );
  // While the agent is still writing it, the code as it arrives: drawing half a page only flickers.
  // While it is written, the same box it will be drawn in, at the height the drawing starts from: the block keeps one shape
  // from its first line to the finished drawing, and only eases to its own height at the end. A short note that became a
  // taller frame that became the drawing jumped twice.
  if (isIncomplete) {
    return (
      <div className="live-block drawing">
        {head(false)}
        <div className="live-stage" style={{ height: startHeight(kind) }}>
          <div className="live-loading" aria-hidden />
          <div className="live-wait" role="status">
            <span className="spinner tiny" /> Drawing it as it's written…
          </div>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="live-block">
        {head(false)}
        {showCode ? <pre className="live-code"><code>{code}</code></pre> : <LiveFrame kind={kind} code={code} exporter={exporter} />}
      </div>
      {big &&
        createPortal(
          <div className="overlay live-overlay" onClick={(e) => e.target === e.currentTarget && setBig(false)}>
            <div ref={bigEl} className="live-block big" role="dialog" aria-label={meta.label}>
              {head(true)}
              <LiveFrame kind={kind} code={code} tall />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}


/** A picture's address on this computer, as the session serves it; null for one on the web (or Friday's own). */
/** The session the chat being drawn is, for a page whose address doesn't say (SessionView sets it). */
export const pictureSession: { sid: string; invite: string } = { sid: "", invite: "" };

export function localPicture(src: string): string | null {
  const q = new URLSearchParams(location.search);
  const sid = q.get("session") || pictureSession.sid;
  const invite = q.get("invite") || pictureSession.invite;
  if (!sid || !invite || /^(https?:|data:|blob:)/i.test(src) || src.startsWith("/api/")) return null;
  const at = `/api/sessions/${encodeURIComponent(sid)}/work/file?invite=${encodeURIComponent(invite)}`;
  const file = src.replace(/^file:\/\//i, "");
  if (file.startsWith("/") || /^[a-z]:[\\/]/i.test(file) || file.startsWith("~/")) return `${at}&abs=${encodeURIComponent(decodeURI(file))}`;
  return `${at}&path=${encodeURIComponent(decodeURI(file.replace(/^\.\//, "")))}`;
}

/** A picture in a message: shown at its size up to the column's width, and large on a press. */
export function LiveImage(props: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [big, setBig] = useState(false);
  const { node: _node, ...rest } = props as typeof props & { node?: unknown };
  let enlarge = () => setBig(true);
  // A picture an agent shows by where it is on this computer (/Users/…/shot.png, file://…, or a path in its folder): from there,
  // through the session (work-files.ts shownFile). The session is the page's own (?session=…&invite=…).
  const src = typeof rest.src === "string" ? localPicture(rest.src) : null;
  // A picture still being written fails to load once or twice before it is whole: asked again twice, a moment apart, before it
  // is said to be missing, and then with a way to ask again (Arun, 2026-10-28: "iron everything and ensure we are good").
  const [tries, setTries] = useState(0);
  const [gone, setGone] = useState(false);
  const own = src ?? (typeof rest.src === "string" && rest.src.startsWith("/api/") ? rest.src : null);
  if (own) (rest as { src?: string }).src = tries ? `${own}${own.includes("?") ? "&" : "?"}try=${tries}` : own;
  if (gone)
    return (
      <span className="chat-media-gone">
        {props.alt || "A picture"} isn't on this computer, or isn't finished yet.{" "}
        {own && (
          <button type="button" className="link-btn" onClick={() => (setGone(false), setTries((n) => n + 1))}>
            Try again
          </button>
        )}
      </span>
    );
  (rest as { onError?: () => void }).onError = () => (own && tries < 2 ? void window.setTimeout(() => setTries((n) => n + 1), 1500 * (tries + 1)) : setGone(true));
  // In a Work session a picture from its folder opens in the rail's one picture viewer, with its title, Copy, Download and Show in
  // folder, among the others beside it (WorkRail, friday:work-open), not a second viewer of its own with a path for a caption
  // (Arun, 2026-10-28: "iron everything… focusing on UI and UX"; the critique's "make one viewer").
  const named = typeof props.src === "string" ? props.src.replace(/^file:\/\//i, "") : "";
  if (src && named && !/^(\/|~|[a-z]:[\\/])/i.test(named) && document.documentElement.classList.contains("work-session")) enlarge = () => dispatchEvent(new CustomEvent("friday:work-open", { detail: { path: named } }));
  return (
    <>
      <img {...rest} className="live-img" loading="lazy" onClick={() => enlarge()} />
      {big && props.src && <Lightbox src={props.src} alt={props.alt ?? ""} onClose={() => setBig(false)} />}
    </>
  );
}
