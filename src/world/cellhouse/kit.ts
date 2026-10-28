// Shared build context passed to every cellhouse builder, plus small layout helpers.
import * as THREE from 'three/webgpu';
import type { Ctx } from '../../game/context';
import type { MeshBatch } from './batch';
import type { Colliders } from './colliders';
import type { CellMaterials } from './materials';

export interface Kit {
  ctx: Ctx;
  batch: MeshBatch;
  cols: Colliders;
  mats: CellMaterials;
  /** parent of every cellhouse object */
  root: THREE.Group;
}

/** Places a static model clone (real size, pivot bottom centre) and returns it. */
export function placeModel(kit: Kit, id: string, x: number, y: number, z: number, ry = 0, scale = 1) {
  const o = kit.ctx.models.instance(id);
  o.position.set(x, y, z);
  o.rotation.y = ry;
  if (scale !== 1) o.scale.setScalar(scale);
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh) { m.castShadow = false; m.receiveShadow = true; }
  });
  kit.root.add(o);
  return o;
}

/** Real model size from the manifest, with a fallback. */
export function modelSize(kit: Kit, id: string, fallback: [number, number, number]): [number, number, number] {
  return kit.ctx.models.size(id) ?? fallback;
}

/** Lets the browser breathe between heavy build phases (keeps the loading bar animating). */
export function yieldFrame() {
  return new Promise<void>((r) => setTimeout(r, 0));
}
