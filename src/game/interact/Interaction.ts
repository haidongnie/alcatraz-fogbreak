// Local interaction system. Every frame it gathers what the local player can do right here
// (rules.availableInteractions + TRAVERSES + CLIMBS), picks the nearest one in front of the camera,
// shows the HUD prompt (bus 'prompt') and runs hold-to-interact: hold E (or the touch Interact
// button) for `hold` seconds while the player works and makes noise; on completion the request
// goes to the host (`ctx.net.act`) or the player starts the traverse/climb. Continuous tasks
// (inflating the raft) stream `progress` to the host while held. G drops, F throws.
// The host validates everything again (rules.hostApply); nothing here mutates WorldState.
import * as THREE from 'three/webgpu';
import { TUNING, isTouch } from '../../config';
import { getLang, t } from '../../i18n';
import { CLIMBS, PLAYER_CELLS, TRAVERSES, zoneAt, type ClimbDef, type TraverseDef } from '../../world/layout';
import type { BusEvents, Ctx, PlayerApi } from '../context';
import { availableInteractions, carriedBy, isHeavy, type Interaction as RuleInteraction } from '../rules';
import type { ItemId, PrisonerAnim, V3, WorldState } from '../types';
import { WorldCache, gearAtLaunch } from './gear';

/** within this distance (horizontal) of a traverse end */
const TRAVERSE_RADIUS = 1.2;
/** within this distance of a climb's bottom/top (or its exit points) */
const CLIMB_RADIUS = 1.3;
/** climbs need a short hold so a stray E press near the pipes does not send the player off */
const CLIMB_HOLD = 0.35;
/** continuous tasks report accumulated hold seconds to the host this often */
const PROGRESS_INTERVAL = 0.25;
/** interactions this large are areas (inflate, board): standing inside is enough */
const AREA_RADIUS = 3;
/** rules interactions win ties against movement helpers standing at the same spot */
const RULE_BONUS = 0.3;
/** host-side inflation rate per player (rules.hostApply 'progress': amount / 20) */
const INFLATE_SECONDS = 20;
/** loud completed actions are reported to the guards */
const LOUD = 0.5;

type Kind = 'rule' | 'traverse' | 'climb' | 'hint';

/** One thing the player could do now. Preallocated and copied; never created per frame. */
class Candidate {
  kind: Kind = 'hint';
  /** unique id (rules id, or a precomputed traverse/climb key) */
  id = '';
  /** i18n key */
  prompt = '';
  key = 'E';
  hold = 0;
  noise = 0;
  continuous = false;
  anim: PrisonerAnim = 'work';
  traverse: TraverseDef | null = null;
  climb: ClimbDef | null = null;
  /** traverse: start from b; climb: start from the top */
  reverse = false;
  score = Infinity;

  clear() { this.score = Infinity; this.id = ''; this.traverse = null; this.climb = null; }
  get valid() { return this.score < Infinity; }
  copy(o: Candidate) {
    this.kind = o.kind; this.id = o.id; this.prompt = o.prompt; this.key = o.key; this.hold = o.hold;
    this.noise = o.noise; this.continuous = o.continuous; this.anim = o.anim; this.traverse = o.traverse;
    this.climb = o.climb; this.reverse = o.reverse; this.score = o.score;
  }
}

/** Optional PlayerApi extension: publishes the id being held as PlayerNet.h (co-op progress). */
interface HoldReporter { setHolding?(id: string): void }

const _fwd = new THREE.Vector3();

export class Interaction {
  private readonly best = new Candidate();
  private readonly hint = new Candidate();
  private readonly tmp = new Candidate();
  private readonly held = new Candidate();

  private readonly rules = new WorldCache<RuleInteraction[]>((w) => availableInteractions(w, this.ctx.myId), []);
  private readonly myCarry = new WorldCache<ItemId | null>((w) => carriedBy(w, this.ctx.myId), null);
  private readonly gearReady = new WorldCache<boolean>(gearAtLaunch, false);

  // precomputed candidate ids (no string building per frame)
  private readonly travIdA = TRAVERSES.map((tr) => `traverse:${tr.id}:a`);
  private readonly travIdB = TRAVERSES.map((tr) => `traverse:${tr.id}:b`);
  private readonly climbIdUp = CLIMBS.map((c) => `climb:${c.id}:up`);
  private readonly climbIdDown = CLIMBS.map((c) => `climb:${c.id}:down`);

  // hold state
  private holding = false;
  private heldValid = false;
  private holdT = 0;
  private progressAccum = 0;
  private progressSend = 0;
  /** after a completion E must be released before the next hold starts */
  private needRelease = false;
  private suppressId = '';
  private suppressT = 0;
  private suppressV = -1;
  private actionCooldown = 0;

  // facing + player for the current frame
  private fx = 0;
  private fz = -1;
  private feet: THREE.Vector3 | null = null;

  // prompt: two alternating payload objects so consumers that compare by reference still see a
  // change, without allocating every frame
  private readonly promptA: NonNullable<BusEvents['prompt']> = { text: '', hold: 0, progress: 0, key: '' };
  private readonly promptB: NonNullable<BusEvents['prompt']> = { text: '', hold: 0, progress: 0, key: '' };
  private promptFlip = false;
  private promptShown = false;
  private promptId = '';
  private promptText = '';
  private promptLang = '';
  private promptProgress = -1;

  constructor(readonly ctx: Ctx) {}

  update(dt: number) {
    const ctx = this.ctx;
    this.actionCooldown = Math.max(0, this.actionCooldown - dt);
    this.suppressT = Math.max(0, this.suppressT - dt);
    const w = ctx.world();
    const pl = ctx.player;
    if (!w || !pl || w.phase !== 'playing' || w.players[ctx.myId]?.s !== 'free' || pl.mode !== 'walk') {
      this.cancelHold();
      this.needRelease = this.needRelease || ctx.input.isDown('KeyE');
      this.showPrompt(null, 0);
      return;
    }

    this.gather(w, pl);
    const eDown = ctx.input.isDown('KeyE');
    if (!eDown) this.needRelease = false;

    if (this.holding) {
      if (!eDown) this.cancelHold();
      else if (!this.heldValid) {
        // the target went away under us (done by someone else, raft fully inflated...):
        // make the player let go before anything else starts
        this.cancelHold();
        this.needRelease = true;
      } else this.advanceHold(dt, w, pl);
    } else if (eDown && !this.needRelease && this.best.valid) {
      this.beginHold(w, pl);
    }

    // drop / throw what I carry
    const carrying = this.myCarry.get(w);
    if (carrying && !this.holding && this.actionCooldown <= 0) {
      if (ctx.input.wasPressed('KeyG')) this.dropOrThrow(carrying, false);
      else if (ctx.input.wasPressed('KeyF')) this.dropOrThrow(carrying, true);
    }

    // prompt
    if (this.holding) {
      this.showPrompt(this.held, this.heldProgress(w));
    } else if (this.best.valid) {
      this.showPrompt(this.best, this.best.continuous ? this.areaProgress(w, this.best.id) : 0);
    } else if (this.hint.valid) {
      this.showPrompt(this.hint, 0);
    } else {
      this.showPrompt(null, 0);
    }
  }

  dispose() {
    this.cancelHold();
    this.showPrompt(null, 0);
  }

  // ----------------------------------------------------------------------------------------------
  // Candidates
  // ----------------------------------------------------------------------------------------------
  private gather(w: WorldState, pl: PlayerApi) {
    this.best.clear();
    this.hint.clear();
    this.heldValid = false;
    this.feet = pl.position;

    // "in front" = where the camera looks (third person); fall back to the body's facing
    this.ctx.camera.getWorldDirection(_fwd);
    const len = Math.hypot(_fwd.x, _fwd.z);
    if (len > 1e-3) { this.fx = _fwd.x / len; this.fz = _fwd.z / len; } else { this.fx = -Math.sin(pl.ry); this.fz = -Math.cos(pl.ry); }

    const me = w.players[this.ctx.myId];
    const slot = me.slot;
    const carrying = this.myCarry.get(w);
    const heavy = !!carrying && isHeavy(carrying);
    const gearReady = this.gearReady.get(w);
    const suppressing = this.suppressT > 0 && w.v === this.suppressV;
    const c = this.tmp;

    // 1. game interactions from the rules
    for (const it of this.rules.get(w)) {
      if (suppressing && it.id === this.suppressId) continue;
      // once all gear is at the launch the bundles stay there (see gearAtLaunch)
      if (gearReady && it.id.startsWith('pickup:bundle_')) continue;
      const area = it.radius >= AREA_RADIUS;
      const s = area ? this.score(it.p, it.radius, -3.5, 4, true) : this.score(it.p, it.radius, -1.0, 1.9, false);
      if (s === Infinity) continue;
      c.kind = 'rule';
      c.id = it.id;
      c.prompt = it.prompt;
      c.key = 'E';
      c.hold = it.hold;
      c.noise = it.noise;
      c.continuous = !!it.continuous;
      c.anim = ruleAnim(it.id);
      c.traverse = null;
      c.climb = null;
      c.reverse = false;
      c.score = s - RULE_BONUS;
      this.consider(c);
    }

    // 2. traverses (vent crawl, roof hatch, fence)
    for (let i = 0; i < TRAVERSES.length; i++) {
      const tr = TRAVERSES[i];
      if (tr.requires && !w.flags[tr.requires]) continue;
      if (tr.slot !== undefined && tr.slot !== slot) continue;
      const sa = this.score(tr.a, TRAVERSE_RADIUS, -1.0, 1.2, false);
      const sb = this.score(tr.b, TRAVERSE_RADIUS, -1.0, 1.2, false);
      if (sa === Infinity && sb === Infinity) continue;
      const fromA = sa <= sb;
      if (heavy && !tr.allowHeavy) { this.offerHint('prompt.handsFull', '', Math.min(sa, sb)); continue; }
      const id = fromA ? this.travIdA[i] : this.travIdB[i];
      if (suppressing && id === this.suppressId) continue;
      c.kind = 'traverse';
      c.id = id;
      c.prompt = tr.prompt;
      c.key = 'E';
      c.hold = tr.hold;
      c.noise = tr.noise;
      c.continuous = false;
      c.anim = tr.id.startsWith('crawl') ? 'crouch' : 'climb';
      c.traverse = tr;
      c.climb = null;
      c.reverse = !fromA;
      c.score = Math.min(sa, sb);
      this.consider(c);
    }

    // 3. climbs (utility pipes, bakery pipe)
    for (let i = 0; i < CLIMBS.length; i++) {
      const cl = CLIMBS[i];
      if (cl.requires && !w.flags[cl.requires]) continue;
      const sBottom = Math.min(this.score(cl.bottom, CLIMB_RADIUS, -1.0, 1.2, false), this.score(cl.exitBottom, CLIMB_RADIUS, -1.0, 1.2, false));
      const sTop = Math.min(this.score(cl.top, CLIMB_RADIUS, -1.0, 1.2, false), this.score(cl.exitTop, CLIMB_RADIUS, -1.0, 1.2, false));
      if (sBottom === Infinity && sTop === Infinity) continue;
      const fromTop = sTop < sBottom;
      // Bundles can't be climbed with. Going down a climb that has a drop point (the bakery pipe)
      // sends the bundle down first; any other climb would strand it, so it is refused.
      if (heavy && (!fromTop || !cl.dropHeavyTo)) { this.offerHint('prompt.handsFull', '', Math.min(sTop, sBottom)); continue; }
      const id = fromTop ? this.climbIdDown[i] : this.climbIdUp[i];
      if (suppressing && id === this.suppressId) continue;
      c.kind = 'climb';
      c.id = id;
      c.prompt = fromTop ? 'prompt.climbDown' : 'prompt.climbUp';
      c.key = 'E';
      c.hold = CLIMB_HOLD;
      c.noise = 0.05;
      c.continuous = false;
      c.anim = 'climb';
      c.traverse = null;
      c.climb = cl;
      c.reverse = fromTop;
      c.score = Math.min(sTop, sBottom);
      this.consider(c);
    }

    // 4. non-actionable hints, shown only when nothing else is in reach
    if (carrying) {
      for (const id in w.items) {
        const it = w.items[id as ItemId];
        if (it.by !== '' || (gearReady && isHeavy(id as ItemId))) continue;
        const s = this.score(it.p, 1.4, -1.0, 1.9, false);
        if (s < Infinity) this.offerHint('prompt.handsFull', '', s);
      }
      this.offerHint('prompt.drop', 'G', 50);
    }
    const cell = PLAYER_CELLS[slot];
    if (cell && Math.abs(this.feet.x - cell.center[0]) < 0.76 && zoneAt(this.feet.x, this.feet.y + 0.1, this.feet.z) === 'cell') {
      this.offerHint('prompt.music', 'Q', 60);
    }
  }

  /**
   * Distance score of a target, Infinity when out of reach. Targets in front of the camera score
   * as their distance; behind the player up to 2.2x. Areas score a flat low value inside.
   */
  private score(p: V3, radius: number, dyMin: number, dyMax: number, area: boolean): number {
    const f = this.feet!;
    const dy = p[1] - f.y;
    if (dy < dyMin || dy > dyMax) return Infinity;
    const dx = p[0] - f.x, dz = p[2] - f.z;
    const d = Math.hypot(dx, dz);
    if (d > radius) return Infinity;
    if (area) return 0.25;
    const facing = d > 0.25 ? (dx * this.fx + dz * this.fz) / d : 1;
    return d * (1.6 - 0.6 * facing);
  }

  private consider(c: Candidate) {
    if (this.holding && c.id === this.held.id) {
      this.heldValid = true;
      const progress = this.holdT;
      this.held.copy(c); // refresh (e.g. rule objects after a world update)
      this.holdT = progress;
    }
    if (c.score < this.best.score) this.best.copy(c);
  }

  private offerHint(prompt: string, key: string, score: number) {
    if (score >= this.hint.score) return;
    const h = this.hint;
    h.kind = 'hint';
    h.id = prompt; // i18n keys never collide with rules/traverse/climb ids
    h.prompt = prompt;
    h.key = key;
    h.hold = 0;
    h.noise = 0;
    h.continuous = false;
    h.traverse = null;
    h.climb = null;
    h.score = score;
  }

  // ----------------------------------------------------------------------------------------------
  // Holding
  // ----------------------------------------------------------------------------------------------
  private beginHold(w: WorldState, pl: PlayerApi) {
    this.held.copy(this.best);
    this.holdT = 0;
    this.progressAccum = 0;
    this.progressSend = 0;
    this.heldValid = true;
    if (this.held.hold <= 0 && !this.held.continuous) {
      this.complete(w, pl);
      return;
    }
    this.holding = true;
    pl.setWorking(true, this.held.anim);
    (pl as PlayerApi & HoldReporter).setHolding?.(this.held.id);
  }

  private advanceHold(dt: number, w: WorldState, pl: PlayerApi) {
    const h = this.held;
    pl.addNoise(h.noise);
    if (h.continuous) {
      this.progressAccum += dt;
      this.progressSend += dt;
      if (this.progressSend >= PROGRESS_INTERVAL) this.flushProgress();
      return;
    }
    this.holdT += dt;
    if (this.holdT >= h.hold) this.complete(w, pl);
  }

  private flushProgress() {
    if (this.progressAccum > 0.02 && this.held.continuous) {
      this.ctx.net.act({ k: 'progress', id: this.held.id, amount: Math.round(this.progressAccum * 1000) / 1000 });
    }
    this.progressAccum = 0;
    this.progressSend = 0;
  }

  private cancelHold() {
    if (!this.holding) return;
    this.flushProgress();
    this.holding = false;
    this.holdT = 0;
    const pl = this.ctx.player;
    if (pl) {
      pl.setWorking(false);
      (pl as PlayerApi & HoldReporter).setHolding?.('');
    }
  }

  private complete(w: WorldState, pl: PlayerApi) {
    const c = this.held;
    if (this.holding) {
      pl.setWorking(false);
      (pl as PlayerApi & HoldReporter).setHolding?.('');
    }
    this.holding = false;
    this.holdT = 0;
    this.needRelease = true;
    // hide the finished candidate until the host's answer arrives (new world version)
    this.suppressId = c.id;
    this.suppressV = w.v;
    this.suppressT = 1.5;

    switch (c.kind) {
      case 'rule':
        this.ctx.net.act({ k: 'interact', id: c.id });
        break;
      case 'traverse':
        if (c.traverse) {
          pl.startTraverse(c.traverse, !c.reverse).catch((err) => console.warn('[interact] traverse failed', err));
        }
        break;
      case 'climb': {
        const cl = c.climb;
        if (!cl) break;
        const carrying = this.myCarry.get(w);
        if (c.reverse && carrying && isHeavy(carrying) && cl.dropHeavyTo) {
          // the bundle goes down first (dropped to the foot of the pipe), then the player follows
          this.ctx.net.act({ k: 'drop', item: carrying, p: [...cl.dropHeavyTo] as V3 });
          this.ctx.bus.emit('toast', t('toast.dropHeavy'));
        }
        pl.startClimb(cl, c.reverse);
        break;
      }
      case 'hint':
        break;
    }
    if (c.noise >= LOUD) this.reportNoise(pl.position.x, pl.position.y, pl.position.z, c.noise);
  }

  private dropOrThrow(item: ItemId, throwIt: boolean) {
    const items = this.ctx.items;
    if (!items) return;
    const p = items.dropPoint(throwIt);
    this.ctx.net.act(throwIt ? { k: 'throw', item, p } : { k: 'drop', item, p });
    this.actionCooldown = 0.5;
    // a steel drill clattering onto concrete carries
    if (throwIt && item === 'drill') this.reportNoise(p[0], p[1], p[2], 0.6);
  }

  private reportNoise(x: number, y: number, z: number, noise: number) {
    this.ctx.bus.emit('noise', { p: [x, y, z], r: TUNING.guard.hearing * noise });
  }

  /** 0..1 progress of the action being held */
  private heldProgress(w: WorldState): number {
    const h = this.held;
    if (h.continuous) return this.areaProgress(w, h.id) + this.progressAccum / INFLATE_SECONDS;
    return h.hold > 0 ? Math.min(1, this.holdT / h.hold) : 0;
  }

  /** shared progress of a continuous task (the raft's inflation) */
  private areaProgress(w: WorldState, id: string): number {
    return id === 'inflate' ? Math.min(1, w.raft.inflate) : 0;
  }

  // ----------------------------------------------------------------------------------------------
  // HUD prompt
  // ----------------------------------------------------------------------------------------------
  private showPrompt(c: Candidate | null, progress: number) {
    if (!c) {
      if (this.promptShown) {
        this.promptShown = false;
        this.promptId = '';
        this.ctx.bus.emit('prompt', null);
      }
      return;
    }
    const lang = getLang();
    let changed = !this.promptShown || c.id !== this.promptId || lang !== this.promptLang;
    if (changed) {
      this.promptText = this.textFor(c);
      this.promptId = c.id;
      this.promptLang = lang;
    }
    const prog = Math.min(1, Math.max(0, progress));
    if (Math.abs(prog - this.promptProgress) > 0.004) changed = true;
    if (!changed) return;
    this.promptProgress = prog;
    this.promptShown = true;
    this.promptFlip = !this.promptFlip;
    const msg = this.promptFlip ? this.promptA : this.promptB;
    msg.text = this.promptText;
    // continuous tasks show their shared progress on the ring; hold 1 keeps the ring visible
    msg.hold = c.continuous ? 1 : c.hold;
    msg.progress = prog;
    msg.key = c.key;
    this.ctx.bus.emit('prompt', msg);
  }

  private textFor(c: Candidate): string {
    if (c.prompt === 'prompt.drop' && !isTouch) return `${t('prompt.drop')}   [F] ${t('prompt.throw')}`;
    return t(c.prompt);
  }
}

/** work animation for a rules interaction id */
function ruleAnim(id: string): PrisonerAnim {
  if (id.startsWith('pickup:') || id.startsWith('dummy:')) return 'pickup';
  if (id === 'board') return 'crouch';
  return 'work';
}
