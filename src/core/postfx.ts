import * as THREE from 'three/webgpu';
import {
  pass, mrt, normalView, velocity, screenUV, sample,
  packNormalToRGB, unpackRGBToNormal, builtinAOContext,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

export interface PostFXOptions {
  /** Screen-space ambient occlusion (GTAO). Default true. */
  ao?: boolean;
  /** AO resolution scale; 0.5 (half res) is enough for most scenes. */
  aoScale?: number;
  /** 'traa' (temporal, best quality, needs velocity), 'smaa' (cheap, no ghosting), or 'none'. */
  aa?: 'traa' | 'smaa' | 'none';
  /** Subtle HDR bloom. Default true. */
  bloom?: boolean;
}

/**
 * Realistic default stack for WebGPURenderer:
 *   normal/velocity pre-pass -> GTAO injected into lighting -> beauty pass -> (+bloom) -> TRAA/SMAA.
 * Tone mapping + sRGB output are applied once by RenderPipeline at the end.
 * Call `render()` each frame instead of `renderer.render()`.
 */
export function createPostFX(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  opts: PostFXOptions = {},
) {
  const useAO = opts.ao ?? true;
  const aoScale = opts.aoScale ?? 0.5;
  const aa = opts.aa ?? 'traa';
  const useBloom = opts.bloom ?? true;

  const pipeline = new THREE.RenderPipeline(renderer);
  const needsPrePass = useAO || aa === 'traa';

  // Pre-pass: opaque geometry only, writes packed normals (8-bit) + velocity. Cheap compared to the beauty pass.
  let preDepth: THREE.TextureNode | null = null;
  let preVelocity: THREE.TextureNode | null = null;
  let preNormal: THREE.Node | null = null;
  if (needsPrePass) {
    const prePass = pass(scene, camera);
    prePass.name = 'Pre-Pass';
    prePass.transparent = false;
    prePass.setMRT(mrt({ output: packNormalToRGB(normalView), velocity }));
    prePass.getTexture('output').type = THREE.UnsignedByteType;
    preDepth = prePass.getTextureNode('depth');
    preVelocity = prePass.getTextureNode('velocity');
    preNormal = sample((uv) => unpackRGBToNormal(prePass.getTextureNode('output').sample(uv)));
  }

  // Beauty pass.
  const scenePass = pass(scene, camera);
  scenePass.name = 'Scene';

  // GTAO applied inside the lighting model (affects indirect light only; direct sun stays clean).
  let aoPass: ReturnType<typeof ao> | null = null;
  if (useAO && preDepth && preNormal) {
    aoPass = ao(preDepth, preNormal, camera);
    aoPass.resolutionScale = aoScale;
    aoPass.useTemporalFiltering = aa === 'traa';
    aoPass.radius.value = 0.5;
    aoPass.scale.value = 1.0;
    aoPass.thickness.value = 1.0;
    scenePass.contextNode = builtinAOContext(aoPass.getTextureNode().sample(screenUV).r);
  }

  // Bloom: only HDR values brighter than the threshold (~1 = white) glow. Keep strength low for realism.
  const sceneColor = scenePass.getTextureNode('output');
  const bloomPass = useBloom ? bloom(sceneColor, 0.25, 0.35, 1.0) : null;
  const lit = bloomPass ? sceneColor.add(bloomPass) : sceneColor;

  // Anti-aliasing last. TRAA/SMAA helpers accept any node (they render it to a texture internally);
  // TRAA needs the pre-pass depth + velocity and MSAA off.
  let finalNode: THREE.Node = lit;
  if (aa === 'traa' && preDepth && preVelocity) {
    finalNode = traa(lit, preDepth, preVelocity, camera);
  } else if (aa === 'smaa') {
    finalNode = smaa(lit);
  }

  pipeline.outputNode = finalNode;

  return {
    pipeline,
    aoPass,
    bloomPass,
    render() { pipeline.render(); },
    dispose() { pipeline.dispose(); },
  };
}

export type PostFX = ReturnType<typeof createPostFX>;
