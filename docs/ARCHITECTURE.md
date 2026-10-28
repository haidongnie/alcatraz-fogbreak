# Architecture & module specs

Read `docs/DESIGN.md` (game design) first. Real-world facts are in `docs/RESEARCH.md`.

## Stack

- **three r186** via `import * as THREE from 'three/webgpu'` (WebGPURenderer, auto WebGL2 fallback).
  TSL from `'three/tsl'`, addons from `'three/addons/...'`. Never import from `'three'` directly.
- **Rapier** (`@dimforge/rapier3d-compat` 0.20) through `ctx.physics.world`; `RAPIER` is re-exported
  from `src/core/physics.ts`.
- **Playroom Kit** only behind `src/game/net.ts` (`ctx.net`). Never import `playroomkit` elsewhere.
- Vite, TypeScript strict. `npm run build` = `tsc --noEmit && vite build`. Base path is relative
  (`./`): build every public URL with `asset('models/x.glb')` from `src/config.ts`.
- Assets in `public/models/*.glb` (Meshy, meshopt + WebP; see `public/models/manifest.json`) and
  `public/data/island.json` (OSM + terrain). Load models only through `ctx.models` (ModelsApi).

## Files and owners

| Owner agent | Files (create/replace freely inside these) |
|---|---|
| core (lead) | `src/main.ts`, `src/config.ts`, `src/game/{types,context,net,rules,session}.ts`, `src/world/layout.ts`, `src/core/{renderer,assets,physics,input}.ts` |
| world | `src/world/island.ts`, `src/world/exterior.ts`, `src/world/atmosphere.ts`, `src/world/exterior/**`, `src/core/postfx.ts`, `src/core/environment.ts` |
| cellhouse | `src/world/cellhouse.ts`, `src/world/cellhouse/**` |
| player | `src/world/models.ts`, `src/game/player/**` |
| guards | `src/game/guards/**` |
| interact | `src/game/interact/**`, `src/game/raft/**` |
| ui | `src/ui/**`, `src/i18n.ts`, `src/audio/**` |

Every module currently exists as a **stub with the exact public API that `src/main.ts` calls**.
Replace the stub body; keep exported names, constructor signatures and public methods (you may add
more). Do not edit files you do not own — if you need a change there, describe it in your report.

## Conventions (all modules)

- **Units/axes**: metres; y up; sea level y = 0. Cellhouse long axis = +X (east end = admin wing),
  -Z = north side (A-Block), +Z = south (D-Block). See the header of `src/world/layout.ts`.
- **Yaw**: `ry`/`yaw` 0 faces -Z; direction = `(-sin(yaw), 0, -cos(yaw))` (`yawToDir` in layout).
  Equal to `object.rotation.y`. Meshy characters face +Z in their files: Avatar rotates the model π.
- **Coordinates for everything shared** (cells, climbs, traverses, zones, guard routes, nav graph,
  searchlights, light anchors, item spawns, launch site) are in `src/world/layout.ts`. Use them;
  don't invent duplicates.
- **Game rules** live in `src/game/rules.ts` (interactions, objectives, host logic). Clients never
  mutate WorldState; they call `ctx.net.act(action)` (or `session.act`).
- **Per frame**: no allocations in `update()` (preallocate vectors). Systems implement `update(dt)`.
- **Lighting budget** (WebGPU recompiles shaders when the light count changes — create every light
  once at init, then only change `intensity`/position; never add/remove lights at runtime):
  - Atmosphere: 1 moon DirectionalLight (the only shadow caster) + `quality.pointLights` pooled
    PointLights moved to the nearest `LIGHT_ANCHORS`.
  - Guards: 1 SpotLight per guard in `GUARDS` (flashlight), `castShadow = false`.
  - Searchlights: 1 SpotLight per `SEARCHLIGHTS` entry + 1 on the patrol boat, `castShadow = false`.
  - Nobody else creates lights. Lamps/fixtures/windows are emissive materials.
- **Exposure scale** (`LightingApi.exposure`, used for stealth): lamps 0..0.6 (atmosphere),
  flashlights 0..0.8 (guards), searchlight beams 0..1 (searchlights). Guards treat ≥ 0.85 outdoors as
  "in a searchlight".
- **Materials**: `MeshStandardMaterial`/`MeshPhysicalMaterial` (auto node materials) with
  procedural textures drawn on canvas at startup (cache them); colour maps `SRGBColorSpace`, data
  maps linear; always a roughness variation. Night scene: AgX tone mapping, exposure set by
  Atmosphere.
- **Shadows**: only the moon light. `castShadow` on architecture/props near play areas,
  `receiveShadow` on floors/terrain.
- **Physics**: static colliders with `.setCollisionGroups(WORLD_GROUPS)` (context.ts). Queries for
  camera/LOS/ground use `QUERY_WORLD_ONLY`. Prefer cuboids; trimesh only for terrain/odd shapes.
  Removable blockers (vent grilles are not colliders; the utility door is) keep their collider handle.
- **Draw calls**: target < 400 total on high tier. Merge static geometry per material
  (`BufferGeometryUtils.mergeGeometries`) and instance repeated props (`ctx.models.instanced`).
- **i18n**: all visible text through `t(key)` from `src/i18n.ts`. Keys are listed at the end of this
  file; the UI agent fills both languages. Others use only listed keys (report any new key you need).
- **Network**: read `ctx.world()` (WorldState), `ctx.actors()` (guards/boat/raft), other players'
  `ctx.net.getPlayerState(id)`; host check `ctx.net.isHost()`. Local events on `ctx.bus`.

## Frame order (main.ts)

```
input.poll → session.update → player.preUpdate → physics.update(fixedUpdate) → player.update →
rig.update → interaction → items → remotes → guards → searchlights → raft → cellhouse → exterior →
island → atmosphere.update → audio → ui → (12 Hz) net.setMyState(player.snapshot()) →
atmosphere.render → input.endFrame
```

Before the player spawns (title screen / briefing), main orbits the camera around the island and
renders through `atmosphere.render()` — the island must look good from the air at night.

---

## Module: world (`island.ts`, `exterior.ts`, `atmosphere.ts`)

**Island** (`Island.load(ctx)`): fetch `asset('data/island.json')`. `grid`: Int16 decimetres,
base64, row-major, `rows` along +Z starting at `minZ`, `cols` along +X from `minX`, spacing `res`
(2 m). Build the terrain mesh for the island + ~60 m margin at 2 m (coarser 8 m skirt further out,
down to the sea floor), with a procedural material: wet dark rock on steep slopes (cliffs), scrubby
dry grass/ice-plant on gentle slopes above 8 m, pale guano-streaked rock near the waterline, worn
concrete/asphalt pads near buildings. Collider: Rapier trimesh of the island area (y > -3).
`heightAt(x,z)` bilinear from the grid; `groundAt(x,y,z)` = physics ray down from y+0.5
(`QUERY_WORLD_ONLY`), falling back to `heightAt`.
Sea: large plane (≥ 4 km) at y = 0 with animated normals (TSL time-based ripples or two scrolling
procedural normal maps), dark blue-green, low roughness so the moon/searchlights glint, shoreline
foam where terrain ≈ 0. Distant context so the bay reads as the real place: San Francisco city
lights band ~2 km south-ish (bearing 177–201°), Angel Island dark hill ~2.8 km at bearing 7°,
faint Golden Gate Bridge lights 4.7 km at bearing 261°. Convert bearings with `island.json`
`northDir` (game-frame unit vector of true north; east = north rotated -90° about +Y, i.e.
`(-north.z, north.x)` → verify with the cellhouse: admin wing (+X) must be ESE).

**Exterior** (`new Exterior(ctx, island)`, `build()`): everything outdoors except the cellhouse
complex (Main Prison, Dining Hall, Administration Block — the cellhouse agent builds those).
- OSM buildings (`island.json.buildings`, polygons in game x/z, `base`, `height`): extrude walls +
  flat roofs, window rows (emissive canvas texture, a few warm-lit), colliders. 1962 state:
  everything intact (Warden's House, Officers' Club, lighthouse keepers' quarters).
- Landmarks from Meshy models (`ctx.models.instance(id)`, pivot bottom-centre, real size):
  `lighthouse` at the OSM lighthouse centroid; `water_tower` at OSM Water Tower; `smokestack` at
  OSM 'Powerhouse Smokestack' (scale height to ~30 m is already baked); `warden_house` at the
  Warden's House footprint (orient to the footprint's long edge, replace the extrusion);
  `guard_tower` at each `SEARCHLIGHTS[i].tower` (Model Roof Tower sits on the Model Industries
  roof — use a smaller scale there); `street_lamp` along roads and at exterior `LIGHT_ANCHORS`
  (emissive globes); `cypress_tree` around the Warden's House/garden and slopes; `crates`,
  `oil_drums` near the power house/dock; `shore_rocks` instanced along the coastline every ~10 m;
  `pelican` a few on rocks. Use `ctx.models.instanced` for repeats.
- Roads (`lines` with `type` `highway:*`): ribbons draped on the terrain (+0.05 m), concrete/asphalt.
  Walls (`barrier:wall`, `barrier:retaining_wall`): 2–3 m concrete walls with colliders.
  Pier (`pier`): timber deck on piles.
- Fences: chain-link with barbed wire, 3.7 m (alpha-tested texture + posts), with colliders:
  the service yard (`SERVICE_YARD` box; its north side is `FENCE`, the cellhouse/kitchen wall
  closes its south side) and a perimeter fence along the north/north-east shore from the Model
  Industries building to behind the power house (leave the route from `FENCE.climbOut` down to
  `LAUNCH` open; the guard routes in `GUARDS` must stay walkable).
- Recreation yard (OSM area 'Recreation Yard'): 6 m concrete walls with a catwalk, stepped
  bleachers on the cellhouse side, painted concrete floor.
- Signs: "UNITED STATES PENITENTIARY" on Building 64 facing the dock; "ONLY GOVERNMENT BOATS
  PERMITTED WITHIN 200 YARDS" boards on the NW shore and at the dock (canvas text textures).

**Atmosphere** (`init()`, `update(dt)`, `render()`, `lampExposure(p)`): night of 11 June 1962,
fog rolling in. Sky dome with a deep blue-black gradient, stars, a hazy moon low in the west
(bearing ~250°); `scene.fog` (FogExp2, blue-grey, density ~0.006 outdoors, lower indoors — react
to `bus` 'zone'); moon DirectionalLight (cool 0x9fb6d8) with a tight shadow frustum following the
camera target (texel-snapped); a dim night environment map (PMREM of the sky) for reflections;
light pool (`quality.pointLights` PointLights re-assigned to the nearest LIGHT_ANCHORS every
0.3 s, unused ones intensity 0). Post-processing via `src/core/postfx.ts` per `quality` (AO, bloom
threshold so lamps and searchlights bloom softly, TRAA/SMAA). Tone mapping exposure tuned for
night (player must still read the scene: never pitch black — indoor cellhouse readable, outdoors
silhouettes readable against fog). `render()` draws the frame (skip when the canvas is 0×0).
`lampExposure(p)`: 0..0.6 from LIGHT_ANCHORS with distance falloff (indoor floor baseline ~0.2).

## Module: cellhouse (`cellhouse.ts` + `src/world/cellhouse/**`)

`new Cellhouse(ctx)`, `build()`, `update(dt)`. Builds the Main Prison, Dining Hall/kitchen wing
and Administration wing (OSM footprints in `island.json`; Main Prison polygon is also in
`CELLHOUSE_POLY`) inside and out, faithful to `docs/RESEARCH.md` and the numbers in `layout.ts`.
- **Shell**: walls from below the terrain (y ≈ 25) to `ROOF` (main) / `WING_ROOF` (dining/kitchen)
  / FLOOR+10 (admin), board-formed concrete painted cream/buff; tall barred windows along the
  walls (glass + bars, faint interior glow at night); flat tar-and-gravel roofs with a low parapet,
  long skylight strips, several `roof_ventilator` models (one exactly above `ROOF_VENT`), walkable
  (roof colliders). The main roof steps down to the wing roof at the west end (players drop down).
  `BAKERY_PIPE`: a 0.3 m pipe with brackets on the kitchen wing's north wall from the service yard
  ground (33 m) to above `WING_ROOF`. Kitchen wing walls reach down to the service yard level.
- **Interior** (floor slab at FLOOR, ceiling at CEILING with steel trusses): aisles per `AISLES`;
  blocks per `BLOCKS` (B/C: 3 tiers × 28 cells on both faces with the utility corridor between;
  A: old style, storage; D: treatment unit, 14 cells × 3 tiers facing south, 2.1 m pitch).
  Cells 1.52 × 2.74 × 2.13 m, partitions, cell fronts (round bars + flat bands + sliding door;
  instanced), cantilevered 1.2 m tier walkways with pipe railings on every cell face, stairs at the
  block ends, block-top slabs at BLOCK_TOP (gap over each utility corridor). All non-player cells get
  instanced furniture (`cell_bunk`, `cell_toilet`, `cell_sink`, `cell_table`); A-Block cells hold
  storage clutter.
- **Utility corridor of B** (`UTILITY_B`): dark, full height, crammed with pipes (instanced
  cylinders), vent grilles of every cell, the climbable pipe column at `UTILITY_CLIMB` visually
  distinct (ladder-like brackets), the steel `UTILITY_DOOR` (collider removed + door swings open when
  world flag `utility_door` = 1).
- **Player cells** (`PLAYER_CELLS`): individually built, furniture at the given anchors, the vent
  grille at `vent` (25×36 cm, painted mint green) visible from both sides; when flag `vent:<slot>`
  is 1 the grille lies on the floor and a dark hole remains. The `dummy_head` model appears on
  the pillow when `dummy:<slot>` is 1 (with a blanket lump under it). Cell bars are colliders (the
  player must not leave through the front); the back wall is solid (crawling is a traverse).
- **Hole cells** (`HOLE_CELLS`): enterable interior, barred inner door collider at the front.
- **Workshop** on top of B (`WORKSHOP`): blankets hung on a wire-mesh cage around a dead fan
  housing, a work lamp (emissive), raincoat piles, a half-built pontoon (decor, not the item),
  two plank bridges across the utility gap (walkable, at x ≈ -18 and -11), and the ventilator duct
  rising from above `ROOF_VENT.below` to the roof.
- **Times Square**: `wall_clock` at `CLOCK`, closed dining-hall double door at `DINING_DOOR`.
  **Gun galleries** (`GUN_GALLERIES`): two-level caged catwalks on the west and east walls
  (colliders keep players out). **Library** (`LIBRARY`): shelves of books, `book_cart` at
  `BOOK_CART`, desk; door gap in its north wall. **East end**: `guard_desk` at `GUARD_DESK`, closed
  cutoff gate to the admin wing, `metal_locker`, `mop_bucket`. Painted aisle signs: BROADWAY,
  MICHIGAN AVE., PARK AVE., TIMES SQUARE.
- **Fixtures**: emissive fluorescent fixtures at the indoor `LIGHT_ANCHORS` (real light comes from
  the atmosphere light pool) and dim night lights along the aisles. No light objects.
- **Colliders**: cuboids for walls, slabs, block masses (solid where players can't go), walkways,
  stairs (ramps), railings, gallery cages, furniture in reachable spaces.
- React to `ctx.bus.on('world', w => ...)` for flags (`vent:*`, `dummy:*`, `utility_door`, `roof_vent`
  — drilled bars visibly bent/removed on the roof ventilator).
- Budget: ≤ 150 draw calls for the whole complex (merge per material, instance cells).

## Module: player (`models.ts`, `game/player/**`)

**Models** (`Models.load(assets, onProgress)`): fetch `asset('models/manifest.json')`, load every
GLB (`asset(entry.url)`) with `assets.model()`, report progress. Static models: their pivot and
real size are baked; `instance()` clones (sharing geometry/materials), sets cast/receive shadow;
missing id → grey box placeholder of `size` or 0.5 m. `instanced()` → one InstancedMesh per mesh of
the model (account for each mesh's transform within the model). `character(id)`:
`SkeletonUtils.clone`, scale to `entry.height` using the skinned bounds, clips renamed already
(see manifest `animations`), **strip horizontal root motion** (hips position X/Z tracks → constant)
so animations play in place, find bones for hand/back/head (Meshy rig names like `RightHand`,
`Spine02`/`Spine01`/`Spine`, `Head`), `frustumCulled = false` on skinned meshes.

**Avatar** (`new Avatar(ctx, characterId)`): root Object3D (yaw applied by owner), model rotated π
inside (files face +Z), cross-fading `play()`, one-shot clips (pickup, knockdown) clamp, walk/run
playback speed scaled to movement speed when a `speed` hint is set, `attach()` puts a carried item
visual on the back bone (bundles) or right hand (drill/keys).

**LocalPlayer** (`new LocalPlayer(ctx, characterId, rig, spawn, ry)`; `preUpdate/fixedUpdate/update`):
Rapier kinematic capsule (radius 0.3, height 1.78, membership GROUP.PLAYER) + character controller
(autostep 0.35, snap to ground, max slope 50°). Movement relative to `rig.yaw`; body turns toward
the move direction; Shift run, C/Ctrl crouch (toggle), Space jump; speeds from `TUNING.player`
(carrying a bundle → ×carrySpeedMul, no run). Climb mode along a `ClimbDef` (W/S up/down, exits at
the ends, `climb` anim). Traverse: fade out (`bus` 'fade'), move a→b, fade in. Seated mode: follow
the anchor's world transform, `sit` anim, publish `rw` = [forward, steer] from WASD. Swimming when
in water (`zoneAt` → 'water' or y < 0.2 outdoors): slow, `swim` anim, feet held at y ≈ -1.1.
Frozen mode. Q toggles concertina/music while in the player's own cell zone (`m` = 1, `sit` anim).
Emits `bus` 'zone' on change. Noise: walk 0.25 / run 0.7 / crouch 0.05 (only while moving) plus
`addNoise` this frame. `snapshot()` → PlayerNet (anim name, crouch, zone, noise, m, rw).
Registers its avatar in `ctx.avatars` under `ctx.myId`. Safety: below y = -20 → teleport home.

**CameraRig**: third-person over-the-shoulder (0.45 m right), distance 3.2 m (wheel 1.4–6),
`yaw`/`pitch` from `input.look` when `input.lookActive` (sensitivity from
`localStorage['fogbreak.sens']`, default 1), pitch clamp; sphere/ray cast against
`QUERY_WORLD_ONLY` so the camera never clips walls (tight spaces: cell, utility corridor → short
boom); smooth follow. Exposes `yaw`, `pitch`.

**RemotePlayers**: one Avatar per other connected player (`ctx.net.players()`), character from
their slot in `ctx.world().players[id].slot`; interpolate positions (≈120 ms buffer), yaw, anim,
crouch; name tag sprite (player colour + name; visible through walls at low opacity for co-op);
register in `ctx.avatars`; dispose on quit.

## Module: guards (`game/guards/**`)

`Guards` (host simulates, everyone renders) per `GUARDS` (active when `world.alarm >= minAlarm`):
modes patrol → suspicious → investigate → chase → return, plus `count` for the guard with
`counts: true` while `world.flags.countOpen` (walk the B-Block Michigan Avenue flats shining the
flashlight into cells, then resume). Patrol waypoints are feet positions; outdoor guards
ground-snap with `ctx.terrain.groundAt`. Cellhouse guards path with `NAV_NODES`/`NAV_EDGES` (A*)
when not in direct line; the gallery guard stays on its gallery route.
Perception (host, ~10 Hz): only players with `world.players[id].s === 'free'` and a PlayerNet;
ignore players in zones `cell`, `utility`, `workshop` (unpatrolled, walls block LOS anyway).
Vision cone `TUNING.guard.fov`, range, LOS ray (`QUERY_WORLD_ONLY`) eye (1.65 m) → chest; factor
crouch-in-dark ×0.45, lit (`ctx.lighting.exposure` > 0.5) ×1.4, inside the guard's own flashlight
cone ×1.6. Suspicion rises with visibility and nearness, decays when unseen; at 1 → chase (floor
and outdoor guards) and catch at `catchDistance` → `hooks.onCatch(pid, i)`. The gallery officer
cannot chase: at full suspicion → `hooks.onSpotted('guard', pid)` (20 s cooldown) and the nearest
floor guard investigates. Searchlights: an outdoor free player with exposure ≥ 0.85 for 1.2 s →
`hooks.onSpotted('searchlight', pid)` (15 s cooldown) and the nearest outdoor guard investigates.
Hearing: `hearNoise(p, r)` plus each player's PlayerNet `n` (noise × TUNING.guard.hearing ≥
distance → investigate); work noise in zones cell/utility is ×`TUNING.noise.concertinaMask` if any
player with `m = 1` is within `concertinaRange`. Publish via `snapshot()` (GuardNet[] with stable
`i`). Clients render from `ctx.actors().g` with interpolation. Visuals: `new Avatar(ctx, 'guard')`
(import from `../player/Avatar`), flashlight SpotLight + faint volumetric cone, "?"/"!" sprite
above the head. `exposure(p)` = 0..0.8 inside a lit flashlight cone.

`Searchlights` (deterministic from `ctx.time()`, no networking): for each `SEARCHLIGHTS` entry a
`searchlight` model at `tower + height`, a SpotLight sweeping `yaw ± amp` (sinusoid, `period`) with
downward `pitch`, a volumetric beam (additive cone, fog-friendly), `exposure(p)` with occlusion
(physics ray from the lamp; the power house must shadow the launch site from the Model Roof Tower).
Patrol boat: `patrol_boat` model moving along `BOAT_ROUTE` (closed Catmull-Rom, ~4 m/s, bobbing,
wake), with its own sweeping searchlight; `boatPose()`.

## Module: interact (`game/interact/**`, `game/raft/**`)

`Interaction`: each frame gather candidates near the local player: `rules.availableInteractions`
(world, myId), `TRAVERSES` (requires flag, slot, `allowHeavy`, within 1.2 m of `a` or `b`), `CLIMBS`
(near bottom or top; heavy items can't be climbed up; starting `bakery_pipe` from the top while
carrying a bundle first sends a `drop` at `dropHeavyTo` with toast `toast.dropHeavy`). Pick the
nearest in front; show a prompt (`bus` 'prompt' with `t(prompt)`, hold seconds, progress). Hold E
(or touch Interact) for `hold` seconds: `player.setWorking(true)`, `player.addNoise(noise)`; on
completion → `ctx.net.act({k:'interact', id})` (or `startTraverse`/`startClimb`); releasing early
cancels. `continuous` (inflate): while held send `{k:'progress', id, amount}` every 0.25 s. G drops,
F throws (`ctx.items.dropPoint`). Completed actions with noise ≥ 0.5 also emit `bus` 'noise'
(`r = TUNING.guard.hearing * noise`). Disabled unless `world.phase === 'playing'` and my status is
`free`.

`Items` (ItemsApi): render every item with `by !== '-'`: lying (`by === ''`) at `p` with a soft
highlight when interactable nearby, or attached to the carrier's avatar (`ctx.avatars.get(by)`).
Visuals: drill → `drill`, keys → `key_ring`, bundle_raft → `raincoat_bundle` (scaled up),
bundle_paddles → `paddle` ×2 + `life_vest`, bundle_concertina → `concertina`. `dropPoint(throw)`:
ground point in front of the player (throw: ~6 m arc, raycast).

`Raft`: before inflation show the deflated `raft` model at `LAUNCH.raftSpawn` once all bundles
are at the launch (flattened, scale y grows with `world.raft.inflate`), floating with bobbing when
inflated. Host `hostUpdate(dt, w)`: when an aboard player paddles (`rw[0] > 0.1`), set
`w.raft.launched = 1`, everyone free and not aboard → `left_behind` (toast), then integrate: speed
`TUNING.raft.paddleSpeed + extraPaddler × (n-1)` × mean forward input along the raft's heading,
plus `EBB_CURRENT`; yaw += mean steer × turnRate; collide softly with the island (terrain height
> -0.5 pushes back). `pose()` = [x, z, yaw, distance from LAUNCH.p]. Everyone: render the raft at
the pose (clients: interpolate `ctx.actors().r`), seat anchors for up to 4; when my status becomes
`aboard`, `ctx.player.setSeated(true, anchor)`; splashes.

## Module: ui (`src/ui/**`, `src/i18n.ts`, `src/audio/**`)

`UI` (see stub): title screen over the live 3D backdrop (game title 恶魔岛·雾夜越狱 / ALCATRAZ:
FOGBREAK, name input saved via `saveName`, 中文/EN toggle, buttons Play online / Solo / How to play,
credits: Meshy AI models, OpenStreetMap, AWS Terrain Tiles/USGS, Playroom Kit, three.js; loading bar,
Play disabled until loaded; invited players see a Join button). After `attach()`:
briefing/lobby while `world.phase === 'briefing'` (prologue, cast with names and characters,
invite URL with Copy/Share, host Start button → `session.act({k:'start'})`, others wait),
HUD while playing (chapter + `rules.objectives`, objective marker toward `rules.objectiveTarget`,
alarm pips, next-count timer, night clock 21:30 + elapsed, interaction prompt with hold ring from
`bus` 'prompt', teammate list with status, zone/area name, noise + visibility meters from
`ctx.player.snapshot().n` and `ctx.lighting.exposure`), chapter cards on `fx` chapter, toasts for
fx/bus toasts, caught overlay, alarm vignette, count banner, fade overlay (`bus` 'fade'), minimap
(M) drawn from `island.json` + layout, pause menu (Esc: resume, language, mouse sensitivity →
`localStorage['fogbreak.sens']`, invite link, leave), end screen for won/lost with epilogue,
stats and per-player outcome, restart (host). Manage pointer lock (`ctx.input.pointerLockAllowed`,
`exitPointerLock`) when overlays open; hint "click to look around". Touch controls when
`isTouch`: left virtual stick → `input.setVirtualAxis`, right-side drag → `input.addLook`, buttons
→ `input.setVirtualButton('KeyE'|'KeyC'|'ShiftLeft'|'KeyG'|'KeyQ'|'Space', down)`. Style: 1960s
government typewriter/stencil look, readable, responsive (phone landscape + desktop).

`Audio` (procedural WebAudio, no files): outdoor wind + surf + distant foghorn (two-tone every
~30 s) + gulls; indoor cellhouse hum, distant coughs/snores, drips (switch by zone); footsteps from
the local player's speed; fx sounds (`SfxId`), whistle when a guard starts chasing, alarm bell,
count bell; tension drone that rises with alarm/chase; concertina melody near any player with
`m = 1`. Master volume in the pause menu.

## i18n keys (UI agent fills zh + en; others use only these)

```
loading.renderer loading.models loading.island loading.cellhouse loading.exterior loading.shaders loading.ready
net.failed
prompt.dummy prompt.vent prompt.lockpick prompt.drill prompt.free prompt.inflate prompt.board
prompt.pickup.drill prompt.pickup.keys prompt.pickup.bundle_raft prompt.pickup.bundle_paddles prompt.pickup.bundle_concertina
prompt.crawl prompt.roof prompt.fence prompt.climbUp prompt.climbDown prompt.drop prompt.throw prompt.music prompt.handsFull
toast.dummy toast.vent toast.door toast.roofvent toast.inflated toast.countMissed toast.dropHeavy
toast.caught toast.freed toast.alarm toast.count toast.countEnd toast.joined toast.left toast.spotted toast.leftBehind toast.launched
obj.dummy obj.vent obj.crawl obj.climb obj.door obj.getDrill obj.bringDrill obj.keysOptional obj.drillVent
obj.carry obj.pipe obj.inflate obj.board obj.paddle
chapter.lights_out chapter.utility chapter.drill chapter.roof chapter.descent chapter.bay   (+ `.text` for each)
lost.lockdown lost.allCaught
zone.cell zone.utility zone.workshop zone.floor zone.dblock zone.roof zone.yard zone.shore zone.water zone.raft zone.outside
item.drill item.keys item.bundle_raft item.bundle_paddles item.bundle_concertina
status.free status.hole status.aboard status.escaped status.left_behind
```
Args: `toast.caught {name}`, `toast.freed {name}`, `toast.alarm {level}`, `toast.joined {name}`,
`toast.left {name}`.
