// The escapees' hidden workshop on top of B-Block (WORKSHOP): a wire-mesh cage hung with army
// blankets around the dead fan housing (motor removed in 1957), a work lamp, piles of rubberized
// raincoats, a half-built pontoon, two plank bridges across the utility-corridor gap, and the
// ventilator duct rising from above ROOF_VENT.below to the roof ventilator. When the `roof_vent`
// flag is set the drilled bars are bent out of the duct and the ventilator cap lies on the roof.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { RAPIER } from '../../core/physics';
import { BLOCK_TOP, CEILING, ROOF, ROOF_VENT, UTILITY_CLIMB, WORKSHOP } from '../layout';
import { projectUVs, rng } from './batch';
import { railing } from './blocks';
import { DOOR_GROUPS } from './colliders';
import { modelSize, type Kit } from './kit';

const BT = BLOCK_TOP;
const BRIDGES = [-18.0, -11.0];    // plank bridges across the utility gap (x)
const [SX, SZ] = ROOF_VENT.shaft;
const DUCT = 0.6;                  // square duct / roof opening
const DUCT_BOTTOM = BT + 1.92;     // intake just above head height

function panelGeometry(w: number, h: number, seed: number) {
  const g = new THREE.PlaneGeometry(w, h, 12, 8);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const k = 3 + Math.floor(seed * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const down = 0.5 - y / h; // 0 at the top edge, 1 at the hem
    pos.setZ(i, Math.sin((x / w) * Math.PI * k + seed * 9) * 0.04 * (0.3 + down) + Math.sin(x * 9 + seed) * 0.006);
    if (Math.abs(y - h / 2) < 1e-4) pos.setY(i, y - Math.abs(Math.sin((x / w) * Math.PI * k)) * 0.03); // pinned, sagging between pins
  }
  g.computeVertexNormals();
  return g;
}

export class Workshop {
  private vent: THREE.Object3D | null = null;
  private ventStand = new THREE.Matrix4();
  private ventFallen = new THREE.Matrix4();
  private standCol: RAPIER.Collider | null = null;
  private fallenCol: RAPIER.Collider | null = null;
  private barsIntact: THREE.Mesh | null = null;
  private barsBent: THREE.Mesh | null = null;
  private lampMat: THREE.MeshStandardMaterial | null = null;
  private open = true;
  private t = 0;

  constructor(private readonly kit: Kit) {}

  build() {
    this.buildCage();
    this.buildFloorItems();
    this.buildDuctAndVentilator();
    this.setRoofVent(false);
  }

  private buildCage() {
    const { batch, mats, cols } = this.kit;
    const r = rng(611);
    const [bx0, bz0, bx1, bz1] = WORKSHOP.box;
    const x0 = bx0 + 0.05, x1 = bx1 - 0.05, z0 = bz0 + 0.05, z1 = bz1 - 0.05;
    const yTop = CEILING - 0.02;
    const sides: [number, number, number, number][] = [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]];
    const tints = [0x8a8676, 0x6f7151, 0x7a5f45, 0x5d6470, 0x7d7a6a];
    for (const [ax, az, cx, cz] of sides) {
      const len = Math.hypot(cx - ax, cz - az);
      const dx = (cx - ax) / len, dz = (cz - az) / len;
      const yaw = Math.atan2(-dz, dx);
      // square-tube posts and a top rail
      const np = Math.max(2, Math.round(len / 1.5));
      for (let i = 0; i <= np; i++) {
        const t = i / np;
        batch.boxMM(mats.darkSteel, ax + (cx - ax) * t - 0.025, BT, az + (cz - az) * t - 0.025, ax + (cx - ax) * t + 0.025, yTop, az + (cz - az) * t + 0.025);
      }
      batch.box(mats.darkSteel, (ax + cx) / 2, yTop - 0.03, (az + cz) / 2, len, 0.05, 0.05, yaw);
      batch.box(mats.darkSteel, (ax + cx) / 2, BT + 0.05, (az + cz) / 2, len, 0.05, 0.05, yaw);
      // welded wire mesh
      const mesh = new THREE.PlaneGeometry(len, yTop - BT);
      mesh.rotateY(yaw);
      mesh.translate((ax + cx) / 2, (BT + yTop) / 2, (az + cz) / 2);
      batch.addGeometry(mats.wire, mesh, null);
      cols.fence(ax, az, cx, cz, BT, CEILING);
      // army blankets pinned to the outside of the mesh (a few gaps)
      const outward = { x: dz, z: -dx }; // right-hand normal points out of the loop (clockwise in x/z)
      let s = 0.05;
      while (s < len - 0.4) {
        const w = Math.min(len - s, 1.25 + r() * 0.4);
        if (r() > 0.12) {
          const h = 1.55 + r() * 0.4;
          const g = panelGeometry(w, h, r());
          g.rotateY(yaw);
          const mx = ax + dx * (s + w / 2) + outward.x * 0.06, mz = az + dz * (s + w / 2) + outward.z * 0.06;
          g.translate(mx, yTop - h / 2 - 0.02, mz);
          batch.addGeometry(mats.blanket, g, null, { color: new THREE.Color(tints[Math.floor(r() * tints.length)]) });
        }
        s += w - 0.05;
      }
    }
  }

  private buildFloorItems() {
    const { batch, mats, cols } = this.kit;
    const r = rng(1957);
    // plank bridges across the utility gap
    for (const bx of BRIDGES) {
      for (let i = -1; i <= 1; i++) batch.boxMM(mats.wood, bx + i * 0.27 - 0.13, BT, -6.62 + i * 0.03, bx + i * 0.27 + 0.13, BT + 0.045, -4.5 - i * 0.04);
      cols.mm(bx - 0.41, BT - 0.05, -6.62, bx + 0.41, BT + 0.045, -4.5);
    }
    // pipe guard rails along the open gap (gameplay: no accidental 7 m falls with a bundle);
    // openings at both bridges and, on the south edge, at the top of the climbing pipes
    const [wx0, , wx1] = WORKSHOP.box;
    const openN = BRIDGES.map((x) => [x - 0.5, x + 0.5] as [number, number]);
    const openS = [...openN, [UTILITY_CLIMB.x - 0.5, UTILITY_CLIMB.x + 0.5] as [number, number]].sort((p, q) => p[0] - q[0]);
    for (const [z, open] of [[-6.2, openN], [-4.9, openS]] as [number, [number, number][]][]) {
      let x = wx0 + 0.1;
      for (const [o0, o1] of [...open, [wx1 - 0.1, wx1 - 0.1] as [number, number]]) {
        if (o0 - x > 0.2) railing(this.kit, x, z, o0, z, BT, 1.2, 1.0);
        x = o1;
      }
    }
    // dead fan housing: centrifugal drum (axis along x), outlet, empty motor mount
    const fx = -12.55, fy = BT + 0.5, fz = -2.95;
    batch.cyl(mats.darkSteel, [fx - 0.4, fy, fz], [fx + 0.4, fy, fz], 0.47, 18);
    batch.boxMM(mats.darkSteel, fx - 0.2, fy + 0.25, fz - 0.5, fx + 0.2, BT + 1.8, fz - 0.15);
    batch.boxMM(mats.darkSteel, fx - 0.25, BT + 1.62, fz - 0.55, fx + 0.25, BT + 1.66, fz - 0.1);
    batch.boxMM(mats.darkSteel, fx + 0.4, BT, fz - 0.3, fx + 0.45, BT + 0.75, fz + 0.3);
    for (const [dy, dz] of [[0.12, -0.2], [0.12, 0.2], [0.6, -0.2], [0.6, 0.2]]) batch.cyl(mats.steel, [fx + 0.45, BT + dy, fz + dz], [fx + 0.5, BT + dy, fz + dz], 0.012, 6);
    batch.boxMM(mats.darkSteel, fx - 0.45, BT, fz - 0.45, fx + 0.45, BT + 0.06, fz + 0.45);
    cols.mm(fx - 0.45, BT, fz - 0.53, fx + 0.5, BT + 1.75, fz + 0.47);
    // half-built pontoon (decor) and a glued sheet of raincoats
    const pont = new THREE.CapsuleGeometry(0.3, 1.2, 6, 14);
    pont.rotateZ(Math.PI / 2);
    pont.translate(-9.3, BT + 0.3, -8.2);
    batch.addGeometry(mats.rubber, pont, null, { color: new THREE.Color(0x8d8558) });
    for (const x of [-9.9, -9.3, -8.7]) batch.cyl(mats.rubber, [x - 0.01, BT + 0.3, -8.2], [x + 0.01, BT + 0.3, -8.2], 0.305, 14, false, { color: new THREE.Color(0x4f4a30) });
    cols.mm(-10.2, BT, -8.52, -8.4, BT + 0.6, -7.88);
    const sheet = new THREE.PlaneGeometry(1.6, 2.2, 6, 6);
    sheet.rotateX(-Math.PI / 2);
    const sp = sheet.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < sp.count; i++) sp.setY(i, Math.abs(Math.sin(sp.getX(i) * 7 + sp.getZ(i) * 3)) * 0.015);
    sheet.computeVertexNormals();
    sheet.translate(-19.0, BT + 0.01, -3.5);
    batch.addGeometry(mats.rubber, sheet, null, { color: new THREE.Color(0x837b4f) });
    // piles of rubberized raincoats (soft: no colliders)
    for (const [x, z, s] of [[-19.3, -8.4, 0.45], [-19.4, -6.95, 0.38], [-13.3, -8.5, 0.4], [-9.3, -2.7, 0.45], [-15.8, -2.55, 0.33], [-10.0, -6.85, 0.3]]) {
      const g = new THREE.SphereGeometry(1, 12, 7, 0, Math.PI * 2, 0, Math.PI / 2);
      const p = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const k = 1 + Math.sin(p.getX(i) * 5.1 + x) * 0.12 + Math.cos(p.getZ(i) * 4.3 + z) * 0.1;
        p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.45, p.getZ(i) * k);
      }
      g.computeVertexNormals();
      g.scale(s, s, s * (0.8 + r() * 0.5));
      g.rotateY(r() * Math.PI);
      g.translate(x, BT, z);
      batch.addGeometry(mats.rubber, g, null, { color: new THREE.Color(r() < 0.5 ? 0x7f7a52 : 0x6a6a48) });
    }
    // tools: tool box, paint cans, plywood paddle stock leaning on the cage, a rope coil
    batch.boxMM(mats.darkSteel, -17.2, BT, -2.6, -16.7, BT + 0.22, -2.35);
    for (const [x, z] of [[-16.45, -2.45], [-16.3, -2.6], [-11.2, -8.6]]) batch.cyl(mats.steel, [x, BT, z], [x, BT + 0.18, z], 0.09, 10);
    for (let i = 0; i < 3; i++) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.12 - i * 0.03, 0, 0));
      batch.boxQ(mats.wood, new THREE.Vector3(-12.2 + i * 0.05, BT + 0.65, -8.8 + i * 0.03), new THREE.Vector3(0.9, 1.3, 0.018), q);
    }
    const torus = new THREE.TorusGeometry(0.2, 0.04, 6, 16);
    torus.rotateX(Math.PI / 2);
    torus.translate(-17.0, BT + 0.04, -8.6);
    batch.addGeometry(mats.blanket, torus, null, { color: new THREE.Color(0x8f7f5c) });
    // work lamp hanging from the roof steel (its own material so it can flicker)
    const lx = -16.6, ly = CEILING - 0.42, lz = -7.3;
    batch.cyl(mats.darkSteel, [lx, ly + 0.12, lz], [lx, CEILING + 0.25, lz], 0.006, 4, true);
    const shade = new THREE.ConeGeometry(0.17, 0.14, 14, 1, true);
    shade.translate(lx, ly + 0.06, lz);
    batch.addGeometry(mats.darkSteel, shade, null);
    this.lampMat = (this.kit.mats.warmLamp.mat as THREE.MeshStandardMaterial).clone();
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), this.lampMat);
    bulb.position.set(lx, ly + 0.01, lz);
    bulb.name = 'cellhouse:workLamp';
    this.kit.root.add(bulb);
  }

  private buildDuctAndVentilator() {
    const { kit } = this;
    const { batch, mats, cols } = kit;
    const h = DUCT / 2;
    // sheet-metal duct from the intake (above ROOF_VENT.below) up through the roof deck
    const ducts: [number, number, number, number][] = [[SX - h, SZ - h, SX + h, SZ - h + 0.03], [SX - h, SZ + h - 0.03, SX + h, SZ + h], [SX - h, SZ - h, SX - h + 0.03, SZ + h], [SX + h - 0.03, SZ - h, SX + h, SZ + h]];
    for (const [a, b, c, d] of ducts) batch.boxMM(mats.steel, a, DUCT_BOTTOM, b, c, ROOF + 0.05, d);
    batch.boxMM(mats.darkSteel, SX - h - 0.06, DUCT_BOTTOM - 0.05, SZ - h - 0.06, SX + h + 0.06, DUCT_BOTTOM + 0.04, SZ - h);
    batch.boxMM(mats.darkSteel, SX - h - 0.06, DUCT_BOTTOM - 0.05, SZ + h, SX + h + 0.06, DUCT_BOTTOM + 0.04, SZ + h + 0.06);
    batch.boxMM(mats.darkSteel, SX - h - 0.06, DUCT_BOTTOM - 0.05, SZ - h, SX - h, DUCT_BOTTOM + 0.04, SZ + h);
    batch.boxMM(mats.darkSteel, SX + h, DUCT_BOTTOM - 0.05, SZ - h, SX + h + 0.06, DUCT_BOTTOM + 0.04, SZ + h);
    // stub duct from the fan outlet into the shaft (kept above head height: capsule top is 1.78 m)
    batch.boxMM(mats.steel, SX + h - 0.02, BT + 1.8, SZ + 0.08, -12.35, BT + 1.98, SZ + 0.42);
    // roof curb (hollow) around the opening, dark shaft inside
    const c = 0.15, top = ROOF + 0.3;
    batch.boxMM(mats.wallOuter, SX - h - c, ROOF, SZ - h - c, SX + h + c, top, SZ - h);
    batch.boxMM(mats.wallOuter, SX - h - c, ROOF, SZ + h, SX + h + c, top, SZ + h + c);
    batch.boxMM(mats.wallOuter, SX - h - c, ROOF, SZ - h, SX - h, top, SZ + h);
    batch.boxMM(mats.wallOuter, SX + h, ROOF, SZ - h, SX + h + c, top, SZ + h);
    batch.quadY(mats.dark, SX - h, SZ - h, SX + h, SZ + h, ROOF + 0.02, true);
    batch.quadY(mats.dark, SX - h, SZ - h, SX + h, SZ + h, DUCT_BOTTOM + 0.3, false);
    cols.mm(SX - h - c, ROOF, SZ - h - c, SX + h + c, top, SZ + h + c);

    // bars: intact (straight across the duct intake and the roof opening) / drilled and bent
    const bar = (parts: THREE.BufferGeometry[], a: THREE.Vector3, b: THREE.Vector3, rad = 0.008) => {
      const g = new THREE.CylinderGeometry(rad, rad, a.distanceTo(b), 6, 1, true);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      g.applyQuaternion(q);
      g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      g.deleteAttribute('uv');
      parts.push(g);
    };
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const intact: THREE.BufferGeometry[] = [], bent: THREE.BufferGeometry[] = [];
    for (const y of [DUCT_BOTTOM + 0.02, ROOF + 0.26]) {
      for (const dz of [-0.15, 0, 0.15]) bar(intact, V(SX - h, y, SZ + dz), V(SX + h, y, SZ + dz));
      bar(intact, V(SX, y - 0.015, SZ - h), V(SX, y - 0.015, SZ + h), 0.0065);
    }
    // inside: one bar gone (lying on the block top), two bent down out of the intake
    bar(bent, V(SX - h, DUCT_BOTTOM + 0.02, SZ - 0.15), V(SX - 0.05, DUCT_BOTTOM - 0.18, SZ - 0.12));
    bar(bent, V(SX + h, DUCT_BOTTOM + 0.02, SZ + 0.15), V(SX + 0.08, DUCT_BOTTOM - 0.22, SZ + 0.1));
    bar(bent, V(SX - 0.7, BT + 0.012, SZ + 0.6), V(SX - 0.1, BT + 0.012, SZ + 0.75));
    // on the roof: the 1/2-inch crossbar bent up and over
    bar(bent, V(SX - h, ROOF + 0.26, SZ), V(SX - 0.02, ROOF + 0.55, SZ + 0.05), 0.0065);
    bar(bent, V(SX + h, ROOF + 0.26, SZ - 0.15), V(SX + 0.1, ROOF + 0.5, SZ - 0.2));
    const mk = (parts: THREE.BufferGeometry[], name: string) => {
      const g = mergeGeometries(parts, false)!;
      for (const p of parts) p.dispose();
      projectUVs(g, 0.5);
      const m = new THREE.Mesh(g, mats.darkSteel.mat);
      m.name = name;
      kit.root.add(m);
      return m;
    };
    this.barsIntact = mk(intact, 'cellhouse:ventBars');
    this.barsBent = mk(bent, 'cellhouse:ventBarsBent');

    // the ventilator cap: standing on the curb, or knocked onto the roof
    const size = modelSize(kit, 'roof_ventilator', [1.407, 1.6, 1.42]);
    this.vent = kit.ctx.models.instance('roof_ventilator');
    this.vent.name = 'cellhouse:escapeVentilator';
    this.vent.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    this.vent.matrixAutoUpdate = false;
    kit.root.add(this.vent);
    this.ventStand.makeTranslation(SX, top, SZ);
    const qf = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2 * 0.96));
    const box = new THREE.Box3(new THREE.Vector3(-size[0] / 2, 0, -size[2] / 2), new THREE.Vector3(size[0] / 2, size[1], size[2] / 2))
      .applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(qf));
    const ctr = box.getCenter(new THREE.Vector3());
    const tx = SX - 1.5, tz = SZ - 1.55; // lands north-west of the opening, clear of the hatch exit
    this.ventFallen.compose(new THREE.Vector3(tx - ctr.x, ROOF - box.min.y, tz - ctr.z), qf, new THREE.Vector3(1, 1, 1));
    this.standCol = cols.box(SX, top + size[1] / 2, SZ, size[0] / 2, size[1] / 2, size[2] / 2, 0, DOOR_GROUPS);
    const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.45);
    this.fallenCol = cols.box(tx, ROOF + half.y, tz, half.x, half.y, half.z, 0, DOOR_GROUPS);
  }

  /** roof_vent = 1: bars drilled out and bent, the cap lies on the roof. Reversible (restart). */
  setRoofVent(open: boolean) {
    if (open === this.open) return;
    this.open = open;
    if (this.vent) { this.vent.matrix.copy(open ? this.ventFallen : this.ventStand); this.vent.matrixWorldNeedsUpdate = true; }
    if (this.barsIntact) this.barsIntact.visible = !open;
    if (this.barsBent) this.barsBent.visible = open;
    this.standCol?.setEnabled(!open);
    this.fallenCol?.setEnabled(open);
  }

  update(dt: number) {
    if (!this.lampMat) return;
    this.t += dt;
    // a cheap bulb on a long cord: slow breathing plus the odd dip
    const dip = Math.sin(this.t * 23.0) > 0.985 ? 0.55 : 1;
    this.lampMat.emissiveIntensity = (4.2 + Math.sin(this.t * 1.7) * 0.25) * dip;
  }
}
