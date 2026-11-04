/**
 * Your own models by the server they're on (issue #17's follow-up, 2026-11-04: several models from one router read as one flat list,
 * every row saying "Another server · key saved here"): one group per address, the server said once, its models under it.
 */
export interface OwnGroup<T> {
  baseUrl: string;
  /** Where it is, as a person reads an address: host and path, no scheme. */
  host: string;
  provider?: string;
  local: boolean;
  /** Whether its models carry a key: all, some or none. */
  keyed: "all" | "some" | "none";
  models: T[];
}

const hostOf = (baseUrl: string) => {
  try {
    const u = new URL(baseUrl);
    return `${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return baseUrl;
  }
};

/** In the order they were saved: a server where its first model was added, its models in theirs. */
export function groupOwn<T extends { baseUrl: string; provider?: string; local: boolean; hasKey: boolean }>(models: T[]): OwnGroup<T>[] {
  const by = new Map<string, OwnGroup<T>>();
  for (const m of models) {
    const key = m.baseUrl.trim().replace(/\/+$/, "");
    let g = by.get(key);
    if (!g) by.set(key, (g = { baseUrl: key, host: hostOf(key), ...(m.provider ? { provider: m.provider } : {}), local: m.local, keyed: "none", models: [] }));
    g.models.push(m);
  }
  for (const g of by.values()) {
    const n = g.models.filter((m) => m.hasKey).length;
    g.keyed = n === 0 ? "none" : n === g.models.length ? "all" : "some";
  }
  return [...by.values()];
}
