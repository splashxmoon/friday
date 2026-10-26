import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { childEnv } from "./adapters.js";
import { hidHelper, hidWarm } from "./ios-hid.js";
import { axePath, iosInput, type IosInput } from "./ios.js";

/**
 * The iOS preview live, on the Mac it runs on (Arun, 2026-10-18: "this feels slow and not responsive at all"). A frame at a
 * time through Friday was a screenshot every 700ms, sent through the server and back as text. This instead is a page served
 * by the runner on 127.0.0.1, which the Preview panel shows as it shows a dev server: the simulator's screen as a live stream
 * (AXe's stream-video, MJPEG at up to 30 frames a second), and touches, swipes and typing sent straight back to the runner on
 * the same machine. Nothing goes through Friday, and nothing listens beyond this computer: the address carries a token made
 * when the runner started, and only these three paths answer.
 */

const TOKEN = randomBytes(18).toString("base64url");
const UDID = /^[0-9A-F-]{36}$/i;
let server: http.Server | null = null;
let port = 0;

/** The live view's address for a simulator, starting the little server the first time it is asked for. */
export async function iosLiveUrl(udid: string): Promise<{ url: string } | { error: string }> {
  if (!UDID.test(udid)) return { error: "That isn't a simulator." };
  const axe = axePath();
  if (!axe) return { error: "Install AXe to see the simulator live: brew install cameroncooke/axe/axe" };
  // The touch helper, made ready while the view loads, so the first press is as quick as the rest.
  hidWarm(axe, udid);
  if (!server) {
    const s = http.createServer(handle);
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => resolve());
    });
    port = (s.address() as { port: number }).port;
    server = s;
  }
  return { url: `http://127.0.0.1:${port}/${TOKEN}/view/${udid}` };
}

function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const m = (req.url ?? "").match(/^\/([\w-]+)\/(view|stream|input)\/([0-9A-Fa-f-]{36})(?:\?(.*))?$/);
  if (!m || m[1] !== TOKEN || !UDID.test(m[3]!)) {
    res.writeHead(404).end();
    return;
  }
  const [, , what, udid] = m;
  res.setHeader("Cache-Control", "no-store");
  if (what === "view" && req.method === "GET") return void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page(udid!));
  if (what === "stream" && req.method === "GET") return stream(udid!, new URLSearchParams(m[4] ?? ""), req, res);
  if (what === "input" && req.method === "POST") return void input(udid!, req, res);
  res.writeHead(405).end();
}

/**
 * The simulator's screen as MJPEG (Arun, 2026-10-20: Friday's picture was "softer and less smooth" than Claude's own
 * simulator panel). The touch helper (ios-hid.ts) reads the simulator's display surface as it is drawn and sends a frame
 * each time it changes, up to 60 a second, as wide as the page asks (its own width in device pixels, so nothing is
 * stretched); AXe's stream-video, the fallback, takes a screenshot a frame and managed about 18 a second. A helper not
 * built within a few seconds (the first time on this Mac), or one that stops before its first frame, leaves the page with
 * AXe's. Frames are passed on whole, and dropped rather than queued when the page is behind, so it never lags the screen.
 */
function stream(udid: string, q: URLSearchParams, req: http.IncomingMessage, res: http.ServerResponse) {
  const axe = axePath();
  if (!axe) return void res.writeHead(503).end();
  const num = (k: string, lo: number, hi: number, d: number) => Math.min(hi, Math.max(lo, Number(q.get(k)) || d));
  const width = num("w", 100, 4000, 800);
  res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=mjpegstream", Connection: "close" });
  let child: ChildProcess | null = null;
  let gone = false;
  const stop = () => {
    gone = true;
    if (child && !child.killed) child.kill("SIGTERM");
  };
  req.on("close", stop);
  res.on("close", stop);
  // One part at a time: "--mjpegstream", its headers with the JPEG's length, the JPEG, a line end.
  let buf: Buffer = Buffer.alloc(0);
  let parts = 0;
  const pass = (d: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    for (;;) {
      const head = buf.indexOf("\r\n\r\n");
      if (head < 0) return;
      const len = Number(/Content-Length:\s*(\d+)/i.exec(buf.subarray(0, head).toString("latin1"))?.[1]);
      if (!Number.isFinite(len)) return void (buf = Buffer.alloc(0));
      const end = head + 4 + len + 2;
      if (buf.length < end) return;
      parts++;
      if (res.writableLength < 2 * 1024 * 1024) res.write(buf.subarray(0, end));
      buf = buf.subarray(end);
    }
  };
  const viaAxe = () => {
    if (gone) return;
    // Its scale is of the screen's own pixels, about 1200 wide on most iPhones.
    const c = spawn(axe, ["stream-video", "--udid", udid, "--format", "mjpeg", "--fps", "30", "--quality", String(Math.round(num("q", 0.3, 0.95, 0.8) * 100)), "--scale", Math.min(1, width / 1200).toFixed(2)], { env: childEnv(), stdio: ["ignore", "pipe", "ignore"] });
    child = c;
    // AXe writes a whole HTTP response: its status line and headers are skipped, the parts after them passed on.
    let head = Buffer.alloc(0);
    let started = false;
    c.stdout.on("data", (d: Buffer) => {
      if (started) return pass(d);
      head = Buffer.concat([head, d]);
      const at = head.indexOf("\r\n\r\n");
      if (at < 0) return;
      started = true;
      pass(head.subarray(at + 4));
    });
    c.on("exit", () => res.end());
  };
  void (async () => {
    const exe = await Promise.race([hidHelper(axe), new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
    if (!exe || gone) return viaAxe();
    const c = spawn(exe, [udid, "stream", String(width), String(num("q", 0.3, 0.95, 0.8)), String(num("fps", 5, 60, 60))], { env: childEnv(), stdio: ["ignore", "pipe", "ignore"] });
    child = c;
    c.on("error", () => {});
    c.stdout.on("data", pass);
    c.on("exit", () => (parts ? res.end() : viaAxe()));
  })();
}

async function input(udid: string, req: http.IncomingMessage, res: http.ServerResponse) {
  let body = "";
  for await (const c of req) {
    body += c;
    if (body.length > 64 * 1024) return void res.writeHead(413).end();
  }
  let parsed: IosInput;
  try {
    parsed = JSON.parse(body) as IosInput;
  } catch {
    return void res.writeHead(400).end();
  }
  const r = await iosInput(udid, parsed);
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(r));
}

/** The live view: the stream filling the page, and what is pressed and typed on it sent back. Shown inside the phone's frame. */
function page(udid: string): string {
  const base = `/${TOKEN}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;height:100%;background:#000;overflow:hidden;user-select:none;-webkit-user-select:none}
img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;-webkit-user-drag:none;cursor:pointer}
.dot{position:absolute;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:rgba(255,255,255,.45);box-shadow:0 0 0 1px rgba(0,0,0,.15);pointer-events:none;animation:press .45s ease-out forwards}
.trail{position:absolute;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:rgba(255,255,255,.35);pointer-events:none;animation:fade .4s ease-out forwards}
@keyframes press{from{transform:scale(.5);opacity:1}to{transform:scale(1.4);opacity:0}}
@keyframes fade{to{opacity:0}}
.wait{position:absolute;inset:0;display:grid;place-items:center;color:#a1a1aa;font:13px -apple-system,system-ui,sans-serif}
</style></head><body tabindex="0">
<div class="wait" id="wait">Connecting to the simulator…</div>
<img id="s" alt="" draggable="false">
<script>
const base=${JSON.stringify(base)}, udid=${JSON.stringify(udid)};
const img=document.getElementById("s"), wait=document.getElementById("wait");
let tries=0;
// As wide as the page is in the screen's own pixels, asked again when that changes by a tenth (the panel zoomed).
let wide=0;
const want=()=>Math.round(innerWidth*(devicePixelRatio||1));
const connect=()=>{wide=want();img.src=base+"/stream/"+udid+"?w="+wide+"&q=0.8&t="+Date.now();};
let resized=0;
addEventListener("resize",()=>{clearTimeout(resized);resized=setTimeout(()=>{if(Math.abs(want()-wide)>wide*0.1)connect();},300);});
img.onload=()=>{wait.style.display="none";tries=0;};
img.onerror=()=>{wait.style.display="grid";wait.textContent="The simulator isn't streaming. Trying again…";setTimeout(connect,Math.min(5000,500*++tries));};
connect();
// Sent one at a time, in order: a finger's moves while one is on its way are folded into the newest, so a drag never queues
// up behind itself, and a lift never overtakes the move before it.
const out=[];let busy=false;
const pump=()=>{if(busy||!out.length)return;busy=true;const i=out.shift();fetch(base+"/input/"+udid,{method:"POST",body:JSON.stringify(i)}).catch(()=>{}).finally(()=>{busy=false;pump();});};
const send=(i)=>{const last=out[out.length-1];if(i.kind==="move"&&last&&last.kind==="move")out[out.length-1]=i;else out.push(i);pump();};
const at=(e)=>{const r=img.getBoundingClientRect();return{x:Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),y:Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))};};
const mark=(e,cls)=>{const d=document.createElement("i");d.className=cls;d.style.left=e.clientX+"px";d.style.top=e.clientY+"px";document.body.appendChild(d);setTimeout(()=>d.remove(),500);};
// The finger goes down, moves and lifts in the simulator as it does here: a press is held as long as it is held here, and a
// drag scrolls with it.
let down=null;
img.addEventListener("pointerdown",(e)=>{if(e.button!==0||down)return;e.preventDefault();document.body.focus();try{img.setPointerCapture(e.pointerId)}catch{}const p=at(e);down={...p,id:e.pointerId,n:0};send({kind:"down",...p});mark(e,"dot");});
img.addEventListener("pointermove",(e)=>{if(!down||down.id!==e.pointerId)return;const p=at(e);down.x=p.x;down.y=p.y;send({kind:"move",...p});if(++down.n%2===0)mark(e,"trail");});
const lift=(e)=>{if(!down||(e&&down.id!==e.pointerId))return;const p=e&&e.type==="pointerup"?at(e):down;down=null;send({kind:"up",x:p.x,y:p.y});};
img.addEventListener("pointerup",lift);
img.addEventListener("pointercancel",lift);
window.addEventListener("pagehide",()=>lift());
const KEYS={Enter:40,Escape:41,Backspace:42,Tab:43,Delete:76,ArrowRight:79,ArrowLeft:80,ArrowDown:81,ArrowUp:82};
let typed="",timer=0;
const flush=()=>{const t=typed;typed="";if(t)send({kind:"type",text:t});};
document.addEventListener("keydown",(e)=>{if(e.metaKey||e.ctrlKey||e.altKey)return;const k=KEYS[e.key];if(k!==undefined){e.preventDefault();clearTimeout(timer);flush();send({kind:"key",code:k});return;}
 if(e.key.length!==1)return;e.preventDefault();typed+=e.key;clearTimeout(timer);timer=setTimeout(flush,120);});
document.addEventListener("paste",(e)=>{const t=e.clipboardData&&e.clipboardData.getData("text/plain");if(t){e.preventDefault();send({kind:"type",text:t});}});
window.addEventListener("message",(e)=>{if(e.data&&e.data.friday==="ios-home")send({kind:"button",name:"home"});});
</script></body></html>`;
}
