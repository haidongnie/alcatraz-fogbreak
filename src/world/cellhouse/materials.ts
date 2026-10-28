// Material library for the cellhouse complex. Each MatDef carries the batching rules for the
// merged mesh it ends up in: UV tile size (world-projected UVs), shadow flags, vertex colours.
// Created once per Cellhouse; textures are procedural (textures.ts).
import * as THREE from 'three/webgpu';
import {
  blanketTexture, booksTexture, cellPaintTexture, floorTexture, genericRoughness, mattressTexture, meshTexture,
  paintedSteelTexture, pipeTexture, plateTexture, roofTexture, signTexture, wallTexture, windowGlowTextures, woodTexture,
  type PBRSet,
} from './textures';

export interface MatDef {
  name: string;
  mat: THREE.Material;
  /** metres per texture repeat for world-projected UVs */
  tile: number;
  cast: boolean;
  receive: boolean;
  /** geometries in this group carry a vertex colour attribute */
  colors: boolean;
}

function std(p: PBRSet, params: THREE.MeshStandardMaterialParameters) {
  const m = new THREE.MeshStandardMaterial({ map: p.map, roughnessMap: p.rough, roughness: 1, metalness: 0, ...params });
  if (p.normal) { m.normalMap = p.normal; m.normalScale.set(0.6, 0.6); }
  return m;
}

export class CellMaterials {
  readonly wall: MatDef;
  readonly wallOuter: MatDef;
  readonly floor: MatDef;
  readonly cell: MatDef;
  readonly oldPaint: MatDef;
  readonly steel: MatDef;
  readonly darkSteel: MatDef;
  readonly pipe: MatDef;
  readonly climbPipe: MatDef;
  readonly roof: MatDef;
  readonly wood: MatDef;
  readonly books: MatDef;
  readonly blanket: MatDef;
  readonly rubber: MatDef;
  readonly mattress: MatDef;
  readonly glassOut: MatDef;
  readonly glassIn: MatDef;
  readonly skyGlass: MatDef;
  readonly tubeLit: MatDef;
  readonly tubeOff: MatDef;
  readonly nightLamp: MatDef;
  readonly warmLamp: MatDef;
  readonly dark: MatDef;
  readonly signs: MatDef;
  readonly plates: MatDef;
  readonly wire: MatDef;
  readonly furnLow: MatDef;
  /** raw materials used by instanced meshes */
  readonly grilleMat: THREE.MeshStandardMaterial;
  readonly doorMat: THREE.MeshStandardMaterial;

  constructor(plateLabels: string[]) {
    const generic = genericRoughness();
    const wall = wallTexture();
    const floor = floorTexture();
    const cell = cellPaintTexture();
    const steel = paintedSteelTexture([196, 194, 182], 0);
    const dark = paintedSteelTexture([66, 74, 70], 170);
    const green = paintedSteelTexture([150, 186, 160], 333);
    const pipe = pipeTexture();
    const roof = roofTexture();
    const wood = woodTexture();
    const books = booksTexture();
    const blanket = blanketTexture();
    const mattress = mattressTexture();
    const glow = windowGlowTextures();

    const def = (name: string, mat: THREE.Material, tile: number, cast: boolean, receive = true, colors = false): MatDef =>
      ({ name, mat, tile, cast, receive, colors });

    // Architecture: walls and slabs cast (moonlight through windows/skylights only), all receive.
    this.wall = def('wall', std(wall, {}), 2.5, true);
    this.wallOuter = def('wallOuter', std(wall, { color: 0xe9e2cf }), 2.5, true);
    this.floor = def('floor', std(floor, {}), 4, true);
    this.cell = def('cell', std(cell, {}), 2, true);
    this.oldPaint = def('oldPaint', std(cell, { color: 0x8f9a8a }), 2, true);
    this.steel = def('steel', std(steel, { metalness: 0.25 }), 1, false);
    this.darkSteel = def('darkSteel', std(dark, { metalness: 0.35 }), 1, true);
    this.pipe = def('pipe', std(pipe, { metalness: 0.3 }), 1, false);
    this.climbPipe = def('climbPipe', std(steel, { color: 0xb8b2a2, metalness: 0.55 }), 0.5, false);
    this.roof = def('roof', std(roof, {}), 3, false);
    this.wood = def('wood', std(wood, {}), 2, false);
    this.books = def('books', std(books, {}), 1, false);
    this.blanket = def('blanket', std(blanket, { side: THREE.DoubleSide }), 1, false, true, true);
    this.rubber = def('rubber', std(blanket, { color: 0x7d7650, roughness: 0.7 }), 1, false, true, true);
    this.mattress = def('mattress', std(mattress, {}), 1, false);
    this.furnLow = def('furnLow', new THREE.MeshStandardMaterial({ roughnessMap: generic, roughness: 1, metalness: 0.15, vertexColors: true }), 1, false, true, true);

    // Windows: outside a faint interior glow (opaque, emissive atlas); inside nearly clear glass.
    this.glassOut = def('glassOut', new THREE.MeshStandardMaterial({
      map: glow.map, emissiveMap: glow.emissive, emissive: 0xffffff, emissiveIntensity: 0.85,
      roughnessMap: generic, roughness: 0.18, metalness: 0,
    }), 1, false, false);
    this.glassIn = def('glassIn', new THREE.MeshStandardMaterial({
      color: 0x2a3440, roughnessMap: generic, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.2, depthWrite: false,
    }), 1, false, false);
    this.skyGlass = def('skyGlass', new THREE.MeshStandardMaterial({
      color: 0x22303c, roughnessMap: generic, roughness: 0.15, metalness: 0, transparent: true, opacity: 0.38,
      depthWrite: false, side: THREE.DoubleSide,
    }), 1, false, false);

    // Emissive fixtures (the real light comes from the atmosphere's pooled lights).
    const emissive = (color: number, intensity: number) => new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: color, emissiveIntensity: intensity, roughnessMap: generic, roughness: 0.4,
    });
    this.tubeLit = def('tubeLit', emissive(0xdfeaff, 5), 1, false, false);
    this.tubeOff = def('tubeOff', new THREE.MeshStandardMaterial({ color: 0x9ea4a8, roughnessMap: generic, roughness: 0.35 }), 1, false);
    this.nightLamp = def('nightLamp', emissive(0xffd29a, 2.4), 1, false, false);
    this.warmLamp = def('warmLamp', emissive(0xffbf73, 4.5), 1, false, false);
    this.dark = def('dark', new THREE.MeshStandardMaterial({ color: 0x050505, roughnessMap: generic, roughness: 1 }), 1, false);

    this.signs = def('signs', new THREE.MeshStandardMaterial({ map: signTexture(), roughnessMap: generic, roughness: 0.85 }), 1, false);
    this.plates = def('plates', new THREE.MeshStandardMaterial({ map: plateTexture(plateLabels), roughnessMap: generic, roughness: 0.6, metalness: 0.2 }), 1, false);
    this.wire = def('wire', new THREE.MeshStandardMaterial({
      map: meshTexture(), alphaTest: 0.5, side: THREE.DoubleSide, color: 0x9a9a92, metalness: 0.5, roughnessMap: generic, roughness: 0.6,
    }), 0.5, false);

    this.grilleMat = new THREE.MeshStandardMaterial({ map: green.map, roughnessMap: green.rough, roughness: 1, metalness: 0.3, vertexColors: true });
    this.doorMat = new THREE.MeshStandardMaterial({ map: dark.map, roughnessMap: dark.rough, normalMap: dark.normal, roughness: 1, metalness: 0.45, color: 0x9aa79c });
  }
}
