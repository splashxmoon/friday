import { useEffect, useRef, useState } from "react";
import { call } from "./Computers.js";
import { pollWhileShown } from "./app-push.js";
import { Icon } from "./icons.js";

/**
 * Linking a computer in two clicks (local/nearby.ts; Arun, 2026-11-21: "make it way easier to link up machines too"): Add a
 * computer › Nearby lists the Fridays on this network, Link offers one this computer's pairing, and that one asks its person
 * (LinkOffers, below) with a check number both screens show.
 */

interface Found {
  id: string;
  name: string;
  platform: string;
  version: string;
  address: string;
  linked: boolean;
  usedFromAnother: boolean;
}
const OS: Record<string, string> = { darwin: "Mac", linux: "Linux", win32: "Windows" };

/** Add a computer › Nearby. */
export function NearbyLink() {
  const [found, setFound] = useState<Found[] | null>(null);
  const [asked, setAsked] = useState<{ id: string; name: string; check: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let gone = false;
    const look = () => void call<{ found: Found[] }>("/api/computers/nearby").then((r) => !gone && setFound(r.found), () => !gone && setFound((f) => f ?? []));
    look();
    const t = setInterval(look, 4000);
    return () => ((gone = true), clearInterval(t));
  }, []);
  const link = async (f: Found) => {
    setBusy(f.id);
    setError("");
    try {
      const r = await call<{ name: string; check: string; error?: string }>("/api/computers/nearby/link", { method: "POST", body: JSON.stringify({ id: f.id }) });
      setAsked({ id: f.id, name: r.name, check: r.check });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const done = found?.find((f) => f.id === asked?.id)?.linked;
  return (
    <div className="computers-add-body nearby">
      {asked && !done ? (
        <div className="nearby-asked">
          <p className="small">
            On <b>{asked.name}</b>, press <b>Allow</b>. Both screens show the same number:
          </p>
          <div className="nearby-check" aria-label={`Check number ${asked.check}`}>
            {asked.check}
          </div>
          <p className="muted small">Waiting for {asked.name}… The offer lasts ten minutes.</p>
        </div>
      ) : (
        <>
          <p className="muted small">Any computer with Friday open on this Wi-Fi shows up here. Link it, then press Allow on it.</p>
          <ul className="nearby-list">
            {found === null && <li className="muted small nearby-empty"><span className="nearby-pulse" aria-hidden />Looking…</li>}
            {found?.length === 0 && <li className="muted small nearby-empty"><span className="nearby-pulse" aria-hidden />Looking… Open Friday on the other computer.</li>}
            {found?.map((f) => (
              <li key={f.id}>
                <Icon name="server" size={14} />
                <span className="nearby-name">{f.name}</span>
                <span className="muted small">{[OS[f.platform] ?? f.platform, f.version && `Friday ${f.version}`].filter(Boolean).join(" · ")}</span>
                {f.linked ? (
                  <span className="nearby-done small">Linked</span>
                ) : (
                  <button type="button" className="btn small primary" disabled={!!busy} onClick={() => void link(f)} title={f.usedFromAnother ? "It's linked to another computer now: linking it here moves it" : undefined}>
                    {busy === f.id ? "Asking…" : "Link"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {done && <p className="small computers-said ok">{asked?.name} is linked.</p>}
      {error && <p className="small computers-said bad">{error}</p>}
    </div>
  );
}

/**
 * On the computer being linked: "Maya's MacBook Pro wants to run agents on this computer", with its check number, Allow or Don't.
 * Polled while Friday is open here (local edition only); one offer at a time, newest first.
 */
export function LinkOffers() {
  const [offers, setOffers] = useState<{ from: string; name: string; check: string; until: number }[]>([]);
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let gone = false;
    const look = () => void call<{ offers: typeof offers }>("/api/computers/offers").then((r) => !gone && setOffers((was) => (JSON.stringify(was) === JSON.stringify(r.offers) ? was : r.offers)), () => {});
    // Asked when an offer comes (app-push.ts), not every 3 seconds; as before where nothing tells it.
    const stop = pollWhileShown(look, { every: 3000, on: ["offers"] });
    return () => ((gone = true), stop());
  }, []);
  const o = offers[0];
  const ref = useRef<HTMLDivElement>(null);
  const answer = async (allow: boolean) => {
    if (!o) return;
    setBusy(true);
    try {
      const r = await call<{ hub?: { connected?: boolean } | null; error?: string }>(`/api/computers/offers/${o.from}`, { method: "POST", body: JSON.stringify({ allow }) });
      setSaid(allow ? (r.error ? r.error : `Linked to ${o.name}. Its agents can run here now.`) : "");
    } catch (e) {
      setSaid((e as Error).message);
    } finally {
      setBusy(false);
      setOffers((l) => l.slice(1));
    }
  };
  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(""), 6000);
    return () => clearTimeout(t);
  }, [said]);
  if (!o) return said ? <div className="nearby-toast small">{said}</div> : null;
  return (
    <div className="overlay nearby-over">
      <div ref={ref} className="modal nearby-offer" role="alertdialog" aria-modal="true" aria-label={`${o.name} wants to link`}>
        <h2>Link to {o.name}?</h2>
        <p className="muted small">
          {o.name} wants to run agents on this computer, with your coding tools here. Check that it shows the same number:
        </p>
        <div className="nearby-check">{o.check}</div>
        <p className="muted small">Only allow it if you started this on {o.name}. You can remove it any time in Settings › Other computers.</p>
        <div className="nearby-actions">
          <button type="button" className="btn small" disabled={busy} onClick={() => void answer(false)}>
            Don't allow
          </button>
          <button type="button" className="btn small primary" disabled={busy} onClick={() => void answer(true)}>
            {busy ? "Linking…" : "Allow"}
          </button>
        </div>
      </div>
    </div>
  );
}
