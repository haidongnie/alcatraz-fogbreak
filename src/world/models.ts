// Model library built from public/models/manifest.json (Meshy assets, meshopt + WebP).
//
// - Static models (props / landmarks): real-world scale and a bottom-centre pivot are baked into
//   the files by scripts/meshy/optimize.mjs. `instance()` clones share geometry + materials;
//   `instanced()` turns every sub-mesh into one InstancedMesh (one draw call per sub-mesh).
// - Characters (prisoner_a..d, guard): one skinned mesh on a 24-joint Meshy rig ("Armature"
//   scaled 0.01, joints in centimetres, files face +Z). `character()` clones with SkeletonUtils,
//   scales to the manifest height measured from the skinned rest-pose bounds, and hands out clips
//   that play in place: the hips' horizontal root motion is stripped once per character at load
//   (crouch / swim / knockdown / work move the hips forward in the source files), and the
//   vertical rise of `climb` is detrended so the loop does not jump back down every cycle.
//   Two long one-shots are trimmed to the part the game uses: `pickup` (bend, grab, stand up) and
//   `work` (the kneeling segment, played ping-pong by Avatar).
import * as THREE from 'three/webgpu';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { asset } from '../config';
import type { Assets } from '../core/assets';
import type { CharacterInstance, ModelsApi } from '../game/context';

interface ManifestEntry {
  url: string;
  kind: string;
  role?: string;
  /** characters: real standing height (m) */
  height?: number;
  /** static models: baked real-world size (m) */
  size?: [number, number, number];
  animations?: string[];
  bytes?: number;
}
interface Manifest { models: Record<string, ManifestEntry> }

interface StaticSource {
  scene: THREE.Object3D;
  /** every mesh with its transform relative to the model root (for instancing) */
  parts: { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; matrix: THREE.Matrix4 }[];
}

interface CharacterSource {
  scene: THREE.Object3D;
  clips: Map<string, THREE.AnimationClip>;
  /** uniform scale that brings the rest pose to the manifest height */
  scale: number;
  /** y offset that puts the lowest rest-pose vertex on y = 0 (after scaling) */
  lift: number;
  height: number;
}

/** Bone names tried in order (Meshy rig first, then Mixamo-style), regex as a last resort. */
const HAND_BONES = ['RightHand', 'mixamorigRightHand', 'hand_r', 'Hand_R'];
const BACK_BONES = ['Spine02', 'Spine2', 'mixamorigSpine2', 'Spine01', 'Spine1', 'Spine'];
const HEAD_BONES = ['Head', 'mixamorigHead', 'head'];
const HIPS_BONES = ['Hips', 'mixamorigHips', 'hips', 'pelvis', 'Pelvis'];

/** Clips whose vertical root motion is removed too (the player moves itself along the climb). */
const DETREND_Y = new Set(['climb']);
/** [start, end] seconds kept from long source clips (measured on the Meshy animation library). */
const TRIMS: Record<string, [number, number]> = {
  pickup: [0.55, 2.75], // reach down (hand lowest at ~1.5 s) and straighten up
  work: [0.0, 1.45],    // kneeling, hands busy at knee height (the clip stands up after 1.5 s)
};

const PLACEHOLDER_COLOR = 0x7b7f86;

export class Models implements ModelsApi {
  private readonly manifest: Record<string, ManifestEntry>;
  private readonly statics = new Map<string, StaticSource>();
  private readonly characters = new Map<string, CharacterSource>();
  private placeholderMat: THREE.MeshStandardMaterial | null = null;
  private readonly placeholderGeo = new Map<string, THREE.BufferGeometry>();

  private constructor(manifest: Record<string, ManifestEntry>) {
    this.manifest = manifest;
  }

  /** Fetches the manifest and every GLB in it. Missing/broken files become placeholders. */
  static async load(assets: Assets, onProgress?: (fraction: number) => void): Promise<Models> {
    let manifest: Record<string, ManifestEntry> = {};
    try {
      const res = await fetch(asset('models/manifest.json'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = ((await res.json()) as Manifest).models ?? {};
    } catch (err) {
      console.warn('[models] manifest unavailable, using placeholders', err);
    }
    const models = new Models(manifest);
    const entries = Object.entries(manifest);
    const total = entries.reduce((s, [, e]) => s + (e.bytes ?? 200_000), 0) || 1;
    let done = 0;
    onProgress?.(0.02);
    await Promise.all(entries.map(async ([id, entry]) => {
      try {
        const gltf = await assets.model(asset(entry.url));
        if (entry.kind === 'character') models.addCharacter(id, entry, gltf.scene, gltf.animations);
        else models.addStatic(id, gltf.scene);
      } catch (err) {
        console.warn(`[models] failed to load ${id}`, err);
      }
      done += entry.bytes ?? 200_000;
      onProgress?.(0.02 + 0.98 * (done / total));
    }));
    onProgress?.(1);
    return models;
  }

  // ----------------------------------------------------------------------------------------------
  // ModelsApi
  // ----------------------------------------------------------------------------------------------
  has(id: string) { return this.statics.has(id) || this.characters.has(id); }

  size(id: string): [number, number, number] | null {
    const e = this.manifest[id];
    if (e?.size) return [e.size[0], e.size[1], e.size[2]];
    if (e?.kind === 'character' && e.height) return [0.6, e.height, 0.35];
    return null;
  }

  instance(id: string): THREE.Object3D {
    const s = this.statics.get(id);
    if (s) return s.scene.clone(true);
    const c = this.characters.get(id);
    if (c) {
      // a posed-at-rest character used as a prop (no mixer)
      const root = new THREE.Group();
      const model = SkeletonUtils.clone(c.scene);
      model.scale.setScalar(c.scale);
      model.position.y = c.lift;
      root.add(model);
      return root;
    }
    return this.placeholder(id);
  }

  instanced(id: string, matrices: THREE.Matrix4[], opts: { castShadow?: boolean; receiveShadow?: boolean } = {}): THREE.Object3D {
    const group = new THREE.Group();
    group.name = `instanced:${id}`;
    if (matrices.length === 0) return group;
    const castShadow = opts.castShadow ?? true;
    const receiveShadow = opts.receiveShadow ?? true;
    const src = this.statics.get(id);
    const parts = src ? src.parts : [{ geometry: this.placeholderGeometry(id), material: this.placeholderMaterial(), matrix: new THREE.Matrix4() }];
    const m = new THREE.Matrix4();
    for (const part of parts) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, matrices.length);
      for (let i = 0; i < matrices.length; i++) {
        m.multiplyMatrices(matrices[i], part.matrix);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      mesh.computeBoundingSphere(); // instance-aware bounds, so frustum culling stays correct
      group.add(mesh);
    }
    return group;
  }

  character(id: string): CharacterInstance {
    const src = this.characters.get(id);
    const root = new THREE.Group();
    root.name = `character:${id}`;
    if (!src) return this.placeholderCharacter(id, root);

    const model = SkeletonUtils.clone(src.scene);
    model.scale.setScalar(src.scale);
    model.position.y = src.lift;
    root.add(model);
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // skinned geometry bounds are the bind pose: never cull, the animated pose leaves them
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) mesh.frustumCulled = false;
    });
    return {
      root,
      mixer: new THREE.AnimationMixer(model),
      clips: src.clips,
      hand: findBone(model, HAND_BONES, /right.?hand|hand.?r$/i),
      back: findBone(model, BACK_BONES, /spine/i),
      head: findBone(model, HEAD_BONES, /^head$/i),
      height: src.height,
    };
  }

  // ----------------------------------------------------------------------------------------------
  // Loading
  // ----------------------------------------------------------------------------------------------
  private addStatic(id: string, scene: THREE.Object3D) {
    scene.updateMatrixWorld(true);
    const parts: StaticSource['parts'] = [];
    const rootInv = new THREE.Matrix4().copy(scene.matrixWorld).invert();
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const std = mat as THREE.MeshStandardMaterial;
        if (std.map) std.map.anisotropy = 4;
      }
      parts.push({ geometry: mesh.geometry, material: mesh.material, matrix: new THREE.Matrix4().multiplyMatrices(rootInv, mesh.matrixWorld) });
    });
    this.statics.set(id, { scene, parts });
  }

  private addCharacter(id: string, entry: ManifestEntry, scene: THREE.Object3D, animations: THREE.AnimationClip[]) {
    scene.updateMatrixWorld(true);

    // Real height from the skinned rest pose (the files are in centimetres under a 0.01 armature).
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    scene.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh) return;
      const pos = sm.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        sm.getVertexPosition(i, v);
        box.expandByPoint(v.applyMatrix4(sm.matrixWorld));
      }
    });
    if (box.isEmpty()) box.setFromObject(scene);
    const measured = Math.max(0.1, box.max.y - box.min.y);
    const height = entry.height ?? measured;
    const scale = height / measured;
    const lift = -box.min.y * scale;

    // Clips: in-place root motion + trims. Clones, so the cached GLTF stays pristine.
    const hips = findBone(scene, HIPS_BONES, /hips|pelvis/i);
    const clips = new Map<string, THREE.AnimationClip>();
    for (const source of animations) {
      let clip = source.clone();
      if (hips) stripRootMotion(clip, hips, DETREND_Y.has(clip.name));
      const trim = TRIMS[clip.name];
      if (trim) clip = trimClip(clip, trim[0], Math.min(trim[1], clip.duration));
      clips.set(clip.name, clip);
    }
    this.characters.set(id, { scene, clips, scale, lift, height });
  }

  // ----------------------------------------------------------------------------------------------
  // Placeholders
  // ----------------------------------------------------------------------------------------------
  private placeholderMaterial() {
    return (this.placeholderMat ??= new THREE.MeshStandardMaterial({ color: PLACEHOLDER_COLOR, roughness: 0.85, metalness: 0 }));
  }

  /** Box of the manifest size (or 0.5 m) resting on y = 0. */
  private placeholderGeometry(id: string): THREE.BufferGeometry {
    const s = this.size(id) ?? [0.5, 0.5, 0.5];
    const key = s.join('x');
    let geo = this.placeholderGeo.get(key);
    if (!geo) {
      geo = new THREE.BoxGeometry(s[0], s[1], s[2]).translate(0, s[1] / 2, 0);
      this.placeholderGeo.set(key, geo);
    }
    return geo;
  }

  private placeholder(id: string): THREE.Object3D {
    const mesh = new THREE.Mesh(this.placeholderGeometry(id), this.placeholderMaterial());
    mesh.name = `placeholder:${id}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private placeholderCharacter(id: string, root: THREE.Group): CharacterInstance {
    const height = this.manifest[id]?.height ?? 1.78;
    const r = 0.26;
    const key = `capsule:${height}`;
    let geo = this.placeholderGeo.get(key);
    if (!geo) {
      geo = new THREE.CapsuleGeometry(r, height - 2 * r, 4, 12).translate(0, height / 2, 0);
      this.placeholderGeo.set(key, geo);
    }
    const body = new THREE.Mesh(geo, this.placeholderMaterial());
    body.castShadow = true;
    root.add(body);
    return { root, mixer: new THREE.AnimationMixer(root), clips: new Map(), hand: null, back: null, head: null, height };
  }
}

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------
function findBone(root: THREE.Object3D, names: string[], fallback: RegExp): THREE.Object3D | null {
  for (const n of names) {
    const o = root.getObjectByName(n);
    if (o) return o;
  }
  let found: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.Bone).isBone && fallback.test(o.name)) found = o;
  });
  return found;
}

/**
 * Hips X/Z become the rest-pose value for every key so the clip plays in place (the capsule does
 * the moving). With `detrendY`, the linear rise between the first and last key is removed too,
 * keeping the up/down bob inside the cycle.
 */
function stripRootMotion(clip: THREE.AnimationClip, hips: THREE.Object3D, detrendY: boolean) {
  const name = `${hips.name}.position`;
  const track = clip.tracks.find((t) => t.name === name);
  if (!track) return;
  const values = track.values; // clone() already copied the arrays
  const times = track.times;
  const n = times.length;
  const rest = hips.position;
  for (let i = 0; i < n; i++) {
    values[i * 3] = rest.x;
    values[i * 3 + 2] = rest.z;
  }
  if (detrendY && n > 1) {
    const t0 = times[0];
    const span = times[n - 1] - t0 || 1;
    const rise = values[(n - 1) * 3 + 1] - values[1];
    for (let i = 0; i < n; i++) values[i * 3 + 1] -= rise * ((times[i] - t0) / span);
  }
}

/**
 * Keeps [start, end] of a clip, shifted to begin at 0. Every track gets exact keys at both ends
 * (sampled with its own interpolant), so bones that only had keys outside the range keep their
 * pose instead of being dropped from the clip.
 */
function trimClip(clip: THREE.AnimationClip, start: number, end: number): THREE.AnimationClip {
  if (end - start <= 0.05) return clip;
  const tracks: THREE.KeyframeTrack[] = [];
  for (const track of clip.tracks) {
    // `createInterpolant` is not in the typings; GLTFLoader tags its cubic-spline factory.
    const withFactory = track as unknown as { createInterpolant: (() => THREE.Interpolant) & { isInterpolantFactoryMethodGLTFCubicSpline?: boolean } };
    if (withFactory.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline) return clip; // tangents: leave as authored
    const size = track.getValueSize();
    const interp = withFactory.createInterpolant();
    const times: number[] = [];
    const values: number[] = [];
    const push = (t: number, v: ArrayLike<number>) => {
      times.push(t - start);
      for (let k = 0; k < size; k++) values.push(v[k]);
    };
    push(start, interp.evaluate(start));
    for (let i = 0; i < track.times.length; i++) {
      const t = track.times[i];
      if (t > start + 1e-4 && t < end - 1e-4) push(t, track.values.subarray(i * size, i * size + size));
    }
    push(end, interp.evaluate(end));
    const Ctor = track.constructor as new (name: string, times: number[], values: number[], interpolation?: THREE.InterpolationModes) => THREE.KeyframeTrack;
    tracks.push(new Ctor(track.name, times, values, track.getInterpolation()));
  }
  return new THREE.AnimationClip(clip.name, end - start, tracks);
}
