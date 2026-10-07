// Small helpers shared by every section: number and date formats, the API,
// the Tsum catalog and each Tsum's colour.
import {isSnapshot, snapshotApi} from './snapshot/client.js';

export const IMAGE_URL = id => `https://tsum-assets.gapapp.app/tsums/block_${encodeURIComponent(id)}_l.png`;

const nf = new Intl.NumberFormat();
const nf1 = new Intl.NumberFormat(undefined, {maximumFractionDigits: 1});
export const fmt = v => (v === null || v === undefined ? '—' : nf.format(Math.round(v)));
export const fmt1 = v => (v === null || v === undefined ? '—' : nf1.format(v));

export function fmtDuration(sec) {
  if (sec === null || sec === undefined) return '—';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// played_at is UTC "YYYY-MM-DD HH:MM:SS"; shown in the viewer's time.
export const parseUTC = s => new Date(s.replace(' ', 'T') + 'Z');
const dtf = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'});
export const fmtWhen = s => (s ? dtf.format(parseUTC(s)) : '—');

export const cap = w => w[0].toUpperCase() + w.slice(1);
export const buildLabel = b => ({global: 'INTL', jp: 'JP'}[b] || '—');

/** A theme token's current value, e.g. css('--coin'). */
export const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// A device is online while it is connected and has been heard from lately;
// the app sends a heartbeat every 15 s.
const STALE_MS = 45000;
export const isOnline = d => d.online && Date.now() - new Date(d.lastSeen).getTime() < STALE_MS;

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// The catalog: every Tsum in either build, with each build's name.
let catalogPromise;
export function loadCatalog() {
  catalogPromise ??= fetch('data/catalog.json').then(r => r.json()).then(c => {
    c.byId = new Map(c.tsums.map(t => [t.id, t]));
    return c;
  });
  return catalogPromise;
}

/** A Tsum's name for a build, falling back to the other build's, then the id. */
export function tsumName(catalog, id, build = 'global') {
  const t = catalog?.byId.get(id);
  if (!t) return id || 'Unknown';
  return (build === 'jp' ? t.jp || t.global : t.global || t.jp) || id;
}

/** "Mickey Mouse" → "MM", for a portrait whose art is missing. */
export function initials(name) {
  const words = (name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
}

export async function api(path, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined));
  // A published snapshot has no server: the same routes are answered in the browser.
  if (isSnapshot()) return snapshotApi(path, Object.fromEntries(q));
  const res = await fetch(`/api/stats/${path}${q.size ? '?' + q : ''}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

// Each Tsum's chart colour is in the catalog. A Tsum the catalog lacks gets a
// hue from its id, in the same lightness band.
export const otherColor = () => css('--chart-other');
export function tsumColor(catalog, id) {
  if (!id) return otherColor();
  const c = catalog?.byId.get(id)?.color;
  if (c) return c;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `oklch(0.61 0.13 ${h % 360})`;
}

// Boost items, as a bitmask, with what each costs; the server's itemBits has the same list.
export const ITEMS = [
  {bit: 1, label: '+Coin', cost: 500}, {bit: 2, label: '5>4', cost: 1800}, {bit: 4, label: '+Time', cost: 1000},
  {bit: 8, label: '+Exp', cost: 500}, {bit: 16, label: '+Score', cost: 500}, {bit: 32, label: '+Bubble', cost: 1500},
  {bit: 64, label: '+Combo', cost: 1200},
];
/** What a round's items cost, or null for rounds recorded before items were. */
export function itemsCost(mask) {
  if (mask === null || mask === undefined || mask < 0) return null;
  return ITEMS.reduce((sum, i) => (mask & i.bit ? sum + i.cost : sum), 0);
}
/** "+Coin · 5>4", "No items", or "Unknown" for rounds recorded before items were. */
export function itemsLabel(mask) {
  if (mask === null || mask === undefined || mask < 0) return 'Unknown';
  if (!mask) return 'No items';
  return ITEMS.filter(i => mask & i.bit).map(i => i.label).join(' · ');
}

// Small rates (medals per second) keep two significant digits instead of rounding to 0.
const sig2 = new Intl.NumberFormat(undefined, {maximumSignificantDigits: 2});
export const fmtRate = v => (v === null || v === undefined ? '—' : (Math.abs(v) < 1 ? sig2 : nf1).format(v));
export const pct = v => (v === null || v === undefined ? '—' : `${nf1.format(v * 100)}%`);

/** A localStorage JSON value; private mode or bad JSON gives fallback. */
export function loadPref(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
export function savePref(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: reset next visit */ }
}
