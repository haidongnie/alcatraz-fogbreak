// STUB — owned by the guards agent.
import type * as THREE from 'three/webgpu';
import type { Ctx } from '../context';
export class Searchlights {
  constructor(readonly ctx: Ctx) {}
  /** sweeps are deterministic from ctx.time(); also moves the patrol boat */
  update(_dt: number) {}
  /** 0..1 how strongly a point is inside a searchlight beam (with occlusion) */
  exposure(_p: THREE.Vector3) { return 0; }
  /** patrol boat pose: x, z, yaw (deterministic from ctx.time()) */
  boatPose(): [number, number, number] { return [0, 0, 0]; }
}
