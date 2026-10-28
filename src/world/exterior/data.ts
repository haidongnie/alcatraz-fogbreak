// island.json data contract, small 2D geometry helpers and the "keep clear" corridors that every
// exterior builder respects (outdoor guard routes and the escape walk from the fence to the shore).
// 2D points are [x, z] in the game frame (see src/world/layout.ts).
import { FENCE, GUARDS, LAUNCH, SERVICE_YARD } from '../layout';

export type P2 = [number, number];

export interface IslandBuilding {
  osmId: number;
  name: string | null;
  kind: string;
  ruinsToday?: boolean;
  height: number;
  /** lowest ground under the footprint in the source DEM (before gameplay sculpting) */
  base: number;
  centroid: P2;
  poly: P2[];
}
export interface IslandLine { osmId: number; type: string; name?: string; closed: boolean; pts: P2[] }
export interface IslandArea { osmId: number; name: string; poly: P2[] }
export interface IslandGrid { minX: number; minZ: number; res: number; cols: number; rows: number; scale: number; data: string }
export interface IslandData {
  attribution: string;
  origin: { lat: number; lon: number };
  northAngle: number;
  /** game-frame (x, z) unit vector of true north */
  northDir: P2;
  cellhouse: { length: number; width: number; base: number };
  maxElevation: number;
  grid: IslandGrid;
  coastline: P2[];
  buildings: IslandBuilding[];
  lines: IslandLine[];
  areas: IslandArea[];
}

// ------------------------------------------------------------------------------------------------
// Deterministic RNG (mulberry32) so the island looks the same for every player.
// ------------------------------------------------------------------------------------------------
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------------------------------------
// Polygon / segment helpers
// ------------------------------------------------------------------------------------------------
export function signedArea(poly: P2[]) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return a / 2;
}
export function pointInPoly(x: number, z: number, poly: P2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
/** distance from point to segment ab */
export function segDist(x: number, z: number, ax: number, az: number, bx: number, bz: number) {
  const vx = bx - ax, vz = bz - az;
  const l2 = vx * vx + vz * vz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2)) : 0;
  return Math.hypot(x - ax - t * vx, z - az - t * vz);
}
export function distToPolyEdge(x: number, z: number, poly: P2[]) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, segDist(x, z, poly[j][0], poly[j][1], poly[i][0], poly[i][1]));
  return d;
}
function segIntersect(a: P2, b: P2, c: P2, d: P2) {
  const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
  if (Math.abs(den) < 1e-12) return false;
  const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
  const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}
export function segSegDist(a: P2, b: P2, c: P2, d: P2) {
  if (segIntersect(a, b, c, d)) return 0;
  return Math.min(
    segDist(a[0], a[1], c[0], c[1], d[0], d[1]), segDist(b[0], b[1], c[0], c[1], d[0], d[1]),
    segDist(c[0], c[1], a[0], a[1], b[0], b[1]), segDist(d[0], d[1], a[0], a[1], b[0], b[1]),
  );
}
export function polyCentroid(poly: P2[]): P2 {
  let x = 0, z = 0;
  for (const p of poly) { x += p[0]; z += p[1]; }
  return [x / poly.length, z / poly.length];
}
/** Sutherland-Hodgman: keep the part of `poly` where dot(p - o, n) >= 0. */
export function clipHalfPlane(poly: P2[], ox: number, oz: number, nx: number, nz: number): P2[] {
  const out: P2[] = [];
  const side = (p: P2) => (p[0] - ox) * nx + (p[1] - oz) * nz;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const sa = side(a), sb = side(b);
    if (sa >= 0) out.push(a);
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
/** Removes consecutive duplicates and a closing duplicate; returns a counter-clockwise copy (x right, z down). */
export function cleanPoly(poly: P2[]): P2[] {
  const out: P2[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.05) out.push([p[0], p[1]]);
  }
  if (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 0.05) out.pop();
  // "CCW" here means positive signed area in (x, z): walls are then emitted with outward normals.
  if (signedArea(out) < 0) out.reverse();
  return out;
}
/** Resamples a polyline so no segment is longer than `step` (keeps the original vertices). */
export function resample(pts: P2[], step: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++) out.push([a[0] + (b[0] - a[0]) * (k / n), a[1] + (b[1] - a[1]) * (k / n)]);
  }
  if (pts.length) out.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
  return out;
}

// ------------------------------------------------------------------------------------------------
// Keep-clear corridors
// ------------------------------------------------------------------------------------------------
export interface Corridor { pts: P2[]; radius: number; closed: boolean; name: string }

/**
 * The walk from the fence (FENCE.climbOut) down to the launch beach, between the double fence and
 * the north retaining wall, round the wall's west end, down past the Quartermaster warehouse along
 * the north road and the ramp onto the shingle, then out to the raft spawn. Only used to keep the
 * way open (no gameplay meaning): walls get gaps, buildings are trimmed and props stay off it.
 */
export const ESCAPE_PATH: P2[] = [
  [FENCE.climbOut[0], -29.5], [-96, -29.4], [-116, -24.2], [-127, -19.5], [-134, -21], [-132, -29],
  [-160, -36.4], [-185, -46.2], [-196, -51.5], [-206, -53.2], [LAUNCH.p[0], LAUNCH.p[2]],
  [LAUNCH.raftSpawn[0], LAUNCH.raftSpawn[2]],
];

export const CORRIDORS: Corridor[] = [
  ...GUARDS.filter((g) => g.area === 'outside').map((g): Corridor => ({
    name: g.name, pts: g.route.map((p): P2 => [p[0], p[2]]), radius: 1.6, closed: true,
  })),
  { name: 'escape', pts: ESCAPE_PATH, radius: 1.5, closed: false },
];

function forEachCorridorSeg(fn: (a: P2, b: P2, r: number) => void) {
  for (const c of CORRIDORS) {
    const n = c.pts.length;
    for (let i = 0; i < (c.closed ? n : n - 1); i++) fn(c.pts[i], c.pts[(i + 1) % n], c.radius);
  }
}

/** Signed clearance of a point: < 0 means inside a corridor (distance to its edge). */
export function corridorClearance(x: number, z: number): number {
  let best = Infinity;
  forEachCorridorSeg((a, b, r) => { best = Math.min(best, segDist(x, z, a[0], a[1], b[0], b[1]) - r); });
  return best;
}
/** True when the segment ab (with half-thickness `half`) intrudes on any corridor. */
export function segmentBlocksCorridor(a: P2, b: P2, half: number): boolean {
  let hit = false;
  forEachCorridorSeg((c, d, r) => { if (!hit && segSegDist(a, b, c, d) < r + half + 0.25) hit = true; });
  return hit;
}
/** Trims a building footprint so it stays `margin` metres off every corridor that it touches. */
export function clipToCorridors(poly: P2[], margin = 0.4): P2[] {
  let out = poly;
  forEachCorridorSeg((a, b, r) => {
    if (out.length < 3) return;
    let near = false;
    for (let i = 0; i < out.length && !near; i++) {
      if (segSegDist(out[i], out[(i + 1) % out.length], a, b) < r + margin) near = true;
    }
    if (!near) return;
    // normal of the corridor segment pointing toward the footprint's centroid
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    let nx = -dz / len, nz = dx / len;
    const c = polyCentroid(out);
    if ((c[0] - a[0]) * nx + (c[1] - a[1]) * nz < 0) { nx = -nx; nz = -nz; }
    const off = r + margin;
    out = clipHalfPlane(out, a[0] + nx * off, a[1] + nz * off, nx, nz);
  });
  return out;
}

/** The fenced service yard (pipe landing) plus a margin: free-standing OSM walls are not built inside it. */
export function inServiceYard(x: number, z: number, margin = 0.5) {
  const [x0, z0, x1, z1] = SERVICE_YARD.box;
  return x >= x0 - margin && x <= x1 + margin && z >= z0 - margin && z <= z1 + margin;
}

/** Bearing (degrees from true north, clockwise) -> game-frame unit vector (x, z). */
export function bearingDir(north: P2, deg: number): P2 {
  const r = (deg * Math.PI) / 180;
  const ex = -north[1], ez = north[0]; // east = north rotated -90 deg about +Y
  return [north[0] * Math.cos(r) + ex * Math.sin(r), north[1] * Math.cos(r) + ez * Math.sin(r)];
}
