// Game rules: the single source of truth for objectives and interactions.
// - Clients call `availableInteractions()` to know what they can do and where (prompts, hold times).
// - The host validates every request in `hostApply()` and advances the night in `hostTick()`.
// Pure functions over WorldState; side effects go through the `HostIO` callbacks.
//
// Flag keys in WorldState.flags:
//   dummy:<slot>   dummy head placed in that cell's bunk
//   vent:<slot>    vent grille of that cell pried off (crawl through is then possible)
//   utility_door   west door of B's utility corridor unlocked (door open, collider removed)
//   workshop       someone reached the workshop on top of B-Block
//   drill_ready    the drill has been brought into the workshop
//   roof_vent      ventilator bars drilled out (roof hatch usable)
//   bundles        number of raft-gear bundles in play (1-3, scales with team size)
//   countOpen      1 while a count is in progress
import { TUNING } from '../config';
import {
  HOLE_CELLS, ITEM_SPAWNS, LAUNCH, PLAYER_CELLS, ROOF_VENT, UTILITY_DOOR, WORKSHOP, zoneAt,
} from '../world/layout';
import {
  BUNDLE_IDS, ITEM_IDS, type Action, type ChapterId, type Fx, type ItemId, type PlayerNet, type V3, type WorldState,
} from './types';

export const NOT_IN_PLAY = '-';

// ------------------------------------------------------------------------------------------------
// World creation
// ------------------------------------------------------------------------------------------------
export function createWorld(): WorldState {
  const items = {} as WorldState['items'];
  for (const id of ITEM_IDS) items[id] = { by: '', p: [...ITEM_SPAWNS[id]] as V3 };
  return {
    v: 1,
    phase: 'briefing',
    chapter: 'lights_out',
    startT: 0,
    players: {},
    flags: {},
    items,
    alarm: 0,
    nextCount: 0,
    raft: { inflate: 0, launched: 0, p: [...LAUNCH.raftSpawn] as V3, ry: LAUNCH.raftRy, dist: 0 },
    stats: { caught: 0, counts: 0, alarmsRaised: 0 },
  };
}

/** Gives a joining player the lowest free slot. Returns false when all 4 slots are taken. */
export function addPlayer(w: WorldState, pid: string): boolean {
  if (w.players[pid]) return true;
  const used = new Set(Object.values(w.players).map((p) => p.slot));
  for (let slot = 0; slot < 4; slot++) {
    if (!used.has(slot)) {
      w.players[pid] = { s: 'free', slot, caught: 0 };
      return true;
    }
  }
  return false;
}

/** Briefing -> night. `connected` = ids currently in the room. */
export function startNight(w: WorldState, connected: string[], t: number) {
  for (const pid of connected) addPlayer(w, pid);
  const n = Math.max(1, Math.min(3, connected.length));
  w.flags = { bundles: n };
  for (const id of ITEM_IDS) w.items[id] = { by: '', p: [...ITEM_SPAWNS[id]] as V3 };
  // Fewer players -> fewer bundles to haul (solo: everything is rolled into the raft bundle).
  for (const id of BUNDLE_IDS.slice(n)) w.items[id] = { by: NOT_IN_PLAY, p: [0, -100, 0] };
  for (const p of Object.values(w.players)) { p.s = 'free'; p.caught = 0; delete p.until; }
  w.phase = 'playing';
  w.chapter = 'lights_out';
  w.startT = t;
  w.alarm = 0;
  w.nextCount = t + TUNING.countInterval;
  w.raft = { inflate: 0, launched: 0, p: [...LAUNCH.raftSpawn] as V3, ry: LAUNCH.raftRy, dist: 0 };
  w.stats = { caught: 0, counts: 0, alarmsRaised: 0 };
  delete w.lostReason;
}

export function activeBundles(w: WorldState): ItemId[] {
  return BUNDLE_IDS.filter((id) => w.items[id].by !== NOT_IN_PLAY);
}
export function slotOf(w: WorldState, pid: string): number {
  return w.players[pid]?.slot ?? -1;
}
export function carriedBy(w: WorldState, pid: string): ItemId | null {
  for (const id of ITEM_IDS) if (w.items[id].by === pid) return id;
  return null;
}
export function isHeavy(item: ItemId) { return item.startsWith('bundle_'); }

function dist2(a: V3, b: V3) { const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2]; return dx * dx + dy * dy + dz * dz; }
function inLaunchZone(p: V3) { return Math.hypot(p[0] - LAUNCH.p[0], p[2] - LAUNCH.p[2]) <= LAUNCH.radius && p[1] < 6; }
function inWorkshop(p: V3) {
  const [x0, z0, x1, z1] = WORKSHOP.box;
  return p[0] >= x0 && p[0] <= x1 && p[2] >= z0 && p[2] <= z1 && Math.abs(p[1] - WORKSHOP.y) < 1.5;
}
export function bundlesAtLaunch(w: WorldState): number {
  return activeBundles(w).filter((id) => w.items[id].by === '' && inLaunchZone(w.items[id].p)).length;
}

// ------------------------------------------------------------------------------------------------
// Interactions
// ------------------------------------------------------------------------------------------------
export interface Interaction {
  id: string;
  /** where the player must stand (within `radius`) */
  p: V3;
  radius: number;
  /** seconds the button must be held (0 = instant) */
  hold: number;
  /** noise while holding (0..1) */
  noise: number;
  /** i18n key of the prompt */
  prompt: string;
  /** `progress` interactions stream partial progress to the host while held (raft inflation) */
  continuous?: boolean;
}

/** Everything `pid` can interact with right now (positions in world space). */
export function availableInteractions(w: WorldState, pid: string): Interaction[] {
  const out: Interaction[] = [];
  if (w.phase !== 'playing') return out;
  const me = w.players[pid];
  if (!me || me.s !== 'free') return out;
  const slot = me.slot;
  const carrying = carriedBy(w, pid);
  const cell = PLAYER_CELLS[slot];
  const f = w.flags;

  if (cell && !f[`dummy:${slot}`]) {
    out.push({ id: `dummy:${slot}`, p: cell.dummy, radius: 1.3, hold: 1.5, noise: 0, prompt: 'prompt.dummy' });
  }
  if (cell && f[`dummy:${slot}`] && !f[`vent:${slot}`]) {
    out.push({ id: `vent:${slot}`, p: cell.vent, radius: 1.2, hold: 5, noise: TUNING.noise.work, prompt: 'prompt.vent' });
  }
  if (!f.utility_door) {
    out.push({ id: 'utility_door', p: UTILITY_DOOR.inside, radius: 1.3, hold: 4, noise: 0.3, prompt: 'prompt.lockpick' });
  }
  if (!f.roof_vent && carrying === 'drill') {
    out.push({ id: 'roof_vent', p: ROOF_VENT.below, radius: 1.6, hold: 8, noise: TUNING.noise.work, prompt: 'prompt.drill' });
  }
  if (carrying === 'keys') {
    for (const [opid, st] of Object.entries(w.players)) {
      if (st.s === 'hole' && opid !== pid) {
        const hc = HOLE_CELLS[st.slot];
        out.push({ id: `free:${st.slot}`, p: hc.door, radius: 1.4, hold: 2, noise: 0.2, prompt: 'prompt.free' });
      }
    }
  }
  if (!carrying) {
    for (const id of ITEM_IDS) {
      const it = w.items[id];
      if (it.by !== '') continue;
      out.push({ id: `pickup:${id}`, p: it.p, radius: 1.4, hold: isHeavy(id) ? 1.0 : 0.5, noise: 0.05, prompt: `prompt.pickup.${id}` });
    }
  }
  if (w.raft.inflate < 1 && bundlesAtLaunch(w) === activeBundles(w).length && activeBundles(w).length > 0) {
    out.push({ id: 'inflate', p: LAUNCH.p, radius: LAUNCH.radius, hold: 0, noise: 0.35, prompt: 'prompt.inflate', continuous: true });
  }
  if (w.raft.inflate >= 1 && !w.raft.launched) {
    out.push({ id: 'board', p: w.raft.p, radius: 3.2, hold: 0.6, noise: 0.1, prompt: 'prompt.board' });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Host side
// ------------------------------------------------------------------------------------------------
export interface HostIO {
  fx(f: Fx): void;
  /** last known player states (for validation and zone checks) */
  playerState(pid: string): PlayerNet | null;
  /** currently connected player ids */
  connected(): string[];
}

/** Applies a client request. Returns true when the world changed (caller publishes it). */
export function hostApply(w: WorldState, a: Action, pid: string, t: number, io: HostIO): boolean {
  if (a.k === 'restart') {
    const fresh = createWorld();
    fresh.players = w.players;
    Object.assign(w, fresh, { v: w.v + 1 });
    return true;
  }
  if (a.k === 'start') {
    if (w.phase !== 'briefing') return false;
    startNight(w, io.connected(), t);
    io.fx({ k: 'chapter', chapter: 'lights_out' });
    return true;
  }
  if (w.phase !== 'playing') return false;
  const me = w.players[pid];
  if (!me) return false;
  const ps = io.playerState(pid);
  const near = (p: V3, r: number) => !ps || dist2(ps.p, p) <= (r + 2.5) * (r + 2.5); // latency slack

  switch (a.k) {
    case 'interact': {
      if (me.s !== 'free') return false;
      const it = availableInteractions(w, pid).find((i) => i.id === a.id);
      if (!it || !near(it.p, it.radius)) return false;
      return applyInteraction(w, it, pid, t, io);
    }
    case 'progress': {
      if (a.id !== 'inflate' || me.s !== 'free') return false;
      const it = availableInteractions(w, pid).find((i) => i.id === 'inflate');
      if (!it || !near(it.p, it.radius)) return false;
      const before = w.raft.inflate;
      // each player inflates at 1/20 per second; amounts are clamped so a client cannot cheat
      w.raft.inflate = Math.min(1, w.raft.inflate + Math.max(0, Math.min(a.amount, 0.6)) / 20);
      if (w.raft.inflate > 0.999) w.raft.inflate = 1; // float drift from many small steps
      if (before < 1 && w.raft.inflate >= 1) {
        io.fx({ k: 'toast', key: 'toast.inflated' });
        io.fx({ k: 'sfx', id: 'inflate', p: LAUNCH.p });
      }
      return true;
    }
    case 'pickup': {
      const it = w.items[a.item];
      if (me.s !== 'free' || it.by !== '' || carriedBy(w, pid) || !near(it.p, 1.4)) return false;
      it.by = pid;
      io.fx({ k: 'sfx', id: 'pickup', p: it.p });
      return true;
    }
    case 'drop':
    case 'throw': {
      const it = w.items[a.item];
      if (it.by !== pid) return false;
      it.by = '';
      it.p = [...a.p] as V3;
      if (a.item === 'drill' && inWorkshop(it.p)) w.flags.drill_ready = 1;
      io.fx({ k: 'sfx', id: 'drop', p: it.p });
      return true;
    }
    case 'board': {
      if (me.s !== 'free' || w.raft.inflate < 1 || w.raft.launched || !near(w.raft.p, 3.2)) return false;
      me.s = 'aboard';
      const c = carriedBy(w, pid);
      if (c) { w.items[c].by = ''; w.items[c].p = [...w.raft.p] as V3; }
      return true;
    }
    case 'noise':
      return false; // consumed by the guard system directly (see GuardSystem.hearNoise)
  }
  return false;
}

function applyInteraction(w: WorldState, it: Interaction, pid: string, t: number, io: HostIO): boolean {
  const [kind, arg] = it.id.split(':');
  switch (kind) {
    case 'dummy':
      w.flags[it.id] = 1;
      io.fx({ k: 'toast', key: 'toast.dummy' });
      return true;
    case 'vent':
      w.flags[it.id] = 1;
      io.fx({ k: 'sfx', id: 'grille', p: it.p });
      io.fx({ k: 'toast', key: 'toast.vent' });
      return true;
    case 'utility_door':
      w.flags.utility_door = 1;
      io.fx({ k: 'sfx', id: 'door', p: it.p });
      io.fx({ k: 'toast', key: 'toast.door' });
      return true;
    case 'roof_vent': {
      w.flags.roof_vent = 1;
      const d = w.items.drill;
      d.by = '';
      d.p = [ROOF_VENT.below[0] + 0.8, ROOF_VENT.below[1], ROOF_VENT.below[2] - 0.6];
      io.fx({ k: 'sfx', id: 'clang', p: ROOF_VENT.roof });
      io.fx({ k: 'toast', key: 'toast.roofvent' });
      return true;
    }
    case 'free': {
      const slot = Number(arg);
      const target = Object.entries(w.players).find(([, s]) => s.slot === slot && s.s === 'hole');
      if (!target) return false;
      target[1].s = 'free';
      delete target[1].until;
      io.fx({ k: 'freed', pid: target[0], by: pid });
      io.fx({ k: 'sfx', id: 'cell_door', p: it.p });
      return true;
    }
    case 'pickup': {
      const item = arg as ItemId;
      const st = w.items[item];
      if (st.by !== '' || carriedBy(w, pid)) return false;
      st.by = pid;
      io.fx({ k: 'sfx', id: 'pickup', p: st.p });
      return true;
    }
    case 'board':
      return hostApply(w, { k: 'board' }, pid, t, io);
  }
  return false;
}

/** Guard contact: send the player to the hole, drop what they carry, raise the alarm. */
export function hostCatch(w: WorldState, pid: string, guardIndex: number, t: number, io: HostIO): boolean {
  const st = w.players[pid];
  if (!st || st.s !== 'free' || w.phase !== 'playing') return false;
  const ps = io.playerState(pid);
  const c = carriedBy(w, pid);
  if (c) {
    w.items[c].by = '';
    w.items[c].p = ps ? [...ps.p] as V3 : [...ITEM_SPAWNS[c]] as V3;
    if (c === 'drill' && !w.flags.roof_vent) w.items.drill.p = [...ITEM_SPAWNS.drill] as V3; // confiscated back to the cart
  }
  st.s = 'hole';
  st.caught++;
  st.until = t + TUNING.holeSeconds;
  w.stats.caught++;
  io.fx({ k: 'caught', pid, by: guardIndex });
  raiseAlarm(w, io);
  return true;
}

export function raiseAlarm(w: WorldState, io: HostIO) {
  w.alarm = Math.min(3, w.alarm + 1);
  w.stats.alarmsRaised++;
  io.fx({ k: 'alarm', level: w.alarm });
  io.fx({ k: 'sfx', id: 'alarm_bell' });
}

/**
 * Advances timers and chapters. Call every host frame; returns true when the world changed.
 * `raftDist` is the live raft distance from the launch point (host raft simulation).
 */
export function hostTick(w: WorldState, t: number, io: HostIO, raftDist: number): boolean {
  if (w.phase !== 'playing') return false;
  let changed = false;
  const connected = io.connected().filter((pid) => w.players[pid]);

  // late joiners get a slot
  for (const pid of io.connected()) if (!w.players[pid] && addPlayer(w, pid)) changed = true;

  // zone-driven flags
  for (const pid of connected) {
    const ps = io.playerState(pid);
    if (!ps || w.players[pid].s !== 'free') continue;
    const z = zoneAt(ps.p[0], ps.p[1], ps.p[2]);
    if (z === 'workshop' && !w.flags.workshop) { w.flags.workshop = 1; changed = true; }
  }
  if (!w.flags.drill_ready) {
    const d = w.items.drill;
    const holderPos = d.by ? io.playerState(d.by)?.p : d.p;
    if (holderPos && d.by !== NOT_IN_PLAY && inWorkshop(holderPos)) { w.flags.drill_ready = 1; changed = true; }
  }

  // hole auto-release
  for (const [pid, st] of Object.entries(w.players)) {
    if (st.s === 'hole' && st.until !== undefined && t >= st.until) {
      st.s = 'free';
      delete st.until;
      io.fx({ k: 'freed', pid, by: '' });
      changed = true;
    }
  }

  // counts: an officer walks the flats; anyone out of their cell without a dummy raises the alarm
  if (t >= w.nextCount && !w.flags.countOpen) {
    w.flags.countOpen = 1;
    w.stats.counts++;
    io.fx({ k: 'count', phase: 'start' });
    io.fx({ k: 'sfx', id: 'count_bell' });
    changed = true;
  }
  if (w.flags.countOpen && t >= w.nextCount + 25) {
    w.flags.countOpen = 0;
    w.nextCount = t + TUNING.countInterval;
    io.fx({ k: 'count', phase: 'end' });
    for (const pid of connected) {
      const st = w.players[pid];
      const ps = io.playerState(pid);
      if (st.s !== 'free' || !ps) continue;
      const inCell = zoneAt(ps.p[0], ps.p[1], ps.p[2]) === 'cell';
      if (!inCell && !w.flags[`dummy:${st.slot}`]) { raiseAlarm(w, io); io.fx({ k: 'toast', key: 'toast.countMissed' }); }
    }
    changed = true;
  }

  // chapter progression (monotonic)
  const next = computeChapter(w, connected, io);
  if (next !== w.chapter) {
    w.chapter = next;
    io.fx({ k: 'chapter', chapter: next });
    changed = true;
  }

  // raft progress / win
  if (w.raft.launched) {
    if (Math.abs(raftDist - w.raft.dist) > 5) { w.raft.dist = raftDist; changed = true; }
    if (raftDist >= TUNING.fogBankDistance) {
      w.phase = 'won';
      w.stats.endT = t;
      for (const st of Object.values(w.players)) st.s = st.s === 'aboard' ? 'escaped' : 'left_behind';
      io.fx({ k: 'won' });
      return true;
    }
  }

  // lose conditions
  if (w.alarm >= 3) return lose(w, t, 'lost.lockdown', io);
  const active = connected.map((pid) => w.players[pid]);
  if (active.length > 0 && active.every((s) => s.s === 'hole')) return lose(w, t, 'lost.allCaught', io);
  return changed;
}

function lose(w: WorldState, t: number, reason: string, io: HostIO) {
  w.phase = 'lost';
  w.lostReason = reason;
  w.stats.endT = t;
  io.fx({ k: 'lost', reason });
  return true;
}

const ORDER: ChapterId[] = ['lights_out', 'utility', 'drill', 'roof', 'descent', 'bay'];
function computeChapter(w: WorldState, connected: string[], io: HostIO): ChapterId {
  let c: ChapterId = 'lights_out';
  const anyIn = (zone: string) => connected.some((pid) => {
    const ps = io.playerState(pid);
    return ps && zoneAt(ps.p[0], ps.p[1], ps.p[2]) === zone;
  });
  if (Object.keys(w.flags).some((k) => k.startsWith('vent:')) && anyIn('utility')) c = 'utility';
  if (w.flags.workshop) c = 'drill';
  if (w.flags.drill_ready) c = 'roof';
  if (w.flags.roof_vent) c = 'descent';
  if (w.raft.inflate >= 1) c = 'bay';
  // never go backwards
  return ORDER.indexOf(c) > ORDER.indexOf(w.chapter) ? c : w.chapter;
}

/** Objective lines for the HUD: [i18n key, done, optional "n/m" progress]. */
export function objectives(w: WorldState, myId: string): { key: string; done: boolean; progress?: string }[] {
  const me = w.players[myId];
  const slot = me?.slot ?? 0;
  const f = w.flags;
  const ventCount = Object.values(w.players).filter((p) => f[`vent:${p.slot}`]).length;
  const total = Object.keys(w.players).length;
  switch (w.chapter) {
    case 'lights_out':
      return [
        { key: 'obj.dummy', done: !!f[`dummy:${slot}`] },
        { key: 'obj.vent', done: !!f[`vent:${slot}`], progress: `${ventCount}/${total}` },
        { key: 'obj.crawl', done: false },
      ];
    case 'utility':
      return [{ key: 'obj.climb', done: !!f.workshop }];
    case 'drill':
      return [
        { key: 'obj.door', done: !!f.utility_door },
        { key: 'obj.getDrill', done: w.items.drill.by !== '' || dist2(w.items.drill.p, ITEM_SPAWNS.drill) > 4 },
        { key: 'obj.bringDrill', done: !!f.drill_ready },
        { key: 'obj.keysOptional', done: w.items.keys.by !== '' },
      ];
    case 'roof':
      return [{ key: 'obj.drillVent', done: !!f.roof_vent }];
    case 'descent':
      return [
        { key: 'obj.carry', done: bundlesAtLaunch(w) === activeBundles(w).length, progress: `${bundlesAtLaunch(w)}/${activeBundles(w).length}` },
        { key: 'obj.pipe', done: false },
        { key: 'obj.inflate', done: w.raft.inflate >= 1, progress: `${Math.round(w.raft.inflate * 100)}%` },
      ];
    case 'bay':
      return [
        { key: 'obj.board', done: me?.s === 'aboard' },
        { key: 'obj.paddle', done: false, progress: `${Math.round(w.raft.dist)}/${TUNING.fogBankDistance} m` },
      ];
  }
}

/** Reference positions used by the UI for objective markers (where to go next). */
export function objectiveTarget(w: WorldState, myId: string): V3 | null {
  const slot = w.players[myId]?.slot ?? 0;
  const f = w.flags;
  switch (w.chapter) {
    case 'lights_out':
      return !f[`dummy:${slot}`] ? PLAYER_CELLS[slot].dummy : PLAYER_CELLS[slot].vent;
    case 'utility':
      return [-14.2, 41.0, -5.55];
    case 'drill':
      if (!f.utility_door) return UTILITY_DOOR.inside;
      return w.items.drill.by === '' ? w.items.drill.p : [-14.2, WORKSHOP.y, -4.0];
    case 'roof':
      return ROOF_VENT.below;
    case 'descent':
      return LAUNCH.p;
    case 'bay':
      return w.raft.p;
  }
  return null;
}
