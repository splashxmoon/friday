// The routes of "Keep this going" (crew-carry.ts) from the page: one small fetch helper, its errors said in words. Apart from
// crew-carry-open.tsx, which every page loads, so the first load carries none of it.
/** A route of Keep this going (crew-carry.ts), its error said in words. */
export async function carryReq<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, credentials: "same-origin", headers: { "Content-Type": "application/json", ...init.headers } });
  } catch {
    throw new Error("Couldn't reach Friday. Try again.");
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? (res.status === 404 ? "Not there yet." : "Couldn't reach Friday. Try again."));
  return body;
}
