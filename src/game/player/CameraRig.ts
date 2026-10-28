// Third-person over-the-shoulder camera.
//
// The pivot sits at the followed character's eye height; the camera hangs `arm` metres behind a
// shoulder point offset to the right. Two sphere sweeps against the world (QUERY_WORLD_ONLY) keep
// it out of walls: pivot -> shoulder (so the shoulder offset never pokes through a wall beside
// the player), then shoulder -> back along the view direction. The arm snaps in on contact and
// eases back out. Tight zones (own cell, utility corridor, the hole) cap the boom and shoulder so
// the view stays readable instead of grinding along the walls.
// Yaw/pitch come from mouse/touch look; yaw 0 looks toward -Z, positive pitch looks up.
import * as THREE from 'three/webgpu';
import { TUNING } from '../../config';
import { RAPIER } from '../../core/physics';
import { QUERY_WORLD_ONLY, type Ctx } from '../context';
import type { ZoneId } from '../types';

/** What the rig follows (implemented by LocalPlayer). */
export interface RigTarget {
  /** interpolated feet position */
  readonly position: THREE.Vector3;
  /** pivot height above the feet for the current pose (standing, crouching, sitting, swimming) */
  readonly eyeHeight: number;
  readonly zone: ZoneId;
  readonly avatar: { readonly root: THREE.Object3D };
}

const SENS_KEY = 'fogbreak.sens';
const PITCH_MIN = -1.25;
const PITCH_MAX = 0.75;
const DIST_MIN = 1.4;
const DIST_MAX = 6;
const SHOULDER = 0.45;
const MIN_ARM = 0.15;
/** camera never dips under the sea surface (the sea plane is not a collider) */
const MIN_CAMERA_Y = 0.3;

/** Boom / shoulder caps and collision radius in confined spaces. */
const TIGHT: Partial<Record<ZoneId, { boom: number; shoulder: number; radius: number }>> = {
  cell: { boom: 1.3, shoulder: 0.25, radius: 0.12 },
  utility: { boom: 1.2, shoulder: 0.2, radius: 0.12 },
  dblock: { boom: 1.6, shoulder: 0.3, radius: 0.14 },
  workshop: { boom: 2.4, shoulder: 0.35, radius: 0.16 },
};
const OPEN = { boom: Infinity, shoulder: SHOULDER, radius: 0.2 };

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const _goal = new THREE.Vector3();
const _look = new THREE.Vector3();
const _right = new THREE.Vector3();
const _shoulder = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

export class CameraRig {
  /** camera yaw (0 = looking toward -Z) and pitch, driven by mouse/touch look */
  yaw = 0;
  pitch = -0.15;
  /** user-chosen boom length (mouse wheel) */
  distance = 3.2;

  private target: RigTarget | null = null;
  private readonly pivot = new THREE.Vector3();
  private eye = 1.58;
  private arm = 3.2;
  private boom = 3.2;
  private shoulder = SHOULDER;
  private snapNext = true;
  private sensitivity = 1;
  private sensTimer = 0;
  private readonly balls = new Map<number, InstanceType<typeof RAPIER.Ball>>();
  // plain Rapier vectors reused for every query (Rapier copies them into WASM)
  private readonly rOrigin = { x: 0, y: 0, z: 0 };
  private readonly rDir = { x: 0, y: 0, z: 0 };

  constructor(readonly ctx: Ctx) {
    this.readSensitivity();
    ctx.bus.on('ui', () => this.readSensitivity()); // the pause menu writes the setting
  }

  /** Follow a character (the local player registers itself). */
  follow(target: RigTarget | null) {
    this.target = target;
    this.snapNext = true;
  }

  /** Jump straight to the target next update (spawn, teleport, traverse). */
  snap() { this.snapNext = true; }

  update(dt: number) {
    const t = this.target;
    if (!t) return;
    const { input, camera } = this.ctx;

    this.sensTimer += dt;
    if (this.sensTimer > 1) { this.sensTimer = 0; this.readSensitivity(); }
    if (input.lookActive) {
      const s = TUNING.player.lookSensitivity * this.sensitivity;
      this.yaw -= input.look.x * s;
      this.pitch = THREE.MathUtils.clamp(this.pitch - input.look.y * s, PITCH_MIN, PITCH_MAX);
    }
    if (input.wheel) this.distance = THREE.MathUtils.clamp(this.distance + input.wheel * 0.45, DIST_MIN, DIST_MAX);
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;

    // limits for the current space
    const lim = TIGHT[t.zone] ?? OPEN;
    const boomGoal = Math.min(this.distance, lim.boom);
    const kLim = this.snapNext ? 1 : 1 - Math.exp(-5 * dt);
    this.boom += (boomGoal - this.boom) * kLim;
    this.shoulder += (lim.shoulder - this.shoulder) * kLim;

    // pivot: follows the feet + eye height; vertical is softer so steps/stairs do not jolt
    this.eye += (t.eyeHeight - this.eye) * (this.snapNext ? 1 : 1 - Math.exp(-7 * dt));
    _goal.set(t.position.x, t.position.y + this.eye, t.position.z);
    if (this.snapNext || this.pivot.distanceToSquared(_goal) > 36) {
      this.pivot.copy(_goal);
    } else {
      const kh = 1 - Math.exp(-28 * dt);
      const kv = 1 - Math.exp(-12 * dt);
      this.pivot.x += (_goal.x - this.pivot.x) * kh;
      this.pivot.z += (_goal.z - this.pivot.z) * kh;
      this.pivot.y += (_goal.y - this.pivot.y) * kv;
    }

    // view basis
    const cp = Math.cos(this.pitch);
    _look.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    // 1) pivot -> shoulder, 2) shoulder -> back
    const ball = this.ball(lim.radius);
    const side = this.sweep(this.pivot, _right, this.shoulder, ball);
    _shoulder.copy(this.pivot).addScaledVector(_right, Math.max(0, side - 0.02));
    _look.negate();
    const back = this.sweep(_shoulder, _look, this.boom, ball);
    _look.negate();
    const wanted = Math.max(MIN_ARM, back < this.boom ? back - 0.03 : this.boom);
    if (this.snapNext || wanted < this.arm) this.arm = wanted;
    else this.arm += (wanted - this.arm) * (1 - Math.exp(-4 * dt));

    camera.position.copy(_shoulder).addScaledVector(_look, -this.arm);
    if (camera.position.y < MIN_CAMERA_Y) camera.position.y = MIN_CAMERA_Y;
    _euler.set(this.pitch, this.yaw, 0);
    camera.quaternion.setFromEuler(_euler);

    // hide our own character when the camera is inside its head (very tight spots)
    t.avatar.root.visible = camera.position.distanceToSquared(this.pivot) > 0.3 * 0.3;
    this.snapNext = false;
  }

  /** Distance a sphere can travel from `from` along unit `dir` before touching the world. */
  private sweep(from: THREE.Vector3, dir: THREE.Vector3, max: number, ball: InstanceType<typeof RAPIER.Ball>): number {
    if (max <= 1e-3) return 0;
    this.rOrigin.x = from.x; this.rOrigin.y = from.y; this.rOrigin.z = from.z;
    this.rDir.x = dir.x; this.rDir.y = dir.y; this.rDir.z = dir.z;
    const hit = this.ctx.physics.world.castShape(
      this.rOrigin, IDENTITY, this.rDir, ball, 0, max, false,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, QUERY_WORLD_ONLY,
    );
    return hit ? Math.min(max, hit.time_of_impact) : max;
  }

  private ball(radius: number) {
    let b = this.balls.get(radius);
    if (!b) { b = new RAPIER.Ball(radius); this.balls.set(radius, b); }
    return b;
  }

  private readSensitivity() {
    try {
      const v = parseFloat(localStorage.getItem(SENS_KEY) ?? '');
      this.sensitivity = Number.isFinite(v) && v > 0 ? THREE.MathUtils.clamp(v, 0.1, 5) : 1;
    } catch {
      this.sensitivity = 1;
    }
  }
}
