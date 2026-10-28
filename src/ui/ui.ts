// UI root: owns every screen and overlay inside #ui and switches between them from the world phase
// (title -> connecting -> briefing -> HUD -> end screen), plus the pause menu, the map, toasts,
// chapter cards and the fade. It manages pointer lock (menus release it; losing it while playing
// opens the pause menu, which is how Esc reaches us while the mouse is locked) and turns `fx`
// events into toasts, chapter cards and the caught stamp. Styled as a 1962 Bureau of Prisons file.
import './style.css';
import { isTouch } from '../config';
import type { Bus, Ctx } from '../game/context';
import type { Action, Fx, WorldState } from '../game/types';
import { getLang, onLangChange, t } from '../i18n';
import { Briefing } from './briefing';
import { playerName } from './common';
import { blurActive, h, relabel, requestLock } from './dom';
import { EndScreen } from './end';
import { Hud } from './hud';
import { loadMapData, MapView } from './minimap';
import { Overlays } from './overlays';
import { PauseMenu } from './pause';
import { TitleScreen } from './title';
import { TouchControls } from './touch';

export interface SessionLike { act(a: Action): void; isHost(): boolean }

type Mode = 'title' | 'briefing' | 'playing' | 'end';

const FONTS = 'https://fonts.googleapis.com/css2?family=Special+Elite&family=Stardos+Stencil:wght@400;700'
  + '&family=Courier+Prime:wght@400;700&family=Noto+Serif+SC:wght@400;600;900&display=swap';
const GOOD_TOASTS = new Set(['toast.dummy', 'toast.vent', 'toast.door', 'toast.roofvent', 'toast.inflated', 'toast.launched', 'toast.freed']);
const WARN_TOASTS = new Set(['toast.countMissed', 'toast.spotted', 'toast.leftBehind', 'toast.dropHeavy', 'toast.caught', 'toast.alarm']);

function loadFonts() {
  if (document.querySelector('link[data-fogbreak-fonts]')) return;
  for (const href of ['https://fonts.googleapis.com', 'https://fonts.gstatic.com']) {
    const l = document.createElement('link');
    l.rel = 'preconnect';
    l.href = href;
    if (href.includes('gstatic')) l.crossOrigin = '';
    document.head.append(l);
  }
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = FONTS;
  css.dataset.fogbreakFonts = '1';
  document.head.append(css);
}

/** Back to the title: reload without the room hash. */
function leaveGame() {
  location.replace(`${location.pathname}${location.search}`);
}

export class UI {
  private readonly root: HTMLElement;
  private readonly title: TitleScreen;
  private readonly overlays: Overlays;
  private ctx: Ctx | null = null;
  private hud: Hud | null = null;
  private briefing: Briefing | null = null;
  private end: EndScreen | null = null;
  private pause: PauseMenu | null = null;
  private map: MapView | null = null;
  private touch: TouchControls | null = null;
  private mode: Mode = 'title';
  /** we released pointer lock ourselves: don't treat it as Esc */
  private expectUnlock = false;
  private escGuard = 0;
  private mapTimer = 0;
  private namesTimer = 0;
  private lastChapterAt = -1e9;
  private readonly names = new Map<string, string>();

  constructor(readonly bus: Bus) {
    loadFonts();
    let root = document.querySelector<HTMLElement>('#ui');
    if (!root) { root = h('div', { attrs: { id: 'ui' } }); document.body.append(root); }
    this.root = root;
    root.classList.add('fb-ui');
    if (isTouch) root.classList.add('is-touch');
    this.overlays = new Overlays(root);
    this.title = new TitleScreen(root);
    root.append(h('div', { cls: 'rotate-hint', i18n: 'touch.rotate' }));
    bus.on('toast', (m) => this.overlays.toast(m));
    bus.on('fade', (f) => this.overlays.fade(f.to, f.duration));
    onLangChange(() => this.relabelAll());
    // canvas map labels use the web fonts: redraw once they arrive
    void document.fonts?.ready.then(() => { this.mapTimer = 0; });
  }

  /** Title screen; resolves when the player presses Play (online) or Solo (offline). */
  showTitle(opts: { invite: boolean }): Promise<{ mode: 'online' | 'offline'; name: string }> {
    return this.title.show(opts);
  }

  /** Loading progress 0..1 shown on the title screen; the Play buttons enable at 1. */
  setLoading(fraction: number, label: string) { this.title.setLoading(fraction, label); }

  toast(msg: string) { this.overlays.toast(msg); }

  /** Called once connected: creates HUD, lobby/briefing, end screens, pause menu, touch controls. */
  attach(ctx: Ctx, session: SessionLike) {
    if (this.ctx) return;
    this.ctx = ctx;
    const root = this.root;
    const toast = (m: string) => this.overlays.toast(m);
    this.hud = new Hud(root, ctx);
    this.map = new MapView(root, isTouch, () => this.setMap(false));
    this.briefing = new Briefing(root, ctx, session, toast);
    this.end = new EndScreen(root, ctx, session, leaveGame);
    this.pause = new PauseMenu(root, ctx, { onResume: () => this.closePause(true), onClose: () => this.closePause(false), onLeave: leaveGame, toast });
    if (isTouch) {
      const touch = new TouchControls(root, ctx.input, { onMenu: () => this.openPause(), onMap: () => this.setMap(!this.map!.open) });
      this.touch = touch;
      this.hud.onPromptActive = (on) => touch.setInteract(on);
    }
    loadMapData()
      .then((d) => { this.hud?.setMapData(d); this.map?.setData(d); })
      .catch((err) => console.warn('[ui] map unavailable', err));

    ctx.bus.on('world', (w) => this.onWorld(w));
    ctx.bus.on('prompt', (p) => this.hud?.onPrompt(p));
    ctx.bus.on('fx', (f) => this.onFx(f));
    ctx.bus.on('ui', (u) => {
      if (u === 'pause') this.openPause();
      else if (u === 'resume') this.closePause(false);
      else if (u === 'map' && this.mode === 'playing') this.setMap(!this.map!.open);
    });

    // join / leave toasts (players already in the room when we attach are not announced)
    const known = new Set<string>();
    for (const p of ctx.net.players()) { known.add(p.id); this.names.set(p.id, p.name); }
    ctx.net.onJoin((p) => {
      this.names.set(p.id, p.name);
      if (p.isMe || known.has(p.id)) return;
      known.add(p.id);
      this.overlays.toast(t('toast.joined', { name: p.name }), 'good');
    });
    ctx.net.onQuit((id) => {
      known.delete(id);
      this.overlays.toast(t('toast.left', { name: this.names.get(id) ?? '?' }), 'warn');
    });
    document.addEventListener('pointerlockchange', () => this.onLockChange());

    this.title.hide();
    this.setMode('briefing');
    const w = ctx.world();
    if (w) this.onWorld(w);
  }

  update(dt: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const input = ctx.input;
    if (this.escGuard > 0) this.escGuard -= dt;
    if (input.wasPressed('Escape') && this.escGuard <= 0) {
      if (this.map?.open) this.setMap(false);
      else if (this.pause?.isOpen) this.closePause(false);
      else if (this.mode === 'playing') this.openPause();
    }
    if (input.wasPressed('KeyM') && this.mode === 'playing' && !this.pause?.isOpen) this.setMap(!this.map!.open);

    const menus = this.menusOpen();
    this.hud?.update(dt, menus);
    this.briefing?.update(dt);
    if (this.map?.open && (this.mapTimer -= dt) <= 0) {
      this.mapTimer = 0.125;
      this.map.draw(ctx, this.hud!.crew, this.hud!.objectiveTarget);
    }
    if ((this.namesTimer -= dt) <= 0) {
      this.namesTimer = 1;
      for (const p of ctx.net.players()) this.names.set(p.id, p.name);
    }
  }

  // ----------------------------------------------------------------------------------------------
  private onWorld(w: WorldState) {
    this.hud?.onWorld(w);
    const mode: Mode = w.phase === 'briefing' ? 'briefing' : w.phase === 'playing' ? 'playing' : 'end';
    if (mode !== this.mode) this.setMode(mode);
    if (mode === 'end') this.end?.show(w);
  }

  private setMode(m: Mode) {
    const prev = this.mode;
    this.mode = m;
    blurActive();
    if (m === 'briefing') this.briefing?.show(); else this.briefing?.hide();
    this.hud?.setVisible(m === 'playing');
    if (m !== 'playing') {
      this.setMap(false);
      this.closePause(false);
    }
    if (m === 'end') this.overlays.hideChapter();
    else this.end?.hide();
    if (prev === 'end' && m !== 'end') this.overlays.fade(0, 0.3);
    this.touch?.setVisible(m === 'playing');
    this.syncPointer();
    if (m === 'playing' && prev !== 'playing') {
      // late joiners never receive the chapter fx: show the current chapter card instead
      const entered = performance.now();
      setTimeout(() => {
        const w = this.ctx?.world();
        if (this.mode === 'playing' && w && this.lastChapterAt < entered - 2000) this.showChapter(w.chapter);
      }, 900);
    }
  }

  private showChapter(c: WorldState['chapter']) {
    this.lastChapterAt = performance.now();
    this.overlays.chapter(t(`chapter.${c}.num`), t(`chapter.${c}`), t(`chapter.${c}.text`));
  }

  private onFx(f: Fx) {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = ctx.world();
    const name = (pid: string) => playerName(ctx.net, w, pid);
    switch (f.k) {
      case 'toast':
        this.overlays.toast(t(f.key, f.args), GOOD_TOASTS.has(f.key) ? 'good' : WARN_TOASTS.has(f.key) ? 'warn' : 'info');
        break;
      case 'chapter':
        this.showChapter(f.chapter);
        break;
      case 'caught':
        if (f.pid === ctx.myId) { this.overlays.caughtStamp(); this.setMap(false); }
        else this.overlays.toast(t('toast.caught', { name: name(f.pid) }), 'warn');
        break;
      case 'freed':
        if (f.pid === ctx.myId) this.overlays.toast(f.by ? t('toast.freedYou', { name: name(f.by) }) : t('toast.released'), 'good');
        else this.overlays.toast(t('toast.freed', { name: name(f.pid) }), 'good');
        break;
      case 'alarm':
        this.overlays.toast(t('toast.alarm', { level: f.level }), 'warn');
        this.hud?.flashAlarm();
        break;
      case 'count':
        this.overlays.toast(t(f.phase === 'start' ? 'toast.count' : 'toast.countEnd'), f.phase === 'start' ? 'warn' : 'info');
        break;
      default:
        break; // won/lost arrive as world phases; sfx belong to Audio
    }
  }

  // ----------------------------------------------------------------------------------------------
  // Menus and pointer lock
  // ----------------------------------------------------------------------------------------------
  private menusOpen() { return this.mode !== 'playing' || !!this.pause?.isOpen; }

  private syncPointer() {
    const ctx = this.ctx;
    if (!ctx) return;
    const blocked = this.menusOpen();
    ctx.input.pointerLockAllowed = !blocked && !isTouch;
    if (blocked && ctx.input.locked) {
      this.expectUnlock = true;
      ctx.input.exitPointerLock();
    }
  }

  private onLockChange() {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.input.locked) { this.expectUnlock = false; return; }
    if (this.expectUnlock) { this.expectUnlock = false; return; }
    // the browser released the lock (Esc, window switch): open the menu like Esc would
    if (this.mode === 'playing' && !this.pause?.isOpen) {
      this.openPause();
      this.escGuard = 0.35;
    }
  }

  private openPause() {
    const ctx = this.ctx;
    if (!ctx || !this.pause || this.mode !== 'playing' || this.pause.isOpen) return;
    this.pause.open();
    this.setMap(false);
    this.touch?.setVisible(false);
    ctx.player?.setFrozen(true);
    this.bus.emit('ui', 'pause');
    this.syncPointer();
  }

  private closePause(relock: boolean) {
    const ctx = this.ctx;
    if (!ctx || !this.pause?.isOpen) return;
    this.pause.close();
    blurActive();
    if (ctx.world()?.phase === 'playing') ctx.player?.setFrozen(false);
    this.touch?.setVisible(this.mode === 'playing');
    this.bus.emit('ui', 'resume');
    this.syncPointer();
    if (relock && this.mode === 'playing') requestLock(ctx.renderer.domElement);
  }

  private setMap(on: boolean) {
    if (!this.map || this.map.open === on) return;
    if (on && (this.mode !== 'playing' || this.pause?.isOpen)) return;
    this.map.setOpen(on);
    this.mapTimer = 0;
  }

  private relabelAll() {
    relabel(this.root);
    if (this.ctx) this.ctx.lang = getLang();
    this.title.relabel();
    this.hud?.relabel();
    this.briefing?.relabel();
    this.pause?.relabel();
    this.end?.relabel();
    this.mapTimer = 0;
  }
}
