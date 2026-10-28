// Session: owns the shared clock and the authoritative world on the host, mirrors it on clients.
//
// Host (net.isHost()):
//   - creates the WorldState, applies client actions through rules.hostApply, ticks rules.hostTick
//   - publishes 'w' whenever it changed and 'g' (guards/boat/raft) at TUNING.net.actorsHz
// Clients:
//   - read 'w' / 'g' from Playroom room state; re-emit world changes on the bus
// Host migration: whoever becomes host continues from the last 'w' / 'g' it saw (clock included).
import { TUNING } from '../config';
import type { Bus, Ctx } from './context';
import type { Net } from './net';
import { createWorld, hostApply, hostCatch, hostTick, raiseAlarm, type HostIO } from './rules';
import type { Action, ActorsNet, GuardNet, WorldState } from './types';

export interface SessionHooks {
  /** host-side guard snapshot for publishing */
  guards(): GuardNet[];
  /** host-side patrol boat pose */
  boat(): [number, number, number];
  /** host-side raft update: mutates the world (launch etc.), returns true if it changed it */
  raftHost(dt: number, w: WorldState): boolean;
  /** live raft pose once launched: x, z, yaw, distance */
  raftPose(): [number, number, number, number] | undefined;
  /** a client reported a loud noise: forward to the host's guards */
  hearNoise(p: [number, number, number], r: number): void;
}

export class Session {
  private clock = 0;
  private world: WorldState | null = null;
  private actors: ActorsNet | null = null;
  private dirty = false;
  private lastSeenVersion = -1;
  private actorsAccum = 0;
  private wasHost = false;
  private hooks: SessionHooks | null = null;
  private readonly io: HostIO;

  constructor(private readonly net: Net, private readonly bus: Bus) {
    this.io = {
      fx: (f) => this.net.fx(f),
      playerState: (pid) => this.net.getPlayerState(pid),
      connected: () => this.net.players().map((p) => p.id),
    };
    net.onAction((a, from) => this.onAction(a, from));
    net.onFx((f) => bus.emit('fx', f));
  }

  /** Systems that the host simulates (guards, boat, raft). Set once they exist. */
  setHooks(h: SessionHooks) { this.hooks = h; }

  time() { return this.clock; }
  getWorld() { return this.world; }
  getActors() { return this.actors; }
  isHost() { return this.net.isHost(); }

  /** Host: catch a player (called by the guard AI). */
  catchPlayer(pid: string, guardIndex: number) {
    if (!this.net.isHost() || !this.world) return;
    if (hostCatch(this.world, pid, guardIndex, this.clock, this.io)) this.dirty = true;
  }
  /** Host: a searchlight or guard spotted someone without catching them. */
  spotted() {
    if (!this.net.isHost() || !this.world || this.world.phase !== 'playing') return;
    raiseAlarm(this.world, this.io);
    this.io.fx({ k: 'toast', key: 'toast.spotted' });
    this.dirty = true;
  }
  /** Ask the host to do something (works on host and clients). */
  act(a: Action) { this.net.act(a); }

  private onAction(a: Action, from: string) {
    if (!this.net.isHost()) return;
    if (!this.world) this.world = this.net.getWorld() ?? createWorld();
    if (a.k === 'noise') { this.hooks?.hearNoise(a.p, a.r); return; }
    if (hostApply(this.world, a, from, this.clock, this.io)) this.dirty = true;
  }

  update(dt: number) {
    const host = this.net.isHost();
    if (host && !this.wasHost) this.becomeHost();
    this.wasHost = host;

    if (host) {
      this.clock += dt;
      const w = this.world!;
      if (hostTick(w, this.clock, this.io, this.hooks?.raftPose()?.[3] ?? 0)) this.dirty = true;
      if (this.hooks && w.phase === 'playing' && this.hooks.raftHost(dt, w)) this.dirty = true;
      if (this.dirty) {
        w.v++;
        this.net.setWorld(structuredClone(w)); // never hand Playroom an object we keep mutating
        this.dirty = false;
      }
      this.actorsAccum += dt;
      if (this.actorsAccum >= 1 / TUNING.net.actorsHz && this.hooks) {
        this.actorsAccum = 0;
        this.actors = { t: this.clock, g: this.hooks.guards(), b: this.hooks.boat(), r: this.hooks.raftPose() };
        this.net.setActors(this.actors);
      }
    } else {
      const w = this.net.getWorld();
      if (w) this.world = w;
      const a = this.net.getActors();
      if (a && a !== this.actors) {
        this.actors = a;
        // follow the host clock; snap if far off, otherwise ease toward it
        const target = a.t + 0.05;
        this.clock = Math.abs(target - this.clock) > 1 ? target : this.clock + (target - this.clock) * 0.1;
      }
      this.clock += dt;
    }

    if (this.world && this.world.v !== this.lastSeenVersion) {
      this.lastSeenVersion = this.world.v;
      this.bus.emit('world', this.world);
    }
  }

  private becomeHost() {
    // Resume from the room state if it exists (host migration), else create a fresh world.
    // An action may already have created a world before the first update ran (e.g. Start clicked
    // during a throttled first frame) - keep it rather than resetting to a fresh briefing.
    const existing = this.net.getWorld();
    if (existing) this.world = structuredClone(existing);
    else this.world ??= createWorld();
    const a = this.net.getActors();
    if (a) { this.clock = Math.max(this.clock, a.t); this.actors = a; }
    if (!existing) this.dirty = true;
  }
}

/** Convenience for systems that only need the context: true when this client runs the simulation. */
export function isHostCtx(ctx: Ctx) { return ctx.net.isHost(); }
