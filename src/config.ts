// Global constants and quality tiers. Gameplay tuning lives here so it is easy to balance.

/** Prefix a path under public/ with Vite's base URL (the site is served from /<repo>/ on GitHub Pages). */
export function asset(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`;
}

export const params = new URLSearchParams(location.search);
export const isTouch = matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad/i.test(navigator.userAgent);

export type QualityTier = 'high' | 'low';
export interface Quality {
  tier: QualityTier;
  maxPixelRatio: number;
  shadowMapSize: number;
  /** extra point lights re-positioned to the nearest light anchors (fixed count: no shader recompiles) */
  pointLights: number;
  ao: boolean;
  bloom: boolean;
  aa: 'traa' | 'smaa' | 'none';
  /** how many cells per block row get full furniture models (others use instanced low-detail) */
  drawDistance: number;
}

export function pickQuality(): Quality {
  const forced = params.get('q');
  const low = forced ? forced === 'low' : isTouch;
  return low
    ? { tier: 'low', maxPixelRatio: 1.25, shadowMapSize: 1024, pointLights: 4, ao: false, bloom: false, aa: 'smaa', drawDistance: 150 }
    : { tier: 'high', maxPixelRatio: 2, shadowMapSize: 2048, pointLights: 8, ao: true, bloom: true, aa: 'traa', drawDistance: 300 };
}

export const TUNING = {
  player: {
    height: 1.78,
    radius: 0.26,
    walkSpeed: 1.8,
    runSpeed: 4.6,
    crouchSpeed: 1.3,
    carrySpeedMul: 0.75,
    climbSpeed: 1.6,
    jumpSpeed: 4.2,
    lookSensitivity: 0.0022,
    interactRange: 1.8,
  },
  noise: { walk: 0.25, run: 0.7, crouch: 0.05, work: 0.9, fence: 0.6, concertinaMask: 0.35, concertinaRange: 20 },
  guard: {
    fov: (70 * Math.PI) / 180,
    range: 18,
    crouchDarkMul: 0.45,
    litMul: 1.4,
    suspicionRate: 0.55,
    suspicionDecay: 0.35,
    walkSpeed: 1.45,
    runSpeed: 4.4,
    catchDistance: 1.0,
    hearing: 25,
  },
  holeSeconds: 75,
  countInterval: 240,
  /** distance from the launch point at which the raft reaches the fog bank and the game is won */
  fogBankDistance: 240,
  raft: { paddleSpeed: 1.5, extraPaddler: 0.45, turnRate: 0.5 },
  net: { playerHz: 12, actorsHz: 10 },
};
