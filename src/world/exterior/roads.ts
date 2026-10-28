// Roads and paths from OSM `highway:*` lines as ribbons draped on the terrain (+5 cm, polygon
// offset): macadam/asphalt for the service roads, concrete for footways, paths and steps. Modern
// additions (the 1989 Agave Trail) are skipped; the Parade Ground is paved through the terrain
// pad mask instead of a ribbon.
import * as THREE from 'three/webgpu';
import type { Island } from '../island';
import { MeshBatch } from './builder';
import { pointInPoly, resample, type IslandLine, type P2 } from './data';
import { materials } from './materials';

interface RoadKind { width: number; asphalt: boolean; tint: number }
function kindOf(l: IslandLine): RoadKind | null {
  if (/Agave/i.test(l.name ?? '')) return null;
  switch (l.type) {
    case 'highway:service': return { width: 5.2, asphalt: true, tint: 1 };
    case 'highway:footway': return l.name === 'West Road' ? { width: 3.8, asphalt: true, tint: 1 } : { width: 1.8, asphalt: false, tint: 0.95 };
    case 'highway:path': return { width: 1.5, asphalt: false, tint: 0.85 };
    case 'highway:steps': return { width: 2.2, asphalt: false, tint: 1.08 };
    case 'highway:track': return { width: 3.0, asphalt: false, tint: 0.7 };
    default: return null; // pedestrian (area), bridleway (modern trail)
  }
}

export class Roads {
  private readonly asphalt = new MeshBatch();
  private readonly paving = new MeshBatch(false, true);
  /** the recreation yard has its own painted slab: no ribbons on it */
  private readonly yard: P2[] | null;

  constructor(private readonly island: Island) {
    this.yard = island.data.areas.find((a) => a.name === 'Recreation Yard')?.poly ?? null;
  }

  build(root: THREE.Object3D) {
    for (const l of this.island.data.lines) {
      const k = kindOf(l);
      if (k) this.ribbon(l.pts, k);
    }
    const m = materials();
    this.asphalt.mesh(root, m.asphalt, 'roads', false, true);
    this.paving.mesh(root, m.paving, 'paths', false, true);
  }

  private ribbon(line: P2[], k: RoadKind) {
    const isl = this.island;
    const pts = resample(line, 2.0);
    if (pts.length < 2) return;
    const b = k.asphalt ? this.asphalt : this.paving;
    if (!k.asphalt) this.paving.currentColor = [k.tint, k.tint, k.tint];
    const half = k.width / 2;
    const lift = 0.05;
    let dist = 0;
    let prev: number[] | null = null; // indices of the previous cross-section (left, mid, right)
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
      const tx = q[0] - o[0], tz = q[1] - o[1];
      const tl = Math.hypot(tx, tz) || 1;
      const nx = -tz / tl, nz = tx / tl;
      if (i > 0) dist += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
      const ground = isl.heightAt(p[0], p[1]);
      if (ground < 0.3) { prev = null; continue; } // over the water
      if (this.yard && pointInPoly(p[0], p[1], this.yard)) { prev = null; continue; }
      const cur: number[] = [];
      for (const s of [-1, 0, 1]) {
        const x = p[0] + nx * half * s, z = p[1] + nz * half * s;
        const y = Math.max(isl.heightAt(x, z), s === 0 ? ground : -Infinity) + lift;
        const u = k.asphalt ? (s + 1) / 2 : ((s + 1) / 2) * (k.width / 4);
        const v = k.asphalt ? dist / k.width : dist / 4;
        cur.push(b.vertex(x, y, z, 0, 1, 0, u, v));
      }
      if (prev) {
        // two quads per section; winding facing +Y
        for (let j = 0; j < 2; j++) {
          const a0 = prev[j], a1 = prev[j + 1], b0 = cur[j], b1 = cur[j + 1];
          pushUp(b, a0, a1, b1, b0);
        }
      }
      prev = cur;
    }
  }
}

/** Adds quad (a, b, c, d) as two triangles facing +Y regardless of input order; fixes the normals. */
function pushUp(m: MeshBatch, a: number, b: number, c: number, d: number) {
  const P = m.pos;
  const ux = P[b * 3] - P[a * 3], uz = P[b * 3 + 2] - P[a * 3 + 2];
  const vx = P[c * 3] - P[a * 3], vz = P[c * 3 + 2] - P[a * 3 + 2];
  const up = uz * vx - ux * vz > 0;
  if (up) m.idx.push(a, b, c, a, c, d);
  else m.idx.push(a, c, b, a, d, c);
  // face normal from the triangle (draped ribbons follow the slope)
  const uy = P[b * 3 + 1] - P[a * 3 + 1], vy = P[c * 3 + 1] - P[a * 3 + 1];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
  const l = Math.hypot(nx, ny, nz) || 1;
  for (const i of [a, b, c, d]) {
    // average with what is there (vertices are shared between neighbouring quads)
    m.nrm[i * 3] = (m.nrm[i * 3] + nx / l) * 0.5;
    m.nrm[i * 3 + 1] = (m.nrm[i * 3 + 1] + ny / l) * 0.5;
    m.nrm[i * 3 + 2] = (m.nrm[i * 3 + 2] + nz / l) * 0.5;
  }
}
