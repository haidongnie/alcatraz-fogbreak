// Procedural sound recipes (no audio files). Every recipe schedules short-lived WebAudio nodes at
// time `t` into `out` with a loudness scale `v`; the nodes are released by the browser once their
// sources stop. They are called per event (a footstep, a bell), never per frame.

export interface Kit {
  ac: AudioContext;
  /** 2 s of white noise */
  white: AudioBuffer;
  /** 4 s of brown (integrated) noise: surf, wind, rumble */
  brown: AudioBuffer;
}

export function createKit(ac: AudioContext): Kit {
  const sr = ac.sampleRate;
  const white = ac.createBuffer(1, Math.floor(sr * 2), sr);
  const w = white.getChannelData(0);
  for (let i = 0; i < w.length; i++) w[i] = Math.random() * 2 - 1;
  const brown = ac.createBuffer(1, Math.floor(sr * 4), sr);
  const b = brown.getChannelData(0);
  let last = 0;
  for (let i = 0; i < b.length; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    b[i] = last * 3.5;
  }
  // fade the loop seam so looping brown noise does not click
  const seam = Math.floor(sr * 0.05);
  for (let i = 0; i < seam; i++) {
    const k = i / seam;
    b[i] *= k;
    b[b.length - 1 - i] *= k;
  }
  return { ac, white, brown };
}

/** Stereo reverb impulse: exponentially decaying noise with a few early reflections. */
export function makeImpulse(ac: AudioContext, seconds: number, decay: number, brightness = 1): AudioBuffer {
  const sr = ac.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ac.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const x = i / len;
      // one-pole low-pass that closes over time: concrete halls lose their highs first
      const a = Math.min(1, brightness * (1 - x * 0.85));
      lp += a * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * Math.exp(-x * decay);
    }
    for (let r = 0; r < 6; r++) {
      const at = Math.floor(sr * (0.011 + r * 0.019 + Math.random() * 0.01) + ch * 37);
      if (at < len) d[at] += (0.5 - r * 0.07) * (Math.random() < 0.5 ? -1 : 1);
    }
  }
  return buf;
}

// ------------------------------------------------------------------------------------------------
// Primitives
// ------------------------------------------------------------------------------------------------
/** Gain node feeding a node or modulating a parameter (LFO depth). */
export function amp(k: Kit, out: AudioNode | AudioParam, v = 0): GainNode {
  const g = k.ac.createGain();
  g.gain.value = v;
  if (out instanceof AudioParam) g.connect(out); else g.connect(out);
  return g;
}
export function biquad(k: Kit, type: BiquadFilterType, f: number, q: number, out: AudioNode): BiquadFilterNode {
  const b = k.ac.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = q;
  b.connect(out);
  return b;
}
export function tone(k: Kit, type: OscillatorType, f: number, t: number, dur: number, out: AudioNode): OscillatorNode {
  const o = k.ac.createOscillator();
  o.type = type;
  o.frequency.value = f;
  o.connect(out);
  o.start(t);
  o.stop(t + dur);
  return o;
}
export function noise(k: Kit, t: number, dur: number, out: AudioNode, brown = false): AudioBufferSourceNode {
  const s = k.ac.createBufferSource();
  const buf = brown ? k.brown : k.white;
  s.buffer = buf;
  s.loop = true;
  s.connect(out);
  s.start(t, Math.random() * (buf.duration - 0.1));
  s.stop(t + dur);
  return s;
}
/** Percussive envelope: linear attack to `peak`, exponential decay. */
export function perc(p: AudioParam, t: number, peak: number, attack: number, decay: number) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(Math.max(peak, 1e-4), t + attack);
  p.exponentialRampToValueAtTime(1e-4, t + attack + decay);
}
/** Sustained envelope: attack, hold until `t + hold`, release. */
export function swell(p: AudioParam, t: number, peak: number, attack: number, hold: number, release: number) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(Math.max(peak, 1e-4), t + attack);
  p.setValueAtTime(Math.max(peak, 1e-4), t + Math.max(attack, hold));
  p.exponentialRampToValueAtTime(1e-4, t + Math.max(attack, hold) + release);
}
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

// ------------------------------------------------------------------------------------------------
// Metal and bells
// ------------------------------------------------------------------------------------------------
export function bell(k: Kit, out: AudioNode, t: number, f0: number, ratios: readonly number[], amps: readonly number[], decay: number, v: number) {
  for (let i = 0; i < ratios.length; i++) {
    const g = amp(k, out);
    const d = decay * (1 - (i / ratios.length) * 0.6);
    perc(g.gain, t, v * amps[i], 0.003, d);
    tone(k, 'sine', f0 * ratios[i], t, d + 0.05, g);
  }
}

const CLANG_R = [1, 2.31, 3.89, 5.21, 7.13, 9.6] as const;
const CLANG_A = [1, 0.7, 0.55, 0.4, 0.3, 0.2] as const;
/** Heavy steel impact (ventilator cap, cell door, grille hitting the floor). */
export function clang(k: Kit, out: AudioNode, t: number, v: number, f0 = 170, decay = 1.8) {
  bell(k, out, t, f0, CLANG_R, CLANG_A, decay, v * 0.35);
  const g = amp(k, out);
  perc(g.gain, t, v * 0.9, 0.001, 0.09);
  noise(k, t, 0.15, biquad(k, 'bandpass', 2800, 0.7, g));
  const th = amp(k, out);
  perc(th.gain, t, v * 0.6, 0.002, 0.2);
  const o = tone(k, 'sine', 90, t, 0.3, th);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.25);
}

const COUNT_R = [0.5, 1, 1.2, 1.5, 2.0, 2.76, 3.0] as const;
const COUNT_A = [0.6, 1, 0.5, 0.35, 0.3, 0.2, 0.15] as const;
/** The cellhouse count bell, struck twice. */
export function countBell(k: Kit, out: AudioNode, t: number, v: number) {
  bell(k, out, t, 330, COUNT_R, COUNT_A, 3.2, v * 0.3);
  bell(k, out, t + 1.4, 330, COUNT_R, COUNT_A, 3.6, v * 0.3);
}

/** Electric alarm bell: a hammer at ~17 Hz on a bright bell tone. */
export function alarmBell(k: Kit, out: AudioNode, t: number, v: number, dur = 3.4) {
  const env = amp(k, out);
  swell(env.gain, t, v * 0.5, 0.02, dur, 0.5);
  const am = amp(k, env, 0.5);
  tone(k, 'square', 17, t, dur + 0.6, amp(k, am.gain, 0.5));
  const parts = [980, 2410, 3890];
  const levels = [0.5, 0.3, 0.2];
  for (let i = 0; i < parts.length; i++) tone(k, 'sine', parts[i], t, dur + 0.6, amp(k, am, levels[i]));
}

/** Police pea whistle: two short-long blasts with the pea's warble. */
export function whistle(k: Kit, out: AudioNode, t: number, v: number) {
  const env = amp(k, out);
  const p = env.gain;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(v * 0.3, t + 0.02);
  p.setValueAtTime(v * 0.3, t + 0.25);
  p.linearRampToValueAtTime(0, t + 0.29);
  p.linearRampToValueAtTime(v * 0.3, t + 0.36);
  p.setValueAtTime(v * 0.3, t + 1.2);
  p.exponentialRampToValueAtTime(1e-4, t + 1.45);
  const bp = biquad(k, 'bandpass', 3000, 3, env);
  const o1 = tone(k, 'sine', 2900, t, 1.5, bp);
  const o2 = tone(k, 'triangle', 3020, t, 1.5, amp(k, bp, 0.4));
  const lfo = tone(k, 'sine', 26, t, 1.5, amp(k, o1.frequency, 140));
  lfo.connect(amp(k, o2.frequency, 140));
  noise(k, t, 1.5, amp(k, biquad(k, 'highpass', 5000, 0.7, env), 0.15));
}

/** Diaphone foghorn: low reed blast; `twoTone` drops in pitch halfway ("bee-oh"). */
export function foghorn(k: Kit, out: AudioNode, t: number, v: number, twoTone: boolean) {
  const dur = twoTone ? 4.2 : 4.6;
  const env = amp(k, out);
  swell(env.gain, t, v * 0.32, 0.35, dur - 0.8, 0.9);
  const lp = biquad(k, 'lowpass', 520, 2.2, env);
  const f1 = twoTone ? 176 : 150;
  const f2 = twoTone ? 131 : 147;
  const oscs = [tone(k, 'sawtooth', f1, t, dur + 0.2, lp), tone(k, 'sawtooth', f1 * 1.004, t, dur + 0.2, lp),
    tone(k, 'square', f1 / 2, t, dur + 0.2, amp(k, lp, 0.35))];
  const ratios = [1, 1.004, 0.5];
  if (twoTone) {
    for (let i = 0; i < oscs.length; i++) {
      oscs[i].frequency.setValueAtTime(f1 * ratios[i], t + 1.8);
      oscs[i].frequency.linearRampToValueAtTime(f2 * ratios[i], t + 1.95);
    }
  }
}

/** Distant bell buoy in the bay. */
export function buoyBell(k: Kit, out: AudioNode, t: number, v: number) {
  bell(k, out, t, 640, [1, 1.5, 2.31, 3.1], [1, 0.5, 0.35, 0.2], 3, v * 0.25);
}

// ------------------------------------------------------------------------------------------------
// Escape work and props
// ------------------------------------------------------------------------------------------------
/** Vent grille pried off: scrape, then it clatters on the floor. */
export function grille(k: Kit, out: AudioNode, t: number, v: number) {
  const g = amp(k, out);
  perc(g.gain, t, v * 0.7, 0.03, 0.6);
  const bp = biquad(k, 'bandpass', 2600, 6, g);
  bp.frequency.setValueAtTime(2600, t);
  bp.frequency.exponentialRampToValueAtTime(900, t + 0.55);
  noise(k, t, 0.7, bp);
  clang(k, out, t + 0.62, v * 0.45, 540, 0.5);
  clang(k, out, t + 0.8, v * 0.22, 600, 0.35);
  clang(k, out, t + 0.92, v * 0.1, 660, 0.25);
}

/** Steel corridor door: latch, creak, stop. */
export function door(k: Kit, out: AudioNode, t: number, v: number) {
  const latch = amp(k, out);
  perc(latch.gain, t, v * 0.8, 0.002, 0.06);
  noise(k, t, 0.1, biquad(k, 'bandpass', 1600, 2, latch));
  const th = amp(k, out);
  perc(th.gain, t, v * 0.7, 0.005, 0.25);
  tone(k, 'sine', 75, t, 0.3, th);
  const cr = amp(k, out);
  perc(cr.gain, t + 0.15, v * 0.22, 0.15, 1.1);
  const saw = tone(k, 'sawtooth', 92, t + 0.15, 1.4, biquad(k, 'bandpass', 650, 4, cr));
  const curve = new Float32Array(16);
  let f = 92;
  for (let i = 0; i < curve.length; i++) { f = Math.min(135, Math.max(80, f + rnd(-14, 14))); curve[i] = f; }
  saw.frequency.setValueCurveAtTime(curve, t + 0.15, 1.2);
  clang(k, out, t + 1.35, v * 0.3, 140, 0.9);
}

/** Sliding cell door and the slam of the locking bar. */
export function cellDoor(k: Kit, out: AudioNode, t: number, v: number) {
  const rum = amp(k, out);
  swell(rum.gain, t, v * 0.8, 0.05, 0.5, 0.12);
  noise(k, t, 0.7, biquad(k, 'lowpass', 240, 0.8, rum), true);
  tone(k, 'sawtooth', 48, t, 0.7, biquad(k, 'lowpass', 200, 1, amp(k, rum, 0.25)));
  clang(k, out, t + 0.6, v, 120, 1.6);
}

export function pickup(k: Kit, out: AudioNode, t: number, v: number) {
  const g = amp(k, out);
  perc(g.gain, t, v * 0.35, 0.01, 0.12);
  noise(k, t, 0.2, biquad(k, 'bandpass', 2400, 0.7, g));
  const g2 = amp(k, out);
  perc(g2.gain, t + 0.09, v * 0.25, 0.01, 0.1);
  noise(k, t + 0.09, 0.2, biquad(k, 'bandpass', 1800, 0.7, g2));
}

export function drop(k: Kit, out: AudioNode, t: number, v: number) {
  const g = amp(k, out);
  perc(g.gain, t, v, 0.003, 0.22);
  const o = tone(k, 'sine', 95, t, 0.3, g);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.15);
  const n = amp(k, out);
  perc(n.gain, t, v * 0.5, 0.002, 0.08);
  noise(k, t, 0.12, biquad(k, 'lowpass', 600, 0.7, n));
}

export function splash(k: Kit, out: AudioNode, t: number, v: number) {
  const g = amp(k, out);
  perc(g.gain, t, v * 0.8, 0.01, 0.75);
  const lp = biquad(k, 'lowpass', 5000, 0.8, g);
  lp.frequency.setValueAtTime(5000, t);
  lp.frequency.exponentialRampToValueAtTime(350, t + 0.6);
  noise(k, t, 0.85, lp);
  const b = amp(k, out);
  perc(b.gain, t, v * 0.7, 0.005, 0.3);
  noise(k, t, 0.4, biquad(k, 'lowpass', 300, 0.7, b), true);
}

/** Chain-link fence shaking under a climber. */
export function fence(k: Kit, out: AudioNode, t: number, v: number) {
  for (let i = 0; i < 12; i++) {
    const ti = t + i * 0.07 + Math.random() * 0.03;
    const g = amp(k, out);
    perc(g.gain, ti, v * rnd(0.2, 0.5), 0.002, 0.04);
    noise(k, ti, 0.06, biquad(k, 'highpass', 2800, 0.7, g));
    const p = amp(k, out);
    perc(p.gain, ti, v * 0.1, 0.001, 0.12);
    tone(k, 'sine', rnd(3200, 5000), ti, 0.15, p);
  }
}

/** Concertina pumped as a bellows (no keys, just air). */
export function inflate(k: Kit, out: AudioNode, t: number, v: number) {
  const g = amp(k, out);
  const p = g.gain;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(v * 0.5, t + 0.6);
  p.linearRampToValueAtTime(v * 0.1, t + 1.2);
  p.linearRampToValueAtTime(v * 0.5, t + 1.8);
  p.exponentialRampToValueAtTime(1e-4, t + 2.5);
  noise(k, t, 2.6, biquad(k, 'bandpass', 480, 1.4, g), true);
  noise(k, t, 2.6, amp(k, biquad(k, 'highpass', 4000, 0.7, g), 0.15));
}

/** Vacuum-motor drill revving up and down. */
export function drillRev(k: Kit, out: AudioNode, t: number, v: number) {
  const env = amp(k, out);
  swell(env.gain, t, v * 0.35, 0.1, 1.2, 0.25);
  const bp = biquad(k, 'bandpass', 1200, 0.8, env);
  const o = tone(k, 'sawtooth', 140, t, 1.6, bp);
  o.frequency.linearRampToValueAtTime(230, t + 0.25);
  o.frequency.setValueAtTime(230, t + 1.1);
  o.frequency.linearRampToValueAtTime(160, t + 1.5);
  const sub = tone(k, 'square', 70, t, 1.6, amp(k, bp, 0.4));
  sub.frequency.linearRampToValueAtTime(115, t + 0.25);
  noise(k, t, 1.6, amp(k, biquad(k, 'highpass', 3500, 0.7, env), 0.3));
}

/** Hand-cranked escape siren: rises and falls. */
export function siren(k: Kit, out: AudioNode, t: number, v: number, dur = 6) {
  const env = amp(k, out);
  swell(env.gain, t, v * 0.25, 1.0, dur - 1.5, 1.5);
  const lp = biquad(k, 'lowpass', 1500, 0.8, env);
  const a = tone(k, 'sawtooth', 180, t, dur + 0.2, lp);
  const b = tone(k, 'sawtooth', 270, t, dur + 0.2, amp(k, lp, 0.5));
  for (const [o, m] of [[a, 1], [b, 1.5]] as const) {
    o.frequency.setValueAtTime(180 * m, t);
    o.frequency.linearRampToValueAtTime(720 * m, t + dur * 0.45);
    o.frequency.linearRampToValueAtTime(240 * m, t + dur);
  }
}

// ------------------------------------------------------------------------------------------------
// Ambience voices
// ------------------------------------------------------------------------------------------------
/** A western gull: a few harsh descending "kyow" calls. */
export function gull(k: Kit, out: AudioNode, t: number, v: number) {
  const calls = 2 + Math.floor(Math.random() * 3);
  const f = rnd(0.9, 1.15);
  for (let j = 0; j < calls; j++) {
    const tj = t + j * rnd(0.24, 0.34);
    const g = amp(k, out);
    perc(g.gain, tj, v * (j === 0 ? 0.3 : 0.22), 0.015, 0.24);
    const bp = biquad(k, 'bandpass', 2000, 1.5, g);
    const o = tone(k, 'triangle', 1500 * f, tj, 0.32, bp);
    o.frequency.linearRampToValueAtTime(2300 * f, tj + 0.04);
    o.frequency.exponentialRampToValueAtTime(1150 * f, tj + 0.26);
    const r = tone(k, 'sawtooth', 1520 * f, tj, 0.32, amp(k, bp, 0.25));
    r.frequency.linearRampToValueAtTime(2280 * f, tj + 0.04);
    r.frequency.exponentialRampToValueAtTime(1180 * f, tj + 0.26);
  }
}

export function cough(k: Kit, out: AudioNode, t: number, v: number) {
  const n = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < n; i++) {
    const ti = t + i * rnd(0.18, 0.26);
    const g = amp(k, out);
    perc(g.gain, ti, v * (1 - i * 0.2), 0.006, 0.14);
    noise(k, ti, 0.2, biquad(k, 'bandpass', rnd(600, 900), 1.2, g));
    const c = amp(k, out);
    perc(c.gain, ti, v * 0.3, 0.006, 0.1);
    tone(k, 'sine', 160, ti, 0.15, c);
  }
}

export function snore(k: Kit, out: AudioNode, t: number, v: number) {
  const g = amp(k, out);
  const p = g.gain;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(v, t + 0.9);
  p.linearRampToValueAtTime(0, t + 1.5);
  const lp = biquad(k, 'lowpass', 420, 1, g);
  tone(k, 'sawtooth', rnd(70, 86), t, 1.6, lp);
  noise(k, t, 1.6, amp(k, lp, 0.5), true);
  const ex = amp(k, out);
  const q = ex.gain;
  q.setValueAtTime(0, t + 1.8);
  q.linearRampToValueAtTime(v * 0.35, t + 2.2);
  q.linearRampToValueAtTime(0, t + 2.9);
  noise(k, t + 1.8, 1.2, biquad(k, 'bandpass', 900, 0.8, ex));
}

export function drip(k: Kit, out: AudioNode, t: number, v: number) {
  const g = amp(k, out);
  perc(g.gain, t, v, 0.001, 0.07);
  const o = tone(k, 'sine', 900, t, 0.1, g);
  o.frequency.exponentialRampToValueAtTime(rnd(1900, 2500), t + 0.05);
}

export type Surface = 'concrete' | 'metal' | 'gravel' | 'grass' | 'water';
export function footstep(k: Kit, out: AudioNode, t: number, v: number, s: Surface) {
  if (s === 'water') {
    const g = amp(k, out);
    perc(g.gain, t, v * 0.8, 0.01, 0.22);
    const lp = biquad(k, 'lowpass', 1400, 0.7, g);
    lp.frequency.exponentialRampToValueAtTime(450, t + 0.2);
    noise(k, t, 0.3, lp);
    return;
  }
  if (s === 'gravel' || s === 'grass') {
    const grains = s === 'gravel' ? 3 : 1;
    for (let i = 0; i < grains; i++) {
      const ti = t + i * rnd(0.012, 0.025);
      const g = amp(k, out);
      perc(g.gain, ti, v * (s === 'gravel' ? 0.55 : 0.4), s === 'gravel' ? 0.003 : 0.012, s === 'gravel' ? 0.035 : 0.09);
      noise(k, ti, 0.12, biquad(k, s === 'gravel' ? 'highpass' : 'bandpass', s === 'gravel' ? 1800 : 3000, 0.6, g));
    }
  } else {
    const g = amp(k, out);
    perc(g.gain, t, v * 0.7, 0.002, 0.05);
    noise(k, t, 0.08, biquad(k, 'bandpass', rnd(1200, 1600), 0.9, g));
  }
  const th = amp(k, out);
  perc(th.gain, t, v * 0.5, 0.002, 0.07);
  tone(k, 'sine', rnd(75, 95), t, 0.1, th);
  if (s === 'metal') {
    const m = amp(k, out);
    perc(m.gain, t, v * 0.12, 0.001, 0.14);
    tone(k, 'sine', rnd(1100, 1250), t, 0.16, m);
    tone(k, 'sine', rnd(1700, 1800), t, 0.16, m);
  }
}

/** Lock-pick tick. */
export function click(k: Kit, out: AudioNode, t: number, v: number) {
  const g = amp(k, out);
  perc(g.gain, t, v, 0.0005, 0.015);
  noise(k, t, 0.03, biquad(k, 'bandpass', 3800, 4, g));
  const p = amp(k, out);
  perc(p.gain, t, v * 0.2, 0.0005, 0.03);
  tone(k, 'sine', rnd(2400, 2900), t, 0.05, p);
}

export function rustle(k: Kit, out: AudioNode, t: number, v: number) {
  const g = amp(k, out);
  perc(g.gain, t, v, 0.03, 0.15);
  noise(k, t, 0.22, biquad(k, 'bandpass', rnd(1600, 2600), 0.6, g));
}

export function jingle(k: Kit, out: AudioNode, t: number, v: number) {
  let ti = t;
  for (let i = 0; i < 5; i++) {
    ti += rnd(0.02, 0.07);
    const g = amp(k, out);
    perc(g.gain, ti, v * 0.3, 0.001, 0.15);
    tone(k, 'sine', rnd(3000, 5200), ti, 0.18, g);
  }
}

/** Raft paddle stroke. */
export function paddle(k: Kit, out: AudioNode, t: number, v: number) {
  const g = amp(k, out);
  perc(g.gain, t, v * 0.5, 0.06, 0.35);
  const bp = biquad(k, 'bandpass', 600, 0.9, g);
  bp.frequency.exponentialRampToValueAtTime(1500, t + 0.35);
  noise(k, t, 0.45, bp);
  drip(k, out, t + 0.5, v * 0.15);
}

/** Pipe-bracket knock while climbing. */
export function climbKnock(k: Kit, out: AudioNode, t: number, v: number) {
  const g = amp(k, out);
  perc(g.gain, t, v, 0.001, 0.12);
  tone(k, 'sine', rnd(380, 460), t, 0.15, g);
  tone(k, 'sine', rnd(1100, 1300), t, 0.1, amp(k, g, 0.3));
}

// ------------------------------------------------------------------------------------------------
// Stingers
// ------------------------------------------------------------------------------------------------
/** Typewriter keys and the carriage bell (chapter cards). */
export function typewriter(k: Kit, out: AudioNode, t: number, v: number) {
  let ti = t;
  for (let i = 0; i < 7; i++) {
    ti += rnd(0.06, 0.11);
    const g = amp(k, out);
    perc(g.gain, ti, v * 0.5, 0.001, 0.025);
    noise(k, ti, 0.04, biquad(k, 'bandpass', 2500, 1.5, g));
    const th = amp(k, out);
    perc(th.gain, ti, v * 0.25, 0.001, 0.04);
    tone(k, 'sine', 180, ti, 0.06, th);
  }
  bell(k, out, ti + 0.18, 2100, [1, 2.7], [1, 0.3], 1.2, v * 0.3);
}

/** Heartbeat thump (lub-dub). */
export function heartbeat(k: Kit, out: AudioNode, t: number, v: number) {
  for (const [dt, m] of [[0, 1], [0.22, 0.7]] as const) {
    const g = amp(k, out);
    perc(g.gain, t + dt, v * m, 0.005, 0.18);
    const o = tone(k, 'sine', 58, t + dt, 0.25, g);
    o.frequency.exponentialRampToValueAtTime(38, t + dt + 0.18);
  }
}

/** Low dissonant brass hit when the local player is caught. */
export function caughtSting(k: Kit, out: AudioNode, t: number, v: number) {
  const env = amp(k, out);
  swell(env.gain, t, v * 0.22, 0.05, 0.5, 1.6);
  const lp = biquad(k, 'lowpass', 300, 1.5, env);
  lp.frequency.linearRampToValueAtTime(1300, t + 0.4);
  lp.frequency.exponentialRampToValueAtTime(250, t + 2);
  for (const f of [65.4, 69.3, 98, 138.6]) tone(k, 'sawtooth', f, t, 2.3, lp);
  clang(k, out, t, v * 0.6, 100, 1.4);
}

/** Soft open chord when the raft disappears into the fog. */
export function fogChord(k: Kit, out: AudioNode, t: number, v: number) {
  const env = amp(k, out);
  swell(env.gain, t, v * 0.12, 2.5, 5, 4);
  const lp = biquad(k, 'lowpass', 900, 0.5, env);
  for (const f of [110, 164.8, 220, 277.2, 329.6]) {
    tone(k, 'triangle', f, t, 11.6, lp);
    tone(k, 'sine', f * 1.003, t, 11.6, lp);
  }
}
