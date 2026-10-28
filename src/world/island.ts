// STUB — owned by the world/exterior agent.
import type { Ctx, TerrainApi } from '../game/context';
export class Island implements TerrainApi {
  /** Loads public/data/island.json, builds terrain mesh + heightfield collider, sea, shoreline. */
  static async load(ctx: Ctx): Promise<Island> { return new Island(ctx); }
  constructor(readonly ctx: Ctx) {}
  heightAt(_x: number, _z: number) { return 0; }
  groundAt(_x: number, y: number, _z: number) { return y; }
  update(_dt: number) {}
}
