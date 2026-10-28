# Starter skeleton

Minimal vanilla Three.js (WebGPU renderer, r183+) + TypeScript + Vite + Rapier project that
implements the skill's defaults: AgX tone mapping, HDRI lighting, one shadow-casting sun,
GTAO + TRAA + bloom post stack, fixed-step physics with interpolation, kinematic first-person
player. Copy it into a fresh `npm create vite@latest -- --template vanilla-ts` project (or use
it as the project root) and adapt.

Written against three r186 / @types/three 0.186 / @dimforge/rapier3d-compat 0.20. After
installing, always run:

```bash
npm install
node ../scripts/check-env.mjs      # or wherever the skill's scripts/ folder lives
npx tsc --noEmit                   # catch API drift between three.js releases
npm run dev
```

If `tsc` complains about a renamed three.js API, consult
https://github.com/mrdoob/three.js/wiki/Migration-Guide for the installed version and fix the
call site; do not downgrade three.js to silence it.

Assets expected under `public/` (all optional - the starter runs with a procedural sky and a
test scene when they are missing):

- `public/env/sky_2k.hdr` - any 2k equirect HDRI (Poly Haven is CC0)
- `public/models/level.glb` - a level; meshes named `col_*` become collision-only
- `public/draco/`, `public/basis/` - copied by `scripts/copy-decoders.mjs` on `npm install`

Files:

```
index.html
package.json
tsconfig.json
vite.config.ts
scripts/copy-decoders.mjs  postinstall: Draco/Basis binaries -> public/
src/main.ts                bootstrap + frame loop (+ test scene when no level.glb)
src/core/renderer.ts       WebGPURenderer with color pipeline
src/core/environment.ts    HDRI (or procedural SkyMesh) + sun + shadow frustum
src/core/assets.ts         GLTF/KTX2/Draco/meshopt/HDR loaders
src/core/physics.ts        Rapier world, fixed step, interpolation, trimesh helper
src/core/postfx.ts         RenderPipeline: GTAO + bloom + TRAA/SMAA
src/core/input.ts          keyboard/mouse with pointer lock
src/game/Player.ts         kinematic capsule + character controller + first-person camera
```

Controls: click to lock the pointer, WASD to move, Shift to sprint, Space to jump.
`?debug` shows CPU/GPU frame time, `?webgl` forces the WebGL 2 backend.
