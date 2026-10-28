// Meshy landmarks at their OSM positions (real size and pivot are baked into the models):
// the 1909 lighthouse with its keepers' quarters (lit lantern + slowly sweeping beams), the 1941
// water tower, the power-house smokestack, the Warden's House (oriented to its footprint), and the
// gun towers under each searchlight (smaller cab on the Model Industries roof). Simple colliders.
import * as THREE from 'three/webgpu';
import { cos, float, length, mix, positionLocal, sin, smoothstep, time, uniform, uv, vec3, vec4 } from 'three/tsl';
import type { Ctx } from '../../game/context';
import type { Island } from '../island';
import { SEARCHLIGHTS } from '../layout';
import { MeshBatch, type Colliders } from './builder';
import { materials } from './materials';
import { cleanPoly, distToPolyEdge, pointInPoly, type IslandBuilding } from './data';
import { insetPoly, type BuiltBuilding } from './buildings';

/** Lighthouse: one revolution every 10 s -> a flash every 5 s from any direction. */
const BEAM_PERIOD = 10;

export class Landmarks {
  private readonly steel = new MeshBatch();
  // beams brighten in thicker fog (more scattering); driven per render so it also runs on the title screen
  private readonly beamGlow = uniform(1);

  constructor(private readonly ctx: Ctx, private readonly island: Island, private readonly col: Colliders, private readonly built: BuiltBuilding[]) {
    this.beamGlow.onRenderUpdate(() => {
      const fog = this.ctx.scene.fog as THREE.FogExp2 | null;
      return fog ? THREE.MathUtils.clamp(0.5 + fog.density * 90, 0.6, 1.6) : 1;
    });
  }

  private building(name: string): IslandBuilding | undefined {
    return this.island.data.buildings.find((b) => b.name === name);
  }

  /** Lowest terrain under a set of local footprint offsets around (x, z). */
  private minGround(x: number, z: number, r: number) {
    let g = this.island.heightAt(x, z);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      g = Math.min(g, this.island.heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r));
    }
    return g;
  }

  private place(id: string, x: number, y: number, z: number, ry = 0, scale = 1): THREE.Object3D {
    const o = this.ctx.models.instance(id);
    o.name = `landmark-${id}`;
    o.position.set(x, y, z);
    o.rotation.y = ry;
    o.scale.setScalar(scale);
    o.updateMatrixWorld(true);
    o.traverse((c) => { c.matrixAutoUpdate = false; c.updateMatrix(); });
    return o;
  }

  build(root: THREE.Object3D) {
    // --- lighthouse: tower over the OSM footprint centroid, keepers' quarters toward -Z -----------
    const lh = this.building('Alcatraz Island Lighthouse');
    if (lh) {
      const ry = Math.PI / 2;
      // tower axis sits at local (-2.55, -0.3) in the model; rotate that offset into place
      const lx = -2.55, lz = -0.3;
      const ox = lx * Math.cos(ry) + lz * Math.sin(ry), oz = -lx * Math.sin(ry) + lz * Math.cos(ry);
      const px = lh.centroid[0] - ox, pz = lh.centroid[1] - oz;
      const y = this.minGround(px, pz, 6.5) - 0.15;
      root.add(this.place('lighthouse', px, y, pz, ry));
      this.col.cylinder([lh.centroid[0], y + 13, lh.centroid[1]], 13, 2.3);
      this.col.cuboid([px, y + 4.5, pz], [7.0, 4.5, 5.9], ry); // keepers' quarters (model local x/z)
      this.lantern(root, lh.centroid[0], y + 22.1, lh.centroid[1]);
    }
    // --- water tower ----------------------------------------------------------------------------
    const wt = this.building('Water Tower');
    if (wt) {
      const y = this.minGround(wt.centroid[0], wt.centroid[1], 4.3) - 0.1;
      root.add(this.place('water_tower', wt.centroid[0], y, wt.centroid[1], 0.3));
      for (let k = 0; k < 6; k++) {
        const a = 0.3 + (k / 6) * Math.PI * 2;
        this.col.cuboid([wt.centroid[0] + Math.cos(a) * 4.1, y + 8, wt.centroid[1] + Math.sin(a) * 4.1], [0.3, 8, 0.3]);
      }
      this.col.cylinder([wt.centroid[0], y + 19.5, wt.centroid[1]], 3.5, 6);
    }
    // --- power-house smokestack -------------------------------------------------------------------
    const ss = this.building('Powerhouse Smokestack');
    if (ss) {
      const y = this.minGround(ss.centroid[0], ss.centroid[1], 1.8) - 0.3;
      root.add(this.place('smokestack', ss.centroid[0], y, ss.centroid[1], 0.7));
      this.col.cylinder([ss.centroid[0], y + 15, ss.centroid[1]], 15, 2.0);
    }
    // --- Warden's House: long axis along the footprint's longest edge, scaled to the footprint ---
    const wh = this.building("Warden's House");
    if (wh) {
      const poly = cleanPoly(wh.poly);
      let best = 0, ang = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (l > best) { best = l; ang = Math.atan2(b[1] - a[1], b[0] - a[0]); }
      }
      // footprint extent along / across that axis
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const p of poly) {
        const u = p[0] * ca + p[1] * sa, v = -p[0] * sa + p[1] * ca;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      const cx = cu * ca - cv * sa, cz = cu * sa + cv * ca;
      const size = this.ctx.models.size('warden_house') ?? [22, 14.2, 19.3];
      const s = THREE.MathUtils.clamp((u1 - u0 + 1.5) / size[0], 0.7, 1.05);
      const ry = -ang; // local +X -> (cos ang, sin ang)
      const y = this.minGround(cx, cz, 7) - 0.2;
      root.add(this.place('warden_house', cx, y, cz, ry, s));
      this.col.cuboid([cx, y + 5, cz], [(size[0] * s) / 2 - 0.6, 5, (size[2] * s) / 2 - 1.2], ry);
    }
    // --- gun towers under the searchlights --------------------------------------------------------
    const towerH = this.ctx.models.size('guard_tower')?.[1] ?? 11;
    for (const sl of SEARCHLIGHTS) {
      const [x, y, z] = sl.tower;
      if (sl.height < towerH * 0.6) {
        // roof-mounted cab (Model Industries): smaller tower standing on the host roof, its legs
        // hidden inside the building. The cab goes on the nearest point of the nearest roof.
        const s = 0.6;
        const host = this.roofFor(x, z);
        if (host) {
          const cabFloor = 4.4 * s; // model: cab floor ~4.4 m above its base
          root.add(this.place('guard_tower', host.x, host.roof + 0.15 - cabFloor, host.z, sl.yaw, s));
          this.col.cuboid([host.x, host.roof + 1.9, host.z], [1.0, 1.9, 1.0], sl.yaw);
        } else {
          root.add(this.place('guard_tower', x, y + sl.height - towerH * s, z, sl.yaw, s));
        }
      } else {
        // the model's top carries the lamp; a taller tower stands on a braced steel substructure
        const base = y + sl.height - towerH;
        const ground = Math.min(this.island.heightAt(x, z), base);
        root.add(this.place('guard_tower', x, base, z, sl.yaw));
        if (base - ground > 0.8) this.lattice(x, z, ground - 0.3, base + 0.05, sl.yaw);
        this.col.cuboid([x, (ground + y + sl.height) / 2, z], [1.45, (y + sl.height - ground) / 2, 1.45], sl.yaw);
      }
    }
    this.steel.mesh(root, materials().darkMetal, 'tower-substructures', true, false);
  }

  /** Tapered four-legged steel lattice (rings + X bracing) from y0 up to the cab tower's base. */
  private lattice(x: number, z: number, y0: number, y1: number, yaw: number) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const at = (lx: number, lz: number, y: number): [number, number, number] => [x + lx * c + lz * s, y, z - lx * s + lz * c];
    const h0 = 2.3, h1 = 1.3; // half-widths at the bottom and at the top
    const levels = Math.max(2, Math.round((y1 - y0) / 3.2));
    const corner = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const ring = (k: number) => {
      const t = k / levels, y = y0 + (y1 - y0) * t, h = h0 + (h1 - h0) * t;
      return corner.map(([a, b]) => at(a * h, b * h, y));
    };
    for (let k = 0; k < levels; k++) {
      const lo = ring(k), hi = ring(k + 1);
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        this.steel.cylinder(lo[i], hi[i], 0.13, 6);             // leg
        this.steel.cylinder(hi[i], hi[j], 0.06, 4);             // ring
        this.steel.cylinder(lo[i], hi[j], 0.035, 4);            // X bracing
        this.steel.cylinder(lo[j], hi[i], 0.035, 4);
      }
    }
  }

  /** Roof point for a roof-mounted tower: (x, z) itself when it is on a roof, else the nearest roof point (inset 2.5 m). */
  private roofFor(x: number, z: number): { x: number; z: number; roof: number } | null {
    let best: { x: number; z: number; roof: number; d: number } | null = null;
    for (const b of this.built) {
      if (pointInPoly(x, z, b.poly) && distToPolyEdge(x, z, b.poly) >= 2.0) return { x, z, roof: b.roof };
      const inner = insetPoly(b.poly, 2.5);
      for (let i = 0; i < inner.length; i++) {
        const p = inner[i], q = inner[(i + 1) % inner.length];
        const vx = q[0] - p[0], vz = q[1] - p[1], l2 = vx * vx + vz * vz || 1;
        const t = Math.max(0, Math.min(1, ((x - p[0]) * vx + (z - p[1]) * vz) / l2));
        const px = p[0] + vx * t, pz = p[1] + vz * t, d = Math.hypot(px - x, pz - z);
        if (d < 30 && (!best || d < best.d) && pointInPoly(px, pz, b.poly)) best = { x: px, z: pz, roof: b.roof, d };
      }
    }
    return best;
  }

  /** Lit lantern + two opposite beams sweeping slowly (fog-friendly additive cones). */
  private lantern(root: THREE.Object3D, x: number, y: number, z: number) {
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.75, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff1d6, emissiveIntensity: 14, roughness: 0.2 }),
    );
    glow.name = 'lighthouse-lantern';
    glow.position.set(x, y, z);
    glow.castShadow = false;
    glow.matrixAutoUpdate = false;
    glow.updateMatrix();
    root.add(glow);

    // beams: open cones along +X with the apex at the lantern, fading with length and at the rim
    const len = 160, rad = 13;
    const geo = new THREE.ConeGeometry(rad, len, 24, 1, true);
    geo.translate(0, -len / 2, 0);
    geo.rotateZ(Math.PI / 2); // apex at origin, opening toward +X
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    });
    // rotate about the lantern in the vertex stage (time-driven, no per-frame CPU work)
    const ang = time.mul((Math.PI * 2) / BEAM_PERIOD);
    const p = positionLocal;
    mat.positionNode = vec3(p.x.mul(cos(ang)).add(p.z.mul(sin(ang))), p.y, p.z.mul(cos(ang)).sub(p.x.mul(sin(ang))));
    // distance from the apex is rotation-invariant (positionLocal may already be the rotated one)
    const along = length(positionLocal).div(len).clamp(0, 1);
    const fall = float(1).sub(along).pow(2.2).mul(smoothstep(0.0, 0.03, along));
    const rim = float(1).sub(uv().x.sub(0.5).abs().mul(2)).clamp(0, 1); // soft edges across the cone surface
    const tint = mix(vec3(1.0, 0.95, 0.85), vec3(0.75, 0.82, 0.95), along);
    mat.colorNode = vec4(tint.mul(fall).mul(rim.mul(0.4).add(0.6)).mul(0.07).mul(this.beamGlow), 1);
    // two opposite beams baked into one geometry, tilted a touch downward
    const both = geo.clone();
    both.rotateZ(-0.04);
    const back = both.clone();
    back.rotateY(Math.PI);
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute([...both.getAttribute('position').array, ...back.getAttribute('position').array], 3));
    merged.setAttribute('uv', new THREE.Float32BufferAttribute([...both.getAttribute('uv').array, ...back.getAttribute('uv').array], 2));
    const ia = both.getIndex()!.array, n = both.getAttribute('position').count;
    merged.setIndex([...ia, ...Array.from(ia, (i) => i + n)]);
    geo.dispose(); both.dispose(); back.dispose();
    const cone = new THREE.Mesh(merged, mat);
    cone.name = 'lighthouse-beams';
    cone.position.set(x, y, z);
    cone.frustumCulled = false;
    cone.renderOrder = 5;
    cone.matrixAutoUpdate = false;
    cone.updateMatrix();
    root.add(cone);
  }

  update(_dt: number) {}
}
