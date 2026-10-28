// The four cell blocks (A/B/C/D) per BLOCKS in layout.ts: three tiers of cells (partitions, back
// walls, tier slabs), instanced 1934 Stewart Iron Works fronts (round bars + flat bands + sliding
// door + lock channel; flat-strap lattice in the old A-Block), cantilevered tier walkways with
// pipe railings, steel stairs in the end bays of B and C, block-top slabs, D-Block's west-end
// passage and the hole cells, plus the colliders (solid masses where players cannot go).
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BLOCKS, BLOCK_TOP, CELL, FLOOR, HOLE_CELLS, PLAYER_CELLS, TIER, type BlockDef, type BlockId,
} from '../layout';
import { projectUVs, rng } from './batch';
import type { MatDef } from './materials';
import type { Kit } from './kit';

export type FaceId = 'north' | 'south';
export type SlotKind = 'cell' | 'player' | 'hole' | 'storage';

/** One cell, in a local frame: origin at the cell front centre (floor level), +z into the cell. */
export interface CellSlot {
  block: BlockId;
  face: FaceId;
  tier: number;
  index: number;
  cx: number;
  y0: number;
  zf: number;
  /** rotation of the local frame (0: front faces -Z / north, PI: front faces +Z / south) */
  yaw: number;
  /** interior half width and depth */
  hw: number;
  depth: number;
  kind: SlotKind;
  /** player slot for player cells */
  slot: number;
}

export interface FaceInfo { face: FaceId; zf: number; d: 1 | -1; zBack: number; yaw: number; }

const WALK = 1.2;          // tier walkway width (cantilevered off the cell face)
const RAIL_H = 1.0;
const STAIR_OUT = 1.0;     // B/C end-bay stairs: flight feet this far past the block end
const L2_W = 0.9;          // tier-2 landing depth at the inner end of the bay
const L3_END = 1.9;        // tier-3 landing (0.9 m deep) reaches this far past the block end

export const tierY = (k: number) => FLOOR + TIER[k];
const cellTop = (k: number) => tierY(k) + CELL.height;
const nextY = (k: number) => (k < 2 ? FLOOR + TIER[k + 1] : BLOCK_TOP);

export function partHalf(b: BlockDef) { return b.style === 'treatment' ? 0.09 : (CELL.pitch - CELL.width) / 2; }
export function cellRange(b: BlockDef): [number, number] { return b.id === 'D' ? [2, b.cellsPerFace - 1] : [0, b.cellsPerFace - 1]; }
export const cellX = (b: BlockDef, j: number) => b.cellX0 + j * b.pitch;

export function faceInfo(b: BlockDef, face: FaceId): FaceInfo {
  if (face === 'north') return { face, zf: b.zNorth, d: 1, zBack: b.utility ? b.utility[0] : b.zSouth, yaw: 0 };
  return { face, zf: b.zSouth, d: -1, zBack: b.utility ? b.utility[1] : b.zNorth + 0.2, yaw: Math.PI };
}

const PLAYER_INDEX = new Map(PLAYER_CELLS.map((c) => [c.cellIndex, c.slot]));
const HOLE_INDEX = new Set(HOLE_CELLS.map((h) => Math.round((h.inside[0] - BLOCKS[3].cellX0) / BLOCKS[3].pitch - 0.5)));

// ------------------------------------------------------------------------------------------------
// Instanced templates
// ------------------------------------------------------------------------------------------------
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _yAxis = new THREE.Vector3(0, 1, 0);

function part(g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0) {
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  return g;
}

/** Cell front in local space: plane z = 0, outside toward -z, x centred, y from the tier floor. */
function frontTemplate(width: number, pitch: number, style: 'modern' | 'old') {
  const parts: THREE.BufferGeometry[] = [];
  const H = CELL.height;
  if (style === 'modern') {
    const nb = Math.round(width / 0.11);
    for (let i = 0; i < nb; i++) {
      const x = -width / 2 + (i + 0.5) * (width / nb);
      parts.push(part(new THREE.CylinderGeometry(0.0125, 0.0125, H, 6, 1, true), x, H / 2, -0.015));
    }
    for (const y of [0.06, 0.42, 1.0, 1.55, 2.06]) parts.push(part(new THREE.BoxGeometry(width, 0.045, 0.016), 0, y, -0.015));
    // sliding-door stile, latch and the bottom track
    parts.push(part(new THREE.BoxGeometry(0.05, H, 0.034), -width / 2 + 0.66, H / 2, -0.015));
    parts.push(part(new THREE.BoxGeometry(0.04, 0.12, 0.06), -width / 2 + 0.6, 1.05, -0.04));
    parts.push(part(new THREE.BoxGeometry(width, 0.03, 0.05), 0, 0.015, -0.015));
  } else {
    const nv = Math.round(width / 0.19), nh = Math.round(H / 0.2);
    for (let i = 0; i <= nv; i++) parts.push(part(new THREE.BoxGeometry(0.055, H, 0.012), -width / 2 + (i * width) / nv, H / 2, -0.012));
    for (let j = 0; j <= nh; j++) parts.push(part(new THREE.BoxGeometry(width, 0.055, 0.012), 0, (j * H) / nh, -0.026));
  }
  // lock channel / header in front of the slab edge (continuous along the row)
  parts.push(part(new THREE.BoxGeometry(pitch, 0.32, 0.13), 0, H + 0.16, -0.065));
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  projectUVs(g, 1);
  return g;
}

/** Vent grille (unit 1 x 1, facing +z). With a dark backing for decorative vents on solid walls. */
export function grilleTemplate(backing: boolean) {
  const parts: THREE.BufferGeometry[] = [];
  const colorOf: number[] = [];
  const push = (g: THREE.BufferGeometry, c: number) => { parts.push(g); colorOf.push(c); };
  push(part(new THREE.BoxGeometry(1, 0.12, 0.03), 0, 0.44, 0), 1);
  push(part(new THREE.BoxGeometry(1, 0.12, 0.03), 0, -0.44, 0), 1);
  push(part(new THREE.BoxGeometry(0.1, 1, 0.03), 0.45, 0, 0), 1);
  push(part(new THREE.BoxGeometry(0.1, 1, 0.03), -0.45, 0, 0), 1);
  for (let i = 0; i < 6; i++) push(part(new THREE.BoxGeometry(0.82, 0.08, 0.016), 0, -0.3 + i * 0.12, 0.002, 0.6), 1);
  if (backing) push(part(new THREE.PlaneGeometry(0.86, 0.86), 0, 0, -0.012), 0.05);
  for (let i = 0; i < parts.length; i++) {
    const n = parts[i].attributes.position.count;
    const c = new Float32Array(n * 3).fill(colorOf[i]);
    parts[i].setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  projectUVs(g, 0.3);
  return g;
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, matrices: THREE.Matrix4[], name: string) {
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, matrices.length));
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.count = matrices.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  mesh.name = name;
  return mesh;
}

// ------------------------------------------------------------------------------------------------
// Build
// ------------------------------------------------------------------------------------------------
export interface BlocksResult {
  slots: CellSlot[];
  /** night-light positions under the tier-2 walkways (for the fixtures pass) */
  nightLights: [number, number, number][];
}

export function buildBlocks(kit: Kit): BlocksResult {
  const slots: CellSlot[] = [];
  const nightLights: [number, number, number][] = [];
  const fronts = { modern: [] as THREE.Matrix4[], wide: [] as THREE.Matrix4[], old: [] as THREE.Matrix4[] };
  const grilles: THREE.Matrix4[] = [];
  const r = rng(4242);

  for (const b of BLOCKS) {
    const paint = b.style === 'old' ? kit.mats.oldPaint : kit.mats.cell;
    const ph = partHalf(b);
    const hw = b.pitch / 2 - ph;
    const [i0, i1] = cellRange(b);
    for (const face of b.faces) {
      const f = faceInfo(b, face);
      const depth = Math.abs(f.zBack - f.zf);
      for (let k = 0; k < b.tiers; k++) {
        const y0 = tierY(k), yc = cellTop(k), yn = nextY(k);
        const xa = cellX(b, i0) - ph, xb = cellX(b, i1 + 1) + ph;
        // partitions between cells
        for (let j = i0; j <= i1 + 1; j++) kit.batch.boxMM(paint, cellX(b, j) - ph, y0, f.zf, cellX(b, j) + ph, yc, f.zBack);
        // slab above (ceiling of this tier, floor of the next; block-top slab on tier 3)
        kit.batch.boxMM(kit.mats.floor, xa, yc, f.zf, xb, yn, f.zBack);
        // B-Block back walls toward the open utility corridor (two skins: painted cell side, raw corridor side)
        if (b.id === 'B') buildBBackWall(kit, f, k, xa, xb);
        for (let i = i0; i <= i1; i++) {
          const cx = cellX(b, i) + b.pitch / 2;
          let kind: SlotKind = b.style === 'old' ? 'storage' : 'cell';
          let slot = -1;
          if (b.id === 'B' && face === 'north' && k === 0 && PLAYER_INDEX.has(i)) { kind = 'player'; slot = PLAYER_INDEX.get(i)!; }
          if (b.id === 'D' && k === 0 && HOLE_INDEX.has(i)) kind = 'hole';
          slots.push({ block: b.id, face, tier: k, index: i, cx, y0, zf: f.zf, yaw: f.yaw, hw, depth, kind, slot });
          _q.setFromAxisAngle(_yAxis, f.yaw);
          const fm = new THREE.Matrix4().compose(_v.set(cx, y0, f.zf), _q, _s);
          (b.style === 'old' ? fronts.old : b.style === 'treatment' ? fronts.wide : fronts.modern).push(fm);
          // decorative vent grilles (player cells get their own, removable ones)
          if (b.style !== 'old' && kind !== 'player') {
            const vx = cx + (f.d === 1 ? 0.1 : -0.1);
            grilles.push(grilleMatrix(vx, y0 + 0.2, f.zBack - f.d * 0.012, f.d === 1 ? Math.PI : 0, 0.24, 0.16));
            if (b.id === 'B') grilles.push(grilleMatrix(vx, y0 + 0.2, f.zBack + f.d * 0.162, f.d === 1 ? 0 : Math.PI, 0.24, 0.16));
          }
        }
        if (k >= 1) buildWalkway(kit, b, f, k);
        // night lights hung under the tier-2 walkway edge, facing the aisle (A-Block stays dark)
        if (k === 1 && b.style !== 'old') {
          for (let i = i0 + 2; i <= i1; i += 5) nightLights.push([cellX(b, i), tierY(1) - 0.32, f.zf - f.d * (WALK - 0.15)]);
        }
        // gang-lock boxes at both ends of the flats (upper tiers: the walkway meets the stair landing there)
        if (b.style === 'modern' && k === 0) {
          for (const x of [cellX(b, i0) - 0.3, cellX(b, i1 + 1) + 0.3]) kit.batch.box(kit.mats.darkSteel, x, y0 + 1.0, f.zf - f.d * 0.13, 0.42, 1.0, 0.24);
        }
      }
      if (b.id === 'B' || b.id === 'C') { buildStairBay(kit, b, f, 'west'); buildStairBay(kit, b, f, 'east'); }
    }
    if (b.utility && b.id !== 'B') {
      // closed utility corridors of A and C: a solid core (the backs of both cell rows) that stops
      // 1 m below the block top, so the open pipe-chase gap still reads from the galleries above
      const [u0, u1] = b.utility, ch = BLOCK_TOP - 1.0;
      kit.batch.boxMM(paint, b.x0, FLOOR, u0, b.x1, ch, u1);
      kit.batch.boxMM(paint, b.x0, ch, u0, b.x1, BLOCK_TOP, u0 + 0.15);
      kit.batch.boxMM(paint, b.x0, ch, u1 - 0.15, b.x1, BLOCK_TOP, u1);
      kit.batch.quadY(kit.mats.dark, b.x0 + 0.05, u0 + 0.15, b.x1 - 0.05, u1 - 0.15, ch + 0.01, true);
      for (const z of [u0 + 0.32, u1 - 0.3]) kit.batch.cyl(kit.mats.pipe, [b.x0 + 0.1, ch + 0.12, z], [b.x1 - 0.1, ch + 0.12, z], 0.07, 8);
    }
    if (b.id === 'A') buildABlockEnds(kit, b, r);
    if (b.id === 'D') buildDBlock(kit, b);
    blockColliders(kit, b);
  }

  // instanced fronts and decorative grilles
  const B = BLOCKS[1], D = BLOCKS[3];
  kit.root.add(instanced(frontTemplate(CELL.width, B.pitch, 'modern'), kit.mats.steel.mat, fronts.modern, 'cellhouse:fronts'));
  kit.root.add(instanced(frontTemplate(D.pitch - 0.18, D.pitch, 'modern'), kit.mats.steel.mat, fronts.wide, 'cellhouse:frontsD'));
  kit.root.add(instanced(frontTemplate(CELL.width, B.pitch, 'old'), kit.mats.darkSteel.mat, fronts.old, 'cellhouse:frontsA'));
  kit.root.add(instanced(grilleTemplate(true), kit.mats.grilleMat, grilles, 'cellhouse:grilles'));

  buildStorageClutter(kit, slots, r);
  buildHoleCells(kit, slots);
  return { slots, nightLights };
}

function grilleMatrix(x: number, y: number, z: number, yaw: number, w: number, h: number) {
  _q.setFromAxisAngle(_yAxis, yaw);
  return new THREE.Matrix4().compose(_v.set(x, y, z), _q, new THREE.Vector3(w, h, 1));
}

/** B back walls; the ground tier of the Michigan face is cut open at the four player-cell vents. */
export const VENT_W = 0.36, VENT_H = 0.25, VENT_Y = 0.22;
function buildBBackWall(kit: Kit, f: FaceInfo, k: number, xa: number, xb: number) {
  const { batch, mats } = kit;
  const y0 = tierY(k), y1 = nextY(k);
  // skins: [cell side, corridor side]
  const z0 = f.zBack, zm = f.zBack + f.d * 0.075, z1 = f.zBack + f.d * 0.15;
  const holes = f.face === 'north' && k === 0 ? PLAYER_CELLS.map((c) => c.vent[0]).sort((a, b) => a - b) : [];
  let x = xa;
  const run = (x0: number, x1: number, ya: number, yb: number) => {
    batch.boxMM(mats.cell, x0, ya, z0, x1, yb, zm);
    batch.boxMM(mats.oldPaint, x0, ya, zm, x1, yb, z1);
  };
  for (const vx of holes) {
    const h0 = vx - VENT_W / 2, h1 = vx + VENT_W / 2;
    run(x, h0, y0, y1);
    run(h0, h1, y0, y0 + VENT_Y - VENT_H / 2);
    run(h0, h1, y0 + VENT_Y + VENT_H / 2, y1);
    // rough dug-out reveal lining the hole
    const ya = y0 + VENT_Y - VENT_H / 2, yb = y0 + VENT_Y + VENT_H / 2;
    batch.boxMM(mats.dark, h0, ya, z0, h0 + 0.015, yb, z1);
    batch.boxMM(mats.dark, h1 - 0.015, ya, z0, h1, yb, z1);
    batch.boxMM(mats.dark, h0, ya, z0, h1, ya + 0.012, z1);
    batch.boxMM(mats.dark, h0, yb - 0.012, z0, h1, yb, z1);
    x = h1;
  }
  run(x, xb, y0, y1);
}

/** Cantilevered tier walkway with a pipe railing and brackets. */
function buildWalkway(kit: Kit, b: BlockDef, f: FaceInfo, k: number) {
  const { batch, mats, cols } = kit;
  const y = tierY(k);
  const [i0, i1] = cellRange(b);
  let xa = cellX(b, i0) - 0.1, xb = cellX(b, i1 + 1) + 0.1;
  if (b.id === 'B' || b.id === 'C') {
    // tier 2 meets the inner landings; tier 3 meets the outer landings (which carry their own rails)
    if (k === 1) { xa = cellX(b, i0) - L2_W; xb = cellX(b, i1 + 1) + L2_W; } else { xa = b.x0 - STAIR_OUT; xb = b.x1 + STAIR_OUT; }
  }
  if (b.id === 'D') xa = -30.3;
  const zo = f.zf - f.d * WALK;
  batch.boxMM(mats.floor, xa, y - 0.12, zo, xb, y, f.zf);
  batch.boxMM(mats.darkSteel, xa, y - 0.2, zo - f.d * 0.02, xb, y + 0.03, zo + f.d * 0.03);
  cols.mm(xa, y - 0.2, zo, xb, y, f.zf);
  // railing on the open edge
  const zr = zo + f.d * 0.04;
  railing(kit, xa, zr, xb, zr, y, b.pitch);
  // end railings across the walkway (B/C tier 3 ends join the landings instead)
  if (!((b.id === 'B' || b.id === 'C') && k === 2)) {
    railing(kit, xa + 0.03, zr, xa + 0.03, f.zf, y, 2);
    railing(kit, xb - 0.03, zr, xb - 0.03, f.zf, y, 2);
  }
  // brackets under the walkway at every partition
  for (let j = i0; j <= i1 + 1; j += 2) {
    const x = cellX(b, j);
    batch.boxMM(mats.darkSteel, x - 0.035, y - 0.48, Math.min(zo, f.zf), x + 0.035, y - 0.12, Math.max(zo, f.zf));
  }
}

/** Pipe railing (posts, top and mid rail) along a straight segment, with a collider. */
export function railing(kit: Kit, x0: number, z0: number, x1: number, z1: number, y: number, postEvery: number, h = RAIL_H) {
  const { batch, mats, cols } = kit;
  batch.cyl(mats.steel, [x0, y + h, z0], [x1, y + h, z1], 0.024, 6);
  batch.cyl(mats.steel, [x0, y + h * 0.5, z0], [x1, y + h * 0.5, z1], 0.018, 6);
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(len / postEvery));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
    batch.cyl(mats.steel, [x, y, z], [x, y + h, z], 0.02, 6, true);
  }
  cols.fence(x0, z0, x1, z1, y, y + h + 0.05);
}

/** Steel stair flight between two foot positions (treads, stringers, optional outer rail). */
function flight(kit: Kit, a: [number, number, number], b: [number, number, number], zA: number, zB: number) {
  const { batch, mats, cols } = kit;
  const rise = b[1] - a[1];
  const n = Math.max(2, Math.round(Math.abs(rise) / 0.21));
  for (const z of [zA, zB]) batch.beam(mats.darkSteel, [a[0], a[1] - 0.12, z], [b[0], b[1] - 0.12, z], 0.04, 0.24);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    batch.box(mats.darkSteel, a[0] + (b[0] - a[0]) * t, a[1] + rise * t - 0.02, (zA + zB) / 2, Math.abs(b[0] - a[0]) / n + 0.04, 0.035, Math.abs(zB - zA) - 0.04);
  }
  const zc = (zA + zB) / 2;
  cols.ramp([a[0], a[1], zc], [b[0], b[1], zc], Math.abs(zB - zA));
}

/**
 * Stairs in the end bay of B/C (where cells were removed): flight 1 from the aisle up to a tier-2
 * landing at the bay's inner end, flight 2 back out to a tier-3 landing cantilevered past the block
 * end, which joins the tier-3 walkway. See docs in the header of this file.
 */
function buildStairBay(kit: Kit, b: BlockDef, f: FaceInfo, end: 'west' | 'east') {
  const { batch, mats, cols } = kit;
  const sx = end === 'west' ? 1 : -1;            // +x points into the block from this end
  const E = end === 'west' ? b.x0 : b.x1;        // block end
  const C = end === 'west' ? b.cellX0 : cellX(b, b.cellsPerFace); // first/last cell boundary
  const y2 = tierY(1), y3 = tierY(2);
  const zf = f.zf, d = f.d;
  const zMid = zf + 1.25 * d, zIn = zf + 2.5 * d;
  // flight feet 1 m past the block end, a 0.9 m tier-2 landing (the 0.6 m capsule must turn there):
  // both flights then run 2.7 m for 2.5 / 2.6 m of rise (43-44 deg, under the 50 deg climb limit)
  const xBottom = E - STAIR_OUT * sx, xL2 = C - L2_W * sx;
  // flight 1 (aisle side) and flight 2 (inner side)
  flight(kit, [xBottom, FLOOR, 0], [xL2, y2, 0], zf + 0.03 * d, zMid - 0.03 * d);
  flight(kit, [xL2, y2, 0], [xBottom, y3, 0], zMid + 0.03 * d, zIn - 0.03 * d);
  // tier-2 landing at the inner end of the bay
  const lx0 = Math.min(xL2, C), lx1 = Math.max(xL2, C);
  batch.boxMM(mats.floor, lx0, y2 - 0.15, zf, lx1, y2, zIn);
  cols.mm(lx0, y2 - 0.15, Math.min(zf, zIn), lx1, y2, Math.max(zf, zIn));
  // tier-3 landing past the block end (joins the tier-3 walkway)
  const L3a = E - L3_END * sx, L3b = E - STAIR_OUT * sx;
  const zo = zf - WALK * d;
  batch.boxMM(mats.floor, L3a, y3 - 0.15, zo, L3b, y3, zIn);
  batch.boxMM(mats.darkSteel, L3a, y3 - 0.22, zo, L3b, y3 - 0.15, zIn);
  cols.mm(Math.min(L3a, L3b), y3 - 0.15, Math.min(zo, zIn), Math.max(L3a, L3b), y3, Math.max(zo, zIn));
  railing(kit, L3a + 0.03 * sx, zo, L3a + 0.03 * sx, zIn, y3, 1.2);
  railing(kit, L3a, zIn - 0.03 * d, L3b, zIn - 0.03 * d, y3, 1.0);
  railing(kit, L3a, zo + 0.04 * d, L3b, zo + 0.04 * d, y3, 1.0);   // continues the walkway's outer rail
  railing(kit, L3b, zf, L3b, zMid, y3, 1.0);                    // over flight 1's foot
  railing(kit, L3b, zf + 0.03 * d, C, zf + 0.03 * d, y3, 1.3);   // tier-3 walkway edge over the stairwell
  // the tier-3 landing hangs from the block end on two steel hangers (no posts: the guards' end
  // lanes at x = -28.5 / 28.8 and the approach to the utility door stay clear)
  for (const z of [zo + 0.05 * d, zIn - 0.05 * d]) {
    batch.beam(mats.darkSteel, [L3a, y3 - 0.2, z], [E, BLOCK_TOP - 0.3, z], 0.04, 0.04);
  }
  // outer stringer rail of flight 1 (with a full-height side collider so the flight is entered from its foot)
  batch.cyl(mats.steel, [xBottom, FLOOR + 0.95, zf + 0.02 * d], [xL2, y2 + 0.95, zf + 0.02 * d], 0.024, 6);
  batch.cyl(mats.steel, [xBottom, FLOOR, zf + 0.02 * d], [xBottom, FLOOR + 0.95, zf + 0.02 * d], 0.02, 6, true);
  cols.mm(Math.min(xBottom, xL2), FLOOR, zf + 0.0 * d, Math.max(xBottom, xL2), y2 + 1.0, zf + 0.05 * d);
  // divider between the flights: rail visually, solid collider
  batch.cyl(mats.steel, [xBottom, FLOOR + 0.95, zMid], [xL2, y2 + 0.95, zMid], 0.024, 6);
  batch.cyl(mats.steel, [xL2, y2 + 0.95, zMid], [xBottom, y3 + 0.95, zMid], 0.024, 6);
  for (const x of [xBottom, xL2]) batch.cyl(mats.steel, [x, FLOOR, zMid], [x, y3 + 0.95, zMid], 0.022, 6, true);
  cols.mm(Math.min(xBottom, xL2), FLOOR, zMid - 0.03, Math.max(xBottom, xL2), y3 + 1.0, zMid + 0.03);
  // back strip between the stairwell and the utility corridor, and the block-top slab over the bay
  const bx0 = Math.min(E, C), bx1 = Math.max(E, C);
  batch.boxMM(mats.cell, bx0, FLOOR, zIn, bx1, BLOCK_TOP, f.zBack);
  cols.mm(bx0, FLOOR, Math.min(zIn, f.zBack), bx1, BLOCK_TOP, Math.max(zIn, f.zBack));
  batch.boxMM(mats.floor, bx0, BLOCK_TOP - 0.2, zf, bx1, BLOCK_TOP, zIn);
  cols.mm(bx0, BLOCK_TOP - 0.2, Math.min(zf, zIn), bx1, BLOCK_TOP, Math.max(zf, zIn));
  // bay side wall face at the block end above the landings (concrete pier at the corner)
  batch.boxMM(mats.cell, E - 0.0, y3 + 1.1, zf, E + 0.15 * sx, BLOCK_TOP - 0.2, zf + 0.15 * d);
}

/** A-Block ends: solid masses, a decorative spiral stair in the west bay on the Michigan side. */
function buildABlockEnds(kit: Kit, b: BlockDef, _r: () => number) {
  const { batch, mats, cols } = kit;
  const west = [b.x0, b.cellX0] as const;
  const east = [cellX(b, b.cellsPerFace), b.x1] as const;
  batch.boxMM(mats.oldPaint, east[0], FLOOR, b.zNorth, east[1], BLOCK_TOP, b.zSouth);
  batch.boxMM(mats.oldPaint, west[0], FLOOR, b.zNorth, west[1], BLOCK_TOP, -15.0);
  // spiral stair (old 1912 style) in the open part of the west bay
  const cx = (west[0] + west[1]) / 2, cz = -14.1, rad = 0.75;
  batch.cyl(mats.darkSteel, [cx, FLOOR, cz], [cx, tierY(2) + 1.0, cz], 0.07, 10);
  const steps = 30;
  for (let i = 0; i < steps; i++) {
    const a = i * 0.42, y = FLOOR + 0.2 + (i * (tierY(2) - FLOOR)) / steps;
    _q.setFromAxisAngle(_yAxis, -a);
    batch.boxQ(mats.darkSteel, _v.set(cx + Math.cos(a) * rad * 0.5, y, cz + Math.sin(a) * rad * 0.5), new THREE.Vector3(rad, 0.03, 0.26), _q);
  }
  for (let i = 0; i < steps; i += 1) {
    const a0 = i * 0.42, a1 = (i + 1) * 0.42;
    const y0 = FLOOR + 1.1 + (i * (tierY(2) - FLOOR)) / steps, y1 = FLOOR + 1.1 + ((i + 1) * (tierY(2) - FLOOR)) / steps;
    batch.cyl(mats.darkSteel, [cx + Math.cos(a0) * rad, y0, cz + Math.sin(a0) * rad], [cx + Math.cos(a1) * rad, y1, cz + Math.sin(a1) * rad], 0.018, 5);
  }
  batch.boxMM(mats.floor, west[0], BLOCK_TOP - 0.2, -15.0, west[1], BLOCK_TOP, b.zSouth);
  cols.box(cx, (FLOOR + BLOCK_TOP) / 2, cz, rad + 0.1, (BLOCK_TOP - FLOOR) / 2, rad + 0.1);
}

/** D-Block: back wall onto Park Avenue, the west-end passage under the gallery, the hole cells. */
function buildDBlock(kit: Kit, b: BlockDef) {
  const { batch, mats, cols } = kit;
  const x2 = cellX(b, 2);                       // -26.8: first cell kept at the west end
  const xe = cellX(b, b.cellsPerFace);          // -1.6
  // back wall (cells back onto it, Park Avenue on the other side)
  batch.boxMM(mats.cell, x2 - 0.09, FLOOR, b.zNorth, xe + 0.09, BLOCK_TOP, b.zNorth + 0.2);
  // west end above the passage: solid mass up to the block top; the passage ceiling slab
  batch.boxMM(mats.cell, -30.3, FLOOR + 2.5, b.zNorth, x2 - 0.09, BLOCK_TOP, b.zSouth);
  batch.boxMM(mats.floor, -30.3, FLOOR + 2.25, b.zNorth, x2, FLOOR + 2.5, b.zSouth);
  for (const z of [b.zNorth + 0.15, b.zSouth - 0.15]) {
    batch.boxMM(mats.cell, -30.42, FLOOR, z - 0.12, -30.18, FLOOR + 2.25, z + 0.12);
    cols.mm(-30.42, FLOOR, z - 0.12, -30.18, FLOOR + 2.25, z + 0.12);
  }
  // outer solid steel doors of the hole cells, standing open
  for (const h of HOLE_CELLS) {
    const hx = h.inside[0] + (b.pitch / 2 - 0.09);
    batch.boxMM(mats.darkSteel, hx + 0.01, FLOOR + 0.02, b.zSouth + 0.02, hx + 0.07, FLOOR + 2.12, b.zSouth + 0.98);
    batch.boxMM(mats.darkSteel, hx - 0.04, FLOOR + 1.45, b.zSouth + 0.3, hx + 0.12, FLOOR + 1.6, b.zSouth + 0.42);
    cols.mm(hx + 0.01, FLOOR, b.zSouth + 0.02, hx + 0.07, FLOOR + 2.12, b.zSouth + 0.98);
  }
}

/** Solid masses where players can't go, plus hollow player cells and hole cells. */
function blockColliders(kit: Kit, b: BlockDef) {
  const { cols } = kit;
  const ph = partHalf(b);
  const [i0, i1] = cellRange(b);
  const xa = cellX(b, i0) - ph, xb = cellX(b, i1 + 1) + ph;
  const yc0 = FLOOR + CELL.height;
  if (b.id === 'A') {
    cols.mm(xa, FLOOR, b.zNorth, b.x1, BLOCK_TOP, b.zSouth);
    cols.mm(b.x0, FLOOR, b.zNorth, xa, BLOCK_TOP, -15.0);
  } else if (b.id === 'C') {
    cols.mm(xa, FLOOR, b.zNorth, xb, BLOCK_TOP, b.zSouth);
    for (const [x0, x1] of [[b.x0, b.cellX0], [cellX(b, b.cellsPerFace), b.x1]]) cols.mm(x0, FLOOR, b.utility![0], x1, BLOCK_TOP, b.utility![1]);
  } else if (b.id === 'B') {
    const zN = b.zNorth, zBN = b.utility![0], zBS = b.utility![1], zS = b.zSouth;
    // Michigan face, ground tier: runs of ordinary cells; player cells stay hollow
    const players = PLAYER_CELLS.map((c) => c.cellIndex).sort((p, q) => p - q);
    let start = i0;
    for (const pi of [...players, i1 + 1]) {
      if (pi > start) cols.mm(cellX(b, start), FLOOR, zN, cellX(b, pi), yc0, zBN);
      start = pi + 1;
    }
    for (const c of PLAYER_CELLS) {
      const x0 = cellX(b, c.cellIndex), x1 = cellX(b, c.cellIndex + 1);
      cols.mm(x0 - ph, FLOOR, zN, x0 + ph, yc0, zBN);                 // partitions
      cols.mm(x1 - ph, FLOOR, zN, x1 + ph, yc0, zBN);
      cols.mm(x0, FLOOR, zN - 0.06, x1, yc0, zN + 0.04);               // bars: no leaving through the front
    }
    cols.mm(xa, yc0, zN, xb, BLOCK_TOP, zBN);                          // upper tiers, Michigan face
    cols.mm(xa, FLOOR, zBS, xb, BLOCK_TOP, zS);                        // Broadway face, all tiers
  } else if (b.id === 'D') {
    const zN = b.zNorth, zS = b.zSouth;
    const holes = [...HOLE_INDEX].sort((p, q) => p - q);
    const h0 = holes[0];
    cols.mm(xa, FLOOR, zN, cellX(b, h0), yc0, zS);                     // ordinary cells, ground tier
    cols.mm(xa, yc0, zN, xb, BLOCK_TOP, zS);                           // upper tiers (hole-cell ceilings)
    cols.mm(-30.3, FLOOR + 2.25, zN, xa, BLOCK_TOP, zS);               // mass above the west passage
    cols.mm(cellX(b, h0), FLOOR, zN, xb, yc0, zN + 0.2);               // hole cells' back wall
    for (const i of holes) {
      const x0 = cellX(b, i), x1 = cellX(b, i + 1);
      cols.mm(x0 - ph, FLOOR, zN, x0 + ph, yc0, zS);
      cols.mm(x1 - ph, FLOOR, zN, x1 + ph, yc0, zS);
      cols.mm(x0, FLOOR, zS - 0.04, x1, yc0, zS + 0.06);               // barred inner door
    }
  }
}

/** A-Block cells (storage in 1962): crates, cartons, rolled mattresses, spare bunk frames. */
function buildStorageClutter(kit: Kit, slots: CellSlot[], r: () => number) {
  const { batch, mats } = kit;
  const carton = new THREE.Color(0x8a6d4a), carton2 = new THREE.Color(0x6e5a40);
  const toWorld = (s: CellSlot, u: number, w: number) => {
    const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
    return [s.cx + u * c + w * sn, s.zf + (-u * sn + w * c)] as const;
  };
  for (const s of slots) {
    if (s.kind !== 'storage') continue;
    const n = 1 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const kind = r();
      const [x, z] = toWorld(s, (r() - 0.5) * (s.hw * 2 - 0.6), 0.5 + r() * (s.depth - 0.9));
      if (kind < 0.45) {
        const sx = 0.4 + r() * 0.3, sy = 0.3 + r() * 0.35, sz = 0.35 + r() * 0.3;
        batch.box(mats.wood, x, s.y0 + sy / 2, z, sx, sy, sz, r() * 0.4);
        if (r() < 0.5) batch.box(mats.furnLow, x, s.y0 + sy + 0.13, z, sx * 0.8, 0.26, sz * 0.8, r(), { color: r() < 0.5 ? carton : carton2 });
      } else if (kind < 0.75) {
        batch.cyl(mats.mattress, [x - 0.35, s.y0 + 0.17, z], [x + 0.35, s.y0 + 0.17, z], 0.17, 10);
      } else {
        batch.box(mats.darkSteel, x, s.y0 + 0.4, z, 0.05, 0.8, 1.8, s.yaw);
      }
    }
  }
}

/** Hole cells: bare floor mattress in the dark cells, nothing but a drain in the strip cell. */
function buildHoleCells(kit: Kit, slots: CellSlot[]) {
  const { batch, mats } = kit;
  const holes = slots.filter((s) => s.kind === 'hole').sort((a, b) => a.index - b.index);
  holes.forEach((s, i) => {
    const zBack = s.zf - s.depth; // interior face of the back wall (D faces south: zf > zBack)
    if (i < holes.length - 1) batch.boxMM(mats.mattress, s.cx - 0.8, s.y0, zBack + 0.1, s.cx - 0.1, s.y0 + 0.1, zBack + 2.0);
    else batch.cyl(mats.dark, [s.cx, s.y0, zBack + 1.2], [s.cx, s.y0 + 0.004, zBack + 1.2], 0.08, 10);
  });
}

/** Material lookup used by other builders for block paint. */
export function blockPaint(kit: Kit, b: BlockDef): MatDef { return b.style === 'old' ? kit.mats.oldPaint : kit.mats.cell; }
