// Small DOM helpers shared by the UI screens: an element factory with i18n binding, cached text
// writes for per-frame HUD values, time formatting, clipboard and pointer-lock wrappers.
import { t } from '../i18n';

type Child = Node | string | null | undefined | false;
export interface Props {
  cls?: string;
  /** literal text */
  text?: string;
  /** i18n key: text is set now and re-applied by `relabel()` after a language switch */
  i18n?: string;
  /** i18n key for an input placeholder */
  ph?: string;
  /** i18n key for aria-label */
  aria?: string;
  attrs?: Record<string, string>;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | string, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (typeof props === 'string') el.className = props;
  else if (props) {
    if (props.cls) el.className = props.cls;
    if (props.i18n) { el.dataset.i18n = props.i18n; el.textContent = t(props.i18n); }
    else if (props.text !== undefined) el.textContent = props.text;
    if (props.ph) { el.dataset.i18nPh = props.ph; (el as unknown as HTMLInputElement).placeholder = t(props.ph); }
    if (props.aria) { el.dataset.i18nAria = props.aria; el.setAttribute('aria-label', t(props.aria)); }
    if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

/** Re-applies every data-i18n binding below `root` (after setLang). */
export function relabel(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n!); });
  root.querySelectorAll<HTMLInputElement>('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh!); });
  root.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria!)));
}

/** Writes textContent only when the value changed (HUD values updated every few frames). */
export class TextSlot {
  private v: string | null = null;
  constructor(readonly el: HTMLElement) {}
  set(s: string) {
    if (s === this.v) return;
    this.v = s;
    this.el.textContent = s;
  }
  reset() { this.v = null; }
}

/** Toggles a class only when the state changes (avoids style recalcs). */
export class Flag {
  private v: boolean | null = null;
  constructor(readonly el: HTMLElement, readonly cls: string) {}
  set(on: boolean) {
    if (on === this.v) return;
    this.v = on;
    this.el.classList.toggle(this.cls, on);
  }
}

export function setHidden(el: HTMLElement, hidden: boolean) { el.classList.toggle('hidden', hidden); }

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));
/** 75.2 -> "1:16" */
export function fmtMMSS(sec: number) {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}
/** Night clock: lights-out at 21:30 plus the elapsed game time (1 game second = 1 s). */
export function nightClock(elapsed: number) {
  const total = 21 * 3600 + 30 * 60 + Math.max(0, elapsed);
  return `${pad2(Math.floor(total / 3600) % 24)}:${pad2(Math.floor(total / 60) % 60)}`;
}

/** 'KeyE' -> 'E', 'ShiftLeft' -> 'Shift', 'Space' -> 'Space'. Labels that are not codes pass through. */
export function keyLabel(code: string) {
  if (!code) return 'E';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (code.startsWith('Shift')) return 'Shift';
  if (code.startsWith('Control')) return 'Ctrl';
  return code;
}

/** Clipboard write with a select-and-copy fallback (older Safari, insecure origins). */
export async function copyText(text: string, fallback?: HTMLInputElement): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  if (!fallback) return false;
  fallback.focus();
  fallback.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { fallback.blur(); }
}

/** Requests pointer lock (must run inside a user gesture); failures are expected and ignored. */
export function requestLock(el: HTMLElement | null | undefined) {
  if (!el || matchMedia('(pointer: coarse)').matches) return;
  try { el.requestPointerLock?.()?.catch?.(() => {}); } catch { /* not allowed right now */ }
}

/** Drops keyboard focus so Space/Enter do not re-trigger a button that just closed its screen. */
export function blurActive() {
  const a = document.activeElement as HTMLElement | null;
  if (a && a !== document.body && typeof a.blur === 'function') a.blur();
}
