// Everything outdoors except the cellhouse complex (Main Prison, Dining Hall, Administration
// Block): OSM buildings in their 1962 state, Meshy landmarks, roads, walls, the recreation yard,
// fences (service yard double fence + perimeter), lamps, trees, rocks, pelicans, dock, pier, signs.
// Builders live in ./exterior/. All static geometry is merged per material or instanced, colliders
// are static cuboids/trimeshes in the WORLD group, and the outdoor guard routes plus the walk from
// FENCE.climbOut to the launch beach are kept clear (see exterior/data.ts CORRIDORS).
import * as THREE from 'three/webgpu';
import type { Ctx } from '../game/context';
import type { Island } from './island';
import { Colliders } from './exterior/builder';
import { Buildings } from './exterior/buildings';
import { Fences } from './exterior/fences';
import { Landmarks } from './exterior/landmarks';
import { materials } from './exterior/materials';
import { Props } from './exterior/props';
import { Roads } from './exterior/roads';
import { Walls } from './exterior/walls';

export class Exterior {
  readonly group = new THREE.Group();
  private landmarks: Landmarks | null = null;

  constructor(readonly ctx: Ctx, readonly island: Island) {
    this.group.name = 'exterior';
  }

  async build() {
    const { ctx, island } = this;
    const col = new Colliders(ctx.physics);
    const yieldFrame = () => new Promise<void>((r) => setTimeout(r, 0));

    const buildings = new Buildings(island, col);
    buildings.build(this.group);
    await yieldFrame();
    this.landmarks = new Landmarks(ctx, island, col, buildings.built);
    this.landmarks.build(this.group);
    new Walls(island, col).build(this.group);
    new Fences(island, col).build(this.group);
    await yieldFrame();
    new Roads(island).build(this.group);
    new Props(ctx, island, col, buildings.built).build(this.group);

    // halos / light pools fade with the fog (read per render: also works on the title screen,
    // where main.ts does not call exterior.update)
    materials().fogDensity.onRenderUpdate(() => (ctx.scene.fog as THREE.FogExp2 | null)?.density ?? 0.004);

    // nothing out here moves (the lighthouse beams turn in their vertex shader)
    this.group.traverse((o) => {
      if (o.matrixAutoUpdate) { o.updateMatrix(); o.matrixAutoUpdate = false; }
    });
    ctx.scene.add(this.group);
  }

  update(dt: number) {
    this.landmarks?.update(dt);
  }
}
