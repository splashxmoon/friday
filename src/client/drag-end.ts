/**
 * A drag that always ends when the person lets go (Arun, 2026-11-05: "it still thinks im dragging when im not").
 *
 * A resize listened for the release on the window, so a release over the preview's page (an iframe), over another app or outside
 * the window never came, and the seam went on following the pointer. Now the grip holds the pointer (its moves and release come to
 * it wherever they happen), and the drag ends on whichever comes first: the release, the system cancelling it, the grip losing the
 * pointer, the window losing focus, or a move with no button down (the release happened somewhere it couldn't be heard).
 *
 * `end` runs once, whichever way it ends: its own release listener calls `stop` too. `live(ev)`, asked first on each move, is
 * false once the drag has ended, so that move is ignored.
 */
export function dragEnds(e: { currentTarget: EventTarget; pointerId: number }, end: () => void): { live: (ev: PointerEvent) => boolean; stop: () => void } {
  const grip = e.currentTarget as HTMLElement;
  let over = false;
  const finish = () => {
    if (over) return;
    over = true;
    grip.removeEventListener("lostpointercapture", finish);
    removeEventListener("blur", finish);
    try {
      if (grip.hasPointerCapture?.(e.pointerId)) grip.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    end();
  };
  try {
    grip.setPointerCapture?.(e.pointerId);
  } catch {
    // A pointer the browser no longer has: the checks below still end it.
  }
  grip.addEventListener("lostpointercapture", finish);
  addEventListener("blur", finish);
  return {
    live: (ev) => {
      if (over) return false;
      if (ev.buttons === 0) {
        finish();
        return false;
      }
      return true;
    },
    stop: finish,
  };
}
