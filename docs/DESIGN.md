# 恶魔岛·雾夜越狱 — ALCATRAZ: FOGBREAK

A 1–4 player co-op stealth escape set on a faithful, data-driven reconstruction of Alcatraz
Island on the night of **11 June 1962**. The story and characters are original fiction inspired by
the real June 1962 escape; the island terrain, coastline and building footprints come from
OpenStreetMap + USGS-derived elevation tiles (see `scripts/data/build-island.mjs`), and the cellhouse
interior follows published dimensions (see `docs/RESEARCH.md`).

## Pillars

1. **Real place.** Real coastline, terrain, building footprints and the real cellhouse plan
   (A/B/C/D blocks, Broadway, Michigan Avenue, Times Square, the utility corridor, roof ventilators).
2. **Co-op stealth.** Every task can be done solo, but splitting up (one scouts, one carries, one
   drills, one covers noise with the concertina) is much faster and safer.
3. **One continuous night.** No loading screens: cell → utility corridor → (cellhouse floor) → roof →
   down the bakery pipe → fence → shore → bay.

## Cast (fictional)

| Slot | Model        | Name (zh / en)                     | Number  | Flavour                                    |
|------|--------------|------------------------------------|---------|--------------------------------------------|
| 0    | prisoner_a   | 埃迪·“火花”·卡拉汉 / Eddie “Sparks” Callahan | AZ-1417 | Electrician; built the vacuum-motor drill. |
| 1    | prisoner_b   | 老沃尔特·休斯 / “Old Man” Walt Hughes  | AZ-1298 | Painter; made the papier-mâché heads.      |
| 2    | prisoner_c   | 约翰尼·雷耶斯 / Johnny Reyes          | AZ-1502 | Youngest; climber and lock-picker.         |
| 3    | prisoner_d   | 雷·“水手长”·林奎斯特 / Ray “Bosun” Lindqvist | AZ-1376 | Ex-merchant sailor; reads the currents.    |

Players take slots in join order. Slot = character = cell (B-Block, bottom tier, utility-corridor
side, four adjacent cells). Guards are Bureau of Prisons correctional officers (`guard` model).

## Story beats (shown as chapter cards; zh primary, en secondary)

0. **Prologue** — “1962年6月11日，旧金山湾。半年来，四个人用磨尖的勺子和改装的吸尘器马达，一点点凿穿了
   牢房后墙的通风口。今夜，雾从金门涌进海湾。熄灯铃响了。”
1. **熄灯 Lights Out** — put your papier-mâché dummy head in the bunk; pry off the loosened vent
   grille (hold, noisy). A teammate playing the concertina in their cell masks digging noise
   (“music hour”, a real Alcatraz privilege).
2. **管道走廊 The Utility Corridor** — squeeze through into the dark pipe chase between the cell rows;
   climb the pipes to the hidden workshop on top of B-Block.
3. **钻头 The Drill** — the drill was stashed in the library book cart after a cell shake-down.
   Pick the utility-corridor door, sneak across the cellhouse floor (Broadway → Times Square →
   library) past the patrols (the west gun gallery is only manned once the alarm is raised), and bring it back. (Optional: lift the
   key ring from the guard desk to free a captured friend from D-Block isolation.)
4. **屋顶 The Roof** — drill out the rivets on the roof ventilator bars (hold, very noisy), climb
   onto the roof. Carry the raft gear (3 bundles: rolled raft, paddles & life vests, concertina)
   across the roof. Bundles can be thrown off the roof edge to save trips.
5. **烟囱 The Bakery Pipe** — slide down the kitchen/bakery vent pipe on the north wall to the
   ground, climb the double fence, descend to the north-east shore by the power house.
6. **入海 Into the Bay** — inflate the raft with the concertina (hold; several players = faster),
   board, paddle into the fog while the patrol boat and the tower searchlights sweep the water.
   Reaching the fog bank (~240 m off-shore) ends the game. Epilogue: “他们再也没有被找到……”

## Rules

- **Detection**: guards see with a 70° cone, 18 m range (×0.45 when the player crouches in
  darkness, ×1.4 when lit by a lamp/searchlight). Suspicion fills over ~1 s in plain sight,
  slower at range. At full suspicion the guard chases; contact = caught.
- **Noise**: walking 0.25, running 0.7, crouching 0.05, drilling/grille 0.9 (radius 25 m), fence 0.6.
  Guards hear noise inside `radius × noise` and investigate. Concertina playing in a cell within
  20 m reduces work noise ×0.35.
- **Caught**: player is marched (teleported after a fade) to a D-Block isolation cell (“the hole”).
  A teammate with the key ring frees them instantly; otherwise auto-release back to their own cell
  after 75 s. Each catch raises the alarm by 1.
- **Counts**: every 4 minutes an officer walks the B-Block flats with a flashlight. A player who is
  out of cell **without** the dummy head in their bunk raises the alarm by 1 (once per count).
- **Alarm**: 0–3. At 1 an extra patrol appears, at 2 the searchlights sweep faster, at 3 →
  lockdown → mission failed (team wipe). Everyone caught at once → failed too.
- **Win**: at least one player aboard the raft reaches the fog bank. Players not aboard when the
  raft launches are left behind (their ending says so).

## Controls

Desktop: WASD move · mouse look (click to lock) · Shift run · C / Ctrl crouch · E interact (hold) ·
G drop · F throw · Q play concertina (when carried or in your cell) · Space jump/climb ·
Tab objectives · M map · Esc menu. Raft: W/S paddle forward/back, A/D steer.
Mobile: left stick move · drag right half to look · buttons Interact / Crouch / Run / Drop.

## Network model (Playroom Kit)

- Each client owns its **player state** `p` (unreliable, 12 Hz): position, yaw, animation, noise.
- The **host** is authoritative for the shared **world state** `w` (reliable, written on change):
  phase, chapter, flags, items, player statuses, alarm, raft. Guards/searchlights/boat are simulated
  only on the host and published as `g` (unreliable, 10 Hz) with the host game clock.
- Clients request changes with `RPC.call('act', action, HOST)`; the host validates against the
  world state (`src/game/rules.ts`) and broadcasts one-off effects with `RPC.call('fx', fx, ALL)`.
- Host migration: if the host leaves, Playroom promotes another player; since `w` and `g` live in
  room state, the new host resumes simulation from them.
- Offline/solo mode uses the same interfaces with a local loop-back implementation.

## Visual targets

Night, fog rolling in, moonlight from the west, sodium-orange yard lamps, cold fluorescent
cellhouse light. AgX tone mapping, one moon shadow, GTAO + light bloom on high tier.
Real metric scale (1 unit = 1 m). Quality tiers: high (desktop), low (mobile).
