import * as THREE from 'three/webgpu';
import type { Assets } from './assets';

export interface EnvironmentOptions {
  /** URL of a 2k equirect HDRI, e.g. '/env/sky_2k.hdr'. Omit (or 404) to use a procedural sky. */
  hdr?: string;
  /** Rotate the HDRI so its sun lines up with `sunDirection`. Radians around Y. */
  hdrRotationY?: number;
  /** Direction *from* the scene *to* the sun (normalized inside). */
  sunDirection?: THREE.Vector3;
  sunIntensity?: number;
  /** Shadow map resolution: 4096 high, 2048 medium, 1024 phones. */
  shadowMapSize?: number;
  /** Half-size (meters) of the shadowed square around the follow target. Keep tight. */
  shadowExtent?: number;
}

/**
 * Image-based lighting + one shadow-casting sun. The environment map is the fill light; do not
 * add ambient/hemisphere lights on top or the scene goes flat.
 *
 * Lighting source, in order of preference: the HDRI at `opts.hdr`; otherwise a procedural
 * SkyMesh aligned with the sun, baked to a PMREM (fine for prototypes and time-of-day systems,
 * but a real HDRI looks better - see references/rendering-pipeline.md).
 */
export async function setupEnvironment(renderer: THREE.WebGPURenderer, scene: THREE.Scene, assets: Assets, opts: EnvironmentOptions = {}) {
  const sunDir = (opts.sunDirection ?? new THREE.Vector3(0.6, 1.0, 0.4)).clone().normalize();
  const extent = opts.shadowExtent ?? 40;
  const mapSize = opts.shadowMapSize ?? 2048;
  const disposables: { dispose(): void }[] = [];

  let envTexture: THREE.Texture | null = null;
  if (opts.hdr) {
    try {
      envTexture = await assets.hdr(opts.hdr);
    } catch (err) {
      console.warn(`[env] could not load ${opts.hdr}; falling back to a procedural sky`, err);
    }
  }

  if (envTexture) {
    scene.environment = envTexture;
    scene.environmentRotation.set(0, opts.hdrRotationY ?? 0, 0);
    scene.background = envTexture;
    scene.backgroundBlurriness = 0.05;
    scene.backgroundRotation.copy(scene.environmentRotation);
    disposables.push(envTexture);
  } else {
    const { SkyMesh } = await import('three/addons/objects/SkyMesh.js');
    const sky = new SkyMesh();
    sky.scale.setScalar(10000);
    sky.turbidity.value = 8;
    sky.rayleigh.value = 2;
    sky.mieCoefficient.value = 0.005;
    sky.mieDirectionalG.value = 0.8;
    sky.sunPosition.value.copy(sunDir);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky);
    const envRT = pmrem.fromScene(envScene);
    scene.environment = envRT.texture;
    scene.add(sky); // fromScene re-parented it into envScene; put it back as the visible sky
    disposables.push(envRT, pmrem);
  }
  scene.environmentIntensity = 1.0;

  const sun = new THREE.DirectionalLight(0xfff2e5, opts.sunIntensity ?? 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(mapSize, mapSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = extent * 4;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.bias = 0;            // WebGPU shadows need little bias; add -0.0002 only if acne appears
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 1.5;
  sun.shadow.intensity = 0.85;    // sky bounce keeps real shadows from being black
  scene.add(sun, sun.target);
  disposables.push(sun);

  const texel = (extent * 2) / mapSize;
  const _snapped = new THREE.Vector3();

  return {
    sun,
    sunDir,
    /** Keep the tight shadow frustum centered on the player; snap to texels to avoid shimmer. */
    follow(position: THREE.Vector3) {
      _snapped.set(
        Math.round(position.x / texel) * texel,
        Math.round(position.y / texel) * texel,
        Math.round(position.z / texel) * texel,
      );
      sun.target.position.copy(_snapped);
      sun.position.copy(_snapped).addScaledVector(sunDir, extent * 2);
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

export type Environment = Awaited<ReturnType<typeof setupEnvironment>>;
