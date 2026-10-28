import * as THREE from 'three/webgpu';

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  /** 2 on desktop, 1.5 on laptops, 1 on phones. Resolution is the biggest GPU cost multiplier. */
  maxPixelRatio?: number;
  /** Force the WebGL 2 backend (to test the fallback path). */
  forceWebGL?: boolean;
}

/**
 * Creates the renderer with a correct realistic color pipeline:
 * linear lighting -> AgX tone mapping -> sRGB output, soft PCF shadows, MSAA off (TRAA does AA).
 */
export async function createRenderer({ canvas, maxPixelRatio = 2, forceWebGL = false }: RendererOptions) {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
  renderer.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight, false);

  renderer.toneMapping = THREE.AgXToneMapping;   // NeutralToneMapping for color-accurate product looks
  renderer.toneMappingExposure = 1.0;
  // renderer.outputColorSpace stays THREE.SRGBColorSpace (default)

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;  // PCFSoftShadowMap was removed from WebGPURenderer (r186)

  await renderer.init();                         // surfaces backend errors now, not in the first frame

  const backend = renderer.backend as { isWebGPUBackend?: boolean };
  console.info(`[renderer] backend: ${backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2 fallback'}`);
  return renderer;
}

export type Renderer = Awaited<ReturnType<typeof createRenderer>>;
