// Pause menu (Esc): resume, language, look sensitivity (localStorage 'fogbreak.sens', read by the
// camera rig), master volume, invite link, controls, leave (two-step confirm). The game world keeps
// running underneath: this is a shared night, the menu only freezes the local player's input.
import type { Ctx } from '../game/context';
import { getVolume, setVolume } from '../audio/settings';
import { getLang, setLang, t, type Lang } from '../i18n';
import { controlsTable } from './common';
import { copyText, h, setHidden, TextSlot } from './dom';

const SENS_KEY = 'fogbreak.sens';

function readSens(): number {
  try {
    const v = Number.parseFloat(localStorage.getItem(SENS_KEY) ?? '');
    return Number.isFinite(v) && v > 0 ? v : 1;
  } catch { return 1; }
}

export class PauseMenu {
  readonly el: HTMLElement;
  isOpen = false;
  private readonly sens: HTMLInputElement;
  private readonly sensVal: TextSlot;
  private readonly vol: HTMLInputElement;
  private readonly volVal: TextSlot;
  private readonly langBtns: HTMLButtonElement[] = [];
  private readonly inviteBox: HTMLElement;
  private readonly inviteInput: HTMLInputElement;
  private readonly leaveLabel: HTMLElement;
  private readonly controls: HTMLElement;
  private leaveArmed = 0;

  constructor(parent: HTMLElement, private readonly ctx: Ctx, opts: { onResume: () => void; onClose: () => void; onLeave: () => void; toast: (m: string) => void }) {
    const resume = h('button', { cls: 'btn btn-primary', attrs: { type: 'button' } }, h('span', { cls: 'btn-label', i18n: 'pause.resume' }));
    resume.addEventListener('click', opts.onResume);

    const seg = h('div', 'seg');
    for (const [l, label] of [['zh', '中文'], ['en', 'EN']] as [Lang, string][]) {
      const b = h('button', { cls: 'seg-btn', text: label, attrs: { type: 'button', 'data-lang': l } });
      b.addEventListener('click', () => setLang(l));
      this.langBtns.push(b);
      seg.append(b);
    }

    this.sens = h('input', { cls: 'slider', attrs: { type: 'range', min: '0.2', max: '3', step: '0.05' } });
    this.sensVal = new TextSlot(h('span', 'slider-val'));
    this.sens.addEventListener('input', () => {
      const v = Number(this.sens.value);
      this.sensVal.set(`${v.toFixed(2)}×`);
      try { localStorage.setItem(SENS_KEY, String(v)); } catch { /* private mode */ }
      // same-window listeners (the camera rig) can react without polling localStorage
      try { dispatchEvent(new StorageEvent('storage', { key: SENS_KEY, newValue: String(v) })); } catch { /* old Safari */ }
    });
    this.vol = h('input', { cls: 'slider', attrs: { type: 'range', min: '0', max: '1', step: '0.01' } });
    this.volVal = new TextSlot(h('span', 'slider-val'));
    this.vol.addEventListener('input', () => {
      const v = Number(this.vol.value);
      this.volVal.set(`${Math.round(v * 100)}%`);
      setVolume(v);
    });

    this.inviteInput = h('input', { cls: 'invite-url', attrs: { readonly: '', spellcheck: 'false' } });
    this.inviteInput.addEventListener('focus', () => this.inviteInput.select());
    const copy = h('button', { cls: 'btn btn-small', i18n: 'brief.copy', attrs: { type: 'button' } });
    copy.addEventListener('click', async () => opts.toast(t((await copyText(this.inviteInput.value, this.inviteInput)) ? 'toast.copied' : 'toast.copyFail')));
    this.inviteBox = h('div', 'set-row set-invite', h('span', { cls: 'set-label', i18n: 'pause.invite' }), h('div', 'invite-row', this.inviteInput, copy));

    this.controls = h('div', 'pause-controls hidden', controlsTable());
    const ctlBtn = h('button', { cls: 'btn btn-ghost', i18n: 'pause.controls', attrs: { type: 'button' } });
    ctlBtn.addEventListener('click', () => this.controls.classList.toggle('hidden'));

    this.leaveLabel = h('span', { cls: 'btn-label', i18n: 'pause.leave' });
    const leave = h('button', { cls: 'btn btn-danger', attrs: { type: 'button' } }, this.leaveLabel);
    leave.addEventListener('click', () => {
      if (this.leaveArmed > performance.now()) { opts.onLeave(); return; }
      this.leaveArmed = performance.now() + 3000;
      this.leaveLabel.dataset.i18n = 'pause.leaveAgain';
      this.leaveLabel.textContent = t('pause.leaveAgain');
      setTimeout(() => this.disarm(), 3100);
    });

    const card = h('article', 'dossier pause-card',
      h('header', 'doc-head', h('span', { cls: 'doc-agency', i18n: 'title.agency' }), h('span', { cls: 'doc-file', i18n: 'title.file' })),
      h('h2', { cls: 'doc-h2', i18n: 'pause.title' }),
      h('p', { cls: 'doc-small', i18n: 'pause.note' }),
      resume,
      h('div', 'set-row', h('span', { cls: 'set-label', i18n: 'pause.lang' }), seg),
      h('label', 'set-row', h('span', { cls: 'set-label', i18n: 'pause.sens' }), this.sens, this.sensVal.el),
      h('label', 'set-row', h('span', { cls: 'set-label', i18n: 'pause.vol' }), this.vol, this.volVal.el),
      this.inviteBox,
      h('div', 'pause-actions', ctlBtn, leave),
      this.controls);
    this.el = h('div', 'screen pause-screen hidden interactive', card);
    this.el.addEventListener('click', (e) => { if (e.target === this.el) opts.onResume(); });
    // Input ignores keys while a slider/field has focus, so Esc is handled here in that case
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (e.target as HTMLElement).tagName === 'INPUT') opts.onClose();
    });
    parent.append(this.el);
  }

  open() {
    this.isOpen = true;
    const s = readSens();
    this.sens.value = String(s);
    this.sensVal.set(`${s.toFixed(2)}×`);
    const v = getVolume();
    this.vol.value = String(v);
    this.volVal.set(`${Math.round(v * 100)}%`);
    const online = this.ctx.net.mode === 'online';
    setHidden(this.inviteBox, !online);
    if (online) this.inviteInput.value = this.ctx.net.inviteUrl();
    this.syncLang();
    this.disarm();
    setHidden(this.el, false);
  }

  close() {
    this.isOpen = false;
    setHidden(this.el, true);
    setHidden(this.controls, true);
  }

  relabel() { this.syncLang(); }

  private syncLang() {
    const l = getLang();
    for (const b of this.langBtns) b.classList.toggle('on', b.dataset.lang === l);
  }
  private disarm() {
    if (this.leaveArmed > performance.now()) return;
    this.leaveArmed = 0;
    this.leaveLabel.dataset.i18n = 'pause.leave';
    this.leaveLabel.textContent = t('pause.leave');
  }
}
