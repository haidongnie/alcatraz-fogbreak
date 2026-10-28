// The level plan: every coordinate shared between modules lives here (world space, metres,
// y = metres above sea level, sea at y = 0).
//
// Frame: produced by scripts/data/build-island.mjs from OpenStreetMap. The Main Prison (cellhouse)
// footprint centre is the origin and its long axis is +X:
//   +X = east end (administration wing, main entrance)   -X = west end (Times Square, dining hall)
//   -Z = north side (A-Block, Michigan Avenue)            +Z = south side (D-Block, library, rec yard)
// True north is roughly (-0.72, 0, -0.70) (island.json `northDir`).
//
// Cellhouse dimensions follow the Bureau of Prisons first-floor plan (docs/RESEARCH.md):
// cells 1.52 x 2.74 x 2.13 m at a 1.71 m pitch, 28 cells per side per tier in B and C,
// tiers at +0 / +2.5 / +5.1 m, block tops at +7.4 m, ceiling +9.5 m, roof +10.5 m.
import type { ItemId, V3, ZoneId } from '../game/types';

/** Cellhouse floor elevation (m above sea level). Terrain under the complex is flattened below it. */
export const FLOOR = 41.0;
export const TIER = [0, 2.5, 5.1] as const;
export const BLOCK_TOP = FLOOR + 7.4;
export const CEILING = FLOOR + 9.5;
export const ROOF = FLOOR + 10.5;
/** Dining hall / kitchen wing roof (lower than the cellhouse roof) */
export const WING_ROOF = FLOOR + 8.5;
export const CELL = { width: 1.52, depth: 2.74, height: 2.13, pitch: 1.707, wall: 0.18 };

/** Main Prison outer footprint (OSM way 128245373), closed polygon in (x, z). */
export const CELLHOUSE_POLY: [number, number][] = [
  [-32.51, 11.05], [-32.53, 16.44], [-32.56, 24.61], [15.52, 24.61], [15.56, 13.55], [32.43, 13.54],
  [32.43, 10.27], [32.56, -24.61], [-15.37, -24.59], [-15.4, -14.24], [-32.42, -14.24], [-32.44, -9.01],
];
/** Exterior wall thickness; interior faces are this far inside CELLHOUSE_POLY. */
export const WALL = 0.45;

// ------------------------------------------------------------------------------------------------
// Cell blocks. Each block is an axis-aligned box [x0,x1] x [zNorth,zSouth].
// Double-sided blocks have a utility corridor (pipe chase) between the two cell rows.
// ------------------------------------------------------------------------------------------------
export type BlockId = 'A' | 'B' | 'C' | 'D';
export interface BlockDef {
  id: BlockId;
  x0: number; x1: number;
  zNorth: number; zSouth: number;
  /** which faces have cells opening onto an aisle */
  faces: ('north' | 'south')[];
  /** utility corridor z range (double-sided blocks) */
  utility?: [number, number];
  cellsPerFace: number;
  /** x of the west edge of cell 0 */
  cellX0: number;
  pitch: number;
  tiers: number;
  /** A-Block is the old 1912 block, used for storage in 1962: darker, flat-strap bars, no lights */
  style: 'modern' | 'old' | 'treatment';
}

export const BLOCKS: BlockDef[] = [
  { id: 'A', x0: -14.0, x1: 30.0, zNorth: -20.2, zSouth: -13.2, faces: ['north', 'south'], utility: [-17.36, -16.04],
    cellsPerFace: 24, cellX0: -12.3, pitch: 1.707, tiers: 3, style: 'old' },
  { id: 'B', x0: -25.5, x1: 27.5, zNorth: -9.0, zSouth: -2.1, faces: ['north', 'south'], utility: [-6.26, -4.84],
    cellsPerFace: 28, cellX0: -22.9, pitch: 1.707, tiers: 3, style: 'modern' },
  { id: 'C', x0: -25.5, x1: 27.5, zNorth: 3.0, zSouth: 9.9, faces: ['north', 'south'], utility: [5.74, 7.16],
    cellsPerFace: 28, cellX0: -22.9, pitch: 1.707, tiers: 3, style: 'modern' },
  // D-Block "Treatment Unit": single-sided, cells back onto a wall facing Park Avenue, open south.
  { id: 'D', x0: -31.0, x1: -1.6, zNorth: 14.1, zSouth: 17.1, faces: ['south'],
    cellsPerFace: 14, cellX0: -31.0, pitch: 2.1, tiers: 3, style: 'treatment' },
];
export const blockById = (id: BlockId) => BLOCKS.find((b) => b.id === id)!;

/** centre x of cell `i` (0 = westmost) in a block */
export function cellCenterX(block: BlockDef, i: number) {
  return block.cellX0 + block.pitch * (i + 0.5);
}

/** Aisles, for lighting / signage / nav. Boxes [x0, z0, x1, z1]. */
export const AISLES: Record<string, [number, number, number, number]> = {
  northAisle: [-15.0, -24.15, 32.1, -20.2],
  michigan: [-32.0, -13.2, 32.1, -9.0],      // "Michigan Avenue" (A/B)
  broadway: [-32.0, -2.1, 32.1, 3.0],        // "Broadway" (B/C), main aisle
  park: [-31.0, 9.9, 32.1, 14.1],            // "Park Avenue" (C/D), toward the library
  sunset: [-32.0, 17.1, 0.5, 24.15],         // "Sunset Strip" (D-Block front)
  timesSquare: [-32.0, -13.8, -25.5, 24.15], // west end, under the clock
  eastEnd: [27.5, -24.15, 32.0, 13.1],       // east end: cutoff gate + desk
};

/** Gun galleries: caged catwalks at +2.5 and +5.1 along the end walls. Boxes [x0, z0, x1, z1]. */
export const GUN_GALLERIES = {
  west: { box: [-32.0, -13.8, -30.3, 24.15] as [number, number, number, number], levels: [FLOOR + 2.5, FLOOR + 5.1] },
  east: { box: [30.3, -24.15, 32.0, 13.1] as [number, number, number, number], levels: [FLOOR + 2.5, FLOOR + 5.1] },
};

/** Library: east end of Park Avenue, beside D-Block. Door gap in its north wall. */
export const LIBRARY = { box: [0.5, 14.4, 15.0, 24.15] as [number, number, number, number], door: [4.0, 6.0] as [number, number] };
/** Clock over the dining hall door (west wall, on Broadway's axis) */
export const DINING_DOOR: V3 = [-32.05, FLOOR, 0.45];
export const CLOCK: V3 = [-31.9, FLOOR + 3.6, 0.45];

// ------------------------------------------------------------------------------------------------
// Player cells: B-Block flats, Michigan Avenue side (real cells of the 1962 escapees).
// Cell interior: x in [cx - 0.76, cx + 0.76], z in [-9.0 (bars), -6.26 (back wall + vent)].
// ------------------------------------------------------------------------------------------------
export interface PlayerCell {
  slot: number;
  label: string;
  cellIndex: number;
  center: V3;
  spawn: V3;
  /** yaw at spawn: facing the back wall (+Z) */
  spawnRy: number;
  bunk: V3;          // bunk model origin (bottom centre), long axis along z
  dummy: V3;         // where the dummy head goes (pillow)
  sink: V3;
  toilet: V3;
  table: V3;
  /** vent grille centre on the back wall (interior side) */
  vent: V3;
  /** standing point in the utility corridor behind the vent */
  ventOut: V3;
}

const B = BLOCKS[1];
function playerCell(slot: number, cellIndex: number, label: string): PlayerCell {
  const cx = cellCenterX(B, cellIndex);
  return {
    slot, label, cellIndex,
    center: [cx, FLOOR, -7.63],
    spawn: [cx + 0.15, FLOOR, -7.9],
    spawnRy: Math.PI,
    bunk: [cx - 0.38, FLOOR, -7.62],
    dummy: [cx - 0.38, FLOOR + 0.62, -6.75],
    sink: [cx + 0.42, FLOOR + 0.62, -6.48],
    toilet: [cx + 0.42, FLOOR, -6.55],
    table: [cx + 0.6, FLOOR + 0.55, -8.2],
    vent: [cx + 0.1, FLOOR + 0.22, -6.27],
    ventOut: [cx + 0.1, FLOOR, -5.55],
  };
}
/** slot -> cell. B-1xx numbering on the Michigan Avenue face runs east -> west from B-129. */
export const PLAYER_CELLS: PlayerCell[] = [
  playerCell(0, 18, 'B-138'),
  playerCell(1, 16, 'B-140'),
  playerCell(2, 6, 'B-150'),
  playerCell(3, 4, 'B-152'),
];

/** "The Hole": D-Block ground tier cells D-11..D-14 (one per slot). */
export interface HoleCell { slot: number; label: string; inside: V3; door: V3; }
const D = BLOCKS[3];
export const HOLE_CELLS: HoleCell[] = [10, 11, 12, 13].map((j, slot) => {
  const x = cellCenterX(D, j);
  return { slot, label: `D-${j + 1}`, inside: [x, FLOOR, 15.5] as V3, door: [x, FLOOR, 17.7] as V3 };
});

// ------------------------------------------------------------------------------------------------
// Escape route anchors.
// ------------------------------------------------------------------------------------------------
/** Utility corridor of B-Block: x range, z centre line. */
export const UTILITY_B = { x0: -25.3, x1: 27.3, z: -5.55, z0: -6.26, z1: -4.84 };
/** Locked steel door at the west end of B's utility corridor, opening onto Times Square.
 *  Once the `utility_door` flag is set the door swings open and its collider is removed. */
export const UTILITY_DOOR = { inside: [-24.9, FLOOR, -5.55] as V3, outside: [-26.3, FLOOR, -5.55] as V3, x: -25.5 };
/** Pipes the crew climbs inside the utility corridor (bottom -> top of block). */
export const UTILITY_CLIMB = { x: -14.2, z: -5.55, bottom: FLOOR, top: BLOCK_TOP };
/** Workshop on top of B-Block around the dead fan housing (box [x0, z0, x1, z1] at BLOCK_TOP). */
export const WORKSHOP = { box: [-20.0, -9.0, -8.0, -2.1] as [number, number, number, number], y: BLOCK_TOP };
/** Ventilator shaft above the workshop: bars drilled here, then up onto the roof. */
export const ROOF_VENT = { below: [-14.2, BLOCK_TOP, -3.6] as V3, roof: [-14.2, ROOF, -2.4] as V3, shaft: [-14.2, -3.6] as [number, number] };
/** Kitchen/bakery vent pipe on the north wall of the kitchen wing (15+ m slide to the service yard). */
export const BAKERY_PIPE = { x: -79.5, z: -9.6, top: WING_ROOF, bottom: 33.0, roofStand: [-79.5, WING_ROOF, -8.6] as V3, groundStand: [-79.5, 33.0, -10.6] as V3 };
/** Fenced service yard where the pipe lands; the double fence on its north side is climbed. */
export const SERVICE_YARD = { box: [-94.0, -26.0, -62.0, -9.2] as [number, number, number, number], y: 33.0 };
export const FENCE = { x0: -94.0, x1: -62.0, z: -26.0, height: 3.7, climbIn: [-78.0, 33.0, -25.2] as V3, climbOut: [-78.0, 32.6, -27.4] as V3 };
/** Launch site: north-east shore in the lee of the power house (searchlight blind spot). */
export const LAUNCH = { p: [-214.0, 1.2, -50.0] as V3, radius: 7.0, raftSpawn: [-219.0, 0.1, -63.0] as V3, raftRy: 0.55, seaDir: [-0.15, 0, -0.99] as V3 };

/** Where items start. Bundles start in the workshop on top of B-Block. */
export const ITEM_SPAWNS: Record<ItemId, V3> = {
  drill: [11.2, FLOOR + 0.62, 20.4],              // library book cart
  keys: [29.8, FLOOR + 0.78, 0.4],                // guard desk at the east end
  bundle_raft: [-17.6, BLOCK_TOP, -7.4],
  bundle_paddles: [-16.4, BLOCK_TOP, -8.2],
  bundle_concertina: [-18.8, BLOCK_TOP, -3.2],
};
export const BOOK_CART: V3 = [11.2, FLOOR, 20.4];
export const GUARD_DESK: V3 = [29.8, FLOOR, 0.4];

// ------------------------------------------------------------------------------------------------
// Movement helpers: climbs (ladder-like) and traverses (squeeze/vault with a short fade).
// ------------------------------------------------------------------------------------------------
export interface ClimbDef {
  id: string;
  /** foot position at the bottom and at the top exit */
  bottom: V3;
  top: V3;
  /** where the player stands after leaving at the top / bottom */
  exitTop: V3;
  exitBottom: V3;
  /** yaw the player faces while climbing */
  ry: number;
  /** world flag that must be 1 before the climb can be used (optional) */
  requires?: string;
  /** heavy items (bundles) are dropped to exitBottom when starting this climb from the top */
  dropHeavyTo?: V3;
}
export const CLIMBS: ClimbDef[] = [
  { id: 'utility_pipes', bottom: [UTILITY_CLIMB.x, FLOOR, -5.55], top: [UTILITY_CLIMB.x, BLOCK_TOP, -5.55],
    exitTop: [UTILITY_CLIMB.x, BLOCK_TOP, -4.0], exitBottom: [UTILITY_CLIMB.x + 0.8, FLOOR, -5.55], ry: Math.PI },
  { id: 'bakery_pipe', bottom: [BAKERY_PIPE.x, BAKERY_PIPE.bottom, -10.2], top: [BAKERY_PIPE.x, BAKERY_PIPE.top, -10.2],
    exitTop: BAKERY_PIPE.roofStand, exitBottom: BAKERY_PIPE.groundStand, ry: 0, dropHeavyTo: [-78.4, 33.0, -11.2] },
];

export interface TraverseDef {
  id: string;
  a: V3;
  b: V3;
  /** seconds of hold to perform */
  hold: number;
  /** world flag required (e.g. the vent of that cell must be open) */
  requires?: string;
  /** only this slot may use it (own cell vent) */
  slot?: number;
  /** i18n prompt key */
  prompt: string;
  noise: number;
  /** can be used while carrying a bundle */
  allowHeavy: boolean;
}
export const TRAVERSES: TraverseDef[] = [
  ...PLAYER_CELLS.map((c): TraverseDef => ({
    id: `crawl:${c.slot}`, a: [c.vent[0], FLOOR, -6.75], b: c.ventOut, hold: 0.8, requires: `vent:${c.slot}`,
    prompt: 'prompt.crawl', noise: 0.1, allowHeavy: false,
  })),
  { id: 'roof_hatch', a: ROOF_VENT.below, b: ROOF_VENT.roof, hold: 1.2, requires: 'roof_vent',
    prompt: 'prompt.roof', noise: 0.2, allowHeavy: true },
  { id: 'fence', a: FENCE.climbIn, b: FENCE.climbOut, hold: 3.0, prompt: 'prompt.fence', noise: 0.6, allowHeavy: true },
];

// ------------------------------------------------------------------------------------------------
// Zones: first box that contains the point wins. Boxes are [x0, y0, z0, x1, y1, z1].
// ------------------------------------------------------------------------------------------------
export const ZONES: { id: ZoneId; box: [number, number, number, number, number, number] }[] = [
  ...PLAYER_CELLS.map((c) => ({ id: 'cell' as ZoneId, box: [c.center[0] - 0.76, FLOOR - 1, -9.0, c.center[0] + 0.76, FLOOR + 2.2, -6.26] as [number, number, number, number, number, number] })),
  { id: 'utility', box: [UTILITY_B.x0, FLOOR - 1, UTILITY_B.z0, UTILITY_B.x1, BLOCK_TOP - 0.2, UTILITY_B.z1] },
  { id: 'workshop', box: [-25.5, BLOCK_TOP - 0.3, -9.0, 27.5, CEILING, -2.1] },
  { id: 'dblock', box: [-31.0, FLOOR - 1, 14.1, -1.6, FLOOR + 7.5, 17.1] },
  { id: 'floor', box: [-32.6, FLOOR - 1, -24.7, 32.6, CEILING, 24.7] },
  { id: 'roof', box: [-90.0, WING_ROOF - 1.5, -26.0, 33.0, ROOF + 4, 26.0] },
  { id: 'yard', box: [SERVICE_YARD.box[0], 25, SERVICE_YARD.box[1], SERVICE_YARD.box[2], 40, SERVICE_YARD.box[3]] },
  { id: 'shore', box: [LAUNCH.p[0] - 25, -2, LAUNCH.p[2] - 20, LAUNCH.p[0] + 25, 8, LAUNCH.p[2] + 15] },
];
export function zoneAt(x: number, y: number, z: number): ZoneId {
  for (const zn of ZONES) {
    const b = zn.box;
    if (x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] && z <= b[5]) return zn.id;
  }
  return y < 0.3 ? 'water' : 'outside';
}

// ------------------------------------------------------------------------------------------------
// Guards. Routes are loops of waypoints (feet positions); `pause` seconds at each waypoint.
// `minAlarm`: guard only spawns once the alarm level reaches it. Nav graph below for chases.
// ------------------------------------------------------------------------------------------------
export interface GuardDef {
  name: string;
  area: 'cellhouse' | 'gallery' | 'outside';
  route: V3[];
  pause: number;
  flashlight: boolean;
  minAlarm: number;
  /** this officer walks the B-Block flats during counts */
  counts?: boolean;
}
const F = FLOOR;
export const GUARDS: GuardDef[] = [
  { name: 'Broadway officer', area: 'cellhouse', flashlight: true, minAlarm: 0, pause: 3,
    route: [[-28.5, F, 0.4], [-6, F, 0.4], [14, F, 0.4], [29, F, 0.4], [14, F, 0.6], [-6, F, 0.6]] },
  { name: 'Block officer', area: 'cellhouse', flashlight: true, minAlarm: 0, pause: 2, counts: true,
    route: [[-28.5, F, -11.1], [0, F, -11.1], [28.8, F, -11.1], [28.8, F, 12.0], [0, F, 12.0], [-28.5, F, 12.0]] },
  { name: 'West gallery officer', area: 'gallery', flashlight: false, minAlarm: 0, pause: 5,
    route: [[-31.15, F + 2.5, -12.5], [-31.15, F + 2.5, 5], [-31.15, F + 2.5, 22.5], [-31.15, F + 2.5, 5]] },
  { name: 'D-Block officer', area: 'cellhouse', flashlight: true, minAlarm: 1, pause: 3,
    route: [[-29, F, 20.5], [-1, F, 20.5], [8, F, 12.2], [-29, F, 12.2]] },
  { name: 'North road patrol', area: 'outside', flashlight: true, minAlarm: 0, pause: 4,
    route: [[-100, 31.5, -34], [-128, 26, -30], [-160, 17, -36], [-188, 13, -44], [-160, 17, -36], [-128, 26, -30]] },
  { name: 'Shore patrol', area: 'outside', flashlight: true, minAlarm: 2, pause: 3,
    route: [[-196, 10, -46], [-226, 3, -44], [-236, 3, -30], [-226, 3, -44]] },
];

/** Waypoint graph for chases/investigation inside the cellhouse (floor level). */
export const NAV_NODES: Record<string, V3> = {
  ts_n: [-28.5, F, -11.1], ts_b: [-28.5, F, 0.4], ts_p: [-28.5, F, 12.0], ts_s: [-28.5, F, 20.5],
  mi_w: [-24, F, -11.1], mi_m: [0, F, -11.1], mi_e: [26.5, F, -11.1],
  br_w: [-24, F, 0.4], br_m: [0, F, 0.4], br_e: [26.5, F, 0.4],
  pa_w: [-24, F, 12.0], pa_m: [0, F, 12.0], pa_e: [26.5, F, 12.0],
  ee_n: [29.0, F, -11.1], ee_b: [29.0, F, 0.4], ee_p: [29.0, F, 12.0],
  ss_w: [-24, F, 20.5], ss_e: [-1, F, 20.5],
  lib_door: [5.0, F, 13.4], lib_in: [8.0, F, 18.5],
  ut_door: [-26.3, F, -5.55],
};
export const NAV_EDGES: [string, string][] = [
  ['ts_n', 'ts_b'], ['ts_b', 'ts_p'], ['ts_p', 'ts_s'], ['ts_n', 'mi_w'], ['ts_b', 'br_w'], ['ts_p', 'pa_w'], ['ts_s', 'ss_w'],
  ['mi_w', 'mi_m'], ['mi_m', 'mi_e'], ['mi_e', 'ee_n'], ['br_w', 'br_m'], ['br_m', 'br_e'], ['br_e', 'ee_b'],
  ['pa_w', 'pa_m'], ['pa_m', 'pa_e'], ['pa_e', 'ee_p'], ['ee_n', 'ee_b'], ['ee_b', 'ee_p'], ['ss_w', 'ss_e'],
  ['pa_m', 'lib_door'], ['lib_door', 'lib_in'], ['ts_b', 'ut_door'], ['ts_n', 'ut_door'],
];

// ------------------------------------------------------------------------------------------------
// Searchlights on the gun towers (sweeping deterministically from the host clock).
// yaw: 0 = facing -Z, positive = counter-clockwise seen from above (three.js rotation.y).
// ------------------------------------------------------------------------------------------------
export interface SearchlightDef {
  name: string;
  /** tower base (ground) position; the lamp sits `height` above it */
  tower: V3;
  height: number;
  /** centre yaw of the sweep, half-angle amplitude, period (s), downward pitch (rad) */
  yaw: number; amp: number; period: number; pitch: number;
  range: number;
}
export const SEARCHLIGHTS: SearchlightDef[] = [
  // Hill tower above the New Industries building: rakes the cellhouse roof and the north slope.
  { name: 'Hill Tower', tower: [-112, 31, 22], height: 11, yaw: -0.89, amp: 0.9, period: 26, pitch: 0.22, range: 120 },
  // Model Roof tower on the Model Industries building (north-west tip): sweeps the north-east shore.
  { name: 'Model Roof Tower', tower: [-250, 10.5, 44], height: 4, yaw: -0.45, amp: 0.7, period: 21, pitch: 0.12, range: 140 },
  // Dock tower (OSM): faces the bay north of the dock.
  { name: 'Dock Tower', tower: [33.6, 1.0, -106.4], height: 11, yaw: 0.3, amp: 1.0, period: 30, pitch: 0.08, range: 160 },
];

/** Patrol boat loop offshore (y = sea level). */
export const BOAT_ROUTE: V3[] = [[-40, 0, -175], [-250, 0, -205], [-390, 0, -110], [-360, 0, 30], [-255, 0, -120]];

/** Light anchors for the pooled point lights (cellhouse night lights + yard lamps). */
export interface LightAnchor { p: V3; color: number; intensity: number; distance: number; }
export const LIGHT_ANCHORS: LightAnchor[] = [
  ...[-24, -12, 0, 12, 24].map((x): LightAnchor => ({ p: [x, CEILING - 0.6, 0.45], color: 0xcfe3ff, intensity: 18, distance: 16 })),
  ...[-24, 0, 24].map((x): LightAnchor => ({ p: [x, CEILING - 0.6, -11.1], color: 0xcfe3ff, intensity: 10, distance: 13 })),
  ...[-24, 0, 24].map((x): LightAnchor => ({ p: [x, CEILING - 0.6, 12.0], color: 0xcfe3ff, intensity: 10, distance: 13 })),
  { p: [-29, F + 4.5, 0.45], color: 0xffe2b0, intensity: 14, distance: 14 },   // Times Square
  { p: [8, F + 3.0, 19.5], color: 0xffd9a0, intensity: 8, distance: 10 },       // library desk lamp
  { p: [29.8, F + 2.2, 0.4], color: 0xffd9a0, intensity: 8, distance: 9 },      // guard desk
  { p: [-78, 37.5, -17], color: 0xffa95a, intensity: 30, distance: 22 },        // service yard sodium lamp
  { p: [-150, 21, -36], color: 0xffa95a, intensity: 30, distance: 24 },         // road lamp
  { p: [-200, 15, -40], color: 0xffa95a, intensity: 30, distance: 24 },         // power house lamp
];

/** Toward Angel Island (Point Blunt, bearing 7 deg, 2.8 km). Reaching TUNING.fogBankDistance from LAUNCH wins. */
export const ANGEL_ISLAND_DIR: V3 = [-0.627, 0, -0.779];
/** Ebb current (W/SW toward the Golden Gate), m/s in world x/z. */
export const EBB_CURRENT: [number, number] = [-0.13, 0.33];

/** yaw convention used everywhere: direction = (-sin(yaw), 0, -cos(yaw)); 0 faces -Z. */
export function yawToDir(yaw: number): [number, number] { return [-Math.sin(yaw), -Math.cos(yaw)]; }
export function dirToYaw(dx: number, dz: number): number { return Math.atan2(-dx, -dz); }
