// Static geometry batching for the cellhouse: every piece of architecture is added here with its
// material, transformed to world space at build time, given world-projected UVs (so tiling
// textures keep a constant texel density on boxes of any size) and finally merged into ONE mesh
// per material. This is what keeps the whole complex at a few dozen draw calls.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MatDef } from './materials';

type V2 = [number, number];
export type XYZ = readonly [number, number, number];

interface Group { def: MatDef; geos: THREE.BufferGeometry[]; }

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _yAxis = new THREE.Vector3(0, 1, 0);

/** Unit templates, cloned per use (cheap: 24 vertices for a box). */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UNIT_CYL = new Map<string, THREE.CylinderGeometry>();
function unitCylinder(segments: number, open: boolean) {
  const key = `${segments}:${open}`;
  let g = UNIT_CYL.get(key);
  if (!g) UNIT_CYL.set(key, (g = new THREE.CylinderGeometry(0.5, 0.5, 1, segments, 1, open)));
  return g;
}

/** Box-projected UVs from world positions and normals (u,v in metres / tile). */
export function projectUVs(g: THREE.BufferGeometry, tile: number) {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  let uv = g.attributes.uv as THREE.BufferAttribute | undefined;
  if (!uv || uv.itemSize !== 2) {
    uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
    g.setAttribute('uv', uv);
  }
  const inv = 1 / tile;
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (ay >= ax && ay >= az) uv.setXY(i, x * inv, z * inv);
    else if (ax >= az) uv.setXY(i, z * inv, y * inv);
    else uv.setXY(i, x * inv, y * inv);
  }
  uv.needsUpdate = true;
}

/** Ensures a geometry is indexed (mergeGeometries needs all-or-none). */
function ensureIndexed(g: THREE.BufferGeometry) {
  if (g.index) return;
  const n = g.attributes.position.count;
  const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
}

/** Keeps only position/normal/uv (+ color for vertex-coloured groups). */
function normaliseAttributes(g: THREE.BufferGeometry, colors: boolean, color: THREE.Color | undefined) {
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && !(colors && name === 'color')) g.deleteAttribute(name);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (colors && (color || !g.attributes.color)) {
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    const r = color ? color.r : 1, gg = color ? color.g : 1, b = color ? color.b : 1;
    for (let i = 0; i < n; i++) { arr[i * 3] = r; arr[i * 3 + 1] = gg; arr[i * 3 + 2] = b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }
  g.morphAttributes = {};
  g.clearGroups(); // BoxGeometry carries per-face groups; every batch is single-material
}

export interface AddOpts {
  /** keep the geometry's own UVs instead of world projection (signs, books, windows) */
  keepUV?: boolean;
  /** vertex colour for vertex-coloured materials */
  color?: THREE.Color;
}

export class MeshBatch {
  private readonly groups = new Map<MatDef, Group>();
  /** total vertices added, for diagnostics */
  vertices = 0;

  /** Adds a geometry (consumed: it is transformed in place, do not reuse it). */
  addGeometry(def: MatDef, g: THREE.BufferGeometry, matrix: THREE.Matrix4 | null, opts?: AddOpts) {
    if (matrix) g.applyMatrix4(matrix);
    normaliseAttributes(g, def.colors, opts?.color);
    if (!opts?.keepUV) projectUVs(g, def.tile);
    ensureIndexed(g);
    let grp = this.groups.get(def);
    if (!grp) this.groups.set(def, (grp = { def, geos: [] }));
    grp.geos.push(g);
    this.vertices += g.attributes.position.count;
  }

  /** Axis-aligned box from its centre and size, optional yaw about +Y. */
  box(def: MatDef, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, rotY = 0, opts?: AddOpts) {
    if (sx <= 1e-4 || sy <= 1e-4 || sz <= 1e-4) return;
    _q.setFromAxisAngle(_yAxis, rotY);
    _m.compose(_p.set(cx, cy, cz), _q, _s.set(sx, sy, sz));
    this.addGeometry(def, UNIT_BOX.clone(), _m, opts);
  }

  /** Axis-aligned box from two corners (any order). */
  boxMM(def: MatDef, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, opts?: AddOpts) {
    this.box(def, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), 0, opts);
  }

  /** Box with an arbitrary orientation. */
  boxQ(def: MatDef, center: THREE.Vector3, size: THREE.Vector3, q: THREE.Quaternion, opts?: AddOpts) {
    _m.compose(center, q, size);
    this.addGeometry(def, UNIT_BOX.clone(), _m, opts);
  }

  /**
   * Thin box ("beam") from point a to point b with a square-ish cross-section w x h; the h axis is
   * kept as close to world up as possible (stringers, sloped rails, truss members).
   */
  beam(def: MatDef, a: XYZ, b: XYZ, w: number, h: number, opts?: AddOpts) {
    _a.set(a[0], a[1], a[2]);
    _b.set(b[0], b[1], b[2]);
    const len = _a.distanceTo(_b);
    if (len < 1e-4) return;
    orientAlong(_q, _b.sub(_a).normalize());
    _p.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    _m.compose(_p, _q, _s.set(len, h, w));
    this.addGeometry(def, UNIT_BOX.clone(), _m, opts);
  }

  /** Cylinder (bar, pipe, post) from point a to point b. */
  cyl(def: MatDef, a: XYZ, b: XYZ, radius: number, segments = 8, open = false, opts?: AddOpts) {
    _a.set(a[0], a[1], a[2]);
    _b.set(b[0], b[1], b[2]);
    const len = _a.distanceTo(_b);
    if (len < 1e-4) return;
    _q.setFromUnitVectors(_up, _b.sub(_a).normalize());
    _p.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    _m.compose(_p, _q, _s.set(radius * 2, len, radius * 2));
    this.addGeometry(def, unitCylinder(segments, open).clone(), _m, opts);
  }

  /** Horizontal quad at height y covering [x0,x1] x [z0,z1]; facing up or down. */
  quadY(def: MatDef, x0: number, z0: number, x1: number, z1: number, y: number, up: boolean, opts?: AddOpts) {
    const g = new THREE.PlaneGeometry(Math.abs(x1 - x0), Math.abs(z1 - z0));
    g.rotateX(up ? -Math.PI / 2 : Math.PI / 2);
    g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
    this.addGeometry(def, g, null, opts);
  }

  /** Merges every group into one mesh per material and adds them to `parent`. */
  flush(parent: THREE.Object3D) {
    const meshes: THREE.Mesh[] = [];
    for (const grp of this.groups.values()) {
      if (grp.geos.length === 0) continue;
      const merged = grp.geos.length === 1 ? grp.geos[0] : mergeGeometries(grp.geos, false);
      if (!merged) { console.warn(`[cellhouse] merge failed for ${grp.def.name}`); continue; }
      if (merged !== grp.geos[0]) for (const g of grp.geos) g.dispose();
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, grp.def.mat);
      mesh.name = `cellhouse:${grp.def.name}`;
      mesh.castShadow = grp.def.cast;
      mesh.receiveShadow = grp.def.receive;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.groups.clear();
    return meshes;
  }
}

/** Quaternion that maps local +X to `dir`, local +Y as close to world up as possible. */
export function orientAlong(out: THREE.Quaternion, dir: THREE.Vector3) {
  const x = _ox.copy(dir).normalize();
  // pick a reference up that is not parallel to the direction
  _oy.set(0, 1, 0);
  if (Math.abs(x.dot(_oy)) > 0.999) _oy.set(1, 0, 0);
  const z = _oz.crossVectors(x, _oy).normalize();
  const y = _oy.crossVectors(z, x).normalize();
  _om.makeBasis(x, y, z);
  return out.setFromRotationMatrix(_om);
}
const _ox = new THREE.Vector3();
const _oy = new THREE.Vector3();
const _oz = new THREE.Vector3();
const _om = new THREE.Matrix4();

/**
 * Rectangles covering `outer` minus `holes` (all axis-aligned [x0,z0,x1,z1]), via coordinate
 * compression + greedy row merging. Used for ceilings and roofs with skylight openings.
 */
export function rectMinusRects(outer: [number, number, number, number], holes: [number, number, number, number][]) {
  const xs = new Set<number>([outer[0], outer[2]]);
  const zs = new Set<number>([outer[1], outer[3]]);
  for (const h of holes) {
    if (h[2] <= outer[0] || h[0] >= outer[2] || h[3] <= outer[1] || h[1] >= outer[3]) continue;
    xs.add(Math.max(outer[0], h[0])); xs.add(Math.min(outer[2], h[2]));
    zs.add(Math.max(outer[1], h[1])); zs.add(Math.min(outer[3], h[3]));
  }
  const X = [...xs].sort((a, b) => a - b);
  const Z = [...zs].sort((a, b) => a - b);
  const inHole = (x: number, z: number) => holes.some((h) => x > h[0] && x < h[2] && z > h[1] && z < h[3]);
  const out: [number, number, number, number][] = [];
  for (let j = 0; j < Z.length - 1; j++) {
    const zc = (Z[j] + Z[j + 1]) / 2;
    let start = -1;
    for (let i = 0; i <= X.length - 1; i++) {
      const filled = i < X.length - 1 && !inHole((X[i] + X[i + 1]) / 2, zc);
      if (filled && start < 0) start = i;
      if (!filled && start >= 0) { out.push([X[start], Z[j], X[i], Z[j + 1]]); start = -1; }
    }
  }
  return out;
}

/** Point-in-polygon (even-odd) for (x, z) polygons. */
export function insidePoly(poly: V2[], x: number, z: number) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/** Small deterministic RNG (mulberry32) so the layout of clutter is identical for every player. */
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
