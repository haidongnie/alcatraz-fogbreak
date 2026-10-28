// Shared light-shaft visuals for flashlights, tower searchlights and the patrol boat:
// - `createBeam`: a soft additive cone ("volumetric" shaft). Brightness falls off along the beam,
//   toward the silhouette edges and with the scene's FogExp2 transmittance; denser fog scatters more
//   light so shafts read stronger outdoors than in the cellhouse. Optional drifting fog wisps (TSL noise).
// - `createGlare`: an HDR lens sprite that blooms when the beam points at the camera.
// - `glyphTexture`: the "?" / "!" alert glyphs above guards' heads.
// Textures are drawn once on canvas and cached; materials are per instance (own intensity uniform)
// but share one shader program.
import * as THREE from 'three/webgpu';
import {
  abs, clamp, dot, exp, length, mx_noise_float, normalView, normalize, positionView, positionWorld,
  smoothstep, time, uniform, uv, vec3,
} from 'three/tsl';

/** FogExp2 density the shafts attenuate with; kept in sync with scene.fog by syncBeamFog(). */
const fogDensity = uniform(0.006);

/** Call once per frame: the atmosphere changes fog density between indoors and outdoors. */
export function syncBeamFog(scene: THREE.Scene) {
  const f = scene.fog;
  let d = 0;
  if (f) d = 'isFogExp2' in f ? f.density : 1.6 / Math.max(1, f.far);
  fogDensity.value = d;
}

let coneGeo: THREE.BufferGeometry | null = null;
/** Open cone, apex at the origin, pointing down -Z, length 1, radius 1 at the far end. */
function unitCone(): THREE.BufferGeometry {
  if (!coneGeo) {
    coneGeo = new THREE.CylinderGeometry(0.03, 1, 1, 28, 1, true);
    coneGeo.translate(0, -0.5, 0); // apex (radiusTop, uv.y = 1) at y = 0
    coneGeo.rotateX(Math.PI / 2);  // -Y -> -Z
  }
  return coneGeo;
}

export interface Beam {
  readonly mesh: THREE.Mesh;
  /** 0..1 brightness multiplier (0 = off) */
  readonly intensity: { value: number };
  /** sets the visible length (m); the radius follows the cone angle */
  setLength(l: number): void;
}

export interface BeamOptions {
  color: THREE.ColorRepresentation;
  /** HDR colour multiplier of the shaft at full brightness */
  strength: number;
  /** visible half-angle (rad) */
  angle: number;
  /** exponent of the falloff along the beam (higher = shorter-looking shaft) */
  falloff?: number;
  /** drifting fog wisps (costs a 3D noise per fragment: high tier, big beams only) */
  wisps?: boolean;
}

export function createBeam(o: BeamOptions): Beam {
  const uIntensity = uniform(1);
  const uColor = uniform(new THREE.Color(o.color).multiplyScalar(o.strength));

  const along = uv().y.oneMinus();                                  // 0 at the lens, 1 at the far end
  const facing = abs(dot(normalView, normalize(positionView.negate())));
  const edge = facing.mul(facing.sqrt());                           // ^1.5: soft silhouette
  const axial = along.oneMinus().pow(o.falloff ?? 1.4).mul(smoothstep(0.0, 0.02, along));
  const fd = length(positionView).mul(fogDensity);
  const fogT = exp(fd.mul(fd).negate());                            // FogExp2 transmittance to the camera
  const scatter = clamp(fogDensity.mul(110).add(0.35), 0.35, 1.5);  // thicker fog = brighter shaft
  let shape = edge.mul(axial).mul(fogT).mul(scatter).mul(uIntensity);
  if (o.wisps) {
    const drift = vec3(time.mul(0.3), time.mul(0.04), time.mul(0.17));
    shape = shape.mul(mx_noise_float(positionWorld.mul(0.11).add(drift)).mul(0.3).add(0.82));
  }

  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
  });
  mat.colorNode = uColor;
  mat.opacityNode = clamp(shape, 0, 1);

  const mesh = new THREE.Mesh(unitCone(), mat);
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.renderOrder = 10;
  const tan = Math.tan(o.angle);
  return {
    mesh,
    intensity: uIntensity,
    setLength(l: number) { mesh.scale.set(l * tan, l * tan, Math.max(l, 0.01)); },
  };
}

let glareTex: THREE.CanvasTexture | null = null;
function glareTexture(): THREE.CanvasTexture {
  if (glareTex) return glareTex;
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.07, 'rgba(255,252,245,0.9)');
  r.addColorStop(0.22, 'rgba(255,244,228,0.28)');
  r.addColorStop(0.55, 'rgba(255,238,215,0.06)');
  r.addColorStop(1, 'rgba(255,238,215,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, s, s);
  // faint horizontal streak, like light smeared on a wet lens
  const h = g.createLinearGradient(0, 0, s, 0);
  h.addColorStop(0, 'rgba(255,255,255,0)');
  h.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  h.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = h;
  g.fillRect(0, s / 2 - 1.5, s, 3);
  glareTex = new THREE.CanvasTexture(c);
  glareTex.colorSpace = THREE.SRGBColorSpace;
  return glareTex;
}

/** Additive lens glare (HDR colour so it blooms). Drive `material.opacity` / scale per frame. */
export function createGlare(color: THREE.ColorRepresentation, size: number, hdr = 3): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: glareTexture(), color: new THREE.Color(color).multiplyScalar(hdr), blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, fog: false,
  });
  const s = new THREE.Sprite(mat);
  s.scale.setScalar(size);
  s.renderOrder = 11;
  return s;
}

const glyphs = new Map<string, THREE.CanvasTexture>();
/** White glyph with a dark outline (tinted by the sprite colour). */
export function glyphTexture(ch: '?' | '!'): THREE.CanvasTexture {
  const cached = glyphs.get(ch);
  if (cached) return cached;
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.font = '900 104px "Arial Black", Impact, "Helvetica Neue", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 14;
  g.strokeStyle = 'rgba(16,12,8,0.85)';
  g.strokeText(ch, s / 2, s / 2 + 6);
  g.fillStyle = '#ffffff';
  g.fillText(ch, s / 2, s / 2 + 6);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  glyphs.set(ch, tex);
  return tex;
}
