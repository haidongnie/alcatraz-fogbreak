// One carbon-arc searchlight: a SpotLight (no shadows, per the lighting budget), a volumetric shaft
// clipped where its axis first hits the world, an HDR lens glare, and the stealth exposure test
// with occlusion. Used by the tower lamps and the patrol boat. The owner positions/rotates `pivot`
// (beam along the pivot's -Z) and calls refresh() once per frame.
import * as THREE from 'three/webgpu';
import { createBeam, createGlare, type Beam } from './beams';
import { smoothstep } from './common';
import type { WorldQueries } from './queries';

export interface BeaconOptions {
  range: number;
  /** half-angle of the lit cone (rad) */
  angle: number;
  intensity: number;
  color: THREE.ColorRepresentation;
  glareSize: number;
  /** drifting fog wisps inside the shaft (high quality tier) */
  wisps: boolean;
}

/** Rays start this far out of the lens so the tower cab / boat superstructure never self-occludes. */
const LENS_CLEARANCE = 1.6;

export class Beacon {
  readonly pivot = new THREE.Object3D();
  readonly spot: THREE.SpotLight;
  readonly beam: Beam;
  readonly glare: THREE.Sprite;
  /** world lens position / unit beam direction (valid after refresh) */
  readonly pos = new THREE.Vector3();
  readonly dir = new THREE.Vector3(0, 0, -1);
  /** distance along the axis to the first obstacle (or range) */
  reach: number;
  private readonly tanA: number;
  private readonly cosA: number;
  private readonly toCam = new THREE.Vector3();

  constructor(readonly o: BeaconOptions) {
    this.reach = o.range;
    this.tanA = Math.tan(o.angle);
    this.cosA = Math.cos(o.angle);
    // decay 1.5 instead of the physical 2 so the pool still reads at 100+ m (a real arc lamp is
    // collimated: its beam barely spreads)
    this.spot = new THREE.SpotLight(o.color, o.intensity, o.range, o.angle, 0.35, 1.5);
    this.spot.castShadow = false;
    this.spot.target.position.set(0, 0, -1);
    this.pivot.add(this.spot, this.spot.target);
    this.beam = createBeam({ color: o.color, strength: 0.5, angle: o.angle * 0.8, falloff: 1.1, wisps: o.wisps });
    this.beam.setLength(o.range);
    this.pivot.add(this.beam.mesh);
    this.glare = createGlare(o.color, o.glareSize, 4);
    this.glare.position.set(0, 0, -0.2);
    this.pivot.add(this.glare);
  }

  /** After the pivot moved: world pose, shaft/light clipping against terrain and buildings, glare. */
  refresh(q: WorldQueries, camPos: THREE.Vector3) {
    this.pivot.updateWorldMatrix(true, false);
    this.pos.setFromMatrixPosition(this.pivot.matrixWorld);
    this.dir.set(0, 0, -1).transformDirection(this.pivot.matrixWorld);
    const r = this.o.range;
    const c = LENS_CLEARANCE;
    this.reach = c + q.rayDistance(this.pos.x + this.dir.x * c, this.pos.y + this.dir.y * c, this.pos.z + this.dir.z * c,
      this.dir.x, this.dir.y, this.dir.z, r - c);
    // An unshadowed spot would light everything inside its cone, including the far side of hills and
    // the lee of the power house. Pulling the cut-off in to just past the first obstacle on the axis
    // keeps the visible pool consistent with the occlusion-aware exposure below.
    this.spot.distance = Math.min(r, this.reach * 1.6 + 4);
    this.beam.setLength(Math.min(r, this.reach + 2));
    // glare: a bright point from the side, a blinding disc when the beam sweeps across the camera
    this.toCam.copy(camPos).sub(this.pos);
    const camDist = this.toCam.length();
    const facing = camDist > 1e-3 ? smoothstep(Math.cos(this.o.angle * 3), Math.cos(this.o.angle * 0.5), this.toCam.dot(this.dir) / camDist) : 0;
    this.glare.material.opacity = 0.2 + 0.8 * facing;
    this.glare.scale.setScalar(this.o.glareSize * (0.6 + 1.2 * facing));
  }

  /** 0..1: how strongly p sits inside the beam, 0 when something solid is in between. */
  exposure(p: THREE.Vector3, q: WorldQueries): number {
    const vx = p.x - this.pos.x, vy = p.y - this.pos.y, vz = p.z - this.pos.z;
    const along = vx * this.dir.x + vy * this.dir.y + vz * this.dir.z;
    const r = this.o.range;
    if (along <= LENS_CLEARANCE || along > r) return 0;
    const d2 = vx * vx + vy * vy + vz * vz;
    const d = Math.sqrt(d2);
    if (along / d < this.cosA) return 0;
    const radius = along * this.tanA;
    const perp = Math.sqrt(Math.max(0, d2 - along * along));
    const core = 1 - smoothstep(0.5 * radius, radius, perp);
    const fade = along > 0.85 * r ? 1 - 0.4 * (along - 0.85 * r) / (0.15 * r) : 1;
    const e = core * fade;
    if (e < 0.05) return 0;
    const ux = vx / d, uy = vy / d, uz = vz / d, c = LENS_CLEARANCE;
    if (!q.lineClear(this.pos.x + ux * c, this.pos.y + uy * c, this.pos.z + uz * c, p.x, p.y, p.z, 0.35)) return 0;
    return e;
  }

  dispose() {
    (this.beam.mesh.material as THREE.Material).dispose();
    this.glare.material.dispose();
    this.spot.dispose();
  }
}
