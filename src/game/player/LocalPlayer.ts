// The local player: input -> Rapier kinematic capsule + character controller -> animation, zone,
// noise and the 12 Hz network snapshot.
//
// Frame flow (main.ts): preUpdate (read + latch input) -> fixedUpdate per physics step (movement)
// -> update (interpolated transform, facing, animation, zone, noise, avatar).
// Movement states:
//   walk      controller-driven; includes swimming (feet below the water line: buoyancy instead of
//             gravity), crouching, carrying, working (stand still), playing the concertina (sit)
//   climb     scripted along a ClimbDef: mount -> W/S up/down -> exit at either end
//   traverse  squeeze/vault from a to b behind a screen fade (bus 'fade')
//   seated    glued to a raft seat anchor; WASD becomes paddle input (`rw`)
// `frozen` (menus, phase changes) drops input in any state; mode reports 'frozen' while walking.
// The capsule's centre is interpolated by Physics.track so rendering is smooth at any refresh.
import * as THREE from 'three/webgpu';
import { TUNING } from '../../config';
import { RAPIER } from '../../core/physics';
import { CHARACTER_IDS, type CharacterId, type ItemId, type PlayerNet, type PrisonerAnim, type V3, type ZoneId } from '../types';
import { GROUP, groups, QUERY_WORLD_ONLY, type Ctx, type PlayerApi } from '../context';
import { CELL, PLAYER_CELLS, dirToYaw, zoneAt, type ClimbDef, type TraverseDef } from '../../world/layout';
import { Avatar } from './Avatar';
import type { CameraRig, RigTarget } from './CameraRig';

const P = TUNING.player;
const N = TUNING.noise;
/** capsule centre above the feet */
const HALF = P.height / 2;
const CAPSULE_HALF = HALF - P.radius;
const GRAVITY = 9.81;
const GROUND_ACCEL = 14;   // 1/s, exponential approach to the wanted velocity
const AIR_ACCEL = 2.5;
const TURN_RATE = 11;      // rad/s
/** water: feet below this are "in the water" (sea level is y = 0) */
const WATER_LINE = 0.2;
/** swimming feet height: the swim clip lies flat ~0.45 m above its root, head ~0.6 m */
const SWIM_FEET_Y = -0.5;
const SWIM_SPEED = 0.9;
const SWIM_FAST = 1.4;
const WADE_MUL = 0.6;
/** fall speed (m/s) above which landing makes a thud */
const LOUD_LANDING = 6.5;
const SAFETY_Y = -20;
/** climb timings (s) */
const MOUNT_TIME = 0.3;
const EXIT_TIME = 0.45;
const DESCEND_MUL = 1.4;   // sliding down a pipe is quicker than climbing it
/** traverse timeline (s) and the shuffle distance on each side of the opening */
const TRAV_FADE_OUT = 0.35;
const TRAV_BLACK = 0.25;
const TRAV_FADE_IN = 0.45;
const TRAV_SHUFFLE = 0.35;

type State = 'walk' | 'climb' | 'traverse' | 'seated';
type ClimbPhase = 'mount' | 'climb' | 'exit';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _fwd = new THREE.Vector3();

function angleDelta(from: number, to: number) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
const smooth = (t: number) => t * t * (3 - 2 * t);
const r2 = (v: number) => Math.round(v * 100) / 100;

export class LocalPlayer implements PlayerApi, RigTarget {
  /** feet position (interpolated, world) */
  readonly position = new THREE.Vector3();
  ry = 0;
  crouching = false;
  readonly avatar: Avatar;
  /** x = strafe (right +1), z = forward (W = +1), this frame; zero while frozen */
  readonly moveInput = { x: 0, z: 0 };
  /** interactable id currently being held (co-op progress, PlayerNet.h); set by Interaction */
  holding = '';

  private state: State = 'walk';
  private frozen = false;
  private readonly slot: number;

  // physics
  private readonly body: InstanceType<typeof RAPIER.RigidBody>;
  private readonly collider: InstanceType<typeof RAPIER.Collider>;
  private readonly controller: InstanceType<typeof RAPIER.KinematicCharacterController>;
  private readonly capsule: InstanceType<typeof RAPIER.Capsule>;
  /** interpolated capsule centre (filled by Physics.track) */
  private readonly proxy = new THREE.Object3D();
  /** simulated feet position after the latest physics step */
  private readonly feet = new THREE.Vector3();
  /** horizontal velocity (m/s); y unused */
  private readonly vel = new THREE.Vector3();
  private vy = 0;
  private grounded = true;
  private snapping = true;
  private groundSpeed = 0;
  private inWater = false;
  private swimming = false;
  private readonly rDesired = { x: 0, y: 0, z: 0 };
  private readonly rPos = { x: 0, y: 0, z: 0 };
  private readonly rMove = { x: 0, y: 0, z: 0 };
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  // input (latched in preUpdate, consumed in fixed steps)
  private readonly wish = new THREE.Vector3();
  private wantRun = false;
  private jumpQueued = 0;
  private climbInput = 0;
  private carried: ItemId | null = null;
  private targetRy = 0;

  // climb
  private climb: ClimbDef | null = null;
  private climbPhase: ClimbPhase = 'mount';
  private climbT = 0;
  private climbLen = 1;
  private climbVel = 0;
  private phaseT = 0;
  private readonly from = new THREE.Vector3();
  private readonly to = new THREE.Vector3();
  private readonly cBottom = new THREE.Vector3();
  private readonly cTop = new THREE.Vector3();
  private exitTo: 'top' | 'bottom' = 'top';

  // traverse
  private trav: TraverseDef | null = null;
  private travT = 0;
  private travJumped = false;
  private travFadedIn = false;
  private travResolve: (() => void) | null = null;
  private readonly travStart = new THREE.Vector3();
  private readonly travEnd = new THREE.Vector3();
  private readonly travDir = new THREE.Vector3();

  // seated
  private anchor: THREE.Object3D | null = null;
  private readonly seat = new THREE.Vector3();

  // actions
  private working = false;
  private workAnim: PrisonerAnim = 'work';
  private music = false;
  private knocked = false;

  // outputs
  private anim: PrisonerAnim = 'idle';
  private pendingNoise = 0;
  private noiseLevel = 0;
  private currentZone: ZoneId = 'cell';
  private emittedZone: ZoneId | null = null;
  private clock = 0;
  private readonly unsubs: (() => void)[] = [];

  constructor(readonly ctx: Ctx, characterId: CharacterId, readonly rig: CameraRig, spawn: V3, ry: number) {
    this.slot = Math.max(0, CHARACTER_IDS.indexOf(characterId));
    this.avatar = new Avatar(ctx, characterId);
    ctx.avatars.set(ctx.myId, this.avatar);

    const world = ctx.physics.world;
    this.capsule = new RAPIER.Capsule(CAPSULE_HALF, P.radius);
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn[0], spawn[1] + HALF, spawn[2]));
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(CAPSULE_HALF, P.radius).setCollisionGroups(groups(GROUP.PLAYER, GROUP.WORLD | GROUP.DOOR)),
      this.body,
    );
    this.controller = world.createCharacterController(0.02);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.setSlideEnabled(true);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((55 * Math.PI) / 180);
    this.controller.enableAutostep(0.35, 0.18, false);
    this.controller.enableSnapToGround(0.3);
    this.controller.setApplyImpulsesToDynamicBodies(false);
    ctx.physics.track(this.body, this.proxy, { syncRotation: false });

    rig.follow(this);
    this.place(spawn, ry);

    this.unsubs.push(ctx.bus.on('fx', (f) => {
      // tackled by a guard: fall down until main.ts teleports us to the hole
      if (f.k === 'caught' && f.pid === ctx.myId) {
        this.cancelActions();
        this.knocked = true;
      }
    }));
  }

  // ----------------------------------------------------------------------------------------------
  // PlayerApi state
  // ----------------------------------------------------------------------------------------------
  get mode(): PlayerApi['mode'] {
    return this.frozen && this.state === 'walk' ? 'frozen' : this.state;
  }
  /** zone the player is in (client-side estimate, also sent in the snapshot) */
  get zone(): ZoneId { return this.currentZone; }
  /** current self-made noise 0..1 (smoothed; for HUD meters without allocating a snapshot) */
  get noise() { return Math.max(this.noiseLevel, this.pendingNoise); }
  get playingMusic() { return this.music; }
  get isSwimming() { return this.swimming; }
  /** camera pivot height above the feet for the current pose */
  get eyeHeight(): number {
    if (this.state === 'seated') return 0.95;
    if (this.knocked) return 0.7;
    if (this.swimming) return 0.6;
    if (this.music) return 0.9;
    if (this.working && this.workAnim === 'work') return 1.05;
    if (this.crouching) return 1.12;
    return 1.58;
  }

  // ----------------------------------------------------------------------------------------------
  // Frame
  // ----------------------------------------------------------------------------------------------
  /** per frame, before physics: read input */
  preUpdate(dt: number) {
    const inp = this.ctx.input;
    const locked = this.frozen || this.knocked;
    const fwd = locked ? 0 : THREE.MathUtils.clamp(inp.axis('KeyS', 'KeyW') + inp.axis('ArrowDown', 'ArrowUp'), -1, 1);
    const strafe = locked ? 0 : THREE.MathUtils.clamp(inp.axis('KeyA', 'KeyD') + inp.axis('ArrowLeft', 'ArrowRight'), -1, 1);
    this.moveInput.x = strafe;
    this.moveInput.z = fwd;

    // camera-relative wish direction (yaw convention: forward = (-sin, 0, -cos))
    const yaw = this.rig.yaw;
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    this.wish.set(-sy * fwd + cy * strafe, 0, -cy * fwd - sy * strafe);
    if (this.wish.lengthSq() > 1) this.wish.normalize();
    const moving = this.wish.lengthSq() > 0.04;

    this.carried = this.ctx.items?.carried() ?? null;
    this.wantRun = !locked && (inp.isDown('ShiftLeft') || inp.isDown('ShiftRight'));
    this.climbInput = locked ? 0 : fwd !== 0 ? fwd : inp.isDown('Space') ? 1 : 0;
    this.jumpQueued = Math.max(0, this.jumpQueued - dt);

    if (!locked && this.state === 'walk') {
      if (inp.wasPressed('KeyC') || inp.wasPressed('ControlLeft') || inp.wasPressed('ControlRight')) {
        if (!this.swimming && !this.working) this.crouching = !this.crouching;
      }
      if (inp.wasPressed('Space')) {
        if (this.crouching) this.crouching = false; // stand up first
        else this.jumpQueued = 0.15;
      }
      if (inp.wasPressed('KeyQ')) this.toggleMusic();
      if (this.music && moving) this.music = false;
      if (this.crouching && this.wantRun && moving && !this.isHeavy()) this.crouching = false;
    }
  }

  /** per fixed physics step: character controller / scripted motion */
  fixedUpdate(step: number) {
    switch (this.state) {
      case 'climb': this.stepClimb(step); break;
      case 'traverse': this.stepTraverse(step); break;
      case 'seated': this.stepSeated(); break;
      default: this.stepWalk(step);
    }
  }

  /** per frame, after physics: transform, facing, animation, zone, noise */
  update(dt: number) {
    this.clock += dt;
    if (this.state === 'seated') {
      this.seatPosition(this.position);
      if (this.anchor) {
        this.anchor.getWorldQuaternion(_q);
        _fwd.set(0, 0, -1).applyQuaternion(_q);
        this.ry = dirToYaw(_fwd.x, _fwd.z);
      }
    } else {
      this.position.set(this.proxy.position.x, this.proxy.position.y - HALF, this.proxy.position.z);
      // turn toward the move direction (walk) or the scripted facing (climb / traverse)
      if (this.state === 'walk' && !this.working && !this.music && !this.knocked && this.groundSpeed > 0.2 && this.wish.lengthSq() > 0.01) {
        this.targetRy = dirToYaw(this.vel.x, this.vel.z);
      }
      const d = angleDelta(this.ry, this.targetRy);
      const maxTurn = (this.state === 'walk' ? TURN_RATE : TURN_RATE * 1.5) * dt;
      this.ry += THREE.MathUtils.clamp(d, -maxTurn, maxTurn);
      if (this.ry > Math.PI) this.ry -= Math.PI * 2;
      else if (this.ry < -Math.PI) this.ry += Math.PI * 2;
    }

    // zone
    const z: ZoneId = this.state === 'seated' ? 'raft' : this.swimming ? 'water' : zoneAt(this.position.x, this.position.y + 0.1, this.position.z);
    this.currentZone = z;
    if (z !== this.emittedZone) {
      this.emittedZone = z;
      this.ctx.bus.emit('zone', z);
    }
    if (this.music && !this.canPlayMusic()) this.music = false;

    this.updateNoise(dt);
    this.updateAnimation();

    // fell out of the world: back to the own cell
    if (this.position.y < SAFETY_Y) {
      const cell = PLAYER_CELLS[this.mySlot()] ?? PLAYER_CELLS[0];
      this.teleport(cell.spawn, cell.spawnRy);
    }

    const root = this.avatar.root;
    root.position.copy(this.position);
    if (this.swimming) root.position.y += Math.sin(this.clock * 2.1) * 0.03; // gentle bob in the swell
    root.rotation.y = this.ry;
    this.avatar.update(dt);
  }

  // ----------------------------------------------------------------------------------------------
  // PlayerApi actions
  // ----------------------------------------------------------------------------------------------
  teleport(p: V3, ry?: number) {
    this.cancelModes();
    this.knocked = false;
    this.place(p, ry ?? this.ry);
  }

  startClimb(c: ClimbDef, fromTop: boolean) {
    if (this.state !== 'walk' || this.knocked) return;
    this.cancelActions();
    this.crouching = false;
    this.state = 'climb';
    this.climb = c;
    this.cBottom.set(c.bottom[0], c.bottom[1], c.bottom[2]);
    this.cTop.set(c.top[0], c.top[1], c.top[2]);
    this.climbLen = Math.max(0.1, this.cBottom.distanceTo(this.cTop));
    this.climbT = fromTop ? 1 : 0;
    this.climbPhase = 'mount';
    this.phaseT = 0;
    this.climbVel = 0;
    this.from.copy(this.feet);
    this.to.copy(fromTop ? this.cTop : this.cBottom);
    this.targetRy = c.ry;
    this.vel.set(0, 0, 0);
    this.vy = 0;
  }

  startTraverse(t: TraverseDef, fromA: boolean): Promise<void> {
    if (this.state !== 'walk' || this.knocked) return Promise.resolve();
    this.cancelActions();
    this.crouching = false;
    this.state = 'traverse';
    this.trav = t;
    this.travT = 0;
    this.travJumped = false;
    this.travFadedIn = false;
    const a = fromA ? t.a : t.b;
    const b = fromA ? t.b : t.a;
    this.travStart.copy(this.feet);
    this.travEnd.set(b[0], b[1], b[2]);
    this.travDir.set(b[0] - a[0], 0, b[2] - a[2]);
    if (this.travDir.lengthSq() < 1e-4) this.travDir.set(-Math.sin(this.ry), 0, -Math.cos(this.ry));
    this.travDir.normalize();
    this.targetRy = dirToYaw(this.travDir.x, this.travDir.z);
    this.vel.set(0, 0, 0);
    this.vy = 0;
    this.ctx.bus.emit('fade', { to: 1, duration: TRAV_FADE_OUT });
    return new Promise<void>((resolve) => { this.travResolve = resolve; });
  }

  setWorking(on: boolean, anim: PrisonerAnim = 'work') {
    if (!on) { this.working = false; return; }
    if (this.state !== 'walk' || this.knocked) return;
    if (!this.working) { this.vel.set(0, 0, 0); this.music = false; }
    this.working = true;
    this.workAnim = anim;
  }

  addNoise(n: number) {
    if (n > this.pendingNoise) this.pendingNoise = Math.min(1, n);
  }

  setSeated(on: boolean, anchor?: THREE.Object3D) {
    if (on) {
      if (this.state === 'seated' && this.anchor === (anchor ?? null)) return;
      this.cancelModes();
      this.state = 'seated';
      this.anchor = anchor ?? null;
      this.seat.copy(this.feet);
      this.crouching = false;
      this.vel.set(0, 0, 0);
      this.vy = 0;
    } else if (this.state === 'seated') {
      this.seatPosition(_v);
      this.state = 'walk';
      this.anchor = null;
      this.place([_v.x, _v.y + 0.3, _v.z], this.ry, false);
    }
  }

  setFrozen(on: boolean) {
    if (on === this.frozen) return;
    this.frozen = on;
    if (on) {
      this.working = false;
      this.music = false;
      this.jumpQueued = 0;
    }
  }

  setHolding(id: string) { this.holding = id; }

  /** Turn (smoothly) toward a world point, e.g. the vent or door being worked on. */
  face(x: number, z: number) {
    const dx = x - this.position.x, dz = z - this.position.z;
    if (dx * dx + dz * dz > 1e-4) this.targetRy = dirToYaw(dx, dz);
  }

  snapshot(): PlayerNet {
    const s: PlayerNet = {
      p: [r2(this.position.x), r2(this.position.y), r2(this.position.z)],
      ry: Math.round(this.ry * 1000) / 1000,
      a: this.anim,
      n: r2(this.noise),
      cr: this.crouching ? 1 : 0,
      z: this.currentZone,
      h: this.holding,
      m: this.music ? 1 : 0,
    };
    if (this.state === 'seated') {
      // forward -1..1 (W = +1); steer -1..1 with +1 = turn left (yaw grows), matching the raft's
      // `yaw += steer * turnRate`
      s.rw = this.frozen ? [0, 0] : [r2(this.moveInput.z), r2(-this.moveInput.x)];
    }
    return s;
  }

  dispose() {
    for (const u of this.unsubs) u();
    this.travResolve?.();
    this.travResolve = null;
    const world = this.ctx.physics.world;
    this.ctx.physics.untrack(this.body);
    world.removeCharacterController(this.controller);
    world.removeRigidBody(this.body); // removes its collider too
    if (this.ctx.avatars.get(this.ctx.myId) === this.avatar) this.ctx.avatars.delete(this.ctx.myId);
    this.rig.follow(null);
    this.avatar.dispose();
  }

  // ----------------------------------------------------------------------------------------------
  // Fixed-step movement
  // ----------------------------------------------------------------------------------------------
  private stepWalk(step: number) {
    const locked = this.frozen || this.knocked;
    const heavy = this.isHeavy();
    this.inWater = this.feet.y < WATER_LINE;
    this.swimming = this.inWater && (this.feet.y < -0.2 || !this.grounded);
    if (this.swimming) this.crouching = false;

    // wanted horizontal speed
    const running = this.wantRun && !heavy && !this.crouching;
    let speed = this.crouching ? P.crouchSpeed : running ? P.runSpeed : P.walkSpeed;
    if (heavy) speed *= P.carrySpeedMul;
    if (this.swimming) speed = running ? SWIM_FAST : SWIM_SPEED;
    else if (this.inWater) speed *= WADE_MUL;
    if (locked || this.working || this.music) speed = 0;

    const k = 1 - Math.exp(-(this.grounded || this.inWater ? GROUND_ACCEL : AIR_ACCEL) * step);
    this.vel.x += (this.wish.x * speed - this.vel.x) * k;
    this.vel.z += (this.wish.z * speed - this.vel.z) * k;

    // vertical: buoyancy in the water, gravity + jump on land
    if (this.inWater) {
      const want = THREE.MathUtils.clamp((SWIM_FEET_Y - this.feet.y) * 2.5, -1.6, 1.4);
      this.vy += (want - this.vy) * (1 - Math.exp(-5 * step));
      this.jumpQueued = 0;
    } else {
      if (this.grounded && this.vy < 0) this.vy = 0;
      if (this.jumpQueued > 0 && this.grounded && !locked && !heavy && !this.working && !this.music) {
        this.vy = P.jumpSpeed;
        this.jumpQueued = 0;
        if (this.snapping) { this.controller.disableSnapToGround(); this.snapping = false; }
      }
      this.vy -= GRAVITY * step;
    }

    const d = this.rDesired;
    d.x = this.vel.x * step;
    d.y = this.vy * step;
    d.z = this.vel.z * step;
    this.controller.computeColliderMovement(this.collider, d, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, QUERY_WORLD_ONLY);
    const m = this.controller.computedMovement(this.rMove);
    const wasGrounded = this.grounded;
    const fall = this.vy;
    this.grounded = this.controller.computedGrounded();

    if (this.grounded && this.vy <= 0) {
      if (!wasGrounded && fall < -LOUD_LANDING && !this.inWater) this.addNoise(0.55);
      this.vy = 0;
      if (!this.snapping) { this.controller.enableSnapToGround(0.3); this.snapping = true; }
    } else if (this.vy > 0 && m.y < d.y * 0.5) {
      this.vy = 0; // bumped the head
    }

    // `vel` stays the wanted velocity even when blocked: feeding the blocked movement back would
    // starve Rapier's autostep (it needs a sustained push to climb a step). Animation and noise
    // use the movement that actually happened.
    this.groundSpeed = Math.hypot(m.x, m.z) / step;
    this.feet.x += m.x;
    this.feet.y += m.y;
    this.feet.z += m.z;
    this.moveBody();
  }

  private stepClimb(step: number) {
    const c = this.climb;
    if (!c) { this.state = 'walk'; return; }
    if (this.climbPhase === 'mount' || this.climbPhase === 'exit') {
      this.phaseT += step / (this.climbPhase === 'mount' ? MOUNT_TIME : EXIT_TIME);
      const u = smooth(Math.min(1, this.phaseT));
      this.feet.lerpVectors(this.from, this.to, u);
      this.climbVel = this.climbPhase === 'exit' && this.exitTo === 'top' ? P.climbSpeed * 0.5 : 0;
      if (this.phaseT >= 1) {
        if (this.climbPhase === 'mount') {
          this.climbPhase = 'climb';
        } else {
          // off the climb: back to normal movement (gravity settles the last few cm)
          this.state = 'walk';
          this.climb = null;
          this.grounded = false;
          this.vel.set(0, 0, 0);
          this.vy = 0;
        }
      }
    } else {
      let v = this.climbInput * P.climbSpeed;
      if (v < 0) v *= DESCEND_MUL;
      if (this.isHeavy()) v *= P.carrySpeedMul;
      const before = this.climbT;
      this.climbT = THREE.MathUtils.clamp(this.climbT + (v * step) / this.climbLen, 0, 1);
      this.climbVel = ((this.climbT - before) * this.climbLen) / step;
      this.feet.lerpVectors(this.cBottom, this.cTop, this.climbT);
      if (this.climbT >= 1 && this.climbInput > 0) this.beginClimbExit('top', c);
      else if (this.climbT <= 0 && this.climbInput < 0) this.beginClimbExit('bottom', c);
    }
    this.groundSpeed = 0;
    this.moveBody();
  }

  private beginClimbExit(end: 'top' | 'bottom', c: ClimbDef) {
    const e = end === 'top' ? c.exitTop : c.exitBottom;
    this.exitTo = end;
    this.climbPhase = 'exit';
    this.phaseT = 0;
    this.from.copy(this.feet);
    this.to.set(e[0], this.groundNear(e[0], e[1], e[2]), e[2]);
    _v.subVectors(this.to, this.from).setY(0);
    if (_v.lengthSq() > 0.01) this.targetRy = dirToYaw(_v.x, _v.z);
  }

  private stepTraverse(step: number) {
    const t = this.trav;
    if (!t) { this.state = 'walk'; return; }
    this.travT += step;
    const T1 = TRAV_FADE_OUT, T2 = TRAV_FADE_OUT + TRAV_BLACK, T3 = T2 + TRAV_FADE_IN;
    if (this.travT < T1) {
      // shuffle into the opening while the screen goes dark
      const u = smooth(this.travT / T1);
      this.feet.copy(this.travStart).addScaledVector(this.travDir, TRAV_SHUFFLE * u);
    } else if (this.travT < T2) {
      if (!this.travJumped) {
        this.travJumped = true;
        this.travEnd.y = this.groundNear(this.travEnd.x, this.travEnd.y, this.travEnd.z);
        this.feet.copy(this.travEnd).addScaledVector(this.travDir, -TRAV_SHUFFLE);
        this.ctx.physics.untrack(this.body); // no interpolation streak across the jump
        this.body.setTranslation(this.bodyPos(), true);
        this.ctx.physics.track(this.body, this.proxy, { syncRotation: false });
        this.rig.snap();
      }
    } else if (this.travT < T3) {
      if (!this.travFadedIn) {
        this.travFadedIn = true;
        this.ctx.bus.emit('fade', { to: 0, duration: TRAV_FADE_IN });
      }
      const u = smooth((this.travT - T2) / TRAV_FADE_IN);
      this.feet.copy(this.travEnd).addScaledVector(this.travDir, -TRAV_SHUFFLE * (1 - u));
    } else {
      this.feet.copy(this.travEnd);
      this.finishTraverse();
    }
    this.groundSpeed = this.state === 'traverse' ? 1 : 0;
    this.moveBody();
  }

  private finishTraverse() {
    this.state = 'walk';
    this.trav = null;
    this.grounded = false;
    this.vel.set(0, 0, 0);
    this.vy = 0;
    const done = this.travResolve;
    this.travResolve = null;
    done?.();
  }

  private stepSeated() {
    this.seatPosition(this.feet);
    this.groundSpeed = 0;
    this.moveBody();
  }

  // ----------------------------------------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------------------------------------
  private moveBody() {
    this.body.setNextKinematicTranslation(this.bodyPos());
  }

  private bodyPos() {
    const r = this.rPos;
    r.x = this.feet.x; r.y = this.feet.y + HALF; r.z = this.feet.z;
    return r;
  }

  private seatPosition(out: THREE.Vector3) {
    if (this.anchor) this.anchor.getWorldPosition(out);
    else out.copy(this.seat);
  }

  /**
   * Puts the capsule at `p` (nudged to the nearest free spot if it would start inside a prop),
   * resets motion and interpolation, and points the camera behind the player.
   */
  private place(p: V3, ry: number, faceCamera = true) {
    this.findFreeSpot(p, this.feet);
    this.position.copy(this.feet);
    this.vel.set(0, 0, 0);
    this.vy = 0;
    this.grounded = false;
    this.groundSpeed = 0;
    this.ry = this.targetRy = ry;
    this.ctx.physics.untrack(this.body);
    this.body.setTranslation(this.bodyPos(), true);
    this.body.setNextKinematicTranslation(this.bodyPos());
    this.ctx.physics.track(this.body, this.proxy, { syncRotation: false });
    if (faceCamera) this.rig.yaw = ry;
    this.rig.snap();
    this.avatar.root.position.copy(this.feet);
    this.avatar.root.rotation.y = ry;
  }

  /**
   * First spot at/around `p` where the capsule overlaps no world collider: straight above `p`
   * first (floor slabs a few cm higher than the layout), then rings around it (props placed where
   * the layout puts a spawn point). Falls back to `p`.
   */
  private findFreeSpot(p: V3, out: THREE.Vector3) {
    const world = this.ctx.physics.world;
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    const test = { x: 0, y: 0, z: 0 };
    const free = (x: number, y: number, z: number) => {
      test.x = x; test.y = y + HALF; test.z = z;
      let hit = false;
      world.intersectionsWithShape(test, rot, this.capsule, () => { hit = true; return false; },
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, QUERY_WORLD_ONLY);
      return !hit;
    };
    for (const lift of [0.04, 0.15, 0.3]) {
      if (free(p[0], p[1] + lift, p[2])) { out.set(p[0], p[1] + lift, p[2]); return; }
    }
    for (const lift of [0.04, 0.15]) {
      for (const r of [0.12, 0.24, 0.36, 0.5]) {
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          const x = p[0] + Math.cos(a) * r, z = p[2] + Math.sin(a) * r;
          if (free(x, p[1] + lift, z)) { out.set(x, p[1] + lift, z); return; }
        }
      }
    }
    out.set(p[0], p[1] + 0.04, p[2]); // nothing better: trust the layout
  }

  /**
   * Walkable surface between 0.5 m above and 0.7 m below a scripted landing height (layout
   * heights are approximate). A ray that starts inside something is ignored.
   */
  private groundNear(x: number, y: number, z: number): number {
    const ray = this.ray;
    ray.origin.x = x; ray.origin.y = y + 0.5; ray.origin.z = z;
    const hit = this.ctx.physics.world.castRay(ray, 1.2, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, QUERY_WORLD_ONLY);
    return hit && hit.timeOfImpact > 0.05 ? y + 0.5 - hit.timeOfImpact + 0.02 : y;
  }

  /** Ends climb / traverse / seat (teleports, getting caught). */
  private cancelModes() {
    this.cancelActions();
    if (this.state === 'traverse') {
      if (!this.travFadedIn) this.ctx.bus.emit('fade', { to: 0, duration: 0.3 }); // never leave the screen black
      this.trav = null;
      const done = this.travResolve;
      this.travResolve = null;
      done?.();
    }
    this.climb = null;
    this.anchor = null;
    this.state = 'walk';
    this.crouching = false;
  }

  private cancelActions() {
    this.working = false;
    this.music = false;
    this.jumpQueued = 0;
  }

  private isHeavy() { return !!this.carried && this.carried.startsWith('bundle_'); }

  private mySlot() { return this.ctx.world()?.players[this.ctx.myId]?.slot ?? this.slot; }

  private inOwnCell() {
    if (this.currentZone !== 'cell') return false;
    const c = PLAYER_CELLS[this.mySlot()];
    if (!c) return false;
    const half = CELL.width / 2 + 0.05;
    return Math.abs(this.position.x - c.center[0]) <= half && this.position.z >= -9.05 && this.position.z <= -6.2;
  }

  private canPlayMusic() {
    return this.state === 'walk' && !this.swimming && !this.knocked && (this.inOwnCell() || this.carried === 'bundle_concertina');
  }

  /** Q: concertina "music hour" in the own cell (or wherever the concertina bundle is carried). */
  private toggleMusic() {
    if (this.music) { this.music = false; return; }
    if (this.working || !this.canPlayMusic()) return;
    this.music = true;
    this.crouching = false;
    this.vel.set(0, 0, 0);
  }

  private updateNoise(dt: number) {
    let n = 0;
    const movingFast = this.groundSpeed > 0.3;
    if (this.state === 'walk' && movingFast) {
      if (this.swimming) n = N.walk;
      else if (this.crouching) n = N.crouch;
      else n = this.groundSpeed > (P.walkSpeed + P.runSpeed) / 2 ? N.run : N.walk;
    } else if (this.state === 'climb' && Math.abs(this.climbVel) > 0.1) {
      n = N.walk;
    } else if (this.state === 'traverse' && this.trav) {
      n = this.trav.noise;
    }
    n = Math.max(n, this.pendingNoise);
    this.pendingNoise = 0;
    // instant attack, ~0.4 s release so the 12 Hz snapshot and HUD meter do not miss short spikes
    this.noiseLevel = n >= this.noiseLevel ? n : Math.max(n, this.noiseLevel - dt * 2.5);
  }

  private updateAnimation() {
    let a: PrisonerAnim;
    let speed: number | null = null;
    let fade = 0.25;
    if (this.knocked) {
      a = 'knockdown'; fade = 0.15;
    } else if (this.state === 'climb') {
      a = 'climb'; speed = this.climbVel;
    } else if (this.state === 'traverse') {
      a = this.trav && !this.trav.id.startsWith('crawl') ? 'climb' : 'crouch';
      speed = a === 'climb' ? 0.5 : 1.1;
    } else if (this.state === 'seated' || this.music) {
      a = 'sit'; fade = 0.4;
    } else if (this.working) {
      a = this.workAnim; fade = 0.2;
    } else if (this.swimming) {
      a = 'swim'; speed = this.groundSpeed; fade = 0.4;
    } else if (this.crouching) {
      a = 'crouch'; speed = this.groundSpeed;
    } else if (this.groundSpeed > (this.anim === 'idle' ? 0.35 : 0.2)) {
      const run = this.groundSpeed > (P.walkSpeed + P.runSpeed) / 2;
      a = run ? 'run' : 'walk'; speed = this.groundSpeed; fade = 0.2;
    } else {
      a = 'idle'; fade = 0.3;
    }
    this.anim = a;
    this.avatar.speed = speed;
    this.avatar.play(a, fade);
  }
}
