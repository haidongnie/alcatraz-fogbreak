#!/usr/bin/env node
// Builds public/data/island.json from real open data:
//   - assets-src/osm/osm_alcatraz.json: OpenStreetMap ways (coastline, buildings, roads, walls)
//     (c) OpenStreetMap contributors, ODbL - https://www.openstreetmap.org/copyright
//   - assets-src/osm/t_15_*.png: Terrarium elevation tiles (AWS Open Data "Terrain Tiles",
//     sources incl. USGS 3DEP) - https://registry.opendata.aws/terrain-tiles/
//
// Game frame: metres, y up, sea level y = 0. The world is rotated so the Main Prison
// (cellhouse) long axis runs along +X and its footprint centre is the origin. `northAngle`
// is the angle (radians, around +Y) from game -Z to true north, for the compass/minimap.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const osm = JSON.parse(readFileSync(resolve(root, 'assets-src/osm/osm_alcatraz.json'), 'utf8'));
const ways = osm.elements.filter((e) => e.type === 'way' && e.geometry);

// --- local projection -------------------------------------------------------------------------
const mainPrison = ways.find((w) => w.tags?.name === 'Main Prison');
const lat0 = mainPrison.geometry.reduce((s, p) => s + p.lat, 0) / mainPrison.geometry.length;
const lon0 = mainPrison.geometry.reduce((s, p) => s + p.lon, 0) / mainPrison.geometry.length;
const mPerLat = 111132.92 - 559.82 * Math.cos(2 * lat0 * Math.PI / 180);
const mPerLon = 111412.84 * Math.cos(lat0 * Math.PI / 180);
const toEN = (p) => [(p.lon - lon0) * mPerLon, (p.lat - lat0) * mPerLat]; // east, north

// cellhouse orientation: longest edge direction of its footprint (it is a near-rectangle)
const mp = mainPrison.geometry.map(toEN);
let best = { len: 0, ang: 0 };
for (let i = 0; i < mp.length - 1; i++) {
  const dx = mp[i + 1][0] - mp[i][0], dy = mp[i + 1][1] - mp[i][1];
  const len = Math.hypot(dx, dy);
  if (len > best.len) best = { len, ang: Math.atan2(dy, dx) };
}
const theta = best.ang; // angle of the long axis from east, counter-clockwise
// rotate EN by -theta so the long axis is +X; then (x, z) = (e', -n')
const ct = Math.cos(-theta), st = Math.sin(-theta);
let cx = 0, cz = 0;
const rot = ([e, n]) => [e * ct - n * st, e * st + n * ct];
{
  const r = mp.map(rot);
  const xs = r.map((p) => p[0]), ys = r.map((p) => p[1]);
  cx = (Math.min(...xs) + Math.max(...xs)) / 2; cz = (Math.min(...ys) + Math.max(...ys)) / 2;
}
const toGame = (p) => {
  const [x, y] = rot(toEN(p));
  return [round(x - cx), round(-(y - cz))];
};
const fromGame = (x, z) => {
  const xr = x + cx, yr = -z + cz;
  // inverse rotation (by +theta)
  const e = xr * Math.cos(theta) - yr * Math.sin(theta);
  const n = xr * Math.sin(theta) + yr * Math.cos(theta);
  return { lat: lat0 + n / mPerLat, lon: lon0 + e / mPerLon };
};
function round(v) { return Math.round(v * 100) / 100; }

// north in game frame: true north (0,1) in EN -> rotated -> game dir
const nr = rot([0, 1]);
const northDir = [nr[0], -nr[1]]; // game (x, z)
const northAngle = Math.atan2(northDir[0], -northDir[1]); // 0 when north == -Z

// --- elevation (Terrarium) -----------------------------------------------------------------------
const Z = 15;
const tiles = new Map();
for (const f of ['t_15_5240_12659.png', 't_15_5241_12659.png']) {
  const [, , tx, ty] = f.replace('.png', '').split('_').map(Number);
  tiles.set(`${tx},${ty}`, PNG.sync.read(readFileSync(resolve(root, 'assets-src/osm', f))));
}
function elevAt(lat, lon) {
  const n = 2 ** Z;
  const fx = (lon + 180) / 360 * n;
  const fy = (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n;
  const sample = (gx, gy) => {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const t = tiles.get(`${tx},${ty}`);
    if (!t) return -10;
    const px = Math.min(255, Math.max(0, gx - tx * 256)), py = Math.min(255, Math.max(0, gy - ty * 256));
    const i = (py * 256 + px) * 4;
    return t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256 - 32768;
  };
  const gx = fx * 256 - 0.5, gy = fy * 256 - 0.5;
  const x0 = Math.floor(gx), y0 = Math.floor(gy), ax = gx - x0, ay = gy - y0;
  return (sample(x0, y0) * (1 - ax) + sample(x0 + 1, y0) * ax) * (1 - ay) +
         (sample(x0, y0 + 1) * (1 - ax) + sample(x0 + 1, y0 + 1) * ax) * ay;
}

// --- vector features --------------------------------------------------------------------------
const coastWay = ways.find((w) => w.tags?.natural === 'coastline');
const coastline = coastWay.geometry.map(toGame);

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function distToPoly(x, z, poly) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j], [bx, bz] = poly[i];
    const vx = bx - ax, vz = bz - az, wx = x - ax, wz = z - az;
    const t = Math.max(0, Math.min(1, (wx * vx + wz * vz) / (vx * vx + vz * vz || 1)));
    d = Math.min(d, Math.hypot(wx - t * vx, wz - t * vz));
  }
  return d;
}

// approximate 1962 heights (m) for buildings OSM leaves untagged; see docs/DESIGN.md
const heightByName = {
  'Main Prison': 17, 'Dining Hall': 14, 'Administration Block': 14, 'Model Industries Building': 8,
  'New Industries Building': 9, 'Building 64': 12, 'Powerhouse': 9, 'Quartermaster': 6,
  "Post Exchange & Officers' Club": 7, 'Sally Port': 7, 'Electric Shop': 5, "Warden's House": 12,
  'Restrooms': 3.5, 'Morgue': 3.5, 'Former Military Chapel': 9, 'Alcatraz Island Lighthouse': 25.6,
  'Water Tower': 28,
};
const buildings = [];
for (const w of ways) {
  const t = w.tags ?? {};
  if (!t.building && t.man_made !== 'chimney') continue;
  const poly = w.geometry.map(toGame);
  if (poly.length > 2 && poly[0][0] === poly.at(-1)[0] && poly[0][1] === poly.at(-1)[1]) poly.pop();
  const name = t.name ?? (t.man_made === 'chimney' ? 'Powerhouse Smokestack' : t.man_made === 'tower' ? 'Guard Tower' : null);
  const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
  const centroid = [round(xs.reduce((a, b) => a + b, 0) / xs.length), round(zs.reduce((a, b) => a + b, 0) / zs.length)];
  // ground level: lowest terrain sample around the footprint
  let base = Infinity;
  for (const [x, z] of poly) { const g = fromGame(x, z); base = Math.min(base, elevAt(g.lat, g.lon)); }
  const c = fromGame(...centroid);
  base = Math.max(1, Math.min(base, elevAt(c.lat, c.lon)));
  buildings.push({
    osmId: w.id,
    name,
    kind: t.man_made ?? t.building,
    ruinsToday: t.building === 'ruins' || t.historic === 'ruins' || undefined,
    height: Number(t.height) || heightByName[name] || (t.building === 'ruins' ? 8 : 6),
    base: round(base),
    centroid,
    poly,
  });
}

const lines = [];
for (const w of ways) {
  const t = w.tags ?? {};
  const type = t.highway ? `highway:${t.highway}` : t.barrier ? `barrier:${t.barrier}` : t.man_made === 'pier' ? 'pier' : null;
  if (!type) continue;
  lines.push({ osmId: w.id, type, name: t.name, closed: w.geometry.length > 2 && w.nodes?.[0] === w.nodes?.at(-1), pts: w.geometry.map(toGame) });
}
const areas = [];
for (const w of ways) {
  const t = w.tags ?? {};
  if (['Recreation Yard', 'Parade Ground'].includes(t.name) || t.leisure === 'garden' || t.natural === 'scree' || t.man_made === 'reservoir_covered') {
    areas.push({ osmId: w.id, name: t.name ?? t.leisure ?? t.natural ?? t.man_made, poly: w.geometry.map(toGame) });
  }
}

// --- gameplay sculpting (keep in sync with src/world/layout.ts) ----------------------------------
// The 1/3-arc-second DEM is smooth; the cellhouse complex sits on a levelled pad at FLOOR, the
// pipe lands in a levelled service yard, and the raft launches from a small shingle beach.
const FLOOR = 41.0;
const complex = ['Main Prison', 'Dining Hall', 'Administration Block']
  .map((n) => ways.find((w) => w.tags?.name === n).geometry.map(toGame));
const SERVICE_YARD = { x0: -94, z0: -26, x1: -62, z1: -9.2, y: 33.0 };
const LAUNCH = { x: -214, z: -50, y: 1.2, sea: [-216, -56] };
const smooth = (t) => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
function sculpt(x, z, h) {
  // complex pad: never above the floor slab inside the footprints (+1.5 m margin)
  for (const poly of complex) {
    const inside = pointInPoly(x, z, poly);
    const d = inside ? 0 : distToPoly(x, z, poly);
    if (d < 4) {
      const k = 1 - smooth(d / 4);
      h = h * (1 - k) + Math.min(h, FLOOR - 0.5) * k;
      if (inside) h = Math.min(h, FLOOR - 0.5);
    }
  }
  // service yard: flat at its level, blended over 6 m
  const dx = Math.max(SERVICE_YARD.x0 - x, 0, x - SERVICE_YARD.x1), dz = Math.max(SERVICE_YARD.z0 - z, 0, z - SERVICE_YARD.z1);
  const dy = Math.hypot(dx, dz);
  if (dy < 6) h = h + (SERVICE_YARD.y - h) * (1 - smooth(dy / 6));
  // launch beach: gentle ramp from y=1.2 down into the water toward the raft spawn
  const dl = Math.hypot(x - LAUNCH.x, z - LAUNCH.z);
  if (dl < 16) {
    const k = 1 - smooth((dl - 6) / 10);
    const along = ((x - LAUNCH.x) * (LAUNCH.sea[0] - LAUNCH.x) + (z - LAUNCH.z) * (LAUNCH.sea[1] - LAUNCH.z)) / 40;
    const beach = LAUNCH.y - Math.max(0, along) * 0.45;
    h = h + (beach - h) * k;
  }
  return h;
}

// --- heightmap grid -----------------------------------------------------------------------------
const pad = 260;
const xsAll = coastline.map((p) => p[0]), zsAll = coastline.map((p) => p[1]);
const minX = Math.floor(Math.min(...xsAll) - pad), maxX = Math.ceil(Math.max(...xsAll) + pad);
const minZ = Math.floor(Math.min(...zsAll) - pad), maxZ = Math.ceil(Math.max(...zsAll) + pad);
const res = 2;
const cols = Math.floor((maxX - minX) / res) + 1, rows = Math.floor((maxZ - minZ) / res) + 1;
const heights = new Int16Array(cols * rows);
let maxH = -Infinity;
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const x = minX + c * res, z = minZ + r * res;
    const g = fromGame(x, z);
    let h = elevAt(g.lat, g.lon);
    // sharpen the shoreline with the OSM coastline: land stays above the tide line, water below
    const inside = pointInPoly(x, z, coastline);
    const d = distToPoly(x, z, coastline);
    if (inside) h = Math.max(h, 1.2 + Math.min(d, 6) * 0.6);
    else h = Math.min(h, -1.5 - Math.min(d, 40) * 0.35);
    h = sculpt(x, z, h);
    maxH = Math.max(maxH, h);
    heights[r * cols + c] = Math.round(h * 10); // decimetres
  }
}

const cell = mainPrison.geometry.map(toGame);
const cxs = cell.map((p) => p[0]), czs = cell.map((p) => p[1]);
const out = {
  attribution: 'Map data (c) OpenStreetMap contributors (ODbL); elevation: AWS Terrain Tiles (USGS 3DEP and others)',
  origin: { lat: lat0, lon: lon0 },
  northAngle,
  northDir,
  cellhouse: {
    length: round(Math.max(...cxs) - Math.min(...cxs)),
    width: round(Math.max(...czs) - Math.min(...czs)),
    base: buildings.find((b) => b.name === 'Main Prison').base,
  },
  maxElevation: round(maxH),
  grid: { minX, minZ, res, cols, rows, scale: 0.1, data: Buffer.from(heights.buffer).toString('base64') },
  coastline,
  buildings,
  lines,
  areas,
};
mkdirSync(resolve(root, 'public/data'), { recursive: true });
writeFileSync(resolve(root, 'public/data/island.json'), JSON.stringify(out));
console.log(`island.json: grid ${cols}x${rows} @${res}m, max elev ${maxH.toFixed(1)} m, cellhouse ${out.cellhouse.length} x ${out.cellhouse.width} m, base ${out.cellhouse.base} m, north angle ${(northAngle * 180 / Math.PI).toFixed(1)} deg`);
for (const b of buildings) console.log(`  ${String(b.name).padEnd(34)} centroid ${b.centroid} base ${b.base} h ${b.height}${b.ruinsToday ? ' (ruins today)' : ''}`);
