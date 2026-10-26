/**
 * A usage limit, drawn the one way it is drawn everywhere: a ring that fills as the limit is used, green with room, yellow
 * from 70%, red from 90%, whatever the tool. The Usage hub, the limits card by the message box and the rail, and the Agents
 * panel all use it, so a limit looks the same wherever it is read.
 */

/** Green, yellow or red, by how much of a limit is used. */
export const limitLevel = (used: number | null) => (used === null ? "none" : used >= 90 ? "hot" : used >= 70 ? "warm" : "ok");

export function LimitRing({ used, size = 64, label, showValue = true }: { used: number | null; size?: number; /** Spoken: "5-hour limit". */ label?: string; showValue?: boolean }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const pct = used === null ? 0 : Math.max(0, Math.min(100, used));
  // A thinner stroke on a small ring keeps the hole readable; the number inside scales with the ring.
  const stroke = size >= 56 ? 5 : size >= 36 ? 6 : 7;
  return (
    <span className={`limit-ring ${limitLevel(used)}`} style={{ width: size, height: size, fontSize: Math.max(9.5, Math.round(size * 0.2)) }} role="img" aria-label={`${label ?? "Limit"}: ${used === null ? "not reported" : `${Math.round(pct)}% used`}`}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="limit-ring-track" />
        {used !== null && <circle cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 32 32)" />}
      </svg>
      {showValue && <span className="limit-ring-n">{used === null ? "—" : `${Math.round(pct)}%`}</span>}
    </span>
  );
}
