// Terrain node material: wet dark rock on cliffs, guano-streaked pale rock near the waterline,
// scrubby dry grass / ice plant on gentle ground above ~8 m, worn concrete and asphalt pads round
// buildings (from a world-space "pad" mask painted from island.json), dark wet rock at the tide line.
import * as THREE from 'three/webgpu';
import {
  cameraViewMatrix, color, float, mix, normalWorldGeometry, positionWorld, saturate, smoothstep, texture, vec2, vec3, vec4,
} from 'three/tsl';
import { SERVICE_YARD } from '../layout';
import type { IslandData, P2 } from './data';
import { detailTexture, rockNormalTexture } from './textures';

export interface PadBounds { x0: number; z0: number; w: number; d: number }

/** Paints the pad mask: R = pavement, G = worn paths / dirt, B = garden (lusher vegetation). */
export function buildPadMask(data: IslandData, b: PadBounds): THREE.CanvasTexture {
  const W = 1024, H = Math.round((1024 * b.d) / b.w);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  // world (x, z) -> pixel; canvas row 0 = z0 (DataTexture/CanvasTexture flipY handled below)
  g.setTransform(W / b.w, 0, 0, H / b.d, (-b.x0 * W) / b.w, (-b.z0 * H) / b.d);
  g.globalCompositeOperation = 'lighter';
  const poly = (pts: P2[]) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); };
  const line = (pts: P2[]) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); };
  g.lineJoin = 'round';
  g.lineCap = 'round';

  // building aprons: worn concrete round every footprint (soft double stroke)
  for (const bd of data.buildings) {
    poly(bd.poly);
    g.strokeStyle = 'rgba(70,0,0,1)'; g.lineWidth = 7; g.stroke();
    g.strokeStyle = 'rgba(110,0,0,1)'; g.lineWidth = 3.5; g.stroke();
    g.fillStyle = 'rgba(255,0,0,1)'; g.fill();
  }
  for (const a of data.areas) {
    poly(a.poly);
    if (a.name === 'garden') { g.fillStyle = 'rgba(0,0,200,1)'; g.fill(); g.strokeStyle = 'rgba(0,0,90,1)'; g.lineWidth = 4; g.stroke(); }
    else if (a.name === 'Parade Ground' || a.name === 'Cistern') { g.fillStyle = 'rgba(230,0,0,1)'; g.fill(); g.strokeStyle = 'rgba(90,40,0,1)'; g.lineWidth = 3; g.stroke(); }
    else if (a.name === 'Recreation Yard') { g.fillStyle = 'rgba(255,0,0,1)'; g.fill(); }
  }
  // service yard (levelled, paved)
  const [sx0, sz0, sx1, sz1] = SERVICE_YARD.box;
  g.fillStyle = 'rgba(220,0,0,1)';
  g.fillRect(sx0 - 1, sz0 - 1, sx1 - sx0 + 2, sz1 - sz0 + 2);
  // roads: dusty shoulders; footpaths: worn dirt
  for (const l of data.lines) {
    if (!l.type.startsWith('highway:') || /Agave/.test(l.name ?? '')) continue;
    line(l.pts);
    if (l.type === 'highway:service') { g.strokeStyle = 'rgba(90,60,0,1)'; g.lineWidth = 8; g.stroke(); }
    else if (l.type === 'highway:track') { g.strokeStyle = 'rgba(0,140,0,1)'; g.lineWidth = 4.5; g.stroke(); }
    else { g.strokeStyle = 'rgba(30,110,0,1)'; g.lineWidth = 3.2; g.stroke(); }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false; // canvas row 0 = z0 = v 0
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

export function createTerrainMaterial(pad: THREE.Texture, b: PadBounds) {
  const detail = detailTexture();
  const rockN = rockNormalTexture();
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  mat.name = 'terrain';

  const wp = positionWorld;
  const nGeo = normalWorldGeometry;
  const h = wp.y;
  const uvA = wp.xz.mul(1 / 7.3);
  const uvB = wp.xz.mul(1 / 41.0);
  // vertical projection for cliffs (along the bisector of x and z so no face stretches badly)
  const uvC = vec2(wp.x.add(wp.z).mul(0.7071), wp.y).mul(1 / 6.0);
  const nA = texture(detail, uvA);
  const nB = texture(detail, uvB);
  const nC = texture(detail, uvC);
  const padS = texture(pad, wp.xz.sub(vec2(b.x0, b.z0)).div(vec2(b.w, b.d)));

  const slope = saturate(float(1).sub(nGeo.y));
  const cliff = smoothstep(0.22, 0.4, slope.add(nB.r.sub(0.5).mul(0.16)));
  const flat = float(1).sub(cliff);

  // rock
  const rockDark = color(0x302f2b), rockLight = color(0x6a645a), guano = color(0xb5af9f);
  const rockFlat = mix(rockDark, rockLight, nA.r.mul(0.6).add(nB.r.mul(0.4)));
  const rockCliff = mix(rockDark, rockLight, nC.r.mul(0.8).add(nB.r.mul(0.2)));
  const guanoMask = smoothstep(0.6, 0.85, mix(nA.a, nC.a, cliff)).mul(smoothstep(18, 2.5, h)).mul(0.8);
  const rock = mix(mix(rockFlat, rockCliff, cliff), guano, guanoMask);
  // vegetation: dry grass, darker ice plant mats with a reddish cast in patches
  const vegCol = mix(mix(color(0x45502e), color(0x6b6343), nA.g), color(0x5a4234), smoothstep(0.6, 0.8, nB.b).mul(0.65));
  const vegMask = smoothstep(4.5, 10, h.add(nB.g.sub(0.5).mul(8)))
    .mul(flat)
    .mul(smoothstep(0.3, 0.55, nB.g.add(0.18).add(padS.b.mul(0.6))))
    .mul(float(1).sub(padS.r));
  const dirt = color(0x564a3b);
  const concrete = mix(color(0x8b877e), color(0x67645d), nA.b.mul(0.55).add(nB.r.mul(0.45)));
  const paved = padS.r.mul(float(1).sub(cliff.mul(0.85)));
  let col = mix(rock, vegCol, vegMask);
  col = mix(col, dirt, padS.g.mul(flat).mul(0.8));
  col = mix(col, concrete, paved);
  // tide line: dark, wet, a little green algae
  const wet = smoothstep(1.9, 0.15, h);
  col = mix(col, color(0x1b201c), wet.mul(0.6));
  mat.colorNode = col;

  const rough = mix(mix(float(0.88).add(nA.b.mul(0.08)), float(0.97), vegMask), float(0.86).add(nA.b.mul(0.08)), paved);
  mat.roughnessNode = mix(rough, float(0.32), wet);

  // detail normals: rock normal map projected like the albedo, flattened under vegetation
  const tA = texture(rockN, uvA).xyz.mul(2).sub(1);
  const tC = texture(rockN, uvC).xyz.mul(2).sub(1);
  const strength = float(0.75).sub(vegMask.mul(0.45)).sub(paved.mul(0.45));
  const pFlat = vec3(tA.x, 0, tA.y);
  const pCliff = vec3(tC.x.mul(0.7071), tC.y, tC.x.mul(0.7071));
  const nWorld = nGeo.add(mix(pFlat, pCliff, cliff).mul(strength)).normalize();
  mat.normalNode = cameraViewMatrix.mul(vec4(nWorld, 0)).xyz.normalize();
  return mat;
}
