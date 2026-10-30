import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { Switch } from "./ui.js";

/**
 * Settings › Computer & coding tools › Your phone (local/phone.ts): let a phone reach the Friday on this computer, pair one with
 * the code on screen, and see and remove the phones paired. Over Wi-Fi or Tailscale, nothing through Friday's servers (Arun,
 * 2026-10-30: phone access, paired over Wi-Fi or Tailscale).
 */
interface State {
  on: boolean;
  listening: boolean;
  port: number | null;
  addresses: { address: string; via: "wifi" | "tailscale" }[];
  secure: boolean;
  /** Phones, and your other computers (Your computers lists those). */
  devices: { id: string; name: string; kind?: "phone" | "computer"; at: number; seen: number }[];
  error?: string;
}

const call = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
  const r = await fetch(path, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json", ...init.headers } });
  const b = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(b.error || "Couldn't reach Friday.");
  return b;
};

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 2 ? "just now" : m < 60 ? `${m} minutes ago` : m < 48 * 60 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`;
};

/** The code as a picture to scan: an SVG of its dark modules, in the page's ink on its own light ground so any camera reads it. */
function Qr({ text, size = 176 }: { text: string; size?: number }) {
  const path = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + 4},${r + 4}h1v1h-1z`;
    return { d, n: n + 8 };
  }, [text]);
  return (
    <svg className="phone-qr" width={size} height={size} viewBox={`0 0 ${path.n} ${path.n}`} role="img" aria-label="Code to scan with the Friday app on your phone" shapeRendering="crispEdges">
      <rect width={path.n} height={path.n} fill="#fff" />
      <path d={path.d} fill="#111" />
    </svg>
  );
}

export function PhoneSettings() {
  const [state, setState] = useState<State | null>(null);
  const [code, setCode] = useState<{ code: string; until: number; link: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [code]);
  const read = () => void call<State>("/api/phone").then(setState, () => {});
  useEffect(() => {
    read();
    // Phones pairing, and when each was last here, as they happen.
    const t = setInterval(read, 5_000);
    return () => clearInterval(t);
  }, []);
  // A new phone, paired with the code on screen: the code has done its work.
  const paired = state?.devices.filter((d) => d.kind !== "computer").length ?? 0;
  const [had, setHad] = useState<number | null>(null);
  useEffect(() => {
    if (had !== null && paired > had) setCode(null);
    setHad(paired);
  }, [paired]); // eslint-disable-line react-hooks/exhaustive-deps
  // The code runs out after ten minutes: offer a new one rather than leave one that won't work.
  useEffect(() => {
    if (!code) return;
    const t = setTimeout(() => setCode(null), Math.max(0, code.until - Date.now()));
    return () => clearTimeout(t);
  }, [code]);
  if (!state) return null;
  const phones = state.devices.filter((d) => d.kind !== "computer");

  const setOn = async (on: boolean) => {
    setBusy(true);
    setError("");
    try {
      const s = await call<State>("/api/phone", { method: "POST", body: JSON.stringify({ on }) });
      setState(s);
      if (!on) setCode(null);
      else if (s.listening && !s.devices.length) await newCode();
      if (s.error) setError(s.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const newCode = async () => {
    setError("");
    try {
      const c = await call<{ code: string; until: number; link: string } | { error: string }>("/api/phone/code", { method: "POST" });
      if ("error" in c) setError(c.error);
      else setCode(c);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const forget = async (id: string) => setState(await call<State>(`/api/phone/devices/${id}`, { method: "DELETE" }).catch(() => state));

  const where = state.addresses.length
    ? state.addresses.some((a) => a.via === "tailscale")
      ? state.addresses.some((a) => a.via === "wifi")
        ? "on this Wi-Fi, or anywhere through Tailscale"
        : "through Tailscale"
      : "on this Wi-Fi"
    : "";
  return (
    <div className="set-card phone-set">
      <div className="set-row">
        <div className="set-text">
          <div className="set-label">Your phone</div>
          <div className="muted small">
            {state.listening
              ? `Your phone can reach Friday here ${where}. Nothing goes through Friday's servers.`
              : "Answer your agents and crew from the Friday app on your iPhone, over Wi-Fi or Tailscale. Nothing goes through Friday's servers."}
          </div>
        </div>
        <Switch on={state.on} label="Let your phone connect" disabled={busy} onChange={(on) => void setOn(on)} />
      </div>
      {state.listening && (
        <div className="phone-pair">
          {code ? (
            <div className="phone-code">
              <Qr text={code.link} />
              {/* The code is only ever scanned or pasted whole: it carries this computer's certificate, which the phone checks, and a
                  code typed by hand would not (Security review of the phone listener, 3). */}
              <div className="phone-code-text">
                <b>Scan this with your iPhone's camera</b>
                <span className="muted small">It opens the Friday app and connects it. It works once, for ten minutes.</span>
                <span className="phone-code-actions">
                  <button type="button" className="btn small" onClick={() => void navigator.clipboard.writeText(code.link).then(() => setCopied(true), () => {})}>
                    {copied ? "Copied" : "Copy link"}
                  </button>
                  <button type="button" className="link-btn" onClick={() => setCode(null)}>
                    Done
                  </button>
                </span>
                <span className="muted small">The link does the same, pasted in the app.</span>
              </div>
            </div>
          ) : (
            <button type="button" className="btn small" onClick={() => void newCode()}>
              {phones.length ? "Pair another phone" : "Pair a phone"}
            </button>
          )}
          {!state.secure && <p className="muted small phone-note">This computer can't make a certificate (no openssl), so phones connect through Tailscale only.</p>}
        </div>
      )}
      {phones.length > 0 && (
        <ul className="phone-devices" aria-label="Paired phones">
          {phones.map((d) => (
            <li key={d.id}>
              <span className="phone-device-name">{d.name}</span>
              <span className="muted small">{d.seen - d.at < 60_000 ? `Paired ${ago(d.at)}` : `Last here ${ago(d.seen)}`}</span>
              <button type="button" className="link-btn" onClick={() => void forget(d.id)} aria-label={`Remove ${d.name}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {(error || state.error) && <p className="phone-error small">{error || state.error}</p>}
    </div>
  );
}
