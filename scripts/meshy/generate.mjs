#!/usr/bin/env node
// Generates every asset in scripts/meshy/assets.json with the Meshy API.
//   props/landmarks: text-to-3d preview (smart-topology, meshy-t2.5) -> refine (PBR textures)
//   characters:      same, then auto-rigging -> animation library clips merged into one GLB
// Progress is saved to scripts/meshy/state.json after every step, so the script can be
// re-run safely: an existing task id is always polled, never re-created (no double spend).
// Only FAILED tasks (refunded by Meshy) are retried, at most MAX_RETRIES times.
//
// usage: node scripts/meshy/generate.mjs [--only id1,id2] [--concurrency 8] [--dry]
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const API = 'https://api.meshy.ai/openapi';
const MAX_RETRIES = 2;
const POLL_MS = 8000;

const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const only = argVal('--only')?.split(',');
const concurrency = Number(argVal('--concurrency') ?? 8);
const dry = args.includes('--dry');

function loadKey() {
  if (process.env.MESHY_API_KEY) return process.env.MESHY_API_KEY;
  const envPath = resolve(root, '.env');
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, 'utf8').match(/^MESHY_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  }
  throw new Error('MESHY_API_KEY missing: set it in the environment or in .env (git-ignored)');
}
const KEY = loadKey();

const manifest = JSON.parse(readFileSync(resolve(here, 'assets.json'), 'utf8'));
const statePath = resolve(here, 'state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (id, msg) => console.log(`${new Date().toISOString().slice(11, 19)} [${id}] ${msg}`);

// HTTP goes through curl: it honours HTTPS_PROXY (sandboxed environments), Node's fetch does not.
function curl(argv, { binary = false } = {}) {
  return new Promise((resolveP, reject) => {
    execFile('curl', ['-sS', '--max-time', '300', ...argv], { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 1 << 30 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`curl: ${String(stderr || err.message).slice(0, 300)}`));
      else resolveP(stdout);
    });
  });
}

async function api(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    let out;
    try {
      const argv = ['-X', method, `${API}${path}`, '-H', `Authorization: Bearer ${KEY}`, '-H', 'Content-Type: application/json', '-w', '\n%{http_code}'];
      if (body) argv.push('--data-binary', JSON.stringify(body));
      out = await curl(argv);
    } catch (err) {
      if (attempt > 8) throw err;
      await sleep(3000 * (attempt + 1));
      continue;
    }
    const nl = out.lastIndexOf('\n');
    const status = Number(out.slice(nl + 1));
    const text = out.slice(0, nl);
    if (status === 429) {
      if (attempt > 200) throw new Error(`429 forever: ${text}`);
      await sleep(20000);
      continue;
    }
    if ((status >= 500 || status === 0) && attempt < 6) { await sleep(4000 * (attempt + 1)); continue; }
    if (status < 200 || status >= 300) throw new Error(`${method} ${path} -> ${status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : {};
  }
}

async function download(url, file) {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await curl(['-f', '-L', '-o', file, url]);
      return statSync(file).size;
    } catch (err) {
      if (attempt === 4) throw err;
      await sleep(3000);
    }
  }
}

/** Runs one Meshy task step: creates it once (id persisted), then polls until a final status. */
async function runStep(asset, stepName, createPath, getPath, body) {
  const s = (state[asset.id] ??= {});
  const step = (s[stepName] ??= { retries: 0 });
  for (;;) {
    if (!step.taskId) {
      if (dry) { log(asset.id, `DRY create ${stepName} ${JSON.stringify(body).slice(0, 160)}`); return null; }
      const r = await api('POST', createPath, body);
      step.taskId = r.result;
      step.status = 'PENDING';
      save();
      log(asset.id, `${stepName} created ${step.taskId}`);
    }
    let task;
    for (;;) {
      task = await api('GET', `${getPath}/${step.taskId}`);
      if (['SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED'].includes(task.status)) break;
      if (task.status !== step.status) { step.status = task.status; save(); }
      await sleep(POLL_MS);
    }
    step.status = task.status;
    step.credits = task.consumed_credits;
    if (task.status === 'SUCCEEDED') { save(); log(asset.id, `${stepName} SUCCEEDED (${task.consumed_credits ?? '?'} cr)`); return task; }
    step.error = task.task_error?.message ?? task.status;
    log(asset.id, `${stepName} ${task.status}: ${step.error}`);
    if (step.retries >= MAX_RETRIES) { save(); throw new Error(`${stepName} failed: ${step.error}`); }
    step.retries++;
    step.failedIds = [...(step.failedIds ?? []), step.taskId];
    step.taskId = undefined;
    save();
  }
}

async function processAsset(asset) {
  const d = manifest.defaults;
  const dir = resolve(root, 'assets-src/meshy', asset.id);
  const s = (state[asset.id] ??= {});
  const isChar = asset.kind === 'character';

  const preview = await runStep(asset, 'preview', '/v2/text-to-3d', '/v2/text-to-3d', {
    mode: 'preview',
    prompt: asset.prompt,
    model_type: d.model_type,
    ai_model: d.ai_model,
    target_polycount: asset.polycount,
    ...(isChar ? { pose_mode: 'a-pose' } : {}),
    target_formats: ['glb'],
  });
  if (!preview) return;

  const refine = await runStep(asset, 'refine', '/v2/text-to-3d', '/v2/text-to-3d', {
    mode: 'refine',
    preview_task_id: s.preview.taskId,
    enable_pbr: d.enable_pbr,
    texture_resolution: d.texture_resolution,
    target_formats: ['glb'],
  });
  if (!s.files?.model) {
    const bytes = await download(refine.model_urls.glb, resolve(dir, 'model.glb'));
    if (refine.thumbnail_url) await download(refine.thumbnail_url, resolve(dir, 'thumb.png')).catch(() => {});
    s.files = { ...(s.files ?? {}), model: `assets-src/meshy/${asset.id}/model.glb` };
    save();
    log(asset.id, `downloaded model.glb (${(bytes / 1e6).toFixed(1)} MB)`);
  }
  if (!isChar) { s.done = true; save(); return; }

  const rig = await runStep(asset, 'rig', '/v1/rigging', '/v1/rigging', {
    input_task_id: s.refine.taskId,
    height_meters: asset.height,
  });
  if (!s.files.rigged) {
    await download(rig.result.rigged_character_glb_url, resolve(dir, 'rigged.glb'));
    const ba = rig.result.basic_animations;
    if (ba?.walking_glb_url) await download(ba.walking_glb_url, resolve(dir, 'basic_walk.glb')).catch(() => {});
    if (ba?.running_glb_url) await download(ba.running_glb_url, resolve(dir, 'basic_run.glb')).catch(() => {});
    s.files.rigged = `assets-src/meshy/${asset.id}/rigged.glb`;
    save();
    log(asset.id, 'downloaded rigged.glb');
  }

  const actionIds = asset.role === 'guard' ? manifest.guardAnimations : manifest.prisonerAnimations;
  const anim = await runStep(asset, 'anim', '/v1/animations', '/v1/animations', {
    rig_task_id: s.rig.taskId,
    action_ids: actionIds,
  });
  if (!s.files.anim) {
    await download(anim.result.animation_glb_url, resolve(dir, 'anim.glb'));
    s.files.anim = `assets-src/meshy/${asset.id}/anim.glb`;
    s.actionIds = actionIds;
    save();
    log(asset.id, 'downloaded anim.glb');
  }
  s.done = true;
  save();
}

async function main() {
  const bal = await api('GET', '/v1/balance');
  console.log(`balance before: ${bal.balance} credits`);
  const queue = manifest.assets.filter((a) => (!only || only.includes(a.id)) && !state[a.id]?.done);
  // characters first: they have the longest chains (preview -> refine -> rig -> anim)
  queue.sort((a, b) => (b.kind === 'character') - (a.kind === 'character'));
  console.log(`${queue.length} assets to process, concurrency ${concurrency}`);
  const failures = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (next < queue.length) {
      const asset = queue[next++];
      try { await processAsset(asset); }
      catch (err) { failures.push(asset.id); log(asset.id, `ERROR ${err.message}`); }
    }
  }));
  const after = await api('GET', '/v1/balance');
  const spent = Object.values(state).reduce((sum, s) => sum + ['preview', 'refine', 'rig', 'anim'].reduce((t, k) => t + (s[k]?.credits ?? 0), 0), 0);
  console.log(`balance after: ${after.balance} credits (recorded spend across all runs: ${spent})`);
  console.log(failures.length ? `FAILED: ${failures.join(', ')}` : 'all assets done');
}

main().catch((err) => { console.error(err); process.exit(1); });
