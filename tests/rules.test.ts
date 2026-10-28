// Headless test of the game rules: plays a full night (2 players) and the failure paths.
// Run: npm run test:rules
import './shim';
import { TUNING } from '../src/config';
import {
  activeBundles, availableInteractions, bundlesAtLaunch, createWorld, hostApply, hostCatch, hostTick, objectives, type HostIO,
} from '../src/game/rules';
import type { Action, Fx, PlayerNet, V3 } from '../src/game/types';
import { ITEM_SPAWNS, LAUNCH, PLAYER_CELLS, ROOF_VENT, UTILITY_DOOR, zoneAt } from '../src/world/layout';

let failures = 0;
function check(cond: unknown, msg: string) {
  if (cond) console.log(`  ok  ${msg}`);
  else { failures++; console.log(`  FAIL ${msg}`); }
}

const states: Record<string, PlayerNet> = {};
const fx: Fx[] = [];
let connected = ['A', 'B'];
const io: HostIO = { fx: (f) => fx.push(f), playerState: (pid) => states[pid] ?? null, connected: () => connected };
const at = (pid: string, p: V3, extra: Partial<PlayerNet> = {}) => {
  states[pid] = { p: [...p] as V3, ry: 0, a: 'idle', n: 0, cr: 0, z: zoneAt(...p), h: '', m: 0, ...extra };
};
let t = 0;
const w = createWorld();
const act = (pid: string, a: Action) => hostApply(w, a, pid, t, io);
const tick = (dt = 0.1, raftDist = 0) => { t += dt; return hostTick(w, t, io, raftDist); };

console.log('briefing -> start');
at('A', PLAYER_CELLS[0].spawn); at('B', PLAYER_CELLS[1].spawn);
check(act('A', { k: 'start' }), 'start accepted');
check(w.phase === 'playing' && w.chapter === 'lights_out', 'playing, lights_out');
check(w.players.A.slot === 0 && w.players.B.slot === 1, 'slots 0/1');
check(activeBundles(w).length === 2 && w.items.bundle_concertina.by === '-', '2 bundles for 2 players');
check(zoneAt(...PLAYER_CELLS[0].spawn) === 'cell', 'spawn is in cell zone');

console.log('lights out');
check(!act('A', { k: 'interact', id: 'vent:0' }), 'vent requires dummy first');
at('A', PLAYER_CELLS[0].dummy);
check(act('A', { k: 'interact', id: 'dummy:0' }) && w.flags['dummy:0'] === 1, 'dummy placed');
check(!act('B', { k: 'interact', id: 'dummy:0' }), 'B cannot use A\'s cell');
at('A', PLAYER_CELLS[0].vent);
check(act('A', { k: 'interact', id: 'vent:0' }) && w.flags['vent:0'] === 1, 'vent opened');
at('B', PLAYER_CELLS[1].dummy); act('B', { k: 'interact', id: 'dummy:1' });
at('B', PLAYER_CELLS[1].vent); act('B', { k: 'interact', id: 'vent:1' });
check(objectives(w, 'A')[1].progress === '2/2', 'vent progress 2/2');

console.log('utility corridor + workshop');
at('A', PLAYER_CELLS[0].ventOut);
check(zoneAt(...PLAYER_CELLS[0].ventOut) === 'utility', 'ventOut is utility zone');
tick();
check(w.chapter === 'utility', 'chapter utility');
at('A', [-14.2, 48.4, -4.0]);
check(zoneAt(-14.2, 48.4, -4.0) === 'workshop', 'climb exit is workshop zone');
tick();
check(w.chapter === 'drill' && w.flags.workshop === 1, 'chapter drill');

console.log('drill detour');
at('B', UTILITY_DOOR.inside);
check(act('B', { k: 'interact', id: 'utility_door' }) && w.flags.utility_door === 1, 'door unlocked');
at('B', ITEM_SPAWNS.drill);
check(availableInteractions(w, 'B').some((i) => i.id === 'pickup:drill'), 'drill pickup offered');
check(act('B', { k: 'interact', id: 'pickup:drill' }) && w.items.drill.by === 'B', 'B carries drill');
check(!availableInteractions(w, 'B').some((i) => i.id.startsWith('pickup:')), 'no second pickup while carrying');
at('B', [-15, 48.4, -3.5]);
tick();
check(w.chapter === 'roof' && w.flags.drill_ready === 1, 'chapter roof once drill reaches workshop');

console.log('roof vent');
at('B', ROOF_VENT.below);
check(act('B', { k: 'interact', id: 'roof_vent' }) && w.flags.roof_vent === 1, 'roof vent drilled');
check(w.items.drill.by === '', 'drill left behind');
tick();
check(w.chapter === 'descent', 'chapter descent');

console.log('bundles to the shore');
at('A', ITEM_SPAWNS.bundle_raft); act('A', { k: 'interact', id: 'pickup:bundle_raft' });
at('B', ITEM_SPAWNS.bundle_paddles); act('B', { k: 'interact', id: 'pickup:bundle_paddles' });
check(w.items.bundle_raft.by === 'A' && w.items.bundle_paddles.by === 'B', 'both carrying');
at('A', LAUNCH.p); act('A', { k: 'drop', item: 'bundle_raft', p: [LAUNCH.p[0] + 1, LAUNCH.p[1], LAUNCH.p[2]] });
at('B', LAUNCH.p); act('B', { k: 'drop', item: 'bundle_paddles', p: [LAUNCH.p[0] - 1, LAUNCH.p[1], LAUNCH.p[2] + 1] });
check(bundlesAtLaunch(w) === 2, 'bundles at launch 2/2');
check(availableInteractions(w, 'A').some((i) => i.id === 'inflate'), 'inflate offered');
for (let i = 0; i < 40 && w.raft.inflate < 1; i++) { act('A', { k: 'progress', id: 'inflate', amount: 0.25 }); act('B', { k: 'progress', id: 'inflate', amount: 0.25 }); }
check(w.raft.inflate >= 1, 'raft inflated');
check(!act('A', { k: 'progress', id: 'inflate', amount: 100 }), 'no inflate after full');
tick();
check(w.chapter === 'bay', 'chapter bay');

console.log('board + win');
at('A', w.raft.p); at('B', w.raft.p);
check(act('A', { k: 'board' }) && w.players.A.s === 'aboard', 'A aboard');
check(act('B', { k: 'interact', id: 'board' }) && w.players.B.s === 'aboard', 'B aboard via interact');
w.raft.launched = 1;
tick(0.1, 100);
check(w.phase === 'playing' && Math.abs(w.raft.dist - 100) < 1, 'raft progress mirrored');
tick(0.1, TUNING.fogBankDistance + 1);
check(w.phase === 'won' && w.players.A.s === 'escaped' && w.players.B.s === 'escaped', 'won, both escaped');

console.log('failure paths');
const w2 = createWorld();
connected = ['A', 'B'];
t = 0;
hostApply(w2, { k: 'start' }, 'A', t, io);
at('A', [0, 41, 0.4]); at('B', PLAYER_CELLS[1].spawn);
w2.items.keys.by = 'A';
check(hostCatch(w2, 'A', 0, t, io) && w2.players.A.s === 'hole' && w2.alarm === 1, 'catch -> hole, alarm 1');
check(w2.items.keys.by === '' && w2.items.keys.p[0] === 0, 'carried keys dropped where caught');
check(!hostCatch(w2, 'A', 0, t, io), 'cannot catch twice');
hostTick(w2, t + TUNING.holeSeconds + 0.1, io, 0);
check(w2.players.A.s === 'free', 'auto release from hole');
hostCatch(w2, 'A', 0, t, io); hostCatch(w2, 'B', 0, t, io);
check(w2.phase === 'playing', 'alarm 3 not yet evaluated until tick');
hostTick(w2, t + 1, io, 0);
check(w2.phase === 'lost', `lost (${w2.lostReason})`);

console.log('count without dummy raises alarm');
const w3 = createWorld();
t = 0;
hostApply(w3, { k: 'start' }, 'A', t, io);
at('A', [0, 41, 0.4]); at('B', PLAYER_CELLS[1].spawn);
hostTick(w3, w3.nextCount + 0.1, io, 0);
check(w3.flags.countOpen === 1, 'count opened');
hostTick(w3, w3.nextCount + 26, io, 0);
check(w3.alarm === 1 && w3.flags.countOpen === 0, 'A out of cell without dummy -> alarm 1');

console.log('solo scaling + late join');
connected = ['S'];
const w4 = createWorld();
hostApply(w4, { k: 'start' }, 'S', 0, io);
check(activeBundles(w4).length === 1, 'solo: 1 bundle');
connected = ['S', 'L'];
at('L', PLAYER_CELLS[1].spawn);
hostTick(w4, 1, io, 0);
check(w4.players.L?.slot === 1 && w4.players.L.s === 'free', 'late joiner gets slot 1');

console.log(failures ? `\n${failures} FAILED` : '\nall rules tests passed');
process.exit(failures ? 1 : 0);
