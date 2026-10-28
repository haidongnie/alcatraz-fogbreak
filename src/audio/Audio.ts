// STUB — owned by the UI/audio agent.
import type { Ctx } from '../game/context';
export class Audio {
  constructor(readonly ctx: Ctx) {}
  /** Resume the AudioContext (called right after a user gesture). */
  unlock() {}
  update(_dt: number) {}
}
