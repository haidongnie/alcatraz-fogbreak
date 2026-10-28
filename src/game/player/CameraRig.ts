// STUB — owned by the player/models agent.
import type { Ctx } from '../context';
export class CameraRig {
  /** camera yaw (0 = looking toward -Z) and pitch, driven by mouse/touch look */
  yaw = 0;
  pitch = -0.15;
  constructor(readonly ctx: Ctx) {}
  update(_dt: number) {}
}
