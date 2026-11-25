/**
 * A proof card's end has to land (app.ts testWork and proveRun). A check or a clip says each step in the chat ("Running the tests",
 * "Walking the page that changed"), and the card shows that step, counting, until a newer one comes. Its "failed" was appended with
 * its error swallowed, so one that didn't go through left the card on "testing" for ever (spec 13, "What can break" 12). So the end
 * is tried again, waiting a little longer each time, and said in the log when it never lands.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `append` until it goes through, `tries` times at most; false when it never did. Never throws. */
export async function appendSurely(append: () => Promise<unknown>, what: string, o: { tries?: number; waitMs?: number } = {}): Promise<boolean> {
  const tries = Math.max(1, o.tries ?? 3);
  for (let i = 0; i < tries; i++) {
    try {
      await append();
      return true;
    } catch (e) {
      if (i === tries - 1) {
        console.error(`[proof] ${what} couldn't be saved after ${tries} tries: ${(e as Error)?.message ?? String(e)}`);
        return false;
      }
      await sleep((o.waitMs ?? 500) * 2 ** i);
    }
  }
  return false;
}
