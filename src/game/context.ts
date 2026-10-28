// The shared runtime context handed to every system, plus the small interfaces systems use to talk
// to each other. Systems depend on these interfaces, never on each other's classes, so modules can
// be developed and replaced independently. main.ts creates the implementations and fills `ctx`.
import type * as THREE from 'three/webgpu';
import type { Assets } from '../core/assets';
import type { Input } from '../core/input';
import type { Physics } from '../core/physics';
import type { Quality } from '../config';
import type { ClimbDef, TraverseDef } from '../world/layout';
import type { Net } from './net';
import type { ActorsNet, Fx, ItemId, PlayerNet, PrisonerAnim, V3, WorldState, ZoneId } from './types';

// ------------------------------------------------------------------------------------------------
// Physics collision groups (Rapier: 16-bit membership << 16 | 16-bit filter).
// ------------------------------------------------------------------------------------------------
export const GROUP = {
  WORLD: 0x0001,      // static level geometry (terrain, walls, floors, props)
  PLAYER: 0x0002,     // the local player's capsule
  RAFT: 0x0004,       // raft (sensor-free kinematic body)
  DOOR: 0x0008,       // removable blockers (vent grilles, utility door) - also WORLD for movement
} as const;
export function groups(membership: number, filter: number) { return (membership << 16) | filter; }
/** Collider groups for static world geometry: collides with everything. */
export const WORLD_GROUPS = groups(GROUP.WORLD, 0xffff);
/** Ray/shape query filter that hits only the world (camera collision, guard line-of-sight, ground snap). */
export const QUERY_WORLD_ONLY = groups(0xffff, GROUP.WORLD | GROUP.DOOR);

// ------------------------------------------------------------------------------------------------
// Local event bus (not networked).
// ------------------------------------------------------------------------------------------------
export interface BusEvents {
  /** host -> everyone one-off effects, re-emitted locally */
  fx: Fx;
  /** world state changed (new version received or written) */
  world: WorldState;
  /** interaction prompt for the HUD; null hides it */
  prompt: { text: string; hold: number; progress: number; key: string } | null;
  /** the local player entered a new zone */
  zone: ZoneId;
  /** a loud local noise (the local Interaction system reports it; the host's guards hear it) */
  noise: { p: V3; r: number };
  /** screen fade for teleports / traverses (0..1 target opacity, seconds) */
  fade: { to: number; duration: number };
  /** HUD toast with an already-translated message */
  toast: string;
  /** UI asks to open/close the pause menu etc. */
  ui: 'pause' | 'resume' | 'map';
}
type Handler<T> = (payload: T) => void;
export class Bus {
  private readonly handlers = new Map<keyof BusEvents, Set<Handler<never>>>();
  on<K extends keyof BusEvents>(type: K, fn: Handler<BusEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn as Handler<never>);
    return () => set!.delete(fn as Handler<never>);
  }
  emit<K extends keyof BusEvents>(type: K, payload: BusEvents[K]) {
    const set = this.handlers.get(type);
    if (set) for (const fn of set) (fn as Handler<BusEvents[K]>)(payload);
  }
}

// ------------------------------------------------------------------------------------------------
// Cross-module interfaces.
// ------------------------------------------------------------------------------------------------
/** Model library built from public/models/manifest.json (src/world/models.ts). */
export interface ModelsApi {
  has(id: string): boolean;
  /** real-world size [x, y, z] of a static model (baked by scripts/meshy/optimize.mjs) */
  size(id: string): [number, number, number] | null;
  /** clone of a static model: real-world scale, pivot at bottom centre. Placeholder box if missing. */
  instance(id: string): THREE.Object3D;
  /** one InstancedMesh per sub-mesh of a static model, placed at the given world matrices */
  instanced(id: string, matrices: THREE.Matrix4[], opts?: { castShadow?: boolean; receiveShadow?: boolean }): THREE.Object3D;
  /** skinned character clone (SkeletonUtils), scaled to its real height, with its clips */
  character(id: string): CharacterInstance;
}
export interface CharacterInstance {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  /** clips by game name: idle, walk, run, crouch, climb, pickup, swim, knockdown, sit, work (guards: idle, walk, run, torch_look, alert, grab, patrol_look) */
  clips: Map<string, THREE.AnimationClip>;
  /** bones to attach carried items to (may be null if not found) */
  hand: THREE.Object3D | null;
  back: THREE.Object3D | null;
  head: THREE.Object3D | null;
  height: number;
}

/** Animated character visual shared by the local player, remote players and guards. */
export interface AvatarApi {
  readonly root: THREE.Object3D;
  /** cross-fade to a clip by game name (no-op if already playing) */
  play(anim: string, fade?: number): void;
  /** attach a carried item visual (null = remove). 'back' for bundles, 'hand' for small items */
  attach(obj: THREE.Object3D | null, where?: 'hand' | 'back'): void;
  /** movement speed hint (m/s) so walk/run clips play at matching speed; null = clip default */
  speed: number | null;
  update(dt: number): void;
  dispose(): void;
}

/** Terrain queries (src/world/island.ts). */
export interface TerrainApi {
  /** terrain height (m) at x/z from the island heightmap (ignores buildings) */
  heightAt(x: number, z: number): number;
  /** highest walkable surface below `y + 0.5` at x/z via a physics ray (buildings, floors, terrain) */
  groundAt(x: number, y: number, z: number): number;
}

/** Light exposure for stealth (src/world/atmosphere.ts + searchlights). */
export interface LightingApi {
  /** 0 = dark, 1 = brightly lit, at a world position (lamps, searchlights, flashlights) */
  exposure(p: THREE.Vector3): number;
}

/** The local player (src/game/player/LocalPlayer.ts). */
export interface PlayerApi {
  /** feet position (interpolated, world) */
  readonly position: THREE.Vector3;
  /** yaw, 0 = facing -Z */
  readonly ry: number;
  readonly crouching: boolean;
  readonly mode: 'walk' | 'climb' | 'traverse' | 'seated' | 'frozen';
  readonly avatar: AvatarApi;
  /** forward axis input this frame (-1..1) and strafe (-1..1), for the raft */
  readonly moveInput: { x: number; z: number };
  teleport(p: V3, ry?: number): void;
  /** begin climbing a ClimbDef from the bottom (or from the top when fromTop) */
  startClimb(c: ClimbDef, fromTop: boolean): void;
  /** play a short squeeze/vault from a to b (or b to a) with a fade; resolves when done */
  startTraverse(t: TraverseDef, fromA: boolean): Promise<void>;
  /** while true the player stands still and plays the work/pickup animation */
  setWorking(on: boolean, anim?: PrisonerAnim): void;
  /** extra noise (0..1) this frame from the action being performed */
  addNoise(n: number): void;
  /** seated on the raft: movement disabled, camera handled by the raft */
  setSeated(on: boolean, anchor?: THREE.Object3D): void;
  /** freeze input (menus, being caught) */
  setFrozen(on: boolean): void;
  /** interactable id currently being held (published as PlayerNet.h for co-op progress), '' = none */
  setHolding(id: string): void;
  /** turn the body to face a world point (e.g. while working on something) */
  face(x: number, z: number): void;
  /** current network snapshot of this player */
  snapshot(): PlayerNet;
}

/** Visual + networked carried items (src/game/interact/Items.ts). */
export interface ItemsApi {
  /** world position where an item would land if dropped/thrown now by the local player */
  dropPoint(throwIt: boolean): V3;
  /** item the local player carries according to the latest world state */
  carried(): ItemId | null;
}

// ------------------------------------------------------------------------------------------------
// Context
// ------------------------------------------------------------------------------------------------
export interface Ctx {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  physics: Physics;
  assets: Assets;
  input: Input;
  quality: Quality;
  net: Net;
  bus: Bus;
  lang: 'zh' | 'en';
  /** my player id (net.myId) */
  myId: string;
  /** shared night clock in seconds (host clock; extrapolated on clients) */
  time(): number;
  /** latest world state, or null before the host created it */
  world(): WorldState | null;
  /** latest actors snapshot (guards, boat, raft) */
  actors(): ActorsNet | null;
  /** filled in by main.ts once created */
  models: ModelsApi;
  terrain: TerrainApi;
  lighting: LightingApi;
  player: PlayerApi | null;
  items: ItemsApi | null;
  /** Object3Ds that remote avatars are attached to, by player id (for item visuals, name tags) */
  avatars: Map<string, AvatarApi>;
}

/** Every per-frame system implements this. */
export interface System {
  update(dt: number): void;
  dispose?(): void;
}
