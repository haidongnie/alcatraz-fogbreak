// Pooled foam on the water surface (paddle splashes, the raft's wake, the launch): one
// InstancedMesh of flat quads with additive blending, faded through the instance colour.
// Fixed pool size; nothing is allocated per frame.
import * as THREE from 'three/webgpu';
import { foamTexture } from '../interact/textures';

/** just above the sea plane (y = 0) */
const WATER_Y = 0.03;
/** manual distance fade (the material ignores scene fog: additive + fog would tint the quads) */
const FADE_DENSITY = 0.01;

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);

export class Splashes {
  readonly mesh: THREE.InstancedMesh;
  private readonly x: Float32Array;
  private readonly z: Float32Array;
  private readonly rot: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size0: Float32Array;
  private readonly size1: Float32Array;
  private readonly alpha: Float32Array;
  private readonly live: Uint8Array;
  private next = 0;
  private alive = 0;
  private seed = 1;

  constructor(scene: THREE.Scene, private readonly count: number) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      map: foamTexture(), color: 0xc6d3dc, transparent: true, depthWrite: false, fog: false,
      blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.name = 'raft-splashes';
    this.mesh.frustumCulled = false; // instances roam; the pool is tiny
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.renderOrder = 3;
    _m.makeScale(0, 0, 0);
    _c.setRGB(0, 0, 0);
    for (let i = 0; i < count; i++) {
      this.mesh.setMatrixAt(i, _m);
      this.mesh.setColorAt(i, _c);
    }
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.x = new Float32Array(count);
    this.z = new Float32Array(count);
    this.rot = new Float32Array(count);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.size0 = new Float32Array(count);
    this.size1 = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.live = new Uint8Array(count);
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** A foam patch at (x, z) growing from size0 to size1 metres over `life` seconds. */
  spawn(x: number, z: number, size0: number, size1: number, life: number, alpha: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.count;
    if (!this.live[i]) this.alive++;
    this.live[i] = 1;
    this.x[i] = x;
    this.z[i] = z;
    this.rot[i] = this.rand() * Math.PI * 2;
    this.age[i] = 0;
    this.life[i] = Math.max(0.05, life);
    this.size0[i] = size0;
    this.size1[i] = size1;
    this.alpha[i] = alpha;
    this.mesh.visible = true;
  }

  /** a value in [-1, 1) for jittering spawn points */
  jitter() { return this.rand() * 2 - 1; }

  update(dt: number, camera: THREE.Vector3) {
    if (this.alive === 0) return;
    for (let i = 0; i < this.count; i++) {
      if (!this.live[i]) continue;
      this.age[i] += dt;
      const k = this.age[i] / this.life[i];
      if (k >= 1) {
        this.live[i] = 0;
        this.alive--;
        _m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _m);
        this.mesh.setColorAt(i, _c.setRGB(0, 0, 0));
        continue;
      }
      // fast expansion that slows down, fade-out that lingers
      const grow = 1 - (1 - k) * (1 - k);
      const s = this.size0[i] + (this.size1[i] - this.size0[i]) * grow;
      _p.set(this.x[i], WATER_Y, this.z[i]);
      _q.setFromAxisAngle(_up, this.rot[i] + k * 0.4);
      _s.set(s, 1, s);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
      const dist = Math.hypot(this.x[i] - camera.x, WATER_Y - camera.y, this.z[i] - camera.z);
      const a = this.alpha[i] * Math.pow(1 - k, 1.4) * Math.min(1, k * 8) * Math.exp(-dist * FADE_DENSITY);
      this.mesh.setColorAt(i, _c.setRGB(a, a, a));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
    if (this.alive === 0) this.mesh.visible = false;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }

  private rand() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
}
