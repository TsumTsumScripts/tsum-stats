// Copy a stat container as an image: a compact card of the panel's figures,
// the Tsum it is about (portrait and name) when the page is about one, the
// filters in a line and the rounds counted. The page says what goes in the
// header and footer through the 'card' context (cardContext); a Chart keeps
// its draw function on its box (box.cardDraw) so the card draws it afresh at
// the card's width instead of shrinking the page's picture.
import {getContext, setContext} from 'svelte';
import {toBlob} from 'html-to-image';
import {isGlobal} from './global/client.js';
import {isSnapshot} from './snapshot/client.js';
import {IMAGE_URL, fmt, initials} from './util.js';
import {toast} from './ui.svelte.js';

/** The card's width in CSS pixels; it is drawn at twice that. */
const CARD_W = 620;
/** Table rows and columns a card keeps. */
const MAX_ROWS = 10, MAX_COLS = 5;
/** Controls that do nothing in a picture. */
const DROP = '.copy-btn, .toggles, .seg, .table-tools, .pager, .col-menu, .expand-btn, .linkish.dim, .target, input, select, textarea';

/**
 * Sets what a page's cards say: get() returns {tsum, build, unit, filters: [text], rounds}.
 * tsum is the one Tsum the page is about, or ''; build names it in that game;
 * unit is the primary stat's, 'coins' or 'medals', whose columns a cut table keeps.
 */
export const cardContext = get => setContext('card', get);
export const cardInfo = () => getContext('card');

/**
 * The Tsum art's origin sends no CORS headers, so the page cannot read its
 * files. The stats server fetches them for it (/api/stats/art/<id>, art.go); a
 * snapshot or the global site has no server and asks the origin itself, which
 * works once the origin allows it, and until then the card shows initials.
 */
const [ART_PRE, ART_POST] = IMAGE_URL('\u0001').split(encodeURIComponent('\u0001'));
function viaServer(src) {
  if (isGlobal() || isSnapshot() || !src.startsWith(ART_PRE) || !src.endsWith(ART_POST)) return src;
  return `api/stats/art/${src.slice(ART_PRE.length, src.length - ART_POST.length)}`;
}

async function dataURL(src) {
  const res = await fetch(viaServer(src), {mode: 'cors'});
  if (!res.ok) throw new Error(String(res.status));
  const blob = await res.blob();
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = fail;
    r.readAsDataURL(blob);
  });
}

/** Every picture in node as a data URL; one that cannot be had is dropped (an avatar then shows its initials). */
async function inlineImages(node) {
  const imgs = [...node.querySelectorAll('img')].map(el => [el, el.getAttribute('src'), v => el.setAttribute('src', v)]);
  const svgImgs = [...node.querySelectorAll('image')].map(el => [el, el.getAttribute('href'), v => el.setAttribute('href', v)]);
  await Promise.all([...imgs, ...svgImgs].map(async ([el, src, set]) => {
    if (!src || src.startsWith('data:')) return;
    try {
      set(await dataURL(src));
      el.removeAttribute('loading');
    } catch {
      el.remove();
    }
  }));
}

/**
 * The panel's tables, cut to their first rows and to the columns that matter
 * most, kept in their order: the first (what the row is), the Tsum, the one
 * they are sorted by, the primary stat's own (cells classed primary), the rest
 * of its unit's (unit: 'coins' or 'medals', cells classed coin or medal), then
 * the rest from the left. Each kept cell carries its rank (data-cc-rank) for
 * fitTables. A note says how
 * many rows were left out, of the table's whole count (data-rows) when it is
 * paged. A column whose cells are controls (the compare ticks) goes, header
 * and all. Head to head keeps every row: they are its figures, not a list.
 */
function condenseTables(body, unit) {
  for (const table of body.querySelectorAll('table')) {
    const rows = [...table.tBodies].flatMap(b => [...b.rows]);
    const maxRows = table.classList.contains('versus') ? Infinity : MAX_ROWS;
    const cut = Math.max(rows.length, Number(table.dataset.rows) || 0) - maxRows;
    rows.slice(maxRows).forEach(r => r.remove());
    const first = table.tBodies[0]?.rows[0];
    const heads = table.tHead?.rows[0] ? [...table.tHead.rows[0].cells] : [];
    const n = Math.max(heads.length, first?.cells.length ?? 0);
    const cells = first ? [...first.cells] : [];
    const controls = new Set(cells.flatMap((c, i) => (c.classList.contains('pick') ? [i] : [])));
    const cols = [...Array(n).keys()].filter(i => !controls.has(i));
    const sorted = heads.findIndex(h => ['ascending', 'descending'].includes(h.getAttribute('aria-sort')));
    const unitCls = unit === 'medals' ? 'medal' : 'coin';
    const ranked = [
      cols[0],
      ...cols.filter(i => cells[i]?.querySelector('.tsum-cell')),
      ...(cols.includes(sorted) ? [sorted] : []),
      ...cols.filter(i => cells[i]?.classList.contains('primary')),
      ...cols.filter(i => cells[i]?.classList.contains(unitCls)),
      ...cols,
    ];
    const order = [...new Set(ranked)].slice(0, MAX_COLS);
    const keep = new Set(order);
    for (const r of table.rows) {
      // A row of one wide cell (an empty table's note) stays as it is.
      if (r.cells.length < n) continue;
      [...r.cells].forEach((c, i) => (keep.has(i) ? (c.dataset.ccRank = order.indexOf(i)) : c.remove()));
    }
    // A fixed layout's column widths go with their columns.
    const colEls = [...table.querySelectorAll(':scope > colgroup > col')];
    if (colEls.length === n) colEls.forEach((c, i) => !keep.has(i) && c.remove());
    if (cut > 0) {
      const td = table.tBodies[0].insertRow().insertCell();
      td.colSpan = keep.size;
      td.className = 'dim cc-more';
      td.textContent = `and ${fmt(cut)} more`;
    }
  }
}

/**
 * A cut table still wider than the card (long Tsum names, wide figures) loses
 * its least important column, by rank, until it fits; the first two stay.
 * Run once the card is in the page, so the table can be measured.
 */
function fitTables(body) {
  for (const table of body.querySelectorAll('table')) {
    for (;;) {
      if (table.offsetWidth <= body.clientWidth) break;
      const ranks = [...(table.tBodies[0]?.rows[0]?.cells ?? [])].map(c => Number(c.dataset.ccRank ?? -1));
      const worst = Math.max(...ranks);
      if (ranks.length <= 2 || worst < 2) break;
      table.querySelectorAll(`[data-cc-rank="${worst}"]`).forEach(c => c.remove());
      table.querySelectorAll('.cc-more').forEach(c => (c.colSpan -= 1));
    }
  }
}

/** The card's chart boxes, drawn again at the card's width from the page's own (box.cardDraw). */
function redrawCharts(body, from) {
  const originals = [...from.querySelectorAll('.chart')];
  [...body.querySelectorAll('.chart')].forEach((box, i) => {
    const src = originals[i]?.cardDraw;
    box.replaceChildren();
    if (!src) return;
    src.redraw(box);
    // A chart taller than its box (one row per Tsum) scrolls in the page; the card shows all of it.
    const svg = box.querySelector('svg');
    if (svg?.style.height) box.style.height = svg.style.height;
  });
}

/**
 * A chart drawn in rows from the top (items, ranked Tsums) fills only part of
 * its box; the card ends it below what was drawn instead of keeping the box's
 * empty height. Run once the card is in the page, so the shapes can be measured.
 */
function trimCharts(body) {
  for (const box of body.querySelectorAll('.chart')) {
    const svg = box.querySelector(':scope > svg');
    const vb = svg?.viewBox.baseVal;
    if (!vb?.height || !svg.children.length) continue;
    const r = svg.getBoundingClientRect();
    const bottom = Math.max(...[...svg.querySelectorAll('rect, text, line, path, circle, image')].map(c => c.getBoundingClientRect().bottom));
    const h = Math.ceil((bottom - r.top) * (vb.width / r.width) + 12);
    if (h >= vb.height - 24) continue;
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${h}`);
    svg.style.height = box.style.height = `${h}px`;
  }
}

/** What the charts' stylesheet rules set on svg shapes and text, which the picture library leaves out: copied onto each. */
const SVG_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'opacity', 'display',
  'font-family', 'font-size', 'font-weight', 'letter-spacing', 'text-anchor', 'dominant-baseline', 'paint-order'];
function inlineSvgStyles(node) {
  for (const n of node.querySelectorAll('svg *')) {
    const cs = getComputedStyle(n);
    for (const p of SVG_PROPS) n.style.setProperty(p, cs.getPropertyValue(p));
  }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function avatar(id, name) {
  const a = el('span', 'avatar lg', initials(name));
  const img = el('img');
  img.alt = '';
  img.src = IMAGE_URL(id);
  a.append(img);
  return a;
}

/**
 * The card for a stat container: title, the cloned content (from), and what the
 * page's card context says. nameOf names the Tsum.
 */
function buildCard({title, sub, from, info, nameOf}) {
  // The views picked in the panel's own toggles (Ranked, Coins/s) say what its chart measures.
  sub ||= [...from.querySelectorAll(':scope > .panel-head .seg:not([hidden]) [aria-pressed="true"]')]
    .map(b => b.textContent.trim() || b.getAttribute('aria-label')).filter(Boolean).join(' · ');
  const card = el('div', 'copy-card');
  card.style.width = `${CARD_W}px`;
  const head = el('div', 'cc-head');
  if (info.tsum) head.append(avatar(info.tsum, nameOf(info.tsum)));
  const words = el('div', 'cc-title');
  if (info.tsum) words.append(el('div', 'cc-tsum', nameOf(info.tsum)));
  words.append(el('h2', '', title));
  if (sub) words.append(el('div', 'cc-sub', sub));
  head.append(words);

  // The panel's own title row is the card's head; its frame is the card's.
  const body = from.cloneNode(true);
  body.removeAttribute('id');
  body.removeAttribute('style');
  body.querySelector(':scope > .panel-head')?.remove();
  body.classList.remove('panel', 'expanded', 'anchor', 'wide');
  body.classList.add('cc-body');
  condenseTables(body, info.unit);
  body.querySelectorAll(DROP).forEach(n => n.remove());
  // A Tsum name that is a button in the page is plain text in the picture.
  body.querySelectorAll('button').forEach(b => b.replaceWith(...b.childNodes));

  const foot = el('div', 'cc-foot');
  foot.append(el('span', 'cc-filters', info.filters.filter(Boolean).join(' · ')));
  const rounds = el('span', 'cc-rounds');
  rounds.append(el('b', '', fmt(info.rounds ?? 0)), ` ${info.rounds === 1 ? 'round' : 'rounds'}`);
  foot.append(rounds);
  const brand = el('div', 'cc-brand', `${isGlobal() ? 'Tsum Tsum Global Stats' : 'Tsum Tsum Stats'} · ${new Date().toLocaleDateString(undefined, {dateStyle: 'medium'})}`);

  card.append(head, body, foot, brand);
  return {card, body};
}

/**
 * The coin and medal icons drawn by ::before rules. The picture library copies a
 * pseudo-element's style as text and does not fetch the files it names, so the
 * card gets the same rules with the files as data URLs.
 */
let iconStyle = null;
async function icons() {
  if (iconStyle) return iconStyle;
  const [coin, medal] = await Promise.all(['img/coin.png', 'img/medal.png'].map(f => dataURL(new URL(f, document.baseURI).href).catch(() => 'none')));
  iconStyle = `.copy-card .kpi.coin .value::before, .copy-card .to-max b::before { background-image: url("${coin}"); }
.copy-card .kpi.medal .value::before, .copy-card .to-max.medals b::before { background-image: url("${medal}"); }`;
  return iconStyle;
}

/** A host off screen, in the page so the theme's tokens and fonts apply. */
async function host() {
  const h = el('div', 'cc-host');
  h.append(el('style', '', await icons()));
  document.body.append(h);
  return h;
}

/** The card as a PNG blob, built in a host off screen and removed after. */
async function render(opts) {
  const h = await host();
  try {
    const {card, body} = buildCard(opts);
    h.append(card);
    redrawCharts(body, opts.from);
    trimCharts(body);
    fitTables(body);
    await inlineImages(card);
    inlineSvgStyles(card);
    const blob = await toBlob(card, {pixelRatio: 2});
    if (!blob) throw new Error('nothing drawn');
    return blob;
  } finally {
    h.remove();
  }
}

/**
 * Copies a stat container to the clipboard as a PNG; where the browser cannot,
 * downloads it. from: the element whose content the card shows. The clipboard
 * is asked at once, with the image to come, so the click still counts as the
 * user's when the picture is ready.
 */
export async function copyCard(opts) {
  const blob = render(opts);
  try {
    if (navigator.clipboard?.write && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
      toast('Copied as an image');
    } else {
      const a = el('a');
      a.href = URL.createObjectURL(await blob);
      a.download = `${opts.file || 'tsum-stats'}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('This browser cannot copy images, so it was downloaded');
    }
  } catch (e) {
    toast(`Could not copy: ${e.message}`, 6000);
  }
}
