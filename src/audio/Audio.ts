// Procedural WebAudio soundscape (no audio files):
// - ambience by zone: outdoors wind gusts, surf swells, the two island foghorns, gulls and a bell
//   buoy; indoors mains hum, fluorescent buzz, room tone, steam hiss and distant coughs, snores,
//   drips and clanks, all through a long concrete-hall reverb
// - the local player's footsteps / pipe knocks while climbing / paddle strokes on the raft
// - positional one-shots for `fx` sfx events, work-sound loops for anyone holding an interaction
//   (PlayerNet.h), the officers' whistle when a chase starts, a tension drone with a heartbeat,
//   and the concertina waltz near anyone playing it (PlayerNet.m)
// The master volume comes from ./settings (pause menu).
import * as THREE from 'three/webgpu';
import type { Ctx } from '../game/context';
import type { Fx, SfxId, V3, ZoneId } from '../game/types';
import { zoneAt } from '../world/layout';
import { Concertina } from './concertina';
import { getVolume, onVolumeChange } from './settings';
import * as S from './synth';

type Env = 'indoor' | 'outdoor' | 'aerial';
type Zone = ZoneId | 'aerial';
const INDOOR: ReadonlySet<Zone> = new Set<Zone>(['cell', 'utility', 'workshop', 'floor', 'dblock']);
/** Fog signals at both ends of the island (SE below the parade ground, NW inside the industries fence). */
const FOGHORN_SE: V3 = [238, 4, 8];
const FOGHORN_NW: V3 = [-288, 6, 46];
/** A bell buoy out in the bay, north of the island. */
const BUOY: V3 = [-120, 0, -420];
const MUSIC_RANGE = 30;

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

type Recipe = (k: S.Kit, out: AudioNode, t: number, v: number) => void;
/** range 0 = global (heard everywhere, not positional) */
const SFX: Record<SfxId, { v: number; range: number; play: Recipe }> = {
  grille: { v: 0.9, range: 45, play: S.grille },
  drill: { v: 0.9, range: 70, play: S.drillRev },
  clang: { v: 1, range: 150, play: (k, o, t, v) => S.clang(k, o, t, v, 150, 2.4) },
  door: { v: 0.8, range: 45, play: S.door },
  pickup: { v: 0.6, range: 16, play: S.pickup },
  drop: { v: 0.8, range: 28, play: S.drop },
  whistle: { v: 0.9, range: 140, play: S.whistle },
  alarm_bell: { v: 0.8, range: 0, play: (k, o, t, v) => S.alarmBell(k, o, t, v) },
  foghorn: { v: 0.8, range: 0, play: (k, o, t, v) => S.foghorn(k, o, t, v, true) },
  splash: { v: 0.9, range: 60, play: S.splash },
  fence: { v: 0.8, range: 45, play: S.fence },
  inflate: { v: 0.8, range: 35, play: S.inflate },
  count_bell: { v: 0.8, range: 0, play: S.countBell },
  cell_door: { v: 0.9, range: 70, play: S.cellDoor },
};

export class Audio {
  private ac: AudioContext | null = null;
  private kit!: S.Kit;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private reverbIn!: GainNode;
  private reverbOut!: GainNode;
  private echoIn!: GainNode;
  private echoOut!: GainNode;
  private outBus!: GainNode;
  private outMuffle!: BiquadFilterNode;
  private inBus!: GainNode;
  private wind!: GainNode;
  private windBp!: BiquadFilterNode;
  private howl!: GainNode;
  private howlBp!: BiquadFilterNode;
  private surf!: GainNode;
  private fizz!: GainNode;
  private hiss!: GainNode;
  private room!: GainNode;
  private drill!: GainNode;
  private scrape!: GainNode;
  private scrapeBp!: BiquadFilterNode;
  private bellows!: GainNode;
  private tension!: GainNode;
  private tensionLp!: BiquadFilterNode;
  private music!: GainNode;
  private concertina!: Concertina;

  private unlocked = false;
  private zone: Zone = 'aerial';
  private env: Env = 'aerial';
  private zoneTimer = 0;
  /** listener: player feet (distance) and camera (panning) */
  private readonly lp = new THREE.Vector3();
  private readonly cam = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3(0, 0, -1);
  private readonly last = new THREE.Vector3();
  private hasLast = false;
  private stepAccum = 0;
  private climbAccum = 0;
  private paddleTimer = 0;
  /** audio-clock times of the next ambient events */
  private readonly next = { gust: 0, wave: 0, hornSE: 0, hornNW: 0, gull: 0, buoy: 0, cough: 0, snore: 0, drip: 0, clank: 0, heart: 0 };
  private tick = 0;
  private remoteTimer = 0;
  private remoteIds: string[] = [];
  private readonly guardModes: string[] = [];
  private tensionLevel = 0;
  private tensionWritten = -1;
  private musicOn = false;
  // work-loop accumulators (filled per 10 Hz tick)
  private wDrill = 0;
  private wScrape = 0;
  private wBellows = 0;

  constructor(readonly ctx: Ctx) {
    try {
      this.build();
    } catch (err) {
      console.warn('[audio] WebAudio unavailable', err);
      this.ac = null;
      return;
    }
    ctx.bus.on('fx', (f) => this.onFx(f));
    const resume = () => {
      if (this.ac && this.ac.state !== 'running' && !document.hidden) void this.ac.resume().catch(() => {});
    };
    for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, resume, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (!this.ac) return;
      if (document.hidden) void this.ac.suspend().catch(() => {});
      else if (this.unlocked) resume();
    });
  }

  /** Resume the AudioContext (called right after a user gesture). */
  unlock() {
    this.unlocked = true;
    if (this.ac && this.ac.state !== 'running') void this.ac.resume().catch(() => {});
  }

  // ----------------------------------------------------------------------------------------------
  // Graph
  // ----------------------------------------------------------------------------------------------
  private build() {
    const ac = new AudioContext({ latencyHint: 'interactive' });
    this.ac = ac;
    const k = (this.kit = S.createKit(ac));
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.25;
    comp.connect(ac.destination);
    this.master = S.amp(k, comp, volumeGain(getVolume()));
    onVolumeChange((v) => this.master.gain.setTargetAtTime(volumeGain(v), ac.currentTime, 0.05));
    this.sfxBus = S.amp(k, this.master, 1);

    // concrete-hall reverb (indoors) and a slap-back echo off cliffs and walls (outdoors)
    const conv = ac.createConvolver();
    conv.buffer = S.makeImpulse(ac, 3.4, 5.5, 0.9);
    this.reverbOut = S.amp(k, this.master, 0.12);
    conv.connect(this.reverbOut);
    this.reverbIn = S.amp(k, conv, 1);
    const delay = ac.createDelay(1.5);
    delay.delayTime.value = 0.38;
    delay.connect(S.biquad(k, 'lowpass', 1600, 0.5, S.amp(k, delay, 0.3)));
    this.echoOut = S.amp(k, this.master, 0.25);
    delay.connect(this.echoOut);
    this.echoIn = S.amp(k, delay, 1);

    // outdoor bed: wind (body + whistle), surf (rumble + fizz)
    this.outMuffle = S.biquad(k, 'lowpass', 18000, 0.5, this.master);
    this.outBus = S.amp(k, this.outMuffle, 0.7);
    this.wind = S.amp(k, this.outBus, 0.22);
    this.windBp = S.biquad(k, 'bandpass', 380, 0.6, this.wind);
    this.loopNoise(this.windBp, true);
    this.howl = S.amp(k, this.outBus, 0.015);
    this.howlBp = S.biquad(k, 'bandpass', 1100, 9, this.howl);
    this.loopNoise(this.howlBp, false);
    this.surf = S.amp(k, this.outBus, 0.15);
    this.loopNoise(S.biquad(k, 'lowpass', 520, 0.7, this.surf), true);
    this.fizz = S.amp(k, this.outBus, 0.005);
    this.loopNoise(S.biquad(k, 'bandpass', 3200, 0.5, this.fizz), false);

    // indoor bed: 60 Hz mains hum + harmonics, fluorescent buzz, room tone, steam hiss
    this.inBus = S.amp(k, this.master, 0);
    const hum = S.biquad(k, 'lowpass', 400, 0.7, S.amp(k, this.inBus, 0.05));
    for (const [f, a] of [[60, 0.5], [120, 0.35], [180, 0.15]] as const) this.loopTone('sine', f, S.amp(k, hum, a));
    this.loopTone('sawtooth', 120, S.biquad(k, 'bandpass', 2400, 3, S.amp(k, this.inBus, 0.006)));
    this.room = S.amp(k, this.inBus, 0.12);
    this.loopNoise(S.biquad(k, 'lowpass', 180, 0.7, this.room), true);
    this.hiss = S.amp(k, this.inBus, 0);
    this.loopNoise(S.biquad(k, 'highpass', 4200, 0.7, this.hiss), false);

    // work loops: drill motor, spoon/crowbar scraping, concertina bellows
    const work = S.amp(k, this.sfxBus, 1);
    work.connect(S.amp(k, this.reverbIn, 0.4));
    this.drill = S.amp(k, work, 0);
    const drillBp = S.biquad(k, 'bandpass', 1300, 0.9, this.drill);
    const saw = this.loopTone('sawtooth', 182, drillBp);
    this.loopTone('square', 91, S.amp(k, drillBp, 0.4));
    this.loopTone('sine', 7, S.amp(k, saw.frequency, 9));
    this.loopNoise(S.biquad(k, 'highpass', 3500, 0.7, S.amp(k, this.drill, 0.25)), false);
    this.scrape = S.amp(k, work, 0);
    this.scrapeBp = S.biquad(k, 'bandpass', 1800, 7, this.scrape);
    this.loopNoise(this.scrapeBp, false);
    this.bellows = S.amp(k, work, 0);
    const bellowsAm = S.amp(k, this.bellows, 0.5);
    this.loopTone('sine', 0.75, S.amp(k, bellowsAm.gain, 0.5));
    this.loopNoise(S.biquad(k, 'bandpass', 480, 1.3, bellowsAm), true);

    // tension drone (rises with the alarm level and chases)
    this.tension = S.amp(k, this.master, 0);
    this.tensionLp = S.biquad(k, 'lowpass', 140, 1.2, this.tension);
    this.loopTone('sawtooth', 55, this.tensionLp);
    this.loopTone('sawtooth', 82.6, S.amp(k, this.tensionLp, 0.6));
    this.loopTone('sine', 27.5, S.amp(k, this.tensionLp, 1.2));

    // concertina
    this.music = S.amp(k, this.master, 0);
    this.music.connect(S.amp(k, this.reverbIn, 0.6));
    this.concertina = new Concertina(k);
    this.concertina.out.connect(this.music);

    const now = ac.currentTime;
    const n = this.next;
    n.gust = now + 1; n.wave = now + 0.5; n.hornSE = now + 5; n.hornNW = now + 16; n.gull = now + 4;
    n.buoy = now + 9; n.cough = now + 6; n.snore = now + 14; n.drip = now + 3; n.clank = now + 25; n.heart = now;
  }

  private loopNoise(into: AudioNode, brown: boolean) {
    const ac = this.ac!;
    const s = ac.createBufferSource();
    s.buffer = brown ? this.kit.brown : this.kit.white;
    s.loop = true;
    s.connect(into);
    s.start(0, Math.random() * s.buffer.duration);
    return s;
  }
  private loopTone(type: OscillatorType, f: number, into: AudioNode) {
    const o = this.ac!.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.connect(into);
    o.start();
    return o;
  }

  // ----------------------------------------------------------------------------------------------
  // Per frame
  // ----------------------------------------------------------------------------------------------
  update(dt: number) {
    const ac = this.ac;
    if (!ac) return;
    const ctx = this.ctx;
    this.cam.copy(ctx.camera.position);
    ctx.camera.getWorldDirection(this.fwd);
    if (ctx.player) this.lp.copy(ctx.player.position); else this.lp.copy(this.cam);
    this.tickZone(dt);
    if (ac.state !== 'running') { this.hasLast = false; return; }
    const now = ac.currentTime;

    this.ambience(now);
    this.footsteps(dt, now);
    this.guards(now);

    this.remoteTimer -= dt;
    if (this.remoteTimer <= 0) {
      this.remoteTimer = 0.5;
      this.remoteIds = ctx.net.players().filter((p) => !p.isMe).map((p) => p.id);
    }
    this.tick += dt;
    if (this.tick >= 0.1) {
      this.tick = 0;
      this.workAndMusic(now);
    }
    this.concertina.schedule(now, this.musicOn);
  }

  private tickZone(dt: number) {
    this.zoneTimer -= dt;
    if (this.zoneTimer > 0) return;
    this.zoneTimer = 0.3;
    const p = this.ctx.player;
    const z: Zone = !p ? 'aerial' : p.mode === 'seated' ? 'raft' : zoneAt(p.position.x, p.position.y, p.position.z);
    if (z === this.zone) return;
    this.zone = z;
    this.env = z === 'aerial' ? 'aerial' : INDOOR.has(z) ? 'indoor' : 'outdoor';
    this.applyEnv();
  }

  private applyEnv() {
    const now = this.ac!.currentTime;
    const indoor = this.env === 'indoor';
    const tau = 0.7;
    this.outBus.gain.setTargetAtTime(indoor ? 0.22 : this.env === 'aerial' ? 0.7 : 1, now, tau);
    this.outMuffle.frequency.setTargetAtTime(indoor ? 520 : 18000, now, tau);
    this.inBus.gain.setTargetAtTime(indoor ? 1 : 0, now, tau);
    this.reverbOut.gain.setTargetAtTime(indoor ? 0.5 : 0.1, now, tau);
    this.echoOut.gain.setTargetAtTime(indoor ? 0 : 0.3, now, tau);
    const pipes = this.zone === 'utility' || this.zone === 'workshop';
    this.hiss.gain.setTargetAtTime(pipes ? 0.035 : 0, now, tau);
    this.room.gain.setTargetAtTime(this.zone === 'utility' ? 0.22 : 0.12, now, tau);
  }

  private ambience(now: number) {
    const k = this.kit;
    const n = this.next;
    const indoor = this.env === 'indoor';
    const z = this.zone;

    if (now >= n.gust) {
      const exposed = z === 'roof' ? 1.5 : this.env === 'aerial' ? 1.2 : 1;
      this.wind.gain.setTargetAtTime(rnd(0.12, 0.36) * exposed, now, 1.2);
      this.windBp.frequency.setTargetAtTime(rnd(260, 560), now, 1.5);
      this.howl.gain.setTargetAtTime(rnd(0, 0.03) * exposed * (z === 'roof' ? 2 : 1), now, 1.5);
      this.howlBp.frequency.setTargetAtTime(rnd(800, 1500), now, 2);
      n.gust = now + rnd(1.5, 4);
    }
    if (now >= n.wave) {
      // swells: louder near the waterline, faint from the roof / hilltop
      const near = z === 'shore' || z === 'water' || z === 'raft' ? 1.25 : 1;
      const base = this.env === 'aerial' ? 0.5 : clamp(1.25 - Math.max(0, this.lp.y - 2) / 40, 0.3, 1.3) * near;
      const peak = base * rnd(0.16, 0.32);
      ramp(this.surf.gain, now, peak, 2.2, peak * 0.25, 1.6);
      ramp(this.fizz.gain, now + 0.4, peak * 0.16, 2.2, 0.003, 0.9);
      n.wave = now + rnd(5.5, 9);
    }
    if (now >= n.hornSE) {
      const out = this.emitterFar(FOGHORN_SE, 0.9);
      if (out) S.foghorn(k, out, now, 1, true);
      n.hornSE = now + 30;
    }
    if (now >= n.hornNW) {
      const out = this.emitterFar(FOGHORN_NW, 0.7);
      if (out) S.foghorn(k, out, now, 1, false);
      n.hornNW = now + 20;
    }
    if (now >= n.gull) {
      if (!indoor) S.gull(k, this.randomOut(rnd(0.3, 0.7) * (z === 'roof' || z === 'shore' ? 1.3 : 0.8), 0.3), now, 1);
      n.gull = now + rnd(6, 20);
    }
    if (now >= n.buoy) {
      const out = this.emitterFar(BUOY, 0.35);
      if (out) S.buoyBell(k, out, now, 1);
      n.buoy = now + rnd(9, 20);
    }
    if (!indoor) return;
    // cellhouse at night: 260 sleeping men, dripping pipes, the odd far-off clank
    if (now >= n.cough) { S.cough(k, this.randomOut(rnd(0.05, 0.14), 0.7), now, 1); n.cough = now + rnd(6, 18); }
    if (now >= n.snore) { S.snore(k, this.randomOut(rnd(0.04, 0.1), 0.5), now, 1); n.snore = now + rnd(12, 32); }
    if (now >= n.drip) {
      S.drip(k, this.randomOut(rnd(0.05, 0.12), 0.8), now, 1);
      n.drip = now + (z === 'utility' ? rnd(1.2, 4) : rnd(4, 10));
    }
    if (now >= n.clank) { S.clang(k, this.randomOut(rnd(0.03, 0.07), 0.9), now, 1, rnd(110, 200), 1.6); n.clank = now + rnd(25, 60); }
  }

  private footsteps(dt: number, now: number) {
    const p = this.ctx.player;
    if (!p) { this.hasLast = false; return; }
    const pos = p.position;
    if (!this.hasLast) { this.last.copy(pos); this.hasLast = true; return; }
    const dx = pos.x - this.last.x, dy = pos.y - this.last.y, dz = pos.z - this.last.z;
    this.last.copy(pos);
    const horiz = Math.hypot(dx, dz);
    if (horiz > 3 || Math.abs(dy) > 3) { this.stepAccum = 0; return; } // teleport
    const k = this.kit;
    if (p.mode === 'climb') {
      this.climbAccum += Math.abs(dy);
      if (this.climbAccum > 0.55) { this.climbAccum = 0; S.climbKnock(k, this.localOut(0.3), now, 1); }
      return;
    }
    if (p.mode === 'seated') {
      const mi = p.moveInput;
      this.paddleTimer -= dt;
      if (Math.abs(mi.x) + Math.abs(mi.z) > 0.15 && this.paddleTimer <= 0) {
        this.paddleTimer = rnd(0.9, 1.15);
        S.paddle(k, this.localOut(0.5), now, 1);
      }
      return;
    }
    if (p.mode !== 'walk' || dt <= 0) { this.stepAccum = 0; return; }
    const speed = horiz / dt;
    if (speed < 0.3 || Math.abs(dy) / dt > 3) return; // standing still, jumping or falling
    this.stepAccum += horiz;
    const run = speed > 3.6;
    const stride = p.crouching ? 0.55 : run ? 1.2 : 0.75;
    if (this.stepAccum < stride) return;
    this.stepAccum = 0;
    const v = p.crouching ? 0.08 : run ? 0.4 : 0.22;
    S.footstep(k, this.localOut(v), now, 1, this.surface());
  }

  private surface(): S.Surface {
    switch (this.zone) {
      case 'water': case 'raft': return 'water';
      case 'utility': return 'metal';
      case 'roof': case 'shore': return 'gravel';
      case 'outside': return 'grass';
      default: return 'concrete';
    }
  }

  /** Whistle when an officer starts a chase; tension from the alarm level and who is after me. */
  private guards(now: number) {
    const ctx = this.ctx;
    const w = ctx.world();
    const actors = ctx.actors();
    let chased = false;
    let susp = 0;
    if (actors) {
      for (const g of actors.g) {
        const prev = this.guardModes[g.i];
        if (g.m === 'chase' && prev !== undefined && prev !== 'chase') {
          const out = this.emitter(g.p[0], g.p[1], g.p[2], SFX.whistle.v, SFX.whistle.range);
          if (out) S.whistle(this.kit, out, now, 1);
        }
        this.guardModes[g.i] = g.m;
        if (g.t === ctx.myId) {
          if (g.m === 'chase') chased = true;
          if (g.s > susp) susp = g.s;
        }
      }
    }
    const target = !w || w.phase !== 'playing' ? 0 : chased ? 1 : Math.max((w.alarm / 3) * 0.4, susp * 0.65);
    this.tensionLevel += (target - this.tensionLevel) * 0.03;
    const tl = this.tensionLevel;
    if (Math.abs(tl - this.tensionWritten) > 0.01) {
      // write automation only when the level moved (not every frame)
      this.tensionWritten = tl;
      this.tension.gain.setTargetAtTime(tl * 0.12, now, 0.3);
      this.tensionLp.frequency.setTargetAtTime(120 + tl * 760, now, 0.3);
    }
    if (tl > 0.7 && now >= this.next.heart) {
      S.heartbeat(this.kit, this.globalOut(0.5 * tl), now, 1);
      this.next.heart = now + 60 / (70 + 60 * tl);
    }
  }

  /** 10 Hz: work loops for anyone holding an interaction, and the concertina distance. */
  private workAndMusic(now: number) {
    const ctx = this.ctx;
    this.wDrill = this.wScrape = this.wBellows = 0;
    let musicD = Infinity;
    const me = ctx.player;
    if (me) {
      const s = me.snapshot();
      if (s.h) this.work(s.h, 1, me.position.x, me.position.y, me.position.z, now);
      if (s.m) musicD = 0;
    }
    for (const id of this.remoteIds) {
      const ps = ctx.net.getPlayerState(id);
      if (!ps) continue;
      const dx = ps.p[0] - this.lp.x, dy = ps.p[1] - this.lp.y, dz = ps.p[2] - this.lp.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (ps.h && d < 45) this.work(ps.h, Math.min(1, 4 / Math.max(d, 4)) * (1 - d / 45), ps.p[0], ps.p[1], ps.p[2], now);
      if (ps.m && d < musicD) musicD = d;
    }
    this.drill.gain.setTargetAtTime(this.wDrill * 0.5, now, 0.08);
    this.scrape.gain.setTargetAtTime(this.wScrape * rnd(0.15, 0.6), now, 0.04);
    this.scrapeBp.frequency.setTargetAtTime(rnd(1200, 2600), now, 0.05);
    this.bellows.gain.setTargetAtTime(this.wBellows * 0.7, now, 0.15);

    this.musicOn = musicD < MUSIC_RANGE && ctx.world()?.phase === 'playing';
    const mg = !this.musicOn ? 0 : musicD === 0 ? 0.75 : 0.75 * (1 - musicD / MUSIC_RANGE) ** 2;
    this.music.gain.setTargetAtTime(mg, now, 0.3);
  }

  private work(h: string, a: number, x: number, y: number, z: number, now: number) {
    const k = this.kit;
    if (h === 'roof_vent') { this.wDrill = Math.max(this.wDrill, a); return; }
    if (h.startsWith('vent:')) { this.wScrape = Math.max(this.wScrape, a); return; }
    if (h === 'inflate') { this.wBellows = Math.max(this.wBellows, a); return; }
    if (h === 'utility_door') {
      if (Math.random() < 0.4) { const o = this.emitter(x, y, z, 0.5 * a, 30); if (o) S.click(k, o, now + Math.random() * 0.08, 1); }
      return;
    }
    if (h.startsWith('free:')) {
      if (Math.random() < 0.25) { const o = this.emitter(x, y, z, 0.45 * a, 30); if (o) S.jingle(k, o, now, 1); }
      return;
    }
    if (h === 'fence') {
      if (Math.random() < 0.15) { const o = this.emitter(x, y, z, 0.35 * a, 40); if (o) S.fence(k, o, now, 1); }
      return;
    }
    // dummy head, pickups, crawling, boarding: cloth and shuffling
    if (Math.random() < 0.35) { const o = this.emitter(x, y, z, 0.3 * a, 20); if (o) S.rustle(k, o, now, 1); }
  }

  // ----------------------------------------------------------------------------------------------
  // Events
  // ----------------------------------------------------------------------------------------------
  private onFx(f: Fx) {
    const ac = this.ac;
    if (!ac || ac.state !== 'running') return;
    const k = this.kit;
    const now = ac.currentTime + 0.01;
    switch (f.k) {
      case 'sfx': this.sfx(f.id, f.p, now); break;
      case 'chapter': S.typewriter(k, this.globalOut(0.5), now + 0.25, 1); break;
      case 'caught': if (f.pid === this.ctx.myId) S.caughtSting(k, this.globalOut(0.9), now, 1); break;
      case 'alarm': if (f.level >= 2) S.siren(k, this.globalOut(0.7), now + 0.6, 1, 6); break;
      case 'lost': S.siren(k, this.globalOut(0.9), now, 1, 9); break;
      case 'won': S.fogChord(k, this.globalOut(1), now, 1); break;
      default: break;
    }
  }

  private sfx(id: SfxId, p: V3 | undefined, t: number) {
    const spec = SFX[id];
    if (!spec) return;
    const out = p && spec.range > 0 ? this.emitter(p[0], p[1], p[2], spec.v, spec.range) : this.globalOut(spec.v);
    if (out) spec.play(this.kit, out, t, 1);
  }

  // ----------------------------------------------------------------------------------------------
  // Routing helpers (one small chain per sound event)
  // ----------------------------------------------------------------------------------------------
  /** Positional source: distance attenuation, stereo pan from the camera, muffled through walls. */
  private emitter(x: number, y: number, z: number, vol: number, range: number): AudioNode | null {
    const dx = x - this.lp.x, dy = y - this.lp.y, dz = z - this.lp.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > range) return null;
    const att = Math.min(1, 5 / Math.max(d, 5)) * (1 - (d / range) ** 2);
    return this.route(x, y, z, vol * att, 0.35 + 0.5 * (d / range));
  }
  /** Far-away source that never cuts out (foghorns, buoy): gentle attenuation. */
  private emitterFar(p: V3, vol: number): AudioNode | null {
    const dx = p[0] - this.lp.x, dy = p[1] - this.lp.y, dz = p[2] - this.lp.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return this.route(p[0], p[1], p[2], vol * clamp(70 / Math.max(d, 1), 0.12, 1), 0.6);
  }
  private route(x: number, y: number, z: number, gain: number, wet: number): AudioNode | null {
    if (gain < 0.002) return null;
    const ac = this.ac!, k = this.kit;
    const indoor = this.env === 'indoor';
    const occluded = (this.env !== 'aerial') && INDOOR.has(zoneAt(x, y, z)) !== indoor;
    const cx = x - this.cam.x, cz = z - this.cam.z;
    const cl = Math.hypot(cx, cz) || 1;
    // right vector of the camera = (-fwd.z, fwd.x)
    const pan = clamp(((cx * -this.fwd.z + cz * this.fwd.x) / cl) * 0.85, -1, 1);
    const pn = ac.createStereoPanner();
    pn.pan.value = pan;
    pn.connect(occluded ? S.biquad(k, 'lowpass', 700, 0.7, this.sfxBus) : this.sfxBus);
    pn.connect(S.amp(k, indoor ? this.reverbIn : this.echoIn, indoor ? wet : wet * 0.5));
    return S.amp(k, pn, occluded ? gain * 0.4 : gain);
  }
  /** Non-positional (bells heard everywhere, stingers). */
  private globalOut(vol: number): AudioNode {
    const k = this.kit;
    const g = S.amp(k, this.sfxBus, vol);
    g.connect(S.amp(k, this.env === 'indoor' ? this.reverbIn : this.echoIn, 0.35));
    return g;
  }
  /** The local player's own sounds (centred, a little room). */
  private localOut(vol: number): AudioNode {
    const k = this.kit;
    const g = S.amp(k, this.sfxBus, vol);
    if (this.env === 'indoor') g.connect(S.amp(k, this.reverbIn, 0.25));
    return g;
  }
  /** Ambient one-shot at a random direction. */
  private randomOut(vol: number, wet: number): AudioNode {
    const ac = this.ac!, k = this.kit;
    const pn = ac.createStereoPanner();
    pn.pan.value = rnd(-0.8, 0.8);
    pn.connect(this.sfxBus);
    pn.connect(S.amp(k, this.env === 'indoor' ? this.reverbIn : this.echoIn, wet));
    return S.amp(k, pn, vol);
  }
}

/** Perceptual mapping of the 0..1 slider. */
function volumeGain(v: number) { return v * v * 0.9; }

/** Ramp a param up to `peak` over `rise` seconds, then let it settle toward `rest`. */
function ramp(p: AudioParam, t: number, peak: number, rise: number, rest: number, tau: number) {
  p.cancelScheduledValues(t);
  p.setValueAtTime(p.value, t);
  p.linearRampToValueAtTime(peak, t + rise);
  p.setTargetAtTime(rest, t + rise, tau);
}
