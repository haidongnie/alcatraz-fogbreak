// Night environment: a procedural sky dome (deep blue-black gradient, stars, hazy moon, thin moonlit
// cloud, sodium glow of the city on the horizon) whose horizon colour is the fog colour, a dim PMREM
// environment baked from that sky (the only fill light), and the moon DirectionalLight - the single
// shadow caster - with a tight, texel-snapped shadow frustum that follows a target.
import * as THREE from 'three/webgpu';
import {
  cameraPosition, color, dot, exp, float, floor, fract, length, max, mix, normalize, positionWorld, pow,
  saturate, sin, smoothstep, step, texture, time, uniform, vec2, vec3,
} from 'three/tsl';
import { detailTexture } from '../world/exterior/textures';

export interface NightSkyOptions {
  /** direction from the scene toward the moon (normalised inside) */
  moonDir: THREE.Vector3;
  /** horizontal (x, z) direction toward the city glow */
  cityDir: [number, number];
  /** radius of the visible dome; keep it inside the camera far plane */
  radius: number;
}

export interface NightSky {
  mesh: THREE.Mesh;
  /** horizon / fog colour the gradient blends into (copy the fog colour in here each frame) */
  horizon: THREE.Color;
  /** 0..1 star visibility (fog hides them) */
  stars: { value: number };
  /** 0..1 thin cloud cover */
  clouds: { value: number };
  /** city glow strength multiplier */
  glow: { value: number };
  material: THREE.MeshBasicNodeMaterial;
  /** keep the dome centred on the camera */
  follow(camera: THREE.Camera): void;
  /** bake a PMREM environment of the sky (no geometry) */
  bakeEnvironment(renderer: THREE.WebGPURenderer): THREE.Texture;
  dispose(): void;
}

export function createNightSky(opts: NightSkyOptions): NightSky {
  const horizonU = uniform(new THREE.Color(0x0b0e13));
  const starsU = uniform(1.0);
  const cloudsU = uniform(0.5);
  const glowU = uniform(1.0);
  const moonDir = opts.moonDir.clone().normalize();
  const moonU = uniform(moonDir);
  const cityU = uniform(new THREE.Vector2(opts.cityDir[0], opts.cityDir[1]).normalize());
  const detail = detailTexture();

  const dir = normalize(positionWorld.sub(cameraPosition));
  const el = dir.y;
  const up = saturate(el);

  // gradient: fog-coloured horizon -> deep navy -> blue-black zenith
  const zenith = color(0x010205);
  const mid = color(0x050a14);
  let sky = mix(horizonU, mid, smoothstep(0.0, 0.22, up));
  sky = mix(sky, zenith, smoothstep(0.15, 0.95, up));

  // sodium / incandescent glow of San Francisco and the East Bay low on the horizon
  const flat = normalize(vec2(dir.x, dir.z).add(vec2(1e-5, 0)));
  const az = dot(flat, cityU);
  const glowMask = smoothstep(0.1, 1.0, az).mul(exp(up.mul(-11))).mul(glowU).mul(saturate(el.add(0.05).mul(12)));
  sky = sky.add(vec3(0.034, 0.019, 0.008).mul(glowMask));

  // moon: disc (~0.55 deg radius, enlarged for readability) with mare mottling, haze halo
  const md = dot(dir, moonU);
  const disc = smoothstep(0.999958, 0.999966, md);
  const mottle = texture(detail, vec2(dir.x.sub(moonU.x), dir.y.sub(moonU.y)).mul(55).add(0.5)).r;
  const moonCol = vec3(1.0, 0.96, 0.88).mul(disc.mul(mottle.mul(0.35).add(0.75))).mul(9.0);
  const halo = pow(saturate(md), 16).mul(0.045).add(pow(saturate(md), 600).mul(0.5)).add(pow(saturate(md), 5).mul(0.012));
  const haloCol = vec3(0.62, 0.7, 0.85).mul(halo);

  // stars: one candidate per angular cell, ~1.5 % of cells lit, gentle twinkle
  const sd = dir.mul(240).add(241);
  const cell = floor(sd);
  const h0 = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
  const h1 = fract(sin(dot(cell, vec3(39.3468, 11.135, 83.155))).mul(24634.6345));
  const h2 = fract(sin(dot(cell, vec3(73.156, 52.235, 9.151))).mul(56445.2345));
  const h3 = fract(h0.mul(91.7).add(h1.mul(13.1)));
  const jitter = vec3(h1, h2, h3).mul(0.6).add(0.2);
  const dStar = length(fract(sd).sub(jitter));
  const twinkle = sin(time.mul(h1.mul(3).add(1.5)).add(h2.mul(40))).mul(0.25).add(0.75);
  const starI = smoothstep(0.3, 0.0, dStar).mul(step(0.985, h0)).mul(pow(h3, 3).mul(2.2).add(0.25)).mul(twinkle);
  const starCol = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.9, 0.75), h2);
  const stars = starCol.mul(starI).mul(starsU).mul(smoothstep(0.03, 0.3, el));

  // thin cloud / high fog wisps, lit from the moon side
  const cuv = vec2(dir.x, dir.z).div(max(el, 0.0).add(0.18)).mul(0.11).add(vec2(time.mul(0.0012), time.mul(0.0007)));
  const cl = texture(detail, cuv).r.mul(0.7).add(texture(detail, cuv.mul(3.1)).g.mul(0.3));
  const cloud = smoothstep(0.5, 0.78, cl).mul(cloudsU).mul(smoothstep(0.0, 0.25, el));
  const cloudLit = horizonU.mul(1.25).add(vec3(0.05, 0.055, 0.065).mul(pow(saturate(md), 6)));
  sky = mix(sky, cloudLit, cloud.mul(0.7));

  const clear = float(1).sub(cloud.mul(0.85));
  const finalCol = sky.add(stars.mul(clear)).add(moonCol.mul(float(1).sub(cloud.mul(0.6)))).add(haloCol);

  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false });
  material.name = 'night-sky';
  material.colorNode = finalCol;

  const geo = new THREE.SphereGeometry(1, 64, 32);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'sky';
  mesh.scale.setScalar(opts.radius);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  let envRT: THREE.RenderTarget | null = null;
  let pmrem: THREE.PMREMGenerator | null = null;

  return {
    mesh,
    horizon: horizonU.value,
    stars: starsU,
    clouds: cloudsU,
    glow: glowU,
    material,
    follow(camera) {
      mesh.position.copy(camera.position);
      mesh.updateMatrix();
    },
    bakeEnvironment(renderer) {
      pmrem ??= new THREE.PMREMGenerator(renderer);
      const envScene = new THREE.Scene();
      const envSky = new THREE.Mesh(geo, material);
      envSky.scale.setScalar(50);
      envSky.frustumCulled = false;
      envScene.add(envSky);
      const prev = starsU.value;
      starsU.value = 0; // no point lights in reflections
      envRT?.dispose();
      envRT = pmrem.fromScene(envScene, 0.02, 0.1, 100);
      starsU.value = prev;
      return envRT.texture;
    },
    dispose() {
      envRT?.dispose();
      pmrem?.dispose();
      geo.dispose();
      material.dispose();
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Moon light
// ------------------------------------------------------------------------------------------------
export interface MoonLight {
  light: THREE.DirectionalLight;
  /** direction from the scene toward the moon */
  dir: THREE.Vector3;
  /** centre the shadow frustum (half-size `extent` m) on `target`, snapped to shadow texels */
  follow(target: THREE.Vector3, extent: number): void;
}

export function createMoonLight(scene: THREE.Scene, dir: THREE.Vector3, opts: { color: number; intensity: number; mapSize: number }): MoonLight {
  const d = dir.clone().normalize();
  const light = new THREE.DirectionalLight(opts.color, opts.intensity);
  light.name = 'moon';
  light.castShadow = true;
  light.shadow.mapSize.set(opts.mapSize, opts.mapSize);
  light.shadow.bias = 0;
  light.shadow.normalBias = 0.05;
  light.shadow.radius = 2;
  light.shadow.intensity = 0.82; // moonlit shadows still get sky fill, never pure black
  light.shadow.camera.near = 1;
  scene.add(light, light.target);

  // shadow camera basis (same as Object3D.lookAt from the light toward its target)
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), d).normalize();
  const up = new THREE.Vector3().crossVectors(d, right).normalize();
  const snapped = new THREE.Vector3();
  let lastExtent = -1;
  const cam = light.shadow.camera;

  return {
    light,
    dir: d,
    follow(target, extent) {
      const size = opts.mapSize;
      if (Math.abs(extent - lastExtent) > 1e-3) {
        lastExtent = extent;
        cam.left = -extent; cam.right = extent; cam.top = extent; cam.bottom = -extent;
        cam.far = extent * 4 + 260;
        cam.updateProjectionMatrix();
        const texel = (2 * extent) / size;
        light.shadow.normalBias = Math.max(0.03, texel * 1.2);
      }
      const texel = (2 * extent) / size;
      const a = Math.round(target.dot(right) / texel) * texel;
      const b = Math.round(target.dot(up) / texel) * texel;
      const c = target.dot(d);
      snapped.copy(right).multiplyScalar(a).addScaledVector(up, b).addScaledVector(d, c);
      light.target.position.copy(snapped);
      light.position.copy(snapped).addScaledVector(d, extent * 2 + 130);
      light.target.updateMatrixWorld();
      light.updateMatrixWorld();
    },
  };
}
