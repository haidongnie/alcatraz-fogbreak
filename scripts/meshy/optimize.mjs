#!/usr/bin/env node
// Turns the raw Meshy downloads (assets-src/meshy/<id>/) into web-ready files in public/models/:
//   - props/landmarks: model.glb, scaled to real-world size (assets.json `fit`), centred on X/Z,
//     resting on y = 0 (the scale is baked so the game places them without any fix-ups)
//   - characters: anim.glb (mesh + skeleton + all clips), clips renamed to game names
//     (idle, walk, run, ...). Scale is applied at runtime from the skinned bounds.
//   - every file: dedup + prune + keyframe resample, textures -> WebP (1024 px, 512 px for small
//     props), meshopt geometry compression.
// Writes public/models/manifest.json describing what is available.
//
// usage: node scripts/meshy/optimize.mjs [--only id1,id2]
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, textureCompress, meshopt, getBounds } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const manifest = JSON.parse(readFileSync(resolve(here, 'assets.json'), 'utf8'));
const state = existsSync(resolve(here, 'state.json')) ? JSON.parse(readFileSync(resolve(here, 'state.json'), 'utf8')) : {};
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

const outDir = resolve(root, 'public/models');
mkdirSync(outDir, { recursive: true });
const outManifestPath = resolve(outDir, 'manifest.json');
const out = existsSync(outManifestPath) ? JSON.parse(readFileSync(outManifestPath, 'utf8')) : { models: {} };

for (const asset of manifest.assets) {
  if (only && !only.includes(asset.id)) continue;
  const isChar = asset.kind === 'character';
  const src = resolve(root, 'assets-src/meshy', asset.id, isChar ? 'anim.glb' : 'model.glb');
  if (!existsSync(src)) { console.log(`skip ${asset.id} (no source yet)`); continue; }

  const doc = await io.read(src);
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const entry = { url: `models/${asset.id}.glb`, kind: asset.kind };

  if (isChar) {
    // Clips come back in the order of the requested action ids; rename them to game names.
    const ids = state[asset.id]?.actionIds ?? (asset.role === 'guard' ? manifest.guardAnimations : manifest.prisonerAnimations);
    const anims = doc.getRoot().listAnimations();
    const names = [];
    anims.forEach((a, i) => {
      const name = manifest.animationNames[String(ids[i])] ?? a.getName();
      a.setName(name);
      names.push(name);
    });
    entry.role = asset.role;
    entry.height = asset.height;
    entry.animations = names;
  } else {
    // Bake real-world scale + pivot (bottom centre) into a new root node.
    const b = getBounds(scene);
    const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    const fit = asset.fit ?? { axis: 'max', size: 1 };
    const ref = fit.axis === 'x' ? size[0] : fit.axis === 'y' ? size[1] : fit.axis === 'z' ? size[2] : Math.max(...size);
    const s = fit.size / (ref || 1);
    const pivot = doc.createNode(`${asset.id}_root`)
      .setScale([s, s, s])
      .setTranslation([-(b.min[0] + b.max[0]) / 2 * s, -b.min[1] * s, -(b.min[2] + b.max[2]) / 2 * s]);
    for (const child of scene.listChildren()) { scene.removeChild(child); pivot.addChild(child); }
    scene.addChild(pivot);
    entry.size = size.map((v) => +(v * s).toFixed(3));
  }

  const texSize = asset.kind === 'prop' && (asset.fit?.size ?? 1) < 0.7 ? 512 : 1024;
  await doc.transform(
    dedup(),
    prune(),
    resample(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [texSize, texSize], quality: 82 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  const dst = resolve(outDir, `${asset.id}.glb`);
  await io.write(dst, doc);
  entry.bytes = statSync(dst).size;
  out.models[asset.id] = entry;
  console.log(`${asset.id.padEnd(16)} -> ${(entry.bytes / 1e6).toFixed(2)} MB ${entry.size ? `size ${entry.size.join(' x ')} m` : `anims ${entry.animations.join(',')}`}`);
}

writeFileSync(outManifestPath, JSON.stringify(out, null, 2));
console.log(`manifest: ${Object.keys(out.models).length} models`);
