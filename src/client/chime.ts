/**
 * One soft chime, and nothing otherwise.
 *
 * Somebody with three sessions running comes to rely on the one sound that means "something needs you". Two short
 * sine notes, made here rather than loaded, so there is no file to fetch and nothing to fail. A browser that has had no
 * click yet may keep the audio context suspended; then the chime is skipped, which is the quiet default anyway.
 */
let ctx: AudioContext | null = null;

/**
 * How loud each note peaks. A Mac's speakers make a quiet sine at this pitch easy to miss (Arun, 2026-10-19: "a little bit
 * louder... for mac"), so there it is a little over twice the gain, about 7 dB, still well clear of clipping with both notes
 * overlapping. Elsewhere as it was.
 */
const PEAK = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent) ? 0.2 : 0.09;

export function chime(): void {
  try {
    const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime;
    const note = (hz: number, at: number, dur: number) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      o.type = "sine";
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(PEAK, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g).connect(ctx!.destination);
      o.start(at);
      o.stop(at + dur + 0.05);
    };
    note(880, t, 0.32);
    note(1174.66, t + 0.16, 0.48);
  } catch {
    // No sound is the quiet default; nothing else depends on it.
  }
}
