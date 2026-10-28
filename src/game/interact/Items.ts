// Carried items (ItemsApi). Renders every item in play from WorldState.items: lying in the world
// (with a soft highlight when the local player could pick it up), attached to the carrier's avatar
// through ctx.avatars (bundles on the back, drill/keys in the hand), or briefly flying along an
// arc after a drop/throw. Also computes where the local player's drop/throw would land.
// Item state is owned by the host (rules.ts); nothing here mutates it.
import * as THREE from 'three/webgpu';
import { RAPIER } from '../../core/physics';
import { zoneAt } from '../../world/layout';
import { QUERY_WORLD_ONLY, type AvatarApi, type Ctx, type ItemsApi, type ModelsApi } from '../context';
import { NOT_IN_PLAY, carriedBy, isHeavy } from '../rules';
import { ITEM_IDS, type ItemId, type V3, type WorldState, type ZoneId } from '../types';
import { WorldCache, gearAtLaunch } from './gear';
import { glowTexture, haloTexture } from './textures';

/**
 * Zones a raft-gear bundle must never land in when thrown/dropped from elsewhere: bundles cannot
 * be carried up a climb or through a vent, so a bundle knocked off the top of B-Block (or into
 * the utility gap) would be lost for good. Such drops land at the player's feet instead.
 */
const NO_BUNDLE_ZONES: ReadonlySet<ZoneId> = new Set<ZoneId>(['cell', 'utility', 'floor', 'dblock']);

const HIGHLIGHT_RANGE = 3.2;
/** = the pickup radius in rules.availableInteractions */
const PICKUP_RANGE = 1.4;
const DROP_AHEAD = 0.55;
/** launch speed/angle of a throw: ~6 m on level ground from hand height */
const THROW_SPEED = 7.9;
const THROW_ANGLE = (35 * Math.PI) / 180;
const GRAVITY = 9.81;
/** vertical offset of the throw release point above the feet */
const HAND_HEIGHT = 1.4;

interface Visual {
  id: ItemId;
  where: 'hand' | 'back';
  /** lying visual, bottom at its origin */
  world: THREE.Group;
  /** carried visual (centred), handed to AvatarApi.attach */
  carry: THREE.Group;
  glow: THREE.Mesh;
  glowMat: THREE.MeshBasicMaterial;
  halo: THREE.Sprite;
  haloMat: THREE.SpriteMaterial;
  height: number;
  restYaw: number;
  phase: number;
  /** avatar the carry visual is currently attached to */
  avatar: AvatarApi | null;
  lying: boolean;
  /** current lying position (world state p) */
  at: THREE.Vector3;
  /** drop/throw flight from the carrier's hand/back to `at` */
  flyFrom: THREE.Vector3;
  hasFrom: boolean;
  flyT: number;
  flyDur: number;
  flyArc: number;
  flySpin: number;
  glowLevel: number;
}

const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _box = new THREE.Box3();

export class Items implements ItemsApi {
  private readonly visuals: Visual[] = [];
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private readonly myCarry = new WorldCache<ItemId | null>((w) => carriedBy(w, this.ctx.myId), null);
  private readonly gearReady = new WorldCache<boolean>(gearAtLaunch, false);
  private time = 0;

  constructor(readonly ctx: Ctx) {
    const glowGeo = new THREE.PlaneGeometry(1, 1);
    glowGeo.rotateX(-Math.PI / 2);
    for (const id of ITEM_IDS) {
      const built = buildVisual(ctx.models, id);
      const glowMat = new THREE.MeshBasicMaterial({
        map: glowTexture(), color: 0xffd9a0, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      const glow = new THREE.Mesh(glowGeo, glowMat);
      // small enough to stay on a desk or cart top when the item lies on furniture
      glow.scale.setScalar(Math.max(0.5, built.footprint * 1.3));
      glow.renderOrder = 2;
      glow.visible = false;
      const haloMat = new THREE.SpriteMaterial({
        map: haloTexture(), color: 0xffe6b8, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const halo = new THREE.Sprite(haloMat);
      halo.scale.setScalar(Math.max(0.45, built.height * 1.8));
      halo.visible = false;
      built.world.visible = false;
      built.carry.visible = false;
      ctx.scene.add(built.world, glow, halo);
      this.visuals.push({
        id, where: isHeavy(id) ? 'back' : 'hand', world: built.world, carry: built.carry,
        glow, glowMat, halo, haloMat, height: built.height,
        restYaw: hash01(id) * Math.PI * 2, phase: hash01(id + '~') * Math.PI * 2,
        avatar: null, lying: false, at: new THREE.Vector3(), flyFrom: new THREE.Vector3(), hasFrom: false,
        flyT: 0, flyDur: 0, flyArc: 0, flySpin: 0, glowLevel: 0,
      });
    }
  }

  // ----------------------------------------------------------------------------------------------
  // ItemsApi
  // ----------------------------------------------------------------------------------------------
  carried(): ItemId | null {
    const w = this.ctx.world();
    return w ? this.myCarry.get(w) : null;
  }

  dropPoint(throwIt: boolean): V3 {
    const pl = this.ctx.player;
    if (!pl) return [0, 0, 0];
    const feet = pl.position;
    // Throws go where the camera looks (that is how players aim in third person); drops go in
    // front of the body.
    let fx = -Math.sin(pl.ry), fz = -Math.cos(pl.ry);
    if (throwIt) {
      this.ctx.camera.getWorldDirection(_v);
      const len = Math.hypot(_v.x, _v.z);
      if (len > 1e-3) { fx = _v.x / len; fz = _v.z / len; }
    }
    const out: V3 = throwIt ? this.throwLanding(feet, fx, fz) : this.dropLanding(feet, fx, fz);

    const item = this.carried();
    if (item && isHeavy(item)
      && NO_BUNDLE_ZONES.has(zoneAt(out[0], out[1] + 0.1, out[2]))
      && !NO_BUNDLE_ZONES.has(zoneAt(feet.x, feet.y + 0.1, feet.z))) {
      out[0] = feet.x;
      out[2] = feet.z;
      out[1] = this.ground(feet.x, feet.y, feet.z, feet.y);
    }
    // Everything the crew carries floats (rubberised bundles, wooden paddles; the drill and keys
    // are tied to cork): an item that ends up over the water rests on the surface.
    if (out[1] < 0) out[1] = 0;
    out[0] = round2(out[0]); out[1] = round2(out[1]); out[2] = round2(out[2]);
    return out;
  }

  // ----------------------------------------------------------------------------------------------
  // Per frame
  // ----------------------------------------------------------------------------------------------
  update(dt: number) {
    this.time += dt;
    const w = this.ctx.world();
    const canPick = !!w && this.canPickUp(w);
    const gearReady = !!w && this.gearReady.get(w);

    // Pass 1: release carried visuals whose carrier changed. Done before any attach so that a
    // drop + pickup by the same player in one world update never detaches the new item.
    for (const v of this.visuals) {
      if (v.avatar && v.avatar !== this.wantedAvatar(w, v.id)) this.detach(v);
    }

    // Pass 2: place every item.
    for (const v of this.visuals) {
      const st = w ? w.items[v.id] : null;
      if (!st || st.by === NOT_IN_PLAY || (st.by === '' && this.hiddenWhileLying(w!, v.id, gearReady))) {
        this.hide(v);
        continue;
      }
      if (st.by !== '') {
        const av = this.ctx.avatars.get(st.by) ?? null;
        if (av && v.avatar !== av) {
          av.attach(v.carry, v.where);
          v.avatar = av;
        }
        v.carry.visible = !!v.avatar;
        if (v.avatar) keepUnitWorldScale(v.carry);
        v.world.visible = false;
        v.lying = false;
        v.hasFrom = false; // only a detach followed by lying down starts a flight
        this.fadeHighlight(v, 0, dt);
        continue;
      }
      this.layDown(v, st.p, dt);
      this.fadeHighlight(v, canPick && !(gearReady && isHeavy(v.id)) ? this.highlightTarget(v) : 0, dt);
    }
  }

  dispose() {
    for (const v of this.visuals) {
      if (v.avatar) this.detach(v);
      v.world.removeFromParent();
      v.glow.removeFromParent();
      v.halo.removeFromParent();
      v.glowMat.dispose();
      v.haloMat.dispose();
    }
    this.visuals.length = 0;
  }

  // ----------------------------------------------------------------------------------------------
  // Visual state
  // ----------------------------------------------------------------------------------------------
  private wantedAvatar(w: WorldState | null, id: ItemId): AvatarApi | null {
    const by = w?.items[id].by;
    if (!by || by === NOT_IN_PLAY) return null;
    return this.ctx.avatars.get(by) ?? null;
  }

  /** Bundles that have turned into the raft (or into its paddles) are not drawn separately. */
  private hiddenWhileLying(w: WorldState, id: ItemId, gearReady: boolean) {
    if (id === 'bundle_raft') return gearReady || w.raft.inflate > 0 || w.raft.launched === 1;
    if (id === 'bundle_paddles') return w.raft.launched === 1;
    return false;
  }

  private canPickUp(w: WorldState) {
    const pl = this.ctx.player;
    return w.phase === 'playing' && w.players[this.ctx.myId]?.s === 'free' && !!pl && pl.mode === 'walk'
      && this.myCarry.get(w) === null;
  }

  private detach(v: Visual) {
    // remember where the item was so its drop/throw can be animated from there
    if (v.carry.parent && v.carry.visible) {
      v.carry.updateWorldMatrix(true, false);
      v.flyFrom.setFromMatrixPosition(v.carry.matrixWorld);
      v.hasFrom = true;
    }
    v.avatar!.attach(null, v.where);
    v.carry.removeFromParent();
    v.carry.visible = false;
    v.avatar = null;
  }

  private hide(v: Visual) {
    if (v.avatar) this.detach(v);
    v.hasFrom = false;
    v.lying = false;
    v.world.visible = false;
    v.glowLevel = 0;
    v.glow.visible = false;
    v.halo.visible = false;
  }

  private layDown(v: Visual, p: V3, dt: number) {
    if (!v.lying || v.at.x !== p[0] || v.at.y !== p[1] || v.at.z !== p[2]) {
      v.at.set(p[0], p[1], p[2]);
      v.flyT = v.flyDur = 0;
      if (v.hasFrom) {
        const dist = v.flyFrom.distanceTo(v.at);
        // drops, throws and the bakery-pipe drop fly; teleports (confiscation) just appear
        if (dist > 0.05 && dist < 25) {
          const horiz = Math.hypot(v.at.x - v.flyFrom.x, v.at.z - v.flyFrom.z);
          v.flyDur = Math.min(1.6, 0.22 + Math.sqrt(dist) * 0.2);
          v.flyArc = horiz > 1.5 ? Math.min(2.2, 0.25 + horiz * 0.2) : 0;
          v.flySpin = horiz > 1.5 ? (hash01(v.id) > 0.5 ? 1 : -1) * Math.PI * 1.5 : 0;
        }
      }
      v.hasFrom = false;
      v.lying = true;
    }
    v.world.visible = true;
    const o = v.world;
    if (v.flyT < v.flyDur) {
      v.flyT += dt;
      const s = Math.min(1, v.flyT / v.flyDur);
      const fall = v.at.y < v.flyFrom.y ? s * s : s; // accelerate when falling, like gravity
      o.position.set(
        v.flyFrom.x + (v.at.x - v.flyFrom.x) * s,
        v.flyFrom.y + (v.at.y - v.flyFrom.y) * fall + v.flyArc * 4 * s * (1 - s),
        v.flyFrom.z + (v.at.z - v.flyFrom.z) * s,
      );
      o.rotation.set(v.flySpin * s, v.restYaw, 0);
      return;
    }
    o.position.copy(v.at);
    if (v.at.y <= 0.05 && this.ctx.terrain.heightAt(v.at.x, v.at.z) < -0.2) {
      // floating: half submerged, bobbing and rocking on the swell
      const t = this.time + v.phase;
      o.position.y = -v.height * 0.35 + Math.sin(t * 1.4) * 0.03;
      o.rotation.set(Math.sin(t * 1.1) * 0.06, v.restYaw + Math.sin(t * 0.3) * 0.2, Math.sin(t * 0.9 + 1) * 0.06);
    } else {
      o.rotation.set(0, v.restYaw, 0);
    }
  }

  private highlightTarget(v: Visual): number {
    const pl = this.ctx.player;
    if (!pl || v.flyT < v.flyDur) return 0;
    const dx = v.at.x - pl.position.x, dz = v.at.z - pl.position.z, dy = v.at.y - pl.position.y;
    if (dy < -1.2 || dy > 1.9) return 0;
    const d = Math.hypot(dx, dz);
    if (d > HIGHLIGHT_RANGE) return 0;
    if (d <= PICKUP_RANGE) return 1;
    return 0.5 * (1 - (d - PICKUP_RANGE) / (HIGHLIGHT_RANGE - PICKUP_RANGE));
  }

  private fadeHighlight(v: Visual, target: number, dt: number) {
    v.glowLevel += (target - v.glowLevel) * Math.min(1, dt * 6);
    const on = v.glowLevel > 0.01;
    v.glow.visible = on;
    v.halo.visible = on;
    if (!on) return;
    const pulse = 0.8 + 0.2 * Math.sin(this.time * 3.4 + v.phase);
    v.glowMat.opacity = v.glowLevel * 0.85 * pulse;
    v.haloMat.opacity = v.glowLevel * 0.55 * pulse;
    v.glow.position.set(v.at.x, Math.max(v.at.y, 0.02) + 0.015, v.at.z);
    v.halo.position.set(v.at.x, Math.max(v.at.y, 0) + v.height * 0.6 + 0.05, v.at.z);
  }

  // ----------------------------------------------------------------------------------------------
  // Landing points
  // ----------------------------------------------------------------------------------------------
  /** In front of the body; never inside a wall, never off a ledge (that is what throwing is for). */
  private dropLanding(feet: THREE.Vector3, fx: number, fz: number): V3 {
    let d = DROP_AHEAD;
    const hit = this.cast(feet.x, feet.y + 0.5, feet.z, fx, 0, fz, DROP_AHEAD + 0.3);
    if (hit) d = Math.max(0, hit.timeOfImpact - 0.3);
    let x = feet.x + fx * d, z = feet.z + fz * d;
    let y = this.ground(x, feet.y + 0.3, z, feet.y);
    if (feet.y - y > 1.2 || y - feet.y > 0.6) {
      x = feet.x;
      z = feet.z;
      y = this.ground(x, feet.y, z, feet.y);
    }
    return [x, y, z];
  }

  /** Simulates a ~6 m ballistic arc in short ray-cast segments; first world hit is the landing. */
  private throwLanding(feet: THREE.Vector3, fx: number, fz: number): V3 {
    const step = 0.04;
    let px = feet.x + fx * 0.3, py = feet.y + HAND_HEIGHT, pz = feet.z + fz * 0.3;
    const h = THROW_SPEED * Math.cos(THROW_ANGLE);
    const vx = fx * h, vz = fz * h;
    let vy = THROW_SPEED * Math.sin(THROW_ANGLE);
    for (let i = 0; i < 100; i++) {
      const nx = px + vx * step, nz = pz + vz * step;
      const ny = py + vy * step - 0.5 * GRAVITY * step * step;
      vy -= GRAVITY * step;
      const sx = nx - px, sy = ny - py, sz = nz - pz;
      const len = Math.hypot(sx, sy, sz);
      const hit = this.cast(px, py, pz, sx / len, sy / len, sz / len, len);
      if (hit) {
        const k = hit.timeOfImpact / len;
        const hx = px + sx * k, hy = py + sy * k, hz = pz + sz * k;
        if (hit.normal.y > 0.55) return [hx, hy, hz];
        // hit a wall or ceiling: it drops straight down just in front of it
        const bx = hx - fx * 0.25, bz = hz - fz * 0.25;
        return [bx, this.ground(bx, hy, bz, hy), bz];
      }
      if (ny < 0 && py >= 0) {
        // splashes into the bay
        const k = py / (py - ny);
        return [px + sx * k, 0, pz + sz * k];
      }
      px = nx; py = ny; pz = nz;
    }
    return [px, this.ground(px, py, pz, py), pz];
  }

  /** Walkable surface below (x, y, z); falls back to `fallback` if the query returns garbage. */
  private ground(x: number, y: number, z: number, fallback: number): number {
    const g = this.ctx.terrain.groundAt(x, y, z);
    return Number.isFinite(g) ? g : fallback;
  }

  private cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxToi: number) {
    const r = this.ray;
    r.origin.x = ox; r.origin.y = oy; r.origin.z = oz;
    r.dir.x = dx; r.dir.y = dy; r.dir.z = dz;
    return this.ctx.physics.world.castRayAndGetNormal(
      r, maxToi, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, QUERY_WORLD_ONLY,
    );
  }
}

// ------------------------------------------------------------------------------------------------
// Visual construction
// ------------------------------------------------------------------------------------------------
interface Built { world: THREE.Group; carry: THREE.Group; height: number; footprint: number }

/**
 * Builds the lying and carried visuals of an item from the Meshy props (real-world size, pivot at
 * bottom centre). Carried visuals are centred on the attach point in the avatar's frame
 * (+Y up, -Z = character forward), so back items sit behind the spine (+Z).
 */
function buildVisual(models: ModelsApi, id: ItemId): Built {
  const world = new THREE.Group();
  const carry = new THREE.Group();
  world.name = `item:${id}`;
  carry.name = `item:${id}:carried`;
  switch (id) {
    case 'drill': {
      const lying = models.instance('drill');
      lying.rotation.x = -Math.PI / 2; // on its side
      world.add(lying);
      carry.add(models.instance('drill'));
      centreAt(carry, 0, 0, 0);
      break;
    }
    case 'keys': {
      const lying = models.instance('key_ring');
      lying.rotation.x = -Math.PI / 2; // flat on the desk
      world.add(lying);
      carry.add(models.instance('key_ring'));
      centreAt(carry, 0, 0, 0);
      break;
    }
    case 'bundle_raft': {
      // 50-odd rubberised raincoats rolled into one heavy bundle
      const lying = models.instance('raincoat_bundle');
      lying.scale.setScalar(1.5);
      lying.rotation.y = 0.4;
      world.add(lying);
      const roll = models.instance('raincoat_bundle');
      roll.scale.setScalar(1.35);
      carry.add(roll);
      centreAt(carry, 0, 0.02, 0.3);
      break;
    }
    case 'bundle_paddles': {
      // two plywood paddles with a raincoat life vest tied on top
      const a = models.instance('paddle');
      const b = models.instance('paddle');
      b.rotation.y = 0.22;
      world.add(a, b);
      stackOn(world, b, 0, 0);
      const vest = models.instance('life_vest');
      vest.rotation.x = -Math.PI / 2; // lying on its back
      vest.scale.setScalar(0.8);
      world.add(vest);
      stackOn(world, vest, 0.12, 0);

      // shafts up along the back, blades facing out, slightly crossed
      const crossed = (tilt: number, x: number, z: number) => {
        const g = new THREE.Group();
        const p = models.instance('paddle');
        p.rotation.set(0, Math.PI / 2, Math.PI / 2); // length X -> up, blade face across the back
        g.add(p);
        g.rotation.z = tilt;
        g.position.set(x, 0, z);
        return g;
      };
      const cvest = models.instance('life_vest');
      cvest.scale.setScalar(0.7);
      cvest.position.set(0, -0.15, 0.12);
      carry.add(crossed(0.18, -0.07, 0.27), crossed(-0.18, 0.07, 0.3), cvest);
      centreAt(carry, 0, 0, 0.22);
      break;
    }
    case 'bundle_concertina': {
      // the stolen concertina (the raft's bellows) strapped to a roll of spare raincoats
      const roll = models.instance('raincoat_bundle');
      roll.scale.setScalar(0.85);
      const box = models.instance('concertina');
      box.rotation.y = 0.5;
      world.add(roll, box);
      stackOn(world, box, 0, 0);
      const croll = models.instance('raincoat_bundle');
      croll.scale.setScalar(0.8);
      const cbox = models.instance('concertina');
      carry.add(croll, cbox);
      stackOn(carry, cbox, 0, 0.05);
      centreAt(carry, 0, 0, 0.26);
      break;
    }
  }
  // lying visual: bottom at y = 0, centred on x/z
  boxOf(world, null);
  const cx = (_box.min.x + _box.max.x) / 2, cz = (_box.min.z + _box.max.z) / 2, minY = _box.min.y;
  for (const c of world.children) c.position.set(c.position.x - cx, c.position.y - minY, c.position.z - cz);
  const height = Math.max(0.05, _box.max.y - _box.min.y);
  const footprint = Math.max(_box.max.x - _box.min.x, _box.max.z - _box.min.z);
  return { world, carry, height, footprint };
}

/** Local-space bounds of `group`'s children (optionally skipping one), into `_box`. */
function boxOf(group: THREE.Group, skip: THREE.Object3D | null) {
  group.updateMatrixWorld(true);
  _box.makeEmpty();
  for (const c of group.children) if (c !== skip) _box.expandByObject(c);
  if (_box.isEmpty()) _box.set(_v.set(-0.1, 0, -0.1), _s.set(0.1, 0.1, 0.1));
}

/** Puts `child` on top of the rest of the group, centred at (x, z). Group must be at identity. */
function stackOn(group: THREE.Group, child: THREE.Object3D, x: number, z: number) {
  boxOf(group, child);
  const top = _box.max.y;
  child.position.set(0, 0, 0);
  group.updateMatrixWorld(true);
  const cb = new THREE.Box3().setFromObject(child);
  child.position.set(x - (cb.min.x + cb.max.x) / 2, top - 0.02 - cb.min.y, z - (cb.min.z + cb.max.z) / 2);
}

/** Moves all children so the group's bounds are centred on (x, y, z). */
function centreAt(group: THREE.Group, x: number, y: number, z: number) {
  boxOf(group, null);
  _box.getCenter(_v);
  for (const c of group.children) c.position.set(c.position.x + x - _v.x, c.position.y + y - _v.y, c.position.z + z - _v.z);
}

/** Cancels any scale on the attach bone (Meshy rigs are often exported in centimetres). */
function keepUnitWorldScale(obj: THREE.Object3D) {
  const parent = obj.parent;
  if (!parent) return;
  parent.getWorldScale(_s);
  const sx = Math.abs(_s.x) > 1e-6 ? 1 / _s.x : 1;
  const sy = Math.abs(_s.y) > 1e-6 ? 1 / _s.y : 1;
  const sz = Math.abs(_s.z) > 1e-6 ? 1 / _s.z : 1;
  if (Math.abs(obj.scale.x - sx) > 1e-4 || Math.abs(obj.scale.y - sy) > 1e-4 || Math.abs(obj.scale.z - sz) > 1e-4) {
    obj.scale.set(sx, sy, sz);
  }
}

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

function round2(n: number) { return Math.round(n * 100) / 100; }
