// Shared data contracts. Everything that crosses the network is plain JSON built from these types.
// Keep property names short: they are sent many times per second.

export type V3 = [number, number, number];

/** Character model id == Meshy asset id. Slot index (0-3) picks the character and the cell. */
export const CHARACTER_IDS = ['prisoner_a', 'prisoner_b', 'prisoner_c', 'prisoner_d'] as const;
export type CharacterId = (typeof CHARACTER_IDS)[number];

/** Animation clip names present in every character GLB (see scripts/meshy/assets.json). */
export type PrisonerAnim =
  | 'idle' | 'walk' | 'run' | 'crouch' | 'climb' | 'pickup' | 'swim' | 'knockdown' | 'sit' | 'work';
export type GuardAnim = 'idle' | 'walk' | 'run' | 'torch_look' | 'alert' | 'grab' | 'patrol_look';

/** Coarse area a player is in (client-computed from layout volumes; used by UI and guards). */
export type ZoneId =
  | 'cell' | 'utility' | 'workshop' | 'floor' | 'dblock' | 'roof' | 'yard' | 'shore' | 'water' | 'raft' | 'outside';

// ------------------------------------------------------------------------------------------------
// Player-owned state: key 'p', unreliable, ~12 Hz. Each client writes only its own.
// ------------------------------------------------------------------------------------------------
export interface PlayerNet {
  /** feet position */
  p: V3;
  /** yaw (radians, 0 = facing -Z) */
  ry: number;
  /** animation clip to play */
  a: PrisonerAnim;
  /** current self-made noise 0..1 (movement, work); host uses it for guard hearing */
  n: number;
  /** crouching */
  cr: 0 | 1;
  /** zone the client believes it is in */
  z: ZoneId;
  /** interactable id currently being held (co-op hold progress), or '' */
  h: string;
  /** playing the concertina */
  m: 0 | 1;
  /** raft paddling input while aboard: forward -1..1, steer -1..1 (host integrates the raft) */
  rw?: [number, number];
}

// ------------------------------------------------------------------------------------------------
// Host-owned world state: key 'w', reliable, written only by the host when something changes.
// ------------------------------------------------------------------------------------------------
export type Phase = 'briefing' | 'playing' | 'won' | 'lost';

export type ChapterId = 'lights_out' | 'utility' | 'drill' | 'roof' | 'descent' | 'bay';
export const CHAPTERS: ChapterId[] = ['lights_out', 'utility', 'drill', 'roof', 'descent', 'bay'];

/** Carryable items. Bundles are the 3 raft-gear bundles that must reach the launch site. */
export type ItemId = 'drill' | 'keys' | 'bundle_raft' | 'bundle_paddles' | 'bundle_concertina';
export const ITEM_IDS: ItemId[] = ['drill', 'keys', 'bundle_raft', 'bundle_paddles', 'bundle_concertina'];
export const BUNDLE_IDS: ItemId[] = ['bundle_raft', 'bundle_paddles', 'bundle_concertina'];

export interface ItemState {
  /** player id carrying it, or '' when lying in the world */
  by: string;
  /** world position when not carried (feet level of the item) */
  p: V3;
}

export type PlayerStatusKind = 'free' | 'hole' | 'aboard' | 'escaped' | 'left_behind';
export interface PlayerStatus {
  s: PlayerStatusKind;
  /** slot 0..3 (character + cell) */
  slot: number;
  /** game time (s) at which an auto-release from the hole happens */
  until?: number;
  /** number of times caught */
  caught: number;
}

export interface RaftState {
  /** 0..1 inflation progress */
  inflate: number;
  launched: 0 | 1;
  /** pose before launch (after launch the live pose is ActorsNet.r) */
  p: V3;
  ry: number;
  /** distance travelled from the launch point (m), updated by the host ~1 Hz */
  dist: number;
}

export interface WorldState {
  /** bumped on every write */
  v: number;
  phase: Phase;
  chapter: ChapterId;
  /** host game clock (s) when the night started (briefing -> playing) */
  startT: number;
  players: Record<string, PlayerStatus>;
  /**
   * Progress flags. Keys are documented in src/game/rules.ts (e.g. `dummy:<slot>`, `vent:<slot>`,
   * `utility_door`, `roof_vent`, `fence`). Values: 1 = done, or 0..1 progress for long tasks.
   */
  flags: Record<string, number>;
  items: Record<ItemId, ItemState>;
  /** 0..3 */
  alarm: number;
  /** game time (s) of the next count */
  nextCount: number;
  raft: RaftState;
  /** why the mission was lost (i18n key) */
  lostReason?: string;
  stats: { caught: number; counts: number; alarmsRaised: number; endT?: number };
}

// ------------------------------------------------------------------------------------------------
// Host-simulated actors: key 'g', unreliable, ~10 Hz.
// ------------------------------------------------------------------------------------------------
export type GuardMode = 'patrol' | 'suspicious' | 'investigate' | 'chase' | 'return' | 'count';
export interface GuardNet {
  /** stable index into layout.guards */
  i: number;
  p: V3;
  ry: number;
  a: GuardAnim;
  m: GuardMode;
  /** suspicion 0..1 */
  s: number;
  /** player id being chased/watched, or '' */
  t: string;
  /** flashlight on */
  f: 0 | 1;
}
export interface ActorsNet {
  /** host game clock (s); clients extrapolate from it */
  t: number;
  g: GuardNet[];
  /** patrol boat: x, z, yaw */
  b: [number, number, number];
  /** raft pose once launched: x, z, yaw, distance from the launch point */
  r?: [number, number, number, number];
}

// ------------------------------------------------------------------------------------------------
// RPC payloads.
// ------------------------------------------------------------------------------------------------
/** client -> host requests ('act'). The host validates every one of them in rules.ts. */
export type Action =
  | { k: 'start' }                                  // leave the briefing, start the night (host or anyone)
  | { k: 'interact'; id: string }                   // a hold-interaction completed on the client
  | { k: 'progress'; id: string; amount: number }   // partial progress on a shared long task (inflate)
  | { k: 'pickup'; item: ItemId }
  | { k: 'drop'; item: ItemId; p: V3 }
  | { k: 'throw'; item: ItemId; p: V3 }             // p = landing point computed by the client
  | { k: 'board' }
  | { k: 'noise'; p: V3; r: number }                // loud one-off noise (clang, fall)
  | { k: 'restart' };

/** host -> everyone one-off effects ('fx'). */
export type Fx =
  | { k: 'toast'; key: string; args?: Record<string, string | number> }
  | { k: 'chapter'; chapter: ChapterId }
  | { k: 'caught'; pid: string; by: number }
  | { k: 'freed'; pid: string; by: string }
  | { k: 'alarm'; level: number }
  | { k: 'count'; phase: 'start' | 'end' }
  | { k: 'sfx'; id: SfxId; p?: V3 }
  | { k: 'won' }
  | { k: 'lost'; reason: string };

export type SfxId =
  | 'grille' | 'drill' | 'clang' | 'door' | 'pickup' | 'drop' | 'whistle' | 'alarm_bell' | 'foghorn'
  | 'splash' | 'fence' | 'inflate' | 'count_bell' | 'cell_door';
