// STUB — owned by the UI agent. Keep the exported API; fill the dictionaries.
export type Lang = 'zh' | 'en';
let current: Lang = 'zh';
const dict: Record<Lang, Record<string, string>> = { zh: {}, en: {} };
/** Picks the language (saved choice, else browser language) and returns it. */
export function initI18n(): Lang { current = navigator.language.startsWith('zh') ? 'zh' : 'en'; return current; }
export function getLang(): Lang { return current; }
export function setLang(l: Lang) { current = l; }
/** Translate a key; `{name}` placeholders are replaced from args. Unknown keys return the key. */
export function t(key: string, args?: Record<string, string | number>): string {
  let s = dict[current][key] ?? dict.en[key] ?? key;
  if (args) for (const [k, v] of Object.entries(args)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
