// Distant context so the bay reads as the real place: the hills around the bay as a silhouette
// ring (Angel Island, Marin, the Golden Gate, San Francisco, the East Bay) and the 1962 lights of
// San Francisco, Sausalito, Tiburon, the Bay Bridge and the Golden Gate Bridge.
//
// Real distances (2-15 km) are far beyond the camera's far plane, so everything is projected onto
// radii of ~1.15-1.42 km around the island while keeping its true bearing and elevation angle.
// Bearings are converted with island.json `northDir`.
import * as THREE from 'three/webgpu';
import { attribute, float, mix, texture, uniform, uv, vec3, vec4 } from 'three/tsl';
import { bearingDir, rng, type P2 } from './data';
import { glowTexture } from './textures';

/** Placed radius for a real distance (km): monotonic, inside the camera far plane from anywhere on the island. */
function placedRadius(km: number) {
  return 1150 + 270 * (1 - Math.exp(-(km - 1.8) / 3.2));
}
const RING_R = 1430;

/** Horizon elevation angle (degrees) by bearing: smooth control points from the real skyline. */
const SKYLINE: [number, number][] = [
  [0, 2.9], [8, 3.4], [18, 3.0], [30, 1.6], [40, 0.9], [55, 1.0], [70, 1.5], [90, 1.7], [104, 1.3],
  [110, 1.4], [116, 0.7], [128, 0.5], [140, 0.9], [160, 1.6], [180, 1.9], [195, 2.4], [212, 1.6],
  [230, 1.1], [246, 0.9], [254, 0.45], [261, 0.3], [268, 0.6], [278, 2.2], [292, 2.6], [310, 3.1],
  [325, 2.2], [338, 1.7], [350, 2.3], [360, 2.9],
];
function skyline(b: number) {
  b = ((b % 360) + 360) % 360;
  for (let i = 0; i < SKYLINE.length - 1; i++) {
    const [b0, e0] = SKYLINE[i], [b1, e1] = SKYLINE[i + 1];
    if (b >= b0 && b <= b1) {
      const t = (b - b0) / (b1 - b0);
      return e0 + (e1 - e0) * (t * t * (3 - 2 * t));
    }
  }
  return 1;
}

export interface Distant {
  group: THREE.Group;
  /** 0 = clear air, 1 = thick fog (silhouettes fade toward the fog colour, lights dim) */
  setHaze(h: number, fogColor: THREE.Color): void;
}

export function buildDistant(north: P2, center: P2): Distant {
  const group = new THREE.Group();
  group.name = 'distant';
  const rand = rng(9001);

  // ---------------------------------------------------------------------------------------------
  // Silhouette ring (+ Golden Gate towers) - unlit, fog-independent, hazed by a uniform.
  // ---------------------------------------------------------------------------------------------
  const hazeU = uniform(0.4);
  const fogU = uniform(new THREE.Color(0x0b0e13));
  const ringPos: number[] = [], ringUv: number[] = [], ringIdx: number[] = [];
  const SEG = 1080;
  for (let i = 0; i <= SEG; i++) {
    const b = (i / SEG) * 360;
    const [dx, dz] = bearingDir(north, b);
    // small-scale ridge detail
    const n = Math.sin(b * 0.37) * 0.12 + Math.sin(b * 1.31 + 1.7) * 0.07 + Math.sin(b * 3.9 + 0.4) * 0.03;
    const e = Math.max(0.15, skyline(b) + n * Math.min(1, skyline(b)));
    const top = RING_R * Math.tan((e * Math.PI) / 180);
    const x = center[0] + dx * RING_R, z = center[1] + dz * RING_R;
    ringPos.push(x, -4, z, x, top * 0.45, z, x, top, z);
    ringUv.push(b / 360, 0, b / 360, 0.45, b / 360, 1);
    if (i < SEG) {
      const k = i * 3;
      for (let r = 0; r < 2; r++) ringIdx.push(k + r, k + r + 3, k + r + 1, k + r + 1, k + r + 3, k + r + 4);
    }
  }
  // Golden Gate Bridge towers (227 m) and deck (67 m), real geometry projected like the lights
  const gg = goldenGate(north);
  for (const s of [-640, 640]) {
    const p = project(gg.at(s, 0), center);
    const pt = project(gg.at(s, 227), center);
    // the bridge runs across the line of sight, so a tower shows its narrow side along the axis
    const [ax, az] = gg.axis;
    const w = 1.5; // placed half-width
    const base = ringPos.length / 3;
    for (const [px, py, pz] of [[p[0] - ax * w, -2, p[2] - az * w], [p[0] + ax * w, -2, p[2] + az * w], [pt[0] + ax * w * 0.8, pt[1], pt[2] + az * w * 0.8], [pt[0] - ax * w * 0.8, pt[1], pt[2] - az * w * 0.8]]) {
      ringPos.push(px, py, pz);
      ringUv.push(0, 1);
    }
    ringIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const ringGeo = new THREE.BufferGeometry();
  ringGeo.setAttribute('position', new THREE.Float32BufferAttribute(ringPos, 3));
  ringGeo.setAttribute('uv', new THREE.Float32BufferAttribute(ringUv, 2));
  ringGeo.setIndex(ringIdx);
  ringGeo.computeBoundingSphere();
  const ringMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
  const hill = vec3(0.004, 0.0055, 0.006);
  // base of the hills sinks into the haze, ridges stay darker
  const k = hazeU.mul(float(1).sub(uv().y.mul(0.55)));
  ringMat.colorNode = mix(hill, fogU, k);
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.name = 'distant-hills';
  ring.frustumCulled = false;
  ring.renderOrder = -10;
  group.add(ring);

  // ---------------------------------------------------------------------------------------------
  // Lights: camera-facing-ish quads (oriented toward the island), additive, one draw call.
  // ---------------------------------------------------------------------------------------------
  const lp: number[] = [], lc: number[] = [], luv: number[] = [], li: number[] = [];
  const addLight = (bearing: number, km: number, h: number, col: [number, number, number], bright: number, size = 1) => {
    const [dx, dz] = bearingDir(north, bearing);
    const R = placedRadius(km);
    const y = (h * R) / (km * 1000);
    const x = center[0] + dx * R, z = center[1] + dz * R;
    const s = R * 0.0023 * size;
    const tx = -dz * s, tz = dx * s; // tangent (horizontal, across the line of sight)
    const base = lp.length / 3;
    lp.push(x - tx, y - s, z - tz, x + tx, y - s, z + tz, x + tx, y + s, z + tz, x - tx, y + s, z - tz);
    for (let i = 0; i < 4; i++) lc.push(col[0] * bright, col[1] * bright, col[2] * bright);
    luv.push(0, 0, 1, 0, 1, 1, 0, 1);
    li.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const addProjected = (p: [number, number, number], col: [number, number, number], bright: number, size = 1) => {
    // p is a real-world offset from Alcatraz (x, y, z) in metres
    const d = Math.hypot(p[0], p[2]);
    const b = bearingOf(north, p[0], p[2]);
    addLight(b, d / 1000, p[1], col, bright, size);
  };
  const warm: [number, number, number] = [1.0, 0.72, 0.42];
  const mercury: [number, number, number] = [0.72, 0.9, 1.0];
  const white: [number, number, number] = [1.0, 0.95, 0.85];
  const pick = () => { const r = rand(); return r < 0.55 ? warm : r < 0.85 ? mercury : white; };

  // San Francisco: waterfront 2.0 km at 177-201 deg, the city climbing Russian/Nob/Telegraph hills
  const shoreKm = (b: number) => b < 150 ? 2.9 - (b - 135) * 0.04 : b < 177 ? 2.3 - (b - 150) * 0.011 : b < 205 ? 2.0 : 2.0 + (b - 205) * 0.035;
  const hillH = (b: number, km: number) => {
    const telegraph = 84 * Math.exp(-(((b - 160) / 6) ** 2) - ((km - 2.3) / 0.35) ** 2);
    const russian = 90 * Math.exp(-(((b - 182) / 7) ** 2) - ((km - 2.6) / 0.4) ** 2);
    const nob = 110 * Math.exp(-(((b - 170) / 8) ** 2) - ((km - 3.2) / 0.5) ** 2);
    const pac = 110 * Math.exp(-(((b - 200) / 10) ** 2) - ((km - 3.3) / 0.8) ** 2);
    const twin = 260 * Math.exp(-(((b - 192) / 9) ** 2) - ((km - 6.6) / 1.2) ** 2);
    return 8 + telegraph + russian + nob + pac + twin + Math.max(0, km - 2) * 12;
  };
  for (let i = 0; i < 1900; i++) {
    const b = 133 + Math.pow(rand(), 0.9) * 105;
    if (b > 226 && rand() < 0.7) continue; // the Presidio is dark
    const km = shoreKm(b) + 0.05 + (-Math.log(1 - rand() * 0.97)) * 1.4;
    if (km > 8) continue;
    const h = hillH(b, km) + rand() * 25;
    const bright = 2.6 * Math.pow(2 / km, 1.3) * (0.4 + rand() * 0.8);
    addLight(b + (rand() - 0.5) * 0.3, km, h, pick(), bright, 0.8 + rand() * 0.5);
  }
  // Embarcadero / Marina waterfront strings
  for (let b = 140; b <= 222; b += 0.45) addLight(b, shoreKm(b) + 0.02, 6, warm, 3.0 * Math.pow(2 / shoreKm(b), 1.3), 0.9);
  // Sausalito (303 deg, 6.3 km) and Tiburon / Belvedere (~345 deg, 5.5 km)
  for (let i = 0; i < 160; i++) addLight(299 + rand() * 9, 6.0 + rand() * 0.9, 5 + rand() * 120, pick(), 0.9 + rand() * 0.5, 0.9);
  for (let i = 0; i < 90; i++) addLight(337 + rand() * 13, 5.2 + rand() * 1.2, 5 + rand() * 90, pick(), 0.8 + rand() * 0.5, 0.9);
  // Angel Island: a handful at Fort McDowell / the quarantine station
  for (let i = 0; i < 14; i++) addLight(14 + rand() * 18, 3.4 + rand() * 1.2, 4 + rand() * 30, warm, 0.7 + rand() * 0.6, 0.8);
  // East Bay (Berkeley / Oakland / Richmond) - a faint carpet
  for (let i = 0; i < 520; i++) addLight(42 + rand() * 66, 10 + rand() * 6, 5 + rand() * 160 * rand(), pick(), 0.35 + rand() * 0.35, 0.8);
  // Bay Bridge: SF anchorage (~140 deg, 3.4 km) -> Yerba Buena (110 deg, 5.1 km) -> Oakland (95 deg, 8.6 km)
  const bb: [number, number][] = [[140, 3.4], [110, 5.1], [95, 8.6]];
  for (let s = 0; s < bb.length - 1; s++) {
    const a = toXZ(north, bb[s][0], bb[s][1] * 1000), c = toXZ(north, bb[s + 1][0], bb[s + 1][1] * 1000);
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    for (let d = 0; d < len; d += 45) {
      const t = d / len;
      addProjected([a[0] + (c[0] - a[0]) * t, 58, a[1] + (c[1] - a[1]) * t], warm, 1.4, 0.9);
    }
  }
  // Golden Gate Bridge deck lights + red tower beacons
  for (let s = -1300; s <= 1300; s += 26) {
    const arch = 67 + 8 * (1 - (s / 1300) ** 2);
    addProjected(gg.at(s, arch), [1.0, 0.78, 0.5], 1.1, 0.75);
  }
  for (const s of [-640, 640]) addProjected(gg.at(s, 230), [1.0, 0.12, 0.08], 3.0, 1.3);

  const lightGeo = new THREE.BufferGeometry();
  lightGeo.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  lightGeo.setAttribute('lc', new THREE.Float32BufferAttribute(lc, 3));
  lightGeo.setAttribute('uv', new THREE.Float32BufferAttribute(luv, 2));
  lightGeo.setIndex(li);
  lightGeo.computeBoundingSphere();
  const visU = uniform(1.0);
  const lightMat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
  });
  const glow = texture(glowTexture(), uv()).a;
  lightMat.colorNode = vec4(attribute('lc', 'vec3').mul(glow).mul(visU), 1);
  const lights = new THREE.Mesh(lightGeo, lightMat);
  lights.name = 'distant-lights';
  lights.frustumCulled = false;
  lights.renderOrder = -9;
  group.add(lights);

  group.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); });

  return {
    group,
    setHaze(h, fogColor) {
      hazeU.value = THREE.MathUtils.clamp(h, 0, 1);
      fogU.value.copy(fogColor);
      visU.value = THREE.MathUtils.clamp(1.15 - h, 0.1, 1);
    },
  };
}

// ------------------------------------------------------------------------------------------------
function toXZ(north: P2, bearing: number, metres: number): P2 {
  const [dx, dz] = bearingDir(north, bearing);
  return [dx * metres, dz * metres];
}
function bearingOf(north: P2, x: number, z: number) {
  const ex = -north[1], ez = north[0];
  const n = x * north[0] + z * north[1], e = x * ex + z * ez;
  return ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360;
}
/** Projects a real offset (from Alcatraz) onto the placed sphere. */
function project(p: [number, number, number], center: P2): [number, number, number] {
  const d = Math.hypot(p[0], p[2]);
  const R = placedRadius(d / 1000);
  return [center[0] + (p[0] / d) * R, (p[1] * R) / d, center[1] + (p[2] / d) * R];
}
/** The Golden Gate Bridge: centre 4.7 km at 261 deg, axis across the line of sight. */
function goldenGate(north: P2) {
  const c = toXZ(north, 261, 4700);
  const axis = bearingDir(north, 351);
  return {
    axis,
    at(s: number, y: number): [number, number, number] { return [c[0] + axis[0] * s, y, c[1] + axis[1] * s]; },
  };
}
