// Briefing / lobby (world.phase === 'briefing'): the prologue typed out on the case file, the crew
// as mugshot cards (character, number, cell, player name), the invite link with Copy / Share, and
// the host's Start button (`session.act({ k: 'start' })`). Everyone else waits for the host.
import type { Ctx } from '../game/context';
import { getLang, t } from '../i18n';
import type { SessionLike } from './ui';
import { castCell, castName, castRole, CAST_NUMBERS, controlsTable, mugshot, rosterSlots, SLOT_COLORS } from './common';
import { copyText, h, setHidden, TextSlot } from './dom';

interface CastCard {
  el: HTMLElement;
  name: TextSlot;
  meta: TextSlot;
  role: TextSlot;
  player: TextSlot;
  dot: HTMLElement;
  you: HTMLElement;
  host: HTMLElement;
}

export class Briefing {
  readonly el: HTMLElement;
  private readonly prologue: HTMLElement;
  private readonly cards: CastCard[] = [];
  private readonly count: TextSlot;
  private readonly inviteBox: HTMLElement;
  private readonly inviteInput: HTMLInputElement;
  private readonly room: TextSlot;
  private readonly shareBtn: HTMLButtonElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly wait: TextSlot;
  private readonly soloNote: HTMLElement;
  private visible = false;
  private refresh = 0;
  private typeTimer = 0;
  private startLock = 0;

  constructor(parent: HTMLElement, private readonly ctx: Ctx, private readonly session: SessionLike, private readonly toast: (m: string) => void) {
    this.prologue = h('p', 'doc-p prologue');
    this.prologue.addEventListener('click', () => this.finishTyping());

    const castGrid = h('div', 'cast-grid');
    for (let slot = 0; slot < 4; slot++) {
      const card: CastCard = {
        el: h('div', 'cast-card'),
        name: new TextSlot(h('div', 'cast-name')),
        meta: new TextSlot(h('div', 'cast-meta')),
        role: new TextSlot(h('div', 'cast-role')),
        player: new TextSlot(h('span', 'cast-pname')),
        dot: h('span', 'dot'),
        you: h('span', { cls: 'badge hidden', i18n: 'brief.you' }),
        host: h('span', { cls: 'badge badge-host hidden', i18n: 'brief.host' }),
      };
      card.dot.style.background = SLOT_COLORS[slot];
      card.el.append(mugshot(slot), h('div', 'cast-info', card.name.el, card.meta.el, card.role.el,
        h('div', 'cast-player', card.dot, card.player.el, card.you, card.host)));
      castGrid.append(card.el);
      this.cards.push(card);
    }
    this.count = new TextSlot(h('span', 'cast-count'));

    this.inviteInput = h('input', { cls: 'invite-url', attrs: { readonly: '', spellcheck: 'false' } });
    this.inviteInput.addEventListener('focus', () => this.inviteInput.select());
    const copyBtn = h('button', { cls: 'btn btn-small', i18n: 'brief.copy', attrs: { type: 'button' } });
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(this.inviteInput.value, this.inviteInput);
      this.toast(t(ok ? 'toast.copied' : 'toast.copyFail'));
    });
    this.shareBtn = h('button', { cls: 'btn btn-small', i18n: 'brief.share', attrs: { type: 'button' } });
    this.shareBtn.addEventListener('click', () => {
      navigator.share?.({ title: t('title.main'), text: t('brief.inviteHint'), url: this.inviteInput.value }).catch(() => {});
    });
    setHidden(this.shareBtn, typeof navigator.share !== 'function');
    this.room = new TextSlot(h('span', 'invite-room'));
    this.inviteBox = h('section', 'invite',
      h('h3', 'doc-h3', h('span', { i18n: 'brief.invite' }), this.room.el),
      h('p', { cls: 'doc-small', i18n: 'brief.inviteHint' }),
      h('div', 'invite-row', this.inviteInput, copyBtn, this.shareBtn));
    this.soloNote = h('p', { cls: 'doc-small solo-note', i18n: 'brief.solo' });

    this.startBtn = h('button', { cls: 'btn btn-primary btn-start', attrs: { type: 'button' } }, h('span', { cls: 'btn-label', i18n: 'brief.start' }));
    this.startBtn.addEventListener('click', () => {
      if (!this.session.isHost() || this.startLock > 0) return;
      this.startLock = 2.5;
      this.startBtn.disabled = true;
      this.session.act({ k: 'start' });
    });
    this.wait = new TextSlot(h('p', 'wait-host'));

    const left = h('section', 'page page-left',
      h('header', 'doc-head', h('span', { cls: 'doc-agency', i18n: 'title.agency' }), h('span', { cls: 'doc-file', i18n: 'title.file' })),
      h('h2', 'doc-h2', h('span', { i18n: 'brief.title' }), h('small', { cls: 'doc-h2-sub', i18n: 'title.date' })),
      this.prologue,
      h('div', 'brief-controls', h('h3', { cls: 'doc-h3', i18n: 'ctl.title' }), controlsTable()));
    const right = h('section', 'page page-right',
      h('h3', 'doc-h3', h('span', { i18n: 'brief.cast' }), this.count.el),
      castGrid, this.inviteBox, this.soloNote,
      h('div', 'brief-actions', this.startBtn, this.wait.el));
    this.el = h('div', 'screen briefing-screen hidden interactive', h('article', 'dossier spread', h('div', { cls: 'stamp stamp-secret', i18n: 'title.secret' }), left, right));
    parent.append(this.el);
  }

  show() {
    if (this.visible) return;
    this.visible = true;
    setHidden(this.el, false);
    this.typePrologue();
    this.render();
  }
  hide() {
    if (!this.visible) return;
    this.visible = false;
    setHidden(this.el, true);
    this.finishTyping();
  }

  update(dt: number) {
    if (!this.visible) return;
    if (this.startLock > 0 && (this.startLock -= dt) <= 0) this.startBtn.disabled = false;
    this.refresh -= dt;
    if (this.refresh <= 0) { this.refresh = 0.5; this.render(); }
  }

  relabel() {
    if (this.typeTimer) this.typePrologue(); else this.prologue.textContent = t('brief.prologue');
    for (const c of this.cards) { c.name.reset(); c.meta.reset(); c.role.reset(); c.player.reset(); }
    this.count.reset();
    this.room.reset();
    this.wait.reset();
    this.render();
  }

  private render() {
    const { net } = this.ctx;
    const w = this.ctx.world();
    const roster = rosterSlots(net, w);
    for (let slot = 0; slot < 4; slot++) {
      const c = this.cards[slot];
      const entry = roster.find((r) => r.slot === slot);
      c.name.set(castName(slot));
      c.meta.set(`${CAST_NUMBERS[slot]} · ${t('brief.cell', { cell: castCell(slot) })}`);
      c.role.set(castRole(slot));
      c.player.set(entry ? entry.p.name : t('brief.vacant'));
      c.el.classList.toggle('filled', !!entry);
      c.el.classList.toggle('me', !!entry?.p.isMe);
      c.dot.style.background = entry?.p.color || SLOT_COLORS[slot];
      setHidden(c.you, !entry?.p.isMe);
      setHidden(c.host, !(entry?.p.isMe && net.isHost() && net.mode === 'online'));
    }
    this.count.set(t('brief.players', { n: roster.length }));

    const online = net.mode === 'online';
    setHidden(this.inviteBox, !online);
    setHidden(this.soloNote, online && roster.length > 1);
    if (online) {
      const url = net.inviteUrl();
      if (this.inviteInput.value !== url) this.inviteInput.value = url;
      const code = net.roomCode();
      this.room.set(code ? t('brief.room', { code }) : '');
    }
    const host = this.session.isHost();
    setHidden(this.startBtn, !host || !w);
    this.wait.set(!w ? t('brief.waitWorld') : host ? '' : t('brief.waitHost'));
    setHidden(this.wait.el, host && !!w);
  }

  private typePrologue() {
    this.finishTyping();
    const full = t('brief.prologue');
    const step = getLang() === 'zh' ? 1 : 2;
    let i = 0;
    this.prologue.textContent = '';
    this.prologue.classList.add('typing');
    this.typeTimer = window.setInterval(() => {
      i += step;
      this.prologue.textContent = full.slice(0, i);
      if (i >= full.length) this.finishTyping();
    }, 42);
  }
  private finishTyping() {
    if (this.typeTimer) { clearInterval(this.typeTimer); this.typeTimer = 0; }
    this.prologue.classList.remove('typing');
    this.prologue.textContent = t('brief.prologue');
  }
}
