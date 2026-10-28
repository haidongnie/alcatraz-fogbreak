// Static Rapier colliders for the cellhouse: cuboids only (walls, slabs, block masses, railings,
// ramps for stairs). Everything uses WORLD_GROUPS except removable blockers (utility door, roof
// ventilator cap), which also carry GROUP.DOOR and are toggled with setEnabled().
import * as THREE from 'three/webgpu';
import { RAPIER } from '../../core/physics';
import { GROUP, WORLD_GROUPS, groups } from '../../game/context';
import { orientAlong, type XYZ } from './batch';

/** Removable blockers: collide like the world, but are tagged DOOR for queries that care. */
export const DOOR_GROUPS = groups(GROUP.WORLD | GROUP.DOOR, 0xffff);

const _q = new THREE.Quaternion();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Vector3();

export class Colliders {
  count = 0;
  constructor(private readonly world: RAPIER.World) {}

  /** Cuboid from centre and half extents, optional yaw. */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, rotY = 0, grp = WORLD_GROUPS): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(Math.max(hx, 0.005), Math.max(hy, 0.005), Math.max(hz, 0.005))
      .setTranslation(cx, cy, cz)
      .setCollisionGroups(grp)
      .setFriction(0.7);
    if (rotY !== 0) {
      _q.setFromAxisAngle(_n.set(0, 1, 0), rotY);
      desc.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
    }
    this.count++;
    return this.world.createCollider(desc);
  }

  /** Axis-aligned cuboid from two corners. */
  mm(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, grp = WORLD_GROUPS) {
    return this.box((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2, 0, grp);
  }

  /** Cuboid with a full orientation. */
  oriented(center: THREE.Vector3, half: THREE.Vector3, q: THREE.Quaternion, grp = WORLD_GROUPS) {
    const desc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setTranslation(center.x, center.y, center.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setCollisionGroups(grp)
      .setFriction(0.7);
    this.count++;
    return this.world.createCollider(desc);
  }

  /**
   * Stair ramp: a slab whose TOP surface runs from walking point `a` to walking point `b`
   * (feet positions), `width` wide. Extended a little at both ends so there is no lip.
   */
  ramp(a: XYZ, b: XYZ, width: number, thickness = 0.25) {
    _d.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = _d.length();
    orientAlong(_q, _d.normalize());
    // slab normal = local +Y after rotation
    _n.set(0, 1, 0).applyQuaternion(_q);
    _c.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2).addScaledVector(_n, -thickness / 2);
    return this.oriented(_c, new THREE.Vector3(len / 2 + 0.08, thickness / 2, width / 2), _q);
  }

  /** Thin vertical wall along a horizontal segment (railings, cage sides). */
  fence(x0: number, z0: number, x1: number, z1: number, yBottom: number, yTop: number, thick = 0.06) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return null;
    const rotY = Math.atan2(-dz, dx);
    return this.box((x0 + x1) / 2, (yBottom + yTop) / 2, (z0 + z1) / 2, len / 2, (yTop - yBottom) / 2, thick / 2, rotY);
  }
}
