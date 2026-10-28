// Visual of one guard, rendered identically on host and clients: the animated officer (Avatar),
// a hand-held flashlight (SpotLight, created once, never removed) with a faint shaft and lens glare,
// and a "?" / "!" glyph above the head. Clients feed it host snapshots through `push()` and render
// ~200 ms in the past with interpolation; the host feeds it its live brain state.
import * as THREE from 'three/webgpu';
import type { GuardDef } from '../../world/layout';
import { Avatar } from '../player/Avatar';
import type { AvatarApi, Ctx } from '../context';
import type { GuardAnim, GuardMode, GuardNet } from '../types';
import { FLASH, clamp, smoothstep, wrapAngle, type Aim } from './common';
import { createBeam, createGlare, glyphTexture, type Beam } from './beams';

/** What the view needs to draw a guard this frame. */
export interface GuardViewState {
  visible: boolean;
  x: number; y: number; z: number;
  ry: number;
  anim: GuardAnim;
  mode: GuardMode;
  s: number;
  target: string;
  flash: boolean;
  /** horizontal speed (m/s), animation playback hint; < 0 = estimate from the rendered motion */
  speed: number;
}

const HISTORY = 8;
const COS_OUTER = Math.cos(FLASH.angle);
const COS_INNER = Math.cos(FLASH.angle * 0.55);
/** guards further than this from the camera are not drawn (fog hides them long before) */
const DRAW_DIST2 = 170 * 170;

const Q_COLOR = new THREE.Color(0xffd27a);
const ALERT_COLOR = new THREE.Color(0xff4a36).multiplyScalar(1.8); // slight bloom

export class GuardView {
  readonly root = new THREE.Group();
  readonly avatar: AvatarApi;
  /** world-space flashlight origin / unit direction, valid while `torchOn` */
  readonly torchPos = new THREE.Vector3();
  readonly torchDir = new THREE.Vector3(0, 0, -1);
  torchOn = false;

  private readonly torch: THREE.Object3D | null = null;
  private readonly spot: THREE.SpotLight | null = null;
  private readonly beam: Beam | null = null;
  private readonly glare: THREE.Sprite | null = null;
  private readonly marker: THREE.Sprite;
  private readonly markerMat: THREE.SpriteMaterial;
  private glyph: 0 | 1 | 2 = 0;
  private pop = 0;
  private readonly aim: Aim = { yaw: 0, pitch: 0.25 };
  private aimInit = false;

  // ---- client-side snapshot history (ring buffer) --------------------------------------------
  private readonly ht = new Float64Array(HISTORY);
  private readonly hx = new Float32Array(HISTORY);
  private readonly hy = new Float32Array(HISTORY);
  private readonly hz = new Float32Array(HISTORY);
  private readonly hr = new Float32Array(HISTORY);
  private hCount = 0;
  private hHead = -1;
  /** latest replicated discrete state */
  net: Pick<GuardNet, 'a' | 'm' | 's' | 't' | 'f'> = { a: 'idle', m: 'patrol', s: 0, t: '', f: 0 };
  netActive = false;
  private lastX = NaN;
  private lastZ = NaN;

  private readonly tmp = new THREE.Vector3();

  constructor(private readonly ctx: Ctx, readonly index: number, readonly def: GuardDef) {
    this.root.name = `guard:${def.name}`;
    this.root.visible = false;
    this.avatar = new Avatar(ctx, 'guard');
    this.root.add(this.avatar.root);

    if (def.flashlight) {
      const torch = new THREE.Object3D();
      torch.rotation.order = 'YXZ';
      torch.position.set(FLASH.offset[0], FLASH.offset[1], FLASH.offset[2]);
      const spot = new THREE.SpotLight(FLASH.color, 0, FLASH.range, FLASH.angle, FLASH.penumbra, 2);
      spot.castShadow = false;
      // The light lives directly in the scene, never under a node that gets hidden: an invisible
      // light drops out of the renderer's light list, which changes every lit material's cache key
      // and recompiles them all. Distant/inactive guards only set intensity 0 (see render/hide).
      spot.position.set(0, -500, 0);
      spot.target.position.set(0, -501, 0);
      ctx.scene.add(spot, spot.target);
      const beam = createBeam({ color: FLASH.color, strength: 0.16, angle: FLASH.angle * 0.8, falloff: 1.8 });
      beam.setLength(FLASH.beamLength);
      torch.add(beam.mesh);
      const glare = createGlare(FLASH.color, 0.45, 2.5);
      glare.position.set(0, 0, -0.06);
      torch.add(glare);
      this.root.add(torch);
      this.torch = torch;
      this.spot = spot;
      this.beam = beam;
      this.glare = glare;
    }

    this.markerMat = new THREE.SpriteMaterial({ map: glyphTexture('?'), color: Q_COLOR, transparent: true, depthWrite: false, fog: false });
    this.marker = new THREE.Sprite(this.markerMat);
    this.marker.position.set(0, 2.3, 0);
    this.marker.scale.setScalar(0.38);
    this.marker.visible = false;
    this.marker.renderOrder = 12;
    this.root.add(this.marker);

    ctx.scene.add(this.root);
  }

  // ----------------------------------------------------------------------------------------------
  // Client interpolation
  // ----------------------------------------------------------------------------------------------
  /** Stores a host snapshot (host clock `t`). */
  push(t: number, g: GuardNet) {
    if (this.hCount > 0 && t <= this.ht[this.hHead]) return; // duplicate / out of order
    // re-activation or a long jump (teleport, respawn): restart the history so we don't glide
    if (!this.netActive || (this.hCount > 0 && Math.hypot(g.p[0] - this.hx[this.hHead], g.p[2] - this.hz[this.hHead]) > 8)) this.hCount = 0;
    this.hHead = (this.hHead + 1) % HISTORY;
    this.ht[this.hHead] = t;
    this.hx[this.hHead] = g.p[0];
    this.hy[this.hHead] = g.p[1];
    this.hz[this.hHead] = g.p[2];
    this.hr[this.hHead] = g.ry;
    this.hCount = Math.min(HISTORY, this.hCount + 1);
    this.net.a = g.a; this.net.m = g.m; this.net.s = g.s; this.net.t = g.t; this.net.f = g.f;
    this.netActive = true;
  }

  /** Interpolated pose at host time `rt` into `st` (position + yaw). False when there is no data. */
  sample(rt: number, st: GuardViewState): boolean {
    if (!this.netActive || this.hCount === 0) return false;
    let newer = this.hHead;
    for (let k = 0; k < this.hCount; k++) {
      const i = (this.hHead - k + HISTORY) % HISTORY;
      if (this.ht[i] <= rt) {
        if (i === this.hHead) { this.write(st, i, i, 0); return true; } // newer than anything: hold the latest
        const f = clamp((rt - this.ht[i]) / Math.max(1e-3, this.ht[newer] - this.ht[i]), 0, 1);
        this.write(st, i, newer, f);
        return true;
      }
      newer = i;
    }
    this.write(st, newer, newer, 0); // older than the history: oldest sample
    return true;
  }

  private write(st: GuardViewState, a: number, b: number, f: number) {
    st.x = this.hx[a] + (this.hx[b] - this.hx[a]) * f;
    st.y = this.hy[a] + (this.hy[b] - this.hy[a]) * f;
    st.z = this.hz[a] + (this.hz[b] - this.hz[a]) * f;
    st.ry = wrapAngle(this.hr[a] + wrapAngle(this.hr[b] - this.hr[a]) * f);
  }

  // ----------------------------------------------------------------------------------------------
  // Rendering
  // ----------------------------------------------------------------------------------------------
  /** Draws the guard. `aim` is the wanted torch/head direction relative to the body. */
  render(dt: number, st: GuardViewState, aim: Aim, t: number) {
    // flashlight pose first, and for every active guard: the host's stealth model needs it even
    // for officers far from its own camera
    this.updateTorch(dt, st, aim);

    const cam = this.ctx.camera.position;
    const near = st.visible && (st.x - cam.x) ** 2 + (st.y - cam.y) ** 2 + (st.z - cam.z) ** 2 < DRAW_DIST2;
    this.root.visible = near;
    if (!near) {
      if (this.spot) this.spot.intensity = 0;
      this.lastX = NaN;
      return;
    }

    // speed estimate for clients (host passes its own)
    if (st.speed < 0 && dt > 0) st.speed = Number.isNaN(this.lastX) ? 0 : Math.hypot(st.x - this.lastX, st.z - this.lastZ) / dt;
    this.lastX = st.x;
    this.lastZ = st.z;

    this.root.position.set(st.x, st.y, st.z);
    this.root.rotation.y = st.ry;
    this.avatar.play(st.anim, 0.25);
    setSpeedHint(this.avatar, st.speed);
    this.avatar.update(dt);

    if (this.torch && this.spot && this.beam && this.glare) {
      this.torch.rotation.set(-this.aim.pitch, this.aim.yaw, 0);
      this.spot.intensity = st.flash ? FLASH.intensity : 0;
      this.spot.position.copy(this.torchPos);
      this.spot.target.position.copy(this.torchPos).add(this.torchDir);
      this.beam.intensity.value = st.flash ? 1 : 0;
      this.beam.mesh.visible = st.flash;
      // lens glare: a dot from the side, a blinding disc when the torch points at the camera
      this.tmp.copy(cam).sub(this.torchPos).normalize();
      const facing = smoothstep(Math.cos(FLASH.angle * 2.2), Math.cos(FLASH.angle * 0.4), this.tmp.dot(this.torchDir));
      this.glare.visible = st.flash;
      this.glare.material.opacity = 0.25 + 0.75 * facing;
      this.glare.scale.setScalar(0.35 + 0.9 * facing);
    }

    // "?" while suspicious / searching, "!" when chasing or raising the alarm
    const glyph: 0 | 1 | 2 = st.mode === 'chase' || st.s >= 0.99 ? 2
      : st.mode === 'suspicious' || st.mode === 'investigate' || st.s > 0.12 ? 1 : 0;
    if (glyph !== this.glyph) {
      if (glyph === 2) this.pop = 0.3;
      this.glyph = glyph;
      if (glyph) {
        this.markerMat.map = glyphTexture(glyph === 2 ? '!' : '?');
        this.markerMat.color.copy(glyph === 2 ? ALERT_COLOR : Q_COLOR);
      }
    }
    this.marker.visible = glyph !== 0;
    if (glyph) {
      this.pop = Math.max(0, this.pop - dt);
      const base = glyph === 2 ? 0.46 : 0.3 + 0.14 * st.s;
      this.marker.scale.setScalar(base * (1 + this.pop * 2));
      this.marker.position.y = 2.3 + 0.04 * Math.sin(t * 4 + this.index);
      this.markerMat.opacity = glyph === 2 ? 1 : 0.45 + 0.55 * st.s;
    }
  }

  /**
   * Smoothed torch aim and its world pose, computed analytically from the body pose (same result as
   * the torch Object3D's matrixWorld, without needing an up-to-date scene graph).
   */
  private updateTorch(dt: number, st: GuardViewState, aim: Aim) {
    if (!this.torch || !st.visible) { this.torchOn = false; this.aimInit = false; return; }
    if (!this.aimInit) { this.aim.yaw = aim.yaw; this.aim.pitch = aim.pitch; this.aimInit = true; }
    const k = Math.min(1, dt * 6); // offsets stay within +-1.5 rad: plain lerp, no wrapping
    this.aim.yaw += (aim.yaw - this.aim.yaw) * k;
    this.aim.pitch += (aim.pitch - this.aim.pitch) * k;
    const c = Math.cos(st.ry), s = Math.sin(st.ry);
    const [ox, oy, oz] = FLASH.offset;
    this.torchPos.set(st.x + ox * c + oz * s, st.y + oy, st.z - ox * s + oz * c);
    const yaw = st.ry + this.aim.yaw, cp = Math.cos(this.aim.pitch);
    this.torchDir.set(-Math.sin(yaw) * cp, -Math.sin(this.aim.pitch), -Math.cos(yaw) * cp);
    this.torchOn = st.flash;
  }

  /** 0..FLASH.exposure: how strongly the flashlight cone lights p (geometry only, no occlusion). */
  lightAt(p: THREE.Vector3): number {
    if (!this.torchOn) return 0;
    const dx = p.x - this.torchPos.x, dy = p.y - this.torchPos.y, dz = p.z - this.torchPos.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > FLASH.range || d < 1e-3) return 0;
    const cos = (dx * this.torchDir.x + dy * this.torchDir.y + dz * this.torchDir.z) / d;
    if (cos <= COS_OUTER) return 0;
    const fall = 1 - (d / FLASH.range) ** 2;
    return FLASH.exposure * smoothstep(COS_OUTER, COS_INNER, cos) * fall;
  }

  hide() {
    this.root.visible = false;
    this.torchOn = false;
    this.aimInit = false;
    if (this.spot) this.spot.intensity = 0;
    this.lastX = NaN;
  }

  dispose() {
    this.ctx.scene.remove(this.root);
    this.avatar.dispose();
    if (this.beam) (this.beam.mesh.material as THREE.Material).dispose();
    if (this.glare) this.glare.material.dispose();
    this.markerMat.dispose();
    if (this.spot) this.ctx.scene.remove(this.spot, this.spot.target);
    this.spot?.dispose();
  }
}

/** Avatar plays walk/run at a rate matched to the movement speed when it exposes a `speed` hint. */
function setSpeedHint(a: AvatarApi, speed: number) {
  if ('speed' in a) (a as { speed: number }).speed = speed;
}
