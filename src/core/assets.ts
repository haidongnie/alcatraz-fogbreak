import * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { asset } from '../config';

/**
 * One place that knows how to load everything. Every decoder is wired so any glTF
 * (Draco, meshopt, KTX2 textures, GPU instancing) works without touching this file again.
 * Requires `public/draco/` and `public/basis/` copied from node_modules/three/examples/jsm/libs/.
 */
export class Assets {
  readonly manager = new THREE.LoadingManager();
  private readonly gltf: GLTFLoader;
  private readonly ktx2: KTX2Loader;
  private readonly models = new Map<string, Promise<GLTF>>();

  /** Construct after `await renderer.init()` so KTX2 can detect GPU texture support. */
  constructor(renderer: THREE.WebGPURenderer) {
    const draco = new DRACOLoader(this.manager).setDecoderPath(asset('draco/'));
    this.ktx2 = new KTX2Loader(this.manager).setTranscoderPath(asset('basis/')).detectSupport(renderer);
    this.gltf = new GLTFLoader(this.manager)
      .setDRACOLoader(draco)
      .setKTX2Loader(this.ktx2)
      .setMeshoptDecoder(MeshoptDecoder);
  }

  /** Cached per URL. Clone `gltf.scene` (SkeletonUtils.clone for skinned meshes) to instantiate. */
  model(url: string): Promise<GLTF> {
    const cached = this.models.get(url);
    if (cached) return cached;
    const p = this.gltf.loadAsync(url);
    this.models.set(url, p);
    return p;
  }

  /** Equirectangular HDR for scene.environment / scene.background. */
  async hdr(url: string): Promise<THREE.Texture> {
    const tex = await new HDRLoader(this.manager).loadAsync(url);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    return tex;
  }

  /** Plain image texture. Tag color maps as sRGB; leave data maps (normal/roughness/metal/ao) linear. */
  async texture(url: string, opts: { srgb?: boolean; repeat?: number } = {}): Promise<THREE.Texture> {
    const tex = await new THREE.TextureLoader(this.manager).loadAsync(url);
    tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.setScalar(opts.repeat ?? 1);
    tex.anisotropy = 8;
    return tex;
  }

  dispose() {
    this.ktx2.dispose();
    this.models.clear();
  }
}
