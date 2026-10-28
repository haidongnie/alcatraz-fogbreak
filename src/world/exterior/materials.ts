// Shared exterior materials (created once). Batched geometry carries per-vertex colour tints so many
// surfaces share one material (= one draw call); facades use a node material with window masks.
import * as THREE from 'three/webgpu';
import {
  attribute, cameraPosition, cameraProjectionMatrix, cameraViewMatrix, color, distance, float, mix, modelWorldMatrix, positionLocal,
  normalMap, positionWorld, smoothstep, step, texture, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl';
import {
  asphaltTextures, chainLinkTexture, concreteTextures, detailTexture, glowTexture, roofTextures, WINDOW_TILE, windowTexture,
  woodTextures, yardPaintTexture,
} from './textures';

let mats: ReturnType<typeof create> | null = null;
export function materials() { return (mats ??= create()); }

function create() {
  const concreteT = concreteTextures();
  const roofT = roofTextures();
  const asphaltT = asphaltTextures();
  const woodT = woodTextures();
  const detail = detailTexture();

  /** Board-formed concrete for walls, retaining walls, bleachers, aprons (tint = vertex colour, uv in m/4). */
  const concrete = new THREE.MeshStandardMaterial({
    name: 'ext-concrete', map: concreteT.map, roughnessMap: concreteT.rough, normalMap: concreteT.normal,
    normalScale: new THREE.Vector2(0.6, 0.6), roughness: 1, metalness: 0, vertexColors: true,
  });

  /** Tar-and-gravel roofs and wall copings. */
  const roof = new THREE.MeshStandardMaterial({
    name: 'ext-roof', map: roofT.map, roughnessMap: roofT.rough, normalMap: roofT.normal,
    normalScale: new THREE.Vector2(0.5, 0.5), roughness: 1, metalness: 0, vertexColors: true,
  });

  /** Asphalt / macadam road ribbons (draped on the terrain: polygon offset avoids z-fighting). */
  const asphalt = new THREE.MeshStandardMaterial({
    name: 'ext-asphalt', map: asphaltT.map, roughnessMap: asphaltT.rough, normalMap: asphaltT.normal,
    normalScale: new THREE.Vector2(0.5, 0.5), roughness: 1, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  /** Concrete footpaths and steps. */
  const paving = new THREE.MeshStandardMaterial({
    name: 'ext-paving', map: concreteT.map, roughnessMap: concreteT.rough, normalMap: concreteT.normal,
    normalScale: new THREE.Vector2(0.4, 0.4), color: 0xb7b2a7, roughness: 1, metalness: 0, vertexColors: true,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });

  /** Galvanised steel: posts, rails, barbed wire, catwalk railings. */
  const metal = new THREE.MeshStandardMaterial({
    name: 'ext-metal', color: 0x7d8184, metalness: 0.75, roughness: 0.55, roughnessMap: detail,
  });
  /** Dark painted steel / iron (lamp brackets, gates, sign posts). */
  const darkMetal = new THREE.MeshStandardMaterial({ name: 'ext-dark-metal', color: 0x2b302c, metalness: 0.5, roughness: 0.6, roughnessMap: detail });

  /** Chain-link mesh: alpha-tested, double sided, casts dappled moon shadows. */
  const chainLink = new THREE.MeshStandardMaterial({
    name: 'ext-chainlink', map: chainLinkTexture(), alphaTest: 0.42, side: THREE.DoubleSide,
    color: 0x9a9fa3, metalness: 0.65, roughness: 0.5,
  });

  /** Weathered timber (pier deck, piles, sign boards' backs). */
  const wood = new THREE.MeshStandardMaterial({
    name: 'ext-wood', map: woodT.map, roughnessMap: woodT.rough, normalMap: woodT.normal, roughness: 1, metalness: 0, vertexColors: true,
  });

  /** Lamp globes: sodium / incandescent emissive (blooms; the real light comes from the pool). */
  const globe = new THREE.MeshStandardMaterial({
    name: 'ext-globe', color: 0x2a2018, emissive: 0xffb469, emissiveIntensity: 9, roughness: 0.3, metalness: 0,
  });

  // --- lit facade ---------------------------------------------------------------------------------
  // uv = metres (u along the perimeter, v above the building's lowest ground). attribute fx =
  // (lit ratio, windows on/off, wall height for windows, warm/cool tint 0..1); colour = paint tint.
  const facade = new THREE.MeshStandardNodeMaterial({ name: 'ext-facade', roughness: 0.85, metalness: 0 });
  {
    const fx = attribute('fx', 'vec4');
    const tint = attribute('color', 'vec3');
    const m = uv();
    const conc = texture(concreteT.map, m.mul(0.25));
    const concR = texture(concreteT.rough, m.mul(0.25)).r;
    const win = texture(windowTexture(), m.div(vec2(WINDOW_TILE.bay * WINDOW_TILE.bays, WINDOW_TILE.floor * WINDOW_TILE.floors)));
    // windows only on walls with windows, below the parapet line, never in the bottom 0.6 m
    const allow = fx.y.mul(step(m.y, fx.z)).mul(step(0.6, m.y));
    const glass = win.r.mul(allow);
    const frame = win.a.mul(allow);
    const lit = step(float(1).sub(fx.x), win.g).mul(glass);
    const glassCol = mix(vec3(0.015, 0.017, 0.02), vec3(0.03, 0.026, 0.02), win.b);
    let base = conc.rgb.mul(tint);
    base = mix(base, base.mul(0.45), frame);
    facade.colorNode = mix(base, glassCol, glass);
    facade.roughnessNode = mix(concR, float(0.12), glass);
    // board-form relief catches the grazing moonlight; glass stays flat
    facade.normalNode = normalMap(texture(concreteT.normal, m.mul(0.25)), float(0.6).mul(float(1).sub(glass)));
    const warm = mix(vec3(1.0, 0.62, 0.3), vec3(1.0, 0.78, 0.5), win.b);
    const cool = vec3(0.65, 0.78, 1.0); // fluorescent office light
    const emis = mix(warm, cool, fx.w.mul(step(0.6, win.b)));
    facade.emissiveNode = emis.mul(lit).mul(win.b.mul(1.1).add(0.6)).mul(1.5);
  }

  /** Painted recreation-yard floor: concrete + white lines, worn by distance from the bleachers. */
  const yardFloor = new THREE.MeshStandardNodeMaterial({ name: 'ext-yard-floor', roughness: 0.9, metalness: 0 });
  const yardOrigin = uniform(new THREE.Vector2(0, 0));
  {
    const wp = positionWorld;
    const c = texture(concreteT.map, wp.xz.mul(0.18));
    const paint = texture(yardPaintTexture(), wp.xz.sub(yardOrigin).div(80)).r;
    const wear = texture(detail, wp.xz.mul(0.05)).g;
    yardFloor.colorNode = mix(c.rgb.mul(color(0xa9a59b)), color(0xd8d6cf), paint.mul(smoothstep(0.25, 0.6, wear).mul(0.6).add(0.3)));
    yardFloor.roughnessNode = texture(concreteT.rough, wp.xz.mul(0.18)).r.mul(0.95);
  }

  /** Additive camera-facing halo (billboards built in the vertex stage; attribute 'corner' = quad offset). */
  const fogDensity = uniform(0.004);
  const halo = new THREE.MeshBasicNodeMaterial({
    name: 'ext-halo', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  {
    const tintA = attribute('color', 'vec3');
    halo.vertexNode = haloVertex();
    const g = texture(glowTexture(), uv()).a;
    const d = distance(positionWorld, cameraPosition);
    const atten = d.mul(fogDensity).mul(0.55).pow(2).negate().exp();
    // fade out when very close (the bloom + real light take over) to avoid a flat sprite look
    const near = smoothstep(2.0, 6.0, d);
    halo.colorNode = vec4(tintA.mul(g).mul(atten).mul(near), 1);
  }

  return {
    concrete, roof, asphalt, paving, metal, darkMetal, chainLink, wood, globe, facade, yardFloor, halo,
    /** follows scene.fog.density (bound per render by Exterior) */
    fogDensity,
    yardOrigin,
  };
}

/** View-space billboard: centre from `position`, offset by corner.xy * corner.z (metres). */
function haloVertex() {
  const corner = attribute('corner', 'vec3'); // (x, y, size)
  const centerView = cameraViewMatrix.mul(modelWorldMatrix.mul(vec4(positionLocal, 1)));
  // pulled 0.45 m toward the camera so the glow is drawn over its own globe
  const offset = vec4(corner.x.mul(corner.z), corner.y.mul(corner.z), 0.45, 0);
  return cameraProjectionMatrix.mul(centerView.add(offset));
}
