// In-game HUD (world.phase === 'playing'): chapter + objectives (rules.objectives), the objective
// marker (rules.objectiveTarget projected with ctx.camera, clamped to the screen edge), night clock,
// next-count timer, alarm pips, zone/area name, crew list, noise/exposure meters, interaction prompt
// with a hold ring, count/hole/chase banners, the alarm vignette and the corner radar.
// Per-frame work is limited to the marker and meter transforms; everything else runs at 2-10 Hz and
// writes the DOM only when a value changes.
import * as THREE from 'three/webgpu';
import { isTouch, TUNING } from '../config';
import type { BusEvents, Ctx, LightingApi } from '../game/context';
import { objectives, objectiveTarget } from '../game/rules';
import { ITEM_IDS, type ChapterId, type V3, type WorldState, type ZoneId } from '../game/types';
import { t } from '../i18n';
import {
  AISLES, ANGEL_ISLAND_DIR, FLOOR, GUN_GALLERIES, HOLE_CELLS, LAUNCH, LIBRARY, PLAYER_CELLS, zoneAt,
} from '../world/layout';
import { rosterSlots, SLOT_COLORS } from './common';
import { Flag, fmtMMSS, h, keyLabel, nightClock, TextSlot } from './dom';
import { CornerMap, type MapCrew, type MapData } from './minimap';

const RING_C = 2 * Math.PI * 21;
const SVG_NS = 'http://www.w3.org/2000/svg';
const INDOOR: ReadonlySet<ZoneId> = new Set<ZoneId>(['cell', 'utility', 'workshop', 'floor', 'dblock']);
/** Aisle boxes in priority order (the west/east ends overlap the long aisles). */
const AREAS: [string, readonly [number, number, number, number]][] = [
  ['timesSquare', AISLES.timesSquare], ['eastEnd', AISLES.eastEnd], ['broadway', AISLES.broadway],
  ['michigan', AISLES.michigan], ['park', AISLES.park], ['sunset', AISLES.sunset], ['northAisle', AISLES.northAisle],
];
/** Once aboard, the marker points at the fog bank toward Angel Island. */
const FOG_TARGET: V3 = [
  LAUNCH.p[0] + ANGEL_ISLAND_DIR[0] * (TUNING.fogBankDistance + 15), 0.5,
  LAUNCH.p[2] + ANGEL_ISLAND_DIR[2] * (TUNING.fogBankDistance + 15),
];

interface CrewRow { el: HTMLElement; dot: HTMLElement; name: TextSlot; status: TextSlot; where: TextSlot; carry: TextSlot; state: string; color: string }
type Objective = ReturnType<typeof objectives>[number];

export class Hud {
  readonly el: HTMLElement;
  /** set by the UI: the touch controls highlight their Interact button */
  onPromptActive: ((on: boolean) => void) | null = null;
  /** crew snapshot for the maps (refreshed at 2 Hz) */
  crew: MapCrew[] = [];
  private visible = false;

  private readonly objPanel: HTMLElement;
  private readonly objNum: TextSlot;
  private readonly objTitle: TextSlot;
  private readonly objText: TextSlot;
  private readonly objList: HTMLElement;
  private readonly carry: TextSlot;
  private readonly tabFlag: Flag;
  private objSig = '';
  private chapter: ChapterId = 'lights_out';
  private objs: Objective[] = [];

  private readonly clock: TextSlot;
  private readonly countLabel: TextSlot;
  private readonly countTime: TextSlot;
  private readonly countLive: Flag;
  private readonly countSoon: Flag;
  private readonly pips: HTMLElement[] = [];
  private alarmShown = -1;

  private readonly zoneName: TextSlot;
  private readonly areaName: TextSlot;
  private zone: ZoneId = 'cell';

  private readonly crewPanel: HTMLElement;
  private readonly crewList: HTMLElement;
  private readonly crewHidden: Flag;
  private readonly rows = new Map<string, CrewRow>();
  private crewOrder = '';

  private readonly noiseFill: HTMLElement;
  private readonly lightFill: HTMLElement;
  private readonly noiseHot: Flag;
  private readonly lightHot: Flag;
  private noiseV = 0; private lightV = 0; private noiseT = 0; private lightT = 0;
  private noiseShown = -1; private lightShown = -1;
  private myMusic = false;

  private readonly prompt: HTMLElement;
  private readonly promptHidden: Flag;
  private readonly promptKey: TextSlot;
  private readonly promptText: TextSlot;
  private readonly promptHold: Flag;
  private readonly promptNoKey: Flag;
  private readonly ring: SVGCircleElement;
  private ringShown = -1;
  private promptOn = false;
  private lastPrompt: BusEvents['prompt'] = null;

  private readonly marker: HTMLElement;
  private readonly markerArrow: HTMLElement;
  private readonly markerHidden: Flag;
  private readonly markerOff: Flag;
  private readonly markerDist: TextSlot;
  private readonly markerLabel: TextSlot;
  private target: V3 | null = null;
  private targetKey = '';
  private mx = -1; private my = -1; private mAng = 99; private mDist = -1;

  private readonly countBanner: Flag;
  private readonly bunkWarn: Flag;
  private readonly holeBanner: Flag;
  private readonly holeText: TextSlot;
  private readonly chaseBanner: Flag;
  private readonly suspBanner: Flag;
  private readonly musicBadge: Flag;
  private readonly hint: Flag;
  private readonly vignette: HTMLElement;
  private readonly flash: HTMLElement;
  private readonly vigPulse: Flag;
  private vigShown = -1;
  private flashTimer = 0;

  private readonly minimap: CornerMap;
  private slow = 0;
  private mid = 0;
  private crewTimer = 0;
  private mapAcc = 0;
  private W = innerWidth;
  private H = innerHeight;
  private readonly v = new THREE.Vector3();

  private readonly fromTmp: V3 = [0, 0, 0];

  constructor(parent: HTMLElement, private readonly ctx: Ctx) {
    // --- top left: objectives + crew
    this.objNum = new TextSlot(h('span', 'obj-num'));
    this.objTitle = new TextSlot(h('span', 'obj-title'));
    this.objText = new TextSlot(h('p', 'obj-story'));
    this.objList = h('ul', 'obj-list');
    this.carry = new TextSlot(h('div', 'obj-carry'));
    this.objPanel = h('section', 'panel obj-panel',
      h('header', 'panel-tab', this.objNum.el, this.objTitle.el),
      this.objList, this.carry.el, this.objText.el);
    this.tabFlag = new Flag(this.objPanel, 'expanded');
    this.crewList = h('ul', 'crew-list');
    this.crewPanel = h('section', 'panel crew-panel', h('header', { cls: 'panel-tab', i18n: 'hud.crew' }), this.crewList);
    this.crewHidden = new Flag(this.crewPanel, 'hidden');

    // --- top centre: clock, count timer, alarm pips, banners
    this.clock = new TextSlot(h('div', 'clock'));
    this.countLabel = new TextSlot(h('span', 'count-label'));
    this.countTime = new TextSlot(h('span', 'count-time'));
    const countBox = h('div', 'count', this.countLabel.el, this.countTime.el);
    this.countLive = new Flag(countBox, 'live');
    this.countSoon = new Flag(countBox, 'soon');
    const pipBox = h('div', 'alarm', h('span', { cls: 'alarm-label', i18n: 'hud.alarm' }));
    for (let i = 0; i < 3; i++) { const p = h('i', 'pip'); this.pips.push(p); pipBox.append(p); }
    const banner = (cls: string, key?: string) => h('div', key ? { cls: `banner ${cls} hidden`, i18n: key } : `banner ${cls} hidden`);
    const countBannerEl = banner('banner-count', 'hud.countBanner');
    const bunkEl = banner('banner-warn', 'hud.bunkEmpty');
    this.holeText = new TextSlot(h('div', 'banner-hole-title'));
    const holeEl = h('div', 'banner banner-hole hidden', this.holeText.el, h('div', { cls: 'banner-hole-hint', i18n: 'hud.holeHint' }));
    const chaseEl = banner('banner-chase', 'hud.chased');
    const suspEl = banner('banner-susp', 'hud.suspicious');
    const musicEl = banner('banner-music', 'hud.music');
    this.countBanner = new Flag(countBannerEl, 'hidden');
    this.bunkWarn = new Flag(bunkEl, 'hidden');
    this.holeBanner = new Flag(holeEl, 'hidden');
    this.chaseBanner = new Flag(chaseEl, 'hidden');
    this.suspBanner = new Flag(suspEl, 'hidden');
    this.musicBadge = new Flag(musicEl, 'hidden');

    // --- top right: radar + zone
    this.zoneName = new TextSlot(h('div', 'zone-name'));
    this.areaName = new TextSlot(h('div', 'zone-area'));
    const tr = h('div', 'hud-tr');
    this.minimap = new CornerMap(tr);
    tr.append(h('div', 'zone', this.zoneName.el, this.areaName.el));

    // --- bottom left: meters
    this.noiseFill = h('i', 'meter-fill');
    this.lightFill = h('i', 'meter-fill');
    const noiseM = h('div', 'meter meter-noise', h('span', { cls: 'meter-label', i18n: 'hud.noise' }), h('span', 'meter-bar', this.noiseFill));
    const lightM = h('div', 'meter meter-light', h('span', { cls: 'meter-label', i18n: 'hud.light' }), h('span', 'meter-bar', this.lightFill));
    this.noiseHot = new Flag(noiseM, 'hot');
    this.lightHot = new Flag(lightM, 'hot');

    // --- bottom centre: interaction prompt with hold ring
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 48 48');
    svg.setAttribute('class', 'ring-svg');
    const bg = document.createElementNS(SVG_NS, 'circle');
    this.ring = document.createElementNS(SVG_NS, 'circle');
    for (const c of [bg, this.ring]) { c.setAttribute('cx', '24'); c.setAttribute('cy', '24'); c.setAttribute('r', '21'); svg.append(c); }
    bg.setAttribute('class', 'ring-bg');
    this.ring.setAttribute('class', 'ring-fg');
    this.ring.setAttribute('stroke-dasharray', RING_C.toFixed(2));
    this.ring.setAttribute('stroke-dashoffset', RING_C.toFixed(2));
    this.promptKey = new TextSlot(h('span', 'prompt-keycap'));
    const holdEl = h('span', { cls: 'prompt-hold', i18n: 'hud.hold' });
    this.promptHold = new Flag(holdEl, 'hidden');
    this.promptText = new TextSlot(h('span', 'prompt-text'));
    const keyEl = h('div', 'prompt-key', svg, this.promptKey.el);
    this.promptNoKey = new Flag(keyEl, 'hidden');
    this.prompt = h('div', 'prompt hidden', keyEl, h('div', 'prompt-body', holdEl, this.promptText.el));
    this.promptHidden = new Flag(this.prompt, 'hidden');

    // --- objective marker
    this.markerArrow = h('i', 'marker-arrow');
    this.markerDist = new TextSlot(h('span', 'marker-dist'));
    this.markerLabel = new TextSlot(h('span', 'marker-label'));
    this.marker = h('div', 'marker hidden', h('div', 'marker-pin', this.markerArrow, h('span', 'marker-diamond')), this.markerDist.el, this.markerLabel.el);
    this.markerHidden = new Flag(this.marker, 'hidden');
    this.markerOff = new Flag(this.marker, 'off');

    const hintEl = h('div', { cls: 'look-hint hidden', i18n: 'hud.clickToLook' });
    this.hint = new Flag(hintEl, 'hidden');
    this.vignette = h('div', 'vignette');
    this.flash = h('div', 'alarm-flash');
    this.vigPulse = new Flag(this.vignette, 'pulse');

    this.el = h('div', 'hud hidden',
      this.vignette, this.flash, this.marker,
      h('div', 'hud-tl', this.objPanel, this.crewPanel),
      h('div', 'hud-tc', h('div', 'clockbox', this.clock.el, countBox, pipBox), countBannerEl, bunkEl, holeEl, chaseEl, suspEl, musicEl),
      tr,
      h('div', 'hud-bl', noiseM, lightM),
      h('div', 'hud-bc', hintEl, this.prompt));
    if (isTouch) this.el.classList.add('is-touch');
    parent.append(this.el);
    addEventListener('resize', () => this.resize());
  }

  setMapData(d: MapData) { this.minimap.setData(d); }

  setVisible(on: boolean) {
    if (on === this.visible) return;
    this.visible = on;
    this.el.classList.toggle('hidden', !on);
    if (on) this.resize();
    this.onPrompt(this.lastPrompt); // show / hide a prompt that changed while the HUD was hidden
  }

  resize() {
    this.W = innerWidth;
    this.H = innerHeight;
    this.mx = this.my = -1;
    if (this.visible) this.minimap.resize();
  }

  /** Target for the maps (same as the marker). */
  get objectiveTarget(): V3 | null { return this.target; }

  // ----------------------------------------------------------------------------------------------
  // Event-driven parts
  // ----------------------------------------------------------------------------------------------
  onWorld(w: WorldState) {
    const myId = this.ctx.myId;
    const me = w.players[myId];
    const objs = objectives(w, myId) ?? [];
    let sig = w.chapter;
    for (const o of objs) sig += `|${o.key}${o.done ? 1 : 0}${o.progress ?? ''}`;
    if (sig !== this.objSig) {
      this.objSig = sig;
      this.chapter = w.chapter;
      this.objs = objs;
      this.renderObjectives();
    }
    let carried = '';
    for (const id of ITEM_IDS) if (w.items[id].by === myId) carried = t('hud.carrying', { item: t(`item.${id}`) });
    this.carry.set(carried);
    if (w.alarm !== this.alarmShown) {
      this.alarmShown = w.alarm;
      for (let i = 0; i < 3; i++) this.pips[i].classList.toggle('on', i < w.alarm);
    }
    this.updateTarget(w);
  }

  /** Where to go next. Position-dependent (the descent follows the route), so also run at 4 Hz. */
  private updateTarget(w: WorldState) {
    const me = w.players[this.ctx.myId];
    if (w.phase !== 'playing' || !me) this.target = null;
    else if (me.s === 'aboard') this.target = FOG_TARGET;
    else if (me.s !== 'free') this.target = null;
    else if (w.chapter === 'bay' && w.raft.launched) this.target = null;
    else {
      const pl = this.ctx.player;
      if (pl) { this.fromTmp[0] = pl.position.x; this.fromTmp[1] = pl.position.y; this.fromTmp[2] = pl.position.z; }
      this.target = objectiveTarget(w, this.ctx.myId, pl ? this.fromTmp : undefined);
    }
    const key = me?.s === 'aboard' ? 'hud.fogBank' : '';
    if (key !== this.targetKey) { this.targetKey = key; this.markerLabel.set(key ? t(key) : ''); }
  }

  onPrompt(p: BusEvents['prompt']) {
    this.lastPrompt = p;
    const on = !!p && this.visible;
    if (on !== this.promptOn) {
      this.promptOn = on;
      this.promptHidden.set(!on);
      this.onPromptActive?.(on);
    }
    if (!p) return;
    this.promptText.set(p.text);
    // '' = a plain hint (hands full): no key cap. Touch has no keys: a finger on the Use button.
    const cap = !p.key ? '' : isTouch ? (keyLabel(p.key) === 'E' ? '☝' : '') : keyLabel(p.key);
    this.promptKey.set(cap);
    this.promptNoKey.set(!cap && !(p.hold > 0));
    this.promptHold.set(!(p.hold > 0));
    const prog = p.hold > 0 ? Math.min(1, Math.max(0, p.progress)) : 0;
    if (Math.abs(prog - this.ringShown) > 0.004) {
      this.ringShown = prog;
      this.ring.setAttribute('stroke-dashoffset', (RING_C * (1 - prog)).toFixed(2));
    }
  }

  flashAlarm() {
    this.flash.classList.remove('flash');
    void this.flash.offsetWidth;
    this.flash.classList.add('flash');
    clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => this.flash.classList.remove('flash'), 1400);
  }

  relabel() {
    this.objSig = '';
    this.renderObjectives();
    for (const s of [this.clock, this.countLabel, this.countTime, this.zoneName, this.areaName, this.carry, this.holeText, this.markerLabel]) s.reset();
    for (const r of this.rows.values()) { r.name.reset(); r.status.reset(); r.where.reset(); r.carry.reset(); }
    this.targetKey = '';
    this.mDist = -1;
    const w = this.ctx.world();
    if (w) this.onWorld(w);
    this.slow = this.crewTimer = 0;
  }

  private renderObjectives() {
    const c = this.chapter;
    this.objNum.set(t(`chapter.${c}.num`));
    this.objTitle.set(t(`chapter.${c}`));
    this.objText.set(t(`chapter.${c}.text`));
    let current = false;
    this.objList.replaceChildren(...this.objs.map((o) => {
      const isCurrent = !o.done && !current;
      if (isCurrent) current = true;
      return h('li', `obj${o.done ? ' done' : ''}${isCurrent ? ' current' : ''}`,
        h('span', 'obj-box'), h('span', { cls: 'obj-text', text: t(o.key) }),
        o.progress ? h('span', { cls: 'obj-prog', text: o.progress }) : null);
    }));
  }

  // ----------------------------------------------------------------------------------------------
  // Per frame
  // ----------------------------------------------------------------------------------------------
  update(dt: number, menusOpen: boolean) {
    if (!this.visible) return;
    const ctx = this.ctx;
    const w = ctx.world();
    this.tabFlag.set(!menusOpen && ctx.input.isDown('Tab'));
    this.hint.set(isTouch || ctx.input.locked || menusOpen);
    this.updateMarker(menusOpen);
    this.updateMeters(dt);
    if ((this.mid -= dt) <= 0) { this.mid = 0.1; this.sample(); }
    if ((this.slow -= dt) <= 0) { this.slow = 0.25; this.tickSlow(w); }
    if ((this.crewTimer -= dt) <= 0) { this.crewTimer = 0.5; this.renderCrew(w); }
    this.mapAcc += dt;
    if (this.mapAcc >= (ctx.quality.tier === 'low' ? 1 / 15 : 1 / 30)) {
      this.minimap.draw(ctx, this.crew, this.target, INDOOR.has(this.zone), this.mapAcc);
      this.mapAcc = 0;
    }
  }

  private updateMarker(hide: boolean) {
    const tg = this.target, p = this.ctx.player;
    if (!tg || !p || hide) { this.markerHidden.set(true); return; }
    this.markerHidden.set(false);
    const cam = this.ctx.camera;
    const W = this.W, H = this.H, m = 46;
    cam.updateMatrixWorld();
    const v = this.v.set(tg[0], tg[1] + 1.1, tg[2]).applyMatrix4(cam.matrixWorldInverse);
    const vx = v.x, vy = v.y;
    const behind = v.z > -0.05;
    let sx = 0, sy = 0, on = false;
    if (!behind) {
      v.applyMatrix4(cam.projectionMatrix);
      sx = (v.x * 0.5 + 0.5) * W;
      sy = (-v.y * 0.5 + 0.5) * H;
      on = sx >= m && sx <= W - m && sy >= m && sy <= H - m;
    }
    let ang = 0;
    if (!on) {
      let dx: number, dy: number;
      if (behind) {
        // behind the camera: slide along the bottom edge toward the side it is on
        dx = vx;
        dy = Math.max(-vy, 0) + Math.hypot(vx, vy) * 0.6 + 1e-3;
      } else {
        dx = sx - W / 2;
        dy = sy - H / 2;
      }
      const k = Math.min((W / 2 - m) / Math.max(Math.abs(dx), 1e-6), (H / 2 - m) / Math.max(Math.abs(dy), 1e-6));
      sx = W / 2 + dx * k;
      sy = H / 2 + dy * k;
      ang = Math.atan2(dy, dx);
    }
    this.markerOff.set(!on);
    if (Math.abs(sx - this.mx) > 0.5 || Math.abs(sy - this.my) > 0.5) {
      this.mx = sx;
      this.my = sy;
      this.marker.style.transform = `translate3d(${sx.toFixed(1)}px,${sy.toFixed(1)}px,0)`;
    }
    if (!on && Math.abs(ang - this.mAng) > 0.01) {
      this.mAng = ang;
      this.markerArrow.style.transform = `rotate(${ang.toFixed(3)}rad)`;
    }
    const pp = p.position;
    const d = Math.round(Math.hypot(pp.x - tg[0], pp.y - tg[1], pp.z - tg[2]));
    if (d !== this.mDist) {
      this.mDist = d;
      this.markerDist.set(d < 2 ? '' : t('hud.meters', { d }));
    }
  }

  /** 10 Hz: noise from the player's snapshot, exposure from the lighting API. */
  private sample() {
    const p = this.ctx.player;
    if (!p) { this.noiseT = this.lightT = 0; return; }
    const s = p.snapshot();
    this.noiseT = s.n;
    this.myMusic = s.m === 1;
    const lighting = this.ctx.lighting as LightingApi | null;
    this.lightT = lighting ? Math.min(1, Math.max(0, lighting.exposure(p.position))) : 0;
  }

  private updateMeters(dt: number) {
    const k = Math.min(1, dt * 8);
    this.noiseV += (this.noiseT - this.noiseV) * k;
    this.lightV += (this.lightT - this.lightV) * k;
    if (Math.abs(this.noiseV - this.noiseShown) > 0.006) {
      this.noiseShown = this.noiseV;
      this.noiseFill.style.transform = `scaleX(${this.noiseV.toFixed(3)})`;
      this.noiseHot.set(this.noiseV > 0.5);
    }
    if (Math.abs(this.lightV - this.lightShown) > 0.006) {
      this.lightShown = this.lightV;
      this.lightFill.style.transform = `scaleX(${this.lightV.toFixed(3)})`;
      this.lightHot.set(this.lightV > 0.5);
    }
  }

  /** 4 Hz: clock, count, zone, banners, vignette. */
  private tickSlow(w: WorldState | null) {
    if (w) this.updateTarget(w);
    const ctx = this.ctx;
    const now = ctx.time();
    const playing = !!w && w.phase === 'playing';
    if (w && playing) {
      this.clock.set(nightClock(now - w.startT));
      const open = !!w.flags.countOpen;
      this.countLive.set(open);
      this.countSoon.set(!open && w.nextCount - now < 30);
      this.countLabel.set(t(open ? 'hud.countNow' : 'hud.nextCount'));
      this.countTime.set(fmtMMSS(open ? w.nextCount + 25 - now : w.nextCount - now));
    }

    const p = ctx.player;
    if (p) {
      const pos = p.position;
      const z: ZoneId = p.mode === 'seated' ? 'raft' : zoneAt(pos.x, pos.y, pos.z);
      this.zone = z;
      this.zoneName.set(t(`zone.${z}`));
      this.areaName.set(areaName(z, pos.x, pos.y, pos.z));
    }

    const me = w?.players[ctx.myId];
    if (w && me?.s === 'hole') {
      this.holeText.set(t('hud.hole', { time: fmtMMSS((me.until ?? now) - now) }));
      this.holeBanner.set(false);
    } else this.holeBanner.set(true);
    const countOpen = playing && !!w.flags.countOpen;
    this.countBanner.set(!countOpen);
    const exposed = playing && me?.s === 'free' && !w.flags[`dummy:${me.slot}`] && this.zone !== 'cell';
    this.bunkWarn.set(!(exposed && (countOpen || w.nextCount - now < 20)));

    // guards: who is watching / chasing me
    let chased = false, susp = 0;
    const actors = ctx.actors();
    if (actors && me?.s === 'free') {
      for (const g of actors.g) {
        if (g.t !== ctx.myId) continue;
        if (g.m === 'chase') chased = true;
        if (g.s > susp) susp = g.s;
      }
    }
    this.chaseBanner.set(!chased);
    this.suspBanner.set(chased || susp < 0.25);

    // concertina cover (work noise is masked near anyone playing)
    let music = this.myMusic;
    if (!music && p) {
      for (const m of this.crew) {
        if (m.isMe) continue;
        const ps = ctx.net.getPlayerState(m.id);
        if (ps?.m && Math.hypot(ps.p[0] - p.position.x, ps.p[1] - p.position.y, ps.p[2] - p.position.z) <= TUNING.noise.concertinaRange) { music = true; break; }
      }
    }
    this.musicBadge.set(!(music && playing && (this.zone === 'cell' || this.zone === 'utility')));

    const vig = Math.max(chased ? 0.85 : 0, w ? (w.alarm / 3) * 0.5 : 0, susp * 0.45);
    if (Math.abs(vig - this.vigShown) > 0.02) {
      this.vigShown = vig;
      this.vignette.style.setProperty('--vig', vig.toFixed(2));
    }
    this.vigPulse.set(chased);
  }

  /** 2 Hz: crew rows (name, status, where, carried item). */
  private renderCrew(w: WorldState | null) {
    const net = this.ctx.net;
    const roster = rosterSlots(net, w);
    this.crewHidden.set(roster.length <= 1);
    this.crew = roster.map(({ p, slot }) => ({
      id: p.id, color: p.color || SLOT_COLORS[slot], initial: (p.name || '?').slice(0, 1).toUpperCase(), isMe: p.isMe,
    }));
    let order = '';
    for (const { p, slot } of roster) {
      order += `${p.id},`;
      let row = this.rows.get(p.id);
      if (!row) {
        row = {
          el: h('li', 'crew-row'), dot: h('i', 'dot'), name: new TextSlot(h('span', 'crew-name')),
          status: new TextSlot(h('span', 'crew-status')), where: new TextSlot(h('span', 'crew-where')),
          carry: new TextSlot(h('span', 'crew-carry')), state: '', color: '',
        };
        row.el.append(row.dot, h('div', 'crew-main', h('div', 'crew-line', row.name.el, row.status.el), h('div', 'crew-line crew-sub', row.where.el, row.carry.el)));
        this.rows.set(p.id, row);
      }
      const color = p.color || SLOT_COLORS[slot];
      if (color !== row.color) { row.color = color; row.dot.style.background = color; }
      row.name.set(p.isMe ? `${p.name} ${t('hud.you')}` : p.name);
      const st = w?.players[p.id]?.s ?? 'free';
      row.status.set(t(`status.${st}`));
      if (st !== row.state) {
        row.el.classList.remove(`st-${row.state}`);
        row.el.classList.add(`st-${st}`);
        row.state = st;
      }
      const z = p.isMe ? this.zone : net.getPlayerState(p.id)?.z;
      row.where.set(z ? t(`zone.${z}`) : '');
      let carried = '';
      if (w) for (const id of ITEM_IDS) if (w.items[id].by === p.id) carried = t(`item.${id}`);
      row.carry.set(carried);
    }
    if (order !== this.crewOrder) {
      this.crewOrder = order;
      const keep = new Set(roster.map((r) => r.p.id));
      for (const [id, row] of this.rows) if (!keep.has(id)) { row.el.remove(); this.rows.delete(id); }
      this.crewList.replaceChildren(...roster.map((r) => this.rows.get(r.p.id)!.el));
    }
  }
}

/** Finer place name inside the cellhouse: aisle, library, gun gallery, cell / hole number. */
function areaName(z: ZoneId, x: number, y: number, zz: number): string {
  if (z === 'cell') {
    for (const c of PLAYER_CELLS) if (Math.abs(x - c.center[0]) < 0.8) return c.label;
    return '';
  }
  if (z === 'dblock') {
    for (const hc of HOLE_CELLS) if (Math.abs(x - hc.inside[0]) < 1.05 && zz < 17.1) return hc.label;
    return '';
  }
  if (z !== 'floor') return '';
  if (y > FLOOR + 2) {
    for (const g of [GUN_GALLERIES.west, GUN_GALLERIES.east]) {
      const b = g.box;
      if (x >= b[0] && x <= b[2] && zz >= b[1] && zz <= b[3]) return t('area.gallery');
    }
  }
  const lb = LIBRARY.box;
  if (x >= lb[0] && x <= lb[2] && zz >= lb[1] && zz <= lb[3]) return t('area.library');
  for (const [name, b] of AREAS) if (x >= b[0] && x <= b[2] && zz >= b[1] && zz <= b[3]) return t(`area.${name}`);
  return '';
}
