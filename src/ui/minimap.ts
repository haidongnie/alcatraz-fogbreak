// Island map built from public/data/island.json + layout.ts: a hill-shaded terrain image with
// contour lines decoded from the heightmap grid, OSM buildings / roads / walls / fences / piers,
// and the cellhouse floor plan. Rendered two ways:
//   CornerMap - small heading-up radar in the HUD corner (night palette, follows the camera yaw)
//   MapView   - the M overlay: the whole island north-up on survey paper + a cellhouse plan inset
// Path2D geometry lives in world metres (x, z); a View maps it to the canvas.
import * as THREE from 'three/webgpu';
import { asset, TUNING } from '../config';
import type { Ctx } from '../game/context';
import type { GuardMode, V3 } from '../game/types';
import { t } from '../i18n';
import { D_GAP_WALL, GUARDS,
  AISLES, BLOCKS, CELLHOUSE_POLY, FENCE, FLOOR, GUN_GALLERIES, HOLE_CELLS, LAUNCH, LIBRARY, PLAYER_CELLS,
  ROOF, SEARCHLIGHTS, SERVICE_YARD, BAKERY_PIPE, UTILITY_B,
} from '../world/layout';
import { h } from './dom';

type P2 = [number, number];
interface IslandJson {
  northDir: P2;
  grid: { minX: number; minZ: number; res: number; cols: number; rows: number; scale: number; data: string };
  coastline: P2[];
  buildings: { name: string | null; kind: string; centroid: P2; poly: P2[] }[];
  lines: { type: string; closed: boolean; pts: P2[] }[];
  areas: { name: string; poly: P2[] }[];
}

export interface MapLabel { key: string; x: number; z: number; major: boolean }
export interface MapData {
  north: P2;
  /** canvas rotation that puts true north up */
  northRot: number;
  /** world rectangle covered by the terrain images */
  img: { x: number; z: number; w: number; h: number };
  paper: HTMLCanvasElement;
  night: HTMLCanvasElement;
  coast: Path2D;
  buildings: Path2D;
  roads: Path2D;
  footways: Path2D;
  walls: Path2D;
  fences: Path2D;
  piers: Path2D;
  areas: Path2D;
  cellhouse: Path2D;
  blocks: Path2D;
  utility: Path2D;
  cellLines: Path2D;
  galleries: Path2D;
  library: Path2D;
  labels: MapLabel[];
  /** north-up fit of the island: world centre and rotated extents (m) */
  fit: { ox: number; oz: number; w: number; h: number };
  /** far-off places, as world directions */
  bearings: { key: string; dx: number; dz: number }[];
}

/** A member of the crew to draw (refreshed by the HUD at a few Hz). */
export interface MapCrew { id: string; color: string; initial: string; isMe: boolean }

const BUILDING_LABELS: Record<string, string> = {
  'Main Prison': 'map.cellhouse',
  'Dining Hall': 'map.diningHall',
  'Administration Block': 'map.admin',
  'Alcatraz Island Lighthouse': 'map.lighthouse',
  'Water Tower': 'map.waterTower',
  Powerhouse: 'map.powerhouse',
  "Warden's House": 'map.wardenHouse',
  'Model Industries Building': 'map.modelIndustries',
  'New Industries Building': 'map.newIndustries',
  'Building 64': 'map.building64',
};
const MAJOR = new Set(['map.cellhouse', 'map.lighthouse', 'map.powerhouse', 'map.launch']);

// ------------------------------------------------------------------------------------------------
// Loading
// ------------------------------------------------------------------------------------------------
export async function loadMapData(): Promise<MapData> {
  const res = await fetch(asset('data/island.json'));
  if (!res.ok) throw new Error(`island.json: HTTP ${res.status}`);
  const j = (await res.json()) as IslandJson;
  const north = j.northDir;
  const northRot = Math.atan2(-north[0], -north[1]);
  const g = j.grid;
  const heights = decodeGrid(g.data, g.cols * g.rows);
  const { paper, night } = terrainImages(g, heights, north);

  const coast = new Path2D();
  poly(coast, j.coastline, true);
  const buildings = new Path2D();
  const labels: MapLabel[] = [];
  for (const b of j.buildings) {
    poly(buildings, b.poly, true);
    const key = b.name ? BUILDING_LABELS[b.name] : undefined;
    if (key) labels.push({ key, x: b.centroid[0], z: b.centroid[1], major: MAJOR.has(key) });
  }
  const roads = new Path2D(), footways = new Path2D(), walls = new Path2D(), fences = new Path2D(), piers = new Path2D();
  let dock: P2 | null = null;
  for (const l of j.lines) {
    const ty = l.type;
    if (ty === 'pier') {
      poly(piers, l.pts, false);
      if (!dock) dock = l.pts[Math.floor(l.pts.length / 2)];
    } else if (ty.startsWith('barrier:fence')) poly(fences, l.pts, l.closed);
    else if (ty.startsWith('barrier:')) poly(walls, l.pts, l.closed);
    else if (/highway:(service|track|pedestrian)/.test(ty)) poly(roads, l.pts, false);
    else if (ty.startsWith('highway:')) poly(footways, l.pts, false);
  }
  const areas = new Path2D();
  for (const a of j.areas) {
    poly(areas, a.poly, true);
    const key = a.name === 'Recreation Yard' ? 'map.recYard' : a.name === 'Parade Ground' ? 'map.paradeGround' : null;
    if (key) { const c = centroid(a.poly); labels.push({ key, x: c[0], z: c[1], major: false }); }
  }
  if (dock) labels.push({ key: 'map.dock', x: dock[0], z: dock[1] + 6, major: false });
  labels.push({ key: 'map.launch', x: LAUNCH.p[0], z: LAUNCH.p[2], major: true });
  const yb = SERVICE_YARD.box;
  labels.push({ key: 'map.yard', x: (yb[0] + yb[2]) / 2, z: (yb[1] + yb[3]) / 2, major: false });
  // the fence line in layout closes the service yard to the north (also drawn in addition to OSM)
  fences.moveTo(FENCE.x0, FENCE.z);
  fences.lineTo(FENCE.x1, FENCE.z);

  // cellhouse plan
  const cellhouse = new Path2D();
  poly(cellhouse, CELLHOUSE_POLY, true);
  const blocks = new Path2D(), utility = new Path2D(), cellLines = new Path2D();
  for (const b of BLOCKS) {
    // D-Block's two westmost flats cells were never built: that end is an open floor passage
    const first = b.id === 'D' ? 2 : 0;
    const bx0 = b.id === 'D' ? b.cellX0 + first * b.pitch : b.x0;
    blocks.rect(bx0, b.zNorth, b.x1 - bx0, b.zSouth - b.zNorth);
    if (b.utility) utility.rect(b.x0, b.utility[0], b.x1 - b.x0, b.utility[1] - b.utility[0]);
    for (let i = first; i <= b.cellsPerFace; i++) {
      const x = b.cellX0 + i * b.pitch;
      if (b.utility) {
        cellLines.moveTo(x, b.zNorth); cellLines.lineTo(x, b.utility[0]);
        cellLines.moveTo(x, b.utility[1]); cellLines.lineTo(x, b.zSouth);
      } else {
        cellLines.moveTo(x, b.zNorth); cellLines.lineTo(x, b.zSouth);
      }
    }
  }
  const galleries = new Path2D();
  for (const gg of [GUN_GALLERIES.west, GUN_GALLERIES.east]) {
    const bx = gg.box;
    galleries.rect(bx[0], bx[1], bx[2] - bx[0], bx[3] - bx[1]);
  }
  const library = new Path2D();
  const lb = LIBRARY.box;
  library.rect(lb[0], lb[1], lb[2] - lb[0], lb[3] - lb[1]);
  // the walled-off gap between D-Block's east end and the library
  const [gx0, gz0, gx1, gz1] = D_GAP_WALL;
  blocks.rect(gx0, gz0, gx1 - gx0, gz1 - gz0);

  // north-up fit of the coastline
  const c = Math.cos(northRot), s = Math.sin(northRot);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, z] of j.coastline) {
    const rx = c * x - s * z, ry = s * x + c * z;
    x0 = Math.min(x0, rx); x1 = Math.max(x1, rx); y0 = Math.min(y0, ry); y1 = Math.max(y1, ry);
  }
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const fit = { ox: c * mx + s * my, oz: -s * mx + c * my, w: x1 - x0, h: y1 - y0 };

  // bearings (clockwise from true north): east = north rotated -90 degrees about +Y
  const east: P2 = [-north[1], north[0]];
  const bearing = (deg: number): [number, number] => {
    const r = (deg * Math.PI) / 180;
    return [north[0] * Math.cos(r) + east[0] * Math.sin(r), north[1] * Math.cos(r) + east[1] * Math.sin(r)];
  };
  const bearings = ([['map.angel', 7], ['map.sf', 189], ['map.gg', 261]] as const).map(([key, deg]) => {
    const [dx, dz] = bearing(deg);
    return { key, dx, dz };
  });

  return {
    north, northRot,
    img: { x: g.minX - g.res / 2, z: g.minZ - g.res / 2, w: g.cols * g.res, h: g.rows * g.res },
    paper, night, coast, buildings, roads, footways, walls, fences, piers, areas,
    cellhouse, blocks, utility, cellLines, galleries, library, labels, fit, bearings,
  };
}

function decodeGrid(b64: string, n: number): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, Math.min(n, bytes.length >> 1));
}

function poly(path: Path2D, pts: readonly (readonly [number, number])[], close: boolean) {
  if (pts.length < 2) return;
  path.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
  if (close) path.closePath();
}
function centroid(pts: readonly P2[]): P2 {
  let x = 0, z = 0;
  for (const p of pts) { x += p[0]; z += p[1]; }
  return [x / pts.length, z / pts.length];
}

/** Hill-shaded terrain with 5 m contours (20 m index contours) in two palettes. */
function terrainImages(g: IslandJson['grid'], hm: Int16Array, north: P2) {
  const { cols, rows, res, scale } = g;
  const paper = document.createElement('canvas');
  const night = document.createElement('canvas');
  paper.width = night.width = cols;
  paper.height = night.height = rows;
  const pc = paper.getContext('2d')!, nc = night.getContext('2d')!;
  const pi = pc.createImageData(cols, rows), ni = nc.createImageData(cols, rows);
  const pd = pi.data, nd = ni.data;
  // cartographic convention: light from the (true) north-west, 45 degrees up
  const west: P2 = [north[1], -north[0]];
  let lx = north[0] + west[0], lz = north[1] + west[1];
  const ll = Math.hypot(lx, lz) || 1;
  lx = (lx / ll) * Math.SQRT1_2; lz = (lz / ll) * Math.SQRT1_2;
  const ly = Math.SQRT1_2;
  const H = (c: number, r: number) => hm[Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))] * scale;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 4;
      const hh = H(c, r), hr = H(c + 1, r), hd = H(c, r + 1);
      let pr: number, pg: number, pb: number, nr: number, ng: number, nb: number;
      if (hh <= 0) {
        const k = Math.min(1, Math.max(0, (hh + 25) / 25));
        pr = 143 + 42 * k; pg = 163 + 36 * k; pb = 168 + 25 * k;
        nr = 11 + 8 * k; ng = 21 + 12 * k; nb = 28 + 12 * k;
      } else {
        const gx = (hr - H(c - 1, r)) / (2 * res) * 1.6, gz = (hd - H(c, r - 1)) / (2 * res) * 1.6;
        const nl = Math.hypot(gx, 1, gz);
        const shade = ((-gx * lx + ly - gz * lz) / nl) / Math.SQRT1_2; // 1 = flat
        const e = Math.min(1, hh / 42);
        const sp = Math.min(1.15, Math.max(0.55, 0.72 + 0.3 * shade));
        pr = (227 - 14 * e) * sp; pg = (214 - 22 * e) * sp; pb = (171 - 28 * e) * sp;
        const sn = Math.min(1.2, Math.max(0.5, 0.65 + 0.42 * shade));
        nr = (36 + 10 * e) * sn; ng = (40 + 8 * e) * sn; nb = (37 + 4 * e) * sn;
        const ci = Math.floor(hh / 5);
        const cr = Math.floor(hr / 5), cd = Math.floor(hd / 5);
        if (cr !== ci || cd !== ci) {
          const major = Math.max(ci, cr, cd) % 4 === 0;
          const m = major ? 0.68 : 0.84;
          pr *= m; pg *= m; pb *= m;
          const q = major ? 1.35 : 1.15;
          nr *= q; ng *= q; nb *= q;
        }
      }
      if ((hh > 0) !== (hr > 0) || (hh > 0) !== (hd > 0)) { // shoreline
        pr = 70; pg = 60; pb = 44;
        nr = 120; ng = 145; nb = 150;
      }
      pd[i] = pr; pd[i + 1] = pg; pd[i + 2] = pb; pd[i + 3] = 255;
      nd[i] = nr; nd[i + 1] = ng; nd[i + 2] = nb; nd[i + 3] = 255;
    }
  }
  pc.putImageData(pi, 0, 0);
  nc.putImageData(ni, 0, 0);
  return { paper, night };
}

// ------------------------------------------------------------------------------------------------
// Drawing
// ------------------------------------------------------------------------------------------------
/** World (x, z) -> canvas CSS pixels: translate(cx, cy) . rotate(rot) . scale(s) . translate(-ox, -oz). */
export class View {
  cx = 0; cy = 0; s = 1; rot = 0; ox = 0; oz = 0;
  private c = 1;
  private sn = 0;
  set(cx: number, cy: number, s: number, rot: number, ox: number, oz: number) {
    this.cx = cx; this.cy = cy; this.s = s; this.rot = rot; this.ox = ox; this.oz = oz;
    this.c = Math.cos(rot); this.sn = Math.sin(rot);
  }
  apply(g: CanvasRenderingContext2D, dpr: number) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.translate(this.cx, this.cy);
    g.rotate(this.rot);
    g.scale(this.s, this.s);
    g.translate(-this.ox, -this.oz);
  }
  sx(x: number, z: number) { return this.cx + this.s * (this.c * (x - this.ox) - this.sn * (z - this.oz)); }
  sy(x: number, z: number) { return this.cy + this.s * (this.sn * (x - this.ox) + this.c * (z - this.oz)); }
  /** screen-space rotation of a world direction given as a yaw (0 = facing -Z) */
  yawToScreen(yaw: number) { return this.rot - yaw; }
}

type Palette = 'paper' | 'night';
const PAL = {
  paper: {
    sea: '#8fa3a8', area: 'rgba(120,100,60,0.10)', road: '#bba97f', foot: 'rgba(110,88,55,0.6)', wall: '#6b5a3e',
    fence: '#8f3a2a', pier: '#7a6446', bFill: '#cdb78a', bLine: '#3c3324', block: '#a8946b', util: '#e9dcb8',
    cellLine: 'rgba(60,50,35,0.35)', gallery: 'rgba(143,58,42,0.6)', house: '#ddd0aa',
  },
  night: {
    sea: '#0b151c', area: 'rgba(200,190,160,0.06)', road: 'rgba(170,160,135,0.38)', foot: 'rgba(170,160,135,0.24)',
    wall: 'rgba(200,190,160,0.5)', fence: 'rgba(225,120,90,0.75)', pier: 'rgba(170,150,120,0.6)',
    bFill: 'rgba(150,140,118,0.55)', bLine: 'rgba(225,215,190,0.65)', block: 'rgba(120,112,95,0.85)',
    util: 'rgba(30,34,32,0.95)', cellLine: 'rgba(225,215,190,0.25)', gallery: 'rgba(225,120,90,0.5)', house: 'rgba(70,72,64,0.9)',
  },
} as const;

/** Terrain + OSM vectors (+ cellhouse plan when `plan`). */
export function drawBase(g: CanvasRenderingContext2D, d: MapData, v: View, pal: Palette, dpr: number, plan: boolean, terrain = true) {
  const P = PAL[pal];
  const px = 1 / v.s;
  g.save();
  v.apply(g, dpr);
  if (terrain) {
    g.imageSmoothingEnabled = true;
    g.drawImage(pal === 'paper' ? d.paper : d.night, d.img.x, d.img.z, d.img.w, d.img.h);
  }
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.fillStyle = P.area;
  g.fill(d.areas);
  g.strokeStyle = P.road;
  g.lineWidth = Math.max(3, 1.5 * px);
  g.stroke(d.roads);
  g.strokeStyle = P.foot;
  g.lineWidth = Math.max(1.2, px);
  g.setLineDash([4 * px, 3 * px]);
  g.stroke(d.footways);
  g.setLineDash([]);
  g.strokeStyle = P.wall;
  g.lineWidth = Math.max(0.8, 1.2 * px);
  g.stroke(d.walls);
  g.strokeStyle = P.pier;
  g.lineWidth = Math.max(4, 2 * px);
  g.stroke(d.piers);
  g.fillStyle = P.bFill;
  g.fill(d.buildings);
  g.strokeStyle = P.bLine;
  g.lineWidth = 1.1 * px;
  g.stroke(d.buildings);
  g.strokeStyle = P.fence;
  g.lineWidth = Math.max(0.5, 1.3 * px);
  g.setLineDash([2.5 * px, 2 * px]);
  g.stroke(d.fences);
  g.setLineDash([]);
  if (plan) drawPlan(g, d, P, px);
  g.restore();
}

function drawPlan(g: CanvasRenderingContext2D, d: MapData, P: (typeof PAL)['paper' | 'night'], px: number) {
  g.fillStyle = P.house;
  g.fill(d.cellhouse);
  g.fillStyle = P.block;
  g.fill(d.blocks);
  g.fillStyle = P.util;
  g.fill(d.utility);
  g.strokeStyle = P.cellLine;
  g.lineWidth = px;
  g.stroke(d.cellLines);
  g.strokeStyle = P.gallery;
  g.setLineDash([3 * px, 2 * px]);
  g.stroke(d.galleries);
  g.setLineDash([]);
  g.strokeStyle = P.bLine;
  g.lineWidth = 1.2 * px;
  g.stroke(d.library);
  g.stroke(d.cellhouse);
}

const FONT = '"Special Elite", "Courier Prime", "Noto Serif SC", "Songti SC", serif';

function arrowGlyph(g: CanvasRenderingContext2D, x: number, y: number, ang: number, size: number, fill: string, stroke: string) {
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.beginPath();
  g.moveTo(0, -size);
  g.lineTo(size * 0.72, size * 0.8);
  g.lineTo(0, size * 0.42);
  g.lineTo(-size * 0.72, size * 0.8);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = stroke;
  g.stroke();
  g.restore();
}
function star(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke: string) {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    if (i === 0) g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    else g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = stroke;
  g.stroke();
}
function dot(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke: string) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = stroke;
  g.stroke();
}
function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, ink: string, halo: string) {
  g.font = `${size}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 3;
  g.strokeStyle = halo;
  g.strokeText(text, x, y);
  g.fillStyle = ink;
  g.fillText(text, x, y);
}

function fitCanvas(canvas: HTMLCanvasElement): { w: number; h: number; dpr: number } {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width)), hh = Math.max(1, Math.round(r.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hh * dpr);
  }
  return { w, h: hh, dpr };
}

// ------------------------------------------------------------------------------------------------
// Corner radar
// ------------------------------------------------------------------------------------------------
export class CornerMap {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private data: MapData | null = null;
  private readonly view = new View();
  private readonly fwd = new THREE.Vector3();
  private zoom = 3;
  private size = { w: 160, h: 160, dpr: 1 };

  constructor(parent: HTMLElement) {
    this.canvas = h('canvas', 'minimap-canvas');
    this.g = this.canvas.getContext('2d')!;
    this.el = h('div', 'minimap', this.canvas);
    parent.append(this.el);
  }
  setData(d: MapData) { this.data = d; }
  resize() { this.size = fitCanvas(this.canvas); }

  draw(ctx: Ctx, crew: readonly MapCrew[], target: V3 | null, indoor: boolean, dt: number) {
    const d = this.data, p = ctx.player;
    if (!d || !p) return;
    if (this.size.w < 4) this.resize();
    const { w, dpr } = this.size;
    if (w < 4) return;
    const R = w / 2;
    ctx.camera.getWorldDirection(this.fwd);
    const yaw = Math.atan2(-this.fwd.x, -this.fwd.z);
    this.zoom += ((indoor ? 5.2 : 1.6) - this.zoom) * Math.min(1, dt * 3);
    const v = this.view;
    v.set(R, R, this.zoom, yaw, p.position.x, p.position.z);
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, w);
    g.save();
    g.beginPath();
    g.arc(R, R, R - 1, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = PAL.night.sea;
    g.fillRect(0, 0, w, w);
    drawBase(g, d, v, 'night', dpr, true);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    const rim = R - 7;
    // nearby guards: sight cone + facing arrow, coloured by how alert they are
    if (ctx.guardRadar) {
      this.gMe = p.position;
      this.gR = R;
      ctx.guardRadar.forEachVisible(this.drawGuard);
    }
    // crew
    for (const m of crew) {
      if (m.isMe) continue;
      const ps = ctx.net.getPlayerState(m.id);
      if (!ps) continue;
      let x = v.sx(ps.p[0], ps.p[2]) - R, y = v.sy(ps.p[0], ps.p[2]) - R;
      const dd = Math.hypot(x, y);
      if (dd > rim) { x *= rim / dd; y *= rim / dd; }
      dot(g, R + x, R + y, 4, m.color, 'rgba(0,0,0,0.7)');
    }
    // objective (clamped to the rim when far)
    if (target) {
      let x = v.sx(target[0], target[2]) - R, y = v.sy(target[0], target[2]) - R;
      const dd = Math.hypot(x, y);
      if (dd > rim) { x *= rim / dd; y *= rim / dd; }
      star(g, R + x, R + y, 6, '#e8c25a', 'rgba(20,14,6,0.85)');
    }
    // me (always at the centre)
    arrowGlyph(g, R, R, v.yawToScreen(p.ry), 7, '#f1e6c8', 'rgba(0,0,0,0.8)');
    g.restore();

    // north mark on the rim
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const nx = c * d.north[0] - s * d.north[1], ny = s * d.north[0] + c * d.north[1];
    label(g, t('map.north'), R + nx * (R - 11), R + ny * (R - 11), 11, '#e8c25a', 'rgba(5,9,12,0.9)');
  }

  private gMe: THREE.Vector3 = new THREE.Vector3();
  private gR = 0;
  /**
   * One guard on the radar (GuardRadarApi callback, so it uses the pose rendered this frame). Drawn
   * when his cone can reach the radar disc; cellhouse/gallery guards only when roughly on my level.
   * The cone is his actual view: TUNING.guard.fov wide around body + head/torch aim, as long as his
   * sight range, clipped by the radar circle; the arrow shows which way his body faces.
   */
  private readonly drawGuard = (i: number, gx: number, gy: number, gz: number, ry: number, viewYaw: number, mode: GuardMode, s: number) => {
    const v = this.view, g = this.g, me = this.gMe;
    const reach = TUNING.guard.range * v.s;
    if (Math.hypot(gx - me.x, gz - me.z) * v.s > this.gR + reach * TUNING.guard.litMul) return;
    if (GUARDS[i]?.area !== 'outside' && Math.abs(gy - me.y) > 5) return;
    const x = v.sx(gx, gz), y = v.sy(gx, gz);
    const alert = mode === 'chase' ? 2 : mode === 'suspicious' || mode === 'investigate' || s > 0.12 ? 1 : 0;
    const col = GUARD_COLORS[alert];
    const half = TUNING.guard.fov / 2;
    const look = v.yawToScreen(viewYaw);
    g.beginPath();
    g.moveTo(x, y);
    g.arc(x, y, reach, -Math.PI / 2 + look - half, -Math.PI / 2 + look + half);
    g.closePath();
    g.fillStyle = col.cone;
    g.fill();
    arrowGlyph(g, x, y, v.yawToScreen(ry), 5.5, col.body, 'rgba(0,0,0,0.85)');
  };
}

/** calm / suspicious ("?") / chasing ("!") */
const GUARD_COLORS = [
  { body: '#d8cfb6', cone: 'rgba(216,207,182,0.24)' },
  { body: '#e8a33a', cone: 'rgba(232,163,58,0.32)' },
  { body: '#e2483f', cone: 'rgba(226,72,63,0.38)' },
] as const;

// ------------------------------------------------------------------------------------------------
// Full map overlay (M)
// ------------------------------------------------------------------------------------------------
export class MapView {
  readonly el: HTMLElement;
  open = false;
  private readonly island: HTMLCanvasElement;
  private readonly inset: HTMLCanvasElement;
  private readonly gi: CanvasRenderingContext2D;
  private readonly gp: CanvasRenderingContext2D;
  private readonly vi = new View();
  private readonly vp = new View();
  private data: MapData | null = null;

  constructor(parent: HTMLElement, touch: boolean, onClose: () => void) {
    this.island = h('canvas', 'map-island');
    this.inset = h('canvas', 'map-inset');
    this.gi = this.island.getContext('2d')!;
    this.gp = this.inset.getContext('2d')!;
    const legend = h('ul', 'map-legend',
      h('li', undefined, h('i', 'lg lg-me'), h('span', { i18n: 'map.you' })),
      h('li', undefined, h('i', 'lg lg-crew'), h('span', { i18n: 'map.crew' })),
      h('li', undefined, h('i', 'lg lg-obj'), h('span', { i18n: 'map.objective' })),
      h('li', undefined, h('i', 'lg lg-launch'), h('span', { i18n: 'map.launch' })),
      h('li', undefined, h('i', 'lg lg-tower'), h('span', { i18n: 'map.tower' })),
      h('li', undefined, h('i', 'lg lg-boat'), h('span', { i18n: 'map.boat' })),
      h('li', undefined, h('i', 'lg lg-fence'), h('span', { i18n: 'map.fence' })));
    const card = h('article', 'dossier map-card',
      h('header', 'doc-head', h('span', { cls: 'doc-agency', i18n: 'map.title' }), h('span', { cls: 'doc-file', i18n: touch ? 'map.closeTouch' : 'map.close' })),
      h('div', 'map-body',
        h('div', 'map-main', this.island),
        h('aside', 'map-side', h('div', { cls: 'map-inset-title', i18n: 'map.inset' }), this.inset, legend)));
    this.el = h('div', `mapview hidden${touch ? ' interactive' : ''}`, card);
    if (touch) this.el.addEventListener('click', onClose);
    parent.append(this.el);
  }

  setData(d: MapData) { this.data = d; }
  setOpen(on: boolean) {
    this.open = on;
    this.el.classList.toggle('hidden', !on);
  }

  draw(ctx: Ctx, crew: readonly MapCrew[], target: V3 | null) {
    const d = this.data;
    if (!this.open || !d) return;
    this.drawIsland(ctx, d, crew, target);
    this.drawInset(ctx, d, crew, target);
  }

  private drawIsland(ctx: Ctx, d: MapData, crew: readonly MapCrew[], target: V3 | null) {
    const { w, h: hh, dpr } = fitCanvas(this.island);
    const g = this.gi, v = this.vi;
    const s = Math.min(w / (d.fit.w * 1.18), hh / (d.fit.h * 1.18));
    v.set(w / 2, hh / 2, s, d.northRot, d.fit.ox, d.fit.oz);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = PAL.paper.sea;
    g.fillRect(0, 0, w, hh);
    drawBase(g, d, v, 'paper', dpr, true);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ink = '#2b2418', halo = 'rgba(232,222,190,0.85)';
    const fs = Math.max(10, Math.min(14, w / 70));

    for (const l of d.labels) label(g, t(l.key), v.sx(l.x, l.z), v.sy(l.x, l.z) + (l.major ? 0 : 1), l.major ? fs + 2 : fs, ink, halo);
    // far-off places at the edge, in their real direction
    const c = Math.cos(v.rot), sn = Math.sin(v.rot);
    for (const b of d.bearings) {
      const bx = c * b.dx - sn * b.dz, by = sn * b.dx + c * b.dz;
      const k = Math.min((w / 2 - 70) / Math.max(1e-3, Math.abs(bx)), (hh / 2 - 22) / Math.max(1e-3, Math.abs(by)));
      const x = w / 2 + bx * k, y = hh / 2 + by * k;
      arrowGlyph(g, x, y, Math.atan2(bx, -by), 6, '#5d4e36', halo);
      label(g, t(b.key), x - bx * 14, y - by * 14, fs - 1, '#4a3e2b', halo);
    }
    // compass + scale bar
    arrowGlyph(g, w - 26, 34, 0, 10, '#8f3a2a', halo);
    label(g, t('map.north'), w - 26, 14, fs, '#8f3a2a', halo);
    const bar = 50 * s;
    g.strokeStyle = ink;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(16, hh - 16); g.lineTo(16 + bar, hh - 16);
    g.moveTo(16, hh - 20); g.lineTo(16, hh - 12);
    g.moveTo(16 + bar, hh - 20); g.lineTo(16 + bar, hh - 12);
    g.stroke();
    label(g, t('map.scale'), 16 + bar / 2, hh - 28, fs - 2, ink, halo);

    // towers, launch, patrol boat
    for (const sl of SEARCHLIGHTS) star(g, v.sx(sl.tower[0], sl.tower[2]), v.sy(sl.tower[0], sl.tower[2]), 5, '#f4efe0', '#3c3324');
    g.beginPath();
    g.arc(v.sx(LAUNCH.p[0], LAUNCH.p[2]), v.sy(LAUNCH.p[0], LAUNCH.p[2]), Math.max(5, LAUNCH.radius * s), 0, Math.PI * 2);
    g.lineWidth = 2;
    g.strokeStyle = '#8f3a2a';
    g.setLineDash([4, 3]);
    g.stroke();
    g.setLineDash([]);
    const pipeX = v.sx(BAKERY_PIPE.x, BAKERY_PIPE.z), pipeY = v.sy(BAKERY_PIPE.x, BAKERY_PIPE.z);
    dot(g, pipeX, pipeY, 3, '#3c3324', halo);
    const boat = ctx.actors()?.b;
    if (boat) arrowGlyph(g, v.sx(boat[0], boat[1]), v.sy(boat[0], boat[1]), v.yawToScreen(boat[2]), 6, '#3a4b55', halo);

    this.drawPeople(g, v, ctx, crew, target, ink, halo, 7, () => true);
  }

  private drawInset(ctx: Ctx, d: MapData, crew: readonly MapCrew[], target: V3 | null) {
    const { w, h: hh, dpr } = fitCanvas(this.inset);
    const g = this.gp, v = this.vp;
    const s = Math.min(w / 70, hh / 54);
    v.set(w / 2, hh / 2, s, 0, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#e6d9b4';
    g.fillRect(0, 0, w, hh);
    g.save();
    v.apply(g, dpr);
    drawPlan(g, d, PAL.paper, 1 / s);
    // my cell and the hole cells
    const me = ctx.world()?.players[ctx.myId];
    g.lineWidth = 2 / s;
    if (me) {
      const pc = PLAYER_CELLS[me.slot];
      g.strokeStyle = '#8f3a2a';
      g.strokeRect(pc.center[0] - 0.76, -9.0, 1.52, 2.74);
    }
    g.strokeStyle = 'rgba(143,58,42,0.7)';
    for (const hc of HOLE_CELLS) g.strokeRect(hc.inside[0] - 1, 14.1, 2, 3);
    g.restore();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    const ink = '#2b2418', halo = 'rgba(232,222,190,0.9)';
    const fs = Math.max(9, Math.min(12, w / 30));
    for (const b of BLOCKS) label(g, t('map.block', { b: b.id }), v.sx(b.x0 + 3, 0), v.sy(0, (b.zNorth + b.zSouth) / 2), fs, ink, halo);
    const aisle = (key: string, box: readonly number[]) => label(g, t(key), v.sx((box[0] + box[2]) / 2, 0), v.sy(0, (box[1] + box[3]) / 2), fs - 1, '#5d4e36', halo);
    aisle('area.broadway', AISLES.broadway);
    aisle('area.michigan', AISLES.michigan);
    aisle('area.park', AISLES.park);
    label(g, t('area.timesSquare'), v.sx(-29, 0), v.sy(0, 6), fs - 1, '#5d4e36', halo);
    label(g, t('area.library'), v.sx((LIBRARY.box[0] + LIBRARY.box[2]) / 2, 0), v.sy(0, (LIBRARY.box[1] + LIBRARY.box[3]) / 2), fs - 1, ink, halo);
    label(g, t('map.utility'), v.sx(10, 0), v.sy(0, UTILITY_B.z), Math.max(8, fs - 3), '#5d4e36', halo);
    // the inset is drawn in the building's own frame: show where true north is
    const ax = w - 22, ay = 30;
    arrowGlyph(g, ax, ay, Math.atan2(d.north[0], -d.north[1]), 9, '#8f3a2a', halo);
    label(g, t('map.north'), ax + d.north[0] * 18, ay + d.north[1] * 18, fs, '#8f3a2a', halo);

    this.drawPeople(g, v, ctx, crew, target, ink, halo, 6, (x, y, z) =>
      Math.abs(x) < 33 && Math.abs(z) < 25 && y > FLOOR - 2 && y < ROOF + 3);
  }

  private drawPeople(g: CanvasRenderingContext2D, v: View, ctx: Ctx, crew: readonly MapCrew[], target: V3 | null,
    ink: string, halo: string, size: number, inside: (x: number, y: number, z: number) => boolean) {
    if (target && inside(target[0], target[1], target[2])) star(g, v.sx(target[0], target[2]), v.sy(target[0], target[2]), size + 1, '#d9a925', ink);
    for (const m of crew) {
      if (m.isMe) continue;
      const ps = ctx.net.getPlayerState(m.id);
      if (!ps || !inside(ps.p[0], ps.p[1], ps.p[2])) continue;
      const x = v.sx(ps.p[0], ps.p[2]), y = v.sy(ps.p[0], ps.p[2]);
      dot(g, x, y, size * 0.7, m.color, ink);
      label(g, m.initial, x, y - size * 1.6, size + 4, ink, halo);
    }
    const p = ctx.player;
    if (p && inside(p.position.x, p.position.y, p.position.z)) {
      arrowGlyph(g, v.sx(p.position.x, p.position.z), v.sy(p.position.x, p.position.z), v.yawToScreen(p.ry), size + 2, '#e8c25a', ink);
    }
  }
}
