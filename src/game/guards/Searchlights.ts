// Gun-tower searchlights and the patrol boat. Everything is a pure function of the shared clock
// (ctx.time()), so all clients see the same sweeps without networking; the host's exposure() is what
// the guards use to spot players ("in a searchlight" = exposure >= 0.85 outdoors).
// Each tower (layout SEARCHLIGHTS): a `searchlight` model at tower + height turning with the sweep
// (yaw +- amp, sinusoid with `period`, downward `pitch`), a SpotLight, a volumetric shaft clipped by
// the terrain/buildings, and occlusion-aware exposure (physics ray from the lamp: the power house
// shadows the launch site from the Model Roof Tower). At alarm >= 2 the operators sweep faster.
// Lights are created here, once, before the shader warm-up in main.ts.
import * as THREE from 'three/webgpu';
import { zoneAt, SEARCHLIGHTS, type SearchlightDef } from '../../world/layout';
import type { Ctx } from '../context';
import { Beacon } from './Beacon';
import { syncBeamFog } from './beams';
import { PatrolBoat } from './PatrolBoat';
import { WorldQueries } from './queries';

/** Lens centre on the `searchlight` model (pivot bottom centre, lens facing +Z in the file). */
const LENS_UP = 0.72;
const LENS_FWD = 0.66;
/** sweep frequency multiplier once the alarm reaches 2 */
const FAST_SWEEP = 1.7;
/** seconds to blend between the calm and the alarmed sweep */
const SWEEP_BLEND = 3;

interface Tower {
  def: SearchlightDef;
  index: number;
  /** turns with the sweep yaw; holds the model and the beacon pivot */
  holder: THREE.Group;
  beacon: Beacon;
}

const INDOOR_ZONES = new Set(['cell', 'utility', 'workshop', 'floor', 'dblock']);

export class Searchlights {
  private readonly q: WorldQueries;
  private readonly towers: Tower[] = [];
  private readonly boat: PatrolBoat;
  /** 0 = calm sweep, 1 = alarmed sweep (blended so the beams never jump) */
  private fast = 0;
  private fastInit = false;

  constructor(readonly ctx: Ctx) {
    this.q = new WorldQueries(ctx);
    const wisps = ctx.quality.tier === 'high';
    SEARCHLIGHTS.forEach((def, index) => {
      const holder = new THREE.Group();
      holder.name = `searchlight:${def.name}`;
      holder.position.set(def.tower[0], def.tower[1] + def.height, def.tower[2]);
      const model = ctx.models.instance('searchlight');
      model.rotation.y = Math.PI; // lens from +Z (file) to -Z (our forward)
      holder.add(model);
      const beacon = new Beacon({ range: def.range, angle: 0.085, intensity: 2600, color: 0xe6eeff, glareSize: 3.6, wisps });
      beacon.pivot.position.set(0, LENS_UP, -LENS_FWD);
      holder.add(beacon.pivot);
      ctx.scene.add(holder);
      this.towers.push({ def, index, holder, beacon });
    });
    this.boat = new PatrolBoat(ctx, wisps);
    this.update(0); // valid poses (and exposure) before the first frame
  }

  /** sweeps are deterministic from ctx.time(); also moves the patrol boat */
  update(dt: number) {
    syncBeamFog(this.ctx.scene);
    const t = this.ctx.time();
    const w = this.ctx.world();
    const want = w && w.alarm >= 2 ? 1 : 0;
    if (!this.fastInit && w) { this.fast = want; this.fastInit = true; } // late joiners start in step
    this.fast += Math.max(-dt / SWEEP_BLEND, Math.min(dt / SWEEP_BLEND, want - this.fast));

    const cam = this.ctx.camera.position;
    for (const tw of this.towers) {
      const { def, index: i } = tw;
      const phase = (Math.PI * 2 * t) / def.period + i * 1.3;
      const calm = Math.sin(phase);
      const alarmed = Math.sin(phase * FAST_SWEEP);
      // the operator's hand is not a motor: a slow wobble on top of the sweep
      tw.holder.rotation.y = def.yaw + def.amp * (calm + (alarmed - calm) * this.fast) + 0.04 * Math.sin(t * 0.31 + i * 2.1);
      tw.beacon.pivot.rotation.x = -(def.pitch + 0.015 * Math.sin(t * 0.47 + i));
      tw.beacon.refresh(this.q, cam);
    }
    this.boat.update(t, this.q, cam);
    // Unshadowed spots would light the cellhouse interior straight through its walls. Lighting is
    // per client, so while this camera is indoors the towers and the boat only show their beams.
    const indoors = INDOOR_ZONES.has(zoneAt(cam.x, cam.y, cam.z));
    for (const tw of this.towers) tw.beacon.spot.intensity = indoors ? 0 : tw.beacon.o.intensity;
    this.boat.beacon.spot.intensity = indoors ? 0 : this.boat.beacon.o.intensity;
  }

  /** 0..1 how strongly a point is inside a searchlight beam (with occlusion) */
  exposure(p: THREE.Vector3) {
    let best = this.boat.beacon.exposure(p, this.q);
    for (const tw of this.towers) {
      if (best >= 1) break;
      best = Math.max(best, tw.beacon.exposure(p, this.q));
    }
    return best;
  }

  /** patrol boat pose: x, z, yaw (deterministic from ctx.time()) */
  boatPose(): [number, number, number] { return this.boat.pose(this.ctx.time()); }

  dispose() {
    for (const tw of this.towers) {
      this.ctx.scene.remove(tw.holder);
      tw.beacon.dispose();
    }
    this.boat.dispose();
  }
}
