// Geometry accumulation (one merged BufferGeometry per material -> one draw call) and static
// Rapier colliders for the exterior. All coordinates are world space; meshes stay at identity.
import * as THREE from 'three/webgpu';
import { RAPIER, type Physics } from '../../core/physics';
import { WORLD_GROUPS } from '../../game/context';
import type { P2 } from './data';

type V3 = [number, number, number];

/** Collects triangles with position/normal/uv (+ optional per-vertex extras) for a single material. */
export class MeshBatch {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly idx: number[] = [];
  /** extra vec4 attribute (e.g. facade parameters) and colour, filled from `current*` for each vertex */
  readonly extra: number[] = [];
  readonly color: number[] = [];
  currentExtra: [number, number, number, number] = [0, 0, 0, 0];
  currentColor: V3 = [1, 1, 1];

  constructor(readonly withExtra = false, readonly withColor = false) {}

  get vertexCount() { return this.pos.length / 3; }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    if (this.withExtra) this.extra.push(...this.currentExtra);
    if (this.withColor) this.color.push(...this.currentColor);
    return this.vertexCount - 1;
  }

  /**
   * Quad a-b-c-d (any winding) facing `n`. uvs are per corner.
   */
  quad(a: V3, b: V3, c: V3, d: V3, n: V3, uvs: [number, number][]) {
    const i0 = this.vertex(a[0], a[1], a[2], n[0], n[1], n[2], uvs[0][0], uvs[0][1]);
    this.vertex(b[0], b[1], b[2], n[0], n[1], n[2], uvs[1][0], uvs[1][1]);
    this.vertex(c[0], c[1], c[2], n[0], n[1], n[2], uvs[2][0], uvs[2][1]);
    this.vertex(d[0], d[1], d[2], n[0], n[1], n[2], uvs[3][0], uvs[3][1]);
    // winding: make (a, b, c) face along n
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) this.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
    else this.idx.push(i0, i0 + 2, i0 + 1, i0, i0 + 3, i0 + 2);
  }

  /** Vertical wall quad from (ax,az) to (bx,bz), bottoms ya0/yb0, tops ya1/yb1, facing (nx, nz). UV in metres * uvScale. */
  wall(ax: number, az: number, bx: number, bz: number, ya0: number, ya1: number, yb0: number, yb1: number,
    nx: number, nz: number, u0: number, uvScale = 1, vBase = 0) {
    const len = Math.hypot(bx - ax, bz - az);
    const u1 = u0 + len;
    const s = uvScale;
    this.quad([ax, ya0, az], [bx, yb0, bz], [bx, yb1, bz], [ax, ya1, az], [nx, 0, nz], [
      [u0 * s, (ya0 - vBase) * s], [u1 * s, (yb0 - vBase) * s], [u1 * s, (yb1 - vBase) * s], [u0 * s, (ya1 - vBase) * s],
    ]);
  }

  /** Box centred at c with half extents h, rotated by yaw about +Y. UVs in metres * uvScale per face. */
  box(c: V3, h: V3, yaw = 0, uvScale = 1, skipBottom = true) {
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    // local axes: x' = (cs, 0, -sn), z' = (sn, 0, cs)  (three.js rotation.y convention)
    const P = (lx: number, ly: number, lz: number): V3 => [c[0] + lx * cs + lz * sn, c[1] + ly, c[2] - lx * sn + lz * cs];
    const N = (lx: number, ly: number, lz: number): V3 => [lx * cs + lz * sn, ly, -lx * sn + lz * cs];
    const [hx, hy, hz] = h;
    const s = uvScale;
    // +X / -X
    for (const sx of [1, -1]) {
      this.quad(P(sx * hx, -hy, -hz), P(sx * hx, -hy, hz), P(sx * hx, hy, hz), P(sx * hx, hy, -hz), N(sx, 0, 0),
        [[0, 0], [2 * hz * s, 0], [2 * hz * s, 2 * hy * s], [0, 2 * hy * s]]);
    }
    for (const sz of [1, -1]) {
      this.quad(P(-hx, -hy, sz * hz), P(hx, -hy, sz * hz), P(hx, hy, sz * hz), P(-hx, hy, sz * hz), N(0, 0, sz),
        [[0, 0], [2 * hx * s, 0], [2 * hx * s, 2 * hy * s], [0, 2 * hy * s]]);
    }
    this.quad(P(-hx, hy, -hz), P(hx, hy, -hz), P(hx, hy, hz), P(-hx, hy, hz), N(0, 1, 0),
      [[0, 0], [2 * hx * s, 0], [2 * hx * s, 2 * hz * s], [0, 2 * hz * s]]);
    if (!skipBottom) {
      this.quad(P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, -hy, hz), P(-hx, -hy, hz), N(0, -1, 0),
        [[0, 0], [2 * hx * s, 0], [2 * hx * s, 2 * hz * s], [0, 2 * hz * s]]);
    }
  }

  /** Box spanning segment a->b (2D) with given thickness, bottom/top heights. */
  beam(a: P2, b: P2, y0: number, y1: number, thickness: number, uvScale = 1) {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return;
    const yaw = Math.atan2(-dz, dx); // local +X along the segment
    this.box([(a[0] + b[0]) / 2, (y0 + y1) / 2, (a[1] + b[1]) / 2], [len / 2, (y1 - y0) / 2, thickness / 2], yaw, uvScale);
  }

  /** Thin cylinder between two points (pipes, posts, rails). */
  cylinder(a: V3, b: V3, r: number, seg = 6) {
    const ax = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = ax.length();
    if (len < 1e-4) return;
    ax.divideScalar(len);
    const tmp = Math.abs(ax.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(ax, tmp).normalize();
    const v = new THREE.Vector3().crossVectors(ax, u);
    const base = this.vertexCount;
    for (let i = 0; i <= seg; i++) {
      const t = (i / seg) * Math.PI * 2;
      const nx = u.x * Math.cos(t) + v.x * Math.sin(t), ny = u.y * Math.cos(t) + v.y * Math.sin(t), nz = u.z * Math.cos(t) + v.z * Math.sin(t);
      this.vertex(a[0] + nx * r, a[1] + ny * r, a[2] + nz * r, nx, ny, nz, i / seg, 0);
      this.vertex(b[0] + nx * r, b[1] + ny * r, b[2] + nz * r, nx, ny, nz, i / seg, len);
    }
    for (let i = 0; i < seg; i++) {
      const k = base + i * 2;
      this.idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }

  /** Flat polygon cap at height y (up = facing +Y). UV = world xz * uvScale. */
  cap(poly: P2[], y: number, up = true, uvScale = 0.25) {
    const contour = poly.map((p) => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const base = this.vertexCount;
    const ny = up ? 1 : -1;
    for (const p of poly) this.vertex(p[0], y, p[1], 0, ny, 0, p[0] * uvScale, p[1] * uvScale);
    for (const t of tris) {
      // ShapeUtils returns CCW in (x, y) = (x, z); facing +Y needs the opposite order in three.js
      if (up) this.idx.push(base + t[0], base + t[2], base + t[1]);
      else this.idx.push(base + t[0], base + t[1], base + t[2]);
    }
    // fix winding generically: check the first triangle against the requested normal
    if (tris.length) {
      const k = this.idx.length - tris.length * 3;
      const i0 = this.idx[k], i1 = this.idx[k + 1], i2 = this.idx[k + 2];
      const p = this.pos;
      const ux = p[i1 * 3] - p[i0 * 3], uz = p[i1 * 3 + 2] - p[i0 * 3 + 2];
      const vx = p[i2 * 3] - p[i0 * 3], vz = p[i2 * 3 + 2] - p[i0 * 3 + 2];
      const cy = uz * vx - ux * vz;
      if ((cy > 0) !== up) {
        for (let j = k; j < this.idx.length; j += 3) { const tmp = this.idx[j + 1]; this.idx[j + 1] = this.idx[j + 2]; this.idx[j + 2] = tmp; }
      }
    }
  }

  build(): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.withExtra) g.setAttribute('fx', new THREE.Float32BufferAttribute(this.extra, 4));
    if (this.withColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.color, 3));
    g.setIndex(this.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  /** Builds a static mesh and adds it to `parent` (no-op when empty). */
  mesh(parent: THREE.Object3D, material: THREE.Material, name: string, cast = true, receive = true): THREE.Mesh | null {
    const g = this.build();
    if (!g) return null;
    const m = new THREE.Mesh(g, material);
    m.name = name;
    m.castShadow = cast;
    m.receiveShadow = receive;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    parent.add(m);
    return m;
  }
}

/** Static colliders in the WORLD group. */
export class Colliders {
  constructor(private readonly physics: Physics) {}

  private finish(desc: RAPIER.ColliderDesc) {
    desc.setCollisionGroups(WORLD_GROUPS);
    return this.physics.world.createCollider(desc);
  }

  /** Axis-aligned (yaw about +Y) cuboid centred at c. */
  cuboid(c: V3, h: V3, yaw = 0) {
    const d = RAPIER.ColliderDesc.cuboid(Math.max(0.01, h[0]), Math.max(0.01, h[1]), Math.max(0.01, h[2]))
      .setTranslation(c[0], c[1], c[2]);
    if (yaw) d.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
    return this.finish(d);
  }

  /** Cuboid spanning the 2D segment a->b between heights y0..y1 with the given thickness. */
  beam(a: P2, b: P2, y0: number, y1: number, thickness: number) {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return null;
    return this.cuboid([(a[0] + b[0]) / 2, (y0 + y1) / 2, (a[1] + b[1]) / 2], [len / 2, (y1 - y0) / 2, thickness / 2], Math.atan2(-dz, dx));
  }

  cylinder(c: V3, halfHeight: number, r: number) {
    return this.finish(RAPIER.ColliderDesc.cylinder(halfHeight, r).setTranslation(c[0], c[1], c[2]));
  }

  trimesh(vertices: Float32Array, indices: Uint32Array, flags?: RAPIER.TriMeshFlags) {
    return this.finish(RAPIER.ColliderDesc.trimesh(vertices, indices, flags));
  }

  /** Trimesh from a MeshBatch (positions are world space). */
  fromBatch(b: MeshBatch) {
    if (!b.idx.length) return null;
    return this.trimesh(new Float32Array(b.pos), new Uint32Array(b.idx));
  }
}
