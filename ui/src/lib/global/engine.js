// The global site's query engine: the server's /api/stats answers
// (internal/stats/summary.go, queries.go, tsum.go) computed in the browser
// from the published part files (global/CONTRACT.md §4 and §6). It follows the
// snapshot engine (../snapshot/engine.js) with cells in place of rounds: a cell
// is the sums of one day × build × Tsum × skill level × items × (medals > 0),
// so every figure but the quartiles and P90 adds up exactly. From part format
// 3 a cell is of one skill type too (format 2's are all skill type "", as
// the rounds before it kept none), and from format 4 of one value of each
// play setting (before it, all not recorded), and from format 5 either all
// coin-bonus jackpots or none (before it, all counted as none). Each cell has
// bins (CONTRACT §5): its rounds counted by 2 % wide bins of their base coins,
// final coins and medals, with each bin's figures. The quartiles, P90 and
// histogram come from them, approximately, and so do the outlier ranges: a
// range keeps the bins whose rounds' average is inside it.
//
// It has no browser APIs, so it runs in a Web Worker, under Node and inside
// workerd. A `loader` supplies the files: {json(name, {fresh}) -> Promise<object>},
// where fresh asks past any cache, and a missing file rejects with an error
// whose `status` is 404.

import {PLAY_SETTINGS, bucketOf, histBounds, itemCost, parseFilter, parseTime, sqlTime} from '../snapshot/engine.js';

const DAY = 86400;

// The built-in themes, in site.go: themeOrder order.
const THEMES = [
  {file: 'halloween.css', name: 'Halloween'}, {file: 'midnight-felt.css', name: 'Midnight Felt'},
  {file: 'daylight-felt.css', name: 'Daylight Felt'}, {file: 'ember.css', name: 'Ember'},
];

/** "YYYY-MM-DD" → its 00:00 UTC in seconds since 1970. */
const dayStart = day => parseTime(`${day} 00:00:00`);

// ---- Bins (CONTRACT §5) ----

/** The value bin b stands for: itself under 100, else the middle of its 2 % span. */
export const binMid = b => (b < 100 ? b : Math.round(100 * 1.02 ** (b - 99.5)));

// A bin as the engine keeps it: [bin, rounds, secs, score, base, final, medals].
const B = {bin: 0, n: 1, secs: 2, score: 3, base: 4, final: 5, medals: 6};
/** Which of a bin's figures its own value is, per kind of bins. */
const OWN = {base: B.base, final: B.final, medals: B.medals};
const KINDS = ['base', 'final', 'medals'];

// ---- Reading the files ----

/** One stat's columns, a value per cell: rounds with it, its sum, sum of squares, lowest, highest and their seconds. */
const statCols = (n, sum, sq, min, max, secs) => ({n, sum, sq, min, max, secs});

/**
 * Coins less the items' cost (queries.go: Filter.Net), a cell at a time. Every
 * round in a cell used the same items, so its figures all move by the one
 * cost; a cell whose items are unknown has no net coins. A null sq (not
 * known, under a range) stays null.
 */
function netCols(s, items) {
  const out = statCols([], [], [], [], [], s.secs);
  items.forEach((mask, i) => {
    const cost = itemCost(mask);
    const n = cost === null ? 0 : s.n[i];
    out.n.push(n);
    out.sum.push(n ? s.sum[i] - n * cost : 0);
    out.sq.push(!n ? 0 : s.sq[i] === null ? null : s.sq[i] - 2 * cost * s.sum[i] + n * cost * cost);
    out.min.push(n ? s.min[i] - cost : null);
    out.max.push(n ? s.max[i] - cost : null);
  });
  return out;
}

/** A bins object {"<bin>": figures} as bins in bin order. */
const binList = o => Object.entries(o).map(([b, f]) => [Number(b), ...f]).sort((x, y) => x[0] - y[0]);

/** Key columns a part before format 3 (skillType), 4 (the play settings) or 5 (jackpot) lacks, as its cells read: not recorded, no jackpot. */
const LATER = {skillType: '', scan: -1, chain: -1, bubble: '', jackpot: 0};
/** The key columns, in the tables' order: how a cell's bins find it. */
const KEY = ['day', 'build', 'tsum', 'skill', 'skillType', 'items', 'scan', 'chain', 'bubble', 'medal', 'jackpot'];

/**
 * A part's files as one: their cells and bins rows added together (a part too
 * long for one file is several, each a share of both), each cell with its
 * bins. Part format 1 had bins per skill level only: its cells have none.
 * A column a part's format lacks is LATER's for each of its cells.
 */
function decodePart(files) {
  const cat = (key, col) => files.flatMap(p => p[key][col] ?? (col in LATER ? new Array(p[key].n).fill(LATER[col]) : []));
  const cols = [...new Set([...Object.keys(files[0].cells).filter(k => k !== 'n'), ...Object.keys(LATER)])];
  const c = Object.fromEntries(cols.map(k => [k, cat('cells', k)]));
  c.n = c.day.length;
  // Each cell's bins by kind, or null where the part has none for it.
  const bins = Object.fromEntries(KINDS.map(k => [k, new Array(c.n).fill(null)]));
  if (files.every(p => p.format >= 2)) {
    const key = (o, i) => KEY.map(k => o[k][i]).join('\u0000');
    const at = new Map();
    for (let i = 0; i < c.n; i++) at.set(key(c, i), i);
    const b = Object.fromEntries([...KEY, ...KINDS].map(k => [k, cat('bins', k)]));
    for (let j = 0; j < b.day.length; j++) {
      const i = at.get(key(b, j));
      if (i !== undefined) for (const k of KINDS) bins[k][i] = binList(b[k][j]);
    }
    // A cell of rounds that earned no medals has no medal bins (CONTRACT §5),
    // but every one of its rounds read is a 0: its one bin is the cell's own.
    for (let i = 0; i < c.n; i++) {
      if (c.medal[i] || !c.medalsN[i] || bins.medals[i] === null || bins.medals[i].length) continue;
      const all = c.medalsN[i] === c.rounds[i];
      bins.medals[i] = all ? [[0, c.rounds[i], c.secs[i], c.scoreSum[i], c.baseSum[i], c.finalSum[i], 0]] : null;
    }
  }
  return cellsOf(c, bins);
}

/** Decoded cells from raw columns c (the part's names) and their bins: days as times, builds by name, the stats' columns. */
function cellsOf(c, bins) {
  const base = statCols(c.rounds, c.baseSum, c.baseSq, c.baseMin, c.baseMax, c.secs);
  const final = statCols(c.rounds, c.finalSum, c.finalSq, c.finalMin, c.finalMax, c.secs);
  return {...c, at: c.at ?? c.day.map(dayStart), build: c.build.map(b => (b === 1 || b === 'jp' ? 'jp' : 'global')), bins,
    stat: {base, final, netBase: netCols(base, c.items), netFinal: netCols(final, c.items),
      medals: statCols(c.medalsN, c.medalsSum, c.medalsSq, c.medalsMin, c.medalsMax, c.medalsSecs)}};
}

// ---- The filter (CONTRACT §6.2) ----

/** A cell's play setting as the filter and the options name it: its value as text, '' for not recorded (-1 or ''). */
const playText = v => (v === -1 || v === '' ? '' : String(v));

/** A comma list of integers; anything else in it is left out. */
const intList = s => String(s ?? '').split(',').map(v => v.trim()).filter(v => /^-?\d+$/.test(v)).map(Number);

/**
 * The query parameters as the global site reads them: queries.go's (skill
 * types among them), plus skill and items lists. Devices, the score range, incomplete and tz are read but
 * not used: there are no score bins, every round here is complete, and days
 * are UTC.
 */
export function parseGlobalFilter(q) {
  const f = parseFilter(q);
  f.skills = intList(q.skill);
  f.items = intList(q.items);
  // A cell counts when its day starts at or after from's day, and before to.
  f.fromDay = f.from === null ? null : Math.floor(f.from / DAY) * DAY;
  // One outlier range at a time: the coins' (base or final, net when asked), else the medals'.
  const coins = f.minCoins !== null || f.maxCoins !== null;
  const medals = f.minMedals !== null || f.maxMedals !== null;
  f.range = coins ? {kind: f.finalCoins ? 'final' : 'base', net: f.net, lo: f.minCoins, hi: f.maxCoins}
    : medals ? {kind: 'medals', net: false, lo: f.minMedals, hi: f.maxMedals} : null;
  f.ignored = coins && medals ? ['medals'] : [];
  return f;
}

/** The primary stat's columns: base or final coins, net when asked, or medals. */
const statKey = f => (f.medals ? 'medals' : f.net ? (f.finalCoins ? 'netFinal' : 'netBase') : f.finalCoins ? 'final' : 'base');
/** The bins behind a stat. */
const kindOf = {base: 'base', netBase: 'base', final: 'final', netFinal: 'final', medals: 'medals'};
/** v is within [lo, hi]; a null bound is open (snapshot engine: within). */
const within = (v, lo, hi) => (lo === null || v >= lo) && (hi === null || v <= hi);

// ---- Outlier ranges (CONTRACT §6.2) ----

/** The columns a derived set of cells is built in, empty. */
const RAW = ['day', 'at', 'build', 'tsum', 'skill', 'skillType', 'items', 'scan', 'chain', 'bubble', 'medal', 'jackpot', 'rounds', 'secs', 'scoreSum', 'scoreMin', 'scoreMax', 'first', 'last',
  'baseSum', 'baseSq', 'baseMin', 'baseMax', 'finalSum', 'finalSq', 'finalMin', 'finalMax',
  'medalsN', 'medalsSum', 'medalsSq', 'medalsMin', 'medalsMax', 'medalsSecs'];

/**
 * The part of cell i of c that a range r keeps, as raw columns pushed onto
 * out (with its bins onto outBins); nothing when it keeps none. Whole when
 * every bin is kept. Otherwise its sums are the kept bins' (exact); the
 * range's own stat's lowest, highest and sum of squares come from the kept
 * bins (approximate); the other stats' sums of squares are unknown (null),
 * and their lowest and highest, the score's and the times stay the cell's.
 */
function cutCell(c, i, r, medalTsums, out, outBins) {
  const push = (row, bins) => {
    for (const k of RAW) out[k].push(row[k]);
    for (const k of KINDS) outBins[k].push(bins[k]);
  };
  const whole = () => push(Object.fromEntries(RAW.map(k => [k, c[k][i]])), Object.fromEntries(KINDS.map(k => [k, c.bins[k][i]])));
  if (r.kind === 'medals') {
    // The medal range judges the Tsums that earn medals only; a cell with none earned holds 0s.
    if (!medalTsums.has(c.tsum[i])) return whole();
    if (!c.medal[i]) return within(0, r.lo, r.hi) ? whole() : undefined;
  }
  const cost = r.net ? itemCost(c.items[i]) : 0;
  if (cost === null) return; // no net coins, so outside any range
  const bins = c.bins[r.kind][i];
  if (bins === null) return whole(); // an old part has no bins to cut by
  const own = OWN[r.kind];
  const kept = bins.filter(b => within(b[own] / b[B.n] - cost, r.lo, r.hi));
  if (kept.length === bins.length) return whole();
  if (!kept.length) return;
  const sum = k => kept.reduce((s, b) => s + b[k], 0);
  const n = sum(B.n);
  const row = Object.fromEntries(RAW.map(k => [k, c[k][i]]));
  Object.assign(row, {rounds: n, secs: sum(B.secs), scoreSum: sum(B.score), baseSum: sum(B.base), finalSum: sum(B.final),
    baseSq: null, finalSq: null, medalsSq: null});
  if (c.medal[i]) Object.assign(row, {medalsN: n, medalsSum: sum(B.medals), medalsSecs: row.secs});
  else if (c.medalsN[i] === c.rounds[i]) Object.assign(row, {medalsN: n, medalsSum: 0, medalsSecs: row.secs});
  // A cell whose medals were read for some rounds only: its share of them, about.
  else Object.assign(row, {medalsN: Math.round((c.medalsN[i] * n) / c.rounds[i]), medalsSum: 0, medalsSecs: (c.medalsSecs[i] * n) / c.rounds[i]});
  // The range's own stat: its lowest and highest the kept bins' (the cell's own where its end bin is kept), its spread theirs.
  const pre = {base: 'base', final: 'final', medals: 'medals'}[r.kind];
  const mean = b => b[own] / b[B.n];
  row[pre + 'Min'] = kept[0] === bins[0] ? c[pre + 'Min'][i] : mean(kept[0]);
  row[pre + 'Max'] = kept.at(-1) === bins.at(-1) ? c[pre + 'Max'][i] : mean(kept.at(-1));
  row[pre + 'Sq'] = kept.reduce((s, b) => s + b[B.n] * mean(b) ** 2, 0);
  push(row, Object.fromEntries(KINDS.map(k => [k, k === r.kind ? kept : null])));
}

// ---- The engine ----

export function createGlobalEngine(loader) {
  let manifest; // Promise<manifest>
  const parts = new Map(); // the files of one part, joined by ',' → Promise<decoded part>

  // A failed read is forgotten, so the next call tries again.
  const getManifest = (fresh = false) => (manifest ??= loader.json('manifest.json', {fresh}).catch(e => { manifest = null; throw e; }));
  const getPart = files => {
    const key = files.join(',');
    if (!parts.has(key)) parts.set(key, Promise.all(files.map(f => loader.json(f))).then(decodePart).catch(e => { parts.delete(key); throw e; }));
    return parts.get(key);
  };

  /** The parts a filter's days can touch, each read as one from all its files: each holds [from, to) days. */
  function partsOf(man, f) {
    const need = man.parts.filter(p => (f.to === null || dayStart(p.from) < f.to) && (f.fromDay === null || dayStart(p.to) > f.fromDay));
    const byRange = new Map();
    for (const p of need) {
      const k = `${p.from}|${p.to}`;
      if (!byRange.has(k)) byRange.set(k, []);
      byRange.get(k).push(p.file);
    }
    return Promise.all([...byRange.values()].map(getPart));
  }

  /** partsOf, read again from a new manifest once when a part has gone (replaced since the manifest was read). */
  async function partsFor(f) {
    const read = getManifest();
    try {
      return await partsOf(await read, f);
    } catch (e) {
      if (e?.status !== 404) throw e;
      // Another call may have read it again already.
      if (manifest === read) manifest = null;
      const man = await getManifest(true);
      const live = new Set(man.parts.map(p => p.file));
      for (const key of parts.keys()) if (!key.split(',').every(file => live.has(file))) parts.delete(key);
      return partsOf(man, f);
    }
  }

  /**
   * Whether cell i is in the filter's days, build, Tsums, skill levels, skill types, play settings and item sets,
   * and is not of coin-bonus jackpots when the filter leaves them out (the Tsum page's, tsum.go: DescribeTsum).
   */
  function keeps(f, c, i, sets) {
    if (f.noJackpots && c.jackpot[i]) return false;
    const at = c.at[i];
    if (f.fromDay !== null && at < f.fromDay) return false;
    if (f.to !== null && at >= f.to) return false;
    if (f.build && c.build[i] !== f.build) return false;
    if (sets.tsum && !sets.tsum.has(c.tsum[i])) return false;
    if (sets.skill && !sets.skill.has(c.skill[i])) return false;
    if (sets.skillType && !sets.skillType.has(c.skillType[i])) return false;
    for (const [param, set] of sets.play) if (!set.has(playText(c[param][i]))) return false;
    return !sets.items || sets.items.has(c.items[i]);
  }

  /**
   * The cells a filter keeps, as {p, idx}: a part's cells and the cell numbers
   * in it. Under an outlier range, each part's kept cells are cut by it into
   * cells of their own. onlyMedals keeps medal Tsums' rounds with medals
   * read, 0s included (queries.go: medalRoundsSQL), as medals mode does.
   */
  async function select(f, {onlyMedals = false} = {}) {
    const sets = {
      tsum: f.tsums.length ? new Set(f.tsums) : null,
      skill: f.skills.length ? new Set(f.skills) : null,
      skillType: f.skillTypes.length ? new Set(f.skillTypes) : null,
      items: f.items.length ? new Set(f.items) : null,
      play: PLAY_SETTINGS.filter(ps => f.play[ps.param].length).map(ps => [ps.param, new Set(f.play[ps.param])]),
    };
    const medalTsums = new Set((await getManifest()).medalTsums ?? []);
    const out = [];
    for (const c of await partsFor(f)) {
      const idx = [];
      for (let i = 0; i < c.n; i++) {
        if (!keeps(f, c, i, sets)) continue;
        if ((f.medals || onlyMedals) && !(c.medalsN[i] && medalTsums.has(c.tsum[i]))) continue;
        idx.push(i);
      }
      if (!idx.length) continue;
      if (!f.range) {
        out.push({p: c, idx});
        continue;
      }
      const raw = Object.fromEntries(RAW.map(k => [k, []]));
      const bins = Object.fromEntries(KINDS.map(k => [k, []]));
      for (const i of idx) cutCell(c, i, f.range, medalTsums, raw, bins);
      raw.n = raw.day.length;
      if (raw.n) out.push({p: cellsOf(raw, bins), idx: Array.from({length: raw.n}, (_, i) => i)});
    }
    return out;
  }

  const each = (sel, fn) => { for (const {p, idx} of sel) for (const i of idx) fn(p, i); };

  // ---- Aggregates: the snapshot engine's, a cell at a time. Every round here
  // is complete, so a score, coins and a time are counted for each. ----

  /** Running figures of one group, for one stat's columns. */
  const acc = () => ({
    rounds: 0, n: 0, sum: 0, sumSq: 0, sqKnown: true, min: null, max: null,
    scoreSum: 0, scoreMin: null, scoreMax: null, baseSum: 0, finalSum: 0, secs: 0,
    rateCoins: 0, rateSecs: 0, rateN: 0, medalsN: 0, medalsSum: 0, earned: 0, first: null, last: null,
  });

  function add(a, c, i, s) {
    a.rounds += c.rounds[i];
    const n = s.n[i];
    if (n) {
      a.n += n; a.sum += s.sum[i];
      if (s.sq[i] === null) a.sqKnown = false;
      else a.sumSq += s.sq[i];
      if (a.min === null || s.min[i] < a.min) a.min = s.min[i];
      if (a.max === null || s.max[i] > a.max) a.max = s.max[i];
      // Rate: the stat over the seconds of the rounds that have it (every round has a time).
      a.rateN += n; a.rateCoins += s.sum[i]; a.rateSecs += s.secs[i];
    }
    a.scoreSum += c.scoreSum[i];
    if (a.scoreMin === null || c.scoreMin[i] < a.scoreMin) a.scoreMin = c.scoreMin[i];
    if (a.scoreMax === null || c.scoreMax[i] > a.scoreMax) a.scoreMax = c.scoreMax[i];
    a.baseSum += c.baseSum[i]; a.finalSum += c.finalSum[i]; a.secs += c.secs[i];
    a.medalsN += c.medalsN[i]; a.medalsSum += c.medalsSum[i];
    if (c.medal[i]) a.earned += c.rounds[i];
    if (a.first === null || c.first[i] < a.first) a.first = c.first[i];
    if (a.last === null || c.last[i] > a.last) a.last = c.last[i];
  }

  const avg = (sum, n) => (n ? sum / n : null);
  const rate = a => (a.rateN ? a.rateCoins / a.rateSecs : null);
  /** Population variance of the stat, as the server computes it; unknown when a cut cell's is. */
  const variance = a => (a.n && a.sqKnown ? a.sumSq / a.n - (a.sum / a.n) ** 2 : null);
  const std = v => (v === null ? null : Math.sqrt(Math.max(0, v)));
  const noSpread = () => ({q1Coins: null, medianCoins: null, q3Coins: null, p90Coins: null});

  const totalsOf = a => ({
    rounds: a.rounds, avgScore: avg(a.scoreSum, a.rounds), maxScore: a.scoreMax,
    avgCoins: avg(a.sum, a.n), minCoins: a.min, maxCoins: a.max,
    avgBaseCoins: avg(a.baseSum, a.rounds), avgFinalCoins: avg(a.finalSum, a.rounds),
    coinRounds: a.n, totalCoins: a.n ? a.sum : null,
    totalSeconds: a.rounds ? a.secs : null, avgSeconds: avg(a.secs, a.rounds),
    coinsPerSec: rate(a), totalMedals: a.medalsN ? a.medalsSum : null, earnedRounds: a.earned,
    first: a.first === null ? null : sqlTime(a.first), last: a.last === null ? null : sqlTime(a.last),
  });

  const tsumOf = (tsum, a) => ({
    tsum, rounds: a.rounds, avgScore: avg(a.scoreSum, a.rounds), maxScore: a.scoreMax,
    avgCoins: avg(a.sum, a.n), minCoins: a.min, maxCoins: a.max,
    avgBaseCoins: avg(a.baseSum, a.rounds), avgFinalCoins: avg(a.finalSum, a.rounds),
    coins: a.n ? a.sum : null, totalSeconds: a.rounds ? a.secs : null, avgSeconds: avg(a.secs, a.rounds),
    coinsPerSec: rate(a), earnedRounds: a.earned,
  });

  /**
   * Each group's rounds of stat k by value, from the bins: a bin's rounds with
   * the same items' cost (net coins) stand at their average, less the cost.
   * Groups as [value, rounds] lowest first, with their rounds; null when a
   * cell has no bins (an old part).
   */
  function binGroups(sel, k, groupOf) {
    const kind = kindOf[k], own = OWN[kind], net = k === 'netBase' || k === 'netFinal';
    const groups = new Map();
    let missing = false;
    each(sel, (c, i) => {
      if (!c.stat[k].n[i]) return;
      const bins = c.bins[kind][i];
      if (bins === null) { missing = true; return; }
      const cost = net ? itemCost(c.items[i]) : 0;
      const g = groupOf(c, i);
      if (!groups.has(g)) groups.set(g, new Map());
      const sums = groups.get(g);
      for (const b of bins) {
        const key = b[B.bin] * 1e6 + cost; // a cost is under 1e6
        const s = sums.get(key);
        if (s) { s.n += b[B.n]; s.sum += b[own]; } else sums.set(key, {n: b[B.n], sum: b[own], cost});
      }
    });
    if (missing) return null;
    return new Map([...groups].map(([g, sums]) => {
      const pairs = [...sums.values()].map(s => [s.sum / s.n - s.cost, s.n]).sort((x, y) => x[0] - y[0]);
      return [g, {pairs, n: pairs.reduce((sum, [, n]) => sum + n, 0)}];
    }));
  }

  /**
   * Quartiles and the 90th percentile per group, from its bins (CONTRACT §6.2):
   * the lower nearest rank (summary.go: coinSpreads) falls in a bin, and that
   * bin's average, kept within the group's lowest and highest, stands for it.
   */
  function binSpreads(groups, accOf) {
    const out = new Map();
    for (const [g, {pairs, n}] of groups) {
      const a = accOf(g);
      if (!n || !a?.n) continue;
      const at = (num, den) => {
        const rank = Math.floor(((n - 1) * num) / den); // 0-based
        let seen = 0;
        for (const [v, k] of pairs) {
          seen += k;
          if (seen > rank) return Math.min(a.max, Math.max(a.min, v));
        }
        return a.max;
      };
      out.set(g, {q1Coins: at(1, 4), medianCoins: at(1, 2), q3Coins: at(3, 4), p90Coins: at(9, 10)});
    }
    return out;
  }

  /**
   * The KPI totals and per-Tsum figures of stat key k, with spreads when asked
   * and the bins have them (summary.go: statSet). spreads says whether they did.
   */
  function statSet(sel, k, wantSpreads) {
    const total = acc();
    const byTsum = new Map();
    each(sel, (c, i) => {
      const s = c.stat[k];
      add(total, c, i, s);
      if (!byTsum.has(c.tsum[i])) byTsum.set(c.tsum[i], acc());
      add(byTsum.get(c.tsum[i]), c, i, s);
    });
    const perGroups = wantSpreads ? binGroups(sel, k, c => '') : null;
    const spreads = perGroups !== null;
    const perTsum = spreads ? binSpreads(binGroups(sel, k, (c, i) => c.tsum[i]), t => byTsum.get(t)) : new Map();
    const all = spreads ? binSpreads(perGroups, () => total) : new Map();

    const totals = totalsOf(total);
    totals.stdCoins = std(variance(total));
    Object.assign(totals, all.get('') ?? noSpread());

    const tsums = [...byTsum].map(([t, a]) => {
      const row = tsumOf(t, a);
      row.stdCoins = std(variance(a));
      return Object.assign(row, perTsum.get(t) ?? noSpread());
    }).sort((a, b) => b.rounds - a.rounds);
    return {totals, tsums, byTsum, spreads};
  }

  /** The value each bin stands for, kept within its Tsum's lowest and highest, bucketed on bounds: [bucket, tsum, rounds, cell]. */
  function bucketed(sel, k, set, bounds) {
    const out = [];
    const groups = binGroups(sel, k, (c, i) => c.tsum[i]);
    for (const [tsum, {pairs}] of groups ?? []) {
      const a = set.byTsum.get(tsum);
      if (!a?.n) continue;
      for (const [v, rounds] of pairs) out.push([bucketOf(Math.min(a.max, Math.max(a.min, v)), bounds), tsum, rounds]);
    }
    return out;
  }

  /**
   * The histogram (summary.go: coinHistogram) from the bins: each bin's rounds
   * go in the bucket holding the bin's average, kept within its Tsum's lowest
   * and highest.
   */
  function histogram(sel, k, set) {
    const h = {width: 0, cap: null, bins: []};
    const bounds = histBounds(set.totals);
    if (!bounds) return h;
    h.width = bounds.width;
    if (set.totals.maxCoins >= bounds.limit) h.cap = bounds.limit;
    const buckets = new Map();
    for (const [from, tsum, rounds] of bucketed(sel, k, set, bounds)) {
      const key = from + '\u0000' + tsum;
      const bucket = buckets.get(key);
      if (bucket) bucket.rounds += rounds;
      else buckets.set(key, {from, tsum, rounds});
    }
    h.bins = [...buckets.values()].sort((a, b) => a.from - b.from);
    return h;
  }

  // ---- The routes ----

  /**
   * /api/stats/summary (summary.go: Summarize) over UTC days, with the spreads
   * approximate. Under an outlier range, only the range's own stat has them:
   * the bins of one figure cannot be cut by another's range.
   */
  async function summary(q, {noJackpots = false} = {}) {
    const f = {...parseGlobalFilter(q), noJackpots};
    const k = statKey(f);
    const sel = await select(f);
    const fits = kind => !f.range || f.range.kind === kind;

    const main = statSet(sel, k, fits(kindOf[k]));
    // With medals as the primary stat the two sets are the same cells and stat.
    const medals = f.medals ? main : statSet(await select(f, {onlyMedals: true}), 'medals', fits('medals'));

    const daily = new Map(), dailyTsums = new Map(), mix = new Map(), chains = new Map();
    each(sel, (c, i) => {
      const s = c.stat[k];
      const day = c.day[i], tsum = c.tsum[i];
      for (const [map, key] of [[daily, day], [dailyTsums, day + '\u0000' + tsum]]) {
        if (!map.has(key)) map.set(key, {a: acc(), day, tsum});
        add(map.get(key).a, c, i, s);
      }
      const build = c.build[i], items = c.items[i];
      const mk = `${build}\u0000${tsum}\u0000${items}`;
      if (!mix.has(mk)) mix.set(mk, {build, tsum, items, a: acc()});
      add(mix.get(mk).a, c, i, s);
      const scan = playText(c.scan[i]), chain = playText(c.chain[i]);
      const ck = `${build}\u0000${tsum}\u0000${scan}\u0000${chain}`;
      if (!chains.has(ck)) chains.set(ck, {build, tsum, scan, chain, a: acc()});
      add(chains.get(ck).a, c, i, s);
    });

    const byKey = (a, b, key) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
    const plain = ({totals, tsums}) => ({totals, tsums});
    return {
      totals: main.totals,
      daily: [...daily.values()].sort((a, b) => byKey(a, b, 'day')).map(({a, day}) => ({
        day, rounds: a.rounds, avgScore: avg(a.scoreSum, a.rounds), minScore: a.scoreMin, maxScore: a.scoreMax,
        coins: a.n ? a.sum : null, avgCoins: avg(a.sum, a.n), minCoins: a.min, maxCoins: a.max, coinsPerSec: rate(a),
      })),
      tsums: main.tsums,
      dailyTsums: [...dailyTsums.values()].sort((a, b) => byKey(a, b, 'day')).map(({a, day, tsum}) => ({
        day, tsum, rounds: a.rounds, coins: a.n ? a.sum : null, avgCoins: avg(a.sum, a.n), coinsPerSec: rate(a),
      })),
      mix: [...mix.values()].sort((a, b) => b.a.rounds - a.a.rounds).map(({a, build, tsum, items}) => ({
        build, tsum, items, rounds: a.rounds, coins: a.n ? a.sum : null, coinRounds: a.n,
        rateCoins: a.rateN ? a.rateCoins : null, rateSeconds: a.rateN ? a.rateSecs : null,
      })),
      chains: [...chains.values()].sort((a, b) => b.a.rounds - a.a.rounds).map(({a, build, tsum, scan, chain}) => ({
        build, tsum, scan, chain, rounds: a.rounds, coins: a.n ? a.sum : null, coinRounds: a.n,
        rateCoins: a.rateN ? a.rateCoins : null, rateSeconds: a.rateN ? a.rateSecs : null,
      })),
      histogram: main.spreads ? histogram(sel, k, main) : {width: 0, cap: null, bins: []},
      // The cells keep no coin-bonus multipliers, only whether a round was a jackpot.
      bonus: {tsums: [], daily: [], all: []},
      medals: plain(medals),
      // spreads: whether the primary stat's quartiles, P90 and histogram are there.
      // range: the outlier range applied ('base', 'final' or 'medals'), and ignored: those that were not.
      global: {approx: true, spreads: main.spreads, range: f.range?.kind ?? null, ignored: f.ignored},
    };
  }

  /**
   * /api/stats/tsum (tsum.go: DescribeTsum) as the global site can answer it:
   * no rounds, so no recent form, versions or devices, and of the settings
   * only those the cells are kept by: the skill level and the play settings. Its skill levels'
   * histogram and the rounds under a target come from the bins.
   */
  async function tsum(q) {
    const id = String(q.id ?? '').trim();
    if (!id) throw new Error('tsum: id is required');
    // In final coins the coin-bonus jackpots are left out, the rank's other Tsums' too (tsum.go: DescribeTsum).
    const parsed = parseGlobalFilter({...q, tsum: id});
    const noJackpots = parsed.finalCoins && !parsed.medals;
    const f = {...parsed, noJackpots};
    const k = statKey(f);
    const summed = await summary({...q, tsum: id}, {noJackpots});
    const sel = await select(f);

    // The jackpots left out, and where they still count: the highest coins and the items (tsum.go: withJackpots).
    let jackpots = null;
    if (noJackpots) {
      jackpots = {rounds: 0, coins: null};
      each(await select({...f, noJackpots: false}), (c, i) => {
        if (!c.jackpot[i]) return;
        const s = c.stat[k];
        jackpots.rounds += c.rounds[i];
        if (s.n[i]) jackpots.coins = (jackpots.coins ?? 0) + s.sum[i];
      });
    }
    // Put back last: the skill levels' buckets below go by the bounds of the cells kept.
    const whole = jackpots?.rounds ? await summary({...q, tsum: id}) : null;

    const group = (a, key) => ({
      key, rounds: a.rounds, avgCoins: avg(a.sum, a.n), maxCoins: a.max, coinsPerSec: rate(a),
      avgScore: avg(a.scoreSum, a.rounds), first: sqlTime(a.first), last: sqlTime(a.last),
    });
    const bySkill = new Map(), byType = new Map();
    // The play settings, by value, not recorded left out (as the skill level's -1 is).
    const byPlay = new Map();
    // Chains per scan and max chain length together, not recorded kept.
    const byChains = new Map();
    each(sel, (c, i) => {
      const scan = playText(c.scan[i]), chain = playText(c.chain[i]);
      const ck = `${scan},${chain}`;
      if (!byChains.has(ck)) byChains.set(ck, {scan, chain, a: acc()});
      add(byChains.get(ck).a, c, i, c.stat[k]);
      for (const ps of PLAY_SETTINGS) {
        const v = playText(c[ps.param][i]);
        if (v === '') continue;
        const key = `${ps.key}\u0000${v}`;
        if (!byPlay.has(key)) byPlay.set(key, {setting: ps.key, key: v, a: acc()});
        add(byPlay.get(key).a, c, i, c.stat[k]);
      }
      const t = c.skillType[i];
      if (!byType.has(t)) byType.set(t, acc());
      add(byType.get(t), c, i, c.stat[k]);
      const s = c.skill[i];
      if (s < 0) return;
      if (!bySkill.has(s)) bySkill.set(s, acc());
      add(bySkill.get(s), c, i, c.stat[k]);
    });

    // Every Tsum in the same filter, for its rank.
    const field = new Map();
    each(await select({...f, tsums: []}), (c, i) => {
      const t = c.tsum[i];
      if (!field.has(t)) field.set(t, acc());
      add(field.get(t), c, i, c.stat[k]);
    });

    // What boxes are paid with: final coins (net when asked) and medals, a round with none as 0.
    const earn = {coins: 0, coinSecs: 0, medals: 0, secs: 0};
    const ef = {...f, tsums: [], medals: false, finalCoins: true, noJackpots: false};
    if (f.range?.kind === 'final' || f.range?.kind === 'base') ef.range = {...f.range, kind: 'final'};
    const ek = ef.net ? 'netFinal' : 'final';
    each(await select(ef), (c, i) => {
      const s = c.stat[ek];
      if (s.n[i]) { earn.coins += s.sum[i]; earn.coinSecs += s.secs[i]; }
      earn.medals += c.medalsSum[i];
      earn.secs += c.secs[i];
    });

    // The histogram's buckets split by skill level (tsum.go: SkillBins), and the rounds under the target, from the bins.
    const spreads = summed.global.spreads;
    const skillBins = new Map();
    const bounds = spreads ? histBounds(summed.totals) : null;
    const goal = q.target === undefined || q.target === '' || !Number.isFinite(Number(q.target)) ? null : Math.trunc(Number(q.target));
    const target = goal === null ? null : {target: goal, rounds: 0, under: 0, approx: true};
    if (spreads && (bounds || target)) {
      const set = statSet(sel, k, false);
      const a = set.totals.minCoins === null ? null : {min: set.totals.minCoins, max: set.totals.maxCoins};
      for (const s of [...new Set(sel.flatMap(({p, idx}) => idx.map(i => p.skill[i])))]) {
        const only = sel.map(({p, idx}) => ({p, idx: idx.filter(i => p.skill[i] === s)})).filter(x => x.idx.length);
        for (const [, {pairs}] of binGroups(only, k, () => '') ?? []) {
          for (const [v, rounds] of pairs) {
            const value = Math.min(a.max, Math.max(a.min, v));
            if (target) { target.rounds += rounds; if (value < goal) target.under += rounds; }
            if (!bounds || s < 0) continue;
            const from = bucketOf(value, bounds);
            const key = `${s}\u0000${from}`;
            if (skillBins.has(key)) skillBins.get(key).rounds += rounds;
            else skillBins.set(key, {skill: String(s), from, rounds});
          }
        }
      }
    }

    if (whole) {
      summed.totals.maxCoins = whole.totals.maxCoins;
      for (const t of summed.tsums) t.maxCoins = whole.totals.maxCoins;
      summed.mix = whole.mix;
    }

    const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
    return {
      summary: summed,
      // tsum.go's order: by setting, then value as text.
      settings: [...[...bySkill].map(([s, a]) => ({setting: 'skillLevel', ...group(a, String(s))})),
        ...[...byPlay.values()].map(({setting, key, a}) => ({setting, ...group(a, key)}))]
        .sort((x, y) => cmp(x.setting, y.setting) || cmp(x.key, y.key)),
      chains: [...byChains].map(([key, {scan, chain, a}]) => ({scan, chain, ...group(a, key)}))
        .sort((x, y) => y.rounds - x.rounds || cmp(x.scan, y.scan) || cmp(x.chain, y.chain)),
      skillTypes: [...byType].map(([t, a]) => group(a, t)).sort((x, y) => y.rounds - x.rounds || cmp(x.key, y.key)),
      versions: [],
      devices: [],
      field: [...field].sort((x, y) => cmp(x[0], y[0])).map(([t, a]) => ({
        tsum: t, rounds: a.rounds, rateCoins: a.rateN ? a.rateCoins : null, rateSeconds: a.rateN ? a.rateSecs : null, coinsPerSec: rate(a),
      })),
      form: [],
      skillBins: [...skillBins.values()].sort((x, y) => cmp(x.skill, y.skill) || x.from - y.from),
      earn: {coinsPerSec: earn.coinSecs ? earn.coins / earn.coinSecs : null, medalsPerSec: earn.secs ? earn.medals / earn.secs : null},
      target: spreads ? target : null,
      jackpots,
      global: {approx: true},
    };
  }

  async function tsums() {
    return (await getManifest()).tsums;
  }

  /** queries.go: PlayedSkillTypes, from the manifest; the rest of its rounds are those without one. */
  async function skillTypes() {
    const man = await getManifest();
    const out = (man.skillTypes ?? []).map(t => ({...t}));
    const none = man.rounds - out.reduce((n, t) => n + t.rounds, 0);
    if (none > 0) out.push({skillType: '', rounds: none});
    return out.sort((x, y) => y.rounds - x.rounds || (x.skillType < y.skillType ? -1 : 1));
  }

  /** queries.go: PlayedPlaySettings, from the manifest; the rest of its rounds are those where a setting is not recorded. */
  async function playSettings() {
    const man = await getManifest();
    return Object.fromEntries(PLAY_SETTINGS.map(({param}) => {
      const out = (man.playSettings?.[param] ?? []).map(v => ({...v}));
      const none = man.rounds - out.reduce((n, v) => n + v.rounds, 0);
      if (none > 0) out.push({value: '', rounds: none});
      return [param, out.sort((x, y) => y.rounds - x.rounds || (x.value < y.value ? -1 : 1))];
    }));
  }

  async function status() {
    const man = await getManifest();
    return {global: true, rounds: man.rounds, contributors: man.contributors, devices: man.devices, generatedAt: man.generatedAt,
      first: man.first, last: man.last, minContributors: man.minContributors, skills: man.skills};
  }

  return {
    async call(path, params = {}) {
      switch (path) {
        case 'summary': return summary(params);
        case 'tsum': return tsum(params);
        case 'tsums': return tsums();
        case 'skill-types': return skillTypes();
        case 'play-settings': return playSettings();
        case 'status': return status();
        case 'themes': return THEMES.map(t => ({...t}));
        case 'devices': case 'round-devices': case 'owned-sources': return [];
        case 'owned': return {list: null};
        default: throw new Error(`${path}: not available on the global site`);
      }
    },
  };
}
