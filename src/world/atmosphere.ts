// STUB — owned by the world/exterior agent.
import type * as THREE from 'three/webgpu';
import type { Ctx } from '../game/context';
export class Atmosphere {
  constructor(readonly ctx: Ctx) {}
  /** Night sky, moon light + shadows, fog, environment, light pool, post-processing. */
  async init() {}
  /** 0..1 how lit a point is by lamps (pooled light anchors). */
  lampExposure(_p: THREE.Vector3) { return 0; }
  update(_dt: number) {}
  /** Renders the frame (post-processing pipeline). */
  render() { this.ctx.renderer.render(this.ctx.scene, this.ctx.camera); }
}
