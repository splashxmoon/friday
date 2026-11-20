/** The seq of the newest instruction of mine: the one message an offer is made for. Looked up once per list of events, not per row. */
const latestMemo = new WeakMap<object, { len: number; seq: number | undefined }>();
export function latestOwn(events: readonly { seq: number; actor: { id: string }; body: { type: string; approval?: unknown } }[], meId: string): number | undefined {
  const hit = latestMemo.get(events);
  if (hit && hit.len === events.length) return hit.seq;
  const seq = events.findLast((e) => e.body.type === "instruction" && e.actor.id === meId && !e.body.approval)?.seq;
  latestMemo.set(events, { len: events.length, seq });
  return seq;
}
