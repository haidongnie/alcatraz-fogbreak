// Title screen over the live 3D backdrop: a Bureau of Prisons case file with the game title, the
// player's name, language toggle, Play online / Join / Solo / How to play, loading bar and credits.
import { isTouch } from '../config';
import { getLang, setLang, t, type Lang } from '../i18n';
import { saveName, savedName } from '../game/net';
import { controlsTable } from './common';
import { blurActive, h, setHidden, TextSlot } from './dom';

export type TitleChoice = { mode: 'online' | 'offline'; name: string };

export class TitleScreen {
  readonly el: HTMLElement;
  private readonly name: HTMLInputElement;
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly join: HTMLButtonElement;
  private readonly play: HTMLButtonElement;
  private readonly joinHint: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly loadLabel: TextSlot;
  private readonly loadBox: HTMLElement;
  private readonly howto: HTMLElement;
  private readonly langBtns: HTMLButtonElement[] = [];
  private loaded = false;
  private chosen = false;
  private loadKey = '';
  private resolve: ((c: TitleChoice) => void) | null = null;

  constructor(parent: HTMLElement) {
    this.name = h('input', { cls: 'field-input', ph: 'title.namePh', attrs: { maxlength: '16', autocomplete: 'nickname', spellcheck: 'false' } });
    this.name.value = savedName();
    this.name.addEventListener('input', () => saveName(this.name.value.trim().slice(0, 16)));
    this.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.name.blur(); });

    const langSeg = h('div', 'seg');
    for (const [l, label] of [['zh', '中文'], ['en', 'EN']] as [Lang, string][]) {
      const b = h('button', { cls: 'seg-btn', text: label, attrs: { type: 'button', 'data-lang': l } });
      b.addEventListener('click', () => setLang(l));
      this.langBtns.push(b);
      langSeg.append(b);
    }

    this.joinHint = h('span', 'btn-hint');
    this.join = this.button('btn btn-primary', 'title.join', this.joinHint, () => this.choose('online'));
    this.play = this.button('btn btn-primary', 'title.play', h('span', { cls: 'btn-hint', i18n: 'title.playHint' }), () => this.choose('online'));
    const solo = this.button('btn', 'title.solo', h('span', { cls: 'btn-hint', i18n: 'title.soloHint' }), () => this.choose('offline'));
    const howtoBtn = h('button', { cls: 'btn btn-ghost', i18n: 'title.howto', attrs: { type: 'button' } });
    howtoBtn.addEventListener('click', () => this.openHowto(true));

    this.bar = h('i');
    this.loadLabel = new TextSlot(h('span', 'loading-label'));
    this.loadBox = h('div', 'loading', h('div', 'loading-bar', this.bar), this.loadLabel.el);

    const card = h('article', 'dossier title-card interactive',
      h('header', 'doc-head', h('span', { cls: 'doc-agency', i18n: 'title.agency' }), h('span', { cls: 'doc-file', i18n: 'title.file' })),
      h('div', { cls: 'stamp stamp-secret', i18n: 'title.secret' }),
      h('h1', 'game-title', h('span', { cls: 'gt-zh', text: t('title.main') }), h('span', { cls: 'gt-en', text: t('title.sub') })),
      h('p', { cls: 'doc-date', i18n: 'title.date' }),
      h('p', { cls: 'doc-tagline', i18n: 'title.tagline' }),
      h('p', { cls: 'doc-coop', i18n: 'title.coop' }),
      h('div', 'form-row',
        h('label', 'field', h('span', { cls: 'field-label', i18n: 'title.name' }), this.name),
        h('div', 'field field-lang', h('span', { cls: 'field-label', i18n: 'title.lang' }), langSeg)),
      h('div', 'actions', this.join, this.play, solo, howtoBtn),
      this.loadBox,
      h('footer', 'credits',
        h('p', { cls: 'credits-disclaimer', i18n: 'title.disclaimer' }),
        h('p', undefined, h('b', { i18n: 'title.credits' }), ' ', h('span', { i18n: 'title.creditsText' }))),
    );

    this.howto = h('div', 'modal hidden interactive',
      h('article', 'dossier modal-card',
        h('header', 'doc-head', h('span', { cls: 'doc-agency', i18n: 'title.agency' }), h('span', { cls: 'doc-file', i18n: 'howto.title' })),
        h('h2', { cls: 'doc-h2', i18n: 'howto.title' }),
        h('p', { cls: 'doc-p', i18n: 'howto.goal' }),
        h('p', { cls: 'doc-p', i18n: 'howto.stealth' }),
        h('p', { cls: 'doc-p', i18n: 'howto.coop' }),
        h('p', { cls: 'doc-p', i18n: 'howto.counts' }),
        h('h3', { cls: 'doc-h3', i18n: 'ctl.title' }),
        controlsTable(),
        this.closeButton(() => this.openHowto(false))));
    this.howto.addEventListener('click', (e) => { if (e.target === this.howto) this.openHowto(false); });

    this.el = h('div', 'screen title-screen hidden interactive', h('div', 'title-vignette'), card, this.howto);
    if (isTouch) this.el.classList.add('is-touch');
    parent.append(this.el);
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.howto.classList.contains('hidden')) this.openHowto(false); });
    this.syncLang();
    this.setButtons();
  }

  show(opts: { invite: boolean }): Promise<TitleChoice> {
    const code = /[#&]r=R?([A-Za-z0-9]+)/.exec(location.hash)?.[1] ?? '';
    setHidden(this.join, !opts.invite);
    setHidden(this.play, opts.invite);
    this.joinHint.dataset.code = code;
    this.joinHint.textContent = t('title.joinHint', { code });
    setHidden(this.el, false);
    return new Promise((res) => { this.resolve = res; });
  }

  setLoading(fraction: number, label: string) {
    const f = Math.min(1, Math.max(0, fraction));
    this.bar.style.transform = `scaleX(${f})`;
    this.loadLabel.set(this.chosen && f >= 1 ? t('title.connecting') : label);
    this.loadKey = label;
    if (f >= 1 && !this.loaded) {
      this.loaded = true;
      this.loadBox.classList.add('done');
      this.setButtons();
    }
  }

  /** Connected: fade the title away (the briefing takes over). */
  hide() {
    this.el.classList.add('out');
    setTimeout(() => setHidden(this.el, true), 700);
  }

  relabel() {
    this.syncLang();
    this.joinHint.textContent = t('title.joinHint', { code: this.joinHint.dataset.code ?? '' });
    if (this.chosen) this.loadLabel.set(t('title.connecting'));
    else if (this.loaded) this.loadLabel.set(t('loading.ready'));
    else if (this.loadKey) this.loadLabel.reset();
  }

  private choose(mode: TitleChoice['mode']) {
    if (!this.loaded || this.chosen || !this.resolve) return;
    this.chosen = true;
    this.setButtons();
    this.loadLabel.set(t('title.connecting'));
    this.el.classList.add('connecting');
    blurActive();
    const name = this.name.value.trim().slice(0, 16);
    saveName(name);
    if (isTouch) {
      // phones: go fullscreen + landscape while we still hold the user gesture (best effort)
      try {
        const orient = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
        document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })
          ?.then(() => orient?.lock?.('landscape'))
          .catch(() => {});
      } catch { /* iOS Safari: no element fullscreen */ }
    }
    this.resolve({ mode, name });
    this.resolve = null;
  }

  private setButtons() {
    for (const b of this.buttons) b.disabled = !this.loaded || this.chosen;
  }

  private syncLang() {
    const l = getLang();
    for (const b of this.langBtns) b.classList.toggle('on', b.dataset.lang === l);
  }

  private openHowto(on: boolean) {
    setHidden(this.howto, !on);
    if (!on) blurActive();
  }

  private button(cls: string, key: string, hint: HTMLElement, onClick: () => void) {
    const b = h('button', { cls, attrs: { type: 'button' } }, h('span', { cls: 'btn-label', i18n: key }), hint);
    b.addEventListener('click', onClick);
    this.buttons.push(b);
    return b;
  }

  private closeButton(onClick: () => void) {
    const b = h('button', { cls: 'btn btn-ghost modal-close', i18n: 'ui.close', attrs: { type: 'button' } });
    b.addEventListener('click', onClick);
    return b;
  }
}
