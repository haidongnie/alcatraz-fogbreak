// Night of 11 June 1962, fog rolling in through the Golden Gate.
// Sky dome + stars + hazy moon low in the WSW, FogExp2 that thickens outdoors / thins indoors /
// closes in over the bay, the moon DirectionalLight (only shadow caster, frustum follows the
// camera target), a dim PMREM night environment, the pooled PointLights re-assigned to the nearest
// lamps, post-processing per quality tier, eye-adaptation-like exposure, and lampExposure() for stealth.
import * as THREE from 'three/webgpu';
import type { Ctx } from '../game/context';
import type { ZoneId } from '../game/types';
import { createMoonLight, createNightSky, type MoonLight, type NightSky } from '../core/environment';
import { createPostFX, type PostFX } from '../core/postfx';
import { zoneAt } from './layout';
import { bearingDir } from './exterior/data';
import { LAMPS, initLamps } from './exterior/lamps';

/** Tunables for the look (all in one place). Colours are sRGB hex. */
const LOOK = {
  moonBearing: 250, moonElevation: 17,
  // AgX: a moonlit cream wall lands around mid-grey, flat ground ~20 %, the fog glows a little above it
  moonColor: 0x9fb6d8, moonIntensity: 0.75,
  /** diffuse fill from the (dark) sky environment: scattered moonlight in the fog */
  envIntensity: { title: 2.4, outdoor: 2.3, indoor: 1.8 },
  /** the sea keeps faithful sky reflections regardless of the fill boost */
  seaEnvIntensity: 0.9,
  exposure: { title: 1.35, outdoor: 1.25, indoor: 1.4 },
  fogDensity: { title: 0.0021, outdoor: 0.006, indoor: 0.0016, bay: 0.0125 },
  fogColor: { title: 0x343b45, outdoor: 0x2e343d, indoor: 0x1b1d20 },
  /** multiplier on LIGHT_ANCHORS intensities for the pooled PointLights */
  lampGain: 1.0,
  shadowExtent: { title: 230, play: 48 },
  skyRadius: 1650,
  reassignInterval: 0.3,
};
const INDOOR_ZONES: ReadonlySet<ZoneId> = new Set<ZoneId>(['cell', 'utility', 'workshop', 'floor', 'dblock']);

interface PoolSlot { light: THREE.PointLight; cur: number; next: number; fade: number }

export class Atmosphere {
  private sky: NightSky | null = null;
  private moon: MoonLight | null = null;
  private postfx: PostFX | null = null;
  private readonly fog: THREE.FogExp2;
  private readonly pool: PoolSlot[] = [];
  private zone: ZoneId = 'outside';
  private reassignT = 0;
  private time = 0;
  // preallocated scratch (no per-frame allocation)
  private readonly target = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly fogTarget = new THREE.Color();
  private readonly colTitle = new THREE.Color(LOOK.fogColor.title);
  private readonly colOut = new THREE.Color(LOOK.fogColor.outdoor);
  private readonly colIn = new THREE.Color(LOOK.fogColor.indoor);
  private best: Int32Array;
  private bestScore: Float32Array;

  constructor(readonly ctx: Ctx) {
    this.fog = new THREE.FogExp2(LOOK.fogColor.title, LOOK.fogDensity.title);
    const n = Math.max(0, ctx.quality.pointLights);
    this.best = new Int32Array(n);
    this.bestScore = new Float32Array(n);
  }

  /** Night sky, moon light + shadows, fog, environment, light pool, post-processing. */
  async init() {
    const { ctx } = this;
    const { scene, renderer, camera, quality } = ctx;
    initLamps();
    const north: [number, number] = [-0.7175, -0.6966]; // island.json northDir (fallback)
    const n = (ctx.terrain as { north?: [number, number] } | null)?.north ?? north;

    // moon: bearing ~250 deg (WSW), low over the Golden Gate
    const [mx, mz] = bearingDir(n, LOOK.moonBearing);
    const el = (LOOK.moonElevation * Math.PI) / 180;
    const moonDir = new THREE.Vector3(mx * Math.cos(el), Math.sin(el), mz * Math.cos(el)).normalize();
    const city = bearingDir(n, 185);

    scene.fog = this.fog;
    scene.background = null;
    this.sky = createNightSky({ moonDir, cityDir: city, radius: LOOK.skyRadius });
    this.sky.horizon.copy(this.fog.color);
    scene.add(this.sky.mesh);
    const env = this.sky.bakeEnvironment(renderer);
    scene.environment = env;
    scene.environmentIntensity = LOOK.envIntensity.title;
    const sea = scene.getObjectByName('sea') as THREE.Mesh | undefined;
    if (sea && 'envMapIntensity' in sea.material) {
      const m = sea.material as THREE.MeshStandardMaterial;
      m.envMap = env;
      m.envMapIntensity = LOOK.seaEnvIntensity;
      m.needsUpdate = true;
    }

    this.moon = createMoonLight(scene, moonDir, { color: LOOK.moonColor, intensity: LOOK.moonIntensity, mapSize: quality.shadowMapSize });

    // fixed-size light pool (never add/remove lights at runtime: WebGPU recompiles on count changes)
    for (let i = 0; i < quality.pointLights; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 10, 2);
      light.name = `lamp-pool-${i}`;
      light.castShadow = false;
      light.position.set(0, -500, 0);
      scene.add(light);
      this.pool.push({ light, cur: -1, next: -1, fade: 0 });
    }

    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = LOOK.exposure.title;
    this.postfx = createPostFX(renderer, scene, camera, {
      ao: quality.ao, aa: quality.aa, bloom: quality.bloom,
      bloomStrength: 0.32, bloomRadius: 0.6, bloomThreshold: 0.75,
      vignette: 0.32, grain: quality.tier === 'high' ? 0.035 : 0.025,
    });

    ctx.bus.on('zone', (z) => { this.zone = z; });
    this.update(0);
  }

  /** 0..0.6 how lit a point is by lamps (pooled light anchors + exterior lamps), with distance falloff. */
  lampExposure(p: THREE.Vector3) {
    const z = zoneAt(p.x, p.y, p.z);
    if (z === 'utility') return 0.04;
    const indoor = INDOOR_ZONES.has(z);
    let e = z === 'floor' || z === 'dblock' ? 0.2 : 0;
    const px = p.x, py = p.y + 1.0, pz = p.z; // chest height
    for (let i = 0; i < LAMPS.length; i++) {
      const l = LAMPS[i];
      if (l.indoor !== indoor) continue;
      const dx = l.p.x - px, dy = l.p.y - py, dz = l.p.z - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const r2 = l.distance * l.distance;
      if (d2 >= r2) continue;
      const f = 1 - d2 / r2;
      e += 0.6 * Math.min(1, l.intensity / 28) * f * f;
    }
    return e > 0.6 ? 0.6 : e;
  }

  update(dt: number) {
    const { ctx } = this;
    const { camera, renderer, scene } = ctx;
    if (!this.sky || !this.moon) return;
    this.time += dt;
    const player = ctx.player;
    const title = !player;
    const indoor = !title && INDOOR_ZONES.has(this.zone);

    // --- fog / exposure / environment targets ------------------------------------------------
    let dens: number, exposure: number, env: number;
    if (title) {
      dens = LOOK.fogDensity.title; exposure = LOOK.exposure.title; env = LOOK.envIntensity.title;
      this.fogTarget.copy(this.colTitle);
    } else if (indoor) {
      dens = LOOK.fogDensity.indoor; exposure = LOOK.exposure.indoor; env = LOOK.envIntensity.indoor;
      this.fogTarget.copy(this.colIn);
    } else {
      dens = LOOK.fogDensity.outdoor; exposure = LOOK.exposure.outdoor; env = LOOK.envIntensity.outdoor;
      this.fogTarget.copy(this.colOut);
      if (this.zone === 'water' || this.zone === 'raft') {
        // the fog bank closes in as the raft gets away from the island
        const dist = ctx.world()?.raft.dist ?? 0;
        dens += (LOOK.fogDensity.bay - dens) * THREE.MathUtils.smoothstep(dist, 15, 230);
      }
      // the bank breathes slowly as it rolls in
      dens *= 1 + 0.07 * Math.sin(this.time * 0.031) + 0.04 * Math.sin(this.time * 0.013 + 1.3);
    }
    const k = dt > 0 ? 1 - Math.exp(-dt * 1.6) : 1;
    this.fog.density += (dens - this.fog.density) * k;
    this.fog.color.lerp(this.fogTarget, k);
    renderer.toneMappingExposure += (exposure - renderer.toneMappingExposure) * k;
    scene.environmentIntensity += (env - scene.environmentIntensity) * k;

    // --- sky -------------------------------------------------------------------------------------
    this.sky.horizon.copy(this.fog.color);
    this.sky.stars.value = THREE.MathUtils.clamp(1.15 - (this.fog.density - 0.0018) * 140, 0.12, 1);
    this.sky.glow.value = THREE.MathUtils.clamp(1.2 - this.fog.density * 60, 0.35, 1.1);
    this.sky.clouds.value = 0.55;
    this.sky.follow(camera);

    // --- moon shadow frustum follows what the camera looks at ---------------------------------
    camera.getWorldDirection(this.fwd);
    if (player) {
      this.fwd.y = 0;
      if (this.fwd.lengthSq() > 1e-6) this.fwd.normalize();
      this.target.copy(player.position).addScaledVector(this.fwd, LOOK.shadowExtent.play * 0.38);
      this.moon.follow(this.target, LOOK.shadowExtent.play);
    } else {
      // aerial orbit: centre on the point ~250 m ahead (the island), cover it all
      this.target.copy(camera.position).addScaledVector(this.fwd, 250);
      this.target.y = 30;
      this.moon.follow(this.target, LOOK.shadowExtent.title);
    }

    // --- light pool ------------------------------------------------------------------------------
    this.reassignT -= dt;
    if (this.reassignT <= 0) {
      this.reassignT = LOOK.reassignInterval;
      this.choose(player ? player.position : camera.position, indoor, title);
    }
    for (const s of this.pool) {
      if (s.next !== s.cur) {
        s.fade -= dt * 5;
        if (s.fade <= 0 || s.cur < 0) {
          s.fade = 0;
          s.cur = s.next;
          if (s.cur >= 0) {
            const l = LAMPS[s.cur];
            s.light.position.copy(l.p);
            s.light.color.copy(l.color);
            s.light.distance = l.distance;
          }
        }
      } else if (s.cur >= 0) {
        s.fade = Math.min(1, s.fade + dt * 3.5);
      }
      s.light.intensity = s.cur >= 0 ? LAMPS[s.cur].intensity * LOOK.lampGain * s.fade : 0;
    }
  }

  /** Picks the N most relevant lamps for `p` and hands them to slots (keeping lamps already held). */
  private choose(p: THREE.Vector3, indoor: boolean, title: boolean) {
    const n = this.pool.length;
    if (!n) return;
    const best = this.best, score = this.bestScore;
    best.fill(-1);
    score.fill(Infinity);
    for (let i = 0; i < LAMPS.length; i++) {
      const l = LAMPS[i];
      let s = this.tmp.copy(l.p).sub(p).length() - l.distance * 0.35;
      if (!title && l.indoor !== indoor) s += 30; // walls are in between
      if (s >= score[n - 1]) continue;
      let j = n - 1;
      while (j > 0 && score[j - 1] > s) { score[j] = score[j - 1]; best[j] = best[j - 1]; j--; }
      score[j] = s; best[j] = i;
    }
    // slots keep lamps that are still wanted; others move to the wanted lamps nobody holds
    for (const s of this.pool) s.next = best.includes(s.cur) ? s.cur : -2;
    for (let j = 0; j < n; j++) {
      const lamp = best[j];
      if (lamp < 0) continue;
      let held = false;
      for (const s of this.pool) if (s.next === lamp) { held = true; break; }
      if (held) continue;
      for (const s of this.pool) if (s.next === -2) { s.next = lamp; break; }
    }
    for (const s of this.pool) if (s.next === -2) s.next = -1;
  }

  /** Renders the frame (post-processing pipeline). */
  render() {
    const { renderer, scene, camera } = this.ctx;
    const canvas = renderer.domElement;
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) return;
    if (this.postfx) this.postfx.render();
    else renderer.render(scene, camera);
  }
}
