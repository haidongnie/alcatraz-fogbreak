// The four player cells (PLAYER_CELLS) on the B-Block flats: the removable mint-green vent grille
// in the back wall (visible from the cell and from the utility corridor; lies on the floor once
// `vent:<slot>` is set, leaving the dug-out hole), the papier-mache dummy head on the pillow with a
// blanket lump when `dummy:<slot>` is set, plus cell number plates for the B flats and the hole.
// Each changeable part is one instanced mesh with an instance per state, hidden by a zero matrix,
// so flag changes never add draw calls or shader variants.
import * as THREE from 'three/webgpu';
import { BLOCKS, FLOOR, HOLE_CELLS, PLAYER_CELLS, cellCenterX } from '../layout';
import { projectUVs } from './batch';
import { VENT_H, VENT_W, VENT_Y, grilleTemplate } from './blocks';
import { ModelPool } from './furniture';
import { modelSize, type Kit } from './kit';

const B = BLOCKS[1];
/** Plate atlas: B-Block flats on Michigan Avenue (B-156 .. B-129, west to east) + the hole cells. */
export const PLATE_LABELS: string[] = [
  ...Array.from({ length: B.cellsPerFace }, (_, i) => `B-${156 - i}`),
  ...HOLE_CELLS.map((h) => h.label),
];

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

function withColor(g: THREE.BufferGeometry, hex: number) {
  const c = new THREE.Color(hex);
  const arr = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < arr.length; i += 3) { arr[i] = c.r; arr[i + 1] = c.g; arr[i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/** Blanket draped over a body-shaped lump of towels (local: x across, z from foot 0 to head L). */
function lumpGeometry(W: number, L: number) {
  const nu = 10, nv = 18;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= nv; j++) {
    const t = j / nv;
    // feet .. legs .. hips .. chest .. shoulders
    const body = 0.07 + 0.05 * Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5) + 0.05 * Math.exp(-((t - 0.55) ** 2) / 0.02) + 0.06 * Math.exp(-((t - 0.85) ** 2) / 0.012);
    for (let i = 0; i <= nu; i++) {
      const s = i / nu * 2 - 1; // -1..1 across
      const across = Math.max(0, Math.cos((s * Math.PI) / 2)) ** 0.7;
      const hang = Math.abs(s) > 0.82 ? -(Math.abs(s) - 0.82) * 0.55 : 0;
      pos.push((s * W) / 2, body * across + hang + 0.02 * Math.sin(i * 1.7 + j * 0.9), t * L);
      uv.push(i / nu, t * 2);
    }
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return withColor(g, 0x8a8470);
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, count: number, name: string) {
  const m = new THREE.InstancedMesh(geo, mat, count);
  for (let i = 0; i < count; i++) m.setMatrixAt(i, ZERO);
  m.receiveShadow = true;
  m.name = name;
  return m;
}

export class PlayerCellsView {
  private grilles!: THREE.InstancedMesh;   // 0..3 in the wall, 4..7 on the floor
  private flat!: THREE.InstancedMesh;      // made bunk
  private lump!: THREE.InstancedMesh;      // blanket over the dummy body
  private heads!: ModelPool;
  private readonly wallM: THREE.Matrix4[] = [];
  private readonly floorM: THREE.Matrix4[] = [];
  private readonly flatM: THREE.Matrix4[] = [];
  private readonly lumpM: THREE.Matrix4[] = [];
  private readonly headM: THREE.Matrix4[] = [];
  private readonly vent: boolean[] = [];
  private readonly dummy: boolean[] = [];

  constructor(private readonly kit: Kit) {}

  build() {
    const { kit } = this;
    const n = PLAYER_CELLS.length;
    this.grilles = instanced(grilleTemplate(false), kit.mats.grilleMat, n * 2, 'cellhouse:playerGrilles');
    const flatGeo = withColor(new THREE.BoxGeometry(0.68, 0.035, 1.5), 0x7c7766);
    flatGeo.clearGroups();
    projectUVs(flatGeo, 1);
    this.flat = instanced(flatGeo, kit.mats.blanket.mat, n, 'cellhouse:blanketFlat');
    this.lump = instanced(lumpGeometry(0.7, 1.62), kit.mats.blanket.mat, n, 'cellhouse:blanketLump');
    this.heads = new ModelPool(kit.ctx, 'dummy_head', n, { castShadow: false, receiveShadow: true });
    kit.root.add(this.grilles, this.flat, this.lump, this.heads.object);

    const head = modelSize(kit, 'dummy_head', [0.262, 0.26, 0.262]);
    // lying on its back, crown toward the back wall, face turned a little toward the cell
    const qHead = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.45)
      .multiply(new THREE.Quaternion().setFromAxisAngle(_yAxis, Math.PI))
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
    const hb = new THREE.Box3(new THREE.Vector3(-head[0] / 2, 0, -head[2] / 2), new THREE.Vector3(head[0] / 2, head[1], head[2] / 2))
      .applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(qHead));
    const hc = hb.getCenter(new THREE.Vector3());

    for (const c of PLAYER_CELLS) {
      const vx = c.vent[0];
      const zMid = -6.26 + 0.075; // mid-depth of the back wall
      _q.setFromAxisAngle(_yAxis, Math.PI);
      this.wallM.push(new THREE.Matrix4().compose(_v.set(vx, FLOOR + VENT_Y, zMid), _q, new THREE.Vector3(VENT_W + 0.02, VENT_H + 0.02, 1)));
      const qf = new THREE.Quaternion().setFromAxisAngle(_yAxis, 0.35 + c.slot * 0.4)
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
      this.floorM.push(new THREE.Matrix4().compose(new THREE.Vector3(vx + 0.12, FLOOR + 0.016, -6.62), qf, new THREE.Vector3(VENT_W + 0.02, VENT_H + 0.02, 1)));
      // bunk: mattress top ~0.57 m; the made blanket covers the foot end, the lump runs foot -> pillow
      const bx = c.bunk[0], bz = c.bunk[2];
      this.flatM.push(new THREE.Matrix4().makeTranslation(bx, FLOOR + 0.585, bz - 0.2));
      this.lumpM.push(new THREE.Matrix4().makeTranslation(bx, FLOOR + 0.55, bz - 0.92));
      const d = c.dummy;
      this.headM.push(new THREE.Matrix4().compose(new THREE.Vector3(d[0] - hc.x, d[1] - hb.min.y, d[2] - hc.z), qHead, new THREE.Vector3(1, 1, 1)));
      this.vent.push(true);  // force the first apply
      this.dummy.push(true);
    }
    for (let s = 0; s < n; s++) { this.setVent(s, false); this.setDummy(s, false); }
    this.commit();
    this.buildPlates();
    this.buildBelongings();
    this.buildColliders();
  }

  /**
   * Bunk and table colliders, trimmed so the spawn point (cx+0.15, -7.9) and the crawl point by the
   * vent (cx+0.1, -6.75) stay free for a 0.3 m capsule. Toilet and sink stay open (the crawl spot).
   */
  private buildColliders() {
    const { cols } = this.kit;
    for (const c of PLAYER_CELLS) {
      const cx = c.center[0];
      cols.mm(cx - 0.74, FLOOR, -8.6, cx - 0.18, FLOOR + 0.56, -7.15);
      cols.mm(cx + 0.47, FLOOR, c.table[2] - 0.34, cx + 0.74, FLOOR + 0.6, c.table[2] + 0.34);
    }
  }

  /** vent:<slot> = 1 -> grille lies on the floor, hole open. */
  setVent(slot: number, open: boolean) {
    if (slot < 0 || slot >= this.vent.length || this.vent[slot] === open) return false;
    this.vent[slot] = open;
    const n = PLAYER_CELLS.length;
    this.grilles.setMatrixAt(slot, open ? ZERO : this.wallM[slot]);
    this.grilles.setMatrixAt(n + slot, open ? this.floorM[slot] : ZERO);
    return true;
  }

  /** dummy:<slot> = 1 -> head on the pillow, blanket over the body lump. */
  setDummy(slot: number, placed: boolean) {
    if (slot < 0 || slot >= this.dummy.length || this.dummy[slot] === placed) return false;
    this.dummy[slot] = placed;
    this.flat.setMatrixAt(slot, placed ? ZERO : this.flatM[slot]);
    this.lump.setMatrixAt(slot, placed ? this.lumpM[slot] : ZERO);
    if (placed) this.heads.set(slot, this.headM[slot]); else this.heads.hide(slot);
    return true;
  }

  commit() {
    for (const m of [this.grilles, this.flat, this.lump]) {
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }
    this.heads.commit();
  }

  /** Painted number plates on the lock channel of every B flat on Michigan Ave and the hole cells. */
  private buildPlates() {
    const { batch, mats } = this.kit;
    const place = (slot: number, x: number, z: number, facing: 1 | -1) => {
      const g = new THREE.PlaneGeometry(0.2, 0.1);
      const uv = g.attributes.uv as THREE.BufferAttribute;
      const col = slot % 8, row = Math.floor(slot / 8);
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (col + uv.getX(i)) / 8, 1 - (row + 1 - uv.getY(i)) / 4);
      if (facing < 0) g.rotateY(Math.PI);
      g.translate(x, FLOOR + 2.29, z);
      batch.addGeometry(mats.plates, g, null, { keepUV: true });
    };
    for (let i = 0; i < B.cellsPerFace; i++) place(i, cellCenterX(B, i), B.zNorth - 0.134, -1);
    HOLE_CELLS.forEach((h, k) => place(B.cellsPerFace + k, h.inside[0], BLOCKS[3].zSouth + 0.134, 1));
  }

  /** Shelves and a few belongings, so the escapees' cells look lived in. */
  private buildBelongings() {
    const { batch, mats } = this.kit;
    const col = (h: number) => ({ color: new THREE.Color(h) });
    for (const c of PLAYER_CELLS) {
      const cx = c.center[0];
      for (const y of [1.42, 1.72]) batch.boxMM(mats.wood, cx - 0.19, FLOOR + y, -6.46, cx + 0.43, FLOOR + y + 0.025, -6.26);
      // books, a tin cup, a folded towel; slot 1 (the painter) keeps his paint box
      batch.boxMM(mats.furnLow, cx - 0.15, FLOOR + 1.445, -6.42, cx - 0.03, FLOOR + 1.66, -6.29, col(0x5b1f1c));
      batch.boxMM(mats.furnLow, cx - 0.02, FLOOR + 1.445, -6.42, cx + 0.06, FLOOR + 1.62, -6.29, col(0x22324f));
      batch.cyl(mats.steel, [cx + 0.25, FLOOR + 1.745, -6.36], [cx + 0.25, FLOOR + 1.84, -6.36], 0.035, 8);
      batch.boxMM(mats.blanket, cx + 0.44, FLOOR + 0.585, -8.5, cx + 0.72, FLOOR + 0.62, -8.24, col(0xd8d2c0));
      if (c.slot === 1) batch.boxMM(mats.furnLow, cx + 0.45, FLOOR + 0.585, -8.16, cx + 0.7, FLOOR + 0.66, -7.92, col(0x6a4a2a));
    }
  }
}
