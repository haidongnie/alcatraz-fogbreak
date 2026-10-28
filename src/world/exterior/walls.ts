// Concrete walls from OSM (free-standing `barrier:wall` 2.6 m, `barrier:retaining_wall` with a
// parapet) built as terrain-stepped pieces with coping and cuboid colliders, and the Recreation
// Yard: 6 m walls with an armed catwalk and two guard shelters, stepped bleachers against the
// dining hall, painted concrete floor. Pieces that would block a guard route or the escape walk are
// left out (gaps), and nothing free-standing is built inside the fenced service yard.
import * as THREE from 'three/webgpu';
import type { Island } from '../island';
import { YARD_FLOOR } from '../island';
import { MeshBatch, type Colliders } from './builder';
import { distToPolyEdge, inServiceYard, pointInPoly, resample, segmentBlocksCorridor, type P2 } from './data';
import { materials } from './materials';

const PIECE = 4.0;
const YARD_WALL_H = 6.0;

export class Walls {
  private readonly concrete = new MeshBatch(false, true);
  private readonly metal = new MeshBatch();
  private readonly roofs = new MeshBatch(false, true);
  private readonly floor = new MeshBatch();

  constructor(private readonly island: Island, private readonly col: Colliders) {}

  build(root: THREE.Object3D) {
    const yard = this.island.data.areas.find((a) => a.name === 'Recreation Yard')?.poly ?? null;
    for (const l of this.island.data.lines) {
      if (l.type !== 'barrier:wall' && l.type !== 'barrier:retaining_wall') continue;
      const retaining = l.type === 'barrier:retaining_wall';
      for (let i = 0; i < l.pts.length - 1; i++) {
        const a = l.pts[i], b = l.pts[i + 1];
        const isYard = !!yard && !retaining && onEdge(a, yard) && onEdge(b, yard) && onEdge([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], yard);
        this.segment(a, b, isYard ? 'yard' : retaining ? 'retaining' : 'wall', yard);
      }
    }
    if (yard) this.yard(yard);
    const m = materials();
    this.concrete.mesh(root, m.concrete, 'walls');
    this.metal.mesh(root, m.metal, 'walls-railings', true, false);
    this.roofs.mesh(root, m.roof, 'walls-roofs');
    const floor = this.floor.mesh(root, m.yardFloor, 'yard-floor', false, true);
    if (floor) this.col.fromBatch(this.floor);
  }

  private segment(a: P2, b: P2, kind: 'wall' | 'retaining' | 'yard', yard: P2[] | null) {
    const isl = this.island;
    const pts = resample([a, b], PIECE);
    const thick = kind === 'yard' ? 0.8 : kind === 'retaining' ? 0.55 : 0.4;
    const tintV = kind === 'retaining' ? 0.74 : kind === 'yard' ? 0.86 : 0.82;
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
      if (kind !== 'yard' && (inServiceYard(p[0], p[1]) || inServiceYard(q[0], q[1]) || inServiceYard(mx, mz))) continue;
      if (segmentBlocksCorridor(p, q, thick / 2)) continue;
      const dx = q[0] - p[0], dz = q[1] - p[1];
      const len = Math.hypot(dx, dz);
      if (len < 0.1) continue;
      const nx = dz / len, nz = -dx / len;
      // ground on both sides at both ends and the middle
      let hi = -Infinity, lo = Infinity;
      for (const [x, z] of [p, q, [mx, mz] as P2]) {
        for (const s of [-1.3, 1.3]) {
          const h = isl.heightAt(x + nx * s, z + nz * s);
          hi = Math.max(hi, h); lo = Math.min(lo, h);
        }
      }
      if (hi < 0.2) continue; // entirely in the water
      let top: number;
      if (kind === 'yard') top = YARD_FLOOR + YARD_WALL_H;
      else if (kind === 'retaining') top = hi + 0.9;
      else top = hi + 2.6;
      const bottom = Math.min(lo, top - 1) - 0.5;
      const v = tintV + Math.sin(mx * 0.37 + mz * 0.11) * 0.03;
      this.concrete.currentColor = [v, v * 0.98, v * 0.93];
      // wall body (overlap pieces a little so stepped tops have no slits)
      const ext = 0.03;
      const pa: P2 = [p[0] - (dx / len) * ext, p[1] - (dz / len) * ext], qb: P2 = [q[0] + (dx / len) * ext, q[1] + (dz / len) * ext];
      this.concrete.beam(pa, qb, bottom, top, thick, 0.25);
      // coping
      this.concrete.currentColor = [v * 1.08, v * 1.06, v * 1.0];
      this.concrete.beam(pa, qb, top, top + 0.12, thick + 0.14, 0.25);
      this.col.beam(p, q, bottom, top + 0.12, thick);

      if (kind === 'yard' && yard) this.catwalk(p, q, nx, nz, top + 0.12, thick, yard);
    }
  }

  /** Catwalk slab on the outer side of a yard wall piece, with pipe railings. */
  private catwalk(p: P2, q: P2, nx: number, nz: number, y: number, thick: number, yard: P2[]) {
    const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
    // outward = away from the yard
    const into = pointInPoly(mx + nx * 2, mz + nz * 2, yard) ? 1 : -1;
    const ox = -nx * into, oz = -nz * into;
    const w = 1.1;
    const off = thick / 2 + w / 2 - 0.2;
    const a: P2 = [p[0] + ox * off, p[1] + oz * off], b: P2 = [q[0] + ox * off, q[1] + oz * off];
    this.concrete.currentColor = [0.62, 0.61, 0.58];
    this.concrete.beam(a, b, y - 0.18, y, w, 0.25);
    this.col.beam(a, b, y - 0.18, y, w);
    // railings: outer side rail + yard side rail, posts at both ends
    for (const side of [thick / 2 + w - 0.25, -thick / 2 + 0.05]) {
      const ra: [number, number, number] = [p[0] + ox * side, y, p[1] + oz * side];
      const rb: [number, number, number] = [q[0] + ox * side, y, q[1] + oz * side];
      for (const hgt of [0.55, 1.05]) this.metal.cylinder([ra[0], y + hgt, ra[2]], [rb[0], y + hgt, rb[2]], 0.025, 5);
      this.metal.cylinder(ra, [ra[0], y + 1.08, ra[2]], 0.03, 5);
    }
  }

  private yard(poly: P2[]) {
    const m = materials();
    const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
    m.yardOrigin.value.set(Math.min(...xs), Math.min(...zs));
    // painted floor slab
    this.floor.cap(poly, YARD_FLOOR + 0.02, true, 0.25);

    // bleachers: 6 concrete steps against the dining hall's south wall (z = 11.05)
    const z0 = 11.05, x0 = -76.6, x1 = -53.6;
    const steps = 6, rise = 0.42, run = 0.9;
    for (let i = 1; i <= steps; i++) {
      const depth = run * (steps + 1 - i);
      const c: [number, number, number] = [(x0 + x1) / 2, YARD_FLOOR + (rise * i) / 2, z0 + depth / 2];
      const h: [number, number, number] = [(x1 - x0) / 2, (rise * i) / 2 + 0.02, depth / 2];
      const v = 0.8 - i * 0.012;
      this.concrete.currentColor = [v, v * 0.98, v * 0.93];
      this.concrete.box(c, h, 0, 0.25);
      this.col.cuboid(c, h);
    }

    // two guard shelters on the catwalk at the far corners of the yard
    const corners = [...poly].sort((a, b) => a[0] - b[0]).slice(0, 1).concat([...poly].sort((a, b) => b[1] - a[1]).slice(0, 1));
    for (const [cx, cz] of corners) {
      const y = YARD_FLOOR + YARD_WALL_H + 0.12;
      this.concrete.currentColor = [0.84, 0.82, 0.76];
      this.concrete.box([cx, y + 1.15, cz], [1.2, 1.15, 1.2], 0, 0.25);
      this.roofs.currentColor = [0.35, 0.35, 0.34];
      this.roofs.box([cx, y + 2.4, cz], [1.45, 0.1, 1.45], 0, 0.25);
      this.col.cuboid([cx, y + 1.25, cz], [1.2, 1.25, 1.2]);
    }
  }
}

function onEdge(p: P2, poly: P2[]) { return distToPolyEdge(p[0], p[1], poly) < 0.8; }
