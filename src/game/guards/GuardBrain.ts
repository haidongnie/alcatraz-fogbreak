// Host-side brain of one guard. Moves along the patrol route, paths through the cellhouse with the
// nav graph (A*) when the straight line is blocked, follows the terrain outdoors, and runs the mode
// machine:
//   patrol -> suspicious -> chase -> (catch) -> return -> patrol
//                        \-> investigate (noise, lost sight, tip-off) -> return
//   count: the counting officer walks the B-Block Michigan Avenue cell fronts, then returns.
// What the guard sees/hears is evaluated by Guards (~10 Hz) and fed in via perceive()/hear();
// this class reacts and moves every frame. No allocations after construction.
import * as THREE from 'three/webgpu';
import { TUNING } from '../../config';
import { FLOOR, PLAYER_CELLS, zoneAt, type GuardDef } from '../../world/layout';
import type { TerrainApi } from '../context';
import type { GuardAnim, GuardMode, GuardNet } from '../types';
import { EYE_HEIGHT, aimToward, approachAngle, clamp, idleAim, wrapAngle, type Aim } from './common';
import type { NavGraph } from './nav';
import type { WorldQueries } from './queries';

/** What a brain needs from the outside world (implemented by Guards). */
export interface BrainEnv {
  readonly q: WorldQueries;
  readonly nav: NavGraph;
  readonly terrain: TerrainApi;
  time(): number;
  /** alarm level 0..3 (guards walk more briskly when the island is on alert) */
  alarm(): number;
  /** latest feet position of a free player; false when unknown or no longer free */
  playerPos(pid: string, out: THREE.Vector3): boolean;
  /** this guard reached the player it was chasing */
  caught(pid: string, guard: GuardBrain): void;
  /** this guard has a player in full view but cannot get to them (gallery, upper tiers, roof...) */
  spotted(pid: string, guard: GuardBrain): void;
}

const ARRIVE = 0.3;          // final arrival radius (m)
const ARRIVE_NODE = 0.75;    // pass-through radius for intermediate nav nodes
const LEASH = 45;            // outdoor guards never go further than this from their beat (m)
const SWEEP_Y = 1.0;         // height of the walkability sweep above the feet
const COUNT_Z = -10.1;       // walking line along the Michigan Avenue cell fronts of B-Block
const COUNT_X0 = -24;        // west / east ends of the count walk (nav nodes mi_w / mi_e)
const COUNT_X1 = 26.5;
const CREW_CELL_X = PLAYER_CELLS.map((c) => c.center[0]).sort((a, b) => a - b);

export class GuardBrain {
  readonly pos = new THREE.Vector3();
  ry = 0;
  mode: GuardMode = 'patrol';
  anim: GuardAnim = 'idle';
  /** suspicion 0..1 */
  s = 0;
  /** player being watched / chased, or '' */
  target = '';
  active = false;
  /** horizontal speed this frame (animation hint) */
  speed = 0;
  /** head/torch direction relative to the body: perception cone centre and flashlight aim */
  readonly aim: Aim = { yaw: 0, pitch: 0.25 };
  /** world point the guard deliberately looks at (when hasLookAt) */
  readonly lookAt = new THREE.Vector3();
  hasLookAt = false;
  /** seconds since the target was last seen */
  seenAgo = 99;
  readonly lastSeen = new THREE.Vector3();
  /** set by Guards from world.flags.countOpen */
  countOpen = false;

  readonly isGallery: boolean;
  readonly isOutdoor: boolean;
  readonly isCellhouse: boolean;
  /** standing height for flat areas (cellhouse floor, gallery catwalk) */
  private readonly baseY: number;

  private wp = 0;
  private pauseT = 0;
  private readonly goal = new THREE.Vector3();
  private hasGoal = false;
  private readonly path = new Int16Array(48);
  private pathLen = 0;
  private pathIdx = 0;
  private endAtGoal = true;
  /** single L-shaped detour point used instead of a nav path when it suffices */
  private readonly corner = new THREE.Vector3();
  private viaCorner = false;
  /** outdoors: off the trusted route, so probe for obstacles and water */
  private offRoute = false;
  private blockedT = 0;
  /** one-shot animation (alert, grab) holding the guard in place */
  private lockT = 0;
  private repathT = 0;
  private readonly inv = new THREE.Vector3();   // where to walk to investigate
  private readonly look = new THREE.Vector3();  // what to look at there
  private invPhase: 0 | 1 = 0;                  // 0 = walking there, 1 = looking around
  private invT = 0;
  private countPhase: 0 | 1 = 0;
  private countDir = -1;
  private countNext = -1;
  private needsSnap = true;
  private readonly tmp = new THREE.Vector3();
  private readonly nodes = new Int16Array(4);

  constructor(readonly index: number, readonly def: GuardDef, readonly route: THREE.Vector3[]) {
    this.isGallery = def.area === 'gallery';
    this.isOutdoor = def.area === 'outside';
    this.isCellhouse = def.area === 'cellhouse';
    this.baseY = this.isGallery ? route[0].y : FLOOR;
  }

  // ----------------------------------------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------------------------------------
  /** Appear at the start of the route (alarm reached minAlarm, or a fresh host). */
  spawn() {
    const r0 = this.route[0], r1 = this.route[1 % this.route.length];
    this.pos.copy(r0);
    this.ry = Math.atan2(-(r1.x - r0.x), -(r1.z - r0.z));
    this.wp = 1 % this.route.length;
    this.resetMind();
    this.mode = 'patrol';
    this.active = true;
    // Reinforcements walk in from an entry point rather than materialising on their beat
    // (which may be right next to the player who just raised the alarm).
    const e = this.def.entry;
    if (e) {
      this.pos.set(e[0], e[1], e[2]);
      this.ry = Math.atan2(-(r0.x - e[0]), -(r0.z - e[2]));
      this.mode = 'return';
    }
  }

  /** Continue from a replicated state (host migration). */
  adopt(g: GuardNet) {
    this.pos.set(g.p[0], g.p[1], g.p[2]);
    this.ry = g.ry;
    this.resetMind();
    this.mode = 'return';
    this.active = true;
  }

  /** Forget everything and walk back to the beat (new night, game over). */
  calm() {
    if (!this.active) return;
    this.resetMind();
    this.mode = 'return';
  }

  private resetMind() {
    this.s = 0;
    this.target = '';
    this.hasGoal = false;
    this.pathLen = this.pathIdx = 0;
    this.viaCorner = false;
    this.pauseT = this.lockT = this.blockedT = 0;
    this.hasLookAt = false;
    this.seenAgo = 99;
    this.offRoute = false;
    this.needsSnap = true;
    this.speed = 0;
  }

  // ----------------------------------------------------------------------------------------------
  // Perception input (called by Guards at ~10 Hz)
  // ----------------------------------------------------------------------------------------------
  /** `pid`/`feet` = the most visible player this tick (null when nobody is seen); `rate` = suspicion/s. */
  perceive(pid: string | null, feet: THREE.Vector3 | null, rate: number, dt: number, env: BrainEnv) {
    if (!this.active) return;
    if (pid && feet) {
      this.target = pid;
      this.lastSeen.copy(feet);
      this.seenAgo = 0;
      this.s = Math.min(1, this.s + rate * dt);
      switch (this.mode) {
        case 'patrol': case 'return': case 'count': case 'investigate':
          if (this.s >= 0.25) this.becomeSuspicious();
          break;
        case 'suspicious':
          if (this.s >= 1) this.fullAlert(env);
          break;
        case 'chase':
          // they climbed somewhere we cannot follow: blow the whistle instead
          if (!this.reachable(feet, env)) { env.spotted(pid, this); this.mode = 'suspicious'; this.hasGoal = false; }
          break;
      }
    } else {
      this.seenAgo += dt;
      // while still staring at the spot, doubt fades slowly; once he gives up looking it fades normally
      const staring = this.mode === 'suspicious' && this.seenAgo < 1.5;
      if (this.mode !== 'chase') this.s = Math.max(0, this.s - TUNING.guard.suspicionDecay * (staring ? 0.3 : 1) * dt);
      if (this.mode === 'suspicious') {
        if (this.seenAgo > 1.2 && this.s > 0.2) this.investigateAt(this.lastSeen, env, false);
        else if (this.s <= 0.01) this.startReturn();
      }
    }
  }

  /** A noise at p reached this guard. */
  hear(p: THREE.Vector3, env: BrainEnv) {
    if (!this.active || this.mode === 'chase') return;
    if (this.mode === 'suspicious' && this.seenAgo < 1.5) return; // busy watching someone
    this.investigateAt(p, env, true);
  }

  /** Go and have a look at p (noise, last sighting, tip-off from another officer). */
  investigateAt(p: THREE.Vector3, env: BrainEnv, startle: boolean) {
    if (!this.active || this.mode === 'chase') return;
    if (this.mode === 'investigate' && this.look.distanceToSquared(p) < 4) {
      // same spot again (continuous noise): keep looking a little longer
      if (this.invPhase === 1) this.invT = Math.max(this.invT, 3);
      return;
    }
    this.look.copy(p);
    this.resolveDestination(p, env, this.inv);
    this.mode = 'investigate';
    this.invPhase = 0;
    this.invT = 5;
    this.hasGoal = false;
    if (startle) { this.lockT = 0.6; this.anim = 'alert'; }
  }

  /** The counting officer: start walking the flats (world.flags.countOpen rose). */
  startCount() {
    if (!this.active || this.mode === 'chase' || this.mode === 'suspicious') return;
    // enter Michigan Avenue at the nearer end and walk to the other one
    const fromWest = Math.abs(this.pos.x - COUNT_X0) < Math.abs(this.pos.x - COUNT_X1);
    this.countDir = fromWest ? 1 : -1;
    this.inv.set(fromWest ? COUNT_X0 : COUNT_X1, FLOOR, COUNT_Z);
    this.countPhase = 0;
    this.countNext = this.countDir > 0 ? 0 : CREW_CELL_X.length - 1;
    this.mode = 'count';
    this.hasGoal = false;
    this.hasLookAt = false;
    this.pauseT = 0;
  }

  // ----------------------------------------------------------------------------------------------
  // Per-frame simulation
  // ----------------------------------------------------------------------------------------------
  update(dt: number, env: BrainEnv) {
    if (!this.active) return;
    this.speed = 0;
    if (this.lockT > 0) this.lockT -= dt;
    switch (this.mode) {
      case 'patrol': this.patrol(dt, env); break;
      case 'suspicious': this.suspicious(dt); break;
      case 'investigate': this.investigate(dt, env); break;
      case 'chase': this.chase(dt, env); break;
      case 'return': this.returning(dt, env); break;
      case 'count': this.count(dt, env); break;
    }
    // head / torch direction (perception cone centre)
    if (this.hasLookAt) aimToward(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z, this.ry, this.lookAt.x, this.lookAt.y + 0.9, this.lookAt.z, this.aim);
    else idleAim(this.mode, this.anim, this.ry, env.time(), this.index, this.aim);
    // outdoors: follow the ground (terrain, roads, piers) whenever we moved
    if (this.isOutdoor && (this.speed > 0 || this.needsSnap)) {
      const g = env.terrain.groundAt(this.pos.x, this.pos.y + (this.needsSnap ? 3 : 0.8), this.pos.z);
      // a ray miss falls back to the heightmap, which may be above the probe (we sank into a slope): fine
      if (Number.isFinite(g) && Math.abs(g - this.pos.y) < 8) {
        this.pos.y = this.needsSnap ? g : this.pos.y + (g - this.pos.y) * Math.min(1, dt * 12);
      }
      this.needsSnap = false;
    }
  }

  private pace(env: BrainEnv) { return TUNING.guard.walkSpeed * (this.isGallery ? 0.8 : 1) * (1 + 0.1 * env.alarm()); }

  private patrol(dt: number, env: BrainEnv) {
    this.hasLookAt = false;
    if (this.pauseT > 0) {
      this.pauseT -= dt;
      this.anim = (this.wp + this.index) % 2 ? 'patrol_look' : 'idle';
      if (this.isGallery) this.turnToward(-Math.PI / 2, 1.5, dt); // face the hall from the catwalk
      return;
    }
    if (!this.hasGoal) { this.offRoute = false; this.setGoal(this.route[this.wp], env); }
    const arrived = this.travel(this.pace(env), dt, env);
    this.anim = this.speed > 0.2 ? 'walk' : 'idle';
    if (arrived) {
      this.pauseT = this.def.pause;
      this.wp = (this.wp + 1) % this.route.length;
      this.hasGoal = false;
    }
  }

  private suspicious(dt: number) {
    this.hasLookAt = true;
    this.lookAt.copy(this.lastSeen);
    this.turnToward(this.yawTo(this.lastSeen), 4, dt);
    this.anim = this.lockT > 0 || !this.def.flashlight ? 'alert' : 'torch_look';
  }

  private investigate(dt: number, env: BrainEnv) {
    this.lookAt.copy(this.look);
    if (this.lockT > 0) {
      this.hasLookAt = true;
      this.turnToward(this.yawTo(this.look), 4, dt);
      return;
    }
    if (this.invPhase === 0) {
      this.hasLookAt = true;
      if (this.isGallery) { this.invPhase = 1; this.invT = 5; return; }
      if (!this.hasGoal) { this.offRoute = true; this.setGoal(this.inv, env); }
      const arrived = this.travel(this.pace(env) * 1.2, dt, env);
      this.anim = this.speed > 0.2 ? 'walk' : 'idle';
      if (arrived || this.blockedT > 1.0) { this.invPhase = 1; this.invT = 5; this.blockedT = 0; }
    } else {
      // first stare at the spot, then look around (idle aim sweep)
      this.hasLookAt = this.invT > 3.2;
      if (this.hasLookAt) this.turnToward(this.yawTo(this.look), 3, dt);
      this.anim = this.def.flashlight ? 'torch_look' : 'patrol_look';
      this.invT -= dt;
      if (this.invT <= 0) this.startReturn();
    }
  }

  private chase(dt: number, env: BrainEnv) {
    if (this.lockT > 0) {
      // whistle wind-up or the grab itself
      this.hasLookAt = true;
      this.lookAt.copy(this.lastSeen);
      this.turnToward(this.yawTo(this.lastSeen), 6, dt);
      return;
    }
    if (this.anim === 'grab') { this.startReturn(); return; }
    const tracking = this.seenAgo < 1.0 && env.playerPos(this.target, this.tmp);
    const goal = tracking ? this.tmp : this.lastSeen;
    this.repathT -= dt;
    if (!this.hasGoal || (this.repathT <= 0 && goal.distanceToSquared(this.goal) > 0.8)) {
      this.offRoute = true;
      this.setGoal(goal, env);
      this.repathT = 0.45;
    }
    this.hasLookAt = true;
    this.lookAt.copy(goal);
    const arrived = this.travel(TUNING.guard.runSpeed, dt, env);
    this.anim = this.speed > 0.5 ? 'run' : 'alert';
    if (tracking) {
      const dx = this.tmp.x - this.pos.x, dz = this.tmp.z - this.pos.z, dy = this.tmp.y - this.pos.y;
      const reach = TUNING.guard.catchDistance + 0.25; // positions arrive with network latency
      if (dx * dx + dz * dz < reach * reach && Math.abs(dy) < 1.4) {
        env.caught(this.target, this);
        this.anim = 'grab';
        this.lockT = 1.4;
        this.s = 0.5;
        this.hasGoal = false;
        return;
      }
    } else if (arrived || this.seenAgo > 6) {
      this.searchHere();
      return;
    }
    if (this.blockedT > 1.2 || (this.isOutdoor && this.routeDistance(this.pos.x, this.pos.z) > LEASH)) this.searchHere();
  }

  private returning(dt: number, env: BrainEnv) {
    this.hasLookAt = false;
    if (!this.hasGoal) {
      this.offRoute = false; // the way back is the way we came: no obstacle probing
      this.wp = this.nearestWaypoint();
      this.setGoal(this.route[this.wp], env);
    }
    const arrived = this.travel(this.pace(env), dt, env);
    this.anim = this.speed > 0.2 ? 'walk' : 'idle';
    if (arrived) {
      this.mode = 'patrol';
      this.pauseT = 0.8;
      this.wp = (this.wp + 1) % this.route.length;
      this.hasGoal = false;
    }
  }

  private count(dt: number, env: BrainEnv) {
    this.hasLookAt = false;
    if (this.countPhase === 0) {
      if (!this.countOpen) { this.startReturn(); return; } // count closed before we got there
      if (!this.hasGoal) { this.offRoute = false; this.setGoal(this.inv, env); }
      const arrived = this.travel(this.pace(env), dt, env);
      this.anim = this.speed > 0.2 ? 'walk' : 'idle';
      if (arrived) {
        this.countPhase = 1;
        this.tmp.set(this.countDir > 0 ? COUNT_X1 : COUNT_X0, FLOOR, COUNT_Z);
        this.setGoal(this.tmp, env);
      }
      return;
    }
    if (this.pauseT > 0) {
      // stop in front of a crew cell and shine the torch through the bars
      this.pauseT -= dt;
      this.anim = 'torch_look';
      this.turnToward(Math.PI, 3, dt);
      return;
    }
    const arrived = this.travel(this.pace(env) * 0.85, dt, env);
    this.anim = this.speed > 0.2 ? 'walk' : 'idle';
    const k = this.countNext;
    if (k >= 0 && k < CREW_CELL_X.length && (this.pos.x - CREW_CELL_X[k]) * this.countDir >= 0) {
      this.pauseT = 1.5;
      this.countNext += this.countDir;
    }
    if (arrived) this.startReturn();
  }

  private becomeSuspicious() {
    this.mode = 'suspicious';
    this.lockT = 0.5;
    this.hasGoal = false;
  }

  private fullAlert(env: BrainEnv) {
    if (this.isGallery || !this.reachable(this.lastSeen, env)) {
      env.spotted(this.target, this); // keeps watching ("!") while the alarm is raised
      return;
    }
    this.mode = 'chase';
    this.anim = 'alert';
    this.lockT = 0.45;
    this.hasGoal = false;
    this.repathT = 0;
  }

  /** Lost the target: look around where we are, then go back. */
  private searchHere() {
    this.mode = 'investigate';
    this.look.copy(this.lastSeen);
    this.inv.copy(this.pos);
    this.invPhase = 1;
    this.invT = 5;
    this.hasGoal = false;
  }

  private startReturn() {
    this.mode = 'return';
    this.hasGoal = false;
    this.hasLookAt = false;
    this.offRoute = false;
    this.pathLen = this.pathIdx = 0;
    this.viaCorner = false;
    this.blockedT = 0;
  }

  // ----------------------------------------------------------------------------------------------
  // Reachability and destinations
  // ----------------------------------------------------------------------------------------------
  /** Can this guard walk to p? */
  reachable(p: THREE.Vector3, env: BrainEnv): boolean {
    if (this.isGallery) return false;
    const z = zoneAt(p.x, p.y, p.z);
    if (this.isCellhouse) return z === 'floor' && Math.abs(p.y - FLOOR) < 1.2;
    if (z !== 'outside' && z !== 'shore') return false;
    if (env.terrain.heightAt(p.x, p.z) < 0.3) return false;
    return this.routeDistance(p.x, p.z) < LEASH;
  }

  /** Where to walk to investigate p: p itself, or the nearest reachable spot facing it. */
  private resolveDestination(p: THREE.Vector3, env: BrainEnv, out: THREE.Vector3) {
    if (this.isGallery) { out.copy(this.pos); return; }
    if (this.reachable(p, env)) { out.copy(p); return; }
    if (this.isCellhouse) { env.nav.closestOnEdges(p.x, p.z, out); return; } // the aisle in front of it
    this.closestOnRoute(p.x, p.z, out); // outdoors: walk the beat to the nearest point and shine over
  }

  private routeDistance(x: number, z: number): number {
    this.closestOnRoute(x, z, this.tmp);
    return Math.hypot(this.tmp.x - x, this.tmp.z - z);
  }

  private closestOnRoute(x: number, z: number, out: THREE.Vector3) {
    let best = Infinity;
    const n = this.route.length;
    for (let i = 0; i < n; i++) {
      const a = this.route[i], b = this.route[(i + 1) % n];
      const vx = b.x - a.x, vz = b.z - a.z;
      const l2 = vx * vx + vz * vz;
      const t = l2 > 0 ? clamp(((x - a.x) * vx + (z - a.z) * vz) / l2, 0, 1) : 0;
      const px = a.x + vx * t, pz = a.z + vz * t;
      const d = (px - x) ** 2 + (pz - z) ** 2;
      if (d < best) { best = d; out.set(px, a.y + (b.y - a.y) * t, pz); }
    }
  }

  private nearestWaypoint(): number {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.route.length; i++) {
      const d = (this.route[i].x - this.pos.x) ** 2 + (this.route[i].z - this.pos.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // ----------------------------------------------------------------------------------------------
  // Locomotion
  // ----------------------------------------------------------------------------------------------
  /** Straight line if walkable, else one corner (the hall is axis-aligned), else A* over the nav graph. */
  private setGoal(p: THREE.Vector3, env: BrainEnv) {
    this.goal.copy(p);
    this.hasGoal = true;
    this.pathLen = this.pathIdx = 0;
    this.viaCorner = false;
    this.endAtGoal = true;
    this.blockedT = 0;
    if (!this.isCellhouse || this.walkable(env, this.pos.x, this.pos.z, p.x, p.z)) return;
    for (let k = 0; k < 2; k++) {
      const cx = k === 0 ? this.pos.x : p.x, cz = k === 0 ? p.z : this.pos.z;
      if (this.walkable(env, this.pos.x, this.pos.z, cx, cz) && this.walkable(env, cx, cz, p.x, p.z)) {
        this.corner.set(cx, this.baseY, cz);
        this.viaCorner = true;
        return;
      }
    }
    const nav = env.nav;
    const start = this.pickNode(env, this.pos.x, this.pos.z);
    const end = this.pickNode(env, p.x, p.z);
    if (start < 0 || end < 0) return;
    this.pathLen = nav.find(start, end, this.path);
    if (this.pathLen === 0) return; // disconnected: try the straight line
    this.endAtGoal = this.walkable(env, nav.x[end], nav.z[end], p.x, p.z);
    // don't walk back to the first node when the second is already in clear view
    if (this.pathLen >= 2) {
      const n1 = this.path[1];
      if (this.walkable(env, this.pos.x, this.pos.z, nav.x[n1], nav.z[n1])) this.pathIdx = 1;
    }
  }

  /** Nearest nav node that can be walked to from (x, z) in a straight line (falls back to the nearest). */
  private pickNode(env: BrainEnv, x: number, z: number): number {
    const nav = env.nav;
    const k = nav.nearest(x, z, this.nodes.length, this.nodes);
    for (let i = 0; i < k; i++) {
      const n = this.nodes[i];
      if (this.walkable(env, x, z, nav.x[n], nav.z[n])) return n;
    }
    return k > 0 ? this.nodes[0] : -1;
  }

  private walkable(env: BrainEnv, ax: number, az: number, bx: number, bz: number) {
    const y = this.baseY + SWEEP_Y;
    return env.q.sweepClear(ax, y, az, bx, y, bz, 0.25);
  }

  /** Follows the current path / goal. Returns true on arrival at the goal (or the last reachable node). */
  private travel(speed: number, dt: number, env: BrainEnv): boolean {
    if (this.viaCorner) {
      if (this.stepToward(this.corner.x, this.corner.z, speed, ARRIVE_NODE, dt, env)) this.viaCorner = false;
      return false;
    }
    if (this.pathIdx < this.pathLen) {
      const nav = env.nav;
      const n = this.path[this.pathIdx];
      const final = this.pathIdx === this.pathLen - 1 && !this.endAtGoal;
      if (!this.stepToward(nav.x[n], nav.z[n], speed, final ? ARRIVE : ARRIVE_NODE, dt, env)) return false;
      this.pathIdx++;
      if (final) return true;
      // string pulling: once the goal is in clear view, walk straight to it
      if (this.endAtGoal && this.pathIdx < this.pathLen && this.walkable(env, this.pos.x, this.pos.z, this.goal.x, this.goal.z)) {
        this.pathIdx = this.pathLen;
      }
      return false;
    }
    return this.stepToward(this.goal.x, this.goal.z, speed, ARRIVE, dt, env);
  }

  /** One frame of walking toward (tx, tz). Returns true once within `radius`. */
  private stepToward(tx: number, tz: number, speed: number, radius: number, dt: number, env: BrainEnv): boolean {
    if (!this.isOutdoor) this.pos.y = this.baseY;
    const dx = tx - this.pos.x, dz = tz - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d <= radius) return true;
    const want = Math.atan2(-dx, -dz);
    const diff = wrapAngle(want - this.ry);
    this.ry = approachAngle(this.ry, want, (speed > 3 ? 9 : 3.4) * dt);
    // turn on the spot when facing away; ease in as the heading lines up
    const align = clamp((Math.cos(diff) - 0.3) / 0.7, 0, 1);
    const stepLen = Math.min(d, speed * align * dt);
    if (stepLen <= 0) return false;
    const ux = dx / d, uz = dz / d;
    if (this.offRoute && this.isOutdoor && !this.canStep(ux, uz, env)) {
      this.blockedT += dt;
      return false;
    }
    this.blockedT = Math.max(0, this.blockedT - dt * 0.5);
    this.pos.x += ux * stepLen;
    this.pos.z += uz * stepLen;
    this.speed = stepLen / dt;
    return false;
  }

  /** Outdoors off-route: no wall/fence ahead, no cliff, no water. */
  private canStep(ux: number, uz: number, env: BrainEnv): boolean {
    const p = this.pos, ahead = 0.7;
    const nx = p.x + ux * ahead, nz = p.z + uz * ahead;
    if (!env.q.lineClear(p.x, p.y + 0.55, p.z, nx, p.y + 0.55, nz, 0)) return false;
    const g = env.terrain.groundAt(nx, p.y + 0.9, nz);
    return g > 0.35 && Math.abs(g - p.y) < 0.85;
  }

  private yawTo(p: THREE.Vector3) { return Math.atan2(-(p.x - this.pos.x), -(p.z - this.pos.z)); }

  private turnToward(yaw: number, rate: number, dt: number) { this.ry = approachAngle(this.ry, yaw, rate * dt); }
}
