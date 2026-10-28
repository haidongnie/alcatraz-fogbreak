// Exterior props: street lamps (Meshy posts + emissive globes + halos + soft light pools, all
// registered with the light pool), cypress trees, shore rocks with pelicans, crates and oil drums,
// the timber dock and pier on piles, the concrete seawall walk behind the power house (shore
// patrol), the covered cistern and the warning signs. Everything repeated is instanced or merged.
import * as THREE from 'three/webgpu';
import { attribute, cameraPosition, distance, positionWorld, smoothstep, texture, uv, vec4 } from 'three/tsl';
import type { Ctx } from '../../game/context';
import type { Island } from '../island';
import { BAKERY_PIPE, CELLHOUSE_POLY, CLIMBS, FENCE, LAUNCH, LIGHT_ANCHORS } from '../layout';
import { MeshBatch, type Colliders } from './builder';
import type { BuiltBuilding } from './buildings';
import {
  CORRIDORS, cleanPoly, corridorClearance, distToPolyEdge, inServiceYard, pointInPoly, resample, rng, segDist, type P2,
} from './data';
import { LAMPS, insideCellhouse, placeAnchor, addLamp } from './lamps';
import { materials } from './materials';
import { glowTexture, signTexture } from './textures';

/** street_lamp model: post at local x = +0.42, globe hanging from the arm at local (-0.14, 3.15, 0). */
const LAMP_POST_X = 0.42;
const LAMP_GLOBE: [number, number, number] = [-0.14, 3.15, 0];
/** decorative road lamps: warm incandescent (the yard anchors use their own sodium colour) */
const INCANDESCENT = 0xffbf7a;

interface Globe { p: THREE.Vector3; color: number; size: number; pool: number }

export class Props {
  private readonly rand = rng(4242);
  private readonly globes: Globe[] = [];
  private readonly lampMatrices: THREE.Matrix4[] = [];
  private readonly concrete = new MeshBatch(false, true);
  private readonly wood = new MeshBatch(false, true);
  private readonly darkMetal = new MeshBatch();
  private readonly rocks: { p: THREE.Vector3; s: THREE.Vector3; ry: number }[] = [];
  private readonly complex: P2[][];

  constructor(private readonly ctx: Ctx, private readonly island: Island, private readonly col: Colliders, private readonly built: BuiltBuilding[]) {
    const names = ['Main Prison', 'Dining Hall', 'Administration Block'];
    this.complex = island.data.buildings.filter((b) => b.name && names.includes(b.name)).map((b) => b.poly);
    if (!this.complex.length) this.complex = [CELLHOUSE_POLY];
  }

  build(root: THREE.Object3D) {
    this.anchorLamps();
    this.roadLamps();
    this.lampVisuals(root);
    this.trees(root);
    this.shoreRocks(root);
    this.cargo(root);
    this.piers();
    this.seawall();
    this.cistern();
    this.signs(root);
    const m = materials();
    this.concrete.mesh(root, m.concrete, 'props-concrete');
    this.wood.mesh(root, m.wood, 'props-wood');
    this.darkMetal.mesh(root, m.darkMetal, 'props-metal');
  }

  // ----------------------------------------------------------------------------------------------
  // helpers
  // ----------------------------------------------------------------------------------------------
  private inBuilding(x: number, z: number, margin: number) {
    for (const b of this.built) if (pointInPoly(x, z, b.poly) || distToPolyEdge(x, z, b.poly) < margin) return true;
    for (const p of this.complex) if (pointInPoly(x, z, p) || distToPolyEdge(x, z, p) < margin) return true;
    return false;
  }
  private area(name: string) { return this.island.data.areas.find((a) => a.name === name)?.poly ?? null; }
  private slopeY(x: number, z: number) { return this.island.normalAt(x, z, _n).y; }

  // ----------------------------------------------------------------------------------------------
  // Lamps
  // ----------------------------------------------------------------------------------------------
  /** Outdoor LIGHT_ANCHORS: a lamp post at the anchor, or a wall lamp when the anchor is inside a footprint. */
  private anchorLamps() {
    LIGHT_ANCHORS.forEach((a, i) => {
      if (insideCellhouse(a.p[0], a.p[1], a.p[2])) return;
      const [ax, ay, az] = a.p;
      const host = this.built.find((b) => pointInPoly(ax, az, b.poly));
      if (host) {
        // nearest wall, lamp on a bracket 0.5 m out from it
        const poly = host.poly;
        let best = Infinity, px = ax, pz = az, nx = 0, nz = 0;
        for (let k = 0; k < poly.length; k++) {
          const p = poly[k], q = poly[(k + 1) % poly.length];
          const d = segDist(ax, az, p[0], p[1], q[0], q[1]);
          if (d < best) {
            best = d;
            const dx = q[0] - p[0], dz = q[1] - p[1], l = Math.hypot(dx, dz) || 1;
            const t = Math.max(0.1, Math.min(0.9, ((ax - p[0]) * dx + (az - p[1]) * dz) / (l * l)));
            px = p[0] + dx * t; pz = p[1] + dz * t; nx = dz / l; nz = -dx / l;
          }
        }
        const g = this.island.heightAt(px + nx, pz + nz);
        const gy = Math.min(host.roof - 0.8, Math.max(ay, g + 3.8));
        const gx = px + nx * 0.55, gz = pz + nz * 0.55;
        this.darkMetal.beam([px, pz], [gx, gz], gy + 0.3, gy + 0.38, 0.06);
        this.darkMetal.box([px + nx * 0.02, gy + 0.2, pz + nz * 0.02], [0.08, 0.25, 0.08]);
        this.globes.push({ p: new THREE.Vector3(gx, gy, gz), color: a.color, size: 1, pool: 8 });
        placeAnchor(i, gx, gy, gz);
      } else {
        // keep the post itself off the walking lines; the arm then reaches back over them
        let px = ax, pz = az, ry = this.rand() * Math.PI * 2;
        const near = nearestOnPaths(ax, az);
        if (near && near.d < 2.0) {
          const dx = ax - near.x, dz = az - near.z, l = Math.hypot(dx, dz);
          const ux = l > 0.05 ? dx / l : 1, uz = l > 0.05 ? dz / l : 0;
          px = near.x + ux * 2.2; pz = near.z + uz * 2.2;
          ry = Math.atan2(-uz, ux); // arm (local -X = (-cos, sin)) back toward the path
        }
        const g = this.island.heightAt(px, pz);
        const s = THREE.MathUtils.clamp((ay - g) / LAMP_GLOBE[1], 0.9, 1.45);
        const globe = this.lamp(px, pz, ry, s);
        this.globes.push({ p: globe, color: a.color, size: s, pool: 9 });
        placeAnchor(i, globe.x, globe.y, globe.z);
      }
    });
  }

  /** Decorative lamps along the service roads and round the parade ground, away from the gameplay paths. */
  private roadLamps() {
    const spots: { x: number; z: number; ry: number }[] = [];
    const ok = (x: number, z: number) => {
      const g = this.island.heightAt(x, z);
      if (g < 1.0 || this.slopeY(x, z) < 0.8) return false;
      if (corridorClearance(x, z) < 26 || inServiceYard(x, z, 8)) return false;
      if (this.inBuilding(x, z, 1.6)) return false;
      for (const s of spots) if (Math.hypot(s.x - x, s.z - z) < 16) return false;
      for (const l of LAMPS) if (!l.indoor && Math.hypot(l.p.x - x, l.p.z - z) < 16) return false;
      return true;
    };
    for (const l of this.island.data.lines) {
      if (l.type !== 'highway:service') continue;
      const pts = resample(l.pts, 3);
      let acc = 14;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (acc < 30) continue;
        const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1;
        for (const side of [1, -1]) {
          const nx = (-dz / len) * side, nz = (dx / len) * side;
          const x = b[0] + nx * 3.3, z = b[1] + nz * 3.3;
          if (ok(x, z)) {
            // arm (local -X) toward the road centre
            spots.push({ x, z, ry: Math.atan2(-nz, nx) });
            acc = 0;
            break;
          }
        }
      }
    }
    const pg = this.area('Parade Ground');
    if (pg) {
      const ring = resample([...cleanPoly(pg), cleanPoly(pg)[0]], 3);
      let acc = 0;
      for (let i = 1; i < ring.length; i++) {
        acc += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
        if (acc < 34) continue;
        const [x, z] = ring[i];
        if (ok(x, z)) { spots.push({ x, z, ry: this.rand() * Math.PI * 2 }); acc = 0; }
      }
    }
    for (const s of spots) {
      const globe = this.lamp(s.x, s.z, s.ry, 1);
      this.globes.push({ p: globe, color: INCANDESCENT, size: 1, pool: 8 });
      addLamp(globe.x, globe.y, globe.z, INCANDESCENT, 20, 17);
    }
  }

  /** Places one street_lamp so its post stands at (x, z); returns the globe's world position. */
  private lamp(x: number, z: number, ry: number, s: number) {
    const g = this.island.heightAt(x, z) - 0.05;
    const c = Math.cos(ry), sn = Math.sin(ry);
    // local -> world offset for a local point (lx, lz): (lx c + lz s, -lx s + lz c)
    const ox = x - LAMP_POST_X * s * c, oz = z + LAMP_POST_X * s * sn;
    const m = new THREE.Matrix4().compose(new THREE.Vector3(ox, g, oz), new THREE.Quaternion().setFromAxisAngle(_up, ry), new THREE.Vector3(s, s, s));
    this.lampMatrices.push(m);
    this.col.cylinder([x, g + 2, z], 2, 0.12);
    return new THREE.Vector3(ox + LAMP_GLOBE[0] * s * c, g + LAMP_GLOBE[1] * s, oz - LAMP_GLOBE[0] * s * sn);
  }

  private lampVisuals(root: THREE.Object3D) {
    const m = materials();
    if (this.lampMatrices.length) root.add(named(this.ctx.models.instanced('street_lamp', this.lampMatrices, { castShadow: true, receiveShadow: true }), 'street-lamps'));
    if (!this.globes.length) return;
    // emissive globes (instanced)
    const globeMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.34, 14, 10), m.globe, this.globes.length);
    globeMesh.name = 'lamp-globes';
    const mat = new THREE.Matrix4();
    this.globes.forEach((g, i) => { mat.makeScale(g.size, g.size, g.size).setPosition(g.p); globeMesh.setMatrixAt(i, mat); });
    globeMesh.instanceMatrix.needsUpdate = true;
    globeMesh.computeBoundingSphere();
    globeMesh.castShadow = false;
    root.add(globeMesh);

    // halos (view-space billboards) and light pools draped on the ground
    const hp: number[] = [], hc: number[] = [], hcorner: number[] = [], huv: number[] = [], hi: number[] = [];
    const pp: number[] = [], pc: number[] = [], puv: number[] = [], pi: number[] = [];
    const col = new THREE.Color();
    for (const g of this.globes) {
      col.set(g.color);
      const base = hp.length / 3;
      for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        hp.push(g.p.x, g.p.y, g.p.z);
        hcorner.push(cx, cy, 2.2 * g.size);
        hc.push(col.r * 0.9, col.g * 0.9, col.b * 0.9);
        huv.push((cx + 1) / 2, (cy + 1) / 2);
      }
      hi.push(base, base + 1, base + 2, base, base + 2, base + 3);
      // pool: 6 x 6 grid draped on the terrain under the globe
      const R = g.pool, N = 6, pb = pp.length / 3;
      for (let j = 0; j <= N; j++) {
        for (let k = 0; k <= N; k++) {
          const x = g.p.x + (k / N - 0.5) * 2 * R, z = g.p.z + (j / N - 0.5) * 2 * R;
          pp.push(x, this.island.heightAt(x, z) + 0.07, z);
          pc.push(col.r * 0.11, col.g * 0.11, col.b * 0.11);
          puv.push(k / N, j / N);
        }
      }
      for (let j = 0; j < N; j++) {
        for (let k = 0; k < N; k++) {
          const a = pb + j * (N + 1) + k, b = a + 1, d = a + N + 1, e = d + 1;
          pi.push(a, e, b, a, d, e);
        }
      }
    }
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.Float32BufferAttribute(hp, 3));
    hg.setAttribute('corner', new THREE.Float32BufferAttribute(hcorner, 3));
    hg.setAttribute('color', new THREE.Float32BufferAttribute(hc, 3));
    hg.setAttribute('uv', new THREE.Float32BufferAttribute(huv, 2));
    hg.setIndex(hi);
    const halos = new THREE.Mesh(hg, m.halo);
    halos.name = 'lamp-halos';
    halos.frustumCulled = false;
    halos.renderOrder = 6;
    root.add(halos);

    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3));
    pg.setAttribute('color', new THREE.Float32BufferAttribute(pc, 3));
    pg.setAttribute('uv', new THREE.Float32BufferAttribute(puv, 2));
    pg.setIndex(pi);
    pg.computeBoundingSphere();
    const poolMat = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    // near the camera the pooled PointLights do the real lighting: fade the fake pools out there;
    // far away the fog swallows them (additive blending cannot use the regular fog mix)
    const d = distance(positionWorld, cameraPosition);
    const fade = smoothstep(26, 48, d).mul(d.mul(m.fogDensity).mul(0.6).pow(2).negate().exp());
    poolMat.colorNode = vec4(attribute('color', 'vec3').mul(texture(glowTexture(), uv()).a).mul(fade), 1);
    const pools = new THREE.Mesh(pg, poolMat);
    pools.name = 'lamp-pools';
    pools.renderOrder = 4;
    pools.matrixAutoUpdate = false;
    root.add(pools);
  }

  // ----------------------------------------------------------------------------------------------
  // Vegetation
  // ----------------------------------------------------------------------------------------------
  private trees(root: THREE.Object3D) {
    const pts: { x: number; z: number; s: number; ry: number }[] = [];
    const yard = this.area('Recreation Yard'), pg = this.area('Parade Ground'), garden = this.area('garden');
    const ok = (x: number, z: number, minH: number) => {
      const g = this.island.heightAt(x, z);
      if (g < minH || this.slopeY(x, z) < 0.8) return false;
      if (corridorClearance(x, z) < 4 || inServiceYard(x, z, 4)) return false;
      if (this.inBuilding(x, z, 3.5)) return false;
      if ((yard && pointInPoly(x, z, yard)) || (pg && pointInPoly(x, z, pg) && distToPolyEdge(x, z, pg) > 3)) return false;
      for (const l of this.island.data.lines) {
        if (!l.type.startsWith('highway') && !l.type.startsWith('barrier')) continue;
        for (let i = 0; i < l.pts.length - 1; i++) {
          if (segDist(x, z, l.pts[i][0], l.pts[i][1], l.pts[i + 1][0], l.pts[i + 1][1]) < 3.2) return false;
        }
      }
      for (const p of pts) if (Math.hypot(p.x - x, p.z - z) < 5.5) return false;
      return true;
    };
    // the Warden's House garden: a row round its edge and a few inside
    if (garden) {
      const ring = resample([...cleanPoly(garden), cleanPoly(garden)[0]], 7);
      for (const [x, z] of ring) if (ok(x, z, 8)) pts.push({ x, z, s: 0.8 + this.rand() * 0.45, ry: this.rand() * 6.3 });
    }
    // scattered on the gentler slopes of the summit and the parade-ground edges
    const [cx, cz] = this.island.center;
    for (let tries = 0; tries < 900 && pts.length < 58; tries++) {
      const x = cx + (this.rand() - 0.5) * 520, z = cz + (this.rand() - 0.5) * 220;
      if (ok(x, z, 12)) pts.push({ x, z, s: 0.7 + this.rand() * 0.55, ry: this.rand() * 6.3 });
    }
    const mats: THREE.Matrix4[] = [];
    for (const p of pts) {
      const g = this.island.heightAt(p.x, p.z) - 0.2;
      mats.push(new THREE.Matrix4().compose(new THREE.Vector3(p.x, g, p.z), new THREE.Quaternion().setFromAxisAngle(_up, p.ry), new THREE.Vector3(p.s, p.s * (0.9 + this.rand() * 0.25), p.s)));
      // trunk sits ~0.9 m off the model pivot
      const c = Math.cos(p.ry), s = Math.sin(p.ry);
      this.col.cylinder([p.x + (0.85 * c - 0.32 * s) * p.s, g + 1.5, p.z + (-0.85 * s - 0.32 * c) * p.s], 1.5, 0.3 * p.s);
    }
    if (mats.length) root.add(named(this.ctx.models.instanced('cypress_tree', mats, { castShadow: true, receiveShadow: true }), 'cypress-trees'));
  }

  // ----------------------------------------------------------------------------------------------
  // Shoreline
  // ----------------------------------------------------------------------------------------------
  private shoreRocks(root: THREE.Object3D) {
    const isl = this.island;
    const coast = isl.data.coastline;
    const ferry = isl.data.lines.find((l) => l.type === 'pier' && l.closed)?.pts ?? null;
    const pier = isl.data.lines.find((l) => l.type === 'pier' && !l.closed)?.pts ?? null;
    const lp: P2 = [LAUNCH.p[0], LAUNCH.p[2]];
    const far: P2 = [LAUNCH.raftSpawn[0] + LAUNCH.seaDir[0] * 40, LAUNCH.raftSpawn[2] + LAUNCH.seaDir[2] * 40];
    const blocked = (x: number, z: number) => {
      if (Math.hypot(x - lp[0], z - lp[1]) < 22) return true;
      if (segDist(x, z, lp[0], lp[1], far[0], far[1]) < 10) return true;
      if (ferry && (pointInPoly(x, z, ferry) || distToPolyEdge(x, z, ferry) < 12)) return true;
      if (pier && segDist(x, z, pier[0][0], pier[0][1], pier[1][0], pier[1][1]) < 8) return true;
      for (let i = 0; i < SEAWALL.length - 1; i++) if (segDist(x, z, SEAWALL[i][0], SEAWALL[i][1], SEAWALL[i + 1][0], SEAWALL[i + 1][1]) < 4.5) return true;
      return corridorClearance(x, z) < 1.5;
    };
    const ring = resample([...coast, coast[0]], 2);
    const rockH = this.ctx.models.size('shore_rocks')?.[1] ?? 1.69;
    let acc = 0;
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1], b = ring[i];
      acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
      const nwTip = b[0] < -228; // riprap round the industrial terraces
      if (acc < (nwTip ? 5 : 9.5)) continue;
      acc = this.rand() * 2;
      const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1;
      let nx = -dz / len, nz = dx / len;
      if (isl.heightAt(b[0] + nx * 3, b[1] + nz * 3) > isl.heightAt(b[0] - nx * 3, b[1] - nz * 3)) { nx = -nx; nz = -nz; }
      const off = 0.2 + this.rand() * 1.8;
      const x = b[0] + nx * off, z = b[1] + nz * off;
      if (blocked(x, z)) continue;
      const s = (nwTip ? 0.55 : 0.7) + this.rand() * 0.7;
      const sc = new THREE.Vector3(s, s * (0.55 + this.rand() * 0.6), s * (0.8 + this.rand() * 0.4));
      // the shore drops steeply: sit on the bottom where it is shallow, otherwise keep the top
      // 0.3-1.2 m out of the water (the hidden underside just hangs below the opaque sea)
      const topY = 0.3 + this.rand() * 0.9;
      const y = Math.max(isl.heightAt(x, z) - 0.25, topY - rockH * sc.y);
      this.rocks.push({ p: new THREE.Vector3(x, y, z), s: sc, ry: this.rand() * Math.PI * 2 });
    }
    const mats = this.rocks.map((r) => new THREE.Matrix4().compose(r.p, new THREE.Quaternion().setFromAxisAngle(_up, r.ry), r.s));
    if (mats.length) root.add(named(this.ctx.models.instanced('shore_rocks', mats, { castShadow: true, receiveShadow: true }), 'shore-rocks'));

    // a few brown pelicans roosting on the rocks
    const birds: THREE.Matrix4[] = [];
    for (let k = 0; k < 24 && birds.length < 8 && this.rocks.length; k++) {
      const r = this.rocks[Math.floor(this.rand() * this.rocks.length)];
      const top = r.p.y + rockH * r.s.y * 0.82;
      if (top < 0.4) continue;
      birds.push(new THREE.Matrix4().compose(
        new THREE.Vector3(r.p.x + (this.rand() - 0.5) * r.s.x, top, r.p.z + (this.rand() - 0.5) * r.s.z),
        new THREE.Quaternion().setFromAxisAngle(_up, this.rand() * Math.PI * 2), new THREE.Vector3(1, 1, 1),
      ));
    }
    if (birds.length) root.add(named(this.ctx.models.instanced('pelican', birds, { castShadow: false, receiveShadow: false }), 'pelicans'));
  }

  /** Crates and oil drums by the power house and on the dock apron. */
  private cargo(root: THREE.Object3D) {
    const crateSpots: [number, number][] = [[-206.5, -23.5], [-208.5, -26.2], [-203.5, -12.5], [-199.5, -7.5], [-212.5, -5.5], [44, -104.5], [47, -106.5], [58, -104], [96, -108.5], [102, -105]];
    const drumSpots: [number, number][] = [[-204.5, -21], [-209.5, -29.5], [-201.5, -10], [-215.5, -3], [41, -106], [55, -106.5], [99.5, -107.5]];
    const ok = (x: number, z: number) => this.island.heightAt(x, z) > 0.8 && corridorClearance(x, z) > 1.8 && !this.inBuilding(x, z, 0.4) && this.slopeY(x, z) > 0.85;
    const crates: THREE.Matrix4[] = [], drums: THREE.Matrix4[] = [];
    const cs = this.ctx.models.size('crates') ?? [0.93, 1.3, 1.43];
    for (const [x, z] of crateSpots) {
      if (!ok(x, z)) continue;
      const g = this.island.heightAt(x, z), ry = this.rand() * Math.PI;
      crates.push(new THREE.Matrix4().compose(new THREE.Vector3(x, g - 0.02, z), new THREE.Quaternion().setFromAxisAngle(_up, ry), new THREE.Vector3(1, 1, 1)));
      this.col.cuboid([x, g + cs[1] / 2, z], [cs[0] / 2, cs[1] / 2, cs[2] / 2], ry);
    }
    for (const [x, z] of drumSpots) {
      if (!ok(x, z)) continue;
      const g = this.island.heightAt(x, z);
      drums.push(new THREE.Matrix4().compose(new THREE.Vector3(x, g - 0.02, z), new THREE.Quaternion().setFromAxisAngle(_up, this.rand() * 6.3), new THREE.Vector3(1, 1, 1)));
      this.col.cylinder([x, g + 0.45, z], 0.45, 0.7);
    }
    if (crates.length) root.add(named(this.ctx.models.instanced('crates', crates, { castShadow: true, receiveShadow: true }), 'crates'));
    if (drums.length) root.add(named(this.ctx.models.instanced('oil_drums', drums, { castShadow: true, receiveShadow: true }), 'oil-drums'));
  }

  // ----------------------------------------------------------------------------------------------
  // Dock, pier, seawall, cistern
  // ----------------------------------------------------------------------------------------------
  private piers() {
    const isl = this.island;
    const deckY = 2.4;
    const ferry = isl.data.lines.find((l) => l.type === 'pier' && l.closed);
    if (ferry) {
      const poly = cleanPoly(ferry.pts);
      this.deckPoly(poly, deckY);
      // gangway from the landward edge up onto the dock apron
      let best = -Infinity, a: P2 = poly[0], b: P2 = poly[1];
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        const h = isl.heightAt((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
        if (h > best) { best = h; a = p; b = q; }
      }
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      let nx = dz / l, nz = -dx / l; // outward of the polygon (positive area)
      if (pointInPoly(mx + nx, mz + nz, poly)) { nx = -nx; nz = -nz; }
      let end = 2;
      while (end < 25 && isl.heightAt(mx + nx * end, mz + nz * end) < deckY - 0.3) end += 1;
      this.deckLine([mx - nx * 0.5, mz - nz * 0.5], [mx + nx * (end + 1), mz + nz * (end + 1)], 4.5, deckY);
    }
    const pier = isl.data.lines.find((l) => l.type === 'pier' && !l.closed);
    if (pier && pier.pts.length >= 2) {
      const pts = pier.pts.map((p): P2 => [p[0], p[1]]);
      // extend the landward end until it meets ground at deck height
      const first = isl.heightAt(pts[0][0], pts[0][1]) > isl.heightAt(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      const [e, f] = first ? [pts[0], pts[1]] : [pts[pts.length - 1], pts[pts.length - 2]];
      const dx = e[0] - f[0], dz = e[1] - f[1], l = Math.hypot(dx, dz) || 1;
      for (let k = 0; k < 20 && isl.heightAt(e[0], e[1]) < deckY - 0.2; k++) { e[0] += (dx / l) * 1; e[1] += (dz / l) * 1; }
      for (let i = 0; i < pts.length - 1; i++) this.deckLine(pts[i], pts[i + 1], 4.6, deckY);
    }
  }

  private deckPoly(poly: P2[], y: number) {
    this.wood.currentColor = [0.95, 0.92, 0.88];
    // planks along the long side: uv in metres / 2 on x, z
    this.wood.cap(poly, y, true, 0.5);
    this.wood.cap(poly, y - 0.35, false, 0.5);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      this.wood.wall(a[0], a[1], b[0], b[1], y - 0.35, y, y - 0.35, y, dz / l, -dx / l, 0, 0.5);
      // piles every 4 m along the edge
      for (let d = 0; d <= l; d += 4) {
        const x = a[0] + (dx / l) * d - (dz / l) * 0.3, z = a[1] + (dz / l) * d + (dx / l) * 0.3;
        this.wood.cylinder([x, -7, z], [x, y - 0.3, z], 0.17, 7);
      }
    }
    // interior piles
    const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
    for (let x = Math.min(...xs) + 4; x < Math.max(...xs); x += 5) {
      for (let z = Math.min(...zs) + 4; z < Math.max(...zs); z += 5) {
        if (pointInPoly(x, z, poly) && distToPolyEdge(x, z, poly) > 1.5) this.wood.cylinder([x, -7, z], [x, y - 0.3, z], 0.17, 7);
      }
    }
    this.col.trimesh(...capTrimesh(poly, y));
  }

  private deckLine(a: P2, b: P2, width: number, y: number) {
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    if (l < 0.5) return;
    this.wood.currentColor = [0.9, 0.87, 0.83];
    this.wood.beam(a, b, y - 0.35, y, width, 0.5);
    this.col.beam(a, b, y - 0.35, y, width);
    const nx = -dz / l, nz = dx / l;
    for (let d = 1; d < l; d += 4) {
      for (const s of [-1, 1]) {
        const x = a[0] + (dx / l) * d + nx * s * (width / 2 - 0.3), z = a[1] + (dz / l) * d + nz * s * (width / 2 - 0.3);
        if (this.island.heightAt(x, z) > y - 0.5) continue;
        this.wood.cylinder([x, -7, z], [x, y - 0.3, z], 0.16, 7);
      }
    }
  }

  /** Concrete seawall walk along the power-house shore, carrying the shore patrol over the water. */
  private seawall() {
    const w = 3.6;
    const tops = [1.32, 1.7, 1.75, 1.75]; // ramps up from the shingle so ground-snapping follows it
    const L = SEAWALL;
    const left: P2[] = [], right: P2[] = [], nrm: P2[] = [];
    for (let i = 0; i < L.length; i++) {
      const o = L[Math.max(0, i - 1)], q = L[Math.min(L.length - 1, i + 1)];
      const tx = q[0] - o[0], tz = q[1] - o[1], tl = Math.hypot(tx, tz) || 1;
      const nx = -tz / tl, nz = tx / tl;
      nrm.push([nx, nz]);
      left.push([L[i][0] + (nx * w) / 2, L[i][1] + (nz * w) / 2]);
      right.push([L[i][0] - (nx * w) / 2, L[i][1] - (nz * w) / 2]);
    }
    const verts: number[] = [], idx: number[] = [];
    this.concrete.currentColor = [0.72, 0.71, 0.67];
    for (let i = 0; i < L.length - 1; i++) {
      const y0 = tops[i], y1 = tops[i + 1];
      const la = left[i], lb = left[i + 1], ra = right[i], rb = right[i + 1];
      this.concrete.quad([la[0], y0, la[1]], [lb[0], y1, lb[1]], [rb[0], y1, rb[1]], [ra[0], y0, ra[1]], [0, 1, 0],
        [[0, 0], [0.9, 0], [0.9, 0.9], [0, 0.9]]);
      const [nx, nz] = nrm[i];
      this.concrete.wall(la[0], la[1], lb[0], lb[1], -3, y0, -3, y1, nx, nz, 0, 0.25);
      this.concrete.wall(ra[0], ra[1], rb[0], rb[1], -3, y0, -3, y1, -nx, -nz, 0, 0.25);
      const b = verts.length / 3;
      verts.push(la[0], y0, la[1], lb[0], y1, lb[1], rb[0], y1, rb[1], ra[0], y0, ra[1]);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      // solid sides so nobody walks under it
      this.col.beam(la, lb, -3, Math.min(y0, y1) - 0.05, 0.3);
      this.col.beam(ra, rb, -3, Math.min(y0, y1) - 0.05, 0.3);
    }
    // beach end face
    const [tx, tz] = [L[1][0] - L[0][0], L[1][1] - L[0][1]];
    const tl = Math.hypot(tx, tz) || 1;
    this.concrete.wall(left[0][0], left[0][1], right[0][0], right[0][1], -1, tops[0], -1, tops[0], -tx / tl, -tz / tl, 0, 0.25);
    this.col.trimesh(new Float32Array(verts), new Uint32Array(idx));
  }

  /** Covered reservoir (Cistern area): a low concrete lid with vents. */
  private cistern() {
    const poly = this.area('Cistern');
    if (!poly) return;
    const p = cleanPoly(poly);
    let gmax = -Infinity, gmin = Infinity;
    for (const [x, z] of p) { const h = this.island.heightAt(x, z); gmax = Math.max(gmax, h); gmin = Math.min(gmin, h); }
    const top = gmax + 0.45;
    this.concrete.currentColor = [0.7, 0.69, 0.65];
    this.concrete.cap(p, top, true, 0.25);
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      this.concrete.wall(a[0], a[1], b[0], b[1], gmin - 0.5, top, gmin - 0.5, top, dz / l, -dx / l, 0, 0.25);
      this.col.beam([a[0] - (dz / l) * 0.2, a[1] + (dx / l) * 0.2], [b[0] - (dz / l) * 0.2, b[1] + (dx / l) * 0.2], gmin - 0.5, top, 0.4);
    }
    this.col.trimesh(...capTrimesh(p, top));
    const [cx, cz] = [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
    for (const [ox, oz] of [[-6, -3], [5, 2], [0, 4]]) this.darkMetal.box([cx + ox, top + 0.35, cz + oz], [0.35, 0.35, 0.35]);
  }

  // ----------------------------------------------------------------------------------------------
  // Signs
  // ----------------------------------------------------------------------------------------------
  private signs(root: THREE.Object3D) {
    // "UNITED STATES PENITENTIARY" on Building 64, on the long facade facing the dock / the bay
    const b64 = this.built.find((b) => b.name === 'Building 64');
    if (b64) {
      let best = 0, ia = 0;
      for (let i = 0; i < b64.poly.length; i++) {
        const a = b64.poly[i], b = b64.poly[(i + 1) % b64.poly.length];
        const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
        const facing = Math.max(0, dx / (l || 1)); // outward normal (dz, -dx)/l: -Z component = dx/l
        if (l * facing > best) { best = l * facing; ia = i; }
      }
      const a = b64.poly[ia], b = b64.poly[(ia + 1) % b64.poly.length];
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
      const nx = dz / l, nz = -dx / l;
      // toward the dock (east) end of that facade
      const t = (a[0] > b[0] ? 0.25 : 0.75);
      const cx = a[0] + dx * t + nx * 0.12, cz = a[1] + dz * t + nz * 0.12;
      const y = b64.roof - 2.2;
      const tex = signTexture('usp', [{ text: 'UNITED STATES PENITENTIARY', size: 120, weight: '700' }], 2048, 200, { border: false, bg: '#e6e0d0' });
      this.board(root, tex, cx, y, cz, nx, nz, 16, 1.56, 0.32);
    }
    // "Only government boats" warning boards: NW shore (Model Industries) and the dock
    const warn = signTexture('boats', [
      { text: 'WARNING', size: 110 },
      { text: 'ONLY GOVERNMENT BOATS', size: 74 },
      { text: 'PERMITTED WITHIN 200 YARDS', size: 74 },
      { text: 'U.S. PENITENTIARY · ALCATRAZ ISLAND', size: 40, weight: '400' },
    ], 1024, 512);
    for (const [x, z] of [[-281, 33], [110, -119]] as P2[]) this.shoreBoard(root, warn, x, z);
  }

  /** A board on two posts facing the water, on dry ground just inland of the coast nearest (x, z). */
  private shoreBoard(root: THREE.Object3D, tex: THREE.Texture, x: number, z: number) {
    const isl = this.island;
    const coast = isl.data.coastline;
    // nearest coastline segment -> seaward normal (toward the lower side)
    let best = Infinity, cx = x, cz = z, dx = 0, dz = -1;
    for (let i = 0; i < coast.length - 1; i++) {
      const a = coast[i], b = coast[i + 1];
      const vx = b[0] - a[0], vz = b[1] - a[1], l2 = vx * vx + vz * vz || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (z - a[1]) * vz) / l2));
      const px = a[0] + vx * t, pz = a[1] + vz * t, d = Math.hypot(px - x, pz - z);
      if (d < best) {
        best = d; cx = px; cz = pz;
        const l = Math.sqrt(l2);
        dx = -vz / l; dz = vx / l;
        if (isl.heightAt(px + dx * 3, pz + dz * 3) > isl.heightAt(px - dx * 3, pz - dz * 3)) { dx = -dx; dz = -dz; }
      }
    }
    // walk inland until the ground is dry, gentle and clear of buildings
    let px = cx, pz = cz;
    for (let k = 0; k < 40; k++) {
      if (isl.heightAt(px, pz) > 2.2 && this.slopeY(px, pz) > 0.85 && !this.inBuilding(px, pz, 1.5)) break;
      px -= dx; pz -= dz;
    }
    const g = isl.heightAt(px, pz);
    const w = 4.2, h = 2.1, post = 2.0;
    const tx = -dz, tz = dx;
    for (const sd of [-1, 1]) {
      const qx = px + tx * sd * (w / 2 - 0.3), qz = pz + tz * sd * (w / 2 - 0.3);
      this.darkMetal.cylinder([qx - dx * 0.05, isl.heightAt(qx, qz) - 0.3, qz - dz * 0.05], [qx - dx * 0.05, g + post + h, qz - dz * 0.05], 0.07, 6);
      this.col.cylinder([qx, g + 1.5, qz], 1.6, 0.1);
    }
    this.board(root, tex, px, g + post + h / 2, pz, dx, dz, w, h, 0.08);
    this.wood.currentColor = [0.5, 0.47, 0.43];
    this.wood.beam([px - (tx * w) / 2 - dx * 0.03, pz - (tz * w) / 2 - dz * 0.03], [px + (tx * w) / 2 - dx * 0.03, pz + (tz * w) / 2 - dz * 0.03], g + post, g + post + h, 0.05, 0.5);
  }

  /** A textured sign quad centred at (x, y, z) facing (nx, nz). */
  private board(root: THREE.Object3D, tex: THREE.Texture, x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, glow: number) {
    const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: glow, roughness: 0.8, metalness: 0 });
    const geo = new THREE.PlaneGeometry(w, h);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.y = Math.atan2(nx, nz); // plane faces +Z locally
    m.receiveShadow = true;
    m.name = 'sign';
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    root.add(m);
  }
}

/** Walking lines that props must not stand on: the service yard (pipe -> fence) and the corridors. */
const YARD_PATH: P2[] = [
  [BAKERY_PIPE.groundStand[0], BAKERY_PIPE.groundStand[2]],
  [CLIMBS.find((c) => c.id === 'bakery_pipe')?.dropHeavyTo?.[0] ?? -78.4, CLIMBS.find((c) => c.id === 'bakery_pipe')?.dropHeavyTo?.[2] ?? -11.2],
  [FENCE.climbIn[0], FENCE.climbIn[2]],
];
function nearestOnPaths(x: number, z: number): { x: number; z: number; d: number } | null {
  let best: { x: number; z: number; d: number } | null = null;
  const test = (pts: P2[], closed: boolean) => {
    const n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const vx = b[0] - a[0], vz = b[1] - a[1], l2 = vx * vx + vz * vz || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (z - a[1]) * vz) / l2));
      const px = a[0] + vx * t, pz = a[1] + vz * t, d = Math.hypot(x - px, z - pz);
      if (!best || d < best.d) best = { x: px, z: pz, d };
    }
  };
  test(YARD_PATH, false);
  for (const c of CORRIDORS) test(c.pts, c.closed);
  return best;
}

/** Shore-patrol seawall centreline (beach end -> power house). */
const SEAWALL: P2[] = [[-218.5, -44.9], [-226, -44], [-236, -30], [-237.4, -27.4]];

const _up = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();

function named(o: THREE.Object3D, name: string) { o.name = name; return o; }

/** Flat polygon -> collider trimesh arrays. */
function capTrimesh(poly: P2[], y: number): [Float32Array, Uint32Array] {
  const tris = THREE.ShapeUtils.triangulateShape(poly.map((p) => new THREE.Vector2(p[0], p[1])), []);
  const v = new Float32Array(poly.length * 3);
  poly.forEach((p, i) => { v[i * 3] = p[0]; v[i * 3 + 1] = y; v[i * 3 + 2] = p[1]; });
  const idx = new Uint32Array(tris.length * 3);
  tris.forEach((t, i) => { idx[i * 3] = t[0]; idx[i * 3 + 1] = t[1]; idx[i * 3 + 2] = t[2]; });
  return [v, idx];
}
