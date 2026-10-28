// Master volume shared by the pause menu (UI) and the Audio system; persisted per browser.
const KEY = 'fogbreak.vol';
const listeners = new Set<(v: number) => void>();

function read(): number {
  try {
    const v = Number.parseFloat(localStorage.getItem(KEY) ?? '');
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
  } catch { return 0.8; }
}
let volume = read();

/** 0..1 linear slider value (Audio maps it to a perceptual gain). */
export function getVolume() { return volume; }
export function setVolume(v: number) {
  volume = Math.min(1, Math.max(0, v));
  try { localStorage.setItem(KEY, String(volume)); } catch { /* private mode */ }
  for (const fn of listeners) fn(volume);
}
export function onVolumeChange(fn: (v: number) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
