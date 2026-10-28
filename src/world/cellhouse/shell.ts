// Exterior shell of the cellhouse complex: Main Prison, Dining Hall/kitchen wing and
// Administration wing. Board-formed concrete walls (from below the terrain up to the roofs) with
// real window openings (bars, steel sash, faintly glowing glass), parapets, cornices, flat
// tar-and-gravel roofs with skylight strips and box ventilators, the bakery vent pipe on the
// kitchen's north wall, and roof colliders so the whole roof route is walkable.
import * as THREE from 'three/webgpu';
import { BAKERY_PIPE, CELLHOUSE_POLY, CEILING, FLOOR, ROOF, ROOF_VENT, WALL, WING_ROOF } from '../layout';
import { insidePoly, rectMinusRects, rng } from './batch';
import type { MatDef } from './materials';
import type { Kit } from './kit';

type V2 = [number, number];
type Rect = [number, number, number, number];

/**
 * Dining Hall / kitchen wing (OSM way 24433437). The small notch on the kitchen's north side
 * (x -84.5..-77.3, z -9.0..-5.7) is filled in as the bakery annex so the north wall runs straight
 * along the service yard and carries BAKERY_PIPE (x -79.5) exactly where layout.ts expects it.
 */
export const DINING_POLY: V2[] = [[-32.51, 11.05], [-32.44, -9.01], [-84.49, -9.01], [-84.55, 7.4], [-77.29, 7.39], [-77.31, 11.05]];
/** Administration Block (OSM way 128245367). */
export const ADMIN_POLY: V2[] = [[32.43, 10.27], [47.19, 10.27], [47.26, -7.29], [47.32, -24.61], [32.56, -24.61]];
export const ADMIN_ROOF = FLOOR + 10;

const WALL_BOTTOM = 25;
const PARAPET = 0.75;       // visible parapet height above a roof
const PARAPET_COL = 1.5;    // collider height: above jump (0.9 m) + mid-air autostep (0.37 m)

/** Main roof rectangles (CELLHOUSE_POLY decomposed). */
export const MAIN_RECTS: Rect[] = [[-32.5, -14.24, 15.5, 24.61], [15.5, -24.6, 32.5, 13.55], [-15.4, -24.6, 15.5, -14.24]];
const DINING_RECTS: Rect[] = [[-84.5, -9.01, -32.5, 7.4], [-77.3, 7.4, -32.5, 11.05]];
const ADMIN_RECTS: Rect[] = [[32.5, -24.61, 47.3, 10.27]];

/** Skylight strips over Michigan Avenue, Broadway and Park Avenue (x0, z0, x1, z1). */
export const SKYLIGHTS: Rect[] = [];
for (const [z0, z1] of [[-12.2, -10.0], [-0.9, 1.8], [10.8, 13.0]] as V2[]) {
  for (const [x0, x1] of [[-23.5, -13.0], [-11.5, -1.0], [0.5, 11.0], [12.5, 23.0]] as V2[]) SKYLIGHTS.push([x0, z0, x1, z1]);
}

/** Box ventilators on the main roof (the escape one above ROOF_VENT is built by the workshop). */
const VENTILATORS: V2[] = [[-2, -5.55], [10, -5.55], [22, -5.55], [-18, 6.45], [-6, 6.45], [6, 6.45], [18, 6.45], [-4, -16.7], [12, -16.7], [24, -16.7]];

/** Interior z extent of the main hall at a given x (north face, south face). */
export function interiorZ(x: number): V2 {
  const zn = x < -15.4 ? -14.24 + WALL : -24.6 + WALL;
  const zs = x < 15.5 ? 24.61 - WALL : 13.54 - WALL;
  return [zn, zs];
}

// ------------------------------------------------------------------------------------------------
// Polygon edges with mitred inner corners
// ------------------------------------------------------------------------------------------------
interface Edge {
  a: V2; b: V2;
  /** unit direction a -> b and unit inward normal */
  d: V2; n: V2;
  len: number;
  /** along-edge extent of the wall box (covers mitre at both convex and reflex corners) */
  s0: number; s1: number;
  /** along-edge span of the interior face */
  in0: number; in1: number;
}

function polyEdges(poly: V2[], t: number): Edge[] {
  const m = poly.length;
  const base = poly.map((a, i) => {
    const b = poly[(i + 1) % m];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d: V2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    let n: V2 = [-d[1], d[0]];
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    if (!insidePoly(poly, mx + n[0] * 0.05, mz + n[1] * 0.05)) n = [-n[0], -n[1]];
    return { a, b, d, n, len };
  });
  // inner (offset) vertex i = intersection of the offset lines of edges i-1 and i
  const inner: V2[] = poly.map((_, i) => {
    const e0 = base[(i - 1 + m) % m], e1 = base[i];
    const p1: V2 = [e0.a[0] + e0.n[0] * t, e0.a[1] + e0.n[1] * t];
    const p2: V2 = [e1.a[0] + e1.n[0] * t, e1.a[1] + e1.n[1] * t];
    const cross = e0.d[0] * e1.d[1] - e0.d[1] * e1.d[0];
    if (Math.abs(cross) < 1e-3) return p2;
    const s = ((p2[0] - p1[0]) * e1.d[1] - (p2[1] - p1[1]) * e1.d[0]) / cross;
    return [p1[0] + e0.d[0] * s, p1[1] + e0.d[1] * s];
  });
  return base.map((e, i) => {
    const pi = inner[i], pj = inner[(i + 1) % m];
    const in0 = (pi[0] - e.a[0]) * e.d[0] + (pi[1] - e.a[1]) * e.d[1];
    const in1 = (pj[0] - e.a[0]) * e.d[0] + (pj[1] - e.a[1]) * e.d[1];
    return { ...e, in0, in1, s0: Math.min(0, in0), s1: Math.max(e.len, in1) };
  });
}

/** World point at along-edge coordinate s and depth (0 = outer face, t = inner face). */
function edgePoint(e: Edge, s: number, depth: number): V2 {
  return [e.a[0] + e.d[0] * s + e.n[0] * depth, e.a[1] + e.d[1] * s + e.n[1] * depth];
}
function edgeYaw(e: Edge) { return Math.atan2(-e.d[1], e.d[0]); }

/** Box in an edge's frame: along [s0,s1], height [y0,y1], depth [d0,d1] (0 = outer face). */
function edgeBox(kit: Kit, def: MatDef, e: Edge, s0: number, s1: number, y0: number, y1: number, d0: number, d1: number) {
  const [x, z] = edgePoint(e, (s0 + s1) / 2, (d0 + d1) / 2);
  kit.batch.box(def, x, (y0 + y1) / 2, z, s1 - s0, y1 - y0, Math.abs(d1 - d0), edgeYaw(e));
}
function edgeCollider(kit: Kit, e: Edge, s0: number, s1: number, y0: number, y1: number, d0: number, d1: number) {
  const [x, z] = edgePoint(e, (s0 + s1) / 2, (d0 + d1) / 2);
  kit.cols.box(x, (y0 + y1) / 2, z, (s1 - s0) / 2, (y1 - y0) / 2, Math.abs(d1 - d0) / 2, edgeYaw(e));
}

type Fill = 'window' | 'basement' | 'door' | 'doorIn' | 'gate' | 'gap';
interface Opening { s0: number; s1: number; y0: number; y1: number; fill: Fill; }

/** Solid wall pieces around the openings. */
function wallWithOpenings(kit: Kit, def: MatDef, e: Edge, y0: number, y1: number, ops: Opening[]) {
  const cuts = [...new Set([e.s0, e.s1, ...ops.flatMap((o) => [o.s0, o.s1])])].filter((s) => s >= e.s0 && s <= e.s1).sort((p, q) => p - q);
  for (let k = 0; k < cuts.length - 1; k++) {
    const ca = cuts[k], cb = cuts[k + 1];
    if (cb - ca < 1e-3) continue;
    const mid = (ca + cb) / 2;
    const covering = ops.filter((o) => o.s0 <= mid && o.s1 >= mid).sort((p, q) => p.y0 - q.y0);
    let y = y0;
    for (const o of covering) {
      if (o.y0 > y) edgeBox(kit, def, e, ca, cb, y, Math.min(o.y0, y1), 0, WALL);
      y = Math.max(y, o.y1);
    }
    if (y < y1) edgeBox(kit, def, e, ca, cb, y, y1, 0, WALL);
  }
}

const _basis = new THREE.Matrix4();
const _X = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);
const _Z = new THREE.Vector3();

/** Vertical quad in an edge's plane at `depth`, facing outward (out = true) or inward. */
function edgeQuad(kit: Kit, def: MatDef, e: Edge, s0: number, s1: number, y0: number, y1: number, depth: number, out: boolean, variant: number) {
  const g = new THREE.PlaneGeometry(s1 - s0, y1 - y0);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setX(i, (variant + uv.getX(i)) / 4);
  const facing = out ? -1 : 1; // inward normal sign
  _X.set(e.d[0], 0, e.d[1]);
  _Z.crossVectors(_X, _Y);
  if (_Z.x * e.n[0] * facing + _Z.z * e.n[1] * facing < 0) { _X.negate(); _Z.crossVectors(_X, _Y); }
  const [x, z] = edgePoint(e, (s0 + s1) / 2, depth);
  _basis.makeBasis(_X, _Y, _Z).setPosition(x, (y0 + y1) / 2, z);
  kit.batch.addGeometry(def, g, _basis, { keepUV: true });
}

/** Bars, steel sash, glass and sill for one window opening. */
function windowFill(kit: Kit, e: Edge, o: Opening, inner: boolean, r: () => number) {
  const { batch, mats } = kit;
  const w = o.s1 - o.s0;
  const yaw = edgeYaw(e);
  // vertical round bars at mid-wall
  const nb = Math.max(3, Math.round(w / 0.15));
  for (let i = 0; i < nb; i++) {
    const s = o.s0 + (i + 0.5) * (w / nb);
    const [x, z] = edgePoint(e, s, WALL * 0.55);
    batch.cyl(mats.darkSteel, [x, o.y0, z], [x, o.y1, z], 0.014, 6, true);
  }
  // flat horizontal bands
  for (let y = o.y0 + 0.75; y < o.y1 - 0.3; y += 1.15) {
    const [x, z] = edgePoint(e, (o.s0 + o.s1) / 2, WALL * 0.55);
    batch.box(mats.darkSteel, x, y, z, w, 0.05, 0.014, yaw);
  }
  // steel sash (muntins) just inside the glass
  for (let k = 1; k < 4; k++) {
    const [x, z] = edgePoint(e, o.s0 + (w * k) / 4, 0.09);
    batch.box(mats.darkSteel, x, (o.y0 + o.y1) / 2, z, 0.035, o.y1 - o.y0, 0.04, yaw);
  }
  const rows = Math.max(2, Math.round((o.y1 - o.y0) / 0.62));
  for (let k = 1; k < rows; k++) {
    const [x, z] = edgePoint(e, (o.s0 + o.s1) / 2, 0.09);
    batch.box(mats.darkSteel, x, o.y0 + ((o.y1 - o.y0) * k) / rows, z, w, 0.035, 0.04, yaw);
  }
  const variant = Math.floor(r() * 4);
  edgeQuad(kit, mats.glassOut, e, o.s0, o.s1, o.y0, o.y1, 0.06, true, variant);
  if (inner) edgeQuad(kit, mats.glassIn, e, o.s0, o.s1, o.y0, o.y1, 0.12, false, 0);
  // projecting sill
  edgeBox(kit, mats.wallOuter, e, o.s0 - 0.06, o.s1 + 0.06, o.y0 - 0.08, o.y0 + 0.012, -0.1, 0.05);
}

/** Steel door leaf (single or double) set into an opening at the given depth. */
function doorFill(kit: Kit, e: Edge, o: Opening, d0: number, d1: number, leaves: number) {
  const { mats } = kit;
  const w = (o.s1 - o.s0) / leaves;
  for (let i = 0; i < leaves; i++) {
    const s0 = o.s0 + i * w + 0.01, s1 = o.s0 + (i + 1) * w - 0.01;
    edgeBox(kit, mats.darkSteel, e, s0, s1, o.y0, o.y1 - 0.02, d0, d1);
    // small wired-glass vision panel
    const out = d0 < WALL / 2;
    edgeQuad(kit, mats.dark, e, s0 + w * 0.3, s1 - w * 0.3, o.y0 + 1.35, o.y0 + 1.75, out ? d0 - 0.005 : d1 + 0.005, out, 0);
  }
  // frame
  edgeBox(kit, mats.darkSteel, e, o.s0 - 0.08, o.s0, o.y0, o.y1 + 0.08, d0 - 0.03, d1 + 0.03);
  edgeBox(kit, mats.darkSteel, e, o.s1, o.s1 + 0.08, o.y0, o.y1 + 0.08, d0 - 0.03, d1 + 0.03);
  edgeBox(kit, mats.darkSteel, e, o.s0 - 0.08, o.s1 + 0.08, o.y1, o.y1 + 0.08, d0 - 0.03, d1 + 0.03);
}

/** Barred double gate (the east-end cutoff into the administration wing). */
function gateFill(kit: Kit, e: Edge, o: Opening) {
  const { batch, mats } = kit;
  const w = o.s1 - o.s0;
  const nb = Math.round(w / 0.12);
  for (let i = 0; i <= nb; i++) {
    const [x, z] = edgePoint(e, o.s0 + (i * w) / nb, WALL * 0.5);
    batch.cyl(mats.darkSteel, [x, o.y0, z], [x, o.y1, z], i === nb / 2 ? 0.03 : 0.016, 6, true);
  }
  for (const y of [o.y0 + 0.12, o.y0 + 1.0, o.y0 + 1.9, o.y1 - 0.06]) {
    const [x, z] = edgePoint(e, (o.s0 + o.s1) / 2, WALL * 0.5);
    batch.box(mats.darkSteel, x, y, z, w, 0.07, 0.05, edgeYaw(e));
  }
  // lock box
  const [lx, lz] = edgePoint(e, (o.s0 + o.s1) / 2, WALL * 0.5);
  batch.box(mats.darkSteel, lx, o.y0 + 1.1, lz, 0.22, 0.3, 0.12, edgeYaw(e));
}

interface WallSpec {
  edge: Edge;
  y0: number;
  /** top of the visible wall (roof level or parapet top) */
  y1: number;
  /** roof level behind this wall (parapet colliders above it) or null for shared walls */
  roofY: number | null;
  ops: Opening[];
  def: MatDef;
  innerGlass: boolean;
  cornice: number | null;
}

function buildWall(kit: Kit, w: WallSpec, r: () => number) {
  const { edge: e } = w;
  wallWithOpenings(kit, w.def, e, w.y0, w.y1, w.ops);
  for (const o of w.ops) {
    if (o.fill === 'window' || o.fill === 'basement') windowFill(kit, e, o, w.innerGlass && o.fill === 'window', r);
    else if (o.fill === 'door') doorFill(kit, e, o, 0.1, 0.17, 1);
    else if (o.fill === 'doorIn') doorFill(kit, e, o, WALL - 0.16, WALL - 0.08, 2);
    else if (o.fill === 'gate') gateFill(kit, e, o);
  }
  const gaps = w.ops.filter((o) => o.fill === 'gap');
  // coping on parapets (skip gaps)
  if (w.roofY !== null) {
    const segs = subtractSpans([e.s0, e.s1], gaps.map((g) => [g.s0, g.s1] as V2));
    for (const [s0, s1] of segs) {
      edgeBox(kit, kit.mats.wallOuter, e, s0, s1, w.y1, w.y1 + 0.08, -0.05, WALL + 0.05);
      edgeCollider(kit, e, s0, s1, w.roofY, w.roofY + PARAPET_COL, 0, WALL);
    }
    edgeCollider(kit, e, e.s0, e.s1, w.y0, w.roofY, 0, WALL);
  } else {
    edgeCollider(kit, e, e.s0, e.s1, w.y0, w.y1, 0, WALL);
  }
  if (w.cornice !== null) edgeBox(kit, kit.mats.wallOuter, e, e.s0, e.s1, w.cornice, w.cornice + 0.32, -0.16, 0.02);
}

function subtractSpans(span: V2, holes: V2[]): V2[] {
  let out: V2[] = [span];
  for (const [h0, h1] of holes) {
    const next: V2[] = [];
    for (const [a, b] of out) {
      if (h1 <= a || h0 >= b) { next.push([a, b]); continue; }
      if (h0 > a) next.push([a, h0]);
      if (h1 < b) next.push([h1, b]);
    }
    out = next;
  }
  return out;
}

/** Evenly spaced openings along [a, b] with a target pitch. */
function spaced(a: number, b: number, pitch: number, width: number, y0: number, y1: number, fill: Fill, skip?: (s0: number, s1: number) => boolean): Opening[] {
  const span = b - a;
  const n = Math.floor(span / pitch);
  const out: Opening[] = [];
  if (n < 1) return out;
  const step = span / n;
  for (let i = 0; i < n; i++) {
    const c = a + (i + 0.5) * step;
    const o = { s0: c - width / 2, s1: c + width / 2, y0, y1, fill };
    if (!skip || !skip(o.s0, o.s1)) out.push(o);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Build
// ------------------------------------------------------------------------------------------------
export function buildShell(kit: Kit) {
  const r = rng(1962);
  buildMainWalls(kit, r);
  buildDiningWalls(kit, r);
  buildAdminWalls(kit, r);
  buildRoofs(kit);
  buildBakeryPipe(kit);
  buildWingStair(kit);
  buildFloorSlab(kit);
}

function buildMainWalls(kit: Kit, r: () => number) {
  const edges = polyEdges(CELLHOUSE_POLY, WALL);
  const terrain = kit.ctx.terrain;
  edges.forEach((e, i) => {
    const sharedDining = i === 11, sharedAdmin = i === 6;
    const shared = sharedDining || sharedAdmin;
    const ops: Opening[] = [];
    if (!shared) {
      const wins = spaced(e.in0 + 0.6, e.in1 - 0.6, 4.27, 2.1, FLOOR + 2.3, FLOOR + 8.2, 'window');
      ops.push(...wins);
      // small barred basement windows into the old Citadel level where the ground falls away
      for (const wnd of wins) {
        const c = (wnd.s0 + wnd.s1) / 2;
        const [x, z] = edgePoint(e, c, -0.5);
        if (terrain && terrain.heightAt(x, z) < FLOOR - 4.6) ops.push({ s0: c - 0.5, s1: c + 0.5, y0: FLOOR - 3.4, y1: FLOOR - 2.1, fill: 'basement' });
      }
    }
    if (sharedDining) {
      // dining hall double door under the clock (DINING_DOOR z = 0.45), low enough for the gallery above
      const s = 0.45 - e.a[1];
      ops.push({ s0: s - 1.2, s1: s + 1.2, y0: FLOOR, y1: FLOOR + 2.15, fill: 'doorIn' });
    }
    if (sharedAdmin) {
      const s = e.a[1] - 0.45; // edge runs toward -z
      ops.push({ s0: s - 1.3, s1: s + 1.3, y0: FLOOR, y1: FLOOR + 2.3, fill: 'gate' });
    }
    buildWall(kit, {
      edge: e, y0: WALL_BOTTOM, y1: shared ? ROOF - 0.01 : ROOF + PARAPET, roofY: shared ? null : ROOF, ops,
      def: kit.mats.wall, innerGlass: true, cornice: shared ? null : ROOF - 0.6,
    }, r);
    // belt course at floor level and an interior dado band
    if (!shared) edgeBox(kit, kit.mats.wallOuter, e, e.s0, e.s1, FLOOR - 0.2, FLOOR + 0.1, -0.07, 0.02);
    const floorOps = ops.filter((o) => o.y0 <= FLOOR + 0.01);
    for (const [s0, s1] of subtractSpans([e.in0, e.in1], floorOps.map((o) => [o.s0 - 0.08, o.s1 + 0.08] as V2))) {
      edgeBox(kit, kit.mats.oldPaint, e, s0, s1, FLOOR, FLOOR + 1.25, WALL, WALL + 0.012);
    }
    if (sharedAdmin) buildVestibule(kit, e, ops[0]);
  });
}

/** Small barred vestibule behind the cutoff gate (inside the administration wing). */
function buildVestibule(kit: Kit, e: Edge, gate: Opening) {
  const { batch, mats, cols } = kit;
  const z0 = e.a[1] - gate.s1, z1 = e.a[1] - gate.s0; // world z range of the gate
  const x0 = 32.56, x1 = 35.6, y0 = FLOOR, y1 = FLOOR + 3.0;
  batch.quadY(mats.floor, x0, z0 - 0.2, x1, z1 + 0.2, y0 + 0.002, true);
  batch.boxMM(mats.wall, x0, y0, z0 - 0.4, x1, y1, z0 - 0.2);
  batch.boxMM(mats.wall, x0, y0, z1 + 0.2, x1, y1, z1 + 0.4);
  batch.boxMM(mats.wall, x1, y0, z0 - 0.4, x1 + 0.2, y1, z1 + 0.4);
  batch.boxMM(mats.wall, x0, y1, z0 - 0.4, x1 + 0.2, y1 + 0.2, z1 + 0.4);
  batch.boxMM(mats.darkSteel, x1 - 0.06, y0, (z0 + z1) / 2 - 0.5, x1, y0 + 2.2, (z0 + z1) / 2 + 0.5);
  batch.boxMM(mats.nightLamp, x0 + 1.2, y1 - 0.08, (z0 + z1) / 2 - 0.15, x0 + 1.5, y1, (z0 + z1) / 2 + 0.15);
  cols.mm(x0, y0, z0 - 0.4, x1 + 0.2, y1 + 0.2, z1 + 0.4); // never entered: solid behind the gate
}

function buildDiningWalls(kit: Kit, r: () => number) {
  const edges = polyEdges(DINING_POLY, WALL);
  const terrain = kit.ctx.terrain;
  const pipeS = -32.44 - BAKERY_PIPE.x; // along the north edge (runs toward -x)
  edges.forEach((e, i) => {
    if (i === 0) return; // shared with the Main Prison west wall
    const ops: Opening[] = [];
    const nearPipe = (s0: number, s1: number) => i === 1 && s1 > pipeS - 1.6 && s0 < pipeS + 1.6;
    ops.push(...spaced(e.in0 + 0.6, e.in1 - 0.6, 4.6, 2.0, FLOOR + 1.6, FLOOR + 6.4, 'window', nearPipe));
    if (i === 1) {
      // service-yard level: barred windows of the kitchen basement + the shower-room exit door
      const doorS = -32.44 - -73.0;
      ops.push(...spaced(e.in0 + 1.0, e.in1 - 1.0, 6.0, 1.0, 35.2, 36.7, 'basement', (s0, s1) => nearPipe(s0, s1) || (s1 > doorS - 1.4 && s0 < doorS + 1.4)));
      ops.push({ s0: doorS - 0.6, s1: doorS + 0.6, y0: 33.0, y1: 35.25, fill: 'door' });
      // parapet gap where the bakery pipe comes over the roof edge
      ops.push({ s0: pipeS - 1.1, s1: pipeS + 1.1, y0: WING_ROOF + 0.02, y1: WING_ROOF + PARAPET + 0.2, fill: 'gap' });
    } else {
      for (const o of [...ops]) {
        const c = (o.s0 + o.s1) / 2;
        const [x, z] = edgePoint(e, c, -0.5);
        if (terrain && terrain.heightAt(x, z) < FLOOR - 4.6) ops.push({ s0: c - 0.5, s1: c + 0.5, y0: FLOOR - 3.4, y1: FLOOR - 2.1, fill: 'basement' });
      }
    }
    buildWall(kit, {
      edge: e, y0: WALL_BOTTOM, y1: WING_ROOF + PARAPET, roofY: WING_ROOF, ops, def: kit.mats.wallOuter,
      innerGlass: false, cornice: WING_ROOF - 0.6,
    }, r);
    edgeBox(kit, kit.mats.wallOuter, e, e.s0, e.s1, FLOOR - 0.2, FLOOR + 0.1, -0.07, 0.02);
  });
}

function buildAdminWalls(kit: Kit, r: () => number) {
  const edges = polyEdges(ADMIN_POLY, WALL);
  const terrain = kit.ctx.terrain;
  edges.forEach((e, i) => {
    if (i === 4) return; // shared with the Main Prison east wall
    const ops: Opening[] = [];
    let doorS = -1;
    if (i === 1) doorS = 10.27 - -6.0; // main entrance on the east face
    const nearDoor = (s0: number, s1: number) => doorS >= 0 && s1 > doorS - 1.6 && s0 < doorS + 1.6;
    ops.push(...spaced(e.in0 + 0.5, e.in1 - 0.5, 3.2, 1.3, FLOOR + 0.9, FLOOR + 3.1, 'window', nearDoor));
    ops.push(...spaced(e.in0 + 0.5, e.in1 - 0.5, 3.2, 1.3, FLOOR + 4.9, FLOOR + 7.4, 'window'));
    if (doorS >= 0) {
      const [x, z] = edgePoint(e, doorS, -1);
      const g = Math.max(FLOOR, terrain ? terrain.heightAt(x, z) : FLOOR);
      ops.push({ s0: doorS - 0.9, s1: doorS + 0.9, y0: g, y1: g + 2.6, fill: 'door' });
      // canopy over the entrance
      edgeBox(kit, kit.mats.wallOuter, e, doorS - 1.5, doorS + 1.5, g + 2.85, g + 3.05, -1.3, 0);
    }
    buildWall(kit, {
      edge: e, y0: WALL_BOTTOM, y1: ADMIN_ROOF + PARAPET, roofY: ADMIN_ROOF, ops, def: kit.mats.wallOuter,
      innerGlass: false, cornice: ADMIN_ROOF - 0.6,
    }, r);
    edgeBox(kit, kit.mats.wallOuter, e, e.s0, e.s1, FLOOR + 4.1, FLOOR + 4.35, -0.06, 0.02);
  });
}

// ------------------------------------------------------------------------------------------------
// Roofs
// ------------------------------------------------------------------------------------------------
function buildRoofs(kit: Kit) {
  const { batch, mats, cols } = kit;
  // Main roof: tar on top, painted deck underside (the visible interior ceiling) with skylight wells.
  for (const rect of MAIN_RECTS) {
    for (const q of rectMinusRects(rect, SKYLIGHTS)) {
      batch.quadY(mats.roof, q[0], q[1], q[2], q[3], ROOF, true);
      batch.quadY(mats.wall, q[0], q[1], q[2], q[3], ROOF - 0.2, false);
    }
    cols.mm(rect[0], CEILING, rect[1], rect[2], ROOF, rect[3]);
  }
  for (const s of SKYLIGHTS) buildSkylight(kit, s);
  for (const [x, z] of VENTILATORS) {
    batch.boxMM(mats.wallOuter, x - 0.5, ROOF, z - 0.5, x + 0.5, ROOF + 0.3, z + 0.5);
    cols.box(x, ROOF + 0.95, z, 0.72, 0.95, 0.72);
  }
  const vm = VENTILATORS.map(([x, z], i) => new THREE.Matrix4().compose(
    new THREE.Vector3(x, ROOF + 0.3, z), new THREE.Quaternion().setFromAxisAngle(_Y, (i % 2) * Math.PI / 2), new THREE.Vector3(1, 1, 1)));
  const vents = kit.ctx.models.instanced('roof_ventilator', vm, { castShadow: true, receiveShadow: true });
  vents.name = 'cellhouse:ventilators';
  kit.root.add(vents);
  // stair/elevator penthouse at the north-east corner of the roof
  batch.boxMM(mats.wallOuter, 25.6, ROOF, -22.6, 29.2, ROOF + 2.7, -19.8);
  batch.boxMM(mats.wallOuter, 25.5, ROOF + 2.7, -22.7, 29.3, ROOF + 2.85, -19.7);
  batch.boxMM(mats.darkSteel, 26.6, ROOF, -19.82, 27.6, ROOF + 2.1, -19.76);
  cols.mm(25.6, ROOF, -22.6, 29.2, ROOF + 2.85, -19.8);

  // Dining/kitchen wing roof (2 m below the main roof: players drop down at the west end).
  for (const q of DINING_RECTS) {
    batch.quadY(mats.roof, q[0], q[1], q[2], q[3], WING_ROOF, true);
    cols.mm(q[0], WING_ROOF - 1.0, q[1], q[2], WING_ROOF, q[3]);
  }
  // kitchen exhaust hood and a brick-faced chimney stack (off the escape route along the north edge)
  batch.boxMM(mats.wallOuter, -71.0, WING_ROOF, 2.6, -68.6, WING_ROOF + 0.9, 5.0);
  batch.boxMM(mats.darkSteel, -71.2, WING_ROOF + 0.9, 2.4, -68.4, WING_ROOF + 1.05, 5.2);
  cols.mm(-71.2, WING_ROOF, 2.4, -68.4, WING_ROOF + 1.05, 5.2);
  batch.boxMM(mats.wallOuter, -83.4, WING_ROOF, 3.6, -82.4, WING_ROOF + 2.6, 4.6);
  cols.mm(-83.4, WING_ROOF, 3.6, -82.4, WING_ROOF + 2.6, 4.6);
  const wm = [[-58, 3.2], [-46, 3.2]].map(([x, z]) => new THREE.Matrix4().makeTranslation(x, WING_ROOF + 0.3, z));
  for (const [x, z] of [[-58, 3.2], [-46, 3.2]]) {
    batch.boxMM(mats.wallOuter, x - 0.5, WING_ROOF, z - 0.5, x + 0.5, WING_ROOF + 0.3, z + 0.5);
    cols.box(x, WING_ROOF + 0.95, z, 0.72, 0.95, 0.72);
  }
  const wv = kit.ctx.models.instanced('roof_ventilator', wm, { castShadow: true, receiveShadow: true });
  kit.root.add(wv);

  // Administration wing roof.
  for (const q of ADMIN_RECTS) {
    batch.quadY(mats.roof, q[0], q[1], q[2], q[3], ADMIN_ROOF, true);
    cols.mm(q[0], ADMIN_ROOF - 1.0, q[1], q[2], ADMIN_ROOF, q[3]);
  }
  batch.boxMM(mats.wallOuter, 38.0, ADMIN_ROOF, -16.0, 40.4, ADMIN_ROOF + 1.4, -13.6);
  cols.mm(38.0, ADMIN_ROOF, -16.0, 40.4, ADMIN_ROOF + 1.4, -13.6);
}

/** Gabled skylight: concrete curb (also the light well seen from inside), ridged glass, steel ribs. */
function buildSkylight(kit: Kit, s: Rect) {
  const { batch, mats, cols } = kit;
  const [x0, z0, x1, z1] = s;
  const c = 0.16, top = ROOF + 0.32, ridge = ROOF + 0.85;
  const yb = ROOF - 0.26; // a little below the ceiling plane (no coplanar faces)
  batch.boxMM(mats.wallOuter, x0 - c, yb, z0 - c, x1 + c, top, z0);
  batch.boxMM(mats.wallOuter, x0 - c, yb, z1, x1 + c, top, z1 + c);
  batch.boxMM(mats.wallOuter, x0 - c, yb, z0, x0, top, z1);
  batch.boxMM(mats.wallOuter, x1, yb, z0, x1 + c, top, z1);
  const zm = (z0 + z1) / 2;
  const half = (z1 - z0) / 2;
  const slope = Math.atan2(ridge - top, half);
  const paneLen = Math.hypot(half, ridge - top);
  for (const side of [-1, 1]) {
    const g = new THREE.PlaneGeometry(x1 - x0, paneLen);
    g.rotateX(-Math.PI / 2);
    g.rotateX(side * slope);
    g.translate((x0 + x1) / 2, (top + ridge) / 2, zm + (side * half) / 2);
    batch.addGeometry(mats.skyGlass, g, null);
  }
  for (let x = x0; x <= x1 + 1e-3; x += (x1 - x0) / Math.max(1, Math.round((x1 - x0) / 1.2))) {
    batch.beam(mats.darkSteel, [x, top, z0], [x, ridge, zm], 0.05, 0.05);
    batch.beam(mats.darkSteel, [x, top, z1], [x, ridge, zm], 0.05, 0.05);
  }
  batch.beam(mats.darkSteel, [x0, ridge, zm], [x1, ridge, zm], 0.09, 0.07);
  // gable ends
  for (const x of [x0, x1]) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([x, top, z0, x, top, z1, x, ridge, zm]), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0.5, 1]), 2));
    g.setIndex([0, 1, 2, 2, 1, 0]);
    batch.addGeometry(mats.darkSteel, g, null);
  }
  cols.mm(x0 - c, ROOF, z0 - c, x1 + c, ridge, z1 + c);
}

/** BAKERY_PIPE: 0.3 m iron vent pipe strapped to the kitchen's north wall, yard to above the roof. */
function buildBakeryPipe(kit: Kit) {
  const { batch, mats, cols } = kit;
  const { x, z } = BAKERY_PIPE;
  const wallZ = -9.01;
  const y0 = BAKERY_PIPE.bottom + 0.35, y1 = WING_ROOF + 1.55;
  batch.cyl(mats.pipe, [x, y0, z], [x, y1, z], 0.15, 14);
  // elbow into the wall at the bottom (the bakery ovens are in the basement)
  batch.cyl(mats.pipe, [x, y0, z], [x, y0, wallZ], 0.15, 14);
  batch.box(mats.pipe, x, y0, z, 0.34, 0.34, 0.34);
  batch.boxMM(mats.wallOuter, x - 0.45, BAKERY_PIPE.bottom - 0.2, wallZ - 0.5, x + 0.45, BAKERY_PIPE.bottom + 0.12, wallZ);
  // flanges and wall brackets
  for (let y = y0 + 1.2; y < y1 - 0.4; y += 1.5) {
    batch.cyl(mats.pipe, [x, y - 0.035, z], [x, y + 0.035, z], 0.175, 14);
    for (const dx of [-0.12, 0.12]) batch.boxMM(mats.darkSteel, x + dx - 0.02, y - 0.03, z + 0.12, x + dx + 0.02, y + 0.03, wallZ);
  }
  for (let y = y0 + 3.0; y < y1 - 0.4; y += 3.0) batch.cyl(mats.pipe, [x, y - 0.03, z], [x, y + 0.03, z], 0.2, 14);
  // conical rain cap
  const cap = new THREE.ConeGeometry(0.32, 0.22, 14, 1, false);
  cap.translate(x, y1 + 0.3, z);
  batch.addGeometry(mats.pipe, cap, null);
  for (const a of [0, 2.1, 4.2]) batch.cyl(mats.darkSteel, [x + Math.cos(a) * 0.13, y1, z + Math.sin(a) * 0.13], [x + Math.cos(a) * 0.2, y1 + 0.2, z + Math.sin(a) * 0.2], 0.012, 4, true);
  cols.box(x, (BAKERY_PIPE.bottom + y1) / 2, z, 0.12, (y1 - BAKERY_PIPE.bottom) / 2, 0.12);
}

/** Steel stair from the wing roof back up to the main roof (players drop down; this is the way back). */
function buildWingStair(kit: Kit) {
  const { batch, mats, cols } = kit;
  const xa = -36.3, xb = -32.5, za = -6.45, zb = -5.35;
  const ya = WING_ROOF, yb = ROOF;
  const steps = 10;
  for (const z of [za, zb]) batch.beam(mats.darkSteel, [xa, ya - 0.05, z], [xb, yb - 0.05, z], 0.05, 0.22);
  for (let i = 1; i <= steps; i++) {
    const t = i / (steps + 0.5);
    const x = xa + (xb - xa) * t, y = ya + (yb - ya) * t;
    batch.box(mats.darkSteel, x, y - 0.02, (za + zb) / 2, 0.24, 0.04, zb - za - 0.06);
  }
  for (const z of [za - 0.03, zb + 0.03]) {
    batch.cyl(mats.steel, [xa, ya, z], [xa, ya + 0.95, z], 0.022, 6);
    batch.cyl(mats.steel, [xb, yb, z], [xb, yb + 0.95, z], 0.022, 6);
    batch.cyl(mats.steel, [xa, ya + 0.95, z], [xb, yb + 0.95, z], 0.022, 6);
  }
  cols.ramp([xa - 0.3, ya, (za + zb) / 2], [xb + 0.15, yb, (za + zb) / 2], zb - za);
}

/** Main hall floor slab (the cells' ground tier and the utility corridor share it). */
function buildFloorSlab(kit: Kit) {
  const { batch, mats, cols } = kit;
  for (const q of MAIN_RECTS) {
    batch.quadY(mats.floor, q[0], q[1], q[2], q[3], FLOOR, true);
    cols.mm(q[0], FLOOR - 0.6, q[1], q[2], FLOOR, q[3]);
  }
}
