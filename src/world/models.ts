// STUB — owned by the player/models agent.
import * as THREE from 'three/webgpu';
import type { Assets } from '../core/assets';
import type { CharacterInstance, ModelsApi } from '../game/context';
export class Models implements ModelsApi {
  static async load(_assets: Assets, _onProgress?: (fraction: number) => void): Promise<Models> { return new Models(); }
  has(_id: string) { return false; }
  size(_id: string): [number, number, number] | null { return null; }
  instance(_id: string): THREE.Object3D { return new THREE.Object3D(); }
  instanced(_id: string, _m: THREE.Matrix4[], _o?: { castShadow?: boolean; receiveShadow?: boolean }): THREE.Object3D { return new THREE.Object3D(); }
  character(_id: string): CharacterInstance {
    const root = new THREE.Object3D();
    return { root, mixer: new THREE.AnimationMixer(root), clips: new Map(), hand: null, back: null, head: null, height: 1.78 };
  }
}
