// Transient overlays that exist from the first frame (before the session is attached):
// embossed label-tape toasts, chapter index cards, the screen fade used for teleports/traverses,
// the "CAUGHT" stamp and the alarm flash.
import { t } from '../i18n';
import { h, setHidden } from './dom';

export type ToastKind = 'info' | 'warn' | 'good';
const MAX_TOASTS = 4;

export class Overlays {
  private readonly toasts: HTMLElement;
  private readonly fadeEl: HTMLElement;
  private readonly card: HTMLElement;
  private readonly cardNum: HTMLElement;
  private readonly cardTitle: HTMLElement;
  private readonly cardText: HTMLElement;
  private readonly caught: HTMLElement;
  private readonly caughtTitle: HTMLElement;
  private readonly caughtSub: HTMLElement;
  private cardTimer = 0;
  private caughtTimer = 0;

  constructor(root: HTMLElement) {
    this.fadeEl = h('div', 'fade');
    this.cardNum = h('div', 'chapter-num');
    this.cardTitle = h('div', 'chapter-title');
    this.cardText = h('p', 'chapter-text');
    this.card = h('div', 'chapter-card hidden', h('div', 'chapter-inner dossier', this.cardNum, this.cardTitle, h('hr', 'chapter-rule'), this.cardText));
    this.caughtTitle = h('div', 'stamp stamp-caught');
    this.caughtSub = h('p', 'caught-sub');
    this.caught = h('div', 'caught hidden', this.caughtTitle, this.caughtSub);
    this.toasts = h('div', 'toasts');
    root.append(this.fadeEl, this.card, this.caught, this.toasts);
  }

  /** Label-tape toast; old ones scroll away. */
  toast(msg: string, kind: ToastKind = 'info') {
    if (!msg) return;
    const el = h('div', `toast toast-${kind}`, h('span', { text: msg }));
    el.style.setProperty('--tilt', `${(Math.random() * 1.6 - 0.8).toFixed(2)}deg`);
    this.toasts.append(el);
    while (this.toasts.children.length > MAX_TOASTS) this.toasts.firstElementChild?.remove();
    const life = 3800 + Math.min(4000, msg.length * 45);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 500);
    }, life);
  }

  /** `bus` 'fade': opacity target over `duration` seconds. */
  fade(to: number, duration: number) {
    this.fadeEl.style.transitionDuration = `${Math.max(0, duration)}s`;
    this.fadeEl.style.opacity = String(Math.min(1, Math.max(0, to)));
  }

  /** Chapter index card (also used for the prologue). */
  chapter(num: string, title: string, text: string, seconds = 8) {
    this.cardNum.textContent = num;
    this.cardTitle.textContent = title;
    this.cardText.textContent = text;
    setHidden(this.card, false);
    this.card.classList.remove('out');
    // restart the entry animation
    void this.card.offsetWidth;
    this.card.classList.add('in');
    clearTimeout(this.cardTimer);
    this.cardTimer = window.setTimeout(() => {
      this.card.classList.remove('in');
      this.card.classList.add('out');
      this.cardTimer = window.setTimeout(() => setHidden(this.card, true), 900);
    }, seconds * 1000);
  }
  hideChapter() {
    clearTimeout(this.cardTimer);
    setHidden(this.card, true);
  }

  /** Big rubber stamp when the local player is caught. */
  caughtStamp() {
    this.caughtTitle.textContent = t('caught.title');
    this.caughtSub.textContent = t('caught.sub');
    setHidden(this.caught, false);
    this.caught.classList.remove('in');
    void this.caught.offsetWidth;
    this.caught.classList.add('in');
    clearTimeout(this.caughtTimer);
    this.caughtTimer = window.setTimeout(() => setHidden(this.caught, true), 3600);
  }
}
