// End screen (world.phase 'won' / 'lost'): the closed case file with a rubber stamp, the epilogue
// (or the reason the attempt failed), the night's statistics, every inmate's disposition, and the
// host's Replay button (`session.act({ k: 'restart' })`).
import { TUNING } from '../config';
import type { Ctx } from '../game/context';
import type { WorldState } from '../game/types';
import { t } from '../i18n';
import type { SessionLike } from './ui';
import { castName, CAST_NUMBERS, mugshot, playerName } from './common';
import { fmtMMSS, h, setHidden } from './dom';

export class EndScreen {
  readonly el: HTMLElement;
  private readonly card: HTMLElement;
  private w: WorldState | null = null;
  private visible = false;

  constructor(parent: HTMLElement, private readonly ctx: Ctx, private readonly session: SessionLike, private readonly onLeave: () => void) {
    this.card = h('article', 'dossier end-card');
    this.el = h('div', 'screen end-screen hidden interactive', this.card);
    parent.append(this.el);
  }

  show(w: WorldState) {
    this.w = w;
    this.render();
    if (!this.visible) {
      this.visible = true;
      setHidden(this.el, false);
      this.el.classList.remove('in');
      void this.el.offsetWidth;
      this.el.classList.add('in');
    }
  }
  hide() {
    if (!this.visible) return;
    this.visible = false;
    setHidden(this.el, true);
  }
  relabel() { if (this.visible) this.render(); }

  private render() {
    const w = this.w;
    if (!w) return;
    const ctx = this.ctx;
    const won = w.phase === 'won';
    const reason = w.lostReason ?? 'lost.lockdown';
    const dur = Math.max(0, (w.stats.endT ?? ctx.time()) - w.startT);
    const text = won ? t('end.won.epilogue') : t(`${reason}.text`);

    const stats = h('dl', 'end-stats');
    const dist = won ? Math.max(w.raft.dist, TUNING.fogBankDistance) : w.raft.dist;
    for (const [k, v] of [
      ['end.time', fmtMMSS(dur)],
      ['end.clock', clockAt(dur)],
      ['end.caughtN', String(w.stats.caught)],
      ['end.counts', String(w.stats.counts)],
      ['end.alarms', String(w.stats.alarmsRaised)],
      ['end.distance', t('hud.meters', { d: Math.round(dist) })],
    ] as const) stats.append(h('div', 'end-stat', h('dt', { text: t(k) }), h('dd', { text: v })));

    const outcomes = h('ul', 'end-outcomes');
    const entries = Object.entries(w.players).sort((a, b) => a[1].slot - b[1].slot);
    for (const [pid, st] of entries) {
      const me = pid === ctx.myId;
      outcomes.append(h('li', `end-outcome st-${st.s}${me ? ' me' : ''}`,
        mugshot(st.slot),
        h('div', 'end-who',
          h('div', 'end-name', h('b', { text: playerName(ctx.net, w, pid) }), me ? h('span', { cls: 'badge', text: t('brief.you') }) : null),
          h('div', 'end-cast', `${castName(st.slot)} · ${CAST_NUMBERS[st.slot] ?? ''}`),
          h('div', 'end-fate', h('span', { cls: 'end-status', text: t(`status.${st.s}`) }), ' ', t(`end.outcome.${st.s}`)))));
    }

    const actions = h('div', 'end-actions');
    if (this.session.isHost()) {
      const restart = h('button', { cls: 'btn btn-primary', attrs: { type: 'button' } }, h('span', { cls: 'btn-label', text: t('end.restart') }));
      restart.addEventListener('click', () => { restart.disabled = true; this.session.act({ k: 'restart' }); });
      actions.append(restart);
    } else actions.append(h('p', { cls: 'wait-host', text: t('end.waitHost') }));
    const leave = h('button', { cls: 'btn btn-ghost', attrs: { type: 'button' } }, h('span', { cls: 'btn-label', text: t('end.leave') }));
    leave.addEventListener('click', this.onLeave);
    actions.append(leave);

    this.card.classList.toggle('won', won);
    this.card.classList.toggle('lost', !won);
    this.card.replaceChildren(
      h('header', 'doc-head', h('span', { cls: 'doc-agency', text: t('title.agency') }), h('span', { cls: 'doc-file', text: t('title.file') })),
      h('div', { cls: `stamp end-stamp ${won ? 'stamp-escaped' : 'stamp-failed'}`, text: t(won ? 'end.won.stamp' : 'end.lost.stamp') }),
      h('h2', { cls: 'doc-h2 end-title', text: won ? t('end.won.title') : `${t('end.lost.title')} · ${t(reason)}` }),
      h('div', 'end-epilogue', ...text.split('\n').map((p) => h('p', { cls: 'doc-p', text: p }))),
      h('div', 'end-cols',
        h('section', 'end-col', h('h3', { cls: 'doc-h3', text: t('end.stats') }), stats),
        h('section', 'end-col', h('h3', { cls: 'doc-h3', text: t('end.outcomes') }), outcomes)),
      actions);
  }
}

function clockAt(elapsed: number) {
  const total = 21 * 3600 + 30 * 60 + elapsed;
  const hh = Math.floor(total / 3600) % 24, mm = Math.floor(total / 60) % 60;
  return `${hh}:${mm < 10 ? '0' : ''}${mm}`;
}
