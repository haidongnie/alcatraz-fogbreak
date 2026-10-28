// The escape raft. Appears at LAUNCH.raftSpawn once all the raft gear lies at the launch site:
// a flattened raincoat raft that rises as it is inflated (world.raft.inflate), then floats and
// bobs. The host launches it when an aboard player paddles and integrates it from the crew's
// paddling input (PlayerNet.rw), the ebb current and soft collisions with the island shore;
// clients interpolate the published pose (ActorsNet.r). Seats up to four: the local player is
// seated through PlayerApi.setSeated, remote crew avatars are pinned to their seats. A paddle
// strokes beside each crew member while they paddle; splashes and a wake foam on the water.
import * as THREE from 'three/webgpu';
import { TUNING } from '../../config';
import { RAPIER } from '../../core/physics';
import { t } from '../../i18n';
import { EBB_CURRENT, LAUNCH } from '../../world/layout';
import { GROUP, groups, type Ctx, type PlayerApi } from '../context';
import type { V3, WorldState } from '../types';
import { WorldCache, gearAtLaunch } from '../interact/gear';
import { Splashes } from './Splashes';

/** The model is 2.6 m long; the real raft was about 4.3 x 1.8 m: stretch it along its length. */
const MODEL_STRETCH = 1.35;
/** how deep the floor sits below the surface when afloat */
const DRAFT = 0.07;
/** seat anchors: feet on the floor, facing raft forward (-Z); two rows of two, by slot */
const SEAT_Y = 0.06;
const SEATS: [number, number][] = [[-0.48, -0.62], [0.48, -0.62], [-0.48, 0.6], [0.48, 0.6]];
/** clients render the host pose this far in the past (actors arrive at ~10 Hz) */
const INTERP_DELAY = 0.15;
const MAX_EXTRAPOLATE = 0.35;
const BUFFER = 8;
/** terrain above this height under the hull counts as shore and pushes the raft off */
const SHORE_DEPTH = -0.5;
/** paddle strokes per second at full input */
const STROKE_HZ = 0.85;
const TWO_PI = Math.PI * 2;

interface PaddleRig {
  pivot: THREE.Group;
  /** blade tip (splash point) */
  tip: THREE.Object3D;
  side: 1 | -1;
  phase: number;
  activity: number;
  strokes: number;
}

const _v = new THREE.Vector3();
const _rt = { x: 0, y: 0, z: 0 };
const _rr = { x: 0, y: 0, z: 0, w: 1 };

export class Raft {
  private readonly root = new THREE.Group();   // x, z, yaw
  private readonly float = new THREE.Group();  // bobbing, pitch and roll; carries seats + paddles
  private readonly hull = new THREE.Group();   // inflation (flattened when deflated)
  private readonly seats: THREE.Object3D[] = [];
  private readonly paddles: PaddleRig[] = [];
  private readonly splashes: Splashes;
  private readonly gearReady = new WorldCache<boolean>(gearAtLaunch, false);
  private readonly halfLength: number;
  private readonly halfWidth: number;

  private body: RAPIER.RigidBody | null = null;
  private collider: RAPIER.Collider | null = null;
  private colliderOn = false;

  // host simulation
  private readonly sim = { active: false, x: 0, z: 0, yaw: 0, v: 0, w: 0 };
  private poseOut: [number, number, number, number] | undefined;

  // client interpolation buffer of host poses (host clock, x, z, yaw)
  private readonly bt = new Float64Array(BUFFER);
  private readonly bx = new Float64Array(BUFFER);
  private readonly bz = new Float64Array(BUFFER);
  private readonly byaw = new Float64Array(BUFFER);
  private bn = 0;
  private lastActorsT = -Infinity;

  // render state
  private px = LAUNCH.raftSpawn[0];
  private pz = LAUNCH.raftSpawn[2];
  private pyaw = LAUNCH.raftRy;
  private prevX = this.px;
  private prevZ = this.pz;
  private speed = 0;
  private baseY = 0;
  private inflateShown = 0;
  private lastInflate = 0;
  private pump = 0;
  private visible = false;
  private wasLaunched = false;
  private seatedOn: PlayerApi | null = null;
  private readonly seatPid: string[] = ['', '', '', ''];
  private time = 0;
  private wakeT = 0;
  private bowT = 0;

  constructor(readonly ctx: Ctx) {
    const size = ctx.models.size('raft') ?? [2.6, 0.47, 1.99];
    this.halfLength = (size[0] * MODEL_STRETCH) / 2;
    this.halfWidth = size[2] / 2;

    const model = ctx.models.instance('raft');
    model.scale.set(MODEL_STRETCH, 1, 1);
    model.rotation.y = Math.PI / 2; // model length (+X) -> raft forward (-Z)
    this.hull.add(model);
    this.float.add(this.hull);
    this.root.add(this.float);
    this.root.name = 'raft';

    for (let i = 0; i < SEATS.length; i++) {
      const a = new THREE.Object3D();
      a.name = `raft-seat-${i}`;
      a.position.set(SEATS[i][0], SEAT_Y, SEATS[i][1]);
      this.float.add(a);
      this.seats.push(a);
    }

    // one paddle per seat, outboard, held at the grip; blade end detected from the geometry
    const first = ctx.models.instance('paddle');
    const blade = bladeEnd(first);
    for (let i = 0; i < SEATS.length; i++) {
      const side: 1 | -1 = SEATS[i][0] > 0 ? 1 : -1;
      const pivot = new THREE.Group();
      pivot.name = `raft-paddle-${i}`;
      const m = i === 0 ? first : ctx.models.instance('paddle');
      // shaft along -Y with the blade at the bottom, blade face across the stroke
      m.rotation.set(0, Math.PI / 2, blade > 0 ? -Math.PI / 2 : Math.PI / 2);
      m.position.y = -0.55;
      pivot.add(m);
      const tip = new THREE.Object3D();
      tip.position.y = -1.1;
      pivot.add(tip);
      pivot.position.set(side * (this.halfWidth - 0.05), 0.55, SEATS[i][1] - 0.12);
      pivot.visible = false;
      this.float.add(pivot);
      this.paddles.push({ pivot, tip, side, phase: i * 1.3, activity: 0, strokes: 0 });
    }

    this.root.visible = false;
    ctx.scene.add(this.root);
    this.splashes = new Splashes(ctx.scene, ctx.quality.tier === 'low' ? 32 : 64);

    // Kinematic hull collider so walkers/swimmers bump into the inflated raft. It only collides
    // with the player (not a WORLD member, so camera/LOS/ground queries ignore it).
    try {
      const world = ctx.physics.world;
      this.body = world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.px, 0, this.pz),
      );
      const h = size[1] / 2;
      this.collider = world.createCollider(
        RAPIER.ColliderDesc.cuboid(this.halfWidth, h, this.halfLength)
          .setTranslation(0, h, 0)
          .setCollisionGroups(groups(GROUP.RAFT, GROUP.PLAYER)),
        this.body,
      );
      this.collider.setEnabled(false);
    } catch (err) {
      console.warn('[raft] collider unavailable', err);
      this.body = null;
      this.collider = null;
    }
  }

  // ----------------------------------------------------------------------------------------------
  // Host
  // ----------------------------------------------------------------------------------------------
  /** host: launch + integrate the raft from aboard players' paddling; true if `w` changed */
  hostUpdate(dt: number, w: WorldState): boolean {
    if (!w.raft.launched) {
      this.sim.active = false;
      this.poseOut = undefined;
      if (w.raft.inflate < 1 || !this.anyPaddling(w)) return false;
      this.launch(w);
      return true;
    }
    if (!this.sim.active) this.resumeSim(w);
    this.integrate(dt, w);
    // A fresh tuple every host frame: the session hands it to the network layer, which must never
    // see an array we keep mutating (same reason the world is structuredClone'd before publishing).
    const s = this.sim;
    this.poseOut = [round(s.x, 100), round(s.z, 100), round(s.yaw, 1000), round(this.distFromLaunch(s.x, s.z), 10)];
    return false;
  }

  /** live pose once launched: x, z, yaw, distance from launch (host: simulated; clients: from actors) */
  pose(): [number, number, number, number] | undefined {
    return this.ctx.net.isHost() ? this.poseOut : this.ctx.actors()?.r;
  }

  private anyPaddling(w: WorldState): boolean {
    for (const pid in w.players) {
      if (w.players[pid].s !== 'aboard') continue;
      const rw = this.ctx.net.getPlayerState(pid)?.rw;
      if (rw && rw[0] > 0.1) return true;
    }
    return false;
  }

  private launch(w: WorldState) {
    w.raft.launched = 1;
    // Everyone not aboard stays on the Rock. Players in the hole too: nobody is coming back for
    // them, and an auto-release after the launch must not let a guard raise the alarm to lockdown.
    // (The launch toasts are local, see update(): each client knows whether it is aboard.)
    for (const pid in w.players) {
      const st = w.players[pid];
      if (st.s === 'free' || st.s === 'hole') {
        st.s = 'left_behind';
        delete st.until;
      }
    }
    this.ctx.net.fx({ k: 'sfx', id: 'splash', p: [w.raft.p[0], 0, w.raft.p[2]] as V3 });
    const s = this.sim;
    s.active = true;
    s.x = w.raft.p[0];
    s.z = w.raft.p[2];
    s.yaw = w.raft.ry;
    s.v = 0.4; // the shove off the rocks
    s.w = 0;
    this.poseOut = [round(s.x, 100), round(s.z, 100), round(s.yaw, 1000), round(this.distFromLaunch(s.x, s.z), 10)];
  }

  /** a new host (migration) continues from the last published pose */
  private resumeSim(w: WorldState) {
    const r = this.ctx.actors()?.r;
    const s = this.sim;
    s.active = true;
    s.x = r ? r[0] : w.raft.p[0];
    s.z = r ? r[1] : w.raft.p[2];
    s.yaw = r ? r[2] : w.raft.ry;
    s.v = 0;
    s.w = 0;
  }

  private integrate(dt: number, w: WorldState) {
    let n = 0, fwd = 0, steer = 0;
    for (const pid in w.players) {
      if (w.players[pid].s !== 'aboard') continue;
      const ps = this.ctx.net.getPlayerState(pid);
      if (!ps) continue; // disconnected crew don't paddle
      n++;
      const rw = ps.rw;
      if (rw) {
        fwd += clamp(rw[0], -1, 1);
        steer += clamp(rw[1], -1, 1);
      }
    }
    const R = TUNING.raft;
    let target = 0, turn = 0;
    if (n > 0) {
      target = (R.paddleSpeed + R.extraPaddler * (n - 1)) * (fwd / n);
      if (target < 0) target *= 0.6; // back-paddling is weaker
      // yaw += steer x turnRate: steer +1 turns to port (yaw grows); LocalPlayer publishes D as -1
      turn = (steer / n) * R.turnRate;
    }
    const s = this.sim;
    const accel = Math.abs(target) > Math.abs(s.v) ? 0.9 : 0.45; // speeds up faster than it glides out
    s.v += (target - s.v) * (1 - Math.exp(-dt * accel));
    s.w += (turn - s.w) * (1 - Math.exp(-dt * 2));
    s.yaw = wrapPi(s.yaw + s.w * dt);
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
    s.x += (fx * s.v + EBB_CURRENT[0]) * dt;
    s.z += (fz * s.v + EBB_CURRENT[1]) * dt;
    this.shorePush(dt, fx, fz);
  }

  /** Soft collision with the island: shallow water under bow, middle or stern pushes it seaward. */
  private shorePush(dt: number, fx: number, fz: number) {
    const T = this.ctx.terrain;
    const s = this.sim;
    for (let k = -1; k <= 1; k++) {
      const off = k * (this.halfLength - 0.2);
      const sx = s.x + fx * off, sz = s.z + fz * off;
      const h = T.heightAt(sx, sz);
      if (!(h > SHORE_DEPTH)) continue;
      let gx = T.heightAt(sx + 1, sz) - T.heightAt(sx - 1, sz);
      let gz = T.heightAt(sx, sz + 1) - T.heightAt(sx, sz - 1);
      let len = Math.hypot(gx, gz);
      if (!(len > 1e-3)) {
        // flat shelf: the open water lies seaward of the launch site
        gx = -LAUNCH.seaDir[0];
        gz = -LAUNCH.seaDir[2];
        len = Math.hypot(gx, gz) || 1;
      }
      gx /= len; gz /= len; // uphill
      const push = Math.min(3, 0.6 + (h - SHORE_DEPTH) * 2.5) * dt;
      s.x -= gx * push;
      s.z -= gz * push;
      // scraping: lose the speed that drives the hull up the slope
      if ((fx * gx + fz * gz) * s.v > 0) s.v *= Math.exp(-dt * 3);
    }
  }

  private distFromLaunch(x: number, z: number) {
    return Math.hypot(x - LAUNCH.p[0], z - LAUNCH.p[2]);
  }

  // ----------------------------------------------------------------------------------------------
  // Everyone
  // ----------------------------------------------------------------------------------------------
  /** visuals for everyone; seats the local player when aboard */
  update(dt: number) {
    this.time += dt;
    const w = this.ctx.world();
    if (!w || w.phase === 'briefing') {
      // briefing (also after a restart): no raft, nobody seated, forget the last voyage
      this.sim.active = false;
      this.poseOut = undefined;
      this.bn = 0;
      this.lastActorsT = -Infinity;
      this.inflateShown = this.lastInflate = 0;
      this.wasLaunched = false;
      this.hide();
      this.splashes.update(dt, this.ctx.camera.position);
      return;
    }
    const launched = w.raft.launched === 1;
    if (!(launched || w.raft.inflate > 0 || this.gearReady.get(w))) {
      this.hide();
      this.splashes.update(dt, this.ctx.camera.position);
      return;
    }
    const appeared = !this.visible;
    this.visible = true;
    this.root.visible = true;

    // inflation, smoothed (progress arrives in steps) with a little breathing on every push
    if (w.raft.inflate > this.lastInflate + 1e-4) this.pump = 1;
    this.lastInflate = w.raft.inflate;
    this.pump = Math.max(0, this.pump - dt * 2.5);
    this.inflateShown += (w.raft.inflate - this.inflateShown) * Math.min(1, dt * 3);
    if (Math.abs(w.raft.inflate - this.inflateShown) < 1e-3) this.inflateShown = w.raft.inflate;

    this.resolvePose(w, launched);
    if (appeared) {
      // no velocity spike from wherever the raft was last shown (e.g. the previous voyage)
      this.prevX = this.px;
      this.prevZ = this.pz;
      this.speed = 0;
    }
    const vx = (this.px - this.prevX) / Math.max(dt, 1e-4), vz = (this.pz - this.prevZ) / Math.max(dt, 1e-4);
    this.prevX = this.px;
    this.prevZ = this.pz;
    const fx = -Math.sin(this.pyaw), fz = -Math.cos(this.pyaw);
    const along = vx * fx + vz * fz;
    this.speed += (clamp(along, -4, 4) - this.speed) * Math.min(1, dt * 2);

    this.placeHull();
    this.root.updateMatrixWorld(true);
    this.updateCrew(w, dt);
    this.updateCollider();
    this.updateWater(dt, launched, fx, fz);
    if (launched && !this.wasLaunched && w.phase === 'playing') {
      // the crew is told to paddle, whoever stayed on the Rock that the raft is gone
      const s = w.players[this.ctx.myId]?.s;
      if (s === 'aboard') this.ctx.bus.emit('toast', t('toast.launched'));
      else if (s === 'left_behind') this.ctx.bus.emit('toast', t('toast.leftBehind'));
    }
    this.wasLaunched = launched;
    this.splashes.update(dt, this.ctx.camera.position);
  }

  dispose() {
    this.unseatLocal();
    this.root.removeFromParent();
    this.splashes.dispose();
    if (this.body) this.ctx.physics.world.removeRigidBody(this.body);
    this.body = null;
    this.collider = null;
  }

  private hide() {
    this.unseatLocal();
    if (!this.visible) return;
    this.visible = false;
    this.root.visible = false;
    for (const p of this.paddles) p.pivot.visible = false;
    this.updateCollider();
  }

  private unseatLocal() {
    if (!this.seatedOn) return;
    this.seatedOn.setSeated(false);
    this.seatedOn = null;
  }

  private resolvePose(w: WorldState, launched: boolean) {
    if (!launched) {
      this.px = w.raft.p[0];
      this.pz = w.raft.p[2];
      this.pyaw = w.raft.ry;
      this.bn = 0;
      this.lastActorsT = -Infinity;
      return;
    }
    if (this.ctx.net.isHost() && this.sim.active) {
      this.px = this.sim.x;
      this.pz = this.sim.z;
      this.pyaw = this.sim.yaw;
      return;
    }
    // client (or a host that has not resumed yet): interpolate the published poses
    const a = this.ctx.actors();
    if (a && a.r && a.t > this.lastActorsT) {
      this.pushSample(a.t, a.r[0], a.r[1], a.r[2]);
      this.lastActorsT = a.t;
    }
    if (this.bn === 0) {
      this.px = w.raft.p[0];
      this.pz = w.raft.p[2];
      this.pyaw = w.raft.ry;
      return;
    }
    this.sampleAt(this.ctx.time() - INTERP_DELAY);
  }

  private pushSample(t: number, x: number, z: number, yaw: number) {
    if (this.bn === BUFFER) {
      this.bt.copyWithin(0, 1);
      this.bx.copyWithin(0, 1);
      this.bz.copyWithin(0, 1);
      this.byaw.copyWithin(0, 1);
      this.bn--;
    }
    const i = this.bn++;
    this.bt[i] = t;
    this.bx[i] = x;
    this.bz[i] = z;
    this.byaw[i] = yaw;
  }

  private sampleAt(rt: number) {
    const n = this.bn, t = this.bt;
    let i0: number, i1: number, k: number;
    if (n === 1 || rt <= t[0]) {
      i0 = i1 = rt <= t[0] ? 0 : n - 1;
      k = 0;
    } else if (rt >= t[n - 1]) {
      // past the newest sample: extrapolate a little along the last segment
      i0 = n - 2;
      i1 = n - 1;
      const span = Math.max(1e-3, t[i1] - t[i0]);
      k = 1 + Math.min(rt - t[i1], MAX_EXTRAPOLATE) / span;
    } else {
      let j = n - 2;
      while (j > 0 && t[j] > rt) j--;
      i0 = j;
      i1 = j + 1;
      k = (rt - t[i0]) / Math.max(1e-3, t[i1] - t[i0]);
    }
    this.px = this.bx[i0] + (this.bx[i1] - this.bx[i0]) * k;
    this.pz = this.bz[i0] + (this.bz[i1] - this.bz[i0]) * k;
    this.pyaw = this.byaw[i0] + wrapPi(this.byaw[i1] - this.byaw[i0]) * k;
  }

  /** Pose, floating height, bob and inflation scale of the hull. */
  private placeHull() {
    const infl = this.inflateShown;
    const h = this.ctx.terrain.heightAt(this.px, this.pz);
    let base = -DRAFT * infl;
    const afloat = !(h > base - 0.05);
    if (!afloat) base = h + 0.01; // resting on the beach / rocks
    this.baseY = base;
    const t = this.time;
    const amp = afloat ? 0.012 + 0.028 * infl : 0;
    const rock = afloat ? infl : 0;
    this.root.position.set(this.px, 0, this.pz);
    this.root.rotation.set(0, this.pyaw, 0);
    this.float.position.y = base + Math.sin(t * 1.7) * amp + Math.sin(t * 2.9 + 1.3) * amp * 0.4;
    this.float.rotation.set(
      (Math.sin(t * 1.3) * 0.025 + clamp(this.speed * 0.012, -0.02, 0.035)) * rock, // bow lifts under way
      0,
      Math.sin(t * 1.1 + 0.7) * 0.03 * rock,
    );
    const e = infl * infl * (3 - 2 * infl);
    const breathe = this.pump * 0.05 * (1 - e) * Math.sin(t * 18);
    this.hull.scale.set(0.86 + 0.14 * e, Math.max(0.06, 0.1 + 0.9 * e + breathe), 0.86 + 0.14 * e);
  }

  /** Seats: local player via setSeated, remote avatars pinned; paddles follow the crew's input. */
  private updateCrew(w: WorldState, dt: number) {
    const seatPid = this.seatPid;
    for (let i = 0; i < seatPid.length; i++) seatPid[i] = '';
    for (const pid in w.players) {
      const st = w.players[pid];
      if (st.s === 'aboard' || st.s === 'escaped') seatPid[st.slot & 3] = pid;
    }

    // local player
    const mine = w.players[this.ctx.myId];
    const pl = this.ctx.player;
    const wantSeat = !!mine && !!pl && (mine.s === 'aboard' || mine.s === 'escaped') && this.inflateShown > 0.5;
    if (wantSeat && this.seatedOn !== pl) {
      this.unseatLocal();
      pl!.setSeated(true, this.seats[mine!.slot & 3]);
      this.seatedOn = pl;
    } else if (!wantSeat) {
      this.unseatLocal();
    }

    for (let i = 0; i < seatPid.length; i++) {
      const pid = seatPid[i];
      const rig = this.paddles[i];
      if (!pid || this.inflateShown < 0.5) {
        rig.pivot.visible = false;
        rig.activity = 0;
        continue;
      }
      // Remote crew: RemotePlayers updates before the raft every frame; pin the avatar to its seat
      // so it rides the locally rendered hull instead of lagging behind it by the network delay.
      if (pid !== this.ctx.myId) {
        const av = this.ctx.avatars.get(pid);
        if (av) this.pin(av.root, this.seats[i]);
      }
      const rw = this.ctx.net.getPlayerState(pid)?.rw;
      this.stroke(rig, rw ? clamp(rw[0], -1, 1) : 0, dt, w.phase === 'playing');
    }
  }

  private pin(obj: THREE.Object3D, anchor: THREE.Object3D) {
    anchor.getWorldPosition(_v);
    if (obj.parent && obj.parent !== this.ctx.scene) obj.parent.worldToLocal(_v);
    obj.position.copy(_v);
    obj.rotation.set(0, this.pyaw, 0);
  }

  /** Paddle pose for one seat: resting across the tube, or a catch-pull-recover stroke cycle. */
  private stroke(rig: PaddleRig, fwd: number, dt: number, playing: boolean) {
    rig.pivot.visible = true;
    const paddling = playing && Math.abs(fwd) > 0.1;
    rig.activity += ((paddling ? 1 : 0) - rig.activity) * Math.min(1, dt * 3);
    if (paddling) rig.phase += dt * TWO_PI * STROKE_HZ * (0.6 + 0.4 * Math.abs(fwd)) * Math.sign(fwd);
    const a = rig.activity;
    const c = Math.cos(rig.phase), s = Math.sin(rig.phase);
    const lift = Math.max(0, -s) * 0.22; // blade out of the water on the recovery
    const pitch = -1.45 + (0.55 * c + 1.45) * a; // rest: shaft laid back across the tube
    const lean = (0.6 - 0.2 * a + lift * 0.4) * rig.side;
    rig.pivot.rotation.set(pitch, 0, lean);
    rig.pivot.position.y = 0.5 + (0.12 + lift) * a;
    // blade entry (the catch, phase = 0 mod 2pi): a splash where the blade bites
    const strokes = Math.floor(rig.phase / TWO_PI);
    if (strokes !== rig.strokes) {
      rig.strokes = strokes;
      if (a > 0.6 && this.inflateShown > 0.9) {
        rig.tip.getWorldPosition(_v);
        if (this.ctx.terrain.heightAt(_v.x, _v.z) < -0.2) {
          this.splashes.spawn(_v.x, _v.z, 0.2, 1.0, 1.3, 0.55);
          this.splashes.spawn(_v.x + this.splashes.jitter() * 0.15, _v.z + this.splashes.jitter() * 0.15, 0.1, 0.45, 0.7, 0.4);
        }
      }
    }
  }

  private updateCollider() {
    const col = this.collider, body = this.body;
    if (!col || !body) return;
    const want = this.visible && this.inflateShown > 0.95 && !this.seatedOn;
    _rt.x = this.px;
    _rt.y = this.baseY;
    _rt.z = this.pz;
    _rr.y = Math.sin(this.pyaw / 2);
    _rr.w = Math.cos(this.pyaw / 2);
    if (want !== this.colliderOn) {
      col.setEnabled(want);
      this.colliderOn = want;
      if (want) { body.setTranslation(_rt, true); body.setRotation(_rr, true); }
    }
    if (want) {
      body.setNextKinematicTranslation(_rt);
      body.setNextKinematicRotation(_rr);
    }
  }

  /** wake behind the stern and a ripple at the bow while under way; a burst at the launch */
  private updateWater(dt: number, launched: boolean, fx: number, fz: number) {
    const sp = this.splashes;
    if (this.inflateShown < 0.9 || this.ctx.terrain.heightAt(this.px, this.pz) > -0.2) return;
    const rx = -fz, rz = fx; // starboard
    if (launched && !this.wasLaunched) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TWO_PI;
        sp.spawn(this.px + Math.cos(a) * this.halfWidth * 1.2, this.pz + Math.sin(a) * this.halfLength, 0.4, 1.8, 1.8, 0.5);
      }
    }
    const moving = Math.abs(this.speed);
    if (moving < 0.25) return;
    const stern = this.speed > 0 ? this.halfLength : -this.halfLength;
    this.wakeT -= dt;
    if (this.wakeT <= 0) {
      this.wakeT = 0.14;
      const lat = sp.jitter() * this.halfWidth * 0.8;
      sp.spawn(this.px - fx * stern + rx * lat, this.pz - fz * stern + rz * lat, 0.5, 1.4 + moving * 0.4, 2.4, Math.min(0.35, 0.12 + moving * 0.1));
    }
    this.bowT -= dt;
    if (this.bowT <= 0) {
      this.bowT = 0.35;
      sp.spawn(this.px + fx * stern, this.pz + fz * stern, 0.6, 1.6, 1.2, Math.min(0.3, 0.08 + moving * 0.1));
    }
  }
}

// ------------------------------------------------------------------------------------------------
/** Which end (+1 = +X, -1 = -X) of a model lying along X is wider in Z: a paddle's blade. */
function bladeEnd(obj: THREE.Object3D): 1 | -1 {
  obj.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const rel = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const box = new THREE.Box3().setFromObject(obj);
  const reach = Math.max(box.max.x, -box.min.x) * 0.4;
  let pos = 0, neg = 0;
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const attr = mesh.geometry.getAttribute('position');
    if (!attr) return;
    rel.multiplyMatrices(inv, mesh.matrixWorld);
    const step = Math.max(1, Math.floor(attr.count / 4000));
    for (let i = 0; i < attr.count; i += step) {
      v.fromBufferAttribute(attr, i).applyMatrix4(rel);
      if (v.x > reach) pos = Math.max(pos, Math.abs(v.z));
      else if (v.x < -reach) neg = Math.max(neg, Math.abs(v.z));
    }
  });
  return pos >= neg ? 1 : -1;
}

function clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v; }
function wrapPi(a: number) { return a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI); }
function round(v: number, k: number) { return Math.round(v * k) / k; }
