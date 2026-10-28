// Cell furniture with a cheap dynamic LOD. Every furnished cell always has a low-detail instanced
// stand-in (one draw call per cell width); the K cells nearest the camera (plus the four player
// cells, permanently) get the real Meshy models (`cell_bunk`, `cell_toilet`, `cell_sink`,
// `cell_table`) through fixed-size instanced pools whose matrices are re-assigned a few times a
// second. ~12k triangles per furnished cell would otherwise put ~4.5 M triangles on screen.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Ctx } from '../../game/context';
import { FLOOR, PLAYER_CELLS } from '../layout';
import { projectUVs } from './batch';
import type { CellSlot } from './blocks';
import type { Kit } from './kit';

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _t = new THREE.Matrix4();
const _f = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _yAxis = new THREE.Vector3(0, 1, 0);

/**
 * A fixed-size pool of instances of a manifest model created through ctx.models.instanced().
 * Instances can be moved or hidden later; each sub-mesh's own transform inside the model is
 * recovered from the matrices the models module wrote, so placement stays correct.
 */
export class ModelPool {
  readonly object: THREE.Object3D;
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly local: THREE.Matrix4[] = [];
  private readonly meshInv: THREE.Matrix4[] = [];

  constructor(ctx: Ctx, id: string, readonly count: number, opts: { castShadow?: boolean; receiveShadow?: boolean } = {}) {
    const base = new THREE.Matrix4().makeTranslation(0, -1000, 0);
    const baseInv = base.clone().invert();
    this.object = ctx.models.instanced(id, Array.from({ length: count }, () => base.clone()), opts);
    this.object.name = `cellhouse:pool:${id}`;
    this.object.updateMatrixWorld(true);
    const rootInv = this.object.matrixWorld.clone().invert();
    const inst0 = new THREE.Matrix4();
    this.object.traverse((o) => {
      const im = o as THREE.InstancedMesh;
      if (!im.isInstancedMesh) return;
      const w = new THREE.Matrix4().multiplyMatrices(rootInv, im.matrixWorld); // mesh relative to the pool root
      im.getMatrixAt(0, inst0);
      this.meshes.push(im);
      this.local.push(new THREE.Matrix4().multiplyMatrices(baseInv, w).multiply(inst0));
      this.meshInv.push(w.invert());
    });
    for (let i = 0; i < count; i++) this.hide(i);
    this.commit();
  }

  /** Place instance i at world matrix m (pool root is expected at the world origin). */
  set(i: number, m: THREE.Matrix4) {
    for (let k = 0; k < this.meshes.length; k++) {
      _t.multiplyMatrices(this.meshInv[k], m).multiply(this.local[k]);
      this.meshes[k].setMatrixAt(i, _t);
    }
  }

  hide(i: number) { for (const m of this.meshes) m.setMatrixAt(i, ZERO); }

  commit() {
    for (const m of this.meshes) {
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }
}

/** Furniture placement inside a cell, from its half width and depth (matches PLAYER_CELLS). */
export function furnitureLayout(hw: number, depth: number) {
  return {
    bunk: [-(hw - 0.38), 0, depth / 2] as const,
    toilet: [hw - 0.34, 0, depth - 0.29] as const,
    sink: [hw - 0.34, 0.62, depth - 0.22] as const,
    table: [hw - 0.18, 0, 0.8] as const,
  };
}
const BUNK_SCALE_X = 0.74; // the model is 0.95 m wide; real Alcatraz bunks are ~0.7 m

/** World matrix of the cell frame (origin at the front centre, +z into the cell). */
export function cellFrame(out: THREE.Matrix4, s: CellSlot) {
  _q.setFromAxisAngle(_yAxis, s.yaw);
  return out.compose(_v.set(s.cx, s.y0, s.zf), _q, _one);
}
function local(out: THREE.Matrix4, frame: THREE.Matrix4, p: readonly [number, number, number], yaw: number, sx = 1) {
  _q.setFromAxisAngle(_yAxis, yaw);
  _t.compose(_v.set(p[0], p[1], p[2]), _q, new THREE.Vector3(sx, 1, 1));
  return out.multiplyMatrices(frame, _t);
}

/** Low-detail furniture in cell-local coordinates (vertex coloured boxes, ~200 triangles). */
function lowTemplate(hw: number, depth: number) {
  const L = furnitureLayout(hw, depth);
  const parts: THREE.BufferGeometry[] = [];
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, c: number) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(x, y, z);
    g.deleteAttribute('uv');
    const col = new THREE.Color(c);
    const arr = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < arr.length; i += 3) { arr[i] = col.r; arr[i + 1] = col.g; arr[i + 2] = col.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    parts.push(g);
  };
  const [bx, , bz] = L.bunk;
  box(bx, 0.44, bz, 0.7, 0.06, 1.9, 0x5d625c);                      // frame
  for (const dx of [-0.32, 0.32]) for (const dz of [-0.9, 0.9]) box(bx + dx, 0.21, bz + dz, 0.04, 0.42, 0.04, 0x4a4e4a);
  box(bx, 0.53, bz, 0.66, 0.12, 1.84, 0x8e939a);                    // mattress
  box(bx, 0.6, bz - 0.15, 0.68, 0.035, 1.45, 0x6b6656);             // blanket
  box(bx, 0.62, bz + 0.78, 0.5, 0.09, 0.28, 0xc9c6bb);              // pillow
  const [tx, , tz] = L.toilet;
  box(tx, 0.2, tz, 0.36, 0.4, 0.46, 0xd8d6cf);
  const [sx, sy, sz] = L.sink;
  box(sx, sy + 0.09, sz, 0.42, 0.18, 0.36, 0xd8d6cf);
  const [ax, , az] = L.table;
  box(ax, 0.58, az, 0.32, 0.035, 0.62, 0x4f5550);
  box(ax - 0.05, 0.3, az + 0.55, 0.26, 0.03, 0.3, 0x4f5550);         // fold-down seat
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  projectUVs(g, 1);
  return g;
}

export class Furniture {
  private readonly pools: Record<'bunk' | 'toilet' | 'sink' | 'table', ModelPool>;
  private readonly poolList: ModelPool[];
  private readonly lows: THREE.InstancedMesh[] = [];
  /** furnished non-player slots, their low mesh/instance, centres and precomputed model matrices */
  private readonly slots: CellSlot[];
  private readonly lowRef: Int32Array;      // index of the low mesh for each slot
  private readonly lowIdx: Int32Array;      // instance index inside that mesh
  private readonly centres: Float32Array;
  private readonly modelM: THREE.Matrix4[]; // 4 per slot: bunk, toilet, sink, table
  private readonly frameM: THREE.Matrix4[];
  private readonly near: Uint8Array;
  private readonly prevNear: Uint8Array;
  private readonly best: Int32Array;
  private readonly bestD: Float32Array;
  private readonly K: number;
  private readonly lastPick = new THREE.Vector3(1e9, 0, 0);
  private timer = 0;

  constructor(private readonly kit: Kit, all: CellSlot[]) {
    const ctx = kit.ctx;
    this.K = Math.max(12, Math.min(60, Math.round(ctx.quality.drawDistance / 12)));
    this.slots = all.filter((s) => s.kind === 'cell');
    const n = this.slots.length;
    this.lowRef = new Int32Array(n);
    this.lowIdx = new Int32Array(n);
    this.centres = new Float32Array(n * 3);
    this.near = new Uint8Array(n);
    this.prevNear = new Uint8Array(n);
    this.best = new Int32Array(this.K);
    this.bestD = new Float32Array(this.K);
    this.modelM = [];
    this.frameM = [];
    const P = PLAYER_CELLS.length;
    const opts = { castShadow: false, receiveShadow: true };
    this.pools = {
      bunk: new ModelPool(ctx, 'cell_bunk', this.K + P, opts),
      toilet: new ModelPool(ctx, 'cell_toilet', this.K + P, opts),
      sink: new ModelPool(ctx, 'cell_sink', this.K + P, opts),
      table: new ModelPool(ctx, 'cell_table', this.K + P, opts),
    };
    this.poolList = [this.pools.bunk, this.pools.toilet, this.pools.sink, this.pools.table];
    for (const p of this.poolList) kit.root.add(p.object);

    // low-detail stand-ins, one instanced mesh per cell size
    const groups = new Map<string, { hw: number; depth: number; ids: number[] }>();
    this.slots.forEach((s, i) => {
      const key = `${s.hw.toFixed(2)}:${s.depth.toFixed(2)}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { hw: s.hw, depth: s.depth, ids: [] }));
      g.ids.push(i);
    });
    for (const g of groups.values()) {
      const mesh = new THREE.InstancedMesh(lowTemplate(g.hw, g.depth), kit.mats.furnLow.mat, g.ids.length);
      mesh.name = 'cellhouse:furnitureLow';
      mesh.receiveShadow = true;
      const ref = this.lows.length;
      g.ids.forEach((si, k) => { this.lowRef[si] = ref; this.lowIdx[si] = k; });
      this.lows.push(mesh);
      kit.root.add(mesh);
    }
    // precompute matrices
    const tmpF = new THREE.Matrix4();
    this.slots.forEach((s, i) => {
      cellFrame(tmpF, s);
      this.frameM.push(tmpF.clone());
      const L = furnitureLayout(s.hw, s.depth);
      this.modelM.push(
        local(new THREE.Matrix4(), tmpF, L.bunk, 0, BUNK_SCALE_X),
        local(new THREE.Matrix4(), tmpF, L.toilet, Math.PI),
        local(new THREE.Matrix4(), tmpF, L.sink, Math.PI),
        local(new THREE.Matrix4(), tmpF, L.table, -Math.PI / 2),
      );
      const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
      const w = s.depth / 2;
      this.centres[i * 3] = s.cx + w * sn;
      this.centres[i * 3 + 1] = s.y0 + 1.0;
      this.centres[i * 3 + 2] = s.zf + w * c;
      this.lows[this.lowRef[i]].setMatrixAt(this.lowIdx[i], this.frameM[i]);
    });
    for (const m of this.lows) { m.instanceMatrix.needsUpdate = true; m.computeBoundingSphere(); }

    // the four player cells always get full models at their PLAYER_CELLS anchors
    PLAYER_CELLS.forEach((c, i) => {
      const at = (p: readonly number[], yaw: number, sx = 1, y?: number) => {
        _q.setFromAxisAngle(_yAxis, yaw);
        return _f.compose(_v.set(p[0], y ?? p[1], p[2]), _q, new THREE.Vector3(sx, 1, 1));
      };
      this.pools.bunk.set(i, at(c.bunk, 0, BUNK_SCALE_X));
      this.pools.toilet.set(i, at(c.toilet, Math.PI));
      this.pools.sink.set(i, at(c.sink, Math.PI));
      // the table model stands on the floor (its top is ~0.58 m), not at the anchor height
      this.pools.table.set(i, at(c.table, -Math.PI / 2, 1, FLOOR));
    });
    this.buildShelves();
    this.pick(ctx.camera.position, true);
  }

  /** Two wall shelves with a few belongings in every furnished cell (static, merged). */
  private buildShelves() {
    const { batch, mats } = this.kit;
    const tmp = new THREE.Matrix4();
    const all = [...this.slots];
    const rnd = (i: number) => { const s = Math.sin(i * 91.7) * 43758.5; return s - Math.floor(s); };
    const colors = [0x5b1f1c, 0x22324f, 0x2c4532, 0x7a6236, 0xc8c2b0];
    all.forEach((s, i) => {
      cellFrame(tmp, s);
      for (const [y, u] of [[1.42, 0.12], [1.72, 0.12]]) {
        const g = new THREE.BoxGeometry(0.62, 0.025, 0.2);
        g.translate(u, y, s.depth - 0.11);
        batch.addGeometry(mats.wood, g, tmp);
      }
      const nItems = 1 + Math.floor(rnd(i) * 3);
      for (let k = 0; k < nItems; k++) {
        const h = 0.12 + rnd(i * 7 + k) * 0.12;
        const g = new THREE.BoxGeometry(0.05 + rnd(i + k) * 0.08, h, 0.15);
        g.translate(-0.12 + k * 0.14, 1.435 + h / 2 + (k % 2) * 0.3, s.depth - 0.11);
        batch.addGeometry(mats.furnLow, g, tmp, { color: new THREE.Color(colors[(i + k) % colors.length]) });
      }
    });
  }

  /** Re-assign the model pools to the K furnished cells nearest to `p`. Allocation-free. */
  private pick(p: THREE.Vector3, force = false) {
    if (!force && p.distanceToSquared(this.lastPick) < 0.6) return;
    this.lastPick.copy(p);
    const K = this.K, best = this.best, bestD = this.bestD;
    let filled = 0;
    const n = this.slots.length;
    for (let i = 0; i < n; i++) {
      const dx = this.centres[i * 3] - p.x, dy = (this.centres[i * 3 + 1] - p.y) * 1.5, dz = this.centres[i * 3 + 2] - p.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (filled < K) {
        let j = filled++;
        while (j > 0 && bestD[j - 1] > d) { bestD[j] = bestD[j - 1]; best[j] = best[j - 1]; j--; }
        bestD[j] = d; best[j] = i;
      } else if (d < bestD[K - 1]) {
        let j = K - 1;
        while (j > 0 && bestD[j - 1] > d) { bestD[j] = bestD[j - 1]; best[j] = best[j - 1]; j--; }
        bestD[j] = d; best[j] = i;
      }
    }
    this.prevNear.set(this.near);
    this.near.fill(0);
    const P = PLAYER_CELLS.length;
    for (let k = 0; k < K; k++) {
      const i = best[k];
      const pi = P + k;
      if (k >= filled) { this.pools.bunk.hide(pi); this.pools.toilet.hide(pi); this.pools.sink.hide(pi); this.pools.table.hide(pi); continue; }
      this.near[i] = 1;
      this.pools.bunk.set(pi, this.modelM[i * 4]);
      this.pools.toilet.set(pi, this.modelM[i * 4 + 1]);
      this.pools.sink.set(pi, this.modelM[i * 4 + 2]);
      this.pools.table.set(pi, this.modelM[i * 4 + 3]);
    }
    for (let i = 0; i < n; i++) {
      if (this.near[i] === this.prevNear[i] && !force) continue;
      this.lows[this.lowRef[i]].setMatrixAt(this.lowIdx[i], this.near[i] ? ZERO : this.frameM[i]);
    }
    for (let i = 0; i < this.lows.length; i++) this.lows[i].instanceMatrix.needsUpdate = true;
    for (let i = 0; i < this.poolList.length; i++) this.poolList[i].commit();
  }

  update(dt: number) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.35;
    this.pick(this.kit.ctx.camera.position);
  }
}
