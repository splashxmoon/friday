// All keys for one session share the `{sid}` hash tag so they land in the same
// Redis Cluster slot — required for the multi-key append script.
export function sessionKeys(prefix: string, sid: string) {
  const base = `${prefix}{${sid}}`;
  return {
    events: `${base}:events`, // LIST of JSON events; seq = 1-based index
    control: `${base}:control`, // HASH driver:<lane>, driverName:<lane>, epoch:<lane>
    members: `${base}:members`, // HASH userId -> {name, role}
    presence: `${base}:presence`, // HASH userId -> open connection count
    seen: `${base}:seen`, // HASH userId -> last seq acknowledged
    runner: `${base}:runner`, // STRING lease (main lane); per-lane via runnerFor
    runnerFor: (lane: string) => `${base}:runner:${lane}`, // one lease per lane, so lanes run at once
    bus: `${base}:bus`, // pub/sub channel
    shielded: `${base}:shielded`, // STRING how many of the log's first events the secret shield has checked as read (store.loadAll)
    heldDiff: (lane: string) => `${base}:diff:${lane}`, // STRING the change set of a coding turn still running, not logged yet (engine/hub.ts)
    gone: `${prefix}gone:{${sid}}`, // STRING set when the session is deleted, for a while: a late write to it is refused (store.bury)
  };
}

export type SessionKeys = ReturnType<typeof sessionKeys>;

export const wakeChannel = (prefix: string) => `${prefix}wake`;
