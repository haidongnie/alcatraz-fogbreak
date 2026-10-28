// Touch controls (phones/tablets): a floating stick on the left half (pull past the ring to run),
// drag anywhere on the right half to look, and buttons that stand in for keys. Everything feeds
// the Input virtual API (`setVirtualAxis`, `addLook`, `setVirtualButton`), so game code never knows
// which device is in use.
import type { Input } from '../core/input';
import { h } from './dom';

const R = 56;             // stick radius (px)
const LOOK_GAIN = 1.35;   // touch drags feel slower than a mouse; boost a little
const DEAD = 0.12;

export class TouchControls {
  readonly el: HTMLElement;
  private readonly base: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly interact: HTMLElement;
  private readonly held = new Set<string>();
  private stickId = -1;
  private lookId = -1;
  private ox = 0; private oy = 0;
  private lx = 0; private ly = 0;
  private runStick = false;
  private runBtn = false;
  private visible = false;

  constructor(parent: HTMLElement, private readonly input: Input, opts: { onMenu: () => void; onMap: () => void }) {
    this.knob = h('div', 'stick-knob');
    this.base = h('div', 'stick-base', this.knob);
    this.interact = this.button('KeyE', 'touch.interact', 'tb-interact');
    const pad = h('div', 'touch-pad',
      this.interact,
      this.button('Space', 'touch.jump', 'tb-jump'),
      this.button('KeyC', 'touch.crouch', 'tb-crouch'),
      this.button('ShiftLeft', 'touch.run', 'tb-run'),
      this.button('KeyG', 'touch.drop', 'tb-drop'),
      this.button('KeyF', 'touch.throw', 'tb-throw'),
      this.button('KeyQ', 'touch.music', 'tb-music'));
    const sys = h('div', 'touch-sys', this.sysButton('touch.map', opts.onMap), this.sysButton('touch.menu', opts.onMenu));
    this.el = h('div', 'touch hidden interactive', this.base, pad, sys);
    parent.append(this.el);

    const el = this.el;
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || (e.target as HTMLElement).closest('.tbtn')) return;
      e.preventDefault();
      if (e.clientX < innerWidth * 0.45 && this.stickId < 0) {
        this.stickId = e.pointerId;
        this.ox = e.clientX; this.oy = e.clientY;
        this.base.classList.add('active');
        this.base.style.transform = `translate3d(${this.ox}px,${this.oy}px,0)`;
        this.moveStick(e.clientX, e.clientY);
      } else if (this.lookId < 0) {
        this.lookId = e.pointerId;
        this.lx = e.clientX; this.ly = e.clientY;
      } else return;
      try { el.setPointerCapture(e.pointerId); } catch { /* already released */ }
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) this.moveStick(e.clientX, e.clientY);
      else if (e.pointerId === this.lookId) {
        this.input.addLook((e.clientX - this.lx) * LOOK_GAIN, (e.clientY - this.ly) * LOOK_GAIN);
        this.lx = e.clientX; this.ly = e.clientY;
      }
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === this.stickId) this.releaseStick();
      else if (e.pointerId === this.lookId) this.lookId = -1;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setVisible(on: boolean) {
    if (on === this.visible) return;
    this.visible = on;
    this.el.classList.toggle('hidden', !on);
    if (!on) this.releaseAll();
  }

  /** Pulse the Interact button while a prompt is available. */
  setInteract(on: boolean) { this.interact.classList.toggle('ready', on); }

  private moveStick(x: number, y: number) {
    let dx = x - this.ox, dy = y - this.oy;
    let len = Math.hypot(dx, dy);
    // floating stick: the base follows a thumb that wanders far away
    if (len > R * 1.7) {
      const k = (len - R * 1.7) / len;
      this.ox += dx * k; this.oy += dy * k;
      this.base.style.transform = `translate3d(${this.ox}px,${this.oy}px,0)`;
      dx = x - this.ox; dy = y - this.oy; len = Math.hypot(dx, dy);
    }
    const c = len > R ? R / len : 1;
    this.knob.style.transform = `translate3d(${dx * c}px,${dy * c}px,0)`;
    let ax = (dx * c) / R, ay = -(dy * c) / R;
    if (Math.hypot(ax, ay) < DEAD) ax = ay = 0;
    this.input.setVirtualAxis(ax, ay);
    const run = len > R * 1.3;
    if (run !== this.runStick) { this.runStick = run; this.syncRun(); }
  }

  private releaseStick() {
    this.stickId = -1;
    this.base.classList.remove('active');
    this.base.style.transform = '';
    this.knob.style.transform = '';
    this.input.setVirtualAxis(0, 0);
    if (this.runStick) { this.runStick = false; this.syncRun(); }
  }

  private releaseAll() {
    this.releaseStick();
    this.lookId = -1;
    for (const code of this.held) this.input.setVirtualButton(code, false);
    this.held.clear();
    this.runBtn = false;
    this.syncRun();
    for (const b of this.el.querySelectorAll('.tbtn.down')) b.classList.remove('down');
  }

  private press(code: string, down: boolean) {
    if (code === 'ShiftLeft') { this.runBtn = down; this.syncRun(); return; }
    if (down) this.held.add(code); else this.held.delete(code);
    this.input.setVirtualButton(code, down);
  }
  private syncRun() { this.input.setVirtualButton('ShiftLeft', this.runBtn || this.runStick); }

  private button(code: string, key: string, cls: string) {
    const b = h('div', { cls: `tbtn ${cls}`, attrs: { role: 'button' } }, h('span', { i18n: key }));
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { b.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      b.classList.add('down');
      this.press(code, true);
    });
    const up = () => {
      if (!b.classList.contains('down')) return;
      b.classList.remove('down');
      this.press(code, false);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
    return b;
  }

  private sysButton(key: string, onTap: () => void) {
    const b = h('div', { cls: 'tbtn tb-sys', attrs: { role: 'button' } }, h('span', { i18n: key }));
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
    b.addEventListener('click', (e) => { e.stopPropagation(); onTap(); });
    return b;
  }
}
