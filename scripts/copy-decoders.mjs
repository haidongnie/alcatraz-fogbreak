#!/usr/bin/env node
// Copies the Draco decoder and Basis (KTX2) transcoder binaries from three.js into public/
// so DRACOLoader / KTX2Loader can fetch them at runtime. Runs on `npm install` (postinstall).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const pairs = [
  ['node_modules/three/examples/jsm/libs/draco/gltf', 'public/draco'],
  ['node_modules/three/examples/jsm/libs/basis', 'public/basis'],
];

for (const [from, to] of pairs) {
  const src = resolve(root, from);
  const dst = resolve(root, to);
  if (!existsSync(src)) {
    console.warn(`[copy-decoders] missing ${from} (is three installed?)`);
    continue;
  }
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
  console.log(`[copy-decoders] ${from} -> ${to}`);
}
