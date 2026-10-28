// Bootstrap and frame loop. Order: title screen + background loading -> world build ->
// connect (Playroom or offline) -> session -> systems -> loop.
import * as THREE from 'three/webgpu';
import { createRenderer } from './core/renderer';
import { Assets } from './core/assets';
import { Physics } from './core/physics';
import { Input } from './core/input';
import { params, pickQuality, TUNING } from './config';
import { initI18n, t } from './i18n';
import { Bus, type Ctx } from './game/context';
import { LocalNet, PlayroomNet, type Net } from './game/net';
import { Session } from './game/session';
import { CHARACTER_IDS, type WorldState } from './game/types';
import { HOLE_CELLS, PLAYER_CELLS } from './world/layout';
import { Models } from './world/models';
import { Island } from './world/island';
import { Exterior } from './world/exterior';
import { Cellhouse } from './world/cellhouse';
import { Atmosphere } from './world/atmosphere';
import { CameraRig } from './game/player/CameraRig';
import { LocalPlayer } from './game/player/LocalPlayer';
import { RemotePlayers } from './game/player/RemotePlayers';
import { Guards } from './game/guards/Guards';
import { Searchlights } from './game/guards/Searchlights';
import { Interaction } from './game/interact/Interaction';
import { Items } from './game/interact/Items';
import { Raft } from './game/raft/Raft';
import { Audio } from './audio/Audio';
import { UI } from './ui/ui';

const lang = initI18n();
const bus = new Bus();
const ui = new UI(bus);
const quality = pickQuality();
const canvas = document.querySelector<HTMLCanvasElement>('#game')!;

// 1. Title screen right away; everything below loads behind it.
const invite = /[#&]r=/.test(location.hash);
const choice = ui.showTitle({ invite });
ui.setLoading(0.02, t('loading.renderer'));

// 2. Core.
const renderer = await createRenderer({ canvas, maxPixelRatio: quality.maxPixelRatio, forceWebGL: params.has('webgl') });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, Math.max(1, canvas.clientWidth) / Math.max(1, canvas.clientHeight), 0.1, 1800);
camera.position.set(-120, 95, -230);
camera.lookAt(-40, 40, 0);
const assets = new Assets(renderer);
const physics = await Physics.create();
const input = new Input(canvas);

let session: Session | null = null;
const ctx: Ctx = {
  renderer, scene, camera, physics, assets, input, quality, bus, lang,
  net: new LocalNet(), // replaced after the player picks online/offline
  myId: 'local',
  time: () => session?.time() ?? performance.now() / 1000,
  world: () => session?.getWorld() ?? null,
  actors: () => session?.getActors() ?? null,
  models: null!, terrain: null!, lighting: null!,
  player: null, items: null, avatars: new Map(),
};

// 3. World.
ctx.models = await Models.load(assets, (f) => ui.setLoading(0.05 + f * 0.45, t('loading.models')));
ui.setLoading(0.52, t('loading.island'));
const island = await Island.load(ctx);
ctx.terrain = island;
const atmosphere = new Atmosphere(ctx);
await atmosphere.init();
ui.setLoading(0.62, t('loading.cellhouse'));
const cellhouse = new Cellhouse(ctx);
await cellhouse.build();
ui.setLoading(0.8, t('loading.exterior'));
const exterior = new Exterior(ctx, island);
await exterior.build();
const searchlights = new Searchlights(ctx);
ui.setLoading(0.9, t('loading.shaders'));
try { await renderer.compileAsync(scene, camera); } catch (err) { console.warn('[main] shader warm-up failed', err); }
ui.setLoading(1, t('loading.ready'));

// Title-screen backdrop: slow orbit around the island until the player spawns.
let orbit = 0;
function titleCamera(dt: number) {
  orbit += dt * 0.025;
  camera.position.set(-40 + Math.cos(orbit) * 260, 95, Math.sin(orbit) * 260);
  camera.lookAt(-40, 38, 0);
}
const timer = new THREE.Timer();
timer.connect(document);
let started = false;
renderer.setAnimationLoop(() => {
  if (started) return;
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.1);
  titleCamera(dt);
  searchlights.update(dt);
  island.update(dt);
  atmosphere.update(dt);
  atmosphere.render();
});

// 4. Connect.
const { mode, name } = await choice;
let net: Net;
if (mode === 'online') {
  try {
    net = await PlayroomNet.connect();
  } catch (err) {
    console.warn('[net] Playroom unavailable, playing offline', err);
    ui.toast(t('net.failed'));
    net = new LocalNet();
  }
} else {
  net = new LocalNet();
}
if (name) net.setMyName(name);
ctx.net = net;
ctx.myId = net.myId;
session = new Session(net, bus);

// 5. Systems.
const audio = new Audio(ctx);
audio.unlock();
const rig = new CameraRig(ctx);
const remotes = new RemotePlayers(ctx);
const items = new Items(ctx);
ctx.items = items;
const interaction = new Interaction(ctx);
const raft = new Raft(ctx);
const guards = new Guards(ctx, {
  onCatch: (pid, gi) => session!.catchPlayer(pid, gi),
  onSpotted: () => session!.spotted(),
});
ctx.lighting = {
  exposure: (p) => Math.max(atmosphere.lampExposure(p), searchlights.exposure(p), guards.exposure(p)),
};
session.setHooks({
  guards: () => guards.snapshot(),
  boat: () => searchlights.boatPose(),
  raftHost: (dt, w) => raft.hostUpdate(dt, w),
  raftPose: () => raft.pose(),
  hearNoise: (p, r) => guards.hearNoise(p, r),
});
bus.on('noise', (n) => session!.act({ k: 'noise', p: n.p, r: n.r }));
ui.attach(ctx, session);

// 6. Spawning and status changes of the local player.
let player: LocalPlayer | null = null;
let lastPhase: WorldState['phase'] | null = null;
function mySlot(w: WorldState) { return w.players[ctx.myId]?.slot ?? 0; }
function spawn(w: WorldState) {
  const slot = mySlot(w);
  const st = w.players[ctx.myId]?.s;
  const cell = PLAYER_CELLS[slot];
  const at = st === 'hole' ? HOLE_CELLS[slot].inside : cell.spawn;
  if (!player) {
    player = new LocalPlayer(ctx, CHARACTER_IDS[slot], rig, at, cell.spawnRy);
    ctx.player = player;
  } else {
    player.teleport(at, cell.spawnRy);
  }
}
bus.on('world', (w) => {
  const me = w.players[ctx.myId];
  if (w.phase === 'playing' && me && (lastPhase !== 'playing' || !player)) spawn(w);
  lastPhase = w.phase;
  player?.setFrozen(w.phase !== 'playing');
});
bus.on('fx', (f) => {
  const w = ctx.world();
  if (!w || !player) return;
  const slot = mySlot(w);
  if (f.k === 'caught' && f.pid === ctx.myId) {
    bus.emit('fade', { to: 1, duration: 0.4 });
    player.setFrozen(true);
    setTimeout(() => {
      player!.teleport(HOLE_CELLS[slot].inside, 0);
      player!.setFrozen(false);
      bus.emit('fade', { to: 0, duration: 0.8 });
    }, 1400);
  }
  if (f.k === 'freed' && f.pid === ctx.myId && !f.by) {
    bus.emit('fade', { to: 1, duration: 0.3 });
    setTimeout(() => {
      player!.teleport(PLAYER_CELLS[slot].spawn, PLAYER_CELLS[slot].spawnRy);
      bus.emit('fade', { to: 0, duration: 0.8 });
    }, 500);
  }
});

// 7. Frame loop.
started = true;
let publishAccum = 0;
renderer.setAnimationLoop(() => {
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.1);
  input.poll();
  session!.update(dt);

  player?.preUpdate(dt);
  physics.update(dt, (step) => player?.fixedUpdate(step));
  player?.update(dt);
  if (player) rig.update(dt); else titleCamera(dt);

  interaction.update(dt);
  items.update(dt);
  remotes.update(dt);
  guards.update(dt);
  searchlights.update(dt);
  raft.update(dt);
  cellhouse.update(dt);
  exterior.update(dt);
  island.update(dt);
  atmosphere.update(dt);
  audio.update(dt);
  ui.update(dt);

  publishAccum += dt;
  if (player && publishAccum >= 1 / TUNING.net.playerHz) {
    publishAccum = 0;
    net.setMyState(player.snapshot());
  }

  atmosphere.render();
  input.endFrame();
});

new ResizeObserver(() => {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}).observe(canvas);
