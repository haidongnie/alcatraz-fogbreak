// Shared UI content: the cast (docs/DESIGN.md), mugshot placards, slot colours, roster slot
// preview, and the controls table used by the title screen, briefing and pause menu.
import { t } from '../i18n';
import type { Net, NetPlayer } from '../game/net';
import type { WorldState } from '../game/types';
import { PLAYER_CELLS } from '../world/layout';
import { h } from './dom';

export const CAST_NUMBERS = ['AZ-1417', 'AZ-1298', 'AZ-1502', 'AZ-1376'] as const;
/** Fallback colours per slot (map dots, crew list) when Playroom has no profile colour. */
export const SLOT_COLORS = ['#e8c25a', '#86b8d8', '#d9875a', '#9fcf86'] as const;

export const castName = (slot: number) => t(`cast.${slot}.name`);
export const castRole = (slot: number) => t(`cast.${slot}.role`);
export const castCell = (slot: number) => PLAYER_CELLS[slot]?.label ?? '';

/**
 * Slot of every connected player: the world's assignment when it exists, otherwise the slot they
 * will get when the night starts (lowest free slot in join order, mirroring rules.addPlayer).
 */
export function rosterSlots(net: Net, w: WorldState | null): { p: NetPlayer; slot: number }[] {
  const players = net.players();
  const used = new Set<number>();
  const out: { p: NetPlayer; slot: number }[] = [];
  for (const p of players) {
    const s = w?.players[p.id]?.slot;
    if (s !== undefined) used.add(s);
  }
  for (const p of players) {
    let s = w?.players[p.id]?.slot;
    if (s === undefined) {
      s = 0;
      while (used.has(s) && s < 4) s++;
      used.add(s);
    }
    if (s < 4) out.push({ p, slot: s });
  }
  return out;
}

/** Name of a player id for toasts (Playroom name, else the character's name). */
export function playerName(net: Net, w: WorldState | null, pid: string): string {
  const p = net.players().find((x) => x.id === pid);
  if (p?.name) return p.name;
  const slot = w?.players[pid]?.slot;
  return slot !== undefined ? castName(slot) : '?';
}

// Head-and-shoulders silhouettes in front of a height chart; slightly different per character.
const HAIR = [
  'M38 30c2-12 22-14 26-2 2 4 1 8 0 10-3-6-9-9-26-8z',          // Sparks: slicked quiff
  'M37 34c0-10 9-16 17-15 9 0 15 6 15 14-4-4-10-6-16-6s-12 2-16 7z', // Walt: receding
  'M36 32c1-13 25-17 30-3 1 3 1 6 0 8-6-6-14-8-30-5z',           // Johnny: thick hair
  'M37 33c1-11 10-15 17-15 8 0 15 5 15 13-8-3-20-3-32 2z',       // Ray: short crop
];
/** Inline SVG mugshot placard for a slot (no external images). */
export function mugshot(slot: number): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 110');
  svg.setAttribute('class', 'mug');
  svg.setAttribute('aria-hidden', 'true');
  let lines = '';
  for (let i = 0; i < 7; i++) {
    const y = 12 + i * 12;
    lines += `<line x1="0" x2="100" y1="${y}" y2="${y}" class="mug-line"/><text x="3" y="${y - 2}" class="mug-tick">${7 - i}'</text>`;
  }
  svg.innerHTML = `
    <rect width="100" height="110" class="mug-bg"/>${lines}
    <path class="mug-body" d="M14 110c2-22 16-30 36-32 20 2 34 10 36 32z"/>
    <path class="mug-body" d="M43 66h16v14H43z"/>
    <ellipse class="mug-body" cx="51" cy="44" rx="15" ry="19"/>
    <path class="mug-hair" d="${HAIR[slot % HAIR.length]}"/>
    <rect x="28" y="84" width="46" height="18" rx="1" class="mug-plate"/>
    <text x="51" y="96.5" class="mug-num">${CAST_NUMBERS[slot] ?? ''}</text>`;
  return svg;
}

/** [key cap (literal, or '@i18n.key'), description key] */
const CONTROLS: [string, string][] = [
  ['W A S D', 'ctl.move'], ['@key.mouse', 'ctl.look'], ['Shift', 'ctl.run'], ['C / Ctrl', 'ctl.crouch'],
  ['E', 'ctl.interact'], ['G', 'ctl.drop'], ['F', 'ctl.throw'], ['Q', 'ctl.music'], ['@key.space', 'ctl.jump'],
  ['Tab', 'ctl.objectives'], ['M', 'ctl.map'], ['Esc', 'ctl.menu'],
];
/** Key/description table (labels re-translate through data-i18n). */
export function controlsTable(): HTMLElement {
  const dl = h('dl', 'controls');
  for (const [key, label] of CONTROLS) {
    const cap = key.startsWith('@') ? h('kbd', { i18n: key.slice(1) }) : h('kbd', { text: key });
    dl.append(h('dt', undefined, cap), h('dd', { i18n: label }));
  }
  return h('div', 'controls-wrap', dl, h('p', { cls: 'controls-note', i18n: 'ctl.raft' }), h('p', { cls: 'controls-note', i18n: 'ctl.touch' }));
}
