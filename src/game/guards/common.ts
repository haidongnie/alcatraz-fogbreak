// Constants and small pure helpers shared by the guard brain (host simulation) and the guard
// views (rendering on every client). Keeping the torch aim a pure function of the replicated
// guard state means clients reproduce the host's flashlight direction without extra network data.
import type { GuardAnim, GuardMode } from '../types';

/** Eye height above the feet (perception rays start here). */
export const EYE_HEIGHT = 1.65;

/** Hand-held flashlight: a 1962 D-cell torch, warm incandescent. */
export const FLASH = {
  color: 0xffe2b8,
  /** candela; lamps in LIGHT_ANCHORS are 8-30 cd, so the torch pool clearly dominates nearby */
  intensity: 32,
  /** light cut-off distance (m) and the distance used for the stealth exposure falloff */
  range: 15,
  /** spot half-angle (rad) */
  angle: 0.36,
  penumbra: 0.6,
  /** visible shaft length (m) */
  beamLength: 7,
  /** torch position relative to the guard's feet, guard facing -Z (right hand, chest height) */
  offset: [0.21, 1.3, -0.24] as const,
  /** peak stealth exposure inside the beam (ARCHITECTURE: flashlights 0..0.8) */
  exposure: 0.8,
} as const;

/** Players in these zones are invisible to guards (unpatrolled, walls block LOS anyway). */
export const HIDDEN_ZONES = new Set(['cell', 'utility', 'workshop']);
/** Zones where searchlights can spot a player. */
export const OUTDOOR_ZONES = new Set(['roof', 'yard', 'shore', 'water', 'outside']);

export interface Aim {
  /** yaw offset of head/torch relative to the body (rad, + = counter-clockwise) */
  yaw: number;
  /** downward pitch of the torch (rad, + = down) */
  pitch: number;
}

export function clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v; }

/** Wraps an angle to (-PI, PI]. */
export function wrapAngle(a: number) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/** Moves angle `a` toward `b` by at most `step` (shortest way round). */
export function approachAngle(a: number, b: number, step: number) {
  const d = wrapAngle(b - a);
  return wrapAngle(a + clamp(d, -step, step));
}

export function smoothstep(e0: number, e1: number, x: number) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Where a guard points his torch (and looks) when he is not staring at something specific.
 * Deterministic from the shared clock so host and clients agree.
 */
export function idleAim(mode: GuardMode, anim: GuardAnim, ry: number, t: number, index: number, out: Aim): Aim {
  if (mode === 'count') {
    // counting officer shines into the B-Block cells on Michigan Avenue (cells open toward +Z)
    out.yaw = clamp(wrapAngle(Math.PI - ry), -1.45, 1.45) + 0.12 * Math.sin(t * 1.7 + index);
    out.pitch = 0.2 + 0.05 * Math.sin(t * 1.1);
  } else if (anim === 'walk' || anim === 'run') {
    // light sway with the stride, beam on the floor a few metres ahead
    out.yaw = 0.1 * Math.sin(t * 0.9 + index * 1.3);
    out.pitch = anim === 'run' ? 0.12 : 0.27;
  } else {
    // standing: slow look-around
    out.yaw = 0.75 * Math.sin(t * 0.7 + index * 1.7);
    out.pitch = 0.2 + 0.06 * Math.sin(t * 0.5 + index);
  }
  return out;
}

/** Aim (relative to body yaw `ry`) from a torch at (ox, oy, oz) toward a world point. */
export function aimToward(ox: number, oy: number, oz: number, ry: number, px: number, py: number, pz: number, out: Aim): Aim {
  const dx = px - ox, dy = py - oy, dz = pz - oz;
  const horiz = Math.hypot(dx, dz);
  out.yaw = clamp(wrapAngle(Math.atan2(-dx, -dz) - ry), -1.3, 1.3);
  out.pitch = clamp(Math.atan2(-dy, Math.max(horiz, 0.3)), -0.5, 1.1);
  return out;
}
