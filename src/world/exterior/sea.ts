// San Francisco Bay around the island: a large plane at y = 0 with three scrolling normal-map
// layers (swell, chop, ripples), dark blue-green water that stays glossy enough for the moon path
// and searchlight glints, and animated foam where the water is shallow (from the height grid).
import * as THREE from 'three/webgpu';
import {
  cameraPosition, cameraViewMatrix, color, distance, float, mix, positionWorld, sin, smoothstep, texture, time, vec2, vec3, vec4,
} from 'three/tsl';
import { detailTexture, seaNormalTexture } from './textures';

export interface ShallowGrid { minX: number; minZ: number; res: number; cols: number; rows: number; heights: Float32Array }

/** R = shallowness (1 at the shoreline / on land, 0 at >= 3.5 m depth). One texel per grid sample. */
function shallowTexture(g: ShallowGrid) {
  const d = new Uint8Array(g.cols * g.rows * 4);
  for (let i = 0; i < g.cols * g.rows; i++) {
    const h = g.heights[i];
    const s = h >= 0 ? 1 : Math.max(0, 1 + h / 3.5);
    d[i * 4] = s * 255; d[i * 4 + 1] = 0; d[i * 4 + 2] = 0; d[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(d, g.cols, g.rows, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function createSea(g: ShallowGrid, center: [number, number], size = 9000): THREE.Mesh {
  const seaN = seaNormalTexture();
  const detail = detailTexture();
  const shallowTex = shallowTexture(g);
  const spanX = (g.cols - 1) * g.res, spanZ = (g.rows - 1) * g.res;

  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 0.08 });
  mat.name = 'sea';
  const wp = positionWorld;
  const t = time;
  const dist = distance(wp.xz, cameraPosition.xz);
  const n1 = texture(seaN, wp.xz.mul(1 / 37).add(vec2(t.mul(0.009), t.mul(0.005)))).xy.mul(2).sub(1);
  const n2 = texture(seaN, wp.xz.mul(1 / 11.3).add(vec2(t.mul(-0.017), t.mul(0.013)))).xy.mul(2).sub(1);
  const n3 = texture(seaN, wp.xz.mul(1 / 3.7).add(vec2(t.mul(0.031), t.mul(-0.024)))).xy.mul(2).sub(1);
  // detail fades with distance (mip-averaged normals would otherwise flatten into a mirror)
  const near = smoothstep(70, 6, dist);
  const fade = smoothstep(1400, 60, dist).mul(0.7).add(0.3);
  const slope = n1.mul(0.6).add(n2.mul(0.38)).add(n3.mul(near.mul(0.3))).mul(fade).mul(0.55);
  const nWorld = vec3(slope.x, 1, slope.y).normalize();
  mat.normalNode = cameraViewMatrix.mul(vec4(nWorld, 0)).xyz.normalize();

  const sUv = wp.xz.sub(vec2(g.minX, g.minZ)).div(vec2(spanX, spanZ));
  const shallow = texture(shallowTex, sUv).r;
  const fn = texture(detail, wp.xz.mul(1 / 5.3).add(vec2(t.mul(0.013), t.mul(-0.009)))).b;
  const fn2 = texture(detail, wp.xz.mul(1 / 17).add(vec2(t.mul(-0.006), t.mul(0.004)))).g;
  // surf: lines of foam rolling toward the shore, broken up by noise
  const surf = sin(t.mul(0.9).sub(shallow.mul(15)).add(fn2.mul(5))).mul(0.5).add(0.5);
  const foam = smoothstep(0.62, 0.95, shallow).mul(smoothstep(0.35, 0.75, fn.mul(0.7).add(surf.mul(0.5))))
    .add(smoothstep(0.93, 1.0, shallow).mul(0.6))
    .clamp(0, 1)
    .mul(smoothstep(500, 120, dist));

  const deep = color(0x061215), shallowCol = color(0x0f2726);
  const water = mix(deep, shallowCol, shallow.mul(0.8));
  mat.colorNode = mix(water, color(0x8c948f), foam);
  mat.roughnessNode = mix(float(0.05).add(dist.mul(0.00012)).min(0.28), float(0.75), foam);

  const geo = new THREE.PlaneGeometry(size, size, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sea';
  mesh.position.set(center[0], 0, center[1]);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
