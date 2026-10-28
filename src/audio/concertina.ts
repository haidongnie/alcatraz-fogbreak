// Concertina: a slow, original A-minor waltz played on a synthesized free-reed voice whenever
// someone nearby is playing (PlayerNet.m = 1). Notes are scheduled slightly ahead of the audio
// clock ("two clocks" scheduling) so timing stays tight regardless of the frame rate.
import { amp, biquad, type Kit } from './synth';

/** [midi note (0 = rest), beats] — 16 bars of 3/4. */
const MELODY: readonly (readonly [number, number])[] = [
  [69, 2], [72, 1], [76, 2], [74, 1], [72, 1], [71, 1], [69, 1], [64, 3],
  [65, 2], [69, 1], [72, 2], [71, 1], [69, 1], [67, 1], [65, 1], [64, 3],
  [69, 2], [72, 1], [76, 2], [79, 1], [77, 1], [76, 1], [74, 1], [72, 3],
  [74, 1], [72, 1], [71, 1], [69, 2], [68, 1], [69, 3], [0, 3],
];
/** Left-hand buttons per bar: bass note on beat 1, chord on beats 2 and 3. */
const AM = [57, 60, 64], C = [55, 60, 64], F = [57, 60, 65], DM = [57, 62, 65], E = [56, 59, 64];
const BARS: readonly (readonly [number, readonly number[]])[] = [
  [45, AM], [45, AM], [45, AM], [40, E], [41, F], [38, DM], [38, DM], [40, E],
  [45, AM], [48, C], [41, F], [48, C], [38, DM], [40, E], [45, AM], [45, AM],
];
const BEAT = 60 / 84;
const LOOKAHEAD = 0.3;

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class Concertina {
  /** connect this to the music bus */
  readonly out: GainNode;
  private readonly voice: BiquadFilterNode;
  private running = false;
  private note = 0;
  private bar = 0;
  private nextNote = 0;
  private nextBar = 0;

  constructor(private readonly k: Kit) {
    const ac = k.ac;
    this.out = ac.createGain();
    // bellows tremolo: a slow LFO on the instrument gain
    const trem = amp(k, this.out, 0.85);
    const lfo = ac.createOscillator();
    lfo.frequency.value = 4.6;
    lfo.connect(amp(k, trem.gain, 0.12));
    lfo.start();
    // reed body: a resonant low-pass shared by every note
    this.voice = biquad(k, 'lowpass', 2300, 1.1, trem);
  }

  /** Call every frame (cheap); `on` = someone audible is playing. */
  schedule(now: number, on: boolean) {
    if (!on) { this.running = false; return; }
    // (re)start from the top; also resync after a stall (hidden tab) instead of bursting notes
    if (!this.running || this.nextNote < now - 0.5) {
      this.running = true;
      this.note = 0;
      this.bar = 0;
      this.nextNote = this.nextBar = now + 0.08;
    }
    while (this.nextNote < now + LOOKAHEAD) {
      const [m, beats] = MELODY[this.note];
      if (m > 0) this.reed(m, this.nextNote, beats * BEAT * 0.92, 0.2);
      this.nextNote += beats * BEAT;
      this.note = (this.note + 1) % MELODY.length;
    }
    while (this.nextBar < now + LOOKAHEAD) {
      const [bass, chord] = BARS[this.bar];
      const t = this.nextBar;
      this.reed(bass, t, BEAT * 0.8, 0.13);
      for (const n of chord) {
        this.reed(n, t + BEAT, BEAT * 0.75, 0.05);
        this.reed(n, t + 2 * BEAT, BEAT * 0.75, 0.05);
      }
      this.nextBar += 3 * BEAT;
      this.bar = (this.bar + 1) % BARS.length;
    }
  }

  /** One reed: two slightly detuned oscillators (saw + square) with a soft bellows envelope. */
  private reed(midi: number, t: number, dur: number, v: number) {
    const ac = this.k.ac;
    const f = midiHz(midi);
    const g = amp(this.k, this.voice);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.04);
    g.gain.setValueAtTime(v, t + Math.max(0.05, dur - 0.08));
    g.gain.linearRampToValueAtTime(0, t + dur + 0.1);
    const a = ac.createOscillator();
    a.type = 'sawtooth';
    a.frequency.value = f;
    a.connect(g);
    const b = ac.createOscillator();
    b.type = 'square';
    b.frequency.value = f * 1.0035;
    b.connect(amp(this.k, g, 0.45));
    a.start(t); b.start(t);
    a.stop(t + dur + 0.15); b.stop(t + dur + 0.15);
  }
}
