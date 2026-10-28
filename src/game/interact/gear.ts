// Small derived queries about the raft gear shared by Interaction, Items and Raft.
import { activeBundles, bundlesAtLaunch } from '../rules';
import type { WorldState } from '../types';

/**
 * True once every raft-gear bundle in play lies at the launch site. From then on the raft is
 * unpacked there (deflated raft visible, inflate available) and the bundles stay put: the client
 * no longer offers to pick them up again, so nobody breaks the inflation by accident.
 */
export function gearAtLaunch(w: WorldState): boolean {
  const n = activeBundles(w).length;
  return n > 0 && bundlesAtLaunch(w) === n;
}

/**
 * Caches a value derived from the world state until the world changes (new object or version).
 * Rule helpers allocate arrays, so per-frame callers go through this.
 */
export class WorldCache<T> {
  private w: WorldState | null = null;
  private v = -1;
  private value: T;
  constructor(private readonly compute: (w: WorldState) => T, initial: T) { this.value = initial; }
  get(w: WorldState): T {
    if (w !== this.w || w.v !== this.v) {
      this.w = w;
      this.v = w.v;
      this.value = this.compute(w);
    }
    return this.value;
  }
}
