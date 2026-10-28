// Post-processing for WebGPURenderer (RenderPipeline), built per quality tier:
//   normal/velocity pre-pass -> GTAO injected into lighting -> beauty pass -> soft bloom ->
//   vignette + fine grain (dithers the dark night gradients) -> TRAA / SMAA.
// Tone mapping (AgX, renderer.toneMappingExposure) + sRGB output are applied once at the end by
// RenderPipeline. Call `render()` each frame instead of `renderer.render()`.
import * as THREE from 'three/webgpu';
import {
  builtinAOContext, float, length, mrt, normalView, packNormalToRGB, pass, rand, sample, screenUV, smoothstep, time,
  uniform, unpackRGBToNormal, vec2, vec4, velocity,
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
  /** HDR bloom. Default true. */
  bloom?: boolean;
  /** bloom strength / radius (0..1) / threshold in scene-linear HDR */
  bloomStrength?: number;
  bloomRadius?: number;
  bloomThreshold?: number;
  /** vignette amount 0..1 (darkening at the corners) */
  vignette?: number;
  /** multiplicative grain amplitude (also dithers 8-bit banding) */
  grain?: number;
}

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

  // Pre-pass: opaque geometry only, writes packed normals (8-bit) + velocity.
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

  // GTAO applied inside the lighting model (indirect light only; direct moonlight stays clean).
  let aoPass: ReturnType<typeof ao> | null = null;
  if (useAO && preDepth && preNormal) {
    aoPass = ao(preDepth, preNormal, camera);
    aoPass.resolutionScale = aoScale;
    aoPass.useTemporalFiltering = aa === 'traa';
    aoPass.radius.value = 0.6;
    aoPass.scale.value = 1.0;
    aoPass.thickness.value = 1.0;
    scenePass.contextNode = builtinAOContext(aoPass.getTextureNode().sample(screenUV).r);
  }

  // Bloom: lamps, lit windows, the moon and searchlight beams glow softly in the fog.
  const sceneColor = scenePass.getTextureNode('output');
  const bloomPass = useBloom
    ? bloom(sceneColor, opts.bloomStrength ?? 0.3, opts.bloomRadius ?? 0.55, opts.bloomThreshold ?? 0.8)
    : null;
  const lit = bloomPass ? sceneColor.add(bloomPass) : sceneColor;

  // Vignette + grain (multiplicative so it scales with brightness; changes every frame).
  const vignetteU = uniform(opts.vignette ?? 0.3);
  const grainU = uniform(opts.grain ?? 0.035);
  const vig = float(1).sub(smoothstep(0.35, 0.95, length(screenUV.sub(vec2(0.5)))).mul(vignetteU));
  const noise = rand(screenUV.add(vec2(time.mul(0.6137).fract(), time.mul(0.3719).fract()))).sub(0.5).mul(grainU).add(1);
  const graded = vec4(lit.rgb.mul(vig.mul(noise)), 1); // keep the canvas opaque

  // Anti-aliasing last (TRAA needs the pre-pass depth + velocity and MSAA off).
  let finalNode: THREE.Node = graded;
  if (aa === 'traa' && preDepth && preVelocity) {
    finalNode = traa(graded, preDepth, preVelocity, camera);
  } else if (aa === 'smaa') {
    finalNode = smaa(graded);
  }

  pipeline.outputNode = finalNode;

  return {
    pipeline,
    aoPass,
    bloomPass,
    vignette: vignetteU,
    grain: grainU,
    render() { pipeline.render(); },
    dispose() { pipeline.dispose(); },
  };
}

export type PostFX = ReturnType<typeof createPostFX>;
