// Small procedural canvas textures shared by the item and raft visuals: the pickup highlight
// (ground glow + halo sprite) and the foam used for paddle splashes and the raft's wake.
// Each is drawn once on first use and cached for the lifetime of the page.
import * as THREE from 'three/webgpu';

const cache = new Map<string, THREE.Texture>();

function canvasTexture(key: string, size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  draw(g, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  cache.set(key, tex);
  return tex;
}

/** Deterministic pseudo-random sequence (textures look the same on every client). */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Soft disc for the ground under a pickup: faint centre, brighter rim, smooth fall-off. */
export function glowTexture(): THREE.Texture {
  return canvasTexture('glow', 128, (g, s) => {
    const c = s / 2;
    const grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0.0, 'rgba(255,236,196,0.30)');
    grad.addColorStop(0.55, 'rgba(255,226,170,0.42)');
    grad.addColorStop(0.72, 'rgba(255,214,150,0.55)');
    grad.addColorStop(0.86, 'rgba(255,200,130,0.18)');
    grad.addColorStop(1.0, 'rgba(255,190,120,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });
}

/** Round soft halo (sprite) that makes a small item readable in the dark. */
export function haloTexture(): THREE.Texture {
  return canvasTexture('halo', 64, (g, s) => {
    const c = s / 2;
    const grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0.0, 'rgba(255,240,210,0.9)');
    grad.addColorStop(0.25, 'rgba(255,226,180,0.35)');
    grad.addColorStop(0.6, 'rgba(255,214,160,0.08)');
    grad.addColorStop(1.0, 'rgba(255,210,150,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });
}

/**
 * Broken foam ring with speckles (white on black: used with additive blending, so black is
 * transparent). The ring expands outward for paddle splashes; scaled patches make the wake.
 */
export function foamTexture(): THREE.Texture {
  return canvasTexture('foam', 128, (g, s) => {
    const c = s / 2;
    g.fillStyle = '#000';
    g.fillRect(0, 0, s, s);
    const rnd = lcg(1962);
    // soft inner wash
    const wash = g.createRadialGradient(c, c, 0, c, c, c);
    wash.addColorStop(0, 'rgba(200,214,222,0.22)');
    wash.addColorStop(0.6, 'rgba(200,214,222,0.12)');
    wash.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = wash;
    g.fillRect(0, 0, s, s);
    // ring of foam blobs of varying size and brightness
    for (let i = 0; i < 260; i++) {
      const a = rnd() * Math.PI * 2;
      const r = c * (0.62 + (rnd() - 0.5) * 0.22);
      const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
      const rad = 1 + rnd() * 3.2;
      const v = Math.round(170 + rnd() * 85);
      g.fillStyle = `rgba(${v},${v + 4},${v + 8},${(0.25 + rnd() * 0.6).toFixed(2)})`;
      g.beginPath();
      g.arc(x, y, rad, 0, Math.PI * 2);
      g.fill();
    }
    // scattered speckles inside
    for (let i = 0; i < 120; i++) {
      const a = rnd() * Math.PI * 2;
      const r = c * Math.sqrt(rnd()) * 0.55;
      const v = Math.round(150 + rnd() * 80);
      g.fillStyle = `rgba(${v},${v},${v + 6},${(0.15 + rnd() * 0.35).toFixed(2)})`;
      g.fillRect(c + Math.cos(a) * r, c + Math.sin(a) * r, 1.5, 1.5);
    }
    // fade the square's edge so nothing clips
    const edge = g.createRadialGradient(c, c, c * 0.8, c, c, c);
    edge.addColorStop(0, 'rgba(0,0,0,0)');
    edge.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = edge;
    g.fillRect(0, 0, s, s);
  });
}
