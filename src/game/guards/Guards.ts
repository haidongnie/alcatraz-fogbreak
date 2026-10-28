// Guards: the cellhouse officers, the west gun-gallery officer and the outdoor patrols (layout GUARDS).
// Host (ctx.net.isHost()): simulates every guard (GuardBrain) and runs perception at ~10 Hz -
//   vision cone + LOS rays (eye -> chest, then head), crouch/lighting/own-flashlight factors, hearing
//   with concertina masking, searchlight spotting - and reports catches and alarms through GuardHooks.
//   snapshot() publishes GuardNet[] (active guards only, stable `i`).
// Everyone: renders guards (GuardView): the host from its live brains, clients from ctx.actors().g
//   interpolated ~200 ms in the past. exposure(p) is the flashlight term of the stealth light model.
// Host migration: a client that becomes host continues from the last replicated guard states.
import * as THREE from 'three/webgpu';
import { TUNING } from '../../config';
import { GUARDS, GUN_GALLERIES, zoneAt, type GuardDef } from '../../world/layout';
import type { Ctx, LightingApi } from '../context';
import type { ActorsNet, GuardMode, GuardNet, Phase, V3, WorldState, ZoneId } from '../types';
import { EYE_HEIGHT, HIDDEN_ZONES, OUTDOOR_ZONES, aimToward, idleAim, wrapAngle, type Aim } from './common';
import { GuardBrain, type BrainEnv } from './GuardBrain';
import { GuardView, type GuardViewState } from './GuardView';
import { NavGraph } from './nav';
import { buildRoute } from './routes';
import { WorldQueries } from './queries';

export interface GuardHooks {
  /** host only: a guard reached a player */
  onCatch(pid: string, guardIndex: number): void;
  /** host only: a player was spotted by a searchlight / gun-gallery officer (raises the alarm) */
  onSpotted(kind: 'searchlight' | 'guard', pid: string): void;
}

/** A free player as the guards perceive them this tick. */
interface Candidate {
  pid: string;
  feet: THREE.Vector3;
  chest: THREE.Vector3;
  head: THREE.Vector3;
  zone: ZoneId;
  /** in a zone guards ignore (own cell, utility corridor, workshop) */
  hidden: boolean;
  outdoor: boolean;
  crouch: boolean;
  noise: number;
  exposure: number;
}

const PERCEPTION_DT = 0.1;
/** clients render guards this far behind the host clock (snapshots arrive at 10 Hz) */
const INTERP_DELAY = 0.2;
const OWN_TORCH_MUL = 1.6;
/** vertical extent of the vision cone (rad, + = up): floor/outdoor officers, gallery looks down */
const FLOOR_PITCH: [number, number] = [-0.95, 0.85];
const GALLERY_PITCH: [number, number] = [-1.3, 0.35];
const SEARCHLIGHT_EXPOSURE = 0.85;
const SEARCHLIGHT_SECONDS = 1.2;
const COOLDOWN = { searchlight: 15, guard: 20 };
/** minimum seconds between two whistles of the same officer */
const WHISTLE_GAP = 6;

export class Guards {
  private readonly q: WorldQueries;
  private readonly nav = new NavGraph();
  private readonly brains: GuardBrain[];
  private readonly views: GuardView[];
  private readonly states: GuardViewState[];
  private readonly aims: Aim[];
  private readonly env: BrainEnv;
  /** gun-gallery cage box [x0, z0, x1, z1] around a guard's beat (LOS rays start outside it) */
  private readonly cages: ([number, number, number, number] | null)[];
  private readonly cands: Candidate[] = [];
  private nCands = 0;
  /** seconds each player has been standing in a searchlight beam */
  private readonly litTime = new Map<string, number>();
  private readonly seen = new Uint8Array(GUARDS.length);
  private readonly prevModes: GuardMode[] = GUARDS.map((): GuardMode => 'patrol');
  private readonly whistleUntil = new Float64Array(GUARDS.length);
  private wasHost = false;
  private lastPhase: Phase | null = null;
  private countStarted = false;
  private perceiveAcc = 0;
  private searchCooldownUntil = -Infinity;
  private guardCooldownUntil = -Infinity;
  private dispatchUntil = -Infinity;
  private lastActors: ActorsNet | null = null;
  private readonly tmp = new THREE.Vector3();
  private readonly noiseAt = new THREE.Vector3();

  constructor(readonly ctx: Ctx, readonly hooks: GuardHooks) {
    this.q = new WorldQueries(ctx);
    this.brains = GUARDS.map((def, i) => new GuardBrain(i, def, buildRoute(def, ctx.terrain)));
    this.views = GUARDS.map((def, i) => new GuardView(ctx, i, def));
    this.states = GUARDS.map((): GuardViewState => ({
      visible: false, x: 0, y: 0, z: 0, ry: 0, anim: 'idle', mode: 'patrol', s: 0, target: '', flash: false, speed: 0,
    }));
    this.aims = GUARDS.map((): Aim => ({ yaw: 0, pitch: 0.25 }));
    this.cages = GUARDS.map((def) => {
      if (def.area !== 'gallery') return null;
      const [x, , z] = def.route[0];
      for (const g of [GUN_GALLERIES.west, GUN_GALLERIES.east]) {
        const [x0, z0, x1, z1] = g.box;
        if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return g.box;
      }
      return null;
    });
    this.env = {
      q: this.q,
      nav: this.nav,
      terrain: ctx.terrain,
      time: () => this.ctx.time(),
      alarm: () => this.ctx.world()?.alarm ?? 0,
      playerPos: (pid, out) => this.playerPos(pid, out),
      caught: (pid, b) => this.hooks.onCatch(pid, b.index),
      spotted: (pid, b) => this.onGuardSpotted(pid, b),
    };
  }

  /** host: simulate AI; everyone: render from host state / ctx.actors() */
  update(dt: number) {
    const host = this.ctx.net.isHost();
    if (host) {
      if (!this.wasHost) this.adoptFromActors();
      this.simulate(dt);
    } else {
      this.ingestActors();
    }
    this.wasHost = host;
    this.render(dt, host);
  }

  /** host: current guard states for publishing */
  snapshot(): GuardNet[] {
    const out: GuardNet[] = [];
    for (const b of this.brains) {
      if (!b.active) continue;
      const watching = b.mode === 'chase' || b.mode === 'suspicious';
      out.push({
        i: b.index,
        p: [round(b.pos.x, 100), round(b.pos.y, 100), round(b.pos.z, 100)],
        ry: round(b.ry, 1000),
        a: b.anim,
        m: b.mode,
        s: round(b.s, 100),
        t: watching ? b.target : '',
        f: b.def.flashlight ? 1 : 0,
      });
    }
    return out;
  }

  /** host: a noise was made at p with radius r */
  hearNoise(p: V3, r: number) {
    if (!this.ctx.net.isHost()) return;
    const w = this.ctx.world();
    if (!w || w.phase !== 'playing') return;
    const at = this.noiseAt.set(p[0], p[1], p[2]);
    const zone = zoneAt(at.x, at.y, at.z);
    if ((zone === 'cell' || zone === 'utility') && this.concertinaNear(w, at)) r *= TUNING.noise.concertinaMask;
    const r2 = r * r;
    for (const b of this.brains) if (b.active && b.pos.distanceToSquared(at) <= r2) b.hear(at, this.env);
  }

  /** 0..0.8 how lit a point is by guard flashlights (cone, distance falloff, occlusion) */
  exposure(p: THREE.Vector3) {
    let best = 0;
    for (const v of this.views) {
      const e = v.lightAt(p);
      if (e > best && this.q.lineClear(v.torchPos.x, v.torchPos.y, v.torchPos.z, p.x, p.y, p.z, 0.3)) best = e;
    }
    return best;
  }

  dispose() {
    for (const v of this.views) v.dispose();
  }

  // ----------------------------------------------------------------------------------------------
  // Host simulation
  // ----------------------------------------------------------------------------------------------
  private simulate(dt: number) {
    const w = this.ctx.world();
    if (!w) { for (const b of this.brains) b.active = false; return; }

    // a new night starts or the game ended: everybody forgets and walks back to the beat
    if (this.lastPhase !== null && (w.phase === 'playing') !== (this.lastPhase === 'playing')) {
      for (const b of this.brains) b.calm();
      this.litTime.clear();
    }
    this.lastPhase = w.phase;

    // extra patrols come on duty as the alarm rises (and go off duty again after a restart)
    for (const b of this.brains) {
      const onDuty = w.alarm >= b.def.minAlarm;
      if (onDuty && !b.active) b.spawn();
      else if (!onDuty && b.active) b.active = false;
    }

    // counts: the counting officer walks the B-Block flats once per count
    const countOpen = w.flags.countOpen === 1;
    if (!countOpen) this.countStarted = false;
    for (const b of this.brains) {
      b.countOpen = countOpen;
      if (countOpen && !this.countStarted && b.def.counts && b.active && w.phase === 'playing') {
        b.startCount();
        this.countStarted = b.mode === 'count'; // busy chasing: retry next frame
      }
    }

    if (w.phase === 'playing') {
      this.perceiveAcc += dt;
      if (this.perceiveAcc >= PERCEPTION_DT) {
        this.perceive(this.perceiveAcc, w);
        this.perceiveAcc = 0;
      }
    }
    for (const b of this.brains) b.update(dt, this.env);

    // an officer starting a chase blows his whistle (everyone hears it: host -> all fx)
    const now = this.ctx.time();
    for (const b of this.brains) {
      if (b.active && b.mode === 'chase' && this.prevModes[b.index] !== 'chase' && w.phase === 'playing' && now >= this.whistleUntil[b.index]) {
        this.whistleUntil[b.index] = now + WHISTLE_GAP;
        this.ctx.net.fx({ k: 'sfx', id: 'whistle', p: [b.pos.x, b.pos.y + 1.6, b.pos.z] });
      }
      this.prevModes[b.index] = b.mode;
    }
  }

  /** Becoming host (fresh game or migration): continue from the replicated guard states. */
  private adoptFromActors() {
    const a = this.ctx.actors();
    for (const b of this.brains) b.active = false;
    if (a) for (const g of a.g) this.brains[g.i]?.adopt(g);
    const w = this.ctx.world();
    this.lastPhase = w?.phase ?? null;
    this.countStarted = w?.flags.countOpen === 1; // a count already under way stays with the old host's walk
    this.perceiveAcc = 0;
  }

  private perceive(dt: number, w: WorldState) {
    const now = this.ctx.time();
    this.gather(w);
    const n = this.nCands;

    // --- sight -----------------------------------------------------------------------------------
    for (const b of this.brains) {
      if (!b.active) continue;
      let best: Candidate | null = null, bestRate = 0;
      for (let k = 0; k < n; k++) {
        const c = this.cands[k];
        if (c.hidden) continue;
        let rate = this.sightRate(b, c);
        if (rate > 0 && c.pid === b.target) rate *= 1.25; // attention stays on whoever they already watch
        if (rate > bestRate) { bestRate = rate; best = c; }
      }
      b.perceive(best ? best.pid : null, best ? best.feet : null, bestRate, dt, this.env);
    }

    // --- hearing: each player's own noise (movement, work) -------------------------------------
    for (let k = 0; k < n; k++) {
      const c = this.cands[k];
      let noise = c.noise;
      if (noise < 0.02 || (c.zone === 'cell' && noise < 0.5)) continue; // pacing in one's own cell is normal
      if ((c.zone === 'cell' || c.zone === 'utility') && this.concertinaNear(w, c.feet)) noise *= TUNING.noise.concertinaMask;
      const r = noise * TUNING.guard.hearing;
      for (const b of this.brains) if (b.active && b.pos.distanceToSquared(c.feet) <= r * r) b.hear(c.feet, this.env);
    }

    // --- searchlights: standing in a beam outdoors for a moment raises the alarm ----------------
    for (let k = 0; k < n; k++) {
      const c = this.cands[k];
      let lit = this.litTime.get(c.pid) ?? 0;
      lit = c.outdoor && c.exposure >= SEARCHLIGHT_EXPOSURE ? lit + dt : Math.max(0, lit - dt);
      if (lit >= SEARCHLIGHT_SECONDS && now >= this.searchCooldownUntil) {
        lit = 0;
        this.searchCooldownUntil = now + COOLDOWN.searchlight;
        this.hooks.onSpotted('searchlight', c.pid);
        this.dispatch('outside', c.feet, null);
      }
      this.litTime.set(c.pid, lit);
    }
  }

  /** Free players with a known state, with everything perception needs precomputed once per tick. */
  private gather(w: WorldState) {
    this.nCands = 0;
    const lighting = this.ctx.lighting as LightingApi | null;
    for (const pid in w.players) {
      if (w.players[pid].s !== 'free') continue;
      const ps = this.ctx.net.getPlayerState(pid);
      if (!ps) continue;
      const c = this.cands[this.nCands] ?? (this.cands[this.nCands] = newCandidate());
      this.nCands++;
      c.pid = pid;
      const me = pid === this.ctx.myId ? this.ctx.player : null;
      if (me) { c.feet.copy(me.position); c.crouch = me.crouching; }
      else { c.feet.set(ps.p[0], ps.p[1], ps.p[2]); c.crouch = ps.cr === 1; }
      c.zone = zoneAt(c.feet.x, c.feet.y, c.feet.z);
      c.hidden = HIDDEN_ZONES.has(c.zone);
      c.outdoor = OUTDOOR_ZONES.has(c.zone);
      c.chest.set(c.feet.x, c.feet.y + (c.crouch ? 0.72 : 1.25), c.feet.z);
      c.head.set(c.feet.x, c.feet.y + (c.crouch ? 1.05 : 1.62), c.feet.z);
      c.noise = ps.n;
      c.exposure = c.hidden || !lighting ? 0 : lighting.exposure(c.chest);
    }
  }

  /** Suspicion per second this guard gains from seeing candidate c (0 = not seen). */
  private sightRate(b: GuardBrain, c: Candidate): number {
    const g = TUNING.guard;
    const ex = b.pos.x, ey = b.pos.y + EYE_HEIGHT, ez = b.pos.z;
    const dx = c.chest.x - ex, dy = c.chest.y - ey, dz = c.chest.z - ez;
    const dist = Math.hypot(dx, dy, dz);
    // how far away the player can be made out: crouching in the dark hides, light gives away
    let f = 1;
    if (c.crouch && c.exposure < 0.3) f = g.crouchDarkMul;
    else if (c.exposure > 0.5) f = g.litMul;
    if (this.views[b.index].lightAt(c.chest) > 0.15) f = Math.max(f, OWN_TORCH_MUL);
    const range = g.range * f;
    if (dist > range) return 0;

    const horiz = Math.hypot(dx, dz);
    const close = horiz < 1.6 && Math.abs(dy) < 1.6; // someone right next to him, even behind
    const off = Math.abs(wrapAngle(Math.atan2(-dx, -dz) - (b.ry + b.aim.yaw)));
    const pitch = Math.atan2(dy, Math.max(horiz, 0.01));
    const [pMin, pMax] = b.isGallery ? GALLERY_PITCH : FLOOR_PITCH;
    const inCone = off <= g.fov / 2 && pitch >= pMin && pitch <= pMax;
    if (!inCone && !close) return 0;
    if (!this.sees(b, ex, ey, ez, c.chest, 0.3) && !this.sees(b, ex, ey, ez, c.head, 0.2)) return 0;

    // fills in ~1 s in plain sight at mid range, faster up close, slowly at the edge of range
    const near = 1 - dist / range;
    let rate = g.suspicionRate * (0.3 + 1.7 * near * near);
    if (!inCone) rate *= 0.5;                       // felt rather than seen
    else if (off > g.fov * 0.3) rate *= 0.65;       // peripheral vision
    if (b.mode === 'suspicious' || b.mode === 'investigate' || b.mode === 'chase') rate *= 1.5; // already on edge
    if (b.isGallery) rate *= 0.7; // looking down through the cage bars, in the dark
    return rate;
  }

  /**
   * Line of sight from the eye to p. The gallery officer's ray starts where it leaves his caged
   * catwalk, whose bars/cage colliders would otherwise block (or enclose) his eye.
   */
  private sees(b: GuardBrain, ex: number, ey: number, ez: number, p: THREE.Vector3, slack: number): boolean {
    const cage = this.cages[b.index];
    if (cage) {
      const dx = p.x - ex, dz = p.z - ez;
      const tx = dx > 1e-6 ? (cage[2] - ex) / dx : dx < -1e-6 ? (cage[0] - ex) / dx : Infinity;
      const tz = dz > 1e-6 ? (cage[3] - ez) / dz : dz < -1e-6 ? (cage[1] - ez) / dz : Infinity;
      const len = Math.hypot(dx, p.y - ey, dz);
      const t = Math.min(tx, tz) + 0.12 / Math.max(len, 1e-3); // a hand's width past the cage face
      if (t >= 1) return true; // target is inside the gallery with him
      if (t > 0) { ex += dx * t; ey += (p.y - ey) * t; ez += dz * t; }
    }
    return this.q.lineClear(ex, ey, ez, p.x, p.y, p.z, slack);
  }

  /** Is a player playing the concertina within range of p ("music hour" covers work noise)? */
  private concertinaNear(w: WorldState, p: THREE.Vector3): boolean {
    const r2 = TUNING.noise.concertinaRange ** 2;
    for (const pid in w.players) {
      if (w.players[pid].s !== 'free') continue;
      const ps = this.ctx.net.getPlayerState(pid);
      if (!ps || ps.m !== 1) continue;
      const dx = ps.p[0] - p.x, dy = ps.p[1] - p.y, dz = ps.p[2] - p.z;
      if (dx * dx + dy * dy + dz * dz <= r2) return true;
    }
    return false;
  }

  /** A guard sees a player he cannot reach (gallery officer, upper tiers, roof): alarm + tip-off. */
  private onGuardSpotted(pid: string, b: GuardBrain) {
    const now = this.ctx.time();
    if (now >= this.guardCooldownUntil) {
      this.guardCooldownUntil = now + COOLDOWN.guard;
      this.hooks.onSpotted('guard', pid);
    }
    if (now >= this.dispatchUntil) {
      this.dispatchUntil = now + 2.5;
      this.dispatch(b.isOutdoor ? 'outside' : 'cellhouse', b.lastSeen, b);
    }
  }

  /** Sends the nearest available guard of an area to investigate p. */
  private dispatch(area: GuardDef['area'], p: THREE.Vector3, except: GuardBrain | null) {
    let best: GuardBrain | null = null, bd = Infinity;
    for (const b of this.brains) {
      if (!b.active || b === except || b.def.area !== area || b.mode === 'chase') continue;
      const d = b.pos.distanceToSquared(p);
      if (d < bd) { bd = d; best = b; }
    }
    best?.investigateAt(p, this.env, true);
  }

  private playerPos(pid: string, out: THREE.Vector3): boolean {
    const w = this.ctx.world();
    if (!w || w.players[pid]?.s !== 'free') return false;
    if (pid === this.ctx.myId && this.ctx.player) { out.copy(this.ctx.player.position); return true; }
    const ps = this.ctx.net.getPlayerState(pid);
    if (!ps) return false;
    out.set(ps.p[0], ps.p[1], ps.p[2]);
    return true;
  }

  // ----------------------------------------------------------------------------------------------
  // Rendering (host and clients)
  // ----------------------------------------------------------------------------------------------
  private ingestActors() {
    const a = this.ctx.actors();
    if (!a || a === this.lastActors) return;
    this.lastActors = a;
    this.seen.fill(0);
    for (const g of a.g) {
      const v = this.views[g.i];
      if (!v) continue;
      this.seen[g.i] = 1;
      v.push(a.t, g);
    }
    for (let i = 0; i < this.views.length; i++) if (!this.seen[i]) this.views[i].netActive = false;
  }

  private render(dt: number, host: boolean) {
    const t = this.ctx.time();
    const hasWorld = this.ctx.world() !== null;
    for (let i = 0; i < this.views.length; i++) {
      const v = this.views[i], st = this.states[i], aim = this.aims[i];
      if (host) {
        const b = this.brains[i];
        st.visible = b.active && hasWorld;
        if (st.visible) {
          st.x = b.pos.x; st.y = b.pos.y; st.z = b.pos.z; st.ry = b.ry;
          st.anim = b.anim; st.mode = b.mode; st.s = b.s; st.target = b.target;
          st.flash = b.def.flashlight; st.speed = b.speed;
          aim.yaw = b.aim.yaw; aim.pitch = b.aim.pitch;
        }
      } else {
        st.visible = v.sample(t - INTERP_DELAY, st);
        if (st.visible) {
          st.anim = v.net.a; st.mode = v.net.m; st.s = v.net.s; st.target = v.net.t;
          st.flash = v.net.f === 1; st.speed = -1;
          this.clientAim(st, t, i, aim);
        }
      }
      if (st.visible) v.render(dt, st, aim, t);
      else v.hide();
    }
  }

  /** Clients don't receive the torch aim: point it at the watched player, else the shared idle sweep. */
  private clientAim(st: GuardViewState, t: number, index: number, aim: Aim) {
    if ((st.mode === 'suspicious' || st.mode === 'chase') && st.target && this.targetPos(st.target, this.tmp)) {
      aimToward(st.x, st.y + EYE_HEIGHT, st.z, st.ry, this.tmp.x, this.tmp.y + 0.9, this.tmp.z, aim);
    } else {
      idleAim(st.mode, st.anim, st.ry, t, index, aim);
    }
  }

  private targetPos(pid: string, out: THREE.Vector3): boolean {
    const av = this.ctx.avatars.get(pid);
    if (av) { av.root.getWorldPosition(out); return true; }
    const ps = this.ctx.net.getPlayerState(pid);
    if (!ps) return false;
    out.set(ps.p[0], ps.p[1], ps.p[2]);
    return true;
  }
}

function newCandidate(): Candidate {
  return {
    pid: '', feet: new THREE.Vector3(), chest: new THREE.Vector3(), head: new THREE.Vector3(),
    zone: 'outside', hidden: false, outdoor: false, crouch: false, noise: 0, exposure: 0,
  };
}

function round(v: number, k: number) { return Math.round(v * k) / k; }
