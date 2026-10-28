// STUB — owned by the player/models agent.
import * as THREE from 'three/webgpu';
import type { Ctx, PlayerApi } from '../context';
import type { ClimbDef, TraverseDef } from '../../world/layout';
import type { CharacterId, PlayerNet, PrisonerAnim, V3 } from '../types';
import { Avatar } from './Avatar';
import type { CameraRig } from './CameraRig';
export class LocalPlayer implements PlayerApi {
  readonly position = new THREE.Vector3();
  ry = 0;
  crouching = false;
  mode: PlayerApi['mode'] = 'walk';
  readonly avatar: Avatar;
  readonly moveInput = { x: 0, z: 0 };
  constructor(readonly ctx: Ctx, characterId: CharacterId, readonly rig: CameraRig, spawn: V3, ry: number) {
    this.avatar = new Avatar(ctx, characterId);
    this.position.set(...spawn);
    this.ry = ry;
  }
  /** per frame, before physics: read input */
  preUpdate(_dt: number) {}
  /** per fixed physics step: character controller */
  fixedUpdate(_step: number) {}
  /** per frame, after physics: animation, zone, noise */
  update(_dt: number) {}
  teleport(p: V3, ry?: number) { this.position.set(...p); if (ry !== undefined) this.ry = ry; }
  startClimb(_c: ClimbDef, _fromTop: boolean) {}
  async startTraverse(_t: TraverseDef, _fromA: boolean) {}
  setWorking(_on: boolean, _anim?: PrisonerAnim) {}
  addNoise(_n: number) {}
  setSeated(_on: boolean, _anchor?: THREE.Object3D) {}
  setFrozen(_on: boolean) {}
  snapshot(): PlayerNet {
    return { p: [this.position.x, this.position.y, this.position.z], ry: this.ry, a: 'idle', n: 0, cr: 0, z: 'cell', h: '', m: 0 };
  }
}
