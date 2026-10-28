// Physics queries for guards and searchlights: line-of-sight rays and "can I walk straight there"
// ball sweeps. Everything hits only static world geometry (QUERY_WORLD_ONLY: the player capsule and
// the raft are ignored) and reuses one Ray / Ball, so queries never allocate on the JS side.
import { RAPIER } from '../../core/physics';
import { QUERY_WORLD_ONLY, type Ctx } from '../context';

export class WorldQueries {
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  private readonly ball = new RAPIER.Ball(0.25);
  private readonly shapePos = { x: 0, y: 0, z: 0 };
  private readonly shapeRot = { x: 0, y: 0, z: 0, w: 1 };
  private readonly shapeVel = { x: 0, y: 0, z: 0 };

  constructor(private readonly ctx: Ctx) {}

  /** Distance from o along direction d (any length) to the first world hit, or `max` when clear. */
  rayDistance(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number {
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6 || max <= 0) return max;
    const r = this.ray;
    r.origin.x = ox; r.origin.y = oy; r.origin.z = oz;
    r.dir.x = dx / len; r.dir.y = dy / len; r.dir.z = dz / len;
    const hit = this.ctx.physics.world.castRay(r, max, true, undefined, QUERY_WORLD_ONLY);
    return hit ? hit.timeOfImpact : max;
  }

  /** True when nothing solid lies between a and b. The last `slack` metres before b are ignored. */
  lineClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, slack = 0.25): boolean {
    const d = Math.hypot(bx - ax, by - ay, bz - az);
    const max = d - slack;
    if (max <= 0) return true;
    return this.rayDistance(ax, ay, az, bx - ax, by - ay, bz - az, max) >= max;
  }

  /** True when a ball of radius `r` can move in a straight line from a to b without touching anything. */
  sweepClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r = 0.25): boolean {
    this.ball.radius = r;
    const p = this.shapePos, v = this.shapeVel;
    p.x = ax; p.y = ay; p.z = az;
    v.x = bx - ax; v.y = by - ay; v.z = bz - az;
    if (v.x * v.x + v.y * v.y + v.z * v.z < 1e-6) return true;
    // maxToi 1 with vel = full displacement covers exactly a -> b; starting overlaps that move away are ignored
    const hit = this.ctx.physics.world.castShape(p, this.shapeRot, v, this.ball, 0, 1, false, undefined, QUERY_WORLD_ONLY);
    return hit === null;
  }
}
