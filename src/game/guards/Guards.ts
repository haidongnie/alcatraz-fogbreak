// STUB — owned by the guards agent.
import type * as THREE from 'three/webgpu';
import type { Ctx } from '../context';
import type { GuardNet, V3 } from '../types';
export interface GuardHooks {
  /** host only: a guard reached a player */
  onCatch(pid: string, guardIndex: number): void;
  /** host only: a player was spotted by a searchlight / gun-gallery officer (raises the alarm) */
  onSpotted(kind: 'searchlight' | 'guard', pid: string): void;
}
export class Guards {
  constructor(readonly ctx: Ctx, readonly hooks: GuardHooks) {}
  /** host: simulate AI; everyone: render from host state / ctx.actors() */
  update(_dt: number) {}
  /** host: current guard states for publishing */
  snapshot(): GuardNet[] { return []; }
  /** host: a noise was made at p with radius r */
  hearNoise(_p: V3, _r: number) {}
  /** 0..1 how lit a point is by guard flashlights */
  exposure(_p: THREE.Vector3) { return 0; }
}
