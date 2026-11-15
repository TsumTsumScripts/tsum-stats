// The language Tsums are named in, page-wide: 'en' (the English name, else
// the JP one) or 'jp' (the JP name, else the English one, for a Tsum JP never
// had). A per-browser preference, set from the top bar; tsumName (util.js)
// reads it. Imports nothing, so util.js can import it.
const KEY = 'tsum-stats.names';
const LANGS = ['en', 'jp'];

function load() {
  try { const v = JSON.parse(localStorage.getItem(KEY)); return LANGS.includes(v) ? v : 'en'; } catch { return 'en'; }
}

export const names = $state({lang: load()});

export function setNames(lang) {
  if (!LANGS.includes(lang)) return;
  names.lang = lang;
  try { localStorage.setItem(KEY, JSON.stringify(lang)); } catch { /* private mode: reset next visit */ }
}
