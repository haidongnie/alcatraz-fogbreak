// B-Block utility corridor (UTILITY_B): the dark, full-height pipe chase between the two cell rows.
// Crammed with instanced pipes (horizontal runs, risers, couplings), the vent grilles of every
// cell (instanced by blocks.ts), the climbable pipe column at UTILITY_CLIMB (paler worn steel with
// ladder-like brackets so it reads as the way up) and the steel UTILITY_DOOR at the west end that
// swings open (collider disabled) when the `utility_door` flag is set.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { RAPIER } from '../../core/physics';
import { BLOCKS, BLOCK_TOP, FLOOR, UTILITY_B, UTILITY_CLIMB, UTILITY_DOOR } from '../layout';
import { projectUVs, rng } from './batch';
import { DOOR_GROUPS } from './colliders';
import { cellX } from './blocks';
import type { Kit } from './kit';

/** Clear walking band between the pipe layers (collider faces). */
export const CORRIDOR_CLEAR: [number, number] = [-5.99, -5.11];
const WALL_N = -6.11, WALL_S = -4.99;      // corridor faces of the cell back walls
const DOOR_Z0 = -6.0, DOOR_Z1 = -5.1, DOOR_H = 2.05;
const OPEN_ANGLE = -Math.PI * 0.52;        // swings out into Times Square (-x)

export class UtilityCorridor {
  private readonly pivot = new THREE.Group();
  private collider: RAPIER.Collider | null = null;
  private open = false;
  private angle = 0;

  constructor(private readonly kit: Kit) {}

  build() {
    this.buildWallsAndColliders();
    this.buildPipes();
    this.buildClimbColumn();
    this.buildDoor();
  }

  private buildWallsAndColliders() {
    const { batch, mats, cols } = this.kit;
    const x0 = UTILITY_B.x0 - 0.2, x1 = UTILITY_B.x1 + 0.2; // block ends (-25.5, 27.5)
    // pipe-layer colliders: keep the capsule off the pipes (0.88 m clear, like the real 3 ft chase)
    cols.mm(x0, FLOOR, UTILITY_B.z0, x1, BLOCK_TOP, CORRIDOR_CLEAR[0]);
    cols.mm(x0, FLOOR, CORRIDOR_CLEAR[1], x1, BLOCK_TOP, UTILITY_B.z1);
    // west end wall with the door opening, east end wall solid
    const ez0 = -6.5, ez1 = -4.6;
    const wx0 = x0, wx1 = UTILITY_B.x0;
    batch.boxMM(mats.cell, wx0, FLOOR, ez0, wx1, BLOCK_TOP, DOOR_Z0);
    batch.boxMM(mats.cell, wx0, FLOOR, DOOR_Z1, wx1, BLOCK_TOP, ez1);
    batch.boxMM(mats.cell, wx0, FLOOR + DOOR_H, DOOR_Z0, wx1, BLOCK_TOP, DOOR_Z1);
    cols.mm(wx0, FLOOR, ez0, wx1, BLOCK_TOP, DOOR_Z0);
    cols.mm(wx0, FLOOR, DOOR_Z1, wx1, BLOCK_TOP, ez1);
    cols.mm(wx0, FLOOR + DOOR_H, DOOR_Z0, wx1, BLOCK_TOP, DOOR_Z1);
    batch.boxMM(mats.cell, UTILITY_B.x1, FLOOR, ez0, x1, BLOCK_TOP, ez1);
    cols.mm(UTILITY_B.x1, FLOOR, ez0, x1, BLOCK_TOP, ez1);
    // door frame (steel jambs and head) on the Times Square face
    batch.boxMM(mats.darkSteel, wx0 - 0.03, FLOOR, DOOR_Z0 - 0.08, wx1, FLOOR + DOOR_H + 0.08, DOOR_Z0);
    batch.boxMM(mats.darkSteel, wx0 - 0.03, FLOOR, DOOR_Z1, wx1, FLOOR + DOOR_H + 0.08, DOOR_Z1 + 0.08);
    batch.boxMM(mats.darkSteel, wx0 - 0.03, FLOOR + DOOR_H, DOOR_Z0 - 0.08, wx1, FLOOR + DOOR_H + 0.1, DOOR_Z1 + 0.08);
    // two dim caged pilot bulbs: one at the climb, one by the door (barely there, but they guide)
    for (const x of [UTILITY_CLIMB.x + 0.9, UTILITY_DOOR.inside[0] + 0.6]) {
      batch.cyl(mats.nightLamp, [x, FLOOR + 2.62, WALL_N + 0.06], [x, FLOOR + 2.7, WALL_N + 0.06], 0.03, 8);
      batch.boxMM(mats.darkSteel, x - 0.05, FLOOR + 2.7, WALL_N, x + 0.05, FLOOR + 2.76, WALL_N + 0.1);
    }
  }

  private buildPipes() {
    const r = rng(77);
    const mats: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    const add = (a: THREE.Vector3, b: THREE.Vector3, rad: number) => {
      dir.subVectors(b, a);
      const len = dir.length();
      q.setFromUnitVectors(up, dir.normalize());
      mats.push(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(rad * 2, len, rad * 2)));
    };
    const x0 = UTILITY_B.x0 + 0.05, x1 = UTILITY_B.x1 - 0.05;
    const A = new THREE.Vector3(), Bv = new THREE.Vector3();
    // horizontal runs: [height above floor, radius] per wall; small ones low, big mains above head height
    const runs: Record<'n' | 's', [number, number][]> = {
      n: [[0.62, 0.045], [0.9, 0.028], [2.05, 0.09], [2.42, 0.055], [3.3, 0.05], [4.45, 0.08], [5.05, 0.04], [6.05, 0.06], [6.85, 0.1]],
      s: [[0.7, 0.04], [1.12, 0.026], [2.15, 0.07], [2.6, 0.1], [3.6, 0.045], [4.7, 0.06], [5.6, 0.085], [6.5, 0.05], [7.05, 0.045]],
    };
    for (const side of ['n', 's'] as const) {
      const face = side === 'n' ? WALL_N : WALL_S, sgn = side === 'n' ? 1 : -1;
      // the south runs stop either side of the climb column (they turn into the wall there)
      const spans: [number, number][] = side === 'n' ? [[x0, x1]] : [[x0, UTILITY_CLIMB.x - 0.42], [UTILITY_CLIMB.x + 0.42, x1]];
      for (const [h, rad] of runs[side]) {
        const z = face + sgn * (0.02 + rad);
        const y = FLOOR + h;
        for (const [s0, s1] of spans) {
          let xa = s0;
          while (xa < s1) {
            const xb = Math.min(s1, xa + 5.5 + r() * 2.5);
            add(A.set(xa, y, z), Bv.set(xb, y, z), rad);
            if (xb < s1) add(A.set(xb - 0.03, y, z), Bv.set(xb + 0.03, y, z), rad + 0.02); // coupling
            xa = xb;
          }
          if (s1 < x1) add(A.set(s1, y, face), Bv.set(s1, y, z), rad); // elbows back into the wall
          if (s0 > x0) add(A.set(s0, y, face), Bv.set(s0, y, z), rad);
        }
      }
      // vertical risers at every second partition (stacks shared by neighbouring cells)
      const b = BLOCKS[1];
      for (let j = 0; j <= b.cellsPerFace; j += 2) {
        const x = cellX(b, j) + (side === 'n' ? 0.05 : -0.05);
        const rad = 0.05;
        const z = face + sgn * (0.02 + rad);
        add(A.set(x, FLOOR, z), Bv.set(x, BLOCK_TOP + 0.35, z), rad);
        // branch into the cell wall at toilet height
        add(A.set(x, FLOOR + 0.42, z), Bv.set(x + 0.25, FLOOR + 0.42, z), 0.035);
      }
    }
    const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1, false);
    projectUVs(geo, 1);
    const mesh = new THREE.InstancedMesh(geo, this.kit.mats.pipe.mat, mats.length);
    mats.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    mesh.name = 'cellhouse:utilityPipes';
    this.kit.root.add(mesh);
  }

  /** The pipes the crew climbs: two pale uprights with bracket rungs every 35 cm. */
  private buildClimbColumn() {
    const { batch, mats } = this.kit;
    const x = UTILITY_CLIMB.x;
    const z = WALL_S - 0.065;
    const xa = x - 0.25, xb = x + 0.25;
    for (const px of [xa, xb]) {
      batch.cyl(mats.climbPipe, [px, FLOOR, z], [px, BLOCK_TOP + 0.25, z], 0.045, 10);
    }
    for (let y = FLOOR + 0.35; y < BLOCK_TOP; y += 0.35) {
      batch.cyl(mats.climbPipe, [xa, y, z + 0.005], [xb, y, z + 0.005], 0.017, 6);
      for (const px of [xa, xb]) batch.boxMM(mats.darkSteel, px - 0.015, y - 0.02, WALL_S, px + 0.015, y + 0.02, z);
    }
  }

  private buildDoor() {
    const kit = this.kit;
    const parts: THREE.BufferGeometry[] = [];
    const w = DOOR_Z1 - DOOR_Z0;
    const leaf = new THREE.BoxGeometry(0.05, DOOR_H - 0.02, w - 0.02);
    leaf.translate(-0.03, DOOR_H / 2, w / 2);
    parts.push(leaf);
    // lock box, hinges, a riveted reinforcing band and a louvre on the leaf (outer face)
    const lock = new THREE.BoxGeometry(0.06, 0.22, 0.12); lock.translate(-0.08, 1.05, w - 0.14); parts.push(lock);
    for (const y of [0.3, 1.75]) { const h = new THREE.BoxGeometry(0.06, 0.14, 0.05); h.translate(-0.05, y, 0.02); parts.push(h); }
    for (const y of [0.55, 1.5]) { const band = new THREE.BoxGeometry(0.02, 0.06, w - 0.06); band.translate(-0.065, y, w / 2); parts.push(band); }
    for (let i = 0; i < 5; i++) { const l = new THREE.BoxGeometry(0.02, 0.025, w * 0.5); l.translate(-0.065, 0.2 + i * 0.05, w / 2); parts.push(l); }
    for (const p of parts) for (const k of Object.keys(p.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') p.deleteAttribute(k);
    const geo = mergeGeometries(parts, false)!;
    projectUVs(geo, 1);
    const mesh = new THREE.Mesh(geo, kit.mats.doorMat);
    mesh.receiveShadow = true;
    mesh.name = 'cellhouse:utilityDoor';
    this.pivot.position.set(UTILITY_DOOR.x, FLOOR, DOOR_Z0);
    this.pivot.add(mesh);
    kit.root.add(this.pivot);
    // closed-door blocker, tagged DOOR so it can be removed
    this.collider = kit.cols.box(UTILITY_DOOR.x + 0.08, FLOOR + DOOR_H / 2, (DOOR_Z0 + DOOR_Z1) / 2, 0.1, DOOR_H / 2, w / 2, 0, DOOR_GROUPS);
  }

  /** Flag-driven: open = unlocked (door swings, collider off). Reversible (restart). */
  setOpen(open: boolean) {
    if (open === this.open) return;
    this.open = open;
    this.collider?.setEnabled(!open);
  }

  update(dt: number) {
    const target = this.open ? OPEN_ANGLE : 0;
    if (this.angle === target) return;
    const step = dt * 1.6;
    this.angle = Math.abs(target - this.angle) <= step ? target : this.angle + Math.sign(target - this.angle) * step;
    this.pivot.rotation.y = this.angle;
  }
}
