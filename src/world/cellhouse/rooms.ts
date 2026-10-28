// Cellhouse interior spaces outside the blocks: the two gun galleries (caged two-level catwalks),
// Times Square (wall clock over the dining-hall door), the library (closed stacks, desk, book cart),
// the east end (guard desk, locker, mop bucket), painted aisle signs, the steel roof trusses and
// the light fixtures (emissive only; the real lights are the atmosphere's pooled point lights).
import * as THREE from 'three/webgpu';
import {
  BOOK_CART, CEILING, CLOCK, D_GAP_WALL, FLOOR, GUARD_DESK, GUN_GALLERIES, LIBRARY, LIGHT_ANCHORS, ROOF,
} from '../layout';
import { rng } from './batch';
import type { MatDef } from './materials';
import { interiorZ } from './shell';
import { SIGN_ROWS } from './textures';
import { modelSize, placeModel, type Kit } from './kit';

export function buildRooms(kit: Kit, nightLights: [number, number, number][]) {
  buildGallery(kit, GUN_GALLERIES.west.box, GUN_GALLERIES.west.levels, 'west');
  buildGallery(kit, GUN_GALLERIES.east.box, GUN_GALLERIES.east.levels, 'east');
  buildTimesSquare(kit);
  buildLibrary(kit);
  buildEastEnd(kit);
  buildSigns(kit);
  buildTrusses(kit);
  buildFixtures(kit, nightLights);
}

// ------------------------------------------------------------------------------------------------
// Gun galleries
// ------------------------------------------------------------------------------------------------
function buildGallery(kit: Kit, box: [number, number, number, number], levels: number[], side: 'west' | 'east') {
  const { batch, mats, cols } = kit;
  const [x0, z0, x1, z1] = box;
  const front = side === 'west' ? x1 : x0;
  const wall = side === 'west' ? x0 : x1;
  const out = side === 'west' ? 1 : -1; // from the wall toward the hall
  const yBottom = FLOOR + 2.2;
  for (const L of levels) {
    batch.boxMM(mats.darkSteel, x0, L - 0.08, z0, x1, L, z1);
    batch.boxMM(mats.darkSteel, front - out * 0.03, L - 0.3, z0, front, L + 0.12, z1); // fascia + toe board
    cols.mm(x0, L - 0.08, z0, x1, L, z1);
  }
  // caged front: vertical bars every 0.2 m and flat bands
  for (let z = z0 + 0.1; z < z1; z += 0.2) batch.cyl(mats.darkSteel, [front, yBottom, z], [front, CEILING, z], 0.013, 5, true);
  for (const y of [yBottom, FLOOR + 3.8, FLOOR + 6.4, FLOOR + 7.7, FLOOR + 8.9, CEILING - 0.06]) {
    batch.boxMM(mats.darkSteel, front - 0.025, y - 0.025, z0, front + 0.025, y + 0.025, z1);
  }
  // wall brackets under the lower deck, ladder between the levels at the far end
  for (let z = z0 + 1.0; z < z1; z += 3.0) {
    batch.beam(mats.darkSteel, [wall, FLOOR + 1.5, z], [front, levels[0] - 0.08, z], 0.08, 0.1);
  }
  const lz = side === 'west' ? z0 + 0.6 : z1 - 0.6, lx = wall + out * 0.35;
  for (const dz of [-0.22, 0.22]) batch.cyl(mats.darkSteel, [lx, levels[0], lz + dz], [lx, levels[1] + 1.0, lz + dz], 0.02, 6);
  for (let y = levels[0] + 0.3; y < levels[1]; y += 0.3) batch.cyl(mats.darkSteel, [lx, y, lz - 0.22], [lx, y, lz + 0.22], 0.012, 5, true);
  // colliders: a low curb at the lower deck edge and the full upper cage, so the gallery officer's
  // line of sight down onto the floor stays open while players cannot jump into the cage
  cols.mm(front - out * 0.03, yBottom, z0, front + out * 0.02, levels[0] + 0.12, z1);
  cols.mm(front - out * 0.03, levels[1] - 0.15, z0, front + out * 0.02, CEILING, z1);
}

// ------------------------------------------------------------------------------------------------
// Times Square
// ------------------------------------------------------------------------------------------------
function buildTimesSquare(kit: Kit) {
  const { batch, mats } = kit;
  const s = 1.6;
  const size = modelSize(kit, 'wall_clock', [0.55, 0.548, 0.065]);
  // CLOCK is the dial centre; the model's pivot is its bottom centre and it faces +Z -> rotate to +X
  placeModel(kit, 'wall_clock', CLOCK[0], CLOCK[1] - (size[1] * s) / 2, CLOCK[2], Math.PI / 2, s);
  batch.boxMM(mats.darkSteel, -32.05, CLOCK[1] - 0.05, CLOCK[2] - 0.05, CLOCK[0] - 0.03, CLOCK[1] + 0.05, CLOCK[2] + 0.05);
}

// ------------------------------------------------------------------------------------------------
// Library
// ------------------------------------------------------------------------------------------------
const LIB_WEST_DOOR: [number, number] = [18.2, 20.0];

function buildLibrary(kit: Kit) {
  const { batch, mats, cols } = kit;
  const [x0, z0, x1, z1] = LIBRARY.box;
  const t = 0.2, doorH = FLOOR + 2.4;
  const [d0, d1] = LIBRARY.door;
  const xe = 15.1; // interior face of the exterior wall
  const zs = 24.2;
  // north wall (door gap toward Park Avenue)
  const wallPiece = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    batch.boxMM(mats.wall, ax, ay, az, bx, by, bz);
    cols.mm(ax, ay, az, bx, by, bz);
  };
  wallPiece(x0, FLOOR, z0, d0, CEILING, z0 + t);
  wallPiece(d1, FLOOR, z0, xe, CEILING, z0 + t);
  wallPiece(d0, doorH, z0, d1, CEILING, z0 + t);
  // the gap between D-Block's east end and the library: wall + a locked steel door (both faces)
  {
    const [gx0, gz0, gx1, gz1] = D_GAP_WALL;
    wallPiece(gx0, FLOOR, gz0, gx1, CEILING, gz1);
    const dc = (gx0 + gx1) / 2;
    batch.boxMM(mats.darkSteel, dc - 0.5, FLOOR, gz0 - 0.04, dc + 0.5, FLOOR + 2.2, gz0);
    batch.boxMM(mats.darkSteel, dc - 0.5, FLOOR, gz1, dc + 0.5, FLOOR + 2.2, gz1 + 0.04);
  }
  // west wall (door to Sunset Strip / D-Block side)
  const [w0, w1] = LIB_WEST_DOOR;
  wallPiece(x0, FLOOR, z0, x0 + t, CEILING, w0);
  wallPiece(x0, FLOOR, w1, x0 + t, CEILING, zs);
  wallPiece(x0, doorH, w0, x0 + t, CEILING, w1);
  // door frames
  batch.boxMM(mats.darkSteel, d0 - 0.06, FLOOR, z0 - 0.02, d0, doorH + 0.06, z0 + t + 0.02);
  batch.boxMM(mats.darkSteel, d1, FLOOR, z0 - 0.02, d1 + 0.06, doorH + 0.06, z0 + t + 0.02);
  batch.boxMM(mats.darkSteel, d0 - 0.06, doorH, z0 - 0.02, d1 + 0.06, doorH + 0.06, z0 + t + 0.02);
  batch.boxMM(mats.darkSteel, x0 - 0.02, FLOOR, w0 - 0.06, x0 + t + 0.02, doorH + 0.06, w0);
  batch.boxMM(mats.darkSteel, x0 - 0.02, FLOOR, w1, x0 + t + 0.02, doorH + 0.06, w1 + 0.06);
  batch.boxMM(mats.darkSteel, x0 - 0.02, doorH, w0 - 0.06, x0 + t + 0.02, doorH + 0.06, w1 + 0.06);
  // closed stacks (double-sided), clear of the guard's diagonal through the doors and the cart
  const r = rng(1934);
  stack(kit, 8.6, 16.3, 14.2, 16.3, r);
  stack(kit, 8.6, 17.7, 14.2, 17.7, r);
  stack(kit, 9.0, 21.9, 14.2, 21.9, r);
  stack(kit, 9.0, 23.2, 14.2, 23.2, r);
  stack(kit, 2.0, 20.6, 2.0, 23.4, r);
  stack(kit, 3.4, 20.6, 3.4, 23.4, r);
  // librarian's desk with a green-shaded lamp, chair, card catalogue
  const dx = 7.7, dz = 19.6; // leaves a 1.1 m lane between the stacks and the desk (lib_in nav node)
  batch.boxMM(mats.wood, dx - 0.8, FLOOR + 0.72, dz - 0.4, dx + 0.8, FLOOR + 0.77, dz + 0.4);
  batch.boxMM(mats.wood, dx - 0.78, FLOOR, dz - 0.38, dx - 0.36, FLOOR + 0.72, dz + 0.38);
  batch.boxMM(mats.wood, dx + 0.36, FLOOR, dz - 0.38, dx + 0.78, FLOOR + 0.72, dz + 0.38);
  batch.boxMM(mats.wood, dx - 0.36, FLOOR + 0.25, dz - 0.36, dx + 0.36, FLOOR + 0.72, dz - 0.33);
  cols.mm(dx - 0.8, FLOOR, dz - 0.4, dx + 0.8, FLOOR + 0.77, dz + 0.4);
  batch.cyl(mats.darkSteel, [dx + 0.45, FLOOR + 0.77, dz - 0.15], [dx + 0.45, FLOOR + 1.1, dz - 0.15], 0.012, 6);
  const shade = new THREE.ConeGeometry(0.13, 0.12, 12, 1, true);
  shade.translate(dx + 0.45, FLOOR + 1.12, dz - 0.15);
  batch.addGeometry(mats.darkSteel, shade, null);
  batch.cyl(mats.warmLamp, [dx + 0.45, FLOOR + 1.06, dz - 0.15], [dx + 0.45, FLOOR + 1.1, dz - 0.15], 0.04, 8);
  batch.boxMM(mats.wood, dx - 0.25, FLOOR + 0.45, dz + 0.55, dx + 0.25, FLOOR + 0.5, dz + 1.0);
  batch.boxMM(mats.wood, dx - 0.25, FLOOR + 0.5, dz + 0.95, dx + 0.25, FLOOR + 0.95, dz + 1.0);
  for (const [cx, cz] of [[-0.22, 0.57], [0.22, 0.57], [-0.22, 0.98], [0.22, 0.98]]) batch.boxMM(mats.wood, dx + cx - 0.02, FLOOR, dz + cz - 0.02, dx + cx + 0.02, FLOOR + 0.45, dz + cz + 0.02);
  batch.boxMM(mats.wood, 5.8, FLOOR, 21.6, 6.7, FLOOR + 1.3, 22.1);
  for (let y = 0.15; y < 1.25; y += 0.16) batch.boxMM(mats.darkSteel, 5.85, FLOOR + y, 21.58, 6.65, FLOOR + y + 0.012, 21.6);
  cols.mm(5.8, FLOOR, 21.6, 6.7, FLOOR + 1.3, 22.1);
  // pendant lamp over the desk (LIGHT_ANCHORS library entry at F+3.0)
  pendant(kit, 8.0, FLOOR + 3.0, 19.5, mats.warmLamp);
  // the book cart where the drill was stashed
  const cart = modelSize(kit, 'book_cart', [1, 0.864, 0.521]);
  placeModel(kit, 'book_cart', BOOK_CART[0], BOOK_CART[1], BOOK_CART[2], 0);
  cols.box(BOOK_CART[0], FLOOR + cart[1] / 2, BOOK_CART[2], cart[0] / 2, cart[1] / 2, cart[2] / 2);
}

/** Double-sided bookcase between two floor points (along x or z), 2.2 m tall, 0.5 m deep. */
function stack(kit: Kit, ax: number, az: number, bx: number, bz: number, r: () => number) {
  const { batch, mats, cols } = kit;
  const alongX = Math.abs(bx - ax) > Math.abs(bz - az);
  const len = alongX ? Math.abs(bx - ax) : Math.abs(bz - az);
  const cx = (ax + bx) / 2, cz = (az + bz) / 2;
  const H = 2.2, D = 0.5;
  // in local terms: u along the stack, v across
  const B = (u0: number, y0: number, v0: number, u1: number, y1: number, v1: number, def: MatDef) => {
    if (alongX) batch.boxMM(def, cx + u0, FLOOR + y0, cz + v0, cx + u1, FLOOR + y1, cz + v1);
    else batch.boxMM(def, cx + v0, FLOOR + y0, cz + u0, cx + v1, FLOOR + y1, cz + u1);
  };
  const h = len / 2;
  const bays = Math.max(1, Math.round(len / 0.9));
  for (let i = 0; i <= bays; i++) { const u = -h + (i * len) / bays; B(u - 0.015, 0, -D / 2, u + 0.015, H, D / 2, mats.wood); }
  B(-h, 0, -0.01, h, H, 0.01, mats.wood);
  const shelves = [0.06, 0.48, 0.9, 1.32, 1.74, 2.17];
  for (const y of shelves) B(-h, y, -D / 2, h, y + 0.025, D / 2, mats.wood);
  // book blocks on both faces of every shelf (UV: a random row of the spine atlas, u along the run)
  for (let s = 0; s < shelves.length - 1; s++) {
    for (const side of [-1, 1]) {
      const y0 = shelves[s] + 0.025, bh = 0.3 + r() * 0.06;
      const depth = 0.2;
      const g = new THREE.BoxGeometry(len - 0.04, bh, depth);
      const uv = g.attributes.uv as THREE.BufferAttribute;
      const row = Math.floor(r() * 4), off = r();
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len + off, (row + uv.getY(i) * 0.95) / 4);
      const vc = side * (0.015 + depth / 2);
      if (alongX) g.translate(cx, FLOOR + y0 + bh / 2, cz + vc);
      else { g.rotateY(Math.PI / 2); g.translate(cx + vc, FLOOR + y0 + bh / 2, cz); }
      batch.addGeometry(mats.books, g, null, { keepUV: true });
    }
  }
  if (alongX) cols.mm(cx - h, FLOOR, cz - D / 2, cx + h, FLOOR + H, cz + D / 2);
  else cols.mm(cx - D / 2, FLOOR, cz - h, cx + D / 2, FLOOR + H, cz + h);
}

/** Pendant lamp: rod from the roof steel, dome shade, emissive bulb centred at (x, y, z). */
function pendant(kit: Kit, x: number, y: number, z: number, bulb: MatDef) {
  const { batch, mats } = kit;
  batch.cyl(mats.darkSteel, [x, y + 0.2, z], [x, CEILING + 0.1, z], 0.008, 4, true);
  const shade = new THREE.ConeGeometry(0.3, 0.24, 16, 1, true);
  shade.translate(x, y + 0.1, z);
  batch.addGeometry(mats.darkSteel, shade, null);
  const g = new THREE.SphereGeometry(0.07, 12, 8);
  g.translate(x, y, z);
  batch.addGeometry(bulb, g, null);
}

// ------------------------------------------------------------------------------------------------
// East end
// ------------------------------------------------------------------------------------------------
function buildEastEnd(kit: Kit) {
  const { batch, mats, cols } = kit;
  const [gx, gy, gz] = GUARD_DESK;
  const desk = modelSize(kit, 'guard_desk', [1.5, 1.487, 0.851]);
  placeModel(kit, 'guard_desk', gx, gy, gz, -Math.PI / 2);
  cols.box(gx, gy + 0.39, gz, desk[2] / 2, 0.39, desk[0] / 2);
  // officer's chair behind the desk
  batch.boxMM(mats.wood, gx + 0.55, FLOOR + 0.44, gz - 0.22, gx + 0.97, FLOOR + 0.48, gz + 0.22);
  batch.boxMM(mats.wood, gx + 0.93, FLOOR + 0.48, gz - 0.22, gx + 0.97, FLOOR + 0.95, gz + 0.22);
  for (const [dx, dz] of [[0.57, -0.2], [0.95, -0.2], [0.57, 0.2], [0.95, 0.2]]) batch.boxMM(mats.darkSteel, gx + dx - 0.015, FLOOR, gz + dz - 0.015, gx + dx + 0.015, FLOOR + 0.44, gz + dz + 0.015);
  // arm lamp off the gallery fascia over the desk (LIGHT_ANCHORS guard desk at F+2.2)
  batch.beam(mats.darkSteel, [30.3, FLOOR + 2.45, gz], [gx, FLOOR + 2.32, gz], 0.025, 0.025);
  const shade = new THREE.ConeGeometry(0.16, 0.14, 12, 1, true);
  shade.translate(gx, FLOOR + 2.26, gz);
  batch.addGeometry(mats.darkSteel, shade, null);
  const b = new THREE.SphereGeometry(0.045, 10, 6);
  b.translate(gx, FLOOR + 2.2, gz);
  batch.addGeometry(mats.warmLamp, b, null);
  // locker and mop bucket under the east gallery
  const lk = modelSize(kit, 'metal_locker', [1.487, 1.8, 0.915]);
  placeModel(kit, 'metal_locker', 31.45, FLOOR, -3.5, -Math.PI / 2);
  cols.box(31.45, FLOOR + lk[1] / 2, -3.5, lk[2] / 2, lk[1] / 2, lk[0] / 2);
  const mb = modelSize(kit, 'mop_bucket', [0.827, 0.95, 0.595]);
  placeModel(kit, 'mop_bucket', 30.75, FLOOR, 3.4, 0.4);
  cols.box(30.75, FLOOR + 0.3, 3.4, mb[0] / 2, 0.3, mb[2] / 2, 0.4);
}

// ------------------------------------------------------------------------------------------------
// Signs
// ------------------------------------------------------------------------------------------------
function buildSigns(kit: Kit) {
  const { batch, mats } = kit;
  const board = (row: number, x: number, y: number, z: number, len: number) => {
    const h = len / 6; // the atlas rows are 8:1; ~6:1 boards give a condensed stencil look
    const g = new THREE.BoxGeometry(0.05, h, len);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - (row + 1 - uv.getY(i)) / 4);
    g.translate(x, y, z);
    batch.addGeometry(mats.signs, g, null, { keepUV: true });
    batch.boxMM(mats.darkSteel, x - 0.035, y - h / 2 - 0.02, z - len / 2 - 0.02, x + 0.035, y - h / 2, z + len / 2 + 0.02);
    batch.boxMM(mats.darkSteel, x - 0.035, y + h / 2, z - len / 2 - 0.02, x + 0.035, y + h / 2 + 0.02, z + len / 2 + 0.02);
    return h;
  };
  const hung = (row: number, x: number, z: number, len: number) => {
    const y = FLOOR + 4.4;
    const h = board(row, x, y, z, len);
    for (const dz of [-len / 2 + 0.15, len / 2 - 0.15]) batch.cyl(mats.darkSteel, [x, y + h / 2 + 0.02, z + dz], [x, CEILING + 0.05, z + dz], 0.008, 4, true);
  };
  const rowOf = (name: (typeof SIGN_ROWS)[number]) => SIGN_ROWS.indexOf(name);
  // hung just outside the tier-3 stair landings at both block ends (x0 - 1.9 / x1 + 1.9)
  for (const x of [-27.95, 29.85]) {
    hung(rowOf('BROADWAY'), x, 0.45, 2.4);
    hung(rowOf('MICHIGAN AVE.'), x, -11.3, 2.2);
    hung(rowOf('PARK AVE.'), x, x < 0 ? 12.0 : 11.7, 2.2);
  }
  // TIMES SQUARE on the west gallery cage, above the clock
  board(rowOf('TIMES SQUARE'), GUN_GALLERIES.west.box[2] + 0.06, FLOOR + 6.6, 0.45, 2.6);
}

// ------------------------------------------------------------------------------------------------
// Roof steel
// ------------------------------------------------------------------------------------------------
function buildTrusses(kit: Kit) {
  const { batch, mats } = kit;
  const yb = CEILING + 0.08, yt = ROOF - 0.3;
  for (let x = -29.9; x <= 30.0; x += 4.27) {
    const [zn, zs] = interiorZ(x);
    batch.boxMM(mats.darkSteel, x - 0.08, CEILING, zn, x + 0.08, CEILING + 0.16, zs);
    batch.boxMM(mats.darkSteel, x - 0.08, yt - 0.08, zn, x + 0.08, yt + 0.08, zs);
    const panels = Math.round((zs - zn) / 1.6);
    const step = (zs - zn) / panels;
    for (let i = 0; i <= panels; i++) {
      const z = zn + i * step;
      batch.boxMM(mats.darkSteel, x - 0.05, yb, z - 0.05, x + 0.05, yt, z + 0.05);
      if (i < panels) {
        const za = i % 2 === 0 ? z : z + step, zb = i % 2 === 0 ? z + step : z;
        batch.beam(mats.darkSteel, [x, yb, za], [x, yt, zb], 0.07, 0.07);
      }
    }
  }
  // purlins along the hall
  for (let z = -23.5; z <= 23.5; z += 3.0) {
    const xa = z < -13.8 ? -15.0 : -32.0, xb = z > 13.1 ? 15.0 : 32.0;
    batch.boxMM(mats.darkSteel, xa, yt - 0.06, z - 0.06, xb, ROOF - 0.2, z + 0.06);
  }
}

// ------------------------------------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------------------------------------
function buildFixtures(kit: Kit, nightLights: [number, number, number][]) {
  const { batch, mats } = kit;
  const indoor = LIGHT_ANCHORS.filter((a) => a.p[1] > FLOOR + 6);
  const lit = (x: number, z: number) => indoor.some((a) => Math.abs(a.p[0] - x) < 1 && Math.abs(a.p[2] - z) < 1);
  const fixture = (x: number, z: number) => {
    const y = CEILING - 0.6;
    const on = lit(x, z);
    batch.boxMM(mats.steel, x - 0.64, y + 0.03, z - 0.12, x + 0.64, y + 0.1, z + 0.12);
    for (const dz of [-0.06, 0.06]) batch.cyl(on ? mats.tubeLit : mats.tubeOff, [x - 0.6, y, z + dz], [x + 0.6, y, z + dz], 0.016, 6);
    for (const dx of [-0.45, 0.45]) batch.cyl(mats.darkSteel, [x + dx, y + 0.1, z], [x + dx, CEILING + 0.05, z], 0.006, 4, true);
  };
  for (let x = -24; x <= 24; x += 6) {
    fixture(x, 0.45);      // Broadway
    fixture(x, -11.1);     // Michigan Avenue
    fixture(x, 12.0);      // Park Avenue
    if (x >= -12) fixture(x, -22.2); // north aisle
    if (x <= -6) fixture(x, 20.5);   // Sunset Strip
  }
  // Times Square pendant (warm), matching its light anchor
  pendant(kit, -29, FLOOR + 4.5, 0.45, mats.warmLamp);
  // caged night lights under the tier-2 walkways
  for (const [x, y, z] of nightLights) {
    batch.boxMM(mats.darkSteel, x - 0.07, y + 0.05, z - 0.07, x + 0.07, y + 0.1, z + 0.07);
    const g = new THREE.SphereGeometry(0.045, 10, 6);
    g.translate(x, y, z);
    batch.addGeometry(mats.nightLamp, g, null);
  }
}
