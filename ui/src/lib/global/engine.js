// The global site's query engine: the server's /api/stats answers
// (internal/stats/summary.go, queries.go) computed in the browser from the
// published part files (global/CONTRACT.md §4 and §6). It follows the snapshot
// engine (../snapshot/engine.js) with cells in place of rounds: a cell is the
// sums of one day × build × Tsum × skill level × items × (medals > 0), so every
// figure but the quartiles and P90 adds up exactly. Those come from the bins
// and are approximate.
//
// It has no browser APIs, so it runs in a Web Worker, under Node and inside
// workerd. A `loader` supplies the files: {json(name, {fresh}) -> Promise<object>},
// where fresh asks past any cache, and a missing file rejects with an error
// whose `status` is 404.

import {bucketOf, histBounds, itemCost, parseFilter, parseTime, sqlTime} from '../snapshot/engine.js';

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

// ---- Reading the files ----

/** One stat's columns, a value per cell: rounds with it, its sum, sum of squares, lowest, highest and their seconds. */
const statCols = (n, sum, sq, min, max, secs) => ({n, sum, sq, min, max, secs});

/**
 * Coins less the items' cost (queries.go: Filter.Net), a cell at a time. Every
 * round in a cell used the same items, so its figures all move by the one
 * cost; a cell whose items are unknown has no net coins.
 */
function netCols(s, items) {
  const out = statCols([], [], [], [], [], s.secs);
  items.forEach((mask, i) => {
    const cost = itemCost(mask);
    const n = cost === null ? 0 : s.n[i];
    out.n.push(n);
    out.sum.push(n ? s.sum[i] - n * cost : 0);
    out.sq.push(n ? s.sq[i] - 2 * cost * s.sum[i] + n * cost * cost : 0);
    out.min.push(n ? s.min[i] - cost : null);
    out.max.push(n ? s.max[i] - cost : null);
  });
  return out;
}

/** A part file's cells and bins, with each row's day as a time, its build by name, and the stats' columns. */
function decodePart(p) {
  const c = p.cells;
  const builds = col => col.map(b => (b === 1 ? 'jp' : 'global'));
  const base = statCols(c.rounds, c.baseSum, c.baseSq, c.baseMin, c.baseMax, c.secs);
  const final = statCols(c.rounds, c.finalSum, c.finalSq, c.finalMin, c.finalMax, c.secs);
  const cells = {...c, at: c.day.map(dayStart), build: builds(c.build),
    stat: {base, final, netBase: netCols(base, c.items), netFinal: netCols(final, c.items),
      medals: statCols(c.medalsN, c.medalsSum, c.medalsSq, c.medalsMin, c.medalsMax, c.medalsSecs)}};
  // A bins object is {"<bin>": rounds}; as [bin, rounds] pairs it is read without parsing keys again.
  const pairs = col => col.map(o => Object.entries(o).map(([b, n]) => [Number(b), n]));
  const bins = {...p.bins, at: p.bins.day.map(dayStart), build: builds(p.bins.build),
    base: pairs(p.bins.base), final: pairs(p.bins.final), medals: pairs(p.bins.medals)};
  return {cells, bins};
}

// ---- The filter (CONTRACT §6.2) ----

/** A comma list of integers; anything else in it is left out. */
const intList = s => String(s ?? '').split(',').map(v => v.trim()).filter(v => /^-?\d+$/.test(v)).map(Number);

/**
 * The query parameters as the global site reads them: queries.go's, plus skill
 * and items lists. Devices, the outlier bounds, incomplete and tz are read but
 * not used: every round here is complete, and days are UTC.
 */
export function parseGlobalFilter(q) {
  const f = parseFilter(q);
  f.skills = intList(q.skill);
  f.items = intList(q.items);
  // A cell counts when its day starts at or after from's day, and before to.
  f.fromDay = f.from === null ? null : Math.floor(f.from / DAY) * DAY;
  return f;
}

/** The primary stat's columns: base or final coins, net when asked, or medals. */
const statKey = f => (f.medals ? 'medals' : f.net ? (f.finalCoins ? 'netFinal' : 'netBase') : f.finalCoins ? 'final' : 'base');
/** The bins behind a stat; net coins have none, since bins are not kept per item set. */
const binKey = {base: 'base', final: 'final', medals: 'medals'};

// ---- The engine ----

export function createGlobalEngine(loader) {
  let manifest; // Promise<manifest>
  const parts = new Map(); // file → Promise<decoded part>

  // A failed read is forgotten, so the next call tries again.
  const getManifest = (fresh = false) => (manifest ??= loader.json('manifest.json', {fresh}).catch(e => { manifest = null; throw e; }));
  const getPart = file => {
    if (!parts.has(file)) parts.set(file, loader.json(file).then(decodePart).catch(e => { parts.delete(file); throw e; }));
    return parts.get(file);
  };

  /** The parts a filter's days can touch: each holds [from, to) days. */
  function partsOf(man, f) {
    const need = man.parts.filter(p => (f.to === null || dayStart(p.from) < f.to) && (f.fromDay === null || dayStart(p.to) > f.fromDay));
    return Promise.all(need.map(p => getPart(p.file)));
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
      for (const file of parts.keys()) if (!man.parts.some(p => p.file === file)) parts.delete(file);
      return partsOf(man, f);
    }
  }

  /** Whether row i of a part's cells or bins (rows) is in the filter's days, build, Tsums and skill levels. */
  function keeps(f, rows, i, tsumSet, skillSet) {
    const at = rows.at[i];
    if (f.fromDay !== null && at < f.fromDay) return false;
    if (f.to !== null && at >= f.to) return false;
    if (f.build && rows.build[i] !== f.build) return false;
    if (tsumSet && !tsumSet.has(rows.tsum[i])) return false;
    return !skillSet || skillSet.has(rows.skill[i]);
  }

  /**
   * The cells a filter keeps, as {p, idx}: a part and the cell numbers in it, and
   * likewise the bins rows. onlyMedals keeps the rounds that earned medals, as
   * medals mode does.
   */
  async function select(f, {onlyMedals = false} = {}) {
    const tsumSet = f.tsums.length ? new Set(f.tsums) : null;
    const skillSet = f.skills.length ? new Set(f.skills) : null;
    const itemSet = f.items.length ? new Set(f.items) : null;
    const cells = [], bins = [];
    for (const p of await partsFor(f)) {
      const c = p.cells, idx = [];
      for (let i = 0; i < c.n; i++) {
        if (!keeps(f, c, i, tsumSet, skillSet)) continue;
        if (itemSet && !itemSet.has(c.items[i])) continue;
        if ((f.medals || onlyMedals) && !c.medal[i]) continue;
        idx.push(i);
      }
      if (idx.length) cells.push({p, idx});
      const b = p.bins, bidx = [];
      for (let i = 0; i < b.n; i++) if (keeps(f, b, i, tsumSet, skillSet)) bidx.push(i);
      if (bidx.length) bins.push({p, idx: bidx});
    }
    return {cells, bins};
  }

  const each = (sel, fn) => { for (const {p, idx} of sel) for (const i of idx) fn(p.cells, i); };

  // ---- Aggregates: the snapshot engine's, a cell at a time. Every round here
  // is complete, so a score, coins and a time are counted for each. ----

  /** Running figures of one group, for one stat's columns. */
  const acc = () => ({
    rounds: 0, n: 0, sum: 0, sumSq: 0, min: null, max: null,
    scoreSum: 0, scoreMin: null, scoreMax: null, baseSum: 0, finalSum: 0, secs: 0,
    rateCoins: 0, rateSecs: 0, rateN: 0, medalsN: 0, medalsSum: 0, first: null, last: null,
  });

  function add(a, c, i, s) {
    a.rounds += c.rounds[i];
    const n = s.n[i];
    if (n) {
      a.n += n; a.sum += s.sum[i]; a.sumSq += s.sq[i];
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
    if (a.first === null || c.first[i] < a.first) a.first = c.first[i];
    if (a.last === null || c.last[i] > a.last) a.last = c.last[i];
  }

  const avg = (sum, n) => (n ? sum / n : null);
  const rate = a => (a.rateN ? a.rateCoins / a.rateSecs : null);
  /** Population variance of the stat, as the server computes it. */
  const variance = a => (a.n ? a.sumSq / a.n - (a.sum / a.n) ** 2 : null);
  const std = v => (v === null ? null : Math.sqrt(Math.max(0, v)));
  const noSpread = () => ({q1Coins: null, medianCoins: null, q3Coins: null, p90Coins: null});

  const totalsOf = a => ({
    rounds: a.rounds, avgScore: avg(a.scoreSum, a.rounds), maxScore: a.scoreMax,
    avgCoins: avg(a.sum, a.n), minCoins: a.min, maxCoins: a.max,
    avgBaseCoins: avg(a.baseSum, a.rounds), avgFinalCoins: avg(a.finalSum, a.rounds),
    coinRounds: a.n, totalCoins: a.n ? a.sum : null,
    totalSeconds: a.rounds ? a.secs : null, avgSeconds: avg(a.secs, a.rounds),
    coinsPerSec: rate(a), totalMedals: a.medalsN ? a.medalsSum : null,
    first: a.first === null ? null : sqlTime(a.first), last: a.last === null ? null : sqlTime(a.last),
  });

  const tsumOf = (tsum, a) => ({
    tsum, rounds: a.rounds, avgScore: avg(a.scoreSum, a.rounds), maxScore: a.scoreMax,
    avgCoins: avg(a.sum, a.n), minCoins: a.min, maxCoins: a.max,
    avgBaseCoins: avg(a.baseSum, a.rounds), avgFinalCoins: avg(a.finalSum, a.rounds),
    coins: a.n ? a.sum : null, totalSeconds: a.rounds ? a.secs : null, avgSeconds: avg(a.secs, a.rounds),
    coinsPerSec: rate(a),
  });

  /** One group's bins, merged: [bin, rounds] pairs in bin order, and their rounds. */
  function binGroups(bsel, key, groupOf) {
    const groups = new Map();
    for (const {p, idx} of bsel) {
      for (const i of idx) {
        const g = groupOf(p.bins, i);
        if (!groups.has(g)) groups.set(g, new Map());
        const counts = groups.get(g);
        for (const [bin, n] of p.bins[key][i]) counts.set(bin, (counts.get(bin) ?? 0) + n);
      }
    }
    return new Map([...groups].map(([g, counts]) => {
      const pairs = [...counts].sort((x, y) => x[0] - y[0]);
      return [g, {pairs, n: pairs.reduce((sum, [, n]) => sum + n, 0)}];
    }));
  }

  /**
   * Quartiles and the 90th percentile per group, from its bins (CONTRACT §6.2):
   * the lower nearest rank (summary.go: coinSpreads) falls in a bin, and that
   * bin's middle, kept within the group's exact lowest and highest, stands for it.
   */
  function binSpreads(groups, accOf) {
    const out = new Map();
    for (const [g, {pairs, n}] of groups) {
      const a = accOf(g);
      if (!n || !a?.n) continue;
      const at = (num, den) => {
        const rank = Math.floor(((n - 1) * num) / den); // 0-based
        let seen = 0;
        for (const [bin, k] of pairs) {
          seen += k;
          if (seen > rank) return Math.min(a.max, Math.max(a.min, binMid(bin)));
        }
        return a.max;
      };
      out.set(g, {q1Coins: at(1, 4), medianCoins: at(1, 2), q3Coins: at(3, 4), p90Coins: at(9, 10)});
    }
    return out;
  }

  /** The KPI totals and per-Tsum figures of stat key k, with spreads when the bins have them (summary.go: statSet). */
  function statSet(sel, k, spreads) {
    const total = acc();
    const byTsum = new Map();
    each(sel.cells, (c, i) => {
      const s = c.stat[k];
      add(total, c, i, s);
      if (!byTsum.has(c.tsum[i])) byTsum.set(c.tsum[i], acc());
      add(byTsum.get(c.tsum[i]), c, i, s);
    });
    const bk = spreads ? binKey[k] : null;
    const perTsum = bk ? binSpreads(binGroups(sel.bins, bk, (b, i) => b.tsum[i]), t => byTsum.get(t)) : new Map();
    const all = bk ? binSpreads(binGroups(sel.bins, bk, () => ''), () => total) : new Map();

    const totals = totalsOf(total);
    totals.stdCoins = std(variance(total));
    Object.assign(totals, all.get('') ?? noSpread());

    const tsums = [...byTsum].map(([t, a]) => {
      const row = tsumOf(t, a);
      row.stdCoins = std(variance(a));
      return Object.assign(row, perTsum.get(t) ?? noSpread());
    }).sort((a, b) => b.rounds - a.rounds);
    return {totals, tsums, byTsum};
  }

  /**
   * The histogram (summary.go: coinHistogram) from the bins: each bin's rounds
   * go in the bucket holding the bin's middle, kept within its Tsum's exact
   * lowest and highest.
   */
  function histogram(bsel, k, set) {
    const h = {width: 0, cap: null, bins: []};
    const bounds = histBounds(set.totals);
    if (!bounds) return h;
    h.width = bounds.width;
    if (set.totals.maxCoins >= bounds.limit) h.cap = bounds.limit;
    const buckets = new Map();
    for (const [tsum, {pairs}] of binGroups(bsel, binKey[k], (b, i) => b.tsum[i])) {
      const a = set.byTsum.get(tsum);
      if (!a?.n) continue;
      for (const [bin, rounds] of pairs) {
        const from = bucketOf(Math.min(a.max, Math.max(a.min, binMid(bin))), bounds);
        const key = from + '\u0000' + tsum;
        const bucket = buckets.get(key);
        if (bucket) bucket.rounds += rounds;
        else buckets.set(key, {from, tsum, rounds});
      }
    }
    h.bins = [...buckets.values()].sort((a, b) => a.from - b.from);
    return h;
  }

  // ---- The routes ----

  /** /api/stats/summary (summary.go: Summarize) over UTC days, with the spreads approximate. */
  async function summary(q) {
    const f = parseGlobalFilter(q);
    const k = statKey(f);
    // Bins are kept per skill level but not per item set: no spreads under an items filter, nor of
    // net coins. Medals are never net, so the medal figures keep theirs.
    const binsFit = !f.items.length;
    const spreads = binsFit && binKey[k] !== undefined;
    const sel = await select(f);

    const main = statSet(sel, k, spreads);
    // With medals as the primary stat the two sets are the same cells and stat.
    const medals = f.medals ? main : statSet(await select(f, {onlyMedals: true}), 'medals', binsFit);

    const daily = new Map(), dailyTsums = new Map(), mix = new Map();
    each(sel.cells, (c, i) => {
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
      // Bots play around the clock and a day's cells have no hours.
      hours: [],
      mix: [...mix.values()].sort((a, b) => b.a.rounds - a.a.rounds).map(({a, build, tsum, items}) => ({
        build, tsum, items, rounds: a.rounds, coins: a.n ? a.sum : null, coinRounds: a.n,
        rateCoins: a.rateN ? a.rateCoins : null, rateSeconds: a.rateN ? a.rateSecs : null,
      })),
      histogram: spreads ? histogram(sel.bins, k, main) : {width: 0, cap: null, bins: []},
      medals: plain(medals),
      // spreads: whether the primary stat's quartiles, P90 and histogram are there.
      global: {approx: true, spreads},
    };
  }

  async function tsums() {
    return (await getManifest()).tsums;
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
        case 'tsums': return tsums();
        case 'status': return status();
        case 'themes': return THEMES.map(t => ({...t}));
        case 'devices': case 'round-devices': case 'owned-sources': return [];
        case 'owned': return {list: null};
        default: throw new Error(`${path}: not available on the global site`);
      }
    },
  };
}
