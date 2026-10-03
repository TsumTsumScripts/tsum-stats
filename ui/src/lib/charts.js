// The Stats section's d3 charts. Each draw function fills an SVG in its box
// and returns the legend items for Legend.svelte ({id?, label, color, value?}).
// Chart.svelte calls them again when the data, the box size or the theme changes.
// A Tsum is always drawn in its own colour, with its portrait where there is room.
// ctx, passed to the Tsum charts: {nameOf(id), colorOf(id), onPick(id, event)}.
import * as d3 from 'd3';
import {IMAGE_URL, css, fmt, fmtRate, initials, itemsLabel, otherColor, pct} from './util.js';
import {b, dim, hideTip, showTip, sw} from './ui.svelte.js';

const parseDay = d3.timeParse('%Y-%m-%d');
const dayLabel = new Intl.DateTimeFormat(undefined, {weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'});
const hourLabel = new Intl.DateTimeFormat(undefined, {hour: 'numeric'});
const hourName = h => hourLabel.format(new Date(2000, 0, 1, h));
const compact = new Intl.NumberFormat(undefined, {notation: 'compact', maximumFractionDigits: 1});
const OTHER = '__other';

// The primary stat's word in labels: 'coins' or 'medals'. Chart.svelte sets it before drawing.
let U = 'coins';
const cap = w => w[0].toUpperCase() + w.slice(1);
export function setUnit(unit) { U = unit; }

/** minHeight makes the svg taller than the box, which then scrolls. */
function frame(container, margin, minHeight = 0) {
  d3.select(container).selectAll('*').remove();
  const width = container.clientWidth, height = Math.max(container.clientHeight, minHeight);
  const svg = d3.select(container).append('svg').attr('viewBox', `0 0 ${width} ${height}`);
  if (minHeight > container.clientHeight) svg.style('height', `${height}px`);
  const inner = {w: Math.max(10, width - margin.left - margin.right), h: Math.max(10, height - margin.top - margin.bottom)};
  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
  return {svg, g, width, height, inner};
}

function empty(f, text = 'No rounds match these filters') {
  f.svg.append('text').attr('class', 'empty').attr('x', f.width / 2).attr('y', f.height / 2)
    .attr('text-anchor', 'middle').text(text);
  return [];
}

let clipSeq = 0;
/** A round Tsum portrait centred on (x, y): initials under the art, which hides itself if missing. */
function portrait(sel, id, name, r, x = 0, y = 0) {
  const g = sel.append('g').attr('class', 'portrait').attr('transform', `translate(${x},${y})`).style('pointer-events', 'none');
  const clip = `pc${++clipSeq}`;
  g.append('clipPath').attr('id', clip).append('circle').attr('r', r);
  g.append('circle').attr('r', r).attr('fill', css('--avatar-b'));
  g.append('text').attr('text-anchor', 'middle').attr('dy', '0.35em').attr('fill', css('--muted'))
    .style('font', `800 ${Math.max(8, r * 0.8)}px ${css('--font-display')}`)
    .text(initials(name));
  if (id) {
    g.append('image').attr('href', IMAGE_URL(id)).attr('x', -r).attr('y', -r).attr('width', 2 * r).attr('height', 2 * r)
      .attr('clip-path', `url(#${clip})`).attr('preserveAspectRatio', 'xMidYMid meet')
      .on('error', function () { this.remove(); });
  }
  return g;
}

/** The n Tsums with the most of value(), in their colours, then "Other" for the rest. */
function topKeys(ids, value, n, ctx) {
  const totals = new Map();
  for (const id of ids) totals.set(id, (totals.get(id) || 0) + value(id));
  const ranked = [...totals].filter(([id]) => id).sort((a, b) => b[1] - a[1]);
  const keys = ranked.slice(0, n).map(([id]) => id);
  const rest = ranked.length > n || totals.has('');
  return {keys: rest ? [...keys, OTHER] : keys, keyOf: id => (keys.includes(id) ? id : OTHER),
    color: k => (k === OTHER ? otherColor() : ctx.colorOf(k)), label: k => (k === OTHER ? 'Other' : ctx.nameOf(k) || 'Not identified')};
}
const keyLegend = top => top.keys.map(k => ({id: k === OTHER ? null : k, label: top.label(k), color: top.color(k)}));

function hoverable(sel, tip, pick) {
  sel.on('pointermove', (e, d) => showTip(tip(d), e)).on('pointerleave', hideTip);
  // pick(d) returns the click action for d, or nothing when d is not clickable.
  if (pick) sel.style('cursor', d => (pick(d) ? 'pointer' : null)).on('click', (e, d) => { const go = pick(d); if (go) { hideTip(); go(e); } });
  return sel;
}

function dayAxes(f, x, y, fmtY = v => compact.format(v)) {
  const {g, inner} = f;
  g.append('g').attr('class', 'grid').call(d3.axisLeft(y).ticks(5).tickSize(-inner.w).tickFormat(''));
  // One tick a day at most: a short range would otherwise get several per day.
  const n = Math.max(2, Math.floor(inner.w / 90));
  const ticks = d3.timeDay.count(...x.domain()) <= n ? d3.timeDay.every(1) : n;
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${inner.h})`)
    .call(d3.axisBottom(x).ticks(ticks).tickFormat(d3.timeFormat('%b %-d')).tickSizeOuter(0));
  g.append('g').attr('class', 'axis').call(d3.axisLeft(y).ticks(5).tickFormat(fmtY).tickSizeOuter(0));
}

/** A hover layer that finds the nearest day and hands it to show(). */
function dayHover(f, x, points, show) {
  const {g, inner} = f;
  const rule = g.append('line').attr('y1', 0).attr('y2', inner.h).attr('stroke', css('--chart-rule')).style('display', 'none');
  const bisect = d3.bisector(p => p.date).center;
  g.append('rect').attr('width', inner.w).attr('height', inner.h).attr('fill', 'transparent')
    .on('pointermove', event => {
      const [mx] = d3.pointer(event);
      const p = points[bisect(points, x.invert(mx))];
      if (!p) return;
      rule.attr('x1', x(p.date)).attr('x2', x(p.date)).style('display', null);
      show(p, event);
    })
    .on('pointerleave', () => { rule.style('display', 'none'); hideTip(); });
}

/** A day line with a lowest–highest band, broken where days are missing. */
function bandLine(f, pts, x, y, color, get) {
  const {g} = f;
  const seg = pts.flatMap((p, i) => (i && d3.timeDay.count(pts[i - 1].date, p.date) > 1 ? [null, p] : [p]));
  if (get.lo) {
    g.append('path').datum(seg).attr('fill', color).attr('fill-opacity', 0.14)
      .attr('d', d3.area().defined(p => p).x(p => x(p.date)).y0(p => y(get.lo(p))).y1(p => y(get.hi(p))).curve(d3.curveMonotoneX));
  }
  g.append('path').datum(seg).attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2)
    .attr('d', d3.line().defined(p => p).x(p => x(p.date)).y(p => y(get.mid(p))).curve(d3.curveMonotoneX));
  if (pts.length <= 60) {
    g.append('g').selectAll('circle').data(pts).join('circle')
      .attr('cx', p => x(p.date)).attr('cy', p => y(get.mid(p))).attr('r', 4)
      .attr('fill', css('--bg')).attr('stroke', color).attr('stroke-width', 2);
  }
}

function dayScale(f, pts) {
  const x = d3.scaleTime().domain(d3.extent(pts, p => p.date)).range([0, f.inner.w]);
  if (pts.length === 1) x.domain([d3.timeDay.offset(pts[0].date, -1), d3.timeDay.offset(pts[0].date, 1)]);
  return x;
}

/** Tooltip lines for a stack: a swatch, name and value per key, largest first. */
const stackLines = (top, p) => top.keys.filter(k => p[k]).sort((a, c) => p[c] - p[a])
  .map(k => [sw(top.color(k)), `${top.label(k)} `, b(fmt(p[k]))]);

// ---- Coins per day: stacked by Tsum, the coin rate, or average with its range ----

export function drawDaily(container, daily, dailyTsums, ctx, mode) {
  const f = frame(container, {top: 12, right: 16, bottom: 26, left: 52});
  const {g, inner} = f;
  if (mode === 'rate' || mode === 'avg') {
    const get = mode === 'rate'
      ? {mid: p => p.coinsPerSec}
      : {mid: p => p.avgCoins, lo: p => p.minCoins, hi: p => p.maxCoins};
    const pts = daily.filter(d => get.mid(d) !== null).map(d => ({...d, date: parseDay(d.day)}));
    if (!pts.length) return empty(f);
    const x = dayScale(f, pts);
    const lo = d3.min(pts, get.lo || get.mid), hi = d3.max(pts, get.hi || get.mid);
    const y = d3.scaleLinear().domain([Math.max(0, lo - (hi - lo) * 0.15), hi * 1.03]).nice().range([inner.h, 0]);
    dayAxes(f, x, y, mode === 'rate' ? v => fmtRate(v) : undefined);
    bandLine(f, pts, x, y, css('--coin'), get);
    dayHover(f, x, pts, (p, e) => showTip([[b(dayLabel.format(p.date))], [`${fmt(p.rounds)} rounds`], ...(mode === 'rate'
      ? [[b(fmtRate(p.coinsPerSec)), ` ${U} per second`]]
      : [['Average ', b(fmt(p.avgCoins)), ` ${U}`], [`Lowest ${fmt(p.minCoins)} · Highest ${fmt(p.maxCoins)}`]])], e));
    return [];
  }

  const rows = dailyTsums.filter(r => r.coins !== null);
  if (!rows.length) return empty(f);
  const top = topKeys(rows.map(r => r.tsum), id => rows.filter(r => r.tsum === id).reduce((s, r) => s + r.coins, 0), 7, ctx);
  const byDay = d3.rollup(rows, rs => {
    const o = {};
    for (const r of rs) o[top.keyOf(r.tsum)] = (o[top.keyOf(r.tsum)] || 0) + r.coins;
    return o;
  }, r => r.day);
  const pts = [...byDay].map(([day, o]) => ({day, date: parseDay(day), ...Object.fromEntries(top.keys.map(k => [k, o[k] || 0]))}))
    .sort((a, c) => a.date - c.date);
  const series = d3.stack().keys(top.keys)(pts);
  const [lo, hi] = d3.extent(pts, p => p.date);
  const x = d3.scaleTime().domain([d3.timeHour.offset(lo, -12), d3.timeHour.offset(hi, 12)]).range([0, inner.w]);
  const days = Math.max(1, d3.timeDay.count(lo, hi) + 1);
  const bw = Math.max(1, Math.min(30, inner.w / days - 2));
  const y = d3.scaleLinear().domain([0, d3.max(series.at(-1), s => s[1])]).nice().range([inner.h, 0]);
  dayAxes(f, x, y);
  // A 2px gap between stacked segments, taken from the top of each.
  g.append('g').selectAll('g').data(series).join('g').attr('fill', s => top.color(s.key))
    .selectAll('rect').data(s => s).join('rect')
    .attr('x', s => x(s.data.date) - bw / 2).attr('width', bw)
    .attr('y', s => y(s[1]) + (s[1] > s[0] ? 1 : 0)).attr('height', s => Math.max(0, y(s[0]) - y(s[1]) - 2))
    .attr('rx', Math.min(3, bw / 4));
  dayHover(f, x, pts, (p, e) => {
    const total = top.keys.reduce((s, k) => s + p[k], 0);
    showTip([[b(dayLabel.format(p.date))], [b(fmt(total)), ` ${U}`], ...stackLines(top, p)], e);
  });
  return keyLegend(top);
}

// ---- Head to head: one line per compared Tsum, per day ----

const COMPARE = {
  rate: {get: r => r.coinsPerSec, fmt: v => fmtRate(v), name: () => `${U} per second`},
  avg: {get: r => r.avgCoins, fmt: v => fmt(v), name: () => `average ${U}`},
  total: {get: r => r.coins, fmt: v => fmt(v), name: () => `total ${U}`},
  rounds: {get: r => r.rounds, fmt: v => fmt(v), name: () => 'rounds'},
};

export function drawCompare(container, dailyTsums, ids, ctx, metric) {
  const f = frame(container, {top: 12, right: 16, bottom: 26, left: 52});
  const {inner} = f;
  const m = COMPARE[metric] || COMPARE.rate;
  const rows = dailyTsums.filter(r => ids.includes(r.tsum) && m.get(r) !== null).map(r => ({...r, date: parseDay(r.day)}));
  const items = ids.map(id => ({id, label: ctx.nameOf(id) || 'Not identified', color: ctx.colorOf(id)}));
  if (!rows.length) { empty(f); return items; }
  const x = dayScale(f, rows);
  const y = d3.scaleLinear().domain([0, d3.max(rows, m.get) * 1.05]).nice().range([inner.h, 0]);
  dayAxes(f, x, y, metric === 'rate' ? v => fmtRate(v) : undefined);
  for (const id of ids) {
    const pts = rows.filter(r => r.tsum === id).sort((a, c) => a.date - c.date);
    if (pts.length) bandLine(f, pts, x, y, ctx.colorOf(id), {mid: m.get});
  }
  const days = [...d3.group(rows, r => r.day)].map(([day, rs]) => ({date: parseDay(day), rs})).sort((a, c) => a.date - c.date);
  dayHover(f, x, days, (p, e) => showTip([[b(dayLabel.format(p.date)), ` · ${m.name()}`],
    ...[...p.rs].sort((a, c) => m.get(c) - m.get(a)).map(r => [sw(ctx.colorOf(r.tsum)), `${ctx.nameOf(r.tsum) || 'Not identified'} `,
      b(m.fmt(m.get(r))), ' ', dim(`${fmt(r.rounds)} rounds`)])], e));
  return items;
}

// ---- Coin efficiency per Tsum: ranked bars, box plot, bubbles ----

const METRICS = {
  rate: {get: t => t.coinsPerSec, fmt: fmtRate, name: () => `${U} per second`},
  avg: {get: t => t.avgCoins, fmt, name: () => `average ${U}`},
  median: {get: t => t.medianCoins, fmt, name: () => `median ${U}`},
  max: {get: t => t.maxCoins, fmt, name: () => `best ${U}`},
};

const tsumTip = (t, ctx) => [
  [sw(ctx.colorOf(t.tsum)), b(ctx.nameOf(t.tsum) || 'Not identified')],
  [`${fmt(t.rounds)} rounds`],
  [b(fmtRate(t.coinsPerSec)), ` ${U}/s · ${fmt(t.coinsPerSec === null ? null : t.coinsPerSec * 3600)} ${U}/h`],
  ['Average ', b(fmt(t.avgCoins)), ` · median ${fmt(t.medianCoins)}`],
  [`Lowest ${fmt(t.minCoins)} · highest ${fmt(t.maxCoins)}`],
];

const ROW_H = 32; // px per Tsum row in the ranked and spread charts

/** Tsum rows down the left: portrait and name, clickable to filter. */
function tsumAxis(f, rows, y, ctx) {
  const r = Math.min(13, y.bandwidth() / 2);
  const lab = f.g.append('g').selectAll('g').data(rows).join('g')
    .attr('transform', t => `translate(0,${y(t.tsum) + y.bandwidth() / 2})`);
  hoverable(lab, t => tsumTip(t, ctx), t => t.tsum && (e => ctx.onPick(t.tsum, e)));
  lab.each(function (t) { portrait(d3.select(this), t.tsum, ctx.nameOf(t.tsum), r, -r - 6, 0); });
  const maxChars = Math.max(6, Math.floor((f.margin - 2 * r - 20) / 7));
  lab.append('text').attr('x', -2 * r - 12).attr('dy', '0.35em').attr('text-anchor', 'end').attr('class', 'tick-label')
    .text(t => { const n = ctx.nameOf(t.tsum) || 'Not identified'; return n.length > maxChars ? n.slice(0, maxChars - 1) + '…' : n; });
}

function drawRate(container, tsums, ctx, metric) {
  const m = METRICS[metric] || METRICS.rate;
  const rows = tsums.filter(t => m.get(t) !== null).sort((a, c) => m.get(c) - m.get(a));
  const left = Math.min(200, container.clientWidth * 0.42);
  const f = frame(container, {top: 4, right: 52, bottom: 24, left}, rows.length * ROW_H + 28);
  f.margin = left;
  const {g, inner} = f;
  if (!rows.length) return empty(f);
  const y = d3.scaleBand().domain(rows.map(t => t.tsum)).range([0, Math.min(inner.h, rows.length * ROW_H)]).padding(0.2);
  const x = d3.scaleLinear().domain([0, d3.max(rows, m.get)]).nice().range([0, inner.w]);
  g.append('g').attr('class', 'grid').attr('transform', `translate(0,${y.range()[1]})`)
    .call(d3.axisBottom(x).ticks(5).tickSize(-y.range()[1]).tickFormat(''));
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${y.range()[1]})`)
    .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(inner.w / 80))).tickFormat(v => (metric === 'rate' ? fmtRate(v) : compact.format(v))).tickSizeOuter(0));
  tsumAxis(f, rows, y, ctx);
  const bars = g.append('g').selectAll('g').data(rows).join('g').attr('transform', t => `translate(0,${y(t.tsum)})`);
  hoverable(bars, t => tsumTip(t, ctx), t => t.tsum && (e => ctx.onPick(t.tsum, e)));
  bars.append('rect').attr('width', inner.w + 50).attr('height', y.bandwidth()).attr('fill', 'transparent');
  bars.append('rect').attr('height', y.bandwidth()).attr('width', t => Math.max(2, x(m.get(t))))
    .attr('rx', Math.min(4, y.bandwidth() / 2)).attr('fill', t => ctx.colorOf(t.tsum));
  bars.append('text').attr('x', t => x(m.get(t)) + 6).attr('y', y.bandwidth() / 2).attr('dy', '0.35em').attr('class', 'value-label')
    .text(t => m.fmt(m.get(t)));
  return [];
}

function drawBox(container, tsums, ctx) {
  const rows = tsums.filter(t => t.medianCoins !== null);
  const left = Math.min(200, container.clientWidth * 0.42);
  const f = frame(container, {top: 4, right: 16, bottom: 24, left}, rows.length * ROW_H + 28);
  f.margin = left;
  const {g, inner} = f;
  if (!rows.length) return empty(f);
  const y = d3.scaleBand().domain(rows.map(t => t.tsum)).range([0, Math.min(inner.h, rows.length * ROW_H)]).padding(0.28);
  // The scale stops a little past the highest 90th percentile, so one freak
  // round does not squash every box; a highest round beyond it is an arrow.
  const x = d3.scaleLinear().domain([0, d3.max(rows, t => t.p90Coins) * 1.12]).nice().range([0, inner.w]);
  const h = y.range()[1];
  g.append('g').attr('class', 'grid').attr('transform', `translate(0,${h})`).call(d3.axisBottom(x).ticks(6).tickSize(-h).tickFormat(''));
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${h})`)
    .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(inner.w / 80))).tickFormat(v => compact.format(v)).tickSizeOuter(0));
  tsumAxis(f, rows, y, ctx);
  const ink = css('--ink'), well = css('--well');
  const box = g.append('g').selectAll('g').data(rows).join('g').attr('transform', t => `translate(0,${y(t.tsum)})`);
  hoverable(box, t => [...tsumTip(t, ctx), [`Middle half ${fmt(t.q1Coins)}–${fmt(t.q3Coins)} · 90th percentile ${fmt(t.p90Coins)}`]],
    t => t.tsum && (e => ctx.onPick(t.tsum, e)));
  const mid = y.bandwidth() / 2;
  box.append('rect').attr('width', inner.w).attr('height', y.bandwidth()).attr('fill', 'transparent');
  box.append('line').attr('x1', t => x(t.minCoins)).attr('x2', t => x(t.p90Coins)).attr('y1', mid).attr('y2', mid)
    .attr('stroke', t => ctx.colorOf(t.tsum)).attr('stroke-width', 2);
  for (const k of ['minCoins', 'p90Coins']) {
    box.append('line').attr('x1', t => x(t[k])).attr('x2', t => x(t[k])).attr('y1', mid - 5).attr('y2', mid + 5)
      .attr('stroke', t => ctx.colorOf(t.tsum)).attr('stroke-width', 2);
  }
  box.append('rect').attr('x', t => x(t.q1Coins)).attr('width', t => Math.max(3, x(t.q3Coins) - x(t.q1Coins)))
    .attr('height', y.bandwidth()).attr('rx', 4).attr('fill', t => ctx.colorOf(t.tsum));
  box.append('line').attr('x1', t => x(t.medianCoins)).attr('x2', t => x(t.medianCoins)).attr('y1', 2).attr('y2', y.bandwidth() - 2)
    .attr('stroke', well).attr('stroke-width', 3);
  box.append('circle').attr('cx', t => Math.min(inner.w, x(t.avgCoins))).attr('cy', mid).attr('r', 4)
    .attr('fill', ink).attr('stroke', well).attr('stroke-width', 2);
  const [, top] = x.domain();
  box.filter(t => t.maxCoins > t.p90Coins).append('circle').attr('cx', t => x(Math.min(t.maxCoins, top))).attr('cy', mid).attr('r', 3.5)
    .attr('fill', 'none').attr('stroke', t => ctx.colorOf(t.tsum)).attr('stroke-width', 2);
  box.filter(t => t.maxCoins > top).append('text').attr('class', 'value-label').attr('x', inner.w - 8).attr('y', mid).attr('dy', '0.35em')
    .attr('text-anchor', 'end').text(t => `▸ ${compact.format(t.maxCoins)}`);
  return [];
}

function drawBubble(container, tsums, ctx) {
  const pts = tsums.filter(t => t.avgCoins !== null && t.coinsPerSec !== null);
  const f = frame(container, {top: 16, right: 24, bottom: 40, left: 56});
  const {g, inner} = f;
  if (!pts.length) return empty(f);
  const pad = (lo, hi) => { const d = (hi - lo) || Math.max(1, hi * 0.2); return [Math.max(0, lo - d * 0.15), hi + d * 0.15]; };
  const x = d3.scaleLinear().domain(pad(...d3.extent(pts, t => t.avgCoins))).nice().range([0, inner.w]);
  const y = d3.scaleLinear().domain(pad(...d3.extent(pts, t => t.coinsPerSec))).nice().range([inner.h, 0]);
  const r = d3.scaleSqrt().domain([0, d3.max(pts, t => t.rounds)]).range([6, Math.max(14, Math.min(40, inner.w / 12))]);
  g.append('g').attr('class', 'grid').call(d3.axisLeft(y).ticks(5).tickSize(-inner.w).tickFormat(''));
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${inner.h})`)
    .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(inner.w / 80))).tickFormat(v => compact.format(v)).tickSizeOuter(0));
  g.append('g').attr('class', 'axis').call(d3.axisLeft(y).ticks(5).tickFormat(v => fmtRate(v)).tickSizeOuter(0));
  g.append('text').attr('class', 'axis-title').attr('x', inner.w).attr('y', inner.h + 34).attr('text-anchor', 'end').text(`Average ${U} per round →`);
  g.append('text').attr('class', 'axis-title').attr('x', -48).attr('y', -6).text(`↑ ${cap(U)} per second`);
  const bub = g.append('g').selectAll('g').data([...pts].sort((a, c) => c.rounds - a.rounds)).join('g')
    .attr('transform', t => `translate(${x(t.avgCoins)},${y(t.coinsPerSec)})`);
  hoverable(bub, t => tsumTip(t, ctx), t => t.tsum && (e => ctx.onPick(t.tsum, e)));
  // A 2px surface ring keeps overlapping bubbles apart.
  bub.append('circle').attr('r', t => Math.max(12, r(t.rounds))).attr('fill', 'transparent');
  bub.append('circle').attr('r', t => r(t.rounds)).attr('fill', t => ctx.colorOf(t.tsum)).attr('stroke', css('--panel')).attr('stroke-width', 2);
  bub.filter(t => r(t.rounds) >= 15).each(function (t) { portrait(d3.select(this), t.tsum, ctx.nameOf(t.tsum), r(t.rounds) - 4); });
  return [];
}

/** One box, three views: 'rate' (ranked), 'box' or 'bubble'. */
export function drawEfficiency(container, view, tsums, ctx, metric) {
  if (view === 'box') return drawBox(container, tsums, ctx);
  if (view === 'bubble') return drawBubble(container, tsums, ctx);
  return drawRate(container, tsums, ctx, metric);
}

// ---- Share of coins: donut and sunburst ----

const SHARE = {
  coins: {name: () => U, tsum: t => t.coins ?? 0, mix: m => m.coins ?? 0, fmt},
  rounds: {name: () => 'rounds', tsum: t => t.rounds, mix: m => m.rounds, fmt},
  time: {name: () => 'hours played', tsum: t => (t.totalSeconds ?? 0) / 3600, mix: m => (m.rateSeconds ?? 0) / 3600, fmt: fmtRate},
};

function drawDonut(container, tsums, ctx, metric) {
  const m = SHARE[metric] || SHARE.coins;
  const f = frame(container, {top: 0, right: 0, bottom: 0, left: 0});
  const {svg, width, height} = f;
  const total = d3.sum(tsums, m.tsum);
  if (!total) return empty(f);
  const top = topKeys(tsums.map(t => t.tsum), id => m.tsum(tsums.find(t => t.tsum === id)), 8, ctx);
  const slices = top.keys.map(k => ({key: k, value: d3.sum(tsums.filter(t => top.keyOf(t.tsum) === k), m.tsum)})).filter(s => s.value > 0);
  const R = Math.min(width, height) / 2 - 6, r0 = R * 0.56;
  const g = svg.append('g').attr('transform', `translate(${width / 2},${height / 2})`);
  const arcs = d3.pie().value(s => s.value).sort(null).padAngle(0.012)(slices);
  const arc = d3.arc().innerRadius(r0).outerRadius(R).cornerRadius(3);
  const tip = a => [[sw(top.color(a.data.key)), b(top.label(a.data.key))], [`${m.fmt(a.data.value)} ${m.name()} · `, b(pct(a.data.value / total))]];
  const pieces = g.selectAll('path').data(arcs).join('path').attr('d', arc).attr('fill', a => top.color(a.data.key));
  hoverable(pieces, tip, a => a.data.key !== OTHER && (e => ctx.onPick(a.data.key, e)));
  const pr = Math.min(20, (R - r0) / 2 - 4);
  for (const a of arcs) {
    if (a.data.key !== OTHER && a.endAngle - a.startAngle > 0.35 && pr >= 9) {
      const [cx, cy] = arc.centroid(a);
      portrait(g, a.data.key, top.label(a.data.key), pr, cx, cy);
    }
  }
  g.append('text').attr('class', 'center-value').attr('text-anchor', 'middle').attr('dy', '0.1em').text(metric === 'time' ? fmtRate(total) : compact.format(total));
  g.append('text').attr('class', 'center-label').attr('text-anchor', 'middle').attr('dy', '1.7em').text(m.name());
  return slices.map(s => ({id: s.key === OTHER ? null : s.key, label: top.label(s.key), color: top.color(s.key), value: pct(s.value / total)}));
}

function drawSunburst(container, mix, ctx, metric) {
  const m = SHARE[metric] || SHARE.coins;
  const f = frame(container, {top: 0, right: 0, bottom: 0, left: 0});
  const {svg, width, height} = f;
  const rows = mix.filter(r => m.mix(r) > 0);
  if (!rows.length) return empty(f);
  const builds = new Set(rows.map(r => r.build));
  const levels = builds.size > 1 ? [r => r.build, r => r.tsum, r => r.items] : [r => r.tsum, r => r.items];
  // Nodes are [key, value] entries; a leaf's value is its rows.
  const root = d3.hierarchy([null, d3.group(rows, ...levels)], ([, v]) => (v instanceof Map ? [...v] : null))
    .sum(([, v]) => (Array.isArray(v) ? d3.sum(v, m.mix) : 0))
    .sort((a, c) => c.value - a.value);
  const R = Math.min(width, height) / 2 - 6;
  // y runs in depth units; depth 0 is the hole in the middle, for the total.
  d3.partition().size([2 * Math.PI, root.height + 1])(root);
  const hole = R * 0.3;
  const ring = y => hole + ((y - 1) / root.height) * (R - hole);
  const arc = d3.arc().startAngle(d => d.x0).endAngle(d => d.x1).padAngle(0.006).padRadius(R / 2)
    .innerRadius(d => ring(d.y0) + 1).outerRadius(d => ring(d.y1) - 1).cornerRadius(2);
  const kind = d => (builds.size > 1 ? ['root', 'build', 'tsum', 'items'] : ['root', 'tsum', 'items'])[d.depth];
  const tsumOf = d => (kind(d) === 'tsum' ? d.data[0] : kind(d) === 'items' ? d.parent.data[0] : null);
  const buildName = bd => ({global: 'INTL', jp: 'JP'}[bd] || 'Game not recorded');
  // Games are not Tsums, so they get muted tones of their own.
  const buildColor = bd => css({global: '--build-intl', jp: '--build-jp'}[bd] || '--build-none');
  const label = d => ({build: buildName(d.data[0]), tsum: ctx.nameOf(d.data[0]) || 'Not identified', items: itemsLabel(d.data[0])}[kind(d)]);
  const g = svg.append('g').attr('transform', `translate(${width / 2},${height / 2})`);
  const nodes = root.descendants().filter(d => d.depth);
  const paths = g.selectAll('path').data(nodes).join('path').attr('d', arc)
    .attr('fill', d => (kind(d) === 'build' ? buildColor(d.data[0]) : ctx.colorOf(tsumOf(d))))
    .attr('fill-opacity', d => (kind(d) === 'items' ? 0.55 : 1));
  hoverable(paths, d => {
    const t = tsumOf(d);
    return [[...(t ? [sw(ctx.colorOf(t))] : []), b(d.ancestors().reverse().slice(1).map(label).join(' › '))],
      [`${m.fmt(d.value)} ${m.name()} · `, b(pct(d.value / root.value))],
      ...(kind(d) === 'items' ? [rateLine(d.data[1])] : [])];
  }, d => tsumOf(d) && (e => ctx.onPick(tsumOf(d), e)));
  // Tsum portraits sit on their ring where the arc is long enough.
  for (const d of nodes) {
    const a = (d.x0 + d.x1) / 2, rr = (ring(d.y0) + ring(d.y1)) / 2;
    const cx = Math.sin(a) * rr, cy = -Math.cos(a) * rr;
    const room = Math.min((ring(d.y1) - ring(d.y0)) / 2 - 3, ((d.x1 - d.x0) * rr) / 2 - 3);
    if (kind(d) === 'tsum' && room >= 9) portrait(g, d.data[0], label(d), Math.min(18, room), cx, cy);
  }
  g.append('text').attr('class', 'center-value').attr('text-anchor', 'middle').attr('dy', '0.1em').text(metric === 'time' ? fmtRate(root.value) : compact.format(root.value));
  g.append('text').attr('class', 'center-label').attr('text-anchor', 'middle').attr('dy', '1.7em').text(m.name());
  const games = builds.size > 1 ? root.children.map(d => ({label: label(d), color: buildColor(d.data[0]), value: pct(d.value / root.value)})) : [];
  const tsumNodes = root.descendants().filter(d => kind(d) === 'tsum');
  const byTsum = d3.rollups(tsumNodes, ds => d3.sum(ds, d => d.value), d => d.data[0]).sort((a, c) => c[1] - a[1]).slice(0, 8);
  return [...games, ...byTsum.map(([id, v]) => ({id, label: ctx.nameOf(id) || 'Not identified', color: ctx.colorOf(id), value: pct(v / root.value)}))];
}

function rateLine(rows) {
  const coins = rows.reduce((s, r) => s + (r.rateCoins ?? 0), 0), secs = rows.reduce((s, r) => s + (r.rateSeconds ?? 0), 0);
  const n = rows.reduce((s, r) => s + r.rounds, 0), withCoins = rows.reduce((s, r) => s + r.coinRounds, 0);
  const avg = withCoins ? rows.reduce((s, r) => s + (r.coins ?? 0), 0) / withCoins : null;
  return [`${fmt(n)} rounds · average ${fmt(avg)} ${U}${secs ? ` · ${fmtRate(coins / secs)}/s` : ''}`];
}

/** 'donut' by Tsum, or 'sunburst' by game, Tsum and items (rows are then the summary's mix). */
export function drawShare(container, view, rows, ctx, metric) {
  return view === 'sunburst' ? drawSunburst(container, rows, ctx, metric) : drawDonut(container, rows, ctx, metric);
}

// ---- Radial: coins by hour of day ----

const HOUR = {
  rate: {get: h => h.coinsPerSec, fmt: fmtRate, name: () => `${U}/s`},
  avg: {get: h => h.avgCoins, fmt, name: () => `avg ${U}`},
  rounds: {get: h => h.rounds, fmt, name: () => 'rounds'},
};

export function drawHours(container, hours, metric) {
  const m = HOUR[metric] || HOUR.rate;
  const f = frame(container, {top: 0, right: 0, bottom: 0, left: 0});
  const {svg, width, height} = f;
  const byHour = new Map(hours.map(h => [h.hour, h]));
  const vals = hours.map(m.get).filter(v => v !== null);
  if (!vals.length) return empty(f);
  const R = Math.min(width, height) / 2 - 22, r0 = R * 0.34;
  const g = svg.append('g').attr('transform', `translate(${width / 2},${height / 2})`);
  const a = d3.scaleBand().domain(d3.range(24)).range([0, 2 * Math.PI]).paddingInner(0.14);
  const y = d3.scaleRadial().domain([0, d3.max(vals)]).range([r0, R]).nice();
  for (const t of y.ticks(3).slice(1)) {
    g.append('circle').attr('r', y(t)).attr('fill', 'none').attr('stroke', css('--grid-line'));
  }
  g.append('g').selectAll('path').data(d3.range(24)).join('path').attr('fill', css('--chart-track'))
    .attr('d', h => d3.arc()({innerRadius: r0, outerRadius: R, startAngle: a(h), endAngle: a(h) + a.bandwidth()}));
  const bars = g.append('g').selectAll('path').data(d3.range(24).filter(h => byHour.has(h) && m.get(byHour.get(h)) !== null)).join('path')
    .attr('fill', css('--coin'))
    .attr('d', h => d3.arc().cornerRadius(3)({innerRadius: r0, outerRadius: Math.max(r0 + 2, y(m.get(byHour.get(h)))), startAngle: a(h), endAngle: a(h) + a.bandwidth()}));
  hoverable(bars, h => {
    const s = byHour.get(h);
    return [[b(`${hourName(h)}–${hourName((h + 1) % 24)}`)], [`${fmt(s.rounds)} rounds`],
      [b(fmtRate(s.coinsPerSec)), ` ${U}/s · average ${fmt(s.avgCoins)} ${U}`]];
  });
  for (const h of [0, 3, 6, 9, 12, 15, 18, 21]) {
    const ang = a(h) + a.bandwidth() / 2;
    g.append('text').attr('class', 'tick-label').attr('text-anchor', 'middle').attr('dy', '0.35em')
      .attr('x', Math.sin(ang) * (R + 12)).attr('y', -Math.cos(ang) * (R + 12)).text(hourName(h));
  }
  const best = hours.filter(h => m.get(h) !== null).sort((p, q) => m.get(q) - m.get(p))[0];
  g.append('text').attr('class', 'center-label').attr('text-anchor', 'middle').attr('dy', '-0.6em').text('Best hour');
  g.append('text').attr('class', 'center-value sm').attr('text-anchor', 'middle').attr('dy', '0.55em').text(hourName(best.hour));
  g.append('text').attr('class', 'center-label').attr('text-anchor', 'middle').attr('dy', '2.6em').text(`${m.fmt(m.get(best))} ${m.name()}`);
  return [];
}

// ---- Radial rings: coins by boost items used ----

const ITEM_METRIC = {
  rate: {get: s => (s.secs ? s.rateCoins / s.secs : null), fmt: v => `${fmtRate(v)}/s`},
  avg: {get: s => (s.coinRounds ? s.coins / s.coinRounds : null), fmt: v => fmt(v)},
  rounds: {get: s => s.rounds, fmt: v => fmt(v)},
};

/** Horizontal bars, one per item set, longest first; the box scrolls when they don't fit. */
export function drawItems(container, mix, metric) {
  const m = ITEM_METRIC[metric] || ITEM_METRIC.rate;
  const groups = [...d3.rollup(mix, rs => ({
    rounds: d3.sum(rs, r => r.rounds), coins: d3.sum(rs, r => r.coins ?? 0), coinRounds: d3.sum(rs, r => r.coinRounds),
    rateCoins: d3.sum(rs, r => r.rateCoins ?? 0), secs: d3.sum(rs, r => r.rateSeconds ?? 0),
  }), r => r.items)].map(([items, s]) => ({items, ...s})).filter(s => m.get(s) !== null)
    .sort((a, c) => m.get(c) - m.get(a));
  const left = Math.min(240, container.clientWidth * 0.45);
  const f = frame(container, {top: 4, right: 64, bottom: 24, left}, groups.length * ROW_H + 28);
  const {g, inner} = f;
  if (!groups.length) return empty(f);
  const h = groups.length * ROW_H;
  const y = d3.scaleBand().domain(groups.map(s => s.items)).range([0, h]).padding(0.2);
  const x = d3.scaleLinear().domain([0, d3.max(groups, m.get)]).nice().range([0, inner.w]);
  g.append('g').attr('class', 'grid').attr('transform', `translate(0,${h})`).call(d3.axisBottom(x).ticks(5).tickSize(-h).tickFormat(''));
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${h})`)
    .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(inner.w / 80))).tickFormat(v => compact.format(v)).tickSizeOuter(0));
  const rows = g.append('g').selectAll('g').data(groups).join('g').attr('transform', s => `translate(0,${y(s.items)})`);
  hoverable(rows, s => [[b(itemsLabel(s.items))], [`${fmt(s.rounds)} rounds`],
    ['Average ', b(fmt(s.coinRounds ? s.coins / s.coinRounds : null)), ` ${U}`],
    [b(fmtRate(s.secs ? s.rateCoins / s.secs : null)), ` ${U}/s`]]);
  rows.append('rect').attr('x', -left).attr('width', inner.w + left + 60).attr('height', y.bandwidth()).attr('fill', 'transparent');
  rows.append('rect').attr('height', y.bandwidth()).attr('width', s => Math.max(2, x(m.get(s))))
    .attr('rx', Math.min(4, y.bandwidth() / 2)).attr('fill', css('--coin'));
  rows.append('text').attr('x', s => x(m.get(s)) + 6).attr('y', y.bandwidth() / 2).attr('dy', '0.35em').attr('class', 'value-label')
    .text(s => m.fmt(m.get(s)));
  const maxChars = Math.max(8, Math.floor((left - 12) / 7));
  rows.append('text').attr('x', -8).attr('y', y.bandwidth() / 2).attr('dy', '0.35em').attr('text-anchor', 'end').attr('class', 'tick-label')
    .text(s => { const n = itemsLabel(s.items); return n.length > maxChars ? n.slice(0, maxChars - 1) + '…' : n; });
  return [];
}

// ---- Coin histogram, stacked by Tsum ----

export function drawHistogram(container, hist, totals, ctx) {
  const f = frame(container, {top: 34, right: 16, bottom: 26, left: 44});
  const {g, inner} = f;
  if (!hist.bins.length) return empty(f);
  const w = hist.width;
  const top = topKeys(hist.bins.map(bn => bn.tsum), id => d3.sum(hist.bins.filter(bn => bn.tsum === id), bn => bn.rounds), 7, ctx);
  const byBin = d3.rollup(hist.bins, bs => {
    const o = {};
    for (const bn of bs) o[top.keyOf(bn.tsum)] = (o[top.keyOf(bn.tsum)] || 0) + bn.rounds;
    return o;
  }, bn => bn.from);
  const pts = [...byBin].map(([from, o]) => ({from, ...Object.fromEntries(top.keys.map(k => [k, o[k] || 0]))})).sort((a, c) => a.from - c.from);
  const series = d3.stack().keys(top.keys)(pts);
  const x = d3.scaleLinear().domain([pts[0].from, pts.at(-1).from + w]).range([0, inner.w]);
  const y = d3.scaleLinear().domain([0, d3.max(series.at(-1), s => s[1])]).nice().range([inner.h, 0]);
  g.append('g').attr('class', 'grid').call(d3.axisLeft(y).ticks(5).tickSize(-inner.w).tickFormat(''));
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${inner.h})`)
    .call(d3.axisBottom(x).tickValues(x.ticks(Math.max(2, Math.floor(inner.w / 70))).filter(v => hist.cap === null || x(hist.cap) - x(v) > 34))
      .tickFormat(v => compact.format(v)).tickSizeOuter(0));
  g.append('g').attr('class', 'axis').call(d3.axisLeft(y).ticks(5).tickFormat(v => compact.format(v)).tickSizeOuter(0));
  const bw = Math.max(1, x(w) - x(0) - 2);
  g.append('g').selectAll('g').data(series).join('g').attr('fill', s => top.color(s.key))
    .selectAll('rect').data(s => s).join('rect')
    .attr('x', s => x(s.data.from) + 1).attr('width', bw)
    .attr('y', s => y(s[1]) + (s[1] > s[0] ? 1 : 0)).attr('height', s => Math.max(0, y(s[0]) - y(s[1]) - 2)).attr('rx', Math.min(3, bw / 4));
  const hit = g.append('g').selectAll('rect').data(pts).join('rect').attr('x', p => x(p.from)).attr('width', Math.max(1, x(w) - x(0)))
    .attr('height', inner.h).attr('fill', 'transparent');
  // The last bucket holds every round at or over the cap.
  const range = p => (hist.cap !== null && p.from >= hist.cap ? `${fmt(hist.cap)} ${U} or more` : `${fmt(p.from)}–${fmt(p.from + w - 1)} ${U}`);
  if (hist.cap !== null) {
    g.append('text').attr('class', 'value-label').attr('x', x(hist.cap) + (x(w) - x(0)) / 2).attr('y', inner.h + 20)
      .attr('text-anchor', 'middle').text(`${compact.format(hist.cap)}+`);
  }
  hoverable(hit, p => [[b(range(p))], [b(fmt(top.keys.reduce((s, k) => s + p[k], 0))), ' rounds'], ...stackLines(top, p)]);
  // Reference lines: median, average and the 90th percentile, labelled once.
  const marks = [['median', totals.medianCoins], ['avg', totals.avgCoins], ['p90', totals.p90Coins]]
    .filter(([, v]) => v !== null && (hist.cap === null || v < hist.cap));
  let lastX = -Infinity, row = 0;
  for (const [name, v] of marks.sort((a, c) => a[1] - c[1])) {
    const px = x(v);
    row = px - lastX < 80 ? row + 1 : 0;
    lastX = px;
    g.append('line').attr('x1', px).attr('x2', px).attr('y1', -18 + row * 12).attr('y2', inner.h).attr('class', 'ref-line').style('pointer-events', 'none');
    g.append('text').attr('class', 'ref-label').attr('x', px + 4).attr('y', -22 + row * 12).attr('text-anchor', 'start').text(`${name} ${compact.format(v)}`);
  }
  return keyLegend(top);
}

// ---- Catalog: how long until every Tsum is maxed, at the player's pace ----

const MAX_DAYS = 3650; // past ten years, a line is cut at the edge
const finishLabel = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric', year: 'numeric'});

/**
 * series: [{label, color, need, left, rate}] -- need is the full cost, left what
 * is still to earn, rate earned per day. Coins and medals differ in scale, so y
 * is the share of each one's cost still to earn.
 */
export function drawMaxOut(container, series) {
  const f = frame(container, {top: 22, right: 20, bottom: 26, left: 44});
  const {g, inner} = f;
  const live = series.filter(s => s.need > 0 && s.left > 0 && s.rate > 0)
    .map(s => ({...s, days: s.left / s.rate}));
  if (!live.length) return empty(f, 'Nothing left to earn, or no rounds to set a pace');
  const today = new Date();
  const span = Math.min(MAX_DAYS, Math.ceil(d3.max(live, s => s.days)) + 1);
  const x = d3.scaleTime().domain([today, d3.timeDay.offset(today, span)]).range([0, inner.w]);
  const y = d3.scaleLinear().domain([0, 1]).range([inner.h, 0]);
  // Evenly spaced date ticks: d3's own restart at each month and collide there.
  const n = Math.max(2, Math.min(span, Math.floor(inner.w / 90)));
  const ticks = d3.range(n + 1).map(i => d3.timeDay.offset(today, Math.round((span * i) / n)));
  g.append('g').attr('class', 'grid').call(d3.axisLeft(y).ticks(5).tickSize(-inner.w).tickFormat(''));
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${inner.h})`)
    .call(d3.axisBottom(x).tickValues(ticks).tickFormat(d3.timeFormat(span > 300 ? '%b %Y' : '%b %-d')).tickSizeOuter(0));
  g.append('g').attr('class', 'axis').call(d3.axisLeft(y).ticks(5).tickFormat(v => `${Math.round(v * 100)}%`).tickSizeOuter(0));
  const share = (s, d) => Math.max(0, s.left - s.rate * d) / s.need;
  for (const s of live) {
    const end = Math.min(s.days, span);
    g.append('path').attr('fill', 'none').attr('stroke', s.color).attr('stroke-width', 2)
      .attr('d', d3.line()([[x(today), y(share(s, 0))], [x(d3.timeHour.offset(today, end * 24)), y(share(s, end))]]));
  }
  // Each finish date marked on the baseline and labelled above it; a label that
  // would sit on the one before it goes a row higher.
  let lastX = -Infinity, row = 0;
  for (const s of [...live].sort((a, c) => a.days - c.days)) {
    if (s.days > span) continue;
    const px = x(d3.timeHour.offset(today, s.days * 24));
    row = px - lastX < 120 ? row + 1 : 0;
    lastX = px;
    g.append('circle').attr('cx', px).attr('cy', y(0)).attr('r', 4).attr('fill', css('--bg')).attr('stroke', s.color).attr('stroke-width', 2);
    g.append('text').attr('class', 'value-label').attr('x', Math.min(px, inner.w)).attr('y', y(0) - 10 - row * 16)
      .attr('text-anchor', px > inner.w - 60 ? 'end' : 'middle').text(`${s.label} ${finishLabel.format(d3.timeHour.offset(today, s.days * 24))}`);
  }
  const pts = d3.range(span + 1).map(d => ({d, date: d3.timeDay.offset(today, d)}));
  dayHover(f, x, pts, (p, e) => showTip([[b(dayLabel.format(p.date))], ...live.map(s => [sw(s.color), `${s.label} still to earn `,
    b(fmt(Math.max(0, s.left - s.rate * p.d))), dim(` (${pct(share(s, p.d))})`)])], e));
  return live.map(s => ({label: s.label, color: s.color,
    value: s.days > MAX_DAYS ? 'over 10 years' : finishLabel.format(d3.timeHour.offset(today, s.days * 24))}));
}
