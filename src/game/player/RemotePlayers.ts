// Other connected players: one Avatar each (character from their slot), rendered ~120 ms in the
// past and interpolated between their 12 Hz PlayerNet samples, plus a name tag sprite.
//
// Samples are stamped with the local receive time; a new sample is taken when Playroom hands us
// a new state object. Big jumps (teleports, traverses) snap instead of streaking across the map.
// Name tags render on top of everything (co-op: you can find your friends through walls) and drop
// to low opacity when a physics ray from the camera says they are behind a wall.
import * as THREE from 'three/webgpu';
import { RAPIER } from '../../core/physics';
import { QUERY_WORLD_ONLY, type Ctx } from '../context';
import type { NetPlayer } from '../net';
import { CHARACTER_IDS, type PlayerNet } from '../types';
import { Avatar } from './Avatar';

/** render delay behind the newest sample (s): a bit more than one 12 Hz interval */
const DELAY = 0.12;
const RING = 8;
/** max extrapolation past the newest sample (s) when packets are late */
const MAX_EXTRAPOLATE = 0.1;
/** distance between consecutive samples treated as a teleport (m) */
const SNAP_DIST = 4;
const ROSTER_INTERVAL = 0.5;
const OCCLUSION_INTERVAL = 0.12;
const TAG_HEIGHT = 0.034;        // screen-space height (sizeAttenuation off)
const TAG_W = 512;
const TAG_H = 52;
const TAG_MAX_DIST = 90;

/** name tag height above the feet per animation */
const TAG_Y: Record<string, number> = { sit: 1.2, swim: 0.95, crouch: 1.65, knockdown: 0.9, work: 1.5 };

interface Sample { t: number; x: number; y: number; z: number; ry: number }

interface Remote {
  id: string;
  slot: number;
  avatar: Avatar;
  samples: Sample[];
  /** index of the newest sample, count of valid samples */
  head: number;
  count: number;
  last: PlayerNet | null;
  lastPushT: number;
  speed: number;
  tag: THREE.Sprite;
  tagMat: THREE.SpriteMaterial;
  tagTex: THREE.CanvasTexture;
  name: string;
  color: string;
  occluded: boolean;
  occT: number;
}

const _a = new THREE.Vector3();
const _tag = new THREE.Vector3();

export class RemotePlayers {
  private readonly remotes = new Map<string, Remote>();
  private readonly roster = new Map<string, NetPlayer>();
  /** roster values as an array, iterated per frame without allocating */
  private rosterList: NetPlayer[] = [];
  private clock = 0;
  private rosterT = ROSTER_INTERVAL;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

  constructor(readonly ctx: Ctx) {
    ctx.net.onJoin((p) => { if (!p.isMe && p.id !== ctx.myId) { this.roster.set(p.id, p); this.rosterList = [...this.roster.values()]; } });
    ctx.net.onQuit((id) => { this.roster.delete(id); this.rosterList = [...this.roster.values()]; this.remove(id); });
  }

  update(dt: number) {
    this.clock += dt;
    this.rosterT += dt;
    if (this.rosterT >= ROSTER_INTERVAL) {
      this.rosterT = 0;
      this.syncRoster();
    }
    const world = this.ctx.world();
    for (let i = 0; i < this.rosterList.length; i++) {
      const np = this.rosterList[i];
      const id = np.id;
      const slot = world?.players[id]?.slot;
      const ps = this.ctx.net.getPlayerState(id);
      let r = this.remotes.get(id);
      if (slot === undefined || !ps) {
        if (r) r.avatar.root.visible = r.tag.visible = false;
        continue;
      }
      if (r && r.slot !== slot) { this.remove(id); r = undefined; } // slots reshuffled (restart)
      if (!r) r = this.create(id, slot, np, ps);
      if (np.name !== r.name || np.color !== r.color) this.drawTag(r, np.name, np.color);
      this.ingest(r, ps);
      this.render(r, ps, dt);
    }
  }

  dispose() {
    for (const id of [...this.remotes.keys()]) this.remove(id);
    this.roster.clear();
    this.rosterList = [];
  }

  // ----------------------------------------------------------------------------------------------
  private syncRoster() {
    const seen = new Set<string>();
    for (const p of this.ctx.net.players()) {
      if (p.isMe || p.id === this.ctx.myId) continue;
      seen.add(p.id);
      this.roster.set(p.id, p);
    }
    for (const id of [...this.roster.keys()]) {
      if (!seen.has(id)) { this.roster.delete(id); this.remove(id); }
    }
    this.rosterList = [...this.roster.values()];
  }

  private create(id: string, slot: number, np: NetPlayer, ps: PlayerNet): Remote {
    const avatar = new Avatar(this.ctx, CHARACTER_IDS[slot] ?? CHARACTER_IDS[0]);
    const tagTex = new THREE.CanvasTexture(document.createElement('canvas'));
    tagTex.colorSpace = THREE.SRGBColorSpace;
    const tagMat = new THREE.SpriteMaterial({
      map: tagTex, transparent: true, depthTest: false, depthWrite: false, fog: false, sizeAttenuation: false,
    });
    const tag = new THREE.Sprite(tagMat);
    tag.renderOrder = 999;
    tag.center.set(0.5, 0);
    tag.scale.set(TAG_HEIGHT * (TAG_W / TAG_H), TAG_HEIGHT, 1);
    this.ctx.scene.add(tag);
    const r: Remote = {
      id, slot, avatar,
      samples: Array.from({ length: RING }, () => ({ t: 0, x: 0, y: 0, z: 0, ry: 0 })),
      head: -1, count: 0, last: null, lastPushT: -1, speed: 0,
      tag, tagMat, tagTex, name: '', color: '', occluded: false, occT: 0,
    };
    this.drawTag(r, np.name, np.color);
    this.push(r, ps); // start at the first known position
    this.remotes.set(id, r);
    this.ctx.avatars.set(id, avatar);
    return r;
  }

  private remove(id: string) {
    const r = this.remotes.get(id);
    if (!r) return;
    this.remotes.delete(id);
    if (this.ctx.avatars.get(id) === r.avatar) this.ctx.avatars.delete(id);
    r.avatar.dispose();
    r.tag.removeFromParent();
    r.tagMat.dispose();
    r.tagTex.dispose();
  }

  /** New network state -> ring buffer (Playroom gives a new object per received update). */
  private ingest(r: Remote, ps: PlayerNet) {
    if (ps === r.last) return;
    const s = r.samples[r.head];
    const changed = !s || s.x !== ps.p[0] || s.y !== ps.p[1] || s.z !== ps.p[2] || s.ry !== ps.ry;
    // identical values arriving every frame would mean we are polling a copy, not an update
    if (!changed && this.clock - r.lastPushT < 0.3) { r.last = ps; return; }
    this.push(r, ps);
  }

  private push(r: Remote, ps: PlayerNet) {
    r.head = (r.head + 1) % RING;
    const s = r.samples[r.head];
    s.t = this.clock; s.x = ps.p[0]; s.y = ps.p[1]; s.z = ps.p[2]; s.ry = ps.ry;
    r.count = Math.min(RING, r.count + 1);
    r.last = ps;
    r.lastPushT = this.clock;
  }

  private render(r: Remote, ps: PlayerNet, dt: number) {
    const rt = this.clock - DELAY;
    const newest = r.samples[r.head];
    const root = r.avatar.root;
    let speed = 0;
    if (r.count < 2 || rt >= newest.t) {
      // starved: hold (or briefly extrapolate along the last segment)
      const prev = r.count >= 2 ? r.samples[(r.head - 1 + RING) % RING] : null;
      if (prev && newest.t > prev.t && dist(prev, newest) < SNAP_DIST) {
        const u = Math.min(rt - newest.t, MAX_EXTRAPOLATE) / (newest.t - prev.t);
        root.position.set(newest.x + (newest.x - prev.x) * u, newest.y + (newest.y - prev.y) * u, newest.z + (newest.z - prev.z) * u);
        speed = Math.hypot(newest.x - prev.x, newest.z - prev.z) / (newest.t - prev.t);
      } else {
        root.position.set(newest.x, newest.y, newest.z);
      }
      root.rotation.y = newest.ry;
    } else {
      // find the pair (a older, b newer) around the render time
      let bi = r.head;
      let ai = (bi - 1 + RING) % RING;
      for (let k = 1; k < r.count - 1 && r.samples[ai].t > rt; k++) {
        bi = ai;
        ai = (ai - 1 + RING) % RING;
      }
      const a = r.samples[ai], b = r.samples[bi];
      if (rt <= a.t || b.t <= a.t || dist(a, b) > SNAP_DIST) {
        const s = rt <= a.t ? a : b;
        root.position.set(s.x, s.y, s.z);
        root.rotation.y = s.ry;
      } else {
        const u = (rt - a.t) / (b.t - a.t);
        root.position.set(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u);
        root.rotation.y = a.ry + shortAngle(a.ry, b.ry) * u;
        speed = Math.hypot(b.x - a.x, b.z - a.z) / (b.t - a.t);
      }
    }
    r.speed += (speed - r.speed) * (1 - Math.exp(-8 * dt));

    root.visible = true;
    r.avatar.speed = ps.a === 'climb' ? (r.speed > 0.05 ? 0.6 : 0) : r.speed;
    r.avatar.play(ps.a, 0.25);
    r.avatar.update(dt);

    // name tag
    _tag.copy(root.position);
    _tag.y += TAG_Y[ps.a] ?? (ps.cr ? TAG_Y.crouch : 2.05);
    r.tag.position.copy(_tag);
    const cam = this.ctx.camera.position;
    const d = cam.distanceTo(_tag);
    r.tag.visible = d < TAG_MAX_DIST;
    r.occT -= dt;
    if (r.tag.visible && r.occT <= 0) {
      r.occT = OCCLUSION_INTERVAL;
      r.occluded = this.blocked(cam, _tag, d);
    }
    const target = r.occluded ? 0.32 : 0.92;
    r.tagMat.opacity += (target - r.tagMat.opacity) * (1 - Math.exp(-10 * dt));
  }

  /** world geometry between the camera and a point? */
  private blocked(from: THREE.Vector3, to: THREE.Vector3, d: number) {
    if (d < 0.5) return false;
    _a.subVectors(to, from).multiplyScalar(1 / d);
    const ray = this.ray;
    ray.origin.x = from.x; ray.origin.y = from.y; ray.origin.z = from.z;
    ray.dir.x = _a.x; ray.dir.y = _a.y; ray.dir.z = _a.z;
    const hit = this.ctx.physics.world.castRay(ray, d - 0.3, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, QUERY_WORLD_ONLY);
    return !!hit;
  }

  /**
   * Name + player colour on a dark plate, centred on a fixed-size canvas (GPU textures keep their
   * size, so the canvas never changes dimensions). Redrawn only when the name or colour changes.
   */
  private drawTag(r: Remote, name: string, color: string) {
    r.name = name;
    r.color = color;
    const canvas = r.tagTex.image as HTMLCanvasElement;
    if (canvas.width !== TAG_W || canvas.height !== TAG_H) { canvas.width = TAG_W; canvas.height = TAG_H; }
    const g = canvas.getContext('2d')!;
    const font = '600 30px "Courier New", Courier, monospace';
    g.font = font;
    const label = name.length > 20 ? `${name.slice(0, 19)}…` : name || '—';
    const padX = 20, dot = 16, gap = 12;
    const textW = Math.min(TAG_W - padX * 2 - dot - gap, Math.ceil(g.measureText(label).width));
    const plateW = textW + padX * 2 + dot + gap;
    const x0 = (TAG_W - plateW) / 2;
    g.clearRect(0, 0, TAG_W, TAG_H);
    g.fillStyle = 'rgba(12, 14, 16, 0.62)';
    roundRect(g, x0, 0, plateW, TAG_H, 12);
    g.fill();
    g.fillStyle = color || '#e8c25a';
    g.beginPath();
    g.arc(x0 + padX + dot / 2, TAG_H / 2, dot / 2, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ece6d6';
    g.textBaseline = 'middle';
    g.fillText(label, x0 + padX + dot + gap, TAG_H / 2 + 2, textW);
    r.tagTex.needsUpdate = true;
  }
}

function dist(a: Sample, b: Sample) {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}
function shortAngle(a: number, b: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
