// STUB — owned by the world/exterior agent.
import type { Ctx } from '../game/context';
import type { Island } from './island';
export class Exterior {
  constructor(readonly ctx: Ctx, readonly island: Island) {}
  async build() {}
  update(_dt: number) {}
}
