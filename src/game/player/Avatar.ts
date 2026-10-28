// STUB — owned by the player/models agent.
import * as THREE from 'three/webgpu';
import type { AvatarApi, Ctx } from '../context';
export class Avatar implements AvatarApi {
  readonly root = new THREE.Object3D();
  constructor(readonly ctx: Ctx, readonly characterId: string) {}
  play(_anim: string, _fade?: number) {}
  attach(_obj: THREE.Object3D | null, _where?: 'hand' | 'back') {}
  update(_dt: number) {}
  dispose() {}
}
