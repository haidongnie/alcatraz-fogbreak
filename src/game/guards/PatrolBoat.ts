// The Bureau of Prisons patrol launch circling offshore on BOAT_ROUTE (closed centripetal
// Catmull-Rom, ~4 m/s). Its pose is a pure function of the shared clock, so every client draws the
// same boat without networking. Hull bobbing/pitch/roll, navigation lights (emissive, no light
// objects), a curved foam wake ribbon sampled along the route behind the stern, and its own
// sweeping searchlight (Beacon).
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOAT_ROUTE, dirToYaw } from '../../world/layout';
import type { Ctx } from '../context';
import { Beacon } from './Beacon';
import type { WorldQueries } from './queries';

const SPEED = 4;              // m/s along the route
const DRAFT = 1.4;            // keel below the waterline (model pivot is bottom centre)
const STERN = 5.6;            // stern behind the hull centre (m)
const WAKE_N = 44;            // wake ribbon samples
const WAKE_SPACING = 2.2;     // metres between samples (~95 m of wake)
const WAKE_Y = 0.045;         // just above the sea plane
/** searchlight on the wheelhouse roof (boat frame: forward = -Z, waterline y = 0) */
const LAMP_LOCAL = [0, 4.9, -2.6] as const;

export class PatrolBoat {
  readonly root = new THREE.Group();
  readonly beacon: Beacon;
  private readonly curve: THREE.CatmullRomCurve3;
  private readonly length: number;
  private readonly wakeGeo: THREE.BufferGeometry;
  private readonly wakePos: Float32Array;
  private readonly wakePts = new Float32Array((WAKE_N + 1) * 2);
  private readonly wake: THREE.Mesh;
  private readonly lights: THREE.Mesh;
  private readonly p = new THREE.Vector3();
  private readonly p2 = new THREE.Vector3();

  constructor(private readonly ctx: Ctx, wisps: boolean) {
    this.curve = new THREE.CatmullRomCurve3(BOAT_ROUTE.map(([x, y, z]) => new THREE.Vector3(x, y, z)), true, 'centripetal');
    this.curve.arcLengthDivisions = 400;
    this.length = this.curve.getLength();

    const hull = ctx.models.instance('patrol_boat');
    hull.rotation.y = -Math.PI / 2; // the model's bow points along -X; our forward is -Z
    hull.position.y = -DRAFT;
    this.root.add(hull);
    this.root.rotation.order = 'YXZ';

    this.beacon = new Beacon({ range: 110, angle: 0.075, intensity: 1400, color: 0xf2f5ff, glareSize: 2.4, wisps });
    this.beacon.pivot.position.set(LAMP_LOCAL[0], LAMP_LOCAL[1], LAMP_LOCAL[2]);
    this.beacon.pivot.rotation.order = 'YXZ';
    this.root.add(this.beacon.pivot);

    this.lights = navigationLights();
    this.root.add(this.lights);

    // wake ribbon: positions rewritten every frame, everything else static
    this.wakePos = new Float32Array(WAKE_N * 2 * 3);
    const uvs = new Float32Array(WAKE_N * 2 * 2);
    const normals = new Float32Array(WAKE_N * 2 * 3);
    const index: number[] = [];
    for (let i = 0; i < WAKE_N; i++) {
      const v = i / (WAKE_N - 1);
      uvs.set([0, v, 1, v], i * 4);
      normals.set([0, 1, 0, 0, 1, 0], i * 6);
      if (i < WAKE_N - 1) {
        const a = i * 2;
        index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    this.wakeGeo = new THREE.BufferGeometry();
    this.wakeGeo.setAttribute('position', new THREE.BufferAttribute(this.wakePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.wakeGeo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    this.wakeGeo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.wakeGeo.setIndex(index);
    const tex = wakeTexture();
    this.wake = new THREE.Mesh(this.wakeGeo, new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex, emissive: 0x18222a, color: 0xd6dfe3, roughness: 0.9, metalness: 0,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2,
    }));
    this.wake.frustumCulled = false; // rewritten every frame; always near the boat
    this.wake.receiveShadow = false;
    this.wake.renderOrder = 2;

    ctx.scene.add(this.root, this.wake);
  }

  /** Arc-length position (m) along the loop at time t. */
  private arcAt(t: number) { return ((t * SPEED) % this.length + this.length) % this.length; }
  private pointAt(s: number, out: THREE.Vector3) {
    const u = ((s / this.length) % 1 + 1) % 1;
    return this.curve.getPointAt(u, out);
  }

  /** x, z, yaw at time t (deterministic). */
  pose(t: number): [number, number, number] {
    const s = this.arcAt(t);
    this.pointAt(s, this.p);
    this.pointAt(s + 1.5, this.p2);
    return [Math.round(this.p.x * 100) / 100, Math.round(this.p.z * 100) / 100, Math.round(dirToYaw(this.p2.x - this.p.x, this.p2.z - this.p.z) * 1000) / 1000];
  }

  update(t: number, q: WorldQueries, camPos: THREE.Vector3) {
    const s = this.arcAt(t);
    this.pointAt(s, this.p);
    this.pointAt(s + 1.5, this.p2);
    const yaw = dirToYaw(this.p2.x - this.p.x, this.p2.z - this.p.z);
    // swell: heave, pitch and roll from a few incommensurate sines
    this.root.position.set(this.p.x, 0.12 * Math.sin(t * 0.9) + 0.06 * Math.sin(t * 1.7 + 1), this.p.z);
    this.root.rotation.set(0.022 * Math.sin(t * 0.75), yaw, 0.035 * Math.sin(t * 0.6 + 0.5));

    // searchlight sweeps across the bow, mostly over the water ahead
    this.beacon.pivot.rotation.set(-(0.065 + 0.01 * Math.sin(t * 0.43)), 1.1 * Math.sin((t * Math.PI * 2) / 19) + 0.3 * Math.sin(t * 0.21), 0);
    this.beacon.refresh(q, camPos);

    this.updateWake(s);
  }

  private updateWake(s: number) {
    const pts = this.wakePts;
    // sample index -1 (just ahead of the stern) .. WAKE_N - 1, for central-difference tangents
    for (let i = -1; i < WAKE_N; i++) {
      this.pointAt(s - STERN - i * WAKE_SPACING, this.p);
      pts[(i + 1) * 2] = this.p.x;
      pts[(i + 1) * 2 + 1] = this.p.z;
    }
    const pos = this.wakePos;
    for (let i = 0; i < WAKE_N; i++) {
      const k = (i + 1) * 2;
      const prev = k - 2, next = Math.min(k + 2, WAKE_N * 2);
      let tx = pts[prev] - pts[next], tz = pts[prev + 1] - pts[next + 1];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      // spreads like a Kelvin wake (narrower than the true 19.5 deg; a slow launch makes a gentle wake)
      const half = 1.5 + 0.18 * i * WAKE_SPACING;
      const nx = -tz * half, nz = tx * half;
      const o = i * 6;
      pos[o] = pts[k] + nx; pos[o + 1] = WAKE_Y; pos[o + 2] = pts[k + 1] + nz;
      pos[o + 3] = pts[k] - nx; pos[o + 4] = WAKE_Y; pos[o + 5] = pts[k + 1] - nz;
    }
    (this.wakeGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose() {
    this.ctx.scene.remove(this.root, this.wake);
    this.wakeGeo.dispose();
    (this.wake.material as THREE.Material).dispose();
    this.lights.geometry.dispose();
    (this.lights.material as THREE.Material).dispose();
    this.beacon.dispose();
  }
}

/** Port (red), starboard (green), masthead and stern (white) lights merged into one emissive mesh. */
function navigationLights(): THREE.Mesh {
  const parts: [number, number, number, number, number][] = [
    // x, y, z (boat frame), colour, HDR multiplier
    [-1.1, 3.9, -1.8, 0xff2a18, 6],
    [1.1, 3.9, -1.8, 0x2aff6a, 5],
    [0, 5.5, -0.8, 0xfff4e0, 6],
    [0, 2.1, 5.8, 0xfff4e0, 4],
  ];
  const c = new THREE.Color();
  const geos = parts.map(([x, y, z, hex, k]) => {
    const g = new THREE.SphereGeometry(0.11, 10, 6);
    g.translate(x, y, z);
    c.setHex(hex).multiplyScalar(k);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  });
  const merged = mergeGeometries(geos)!;
  for (const g of geos) g.dispose();
  const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ vertexColors: true }));
  mesh.castShadow = mesh.receiveShadow = false;
  return mesh;
}

/** Foam: turbulent prop-wash down the middle, two spreading arms, fading toward the tail (top rows). */
function wakeTexture(): THREE.CanvasTexture {
  const W = 64, H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(W, H);
  // cheap deterministic value noise, streaky along the wake (slow in v, fast in u)
  const hash = (x: number, y: number) => {
    const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return h - Math.floor(h);
  };
  const noise = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  for (let y = 0; y < H; y++) {
    const v = 1 - (y + 0.5) / H; // canvas top = tail (v = 1 after the flipY upload)
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const c = Math.abs(u - 0.5) * 2; // 0 centre .. 1 edge
      const n = 0.55 * noise(u * 18, v * 6) + 0.45 * noise(u * 41, v * 15);
      const centre = Math.exp(-((c / (0.22 + 0.25 * v)) ** 2)) * (0.45 + 0.55 * n) * (1 - 0.6 * v);
      const arms = Math.exp(-(((c - 0.84) / 0.07) ** 2)) * (0.35 + 0.65 * n) * (0.35 + 0.65 * (1 - v));
      const head = Math.min(1, v * 40);
      const a = Math.min(1, (centre + arms) * (1 - v) ** 1.2 * head);
      const o = (y * W + x) * 4;
      img.data[o] = 236; img.data[o + 1] = 242; img.data[o + 2] = 245;
      img.data[o + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
