// Procedural textures for the exterior, generated once at startup and cached by name.
// Colour maps are sRGB, data maps (noise, normals, roughness, masks) linear. Everything tiles.
import * as THREE from 'three/webgpu';
import { rng } from './data';

const cache = new Map<string, THREE.Texture>();
function cached<T extends THREE.Texture>(key: string, make: () => T): T {
  let t = cache.get(key) as T | undefined;
  if (!t) { t = make(); cache.set(key, t); }
  return t;
}

// ------------------------------------------------------------------------------------------------
// Tileable value-noise fBm
// ------------------------------------------------------------------------------------------------
/** fBm of periodic value noise on a size x size grid, `period` lattice cells across at octave 0. Range ~0..1. */
export function fbm(size: number, seed: number, period: number, octaves: number, gain = 0.5, stretchY = 1): Float32Array {
  const out = new Float32Array(size * size);
  const rand = rng(seed);
  let amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const px = period << o, py = Math.max(1, Math.round((period << o) / stretchY));
    const lat = new Float32Array(px * py);
    for (let i = 0; i < lat.length; i++) lat[i] = rand();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * py, y0 = Math.floor(fy), ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % py) * px, r1 = ((y0 + 1) % py) * px;
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * px, x0 = Math.floor(fx), tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % px, c1 = (x0 + 1) % px;
        const a = lat[r0 + c0] + (lat[r0 + c1] - lat[r0 + c0]) * sx;
        const b = lat[r1 + c0] + (lat[r1 + c1] - lat[r1 + c0]) * sx;
        out[y * size + x] += (a + (b - a) * sy) * amp;
      }
    }
    norm += amp;
    amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Stretch a noise field's contrast around its mean. */
function contrast(f: Float32Array, k: number) {
  for (let i = 0; i < f.length; i++) f[i] = Math.min(1, Math.max(0, 0.5 + (f[i] - 0.5) * k));
  return f;
}

function dataTexture(data: Uint8Array, size: number, srgb: boolean, h = size): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Tangent-space normal map (RGB) from a tileable height field. */
function normalFromHeight(h: Float32Array, size: number, strength: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)], r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x], d = h[((y + 1) % size) * size + x];
      const nx = (l - r) * strength, ny = (u - d) * strength;
      const inv = 1 / Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      out[i] = (nx * inv * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      out[i + 2] = (inv * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Shared noise / detail
// ------------------------------------------------------------------------------------------------
/** RGBA detail noise (linear): R broad fBm, G mid fBm, B fine speckle, A vertical streaks. */
export function detailTexture() {
  return cached('detail', () => {
    const S = 512;
    const r = contrast(fbm(S, 11, 4, 6, 0.55), 1.6);
    const g = contrast(fbm(S, 23, 8, 5, 0.5), 1.5);
    const b = contrast(fbm(S, 37, 48, 2, 0.5), 1.8);
    const a = contrast(fbm(S, 41, 24, 4, 0.55, 6), 1.7);
    const d = new Uint8Array(S * S * 4);
    for (let i = 0; i < S * S; i++) {
      d[i * 4] = r[i] * 255; d[i * 4 + 1] = g[i] * 255; d[i * 4 + 2] = b[i] * 255; d[i * 4 + 3] = a[i] * 255;
    }
    return dataTexture(d, S, false);
  });
}

/** Rock/ground normal map matching detailTexture().r (cracks + lumps). */
export function rockNormalTexture() {
  return cached('rockNormal', () => {
    const S = 512;
    const h = fbm(S, 11, 4, 6, 0.55);
    const fine = fbm(S, 53, 32, 3, 0.5);
    for (let i = 0; i < h.length; i++) h[i] = h[i] * 0.7 + fine[i] * 0.3 - Math.abs(fine[i] - 0.5) * 0.25;
    return dataTexture(normalFromHeight(h, S, 18), S, false);
  });
}

// ------------------------------------------------------------------------------------------------
// Building / wall materials (canvas-free pixel fills: fast and deterministic)
// ------------------------------------------------------------------------------------------------
interface SurfaceSet { map: THREE.DataTexture; rough: THREE.DataTexture; normal: THREE.DataTexture }

/** Board-formed painted concrete (1 tile = 4 m): faint horizontal form lines, stains, streaks. */
export function concreteTextures(): SurfaceSet {
  const key = 'concrete';
  if (cache.has(key + ':map')) {
    return { map: cache.get(key + ':map') as THREE.DataTexture, rough: cache.get(key + ':rough') as THREE.DataTexture, normal: cache.get(key + ':normal') as THREE.DataTexture };
  }
  const S = 512;
  const big = fbm(S, 101, 3, 5, 0.55);
  const grain = fbm(S, 103, 64, 2, 0.5);
  const streak = contrast(fbm(S, 107, 12, 4, 0.5, 8), 1.8);
  const col = new Uint8Array(S * S * 4), rough = new Uint8Array(S * S * 4);
  const height = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    const board = (y / S) * 20; // 20 form boards per 4 m
    const seam = Math.max(0, 1 - Math.abs(board - Math.round(board)) * 14);
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const stain = Math.max(0, big[i] - 0.55) * 1.6 + Math.max(0, streak[i] - 0.6) * 0.8 * (y / S);
      const v = 0.86 + (grain[i] - 0.5) * 0.12 - stain * 0.35 - seam * 0.06;
      col[i * 4] = Math.min(255, v * 236); col[i * 4 + 1] = Math.min(255, v * 228); col[i * 4 + 2] = Math.min(255, v * 210); col[i * 4 + 3] = 255;
      const rv = 0.78 + grain[i] * 0.16 + stain * 0.1 - seam * 0.05;
      rough[i * 4] = rough[i * 4 + 1] = rough[i * 4 + 2] = Math.min(255, rv * 255); rough[i * 4 + 3] = 255;
      height[i] = grain[i] * 0.4 + big[i] * 0.4 - seam * 0.5;
    }
  }
  const set = { map: dataTexture(col, S, true), rough: dataTexture(rough, S, false), normal: dataTexture(normalFromHeight(height, S, 5), S, false) };
  cache.set(key + ':map', set.map); cache.set(key + ':rough', set.rough); cache.set(key + ':normal', set.normal);
  return set;
}

/** Asphalt / macadam road (u across 0..1, v along; 1 tile = road width square). */
export function asphaltTextures(): SurfaceSet {
  const key = 'asphalt';
  if (cache.has(key + ':map')) {
    return { map: cache.get(key + ':map') as THREE.DataTexture, rough: cache.get(key + ':rough') as THREE.DataTexture, normal: cache.get(key + ':normal') as THREE.DataTexture };
  }
  const S = 256;
  const big = fbm(S, 201, 4, 4, 0.5);
  const grain = fbm(S, 203, 64, 2, 0.6);
  const crack = fbm(S, 207, 10, 4, 0.6);
  const col = new Uint8Array(S * S * 4), rough = new Uint8Array(S * S * 4);
  const height = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const u = x / S;
      const edge = Math.max(0, 1 - Math.min(u, 1 - u) * 9); // worn/dusty edges
      const c = Math.max(0, 1 - Math.abs(crack[i] - 0.5) * 40) * (big[i] > 0.5 ? 1 : 0.3);
      const wheel = Math.max(0, 1 - Math.abs(Math.abs(u - 0.5) - 0.22) * 9) * 0.06; // polished wheel tracks
      const v = 0.32 + (grain[i] - 0.5) * 0.16 + (big[i] - 0.5) * 0.12 + edge * 0.18 - c * 0.12 + wheel;
      col[i * 4] = v * 200; col[i * 4 + 1] = v * 198; col[i * 4 + 2] = v * 192; col[i * 4 + 3] = 255;
      const rv = 0.9 - wheel * 2.5 + (grain[i] - 0.5) * 0.1 - (big[i] < 0.4 ? 0.12 : 0); // damp patches
      rough[i * 4] = rough[i * 4 + 1] = rough[i * 4 + 2] = Math.max(0, Math.min(255, rv * 255)); rough[i * 4 + 3] = 255;
      height[i] = grain[i] - c * 0.8;
    }
  }
  const set = { map: dataTexture(col, S, true), rough: dataTexture(rough, S, false), normal: dataTexture(normalFromHeight(height, S, 4), S, false) };
  cache.set(key + ':map', set.map); cache.set(key + ':rough', set.rough); cache.set(key + ':normal', set.normal);
  return set;
}

/** Tar-and-gravel roof (1 tile = 4 m). */
export function roofTextures(): SurfaceSet {
  const key = 'roof';
  if (cache.has(key + ':map')) {
    return { map: cache.get(key + ':map') as THREE.DataTexture, rough: cache.get(key + ':rough') as THREE.DataTexture, normal: cache.get(key + ':normal') as THREE.DataTexture };
  }
  const S = 256;
  const big = fbm(S, 301, 3, 4, 0.5);
  const grain = fbm(S, 303, 96, 1);
  const col = new Uint8Array(S * S * 4), rough = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const v = 0.3 + (grain[i] - 0.5) * 0.35 + (big[i] - 0.5) * 0.2;
    col[i * 4] = v * 190; col[i * 4 + 1] = v * 186; col[i * 4 + 2] = v * 178; col[i * 4 + 3] = 255;
    const rv = 0.9 - (big[i] < 0.35 ? 0.35 : 0); // puddles
    rough[i * 4] = rough[i * 4 + 1] = rough[i * 4 + 2] = rv * 255; rough[i * 4 + 3] = 255;
  }
  const set = { map: dataTexture(col, S, true), rough: dataTexture(rough, S, false), normal: dataTexture(normalFromHeight(grain, S, 3), S, false) };
  cache.set(key + ':map', set.map); cache.set(key + ':rough', set.rough); cache.set(key + ':normal', set.normal);
  return set;
}

/** Weathered timber planks for the pier (u across planks: 1 tile = 2 m, 10 planks). */
export function woodTextures(): SurfaceSet {
  const key = 'wood';
  if (cache.has(key + ':map')) {
    return { map: cache.get(key + ':map') as THREE.DataTexture, rough: cache.get(key + ':rough') as THREE.DataTexture, normal: cache.get(key + ':normal') as THREE.DataTexture };
  }
  const S = 256;
  const grainN = fbm(S, 401, 8, 4, 0.5, 0.08);
  const big = fbm(S, 403, 4, 3, 0.5);
  const col = new Uint8Array(S * S * 4), rough = new Uint8Array(S * S * 4);
  const height = new Float32Array(S * S);
  const rand = rng(405);
  const plankTone = Array.from({ length: 10 }, () => 0.8 + rand() * 0.35);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const p = (x / S) * 10, pi = Math.floor(p), f = p - pi;
      const gap = f < 0.06 ? 1 : 0;
      const tone = plankTone[pi % 10] * (0.75 + grainN[i] * 0.5) * (0.85 + big[i] * 0.3);
      const v = gap ? 0.08 : tone * 0.42;
      col[i * 4] = v * 220; col[i * 4 + 1] = v * 196; col[i * 4 + 2] = v * 160; col[i * 4 + 3] = 255;
      rough[i * 4] = rough[i * 4 + 1] = rough[i * 4 + 2] = (gap ? 1 : 0.8 + grainN[i] * 0.15) * 255; rough[i * 4 + 3] = 255;
      height[i] = gap ? 0 : 0.6 + grainN[i] * 0.4;
    }
  }
  const set = { map: dataTexture(col, S, true), rough: dataTexture(rough, S, false), normal: dataTexture(normalFromHeight(height, S, 3), S, false) };
  cache.set(key + ':map', set.map); cache.set(key + ':rough', set.rough); cache.set(key + ':normal', set.normal);
  return set;
}

/**
 * Facade window layout (linear data, 8 bays x 4 floors per tile; bay 3.6 m, floor 3.3 m):
 * R = glass mask, G = per-window random (lit selection), B = per-window shade, A = frame/sill.
 */
export const WINDOW_TILE = { bays: 8, floors: 4, bay: 3.6, floor: 3.3 };
export function windowTexture() {
  return cached('windows', () => {
    const W = 512, H = 256;
    const d = new Uint8Array(W * H * 4);
    const rand = rng(501);
    const cw = W / WINDOW_TILE.bays, ch = H / WINDOW_TILE.floors;
    const g: number[] = [], b: number[] = [];
    for (let k = 0; k < WINDOW_TILE.bays * WINDOW_TILE.floors; k++) { g.push(rand()); b.push(rand()); }
    for (let y = 0; y < H; y++) {
      const fy = (y % ch) / ch, row = Math.floor(y / ch);
      for (let x = 0; x < W; x++) {
        const fx = (x % cw) / cw, col = Math.floor(x / cw);
        const k = row * WINDOW_TILE.bays + col;
        // window opening 1.5 m wide, 0.9 .. 2.6 m above the floor line
        const inX = fx > 0.29 && fx < 0.71, inY = fy > 0.27 && fy < 0.79;
        const frameX = fx > 0.27 && fx < 0.73, frameY = fy > 0.24 && fy < 0.82;
        const mullion = Math.abs(fx - 0.5) < 0.012 || Math.abs(fy - 0.53) < 0.012;
        const glass = inX && inY && !mullion ? 1 : 0;
        const i = (y * W + x) * 4;
        d[i] = glass * 255;
        d[i + 1] = g[k] * 255;
        d[i + 2] = b[k] * 255;
        d[i + 3] = frameX && frameY && !glass ? 255 : 0;
      }
    }
    const tex = dataTexture(d, W, false, H);
    tex.anisotropy = 4;
    return tex;
  });
}

/** Chain-link fence (alpha-tested; 1 tile = 0.5 m, ~9 diamonds). RGB = galvanised grey, A = wire. */
export function chainLinkTexture() {
  return cached('chainlink', () => {
    const S = 128;
    const d = new Uint8Array(S * S * 4);
    const n = 9; // diamonds per tile
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = (x / S) * n, v = (y / S) * n;
        const a = Math.abs(((u + v) % 1) - 0.5), b = Math.abs(((u - v + n) % 1) - 0.5);
        const wire = Math.max(1 - Math.min(a, 0.5) * 9, 1 - Math.min(b, 0.5) * 9);
        const i = (y * S + x) * 4;
        const shade = 150 + 60 * Math.max(0, wire);
        d[i] = shade; d[i + 1] = shade; d[i + 2] = shade * 0.97;
        d[i + 3] = Math.max(0, Math.min(255, wire * 255 * 1.6));
      }
    }
    const tex = dataTexture(d, S, true);
    tex.anisotropy = 4;
    return tex;
  });
}

/** Soft radial glow (linear, white): lamp halos, distant lights, light pools. */
export function glowTexture() {
  return cached('glow', () => {
    const S = 64;
    const d = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const r = Math.hypot((x + 0.5) / S - 0.5, (y + 0.5) / S - 0.5) * 2;
        const v = Math.max(0, 1 - r);
        const g = Math.pow(v, 2.2) * 0.75 + Math.pow(v, 10) * 0.25;
        const i = (y * S + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = g * 255;
      }
    }
    const tex = dataTexture(d, S, false);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  });
}

/** Tileable sea normal map built from integer-frequency sine waves (always seamless). */
export function seaNormalTexture() {
  return cached('seaNormal', () => {
    const S = 256;
    const h = new Float32Array(S * S);
    const rand = rng(601);
    const waves = Array.from({ length: 14 }, () => ({
      kx: Math.round((rand() - 0.5) * 16), ky: Math.round((rand() - 0.5) * 16), ph: rand() * Math.PI * 2, a: 0.3 + rand(),
    })).filter((w) => w.kx !== 0 || w.ky !== 0);
    const chop = fbm(S, 603, 16, 3, 0.5);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let v = 0;
        for (const w of waves) {
          const k = Math.hypot(w.kx, w.ky);
          v += (w.a / k) * Math.sin(((w.kx * x + w.ky * y) / S) * Math.PI * 2 + w.ph);
        }
        h[y * S + x] = v * 0.5 + chop[y * S + x] * 0.35;
      }
    }
    return dataTexture(normalFromHeight(h, S, 2.2), S, false);
  });
}

// ------------------------------------------------------------------------------------------------
// Canvas textures (text and line art)
// ------------------------------------------------------------------------------------------------
function canvasTexture(canvas: HTMLCanvasElement, srgb = true) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** A weathered painted sign board. `lines` are drawn centred; the first line may be a header. */
export function signTexture(key: string, lines: { text: string; size: number; weight?: string }[], w: number, h: number, opts: { bg?: string; fg?: string; border?: boolean } = {}) {
  return cached(`sign:${key}`, () => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    g.fillStyle = opts.bg ?? '#e9e4d6';
    g.fillRect(0, 0, w, h);
    // weathering: soft blotches and drips
    const rand = rng(w * 7 + h);
    for (let i = 0; i < 70; i++) {
      g.fillStyle = `rgba(90,80,60,${0.03 + rand() * 0.05})`;
      const x = rand() * w, y = rand() * h, r = 8 + rand() * w * 0.06;
      g.beginPath(); g.ellipse(x, y, r, r * (0.4 + rand()), 0, 0, Math.PI * 2); g.fill();
    }
    for (let i = 0; i < 25; i++) {
      g.fillStyle = `rgba(80,60,40,${0.05 + rand() * 0.06})`;
      g.fillRect(rand() * w, rand() * h * 0.5, 1 + rand() * 2, h * (0.2 + rand() * 0.5));
    }
    if (opts.border !== false) {
      g.strokeStyle = opts.fg ?? '#1c1c1a';
      g.lineWidth = Math.max(4, h * 0.03);
      g.strokeRect(g.lineWidth, g.lineWidth, w - g.lineWidth * 2, h - g.lineWidth * 2);
    }
    g.fillStyle = opts.fg ?? '#1c1c1a';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const total = lines.reduce((s, l) => s + l.size * 1.25, 0);
    let y = (h - total) / 2;
    for (const l of lines) {
      g.font = `${l.weight ?? '700'} ${l.size}px "Courier New", "Courier", monospace`;
      // squeeze to fit the board
      const m = g.measureText(l.text).width;
      const sx = Math.min(1, (w * 0.9) / Math.max(1, m));
      g.save();
      g.translate(w / 2, y + l.size * 0.625);
      g.scale(sx, 1);
      g.fillText(l.text, 0, 0);
      g.restore();
      y += l.size * 1.25;
    }
    return canvasTexture(c);
  });
}

/** Recreation-yard floor paint (softball diamond, handball lines) in yard UV (1 unit = 1 m / 80). */
export function yardPaintTexture() {
  return cached('yardPaint', () => {
    const S = 1024;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, S, S);
    const m = S / 80; // pixels per metre; the texture spans 80 x 80 m from the yard's min (x, z) corner
    g.strokeStyle = '#fff';
    g.lineWidth = 0.12 * m;
    // softball diamond: home plate near the yard's north-west, field opening south-east
    const hx = 30 * m, hy = 6 * m, base = 18.3 * m;
    g.save();
    g.translate(hx, hy);
    g.rotate(Math.PI / 4);
    g.strokeRect(0, 0, base, base);
    g.beginPath(); g.arc(0, 0, base * 1.9, 0.05, Math.PI / 2 - 0.05); g.stroke();
    g.restore();
    // handball / court boxes in front of the bleachers
    for (let i = 0; i < 3; i++) g.strokeRect((56 + i * 8) * m, 20 * m, 6 * m, 10 * m);
    const tex = canvasTexture(c, false);
    tex.flipY = false; // canvas row 0 = the yard's min z
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  });
}
