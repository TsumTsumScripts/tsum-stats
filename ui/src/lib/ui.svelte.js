// Page-wide state shared by components: the catalog and devices, the chart
// tooltip, toasts, the one expanded panel, and the theme.
import {api, loadPref, savePref} from './util.js';

/** Loaded once by App before any section shows. */
export const shared = $state({catalog: null, devices: []});

// ---- Tooltip ----
// Content is lines of parts: a string, {b} bold, {sw} a colour swatch, {dim} faint text.
export const b = text => ({b: text});
export const sw = color => ({sw: color});
export const dim = text => ({dim: text});

export const tip = $state({lines: null, x: 0, y: 0});
export function showTip(lines, event) {
  tip.lines = lines;
  tip.x = event.clientX;
  tip.y = event.clientY;
}
export const hideTip = () => { tip.lines = null; };

// ---- Toasts ----
export const toasts = $state([]);
let toastSeq = 0;
export function toast(text, ms = 3500) {
  const id = ++toastSeq;
  toasts.push({id, text});
  setTimeout(() => {
    const i = toasts.findIndex(t => t.id === id);
    if (i >= 0) toasts.splice(i, 1);
  }, ms);
}

// ---- Expanded panel: at most one fills the window ----
export const expand = $state({open: null});

// ---- Theme ----
// A theme is a themes/*.css file of token overrides; there is always one.
// index.html applies the saved one (else the default) before the page draws, so it never flashes.
const THEME_KEY = 'tsum-stats.theme';
export const DEFAULT_THEME = 'halloween.css';
export const theme = $state({list: [], current: loadPref(THEME_KEY, '') || DEFAULT_THEME, version: 0});

const themeLink = () => document.getElementById('theme-css');

/** Asks the server which themes there are (built in, plus any in --web-dir). */
export async function loadThemes() {
  try {
    theme.list = await api('themes');
  } catch {
    theme.list = [];
  }
  // A saved theme that is gone falls back to the default.
  if (theme.list.length && !theme.list.some(t => t.file === theme.current)) setTheme(DEFAULT_THEME);
}

export function setTheme(file) {
  theme.current = file;
  savePref(THEME_KEY, file);
  const link = themeLink();
  // Charts read colours when they draw, so they redraw once the file has applied.
  link.onload = link.onerror = () => { theme.version++; };
  link.href = `themes/${file}`;
}
