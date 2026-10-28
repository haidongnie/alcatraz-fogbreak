// 12-ft (3.7 m) chain-link fences with barbed wire on outward-angled arms: the double fence on the
// north side of the service yard (FENCE, climbed by the traverse), the yard's side fences, and the
// OSM perimeter / industrial fences. Alpha-tested mesh + galvanised posts/rails/wire, one cuboid
// collider per span (tall enough that nobody jumps it).
import * as THREE from 'three/webgpu';
import type { Island } from '../island';
import { FENCE, SERVICE_YARD } from '../layout';
import { MeshBatch, type Colliders } from './builder';
import { resample, segmentBlocksCorridor, type P2 } from './data';
import { materials } from './materials';

const H = FENCE.height;
const POST_SPACING = 3.0;
const MESH_TILE = 0.5;

export class Fences {
  private readonly mesh = new MeshBatch();
  private readonly metal = new MeshBatch();

  constructor(private readonly island: Island, private readonly col: Colliders) {}

  build(root: THREE.Object3D) {
    const [x0, , x1, z1] = SERVICE_YARD.box;
    const zIn = FENCE.z + 0.25, zOut = FENCE.z - 0.85;
    // Service yard: inner fence (north), west + east sides down to the kitchen wall, and the outer
    // fence of the double fence a metre further north. Never cut by the corridor logic.
    this.fence([[x0, zIn], [x1, zIn]], -1, false);
    this.fence([[x0, zIn], [x0, z1], [x0, -5.68], [-84.55, -5.68]], 1, false);
    this.fence([[x1, zIn], [x1, z1 + 0.1]], 1, false, true);
    this.fence([[x0, zIn], [x0 - 1.2, zIn], [x0 - 1.2, zOut], [x1 + 1.2, zOut], [x1 + 1.2, zIn], [x1, zIn]], -1, false);
    // OSM fences (perimeter along the industrial shore, rec-yard side fences)
    for (const l of this.island.data.lines) {
      if (l.type === 'barrier:fence') this.fence(l.pts, this.downhillSide(l.pts), true);
    }
    const m = materials();
    this.mesh.mesh(root, m.chainLink, 'fences-mesh', true, false);
    this.metal.mesh(root, m.metal, 'fences-metal', true, false);
  }

  /**
   * One fence along a polyline. `armSide` picks which side the barbed-wire arms lean to (+1 = left
   * of the walking direction). `cut` = leave spans out where they would block a corridor.
   */
  private fence(line: P2[], armSide: number, cut: boolean, flipArms = false) {
    const pts = resample(line, POST_SPACING);
    const isl = this.island;
    let u = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const g = isl.heightAt(p[0], p[1]);
      // arm direction from the local segment
      const q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
      const tx = q[0] - o[0], tz = q[1] - o[1];
      const tl = Math.hypot(tx, tz) || 1;
      const side = flipArms ? -armSide : armSide;
      const ax = (-tz / tl) * side, az = (tx / tl) * side;
      const nextBlocked = cut && i < pts.length - 1 && segmentBlocksCorridor(p, pts[i + 1], 0.1);
      const prevBlocked = cut && i > 0 && segmentBlocksCorridor(pts[i - 1], p, 0.1);
      if (!(nextBlocked && (prevBlocked || i === 0))) this.post(p, g, ax, az);
      if (i === pts.length - 1) break;
      const n = pts[i + 1];
      const len = Math.hypot(n[0] - p[0], n[1] - p[1]);
      if (nextBlocked || len < 0.05) { u += len; continue; }
      const gn = isl.heightAt(n[0], n[1]);
      this.span(p, n, g, gn, u, ax, az);
      this.col.beam(p, n, Math.min(g, gn) - 0.6, Math.max(g, gn) + H + 0.7, 0.15);
      u += len;
    }
  }

  /** +1 / -1: the side of the polyline (left of travel = +1) where the ground is lower (the sea). */
  private downhillSide(line: P2[]) {
    let left = 0;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, lx = -dz / l, lz = dx / l;
      left += (this.island.heightAt(mx + lx * 4, mz + lz * 4) - this.island.heightAt(mx - lx * 4, mz - lz * 4)) * l;
    }
    return left < 0 ? 1 : -1;
  }

  private post(p: P2, g: number, ax: number, az: number) {
    const top = g + H;
    this.metal.cylinder([p[0], g - 0.3, p[1]], [p[0], top + 0.05, p[1]], 0.038, 6);
    // 45-degree barbed-wire arm
    this.metal.cylinder([p[0], top, p[1]], [p[0] + ax * 0.42, top + 0.42, p[1] + az * 0.42], 0.02, 4);
  }

  private span(a: P2, b: P2, ga: number, gb: number, u: number, ax: number, az: number) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nx = (b[1] - a[1]) / len, nz = -(b[0] - a[0]) / len;
    const y0a = ga + 0.04, y0b = gb + 0.04, y1a = ga + H - 0.05, y1b = gb + H - 0.05;
    const s = 1 / MESH_TILE;
    this.mesh.quad([a[0], y0a, a[1]], [b[0], y0b, b[1]], [b[0], y1b, b[1]], [a[0], y1a, a[1]], [nx, 0, nz], [
      [u * s, 0], [(u + len) * s, 0], [(u + len) * s, (H - 0.09) * s], [u * s, (H - 0.09) * s],
    ]);
    // top rail and three strands of barbed wire on the arms
    this.metal.cylinder([a[0], ga + H - 0.04, a[1]], [b[0], gb + H - 0.04, b[1]], 0.022, 5);
    for (const t of [0.14, 0.27, 0.4]) {
      this.metal.cylinder([a[0] + ax * t, ga + H + t, a[1] + az * t], [b[0] + ax * t, gb + H + t, b[1] + az * t], 0.007, 3);
    }
  }
}
