// The cellhouse complex, inside and out: the Main Prison (A/B/C/D blocks with three tiers, B's
// utility corridor, the four player cells, the hole, the workshop on top of B, Times Square, the
// gun galleries, the library and the east end), the Dining Hall / kitchen wing with the bakery
// pipe, and the Administration wing; walkable roofs. Static geometry is merged per material
// (src/world/cellhouse/batch.ts), repeated parts are instanced, colliders are Rapier cuboids.
// World flags (vent:*, dummy:*, utility_door, roof_vent) drive the few things that change.
import * as THREE from 'three/webgpu';
import type { Ctx } from '../game/context';
import type { WorldState } from '../game/types';
import { PLAYER_CELLS } from './layout';
import { MeshBatch } from './cellhouse/batch';
import { Colliders } from './cellhouse/colliders';
import { CellMaterials } from './cellhouse/materials';
import { buildShell } from './cellhouse/shell';
import { buildBlocks } from './cellhouse/blocks';
import { UtilityCorridor } from './cellhouse/utility';
import { Furniture } from './cellhouse/furniture';
import { PLATE_LABELS, PlayerCellsView } from './cellhouse/playerCells';
import { Workshop } from './cellhouse/workshop';
import { buildRooms } from './cellhouse/rooms';
import { yieldFrame, type Kit } from './cellhouse/kit';

const done = (f: Record<string, number>, key: string) => (f[key] ?? 0) >= 1;

export class Cellhouse {
  readonly root = new THREE.Group();
  private utility: UtilityCorridor | null = null;
  private workshop: Workshop | null = null;
  private cells: PlayerCellsView | null = null;
  private furniture: Furniture | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(readonly ctx: Ctx) {}

  async build() {
    const ctx = this.ctx;
    this.root.name = 'cellhouse';
    ctx.scene.add(this.root);
    const kit: Kit = {
      ctx,
      batch: new MeshBatch(),
      cols: new Colliders(ctx.physics.world),
      mats: new CellMaterials(PLATE_LABELS),
      root: this.root,
    };
    await yieldFrame();
    buildShell(kit);
    await yieldFrame();
    const blocks = buildBlocks(kit);
    await yieldFrame();
    this.utility = new UtilityCorridor(kit);
    this.utility.build();
    this.cells = new PlayerCellsView(kit);
    this.cells.build();
    this.workshop = new Workshop(kit);
    this.workshop.build();
    this.furniture = new Furniture(kit, blocks.slots);
    buildRooms(kit, blocks.nightLights);
    await yieldFrame();
    const vertices = kit.batch.vertices;
    const merged = kit.batch.flush(this.root);
    this.root.updateMatrixWorld(true);

    this.unsubscribe = ctx.bus.on('world', (w) => this.applyFlags(w));
    const w = ctx.world();
    if (w) this.applyFlags(w);
    let objects = 0;
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) objects++; });
    console.info(`[cellhouse] ${objects} meshes (${merged.length} merged, ${(vertices / 1000).toFixed(0)}k verts), ${kit.cols.count} colliders`);
  }

  /** Flag-driven state; idempotent and reversible (a restart clears the flags). */
  private applyFlags(w: WorldState) {
    const f = w.flags;
    if (this.cells) {
      let dirty = false;
      for (const c of PLAYER_CELLS) {
        if (this.cells.setVent(c.slot, done(f, `vent:${c.slot}`))) dirty = true;
        if (this.cells.setDummy(c.slot, done(f, `dummy:${c.slot}`))) dirty = true;
      }
      if (dirty) this.cells.commit();
    }
    this.utility?.setOpen(done(f, 'utility_door'));
    this.workshop?.setRoofVent(done(f, 'roof_vent'));
  }

  update(dt: number) {
    this.utility?.update(dt);
    this.workshop?.update(dt);
    this.furniture?.update(dt);
  }

  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.ctx.scene.remove(this.root);
  }
}
