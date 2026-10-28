// STUB — owned by the interaction agent.
import type { Ctx } from '../context';
import type { WorldState } from '../types';
export class Raft {
  constructor(readonly ctx: Ctx) {}
  /** host: launch + integrate the raft from aboard players' paddling; true if `w` changed */
  hostUpdate(_dt: number, _w: WorldState): boolean { return false; }
  /** live pose once launched: x, z, yaw, distance from launch (host: simulated; clients: from actors) */
  pose(): [number, number, number, number] | undefined { return undefined; }
  /** visuals for everyone; seats the local player when aboard */
  update(_dt: number) {}
}
