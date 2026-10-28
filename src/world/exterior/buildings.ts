// OSM buildings outside the cellhouse complex, in their 1962 state (everything intact): extruded
// board-formed concrete walls with window rows (a few warm-lit), parapets with coping, flat
// tar-and-gravel roofs with rooftop housings, cuboid wall colliders + roof trimesh. Also the 1962
// parade-ground housing (apartment blocks / officers' quarters, demolished in 1971).
import * as THREE from 'three/webgpu';
import type { Island } from '../island';
import { MeshBatch, type Colliders } from './builder';
import { cleanPoly, clipToCorridors, pointInPoly, polyCentroid, rng, signedArea, type IslandBuilding, type P2 } from './data';
import { materials } from './materials';

/** Built by other systems (cellhouse agent, Meshy landmarks) or modern additions absent in 1962. */
const SKIP = new Set([
  'Main Prison', 'Dining Hall', 'Administration Block', "Warden's House", 'Alcatraz Island Lighthouse', 'Water Tower',
  'Powerhouse Smokestack', 'Guard Tower', 'Restrooms',
]);

interface Style { tint: number; lit: number; cool?: number; windows?: boolean }
const STYLES: Record<string, Style> = {
  'Model Industries Building': { tint: 0xd5ccb6, lit: 0.04, cool: 1 },
  'New Industries Building': { tint: 0xcec5ad, lit: 0.03, cool: 1 },
  'Building 64': { tint: 0xd8cdb4, lit: 0.3 },
  'Powerhouse': { tint: 0xe2ddd2, lit: 0.42, cool: 1 },
  'Quartermaster': { tint: 0xc8bda5, lit: 0.05 },
  "Post Exchange & Officers' Club": { tint: 0xe4d7bb, lit: 0.38 },
  'Sally Port': { tint: 0xa47a62, lit: 0.32 },
  'Electric Shop': { tint: 0xcdc4ac, lit: 0.05, cool: 1 },
  'Morgue': { tint: 0xc4bcaa, lit: 0, windows: false },
  'Former Military Chapel': { tint: 0xe7ddca, lit: 0.3 }, // staff apartments in 1962
  apartments: { tint: 0xdcd3c2, lit: 0.36 },
};
const DEFAULT_STYLE: Style = { tint: 0xd0c7b1, lit: 0.12 };

/** 1962 parade-ground housing [cx, cz, length, depth, yaw, floors] (positions fitted inside the OSM area). */
const PARADE_HOUSING: [number, number, number, number, number, number][] = [
  [137, -62, 46, 12, -0.24, 3], [133, -44, 40, 12, -0.24, 3], [153, -26, 34, 12, -0.24, 3],
  [173, -58, 14, 10, -0.24, 2], [143, -8, 14, 10, -0.24, 2],
];

export interface BuiltBuilding { name: string | null; poly: P2[]; ground: number; roof: number }

export class Buildings {
  readonly built: BuiltBuilding[] = [];
  private readonly walls = new MeshBatch(true, true);
  private readonly roofs = new MeshBatch(false, true);
  private readonly roofCol = new MeshBatch();
  private readonly rand = rng(77);

  constructor(private readonly island: Island, private readonly col: Colliders) {}

  build(root: THREE.Object3D) {
    for (const b of this.island.data.buildings) {
      if (b.name && SKIP.has(b.name)) continue;
      if (b.kind === 'retail') continue; // modern bookstore
      this.extrude(b);
    }
    for (const [cx, cz, w, d, yaw, floors] of PARADE_HOUSING) {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const poly: P2[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, k]): P2 => [cx + a * w / 2 * c + k * d / 2 * s, cz - a * w / 2 * s + k * d / 2 * c]);
      if (this.built.some((o) => poly.some((p) => pointInPoly(p[0], p[1], o.poly)))) continue;
      this.extrude({ osmId: 0, name: 'apartments', kind: 'apartments', height: floors * 3.3 + 0.6, base: 0, centroid: [cx, cz], poly });
    }
    const m = materials();
    this.walls.mesh(root, m.facade, 'buildings-walls');
    this.roofs.mesh(root, m.roof, 'buildings-roofs');
    this.col.fromBatch(this.roofCol);
  }

  private extrude(b: IslandBuilding) {
    let poly = cleanPoly(b.poly);
    poly = clipToCorridors(poly);
    if (poly.length < 3 || Math.abs(signedArea(poly)) < 6) return;
    const isl = this.island;
    const style = (b.name && STYLES[b.name]) || DEFAULT_STYLE;

    // ground under the footprint (vertices, edge midpoints, centroid)
    let gmin = Infinity, gmax = -Infinity;
    const sample = (x: number, z: number) => { const h = isl.heightAt(x, z); gmin = Math.min(gmin, h); gmax = Math.max(gmax, h); };
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], c = poly[(i + 1) % poly.length];
      sample(a[0], a[1]); sample((a[0] + c[0]) / 2, (a[1] + c[1]) / 2);
    }
    const cen = polyCentroid(poly);
    sample(cen[0], cen[1]);
    const ground = Math.max(gmin, 0.6);
    // on slopes the uphill side may be partly buried, but the roof always clears the ground
    const roof = Math.max(ground + b.height, gmax + 1.6);
    const bottom = gmin - 1.2;
    const parapet = 0.7;
    const top = roof + parapet;

    // --- outer walls ------------------------------------------------------------------------------
    const tint = new THREE.Color(style.tint);
    // slight per-building variation of the paint
    tint.offsetHSL(0, (this.rand() - 0.5) * 0.04, (this.rand() - 0.5) * 0.06);
    this.walls.currentColor = [tint.r, tint.g, tint.b];
    const windows = style.windows === false ? 0 : 1;
    this.walls.currentExtra = [style.lit, windows, roof - ground - 0.9, style.cool ?? 0];
    let u = this.rand() * 40;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i], c = poly[(i + 1) % n];
      const dx = c[0] - a[0], dz = c[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const nx = dz / len, nz = -dx / len; // outward for positive signed area
      // walls shorter than a bay get no windows (avoids half windows at corners)
      this.walls.currentExtra[1] = len < 2.4 ? 0 : windows;
      this.walls.wall(a[0], a[1], c[0], c[1], bottom, top, bottom, top, nx, nz, u, 1, ground);
      // UV.v is metres above `ground`; wall() subtracts vBase from y, so the window rows line up
      u += len;
      this.col.beam([a[0] - nx * 0.25, a[1] - nz * 0.25], [c[0] - nx * 0.25, c[1] - nz * 0.25], bottom, top, 0.5);
    }

    // --- parapet (inner face + coping) and roof -----------------------------------------------------
    const inner = insetPoly(poly, 0.3);
    const rc = 0.55 + this.rand() * 0.1;
    this.roofs.currentColor = [rc, rc, rc * 0.97];
    for (let i = 0; i < n; i++) {
      const a = inner[i], c = inner[(i + 1) % n];
      const dx = c[0] - a[0], dz = c[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      this.roofs.wall(a[0], a[1], c[0], c[1], roof, top, roof, top, -dz / len, dx / len, 0, 0.25);
      // coping strip between outer and inner rings
      const o0 = poly[i], o1 = poly[(i + 1) % n];
      this.roofs.quad([o0[0], top, o0[1]], [o1[0], top, o1[1]], [c[0], top, c[1]], [a[0], top, a[1]], [0, 1, 0],
        [[0, 0], [len * 0.25, 0], [len * 0.25, 0.08], [0, 0.08]]);
    }
    this.roofs.cap(poly, roof, true, 0.25);
    this.roofCol.cap(poly, top, true, 1);

    // rooftop housings (vent boxes, stair penthouses) on larger roofs
    const area = Math.abs(signedArea(poly));
    // (none on the Model Industries roof: the roof gun tower stands there)
    const boxes = b.name === 'Model Industries Building' ? 0 : area > 1200 ? 4 : area > 400 ? 2 : area > 150 ? 1 : 0;
    const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
    for (let k = 0, tries = 0; k < boxes && tries < 30; tries++) {
      const x = xs.reduce((m, v) => Math.min(m, v)) + this.rand() * (Math.max(...xs) - Math.min(...xs));
      const z = zs.reduce((m, v) => Math.min(m, v)) + this.rand() * (Math.max(...zs) - Math.min(...zs));
      const hx = 0.8 + this.rand() * 1.6, hz = 0.8 + this.rand() * 1.4, hy = 0.5 + this.rand() * 0.9;
      const corners: P2[] = [[x - hx - 1, z - hz - 1], [x + hx + 1, z - hz - 1], [x + hx + 1, z + hz + 1], [x - hx - 1, z + hz + 1]];
      if (!corners.every((p) => pointInPoly(p[0], p[1], poly))) continue;
      this.roofs.box([x, roof + hy, z], [hx, hy, hz], 0, 0.25);
      k++;
    }

    this.built.push({ name: b.name, poly, ground, roof });
  }
}

/** Miter inset of a positive-area polygon (miter length capped for sharp corners). */
export function insetPoly(poly: P2[], d: number): P2[] {
  const n = poly.length;
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const p = poly[(i - 1 + n) % n], c = poly[i], q = poly[(i + 1) % n];
    const e0x = c[0] - p[0], e0z = c[1] - p[1], e1x = q[0] - c[0], e1z = q[1] - c[1];
    const l0 = Math.hypot(e0x, e0z) || 1, l1 = Math.hypot(e1x, e1z) || 1;
    // inward normals (outward is (dz, -dx))
    const n0x = -e0z / l0, n0z = e0x / l0, n1x = -e1z / l1, n1z = e1x / l1;
    let mx = n0x + n1x, mz = n0z + n1z;
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml; mz /= ml;
    const cos = Math.max(0.35, mx * n0x + mz * n0z);
    out.push([c[0] + (mx * d) / cos, c[1] + (mz * d) / cos]);
  }
  return out;
}
