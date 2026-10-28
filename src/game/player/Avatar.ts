// Animated character visual shared by the local player, remote players and guards.
//
// Hierarchy: root (owner sets position + yaw, 0 = facing -Z) -> character root rotated π (Meshy
// files face +Z) -> scaled skinned model. Clips come from ctx.models.character() already in place.
//
// Blending: every action has its own weight that moves linearly toward 0/1; effective weights are
// normalised each frame so the pose never dips toward the bind pose when several fades overlap
// (three's built-in crossFade restarts the incoming weight at 0, which pops on quick A->B->A).
// Playback speed follows the `speed` hint (m/s) for locomotion clips so feet roughly match the
// ground; clips without a hint play at their natural rate.
import * as THREE from 'three/webgpu';
import type { AvatarApi, CharacterInstance, Ctx } from '../context';

/** Natural ground speed of locomotion clips (m/s, measured on the Meshy rig) and timeScale limits. */
const LOCOMOTION: Record<string, { speed: number; min: number; max: number }> = {
  walk: { speed: 0.76, min: 0.6, max: 2.2 },
  run: { speed: 5.5, min: 0.7, max: 1.4 },
  crouch: { speed: 1.45, min: 0, max: 1.6 },   // crouch-walk: holds the pose when standing still
  swim: { speed: 0.4, min: 0.6, max: 2.0 },    // never fully stops: treading water
  climb: { speed: 0.28, min: -2.6, max: 2.6 }, // signed vertical speed; negative plays it backwards
};
/** One-shot clips: play once and hold the last frame. */
const ONE_SHOT = new Set(['pickup', 'knockdown', 'grab']);
/** Ping-pong loops (trimmed segments whose ends do not match). */
const PING_PONG = new Set(['work']);
/** Default playback rate when no speed hint applies. */
const DEFAULT_RATE: Record<string, number> = { pickup: 1.5 };

interface Slot {
  name: string;
  action: THREE.AnimationAction;
  weight: number;
  target: number;
  active: boolean;
}

/** Item placement in the avatar's rest frame (x right, y up, -z forward), metres. */
const HAND_PALM = 0.085;            // palm centre along the hand bone from the wrist
const BACK_GAP = 0.13;              // spine joint -> surface of the back
const BACK_DROP = 0.26;             // bundle bottom below the upper-spine joint

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _box = new THREE.Box3();
const _c = new THREE.Vector3();

export class Avatar implements AvatarApi {
  readonly root = new THREE.Object3D();
  readonly character: CharacterInstance;
  /** movement speed hint (m/s) for locomotion playback rate; null = natural rate */
  speed: number | null = null;

  private readonly slots: Slot[] = [];
  private current: Slot | null = null;
  private fadeRate = 4;
  /** frames re-aligned to the avatar's rest frame, parented to the hand / back bones */
  private readonly holders: Record<'hand' | 'back', THREE.Object3D | null> = { hand: null, back: null };
  private readonly offset = new THREE.Group();
  private attached: THREE.Object3D | null = null;
  private attachedWhere: 'hand' | 'back' = 'hand';
  private disposed = false;

  constructor(readonly ctx: Ctx, readonly characterId: string) {
    this.root.name = `avatar:${characterId}`;
    this.character = ctx.models.character(characterId);
    this.character.root.rotation.y = Math.PI;
    this.root.add(this.character.root);
    this.offset.name = 'carried';
    this.buildHolders();
    ctx.scene.add(this.root);
    this.play('idle', 0);
  }

  /** Name of the clip currently playing (or fading in). */
  get anim() { return this.current?.name ?? ''; }

  /** True once a one-shot clip has reached its last frame. */
  get finished() {
    const a = this.current?.action;
    return !!a && a.loop === THREE.LoopOnce && a.time >= a.getClip().duration - 1e-3;
  }

  has(anim: string) { return this.character.clips.has(anim); }

  play(anim: string, fade = 0.25) {
    if (this.disposed) return;
    const clips = this.character.clips;
    const name = clips.has(anim) ? anim : clips.has('idle') ? 'idle' : '';
    if (!name || this.current?.name === name) return;

    let slot = this.slots.find((s) => s.name === name);
    if (!slot) {
      const action = this.character.mixer.clipAction(clips.get(name)!);
      if (ONE_SHOT.has(name)) { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
      else if (PING_PONG.has(name)) action.setLoop(THREE.LoopPingPong, Infinity);
      else action.setLoop(THREE.LoopRepeat, Infinity);
      slot = { name, action, weight: 0, target: 0, active: false };
      this.slots.push(slot);
    }
    if (!slot.active || ONE_SHOT.has(name)) {
      // (re)start from the first frame; a looping clip still fading out keeps its phase instead
      slot.action.reset();
      slot.action.play();
      if (!slot.active) slot.weight = 0;
      slot.active = true;
    }
    for (const s of this.slots) s.target = s === slot ? 1 : 0;
    this.current = slot;
    this.fadeRate = fade > 1e-3 ? 1 / fade : Infinity;
    slot.action.timeScale = DEFAULT_RATE[name] ?? 1;
    if (!Number.isFinite(this.fadeRate)) this.applyWeights(0);
  }

  attach(obj: THREE.Object3D | null, where: 'hand' | 'back' = 'hand') {
    if (obj === this.attached && (obj === null || where === this.attachedWhere)) return;
    // release the previous item; its owner (Items) puts it back into the world
    if (this.attached && this.attached.parent === this.offset) this.offset.remove(this.attached);
    this.offset.removeFromParent();
    this.attached = obj;
    this.attachedWhere = where;
    if (!obj) return;

    // The avatar owns the carried object's position (it is reset); rotation and scale are kept.
    obj.removeFromParent();
    obj.position.set(0, 0, 0);
    obj.updateMatrixWorld(true);
    _box.setFromObject(obj, true);
    if (_box.isEmpty()) _box.set(_c.set(-0.1, 0, -0.1), _p.set(0.1, 0.2, 0.1));
    _box.getCenter(_c);
    if (where === 'back') {
      // centred across the back, its front face against the back, hanging below the shoulders
      this.offset.position.set(-_c.x, -BACK_DROP - _box.min.y, BACK_GAP - _box.min.z);
    } else {
      this.offset.position.set(-_c.x, -_c.y, -_c.z);
    }
    this.offset.add(obj);
    const holder = this.holders[where] ?? this.holders.hand ?? this.holders.back;
    if (holder) holder.add(this.offset);
    else {
      // rig without the bones (placeholder capsule): roughly where they would be
      this.offset.position.y += where === 'back' ? 1.15 : 0.9;
      if (where === 'hand') this.offset.position.x += 0.3;
      this.root.add(this.offset);
    }
  }

  update(dt: number) {
    if (this.disposed) return;
    this.applyWeights(dt);
    const cur = this.current;
    if (cur) {
      const loco = LOCOMOTION[cur.name];
      if (loco && this.speed !== null) {
        cur.action.timeScale = THREE.MathUtils.clamp(this.speed / loco.speed, loco.min, loco.max);
      }
    }
    this.character.mixer.update(dt);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.attach(null);
    this.character.mixer.stopAllAction();
    this.character.mixer.uncacheRoot(this.character.mixer.getRoot());
    this.root.removeFromParent();
  }

  // ----------------------------------------------------------------------------------------------
  private applyWeights(dt: number) {
    const instant = !Number.isFinite(this.fadeRate);
    const step = this.fadeRate * dt;
    let sum = 0;
    for (const s of this.slots) {
      if (!s.active) continue;
      if (instant) s.weight = s.target;
      else if (s.weight < s.target) s.weight = Math.min(s.target, s.weight + step);
      else if (s.weight > s.target) s.weight = Math.max(s.target, s.weight - step);
      if (s.weight <= 0 && s.target === 0) {
        s.active = false;
        s.action.stop();
        continue;
      }
      sum += s.weight;
    }
    for (const s of this.slots) {
      if (s.active) s.action.setEffectiveWeight(sum > 0 ? s.weight / sum : 0);
    }
  }

  /**
   * Holders sit on the hand / upper-spine bones with the inverse of the bone's rest rotation and
   * scale (relative to the avatar root), so carried items keep their real size and stand upright
   * in the rest pose whatever the rig's bone axes are; then they follow the animated bone.
   */
  private buildHolders() {
    const { hand, back } = this.character;
    this.root.updateMatrixWorld(true);
    const rootInv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const make = (bone: THREE.Object3D, alongBone: number) => {
      _m.multiplyMatrices(rootInv, bone.matrixWorld).decompose(_p, _q, _s);
      const inv = 1 / Math.max(1e-6, _s.x);
      const holder = new THREE.Object3D();
      holder.name = `holder:${bone.name}`;
      holder.position.set(0, alongBone * inv, 0); // bone-local +Y runs along the bone on this rig
      holder.quaternion.copy(_q).invert();
      holder.scale.setScalar(inv);
      bone.add(holder);
      return holder;
    };
    if (hand) this.holders.hand = make(hand, HAND_PALM);
    if (back) this.holders.back = make(back, 0);
  }
}
