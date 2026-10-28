import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

interface Tracked {
  body: RAPIER.RigidBody;
  object: THREE.Object3D;
  prevPos: THREE.Vector3;
  prevRot: THREE.Quaternion;
  syncRotation: boolean;
}

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/**
 * Rapier world with a fixed timestep and render-side interpolation.
 * Physics runs at `step` Hz regardless of display refresh; meshes are interpolated between
 * the last two physics states so 60 Hz physics looks smooth on 120/144 Hz screens.
 */
export class Physics {
  world!: RAPIER.World;
  eventQueue!: RAPIER.EventQueue;
  readonly step = 1 / 60;
  private accumulator = 0;
  private readonly tracked: Tracked[] = [];

  static async create(gravity = { x: 0, y: -9.81, z: 0 }) {
    await RAPIER.init(); // loads the inlined WASM; safe to call more than once
    const p = new Physics();
    p.world = new RAPIER.World(gravity);
    p.world.timestep = p.step;
    p.eventQueue = new RAPIER.EventQueue(true);
    return p;
  }

  /**
   * Make a Three object follow a Rapier body (world-space; do not parent the object to moving nodes).
   * `syncRotation: false` for objects whose rotation is driven elsewhere (e.g. the player root).
   */
  track(body: RAPIER.RigidBody, object: THREE.Object3D, { syncRotation = true } = {}) {
    const t = body.translation();
    const r = body.rotation();
    this.tracked.push({
      body,
      object,
      prevPos: new THREE.Vector3(t.x, t.y, t.z),
      prevRot: new THREE.Quaternion(r.x, r.y, r.z, r.w),
      syncRotation,
    });
    object.position.set(t.x, t.y, t.z);
    if (syncRotation) object.quaternion.set(r.x, r.y, r.z, r.w);
  }

  untrack(body: RAPIER.RigidBody) {
    const i = this.tracked.findIndex((t) => t.body === body);
    if (i >= 0) this.tracked.splice(i, 1);
  }

  /**
   * Advance the simulation by the frame delta. `onFixedStep` runs before each physics step
   * (apply forces, move kinematic bodies, character controller).
   */
  update(dt: number, onFixedStep?: (step: number) => void) {
    this.accumulator += Math.min(dt, 0.1); // never simulate a 30 s tab-switch
    let steps = 0;
    while (this.accumulator >= this.step && steps < 5) {
      for (const t of this.tracked) {
        const p = t.body.translation();
        const r = t.body.rotation();
        t.prevPos.set(p.x, p.y, p.z);
        t.prevRot.set(r.x, r.y, r.z, r.w);
      }
      onFixedStep?.(this.step);
      this.world.step(this.eventQueue);
      this.accumulator -= this.step;
      steps++;
    }
    if (steps === 5) this.accumulator = 0; // spiral-of-death guard: drop time instead of stalling

    const alpha = this.accumulator / this.step;
    for (const t of this.tracked) {
      const p = t.body.translation();
      const r = t.body.rotation();
      _v.set(p.x, p.y, p.z);
      t.object.position.lerpVectors(t.prevPos, _v, alpha);
      if (t.syncRotation) {
        _q.set(r.x, r.y, r.z, r.w);
        t.object.quaternion.slerpQuaternions(t.prevRot, _q, alpha);
      }
    }
  }

  /** Static collision from a mesh's world-space triangles (level geometry). */
  addStaticTrimesh(mesh: THREE.Mesh): RAPIER.Collider {
    const geom = mesh.geometry.index ? mesh.geometry : mergeVertices(mesh.geometry);
    const pos = geom.attributes.position;
    const vertices = new Float32Array(pos.count * 3);
    mesh.updateWorldMatrix(true, false);
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      vertices[i * 3] = _v.x;
      vertices[i * 3 + 1] = _v.y;
      vertices[i * 3 + 2] = _v.z;
    }
    const indices = new Uint32Array(geom.index!.array);
    // FIX_INTERNAL_EDGES prevents capsules from snagging on triangle seams of flat floors.
    const desc = RAPIER.ColliderDesc.trimesh(vertices, indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES);
    return this.world.createCollider(desc);
  }

  /**
   * Walk a loaded glTF: meshes named `col_*` become invisible colliders, everything else becomes
   * a collider too unless `collisionOnlyNamed` is true. Returns the created colliders.
   */
  addStaticFromObject(root: THREE.Object3D, collisionOnlyNamed = false): RAPIER.Collider[] {
    const colliders: RAPIER.Collider[] = [];
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const isCol = mesh.name.startsWith('col_');
      if (isCol) mesh.visible = false;
      if (isCol || !collisionOnlyNamed) colliders.push(this.addStaticTrimesh(mesh));
    });
    return colliders;
  }

  dispose() {
    this.tracked.length = 0;
    this.eventQueue.free();
    this.world.free();
  }
}

export { RAPIER };
