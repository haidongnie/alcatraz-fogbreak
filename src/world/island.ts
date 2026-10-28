// The island itself: terrain mesh + collider from public/data/island.json (OSM + USGS elevation),
// the bay (sea plane with shoreline foam) and the distant context around it (hills, city lights).
//
// Grid: Int16 decimetres, base64, row-major; rows along +Z from minZ, cols along +X from minX,
// spacing `res` (2 m). The island area (+60 m) is meshed at 2 m, the rest of the grid at 8 m.
// heightAt() interpolates exactly like the rendered/collided triangles (diagonal (c,r)-(c+1,r+1)).
import * as THREE from 'three/webgpu';
import { asset } from '../config';
import { RAPIER } from '../core/physics';
import { QUERY_WORLD_ONLY, WORLD_GROUPS, type Ctx, type TerrainApi } from '../game/context';
import { bearingDir, pointInPoly, type IslandData, type P2 } from './exterior/data';
import { buildDistant, type Distant } from './exterior/distant';
import { createSea } from './exterior/sea';
import { buildPadMask, createTerrainMaterial, type PadBounds } from './exterior/terrainMaterial';

/** Recreation yard floor level (the DEM plateau west of the dining hall). */
export const YARD_FLOOR = 33.0;
const FINE_MARGIN = 60;
const COARSE_STEP = 4; // grid cells per coarse quad (8 m)

export class Island implements TerrainApi {
  readonly group = new THREE.Group();
  /** sculpted heights (m), same layout as island.json grid */
  readonly heights: Float32Array;
  readonly minX: number;
  readonly minZ: number;
  readonly res: number;
  readonly cols: number;
  readonly rows: number;
  /** game-frame unit vectors (x, z) of true north / east */
  readonly north: P2;
  readonly east: P2;
  /** centre of the island's coastline bounding box (x, z) */
  readonly center: P2;
  /** bounds of the 2 m terrain region (also the pad-mask extent) */
  readonly fine: PadBounds;
  readonly sea: THREE.Mesh;
  private readonly distant: Distant;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private readonly fogColor = new THREE.Color();

  /** Loads public/data/island.json, builds terrain mesh + collider, sea, shoreline and distant context. */
  static async load(ctx: Ctx): Promise<Island> {
    const res = await fetch(asset('data/island.json'));
    if (!res.ok) throw new Error(`island.json: HTTP ${res.status}`);
    const data = (await res.json()) as IslandData;
    return new Island(ctx, data);
  }

  constructor(readonly ctx: Ctx, readonly data: IslandData) {
    const g = data.grid;
    this.minX = g.minX; this.minZ = g.minZ; this.res = g.res; this.cols = g.cols; this.rows = g.rows;
    this.north = [data.northDir[0], data.northDir[1]];
    this.east = [-this.north[1], this.north[0]];
    this.heights = decodeGrid(g.data, g.cols * g.rows, g.scale);
    this.sculpt();

    const xs = data.coastline.map((p) => p[0]), zs = data.coastline.map((p) => p[1]);
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), bz0 = Math.min(...zs), bz1 = Math.max(...zs);
    this.center = [(bx0 + bx1) / 2, (bz0 + bz1) / 2];
    // fine region aligned to the coarse lattice so the two meshes share their border vertices
    const step = this.res * COARSE_STEP;
    const fx0 = this.minX + Math.floor((bx0 - FINE_MARGIN - this.minX) / step) * step;
    const fz0 = this.minZ + Math.floor((bz0 - FINE_MARGIN - this.minZ) / step) * step;
    const fx1 = this.minX + Math.ceil((bx1 + FINE_MARGIN - this.minX) / step) * step;
    const fz1 = this.minZ + Math.ceil((bz1 + FINE_MARGIN - this.minZ) / step) * step;
    this.fine = { x0: fx0, z0: fz0, w: fx1 - fx0, d: fz1 - fz0 };

    this.group.name = 'island';
    this.buildTerrain();
    this.sea = createSea({ minX: this.minX, minZ: this.minZ, res: this.res, cols: this.cols, rows: this.rows, heights: this.heights }, this.center);
    this.group.add(this.sea);
    this.distant = buildDistant(this.north, this.center);
    this.group.add(this.distant.group);
    ctx.scene.add(this.group);
  }

  /** Game-frame direction (x, z) of a compass bearing in degrees. */
  bearingDir(deg: number): P2 { return bearingDir(this.north, deg); }

  // ----------------------------------------------------------------------------------------------
  // Queries
  // ----------------------------------------------------------------------------------------------
  heightAt(x: number, z: number) {
    let fx = (x - this.minX) / this.res, fz = (z - this.minZ) / this.res;
    const maxC = this.cols - 1.0001, maxR = this.rows - 1.0001;
    fx = fx < 0 ? 0 : fx > maxC ? maxC : fx;
    fz = fz < 0 ? 0 : fz > maxR ? maxR : fz;
    const c = Math.floor(fx), r = Math.floor(fz);
    const u = fx - c, v = fz - r;
    const H = this.heights, cols = this.cols;
    const i = r * cols + c;
    const h00 = H[i], h10 = H[i + 1], h01 = H[i + cols], h11 = H[i + cols + 1];
    return u >= v ? h00 + u * (h10 - h00) + v * (h11 - h10) : h00 + v * (h01 - h00) + u * (h11 - h01);
  }

  groundAt(x: number, y: number, z: number) {
    const top = y + 0.5;
    const o = this.ray.origin;
    o.x = x; o.y = top; o.z = z;
    const hit = this.ctx.physics.world.castRay(this.ray, top + 40, true, undefined, QUERY_WORLD_ONLY);
    return hit ? top - hit.timeOfImpact : this.heightAt(x, z);
  }

  /** Terrain normal (central differences) into `out`. */
  normalAt(x: number, z: number, out: THREE.Vector3) {
    const e = this.res;
    out.set(this.heightAt(x - e, z) - this.heightAt(x + e, z), 2 * e, this.heightAt(x, z - e) - this.heightAt(x, z + e));
    return out.normalize();
  }

  update(_dt: number) {
    // distant silhouettes / lights follow the current fog (density and colour set by the atmosphere)
    const fog = this.ctx.scene.fog;
    if (fog && (fog as THREE.FogExp2).isFogExp2) {
      const f = fog as THREE.FogExp2;
      this.fogColor.copy(f.color);
      this.distant.setHaze(THREE.MathUtils.smoothstep(f.density, 0.0012, 0.011) * 0.85 + 0.12, this.fogColor);
    }
  }

  // ----------------------------------------------------------------------------------------------
  // Build
  // ----------------------------------------------------------------------------------------------
  /** Gameplay sculpting on top of the build script's: the recreation yard is one paved level. */
  private sculpt() {
    const yard = this.data.areas.find((a) => a.name === 'Recreation Yard');
    if (!yard) return;
    const xs = yard.poly.map((p) => p[0]), zs = yard.poly.map((p) => p[1]);
    const c0 = Math.max(0, Math.floor((Math.min(...xs) - this.minX) / this.res));
    const c1 = Math.min(this.cols - 1, Math.ceil((Math.max(...xs) - this.minX) / this.res));
    const r0 = Math.max(0, Math.floor((Math.min(...zs) - this.minZ) / this.res));
    const r1 = Math.min(this.rows - 1, Math.ceil((Math.max(...zs) - this.minZ) / this.res));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const x = this.minX + c * this.res, z = this.minZ + r * this.res;
        if (pointInPoly(x, z, yard.poly)) this.heights[r * this.cols + c] = YARD_FLOOR - 0.05;
      }
    }
  }

  private buildTerrain() {
    const pad = buildPadMask(this.data, this.fine);
    const mat = createTerrainMaterial(pad, this.fine);
    const res = this.res, cols = this.cols, H = this.heights;
    const c0 = Math.round((this.fine.x0 - this.minX) / res), c1 = Math.round((this.fine.x0 + this.fine.w - this.minX) / res);
    const r0 = Math.round((this.fine.z0 - this.minZ) / res), r1 = Math.round((this.fine.z0 + this.fine.d - this.minZ) / res);
    const hAt = (c: number, r: number) => H[Math.min(this.rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))];

    // --- fine mesh (2 m) ------------------------------------------------------------------------
    const nc = c1 - c0 + 1, nr = r1 - r0 + 1;
    const pos = new Float32Array(nc * nr * 3), nrm = new Float32Array(nc * nr * 3);
    for (let r = 0; r < nr; r++) {
      for (let c = 0; c < nc; c++) {
        const gc = c0 + c, gr = r0 + r;
        let h = hAt(gc, gr);
        // border vertices sit on the coarse edges: interpolate between coarse samples (no cracks)
        const onX = c === 0 || c === nc - 1, onZ = r === 0 || r === nr - 1;
        if (onX && gr % COARSE_STEP !== 0) {
          const ra = gr - (gr % COARSE_STEP), t = (gr % COARSE_STEP) / COARSE_STEP;
          h = hAt(gc, ra) * (1 - t) + hAt(gc, ra + COARSE_STEP) * t;
        } else if (onZ && gc % COARSE_STEP !== 0) {
          const ca = gc - (gc % COARSE_STEP), t = (gc % COARSE_STEP) / COARSE_STEP;
          h = hAt(ca, gr) * (1 - t) + hAt(ca + COARSE_STEP, gr) * t;
        }
        const i = (r * nc + c) * 3;
        pos[i] = this.minX + gc * res; pos[i + 1] = h; pos[i + 2] = this.minZ + gr * res;
        const nx = hAt(gc - 1, gr) - hAt(gc + 1, gr), nz = hAt(gc, gr - 1) - hAt(gc, gr + 1), ny = 2 * res;
        const inv = 1 / Math.hypot(nx, ny, nz);
        nrm[i] = nx * inv; nrm[i + 1] = ny * inv; nrm[i + 2] = nz * inv;
      }
    }
    const idx = new Uint32Array((nc - 1) * (nr - 1) * 6);
    const colIdx: number[] = [];
    let k = 0;
    for (let r = 0; r < nr - 1; r++) {
      for (let c = 0; c < nc - 1; c++) {
        const a = r * nc + c, b = a + 1, d = a + nc, e = d + 1;
        // diagonal a-e; both triangles face +Y (x right, z toward the viewer)
        idx[k++] = a; idx[k++] = e; idx[k++] = b;
        idx[k++] = a; idx[k++] = d; idx[k++] = e;
        if (Math.max(pos[a * 3 + 1], pos[b * 3 + 1], pos[d * 3 + 1], pos[e * 3 + 1]) > -3) colIdx.push(a, e, b, a, d, e);
      }
    }
    const fineGeo = new THREE.BufferGeometry();
    fineGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    fineGeo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    fineGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    fineGeo.computeBoundingSphere();
    const fineMesh = new THREE.Mesh(fineGeo, mat);
    fineMesh.name = 'terrain';
    fineMesh.receiveShadow = true;
    fineMesh.castShadow = true;
    fineMesh.matrixAutoUpdate = false;
    this.group.add(fineMesh);

    // collider: the island area only (triangles reaching above y = -3), compacted
    const remap = new Int32Array(nc * nr).fill(-1);
    const cv: number[] = [];
    const ci = new Uint32Array(colIdx.length);
    for (let j = 0; j < colIdx.length; j++) {
      const v = colIdx[j];
      if (remap[v] < 0) { remap[v] = cv.length / 3; cv.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); }
      ci[j] = remap[v];
    }
    const desc = RAPIER.ColliderDesc.trimesh(new Float32Array(cv), ci, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES);
    desc.setCollisionGroups(WORLD_GROUPS);
    this.ctx.physics.world.createCollider(desc);

    // --- coarse skirt (8 m) out to the edge of the grid, down to the sea floor ------------------
    const S = COARSE_STEP;
    const ccols = Math.floor((cols - 1) / S) + 1, crows = Math.floor((this.rows - 1) / S) + 1;
    const cpos = new Float32Array(ccols * crows * 3), cnrm = new Float32Array(ccols * crows * 3);
    for (let r = 0; r < crows; r++) {
      for (let c = 0; c < ccols; c++) {
        const gc = c * S, gr = r * S;
        const i = (r * ccols + c) * 3;
        cpos[i] = this.minX + gc * res; cpos[i + 1] = hAt(gc, gr); cpos[i + 2] = this.minZ + gr * res;
        const nx = hAt(gc - S, gr) - hAt(gc + S, gr), nz = hAt(gc, gr - S) - hAt(gc, gr + S), ny = 4 * S * res / 2;
        const inv = 1 / Math.hypot(nx, ny, nz);
        cnrm[i] = nx * inv; cnrm[i + 1] = ny * inv; cnrm[i + 2] = nz * inv;
      }
    }
    const cidx: number[] = [];
    const hc0 = c0 / S, hc1 = c1 / S, hr0 = r0 / S, hr1 = r1 / S;
    for (let r = 0; r < crows - 1; r++) {
      for (let c = 0; c < ccols - 1; c++) {
        if (c >= hc0 && c < hc1 && r >= hr0 && r < hr1) continue; // covered by the fine mesh
        const a = r * ccols + c, b = a + 1, d = a + ccols, e = d + 1;
        cidx.push(a, e, b, a, d, e);
      }
    }
    const coarseGeo = new THREE.BufferGeometry();
    coarseGeo.setAttribute('position', new THREE.BufferAttribute(cpos, 3));
    coarseGeo.setAttribute('normal', new THREE.BufferAttribute(cnrm, 3));
    coarseGeo.setIndex(cidx);
    coarseGeo.computeBoundingSphere();
    const coarse = new THREE.Mesh(coarseGeo, mat);
    coarse.name = 'terrain-skirt';
    coarse.receiveShadow = true;
    coarse.matrixAutoUpdate = false;
    this.group.add(coarse);
  }
}

function decodeGrid(b64: string, n: number, scale: number): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dv = new DataView(bytes.buffer);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) * scale;
  return out;
}
