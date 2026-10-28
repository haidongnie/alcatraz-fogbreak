// Procedural PBR textures for the cellhouse, drawn once on canvases at startup:
// colour (sRGB), roughness (linear, always varied) and normal maps (from a height field).
// All noise is tileable so the world-projected UVs repeat seamlessly.
import * as THREE from 'three/webgpu';
import { rng } from './batch';

export interface PBRSet { map: THREE.Texture; rough: THREE.Texture; normal: THREE.Texture | null; }

const N = 512;

/** Tileable value noise (period lattice cells across an n x n image), values 0..1. */
function valueNoise(n: number, period: number, r: () => number, out: Float32Array, amp: number) {
  const lat = new Float32Array(period * period);
  for (let i = 0; i < lat.length; i++) lat[i] = r();
  const cell = n / period;
  for (let y = 0; y < n; y++) {
    const gy = y / cell;
    const iy = Math.floor(gy);
    let fy = gy - iy;
    fy = fy * fy * (3 - 2 * fy);
    const r0 = (iy % period) * period, r1 = ((iy + 1) % period) * period;
    for (let x = 0; x < n; x++) {
      const gx = x / cell;
      const ix = Math.floor(gx);
      let fx = gx - ix;
      fx = fx * fx * (3 - 2 * fx);
      const c0 = ix % period, c1 = (ix + 1) % period;
      const a = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * fx;
      const b = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * fx;
      out[y * n + x] += (a + (b - a) * fy) * amp;
    }
  }
}

/** Fractal noise, normalised to 0..1. */
function fbm(n: number, period: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(n * n);
  const r = rng(seed);
  let amp = 1, total = 0, p = period;
  for (let o = 0; o < octaves && p <= n; o++) {
    valueNoise(n, p, r, out, amp);
    total += amp;
    amp *= 0.5;
    p *= 2;
  }
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < out.length; i++) { const v = out[i] / total; out[i] = v; if (v < mn) mn = v; if (v > mx) mx = v; }
  const k = 1 / Math.max(1e-6, mx - mn);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - mn) * k;
  return out;
}

/** Shared 512^2 noise fields (low/mid/high frequency), sampled with offsets by every texture. */
class Bank {
  readonly low = fbm(N, 4, 5, 11);
  readonly mid = fbm(N, 16, 4, 23);
  readonly high = fbm(N, 64, 3, 37);
}
let bank: Bank | null = null;
function noise() { return (bank ??= new Bank()); }
function at(f: Float32Array, x: number, y: number) { return f[((y | 0) & (N - 1)) * N + ((x | 0) & (N - 1))]; }
const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
function hash(i: number) { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function toTexture(c: HTMLCanvasElement, srgb: boolean, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function fromPixels(w: number, h: number, data: Uint8ClampedArray, srgb: boolean) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  return toTexture(c, srgb);
}

/** Tangent-space normal map from a tileable height field (canvas y down, texture v up). */
function normalFromHeight(hgt: Float32Array, n: number, strength: number) {
  const out = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) {
    const ym = ((y - 1 + n) % n) * n, yp = ((y + 1) % n) * n, yc = y * n;
    for (let x = 0; x < n; x++) {
      const dx = hgt[yc + ((x + 1) % n)] - hgt[yc + ((x - 1 + n) % n)];
      const dy = hgt[yp + x] - hgt[ym + x];
      let nx = -dx * strength, ny = dy * strength;
      const len = Math.hypot(nx, ny, 1);
      nx /= len; ny /= len;
      const i = (yc + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (0.5 / len + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Generic generator: per-pixel callback returns colour, roughness and height. */
function generate(n: number, normalStrength: number, px: (x: number, y: number, o: { r: number; g: number; b: number; rough: number; h: number }) => void): PBRSet {
  const col = new Uint8ClampedArray(n * n * 4);
  const rough = new Uint8ClampedArray(n * n * 4);
  const hgt = new Float32Array(n * n);
  const o = { r: 0, g: 0, b: 0, rough: 0.8, h: 0 };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      o.r = o.g = o.b = 128; o.rough = 0.8; o.h = 0;
      px(x, y, o);
      const i = (y * n + x) * 4;
      col[i] = clamp255(o.r); col[i + 1] = clamp255(o.g); col[i + 2] = clamp255(o.b); col[i + 3] = 255;
      const rv = clamp255(o.rough * 255);
      rough[i] = rough[i + 1] = rough[i + 2] = rv; rough[i + 3] = 255;
      hgt[y * n + x] = o.h;
    }
  }
  return {
    map: fromPixels(n, n, col, true),
    rough: fromPixels(n, n, rough, false),
    normal: normalStrength > 0 ? fromPixels(n, n, normalFromHeight(hgt, n, normalStrength), false) : null,
  };
}

// ------------------------------------------------------------------------------------------------
// Surfaces
// ------------------------------------------------------------------------------------------------

/** Cream/buff paint over board-formed concrete (tile 2.5 m): 14 boards, butt joints, chips, streaks. */
export function wallTexture(): PBRSet {
  const nb = noise();
  const boardH = N / 14;
  return generate(N, 2.2, (x, y, o) => {
    const board = Math.floor(y / boardH);
    const yb = y - board * boardH;
    const shade = (hash(board) - 0.5) * 0.07;
    const grain = at(nb.mid, x, y * 4 + board * 41);
    const low = at(nb.low, x + 90, y + 40);
    const joint = yb < 1.8 ? 1 : 0;
    const butt = ((x + Math.floor(hash(board + 7) * N)) % 230) < 1.6 ? 1 : 0;
    const chipN = at(nb.high, x + 17, y + 211);
    const chip = chipN > 0.8 && low > 0.45 ? 1 : 0;
    const streak = at(nb.low, x * 4 + 33, y);
    let k = 1 + shade + (low - 0.5) * 0.14 + (grain - 0.5) * 0.06;
    if (joint || butt) k *= 0.86;
    let r = 212 * k, g = 201 * k, b = 172 * k;
    if (streak > 0.6) { const s = (streak - 0.6) * 0.9; r *= 1 - s * 0.55; g *= 1 - s * 0.6; b *= 1 - s * 0.75; }
    if (chip) { r = 142 + grain * 14; g = 140 + grain * 14; b = 133 + grain * 12; }
    o.r = r; o.g = g; o.b = b;
    o.rough = chip ? 0.92 : 0.74 + (grain - 0.5) * 0.12 + (streak > 0.6 ? 0.06 : 0);
    o.h = grain * 0.35 + low * 0.25 + (joint ? 0.5 : 0) - chip * 0.45;
  });
}

/** Worn grey cellhouse floor (tile 4 m): polished walking paths, stains, aggregate, control joints. */
export function floorTexture(): PBRSet {
  const nb = noise();
  return generate(N, 1.4, (x, y, o) => {
    const low = at(nb.low, x, y);
    const polish = Math.max(0, at(nb.low, x + 260, y + 130) - 0.5) * 2;
    const mid = at(nb.mid, x + 70, y + 300);
    const hi = at(nb.high, x, y);
    const groove = x < 2 || y < 2 ? 1 : 0;
    let k = 0.92 + (low - 0.5) * 0.22 + polish * 0.08 + (hi - 0.5) * 0.06;
    if (mid > 0.72) k *= 1 - (mid - 0.72) * 1.1; // oil / water stains
    if (hi > 0.86) k *= 1.12;
    if (groove) k *= 0.55;
    o.r = 138 * k; o.g = 137 * k; o.b = 131 * k;
    o.rough = Math.min(0.95, 0.8 - polish * 0.32 + (hi - 0.5) * 0.12 + (mid > 0.72 ? -0.12 : 0) + groove * 0.1);
    o.h = hi * 0.3 + low * 0.1 - groove * 0.8;
  });
}

/** Pale "cucumber" mint cell paint with off-white undercoat chips and scuffs (tile 2 m). */
export function cellPaintTexture(): PBRSet {
  const nb = noise();
  return generate(N, 1.2, (x, y, o) => {
    const low = at(nb.low, x + 400, y + 77);
    const trowel = at(nb.mid, x * 2 + y, y + 51);
    const scuff = at(nb.low, x * 2 + 150, y * 2 + 9);
    const hi = at(nb.high, x + 300, y + 400);
    const chip = hi > 0.82 && trowel > 0.5 ? 1 : 0;
    let k = 1 + (low - 0.5) * 0.1 + (trowel - 0.5) * 0.05;
    if (scuff > 0.74) k *= 1 - (scuff - 0.74) * 0.9;
    o.r = 176 * k; o.g = 200 * k; o.b = 172 * k;
    if (chip) { o.r = 222; o.g = 219; o.b = 202; }
    o.rough = chip ? 0.86 : 0.68 + (trowel - 0.5) * 0.1 + (scuff > 0.74 ? 0.08 : 0);
    o.h = trowel * 0.25 + low * 0.15 - chip * 0.3;
  });
}

/** Painted steel (tile 1 m) in a given colour, with chips down to dark primer and rust. */
export function paintedSteelTexture(base: [number, number, number], seedX: number): PBRSet {
  const nb = noise();
  const n = 256;
  return generate(n, 1.0, (x, y, o) => {
    const low = at(nb.low, x * 2 + seedX, y * 2);
    const hi = at(nb.high, x * 2 + seedX, y * 2 + 91);
    const mid = at(nb.mid, x * 2, y * 2 + seedX);
    const chip = hi > 0.83 ? 1 : 0;
    const rust = chip && mid > 0.55 ? 1 : 0;
    const k = 1 + (low - 0.5) * 0.12 + (mid - 0.5) * 0.05;
    o.r = base[0] * k; o.g = base[1] * k; o.b = base[2] * k;
    if (chip) { o.r = rust ? 118 : 62; o.g = rust ? 72 : 60; o.b = rust ? 44 : 56; }
    o.rough = chip ? 0.82 : 0.46 + (low - 0.5) * 0.16 + (mid - 0.5) * 0.08;
    o.h = chip ? -0.4 : mid * 0.1;
  });
}

/** Utility-corridor pipes: dull paint, rust bloom, drips (tile 1 m). */
export function pipeTexture(): PBRSet {
  const nb = noise();
  const n = 256;
  return generate(n, 1.2, (x, y, o) => {
    const low = at(nb.low, x * 2 + 50, y * 2 + 300);
    const mid = at(nb.mid, x * 2 + 9, y * 8);
    const hi = at(nb.high, x * 2, y * 2 + 5);
    const rust = low > 0.58 ? Math.min(1, (low - 0.58) * 5) : 0;
    const k = 1 + (mid - 0.5) * 0.1;
    o.r = (98 + rust * 28) * k; o.g = (94 - rust * 22) * k; o.b = (84 - rust * 40) * k;
    o.rough = 0.58 + rust * 0.3 + (hi - 0.5) * 0.1;
    o.h = rust * hi * 0.6 + mid * 0.1;
  });
}

/** Tar-and-gravel roof (tile 3 m): pebbles, bitumen, smoother wet patches. */
export function roofTexture(): PBRSet {
  const nb = noise();
  const r = rng(77);
  const stones = new Float32Array(N * N);
  // scatter pebbles (2-5 px) into a stone height field
  for (let i = 0; i < 26000; i++) {
    const cx = r() * N, cy = r() * N, rad = 1 + r() * 2.2, tone = r();
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > rad) continue;
      const idx = (((cy + dy) | 0) & (N - 1)) * N + (((cx + dx) | 0) & (N - 1));
      stones[idx] = Math.max(stones[idx], (1 - d / rad) * (0.6 + tone * 0.4));
    }
  }
  return generate(N, 3.0, (x, y, o) => {
    const s = stones[y * N + x];
    const low = at(nb.low, x + 333, y + 21);
    const wet = low > 0.66 ? Math.min(1, (low - 0.66) * 6) : 0;
    const tone = 0.5 + hash(Math.floor(x / 3) * 977 + Math.floor(y / 3)) * 0.5;
    const tar = 34 + (at(nb.mid, x, y) - 0.5) * 14;
    const st = 82 + tone * 46;
    const k = s > 0.05 ? st : tar;
    o.r = k * (1 - wet * 0.25); o.g = k * 0.98 * (1 - wet * 0.25); o.b = k * 0.93 * (1 - wet * 0.22);
    o.rough = 0.93 - wet * 0.38 - (s > 0.05 ? 0.04 : 0);
    o.h = s * 0.9 + low * 0.1;
  });
}

/** Planked timber (tile 2 m, planks along u). */
export function woodTexture(): PBRSet {
  const nb = noise();
  const plankH = N / 8;
  return generate(N, 1.0, (x, y, o) => {
    const plank = Math.floor(y / plankH);
    const yp = y - plank * plankH;
    const grain = at(nb.mid, x / 2 + plank * 61, y * 6);
    const fine = at(nb.high, x / 3, y * 3 + plank * 13);
    const seam = yp < 1.5 ? 1 : 0;
    const k = 1 + (hash(plank) - 0.5) * 0.25 + (grain - 0.5) * 0.35 + (fine - 0.5) * 0.08;
    o.r = 112 * k; o.g = 78 * k; o.b = 50 * k;
    if (seam) { o.r *= 0.45; o.g *= 0.45; o.b *= 0.45; }
    o.rough = 0.62 + (grain - 0.5) * 0.14 + seam * 0.2;
    o.h = grain * 0.4 - seam * 0.7;
  });
}

/** Grey army wool (tile 1 m) with a darker end stripe; tinted per panel by vertex colour. */
export function blanketTexture(): PBRSet {
  const nb = noise();
  const n = 256;
  return generate(n, 1.6, (x, y, o) => {
    const weave = ((x + y) & 1) * 0.04 + ((x >> 1) & 1) * 0.02;
    const fuzz = at(nb.high, x * 2 + 7, y * 2 + 3);
    const low = at(nb.low, x * 2, y * 2 + 200);
    const stripe = (y > 26 && y < 34) || (y > 40 && y < 44) ? 1 : 0;
    let k = 0.9 + weave + (fuzz - 0.5) * 0.18 + (low - 0.5) * 0.14;
    if (stripe) k *= 0.55;
    o.r = 150 * k; o.g = 146 * k; o.b = 134 * k;
    o.rough = 0.94 + (fuzz - 0.5) * 0.06;
    o.h = fuzz * 0.5 + weave * 4;
  });
}

/** Striped mattress ticking (tile 1 m). */
export function mattressTexture(): PBRSet {
  const nb = noise();
  const n = 256;
  return generate(n, 0.6, (x, y, o) => {
    const stripe = (x % 16) < 4 ? 1 : 0;
    const grime = at(nb.low, x * 2 + 99, y * 2 + 99);
    const k = 1 - Math.max(0, grime - 0.55) * 0.6;
    if (stripe) { o.r = 86 * k; o.g = 98 * k; o.b = 124 * k; } else { o.r = 208 * k; o.g = 202 * k; o.b = 184 * k; }
    o.rough = 0.9;
    o.h = stripe * 0.2 + grime * 0.1;
  });
}

/** Rows of book spines; the atlas has 4 shelf rows (v quarters), u repeats every 1 m. */
export function booksTexture(): PBRSet {
  const n = 512;
  const c = canvas(n, n);
  const g = c.getContext('2d')!;
  const r = rng(5);
  const palette = ['#5b1f1c', '#22324f', '#2c4532', '#5a4428', '#7a6236', '#3b2a3e', '#6b3a22', '#2d2d2d', '#4f5a3c', '#8a7a58', '#3f4c5c'];
  g.fillStyle = '#120e0a';
  g.fillRect(0, 0, n, n);
  for (let row = 0; row < 4; row++) {
    const y0 = row * 128;
    let x = 0;
    while (x < n) {
      const w = 7 + Math.floor(r() * 16);
      const h = 78 + Math.floor(r() * 44);
      if (r() < 0.06) { x += w; continue; } // gap
      const col = palette[Math.floor(r() * palette.length)];
      const lean = r() < 0.05 ? 3 : 0;
      g.fillStyle = col;
      g.fillRect(x + lean, y0 + 128 - h, Math.min(w - 1, n - x), h);
      // spine bands and a title label
      g.fillStyle = 'rgba(210,190,140,0.55)';
      g.fillRect(x + 1, y0 + 128 - h + 8, Math.max(1, w - 3), 3);
      g.fillRect(x + 1, y0 + 128 - 14, Math.max(1, w - 3), 2);
      if (w > 12) { g.fillStyle = 'rgba(230,220,190,0.35)'; g.fillRect(x + 3, y0 + 128 - h + 22, w - 7, 18); }
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(x + w - 2, y0 + 128 - h, 1, h);
      x += w;
    }
  }
  const map = toTexture(c, true);
  const rc = canvas(64, 64);
  const rg = rc.getContext('2d')!;
  rg.fillStyle = 'rgb(205,205,205)';
  rg.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 300; i++) { const v = 170 + Math.floor(r() * 70); rg.fillStyle = `rgb(${v},${v},${v})`; rg.fillRect(Math.floor(r() * 64), Math.floor(r() * 64), 2, 2); }
  return { map, rough: toTexture(rc, false), normal: null };
}

/** Welded wire mesh (alpha-tested), tile 0.5 m. */
export function meshTexture(): THREE.Texture {
  const n = 128;
  const c = canvas(n, n);
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, n, n);
  g.fillStyle = 'rgba(150,150,145,1)';
  const step = n / 8;
  for (let i = 0; i < 8; i++) {
    g.fillRect(i * step, 0, 2, n);
    g.fillRect(0, i * step, n, 2);
  }
  return toTexture(c, true);
}

/**
 * Window glow atlas: 4 variants side by side (u quarters), each a steel sash with 4 x 8 panes.
 * Colour = dark glass; emissive = what leaks out at night (cold fluorescent / warm / almost dark).
 */
export function windowGlowTextures(): { map: THREE.Texture; emissive: THREE.Texture } {
  const w = 512, h = 256;
  const cm = canvas(w, h), ce = canvas(w, h);
  const gm = cm.getContext('2d')!, ge = ce.getContext('2d')!;
  const r = rng(91);
  gm.fillStyle = '#0d1116'; gm.fillRect(0, 0, w, h);
  ge.fillStyle = '#000'; ge.fillRect(0, 0, w, h);
  const cols = 4, rows = 8;
  for (let v = 0; v < 4; v++) {
    const x0 = v * 128;
    const pw = 128 / cols, ph = h / rows;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const px = x0 + i * pw, py = j * ph;
      // glass: faint sky reflection gradient, a few cracked/painted panes
      const sky = 18 + (1 - j / rows) * 14 + r() * 6;
      gm.fillStyle = `rgb(${sky * 0.8},${sky * 0.92},${sky * 1.1})`;
      gm.fillRect(px + 2, py + 2, pw - 4, ph - 4);
      let lit: number;
      if (v === 0) lit = 0.22 + r() * 0.15;                 // cold, even
      else if (v === 1) lit = r() < 0.35 ? 0.55 + r() * 0.3 : 0.12 + r() * 0.1; // a few bright panes
      else if (v === 2) lit = (j / rows) * 0.45 + r() * 0.1; // warm, brighter toward the sill
      else lit = r() * 0.08;                                 // dark
      const warm = v === 2;
      const R = (warm ? 255 : 190) * lit, G = (warm ? 196 : 214) * lit, B = (warm ? 120 : 255) * lit;
      ge.fillStyle = `rgb(${R | 0},${G | 0},${B | 0})`;
      ge.fillRect(px + 2, py + 2, pw - 4, ph - 4);
    }
    // heavier mullion in the middle
    gm.fillStyle = '#05070a'; gm.fillRect(x0 + 62, 0, 4, h);
  }
  return { map: toTexture(cm, true, false), emissive: toTexture(ce, true, false) };
}

/** Painted aisle-sign atlas: 4 rows (v quarters). */
export const SIGN_ROWS = ['BROADWAY', 'MICHIGAN AVE.', 'PARK AVE.', 'TIMES SQUARE'] as const;
export function signTexture(): THREE.Texture {
  const w = 1024, h = 512;
  const c = canvas(w, h);
  const g = c.getContext('2d')!;
  const r = rng(13);
  SIGN_ROWS.forEach((text, i) => {
    const y0 = i * 128;
    g.fillStyle = '#d9d2bc';
    g.fillRect(0, y0, w, 128);
    g.strokeStyle = '#1b1b1b';
    g.lineWidth = 8;
    g.strokeRect(10, y0 + 10, w - 20, 108);
    g.fillStyle = '#161616';
    g.font = 'bold 78px "Courier New", Courier, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, y0 + 66, w - 60);
  });
  // wear: scattered flecks of bare board
  for (let i = 0; i < 2500; i++) {
    g.fillStyle = `rgba(120,112,92,${0.15 + r() * 0.35})`;
    g.fillRect(r() * w, r() * h, 1 + r() * 3, 1 + r() * 2);
  }
  const t = toTexture(c, true, false);
  return t;
}

/** Cell number plates: 32 slots (8 x 4), 128 x 64 px each. */
export function plateTexture(labels: string[]): THREE.Texture {
  const w = 1024, h = 256;
  const c = canvas(w, h);
  const g = c.getContext('2d')!;
  g.fillStyle = '#1d1f1c';
  g.fillRect(0, 0, w, h);
  labels.slice(0, 32).forEach((label, i) => {
    const x0 = (i % 8) * 128, y0 = Math.floor(i / 8) * 64;
    g.fillStyle = '#e6e1cf';
    g.fillRect(x0 + 6, y0 + 8, 116, 48);
    g.fillStyle = '#111';
    g.font = 'bold 34px "Courier New", Courier, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, x0 + 64, y0 + 33, 108);
  });
  return toTexture(c, true, false);
}

/** Simple grey roughness noise (shared by materials without their own maps). */
export function genericRoughness(): THREE.Texture {
  const nb = noise();
  const n = 128;
  const data = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = clamp255((0.75 + (at(nb.mid, x * 4, y * 4) - 0.5) * 0.3) * 255);
    const i = (y * n + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  return fromPixels(n, n, data, false);
}
