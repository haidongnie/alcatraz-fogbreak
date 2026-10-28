// STUB — owned by the interaction agent.
import type { Ctx, ItemsApi } from '../context';
import type { ItemId, V3 } from '../types';
export class Items implements ItemsApi {
  constructor(readonly ctx: Ctx) {}
  dropPoint(_throwIt: boolean): V3 { return [0, 0, 0]; }
  carried(): ItemId | null { return null; }
  update(_dt: number) {}
}
