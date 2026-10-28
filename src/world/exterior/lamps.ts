// Registry of every light source the atmosphere's pooled PointLights can be assigned to.
// Seeded from layout LIGHT_ANCHORS (indoor fixtures + yard lamps); the exterior builder moves an
// outdoor anchor onto its actual lamp globe (e.g. when the anchor falls inside a building footprint)
// and registers its decorative road lamps, so the light the player sees and the stealth exposure
// (Atmosphere.lampExposure) always come from the same places.
import * as THREE from 'three/webgpu';
import { CELLHOUSE_POLY, LIGHT_ANCHORS, ROOF } from '../layout';

export interface Lamp {
  p: THREE.Vector3;
  color: THREE.Color;
  intensity: number;
  distance: number;
  /** inside the cellhouse (lights only indoor points, and only indoor lamps light indoor points) */
  indoor: boolean;
  /** index into LIGHT_ANCHORS, or -1 for a decorative exterior lamp */
  anchor: number;
}

export const LAMPS: Lamp[] = [];

const xs = CELLHOUSE_POLY.map((p) => p[0]), zs = CELLHOUSE_POLY.map((p) => p[1]);
const CH = { x0: Math.min(...xs) - 0.5, x1: Math.max(...xs) + 0.5, z0: Math.min(...zs) - 0.5, z1: Math.max(...zs) + 0.5 };
/** Inside the main cellhouse volume (below the roof). */
export function insideCellhouse(x: number, y: number, z: number) {
  return x >= CH.x0 && x <= CH.x1 && z >= CH.z0 && z <= CH.z1 && y < ROOF - 0.3;
}

export function initLamps() {
  if (LAMPS.length) return;
  LIGHT_ANCHORS.forEach((a, i) => {
    LAMPS.push({
      p: new THREE.Vector3(...a.p), color: new THREE.Color(a.color), intensity: a.intensity, distance: a.distance,
      indoor: insideCellhouse(a.p[0], a.p[1], a.p[2]), anchor: i,
    });
  });
}

/** Moves a layout anchor's light onto the lamp that represents it in the world. */
export function placeAnchor(i: number, x: number, y: number, z: number) {
  initLamps();
  const l = LAMPS.find((m) => m.anchor === i);
  if (l) l.p.set(x, y, z);
}

export function addLamp(x: number, y: number, z: number, color: number, intensity: number, distance: number) {
  initLamps();
  LAMPS.push({ p: new THREE.Vector3(x, y, z), color: new THREE.Color(color), intensity, distance, indoor: insideCellhouse(x, y, z), anchor: -1 });
}
