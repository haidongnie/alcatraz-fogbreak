// Patrol route preparation (once, at construction). Indoor routes are used exactly as laid out in
// layout GUARDS. Outdoor routes are checked against the real terrain: the hand-placed waypoints and
// the heightmap shoreline differ by a few metres, so waypoints in the water move to the nearest dry
// ground, wet segments get one detour inland, and every point is put on the ground.
import * as THREE from 'three/webgpu';
import type { GuardDef } from '../../world/layout';
import type { TerrainApi } from '../context';

/** minimum terrain height (m) for a waypoint to count as dry land */
const DRY = 0.6;

/** Patrol route of `def` as world points (feet positions). */
export function buildRoute(def: GuardDef, terrain: TerrainApi): THREE.Vector3[] {
  const pts = def.route.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  if (def.area !== 'outside') return pts;
  for (const p of pts) dryPoint(p, terrain);
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    out.push(a);
    if (!wetBetween(a, b, terrain)) continue;
    const detour = inlandDetour(a, b, terrain);
    if (detour) out.push(detour);
  }
  for (const p of out) {
    const top = Math.max(p.y, terrain.heightAt(p.x, p.z)) + 1.5;
    const g = terrain.groundAt(p.x, top, p.z);
    if (Number.isFinite(g) && g < top - 1e-3) p.y = g;
  }
  return out;
}

function dryPoint(p: THREE.Vector3, terrain: TerrainApi) {
  if (terrain.heightAt(p.x, p.z) >= DRY) return;
  for (let r = 1; r <= 16; r++) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      if (terrain.heightAt(x, z) >= DRY + 0.2) { p.set(x, p.y, z); return; }
    }
  }
}

function wetBetween(a: THREE.Vector3, b: THREE.Vector3, terrain: TerrainApi) {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 1.5));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (terrain.heightAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t) < 0.4) return true;
  }
  return false;
}

function inlandDetour(a: THREE.Vector3, b: THREE.Vector3, terrain: TerrainApi): THREE.Vector3 | null {
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
  const c = new THREE.Vector3();
  for (let k = 2; k <= 18; k += 2) {
    for (const side of [1, -1]) {
      c.set(mx + nx * k * side, (a.y + b.y) / 2, mz + nz * k * side);
      if (terrain.heightAt(c.x, c.z) >= DRY && !wetBetween(a, c, terrain) && !wetBetween(c, b, terrain)) return c;
    }
  }
  return null;
}
