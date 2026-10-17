// Checks the global engine (src/lib/global/engine.js) against the rounds it
// was built from. Synthetic rounds are aggregated into part files the way the
// Worker's hourly job does (global/CONTRACT.md §4.2, written out again below),
// and the engine's answers over them are held to the snapshot engine's answers
// over the raw rounds. The snapshot engine is itself held to the server's
// Summarize by `go test ./internal/stats` (TestSnapshotParity), so this is the
// shape and the figures of summary.go.
//
// Run: node --test tests/global-engine.test.mjs (npm run test:global).
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {createGlobalEngine} from '../src/lib/global/engine.js';
import {bucketOf, createEngine, histBounds, itemCost, sqlTime} from '../src/lib/snapshot/engine.js';

// ---- Synthetic rounds ----

// A small seeded generator (mulberry32), so a failure can be run again.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = random(20261014);
const pick = list => list[Math.floor(rnd() * list.length)];
const between = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const DAY = 86400;
const day0 = Date.UTC(2026, 7, 20) / 1000; // 2026-08-20
const DAYS = 56; // to 2026-10-14
// Each Tsum's coin range; "tiny" stays under 150 so its bins are mostly exact.
const TSUMS = {mickey: [800, 5200], minnie: [500, 3800], beastda: [1500, 7000], stitch: [900, 4000], tiny: [0, 150], pooh: [2000, 2600]};
const MEDAL_TSUMS = new Set(['beastda', 'stitch']);
const SKILLS = [1, 2, 3, 4, 5, 6, -1];
const ITEMS = [0, 1, 5, 7, 65, 127, -1];

function makeRound() {
  const tsum = pick(Object.keys(TSUMS));
  const [lo, hi] = TSUMS[tsum];
  // A few rounds sit on the day's edges, where a UTC day starts and ends.
  const d = between(0, DAYS - 1);
  const edge = rnd();
  const playedAt = day0 + d * DAY + (edge < 0.02 ? 0 : edge < 0.04 ? DAY - 1 : between(1, DAY - 2));
  const base = between(lo, hi);
  let medals = null;
  if (MEDAL_TSUMS.has(tsum)) medals = rnd() < 0.6 ? between(1, 400) : 0;
  else if (rnd() < 0.3) medals = 0;
  return {
    playedAt, tsum, build: rnd() < 0.25 ? 1 : 0, skill: pick(SKILLS), items: pick(ITEMS),
    duration: between(300, 9000) / 10, score: between(100000, 20000000),
    base, final: Math.round(base * (1.2 + rnd() * 0.5)), medals,
  };
}
const ROUNDS = Array.from({length: 6000}, makeRound).sort((a, b) => a.playedAt - b.playedAt);

// ---- The part files, as the hourly job writes them (CONTRACT §3.1, §4.2, §5) ----

const bin = v => (v < 100 ? v : 100 + Math.floor(Math.log(v / 100) / Math.log(1.02)));
const mid = b => (b < 100 ? b : Math.round(100 * 1.02 ** (b - 99.5)));
const dayOf = at => sqlTime(at).slice(0, 10);
const sha8 = s => createHash('sha256').update(s).digest('hex').slice(0, 8);

/** One part: the cells and their bins (format 2) of the rounds in [from, to). */
function partOf(from, to, rounds) {
  const cells = new Map(), bins = new Map();
  for (const r of rounds) {
    const day = dayOf(r.playedAt);
    const medal = r.medals !== null && r.medals > 0 ? 1 : 0;
    const ck = [day, r.build, r.tsum, r.skill, r.items, medal].join('|');
    if (!cells.has(ck)) {
      cells.set(ck, {day, build: r.build, tsum: r.tsum, skill: r.skill, items: r.items, medal, rounds: 0, secs: 0,
        scoreSum: 0, scoreMin: null, scoreMax: null, first: null, last: null,
        baseSum: 0, baseSq: 0, baseMin: null, baseMax: null, finalSum: 0, finalSq: 0, finalMin: null, finalMax: null,
        medalsN: 0, medalsSum: 0, medalsSq: 0, medalsMin: null, medalsMax: null, medalsSecs: 0});
    }
    const c = cells.get(ck);
    const lo = (x, v) => (x === null || v < x ? v : x), hi = (x, v) => (x === null || v > x ? v : x);
    c.rounds++; c.secs += r.duration;
    c.scoreSum += r.score; c.scoreMin = lo(c.scoreMin, r.score); c.scoreMax = hi(c.scoreMax, r.score);
    c.first = lo(c.first, r.playedAt); c.last = hi(c.last, r.playedAt);
    c.baseSum += r.base; c.baseSq += r.base * r.base; c.baseMin = lo(c.baseMin, r.base); c.baseMax = hi(c.baseMax, r.base);
    c.finalSum += r.final; c.finalSq += r.final * r.final; c.finalMin = lo(c.finalMin, r.final); c.finalMax = hi(c.finalMax, r.final);
    if (r.medals !== null) {
      c.medalsN++; c.medalsSum += r.medals; c.medalsSq += r.medals * r.medals; c.medalsSecs += r.duration;
      c.medalsMin = lo(c.medalsMin, r.medals); c.medalsMax = hi(c.medalsMax, r.medals);
    }
    if (!bins.has(ck)) bins.set(ck, {day, build: r.build, tsum: r.tsum, skill: r.skill, items: r.items, medal, base: {}, final: {}, medals: {}});
    const b = bins.get(ck);
    const into = (o, v) => {
      const f = (o[bin(v)] ??= [0, 0, 0, 0, 0, 0]);
      f[0]++; f[1] += r.duration; f[2] += r.score; f[3] += r.base; f[4] += r.final; f[5] += r.medals ?? 0;
    };
    into(b.base, r.base);
    into(b.final, r.final);
    if (r.medals > 0) into(b.medals, r.medals);
  }
  // Rows are in no particular order: reversed, so nothing leans on the rounds' order.
  const columns = (rows, keys) => ({n: rows.length, ...Object.fromEntries(keys.map(k => [k, rows.map(row => row[k]).reverse()]))});
  const cellRows = [...cells.values()];
  return {
    kind: 'tsum-global-part', format: 2, from, to,
    cells: columns(cellRows, Object.keys(cellRows[0])),
    bins: columns([...bins.values()], ['day', 'build', 'tsum', 'skill', 'items', 'medal', 'base', 'final', 'medals']),
  };
}

const nextDay = day => dayOf(Date.parse(`${day}T00:00:00Z`) / 1000 + DAY);

/**
 * A part as the Worker publishes one too long for one D1 value: n files for
 * the same days, each a share of its cells rows and, apart from those, a
 * share of its bins rows (CONTRACT §4.2).
 */
function sharesOf(part, n) {
  const share = (cols, k) => {
    const size = Math.ceil(cols.n / n), lo = Math.min(cols.n, k * size), hi = Math.min(cols.n, lo + size);
    return Object.fromEntries(Object.entries(cols).map(([key, v]) => [key, key === 'n' ? hi - lo : v.slice(lo, hi)]));
  };
  return Array.from({length: n}, (_, k) => ({...part, cells: share(part.cells, k), bins: share(part.bins, k)}));
}

/**
 * The published files: August compacted into a month part, every later day
 * its own part (in `split` files each), and the manifest. Returns
 * {files: name → JSON text, manifest}.
 */
function publish(rounds, {skipDays = [], split = 1} = {}) {
  const files = new Map();
  const parts = [];
  const put = (kind, from, to, label) => {
    const rs = rounds.filter(r => dayOf(r.playedAt) >= from && dayOf(r.playedAt) < to);
    if (!rs.length) return;
    const whole = partOf(from, to, rs);
    for (const p of kind === 'day' && split > 1 ? sharesOf(whole, split) : [whole]) {
      const text = JSON.stringify(p);
      const sha = sha8(text);
      const file = `${kind}-${label}.${sha}.json`;
      files.set(file, text);
      parts.push({from, to, file, rounds: p.cells.rounds.reduce((n, x) => n + x, 0), sha});
    }
  };
  put('month', '2026-08-01', '2026-09-01', '2026-08');
  for (let day = '2026-09-01'; day <= '2026-10-14'; day = nextDay(day)) {
    if (!skipDays.includes(day)) put('day', day, nextDay(day), day);
  }
  const kept = rounds.filter(r => parts.some(p => dayOf(r.playedAt) >= p.from && dayOf(r.playedAt) < p.to));
  const byTsum = new Map();
  for (const r of kept) byTsum.set(r.tsum, (byTsum.get(r.tsum) ?? 0) + 1);
  const manifest = {
    kind: 'tsum-global', format: 1, generatedAt: '2026-10-14T19:05:12Z',
    rounds: kept.length, contributors: 12, devices: 40,
    first: sqlTime(kept[0].playedAt), last: sqlTime(kept.at(-1).playedAt), parts,
    tsums: [...byTsum].sort((a, b) => b[1] - a[1]).map(([tsum, n], i) => ({tsum, rounds: n, contributors: i + 1})),
    medalTsums: [...MEDAL_TSUMS], skills: [...new Set(kept.map(r => r.skill))].filter(s => s >= 0).sort((a, b) => a - b),
    minContributors: 3,
  };
  files.set('manifest.json', JSON.stringify(manifest));
  return {files, manifest};
}

/** A loader over files, as the worker's fetch is: a missing one rejects with status 404. It logs every read. */
function loaderOf(files, log = []) {
  return {
    log,
    async json(name, opts = {}) {
      log.push({name, fresh: Boolean(opts.fresh)});
      const text = files instanceof Map ? files.get(name) : files(name);
      if (text === undefined) throw Object.assign(new Error(`${name}: 404`), {status: 404});
      return JSON.parse(text);
    },
  };
}

// ---- The brute force: the snapshot engine over the raw rounds ----

/** The rounds as one snapshot month file (snapshot.go: encodeMonth), for the snapshot engine. */
function snapshotOf(rounds) {
  const dict = {tsum: [], build: ['global', 'jp'], skillType: [''], scriptVersion: ['1'], device: ['d'], source: ['test'], settings: ['{}']};
  const tsumIndex = t => (dict.tsum.includes(t) ? dict.tsum.indexOf(t) : dict.tsum.push(t) - 1);
  const zeros = () => rounds.map(() => 0);
  const month = {
    format: 1, month: 'all', n: rounds.length, dict,
    at: rounds.map((r, i) => (i ? r.playedAt - rounds[i - 1].playedAt : r.playedAt)),
    tsum: rounds.map(r => tsumIndex(r.tsum)), build: rounds.map(r => r.build),
    skillType: zeros(), scriptVersion: zeros(), device: zeros(), source: zeros(), settings: zeros(),
    duration: rounds.map(r => r.duration), score: rounds.map(r => r.score), baseCoins: rounds.map(r => r.base),
    finalCoins: rounds.map(r => r.final), medals: rounds.map(r => r.medals), items: rounds.map(r => (r.items < 0 ? null : r.items)),
  };
  const manifest = {
    months: rounds.length ? [{month: 'all', file: 'month.json', first: sqlTime(rounds[0].playedAt), last: sqlTime(rounds.at(-1).playedAt)}] : [],
    medalTsums: [...MEDAL_TSUMS],
  };
  return createEngine(loaderOf(new Map([['manifest.json', JSON.stringify(manifest)], ['month.json', JSON.stringify(month)]])));
}

/** A time parameter as the server reads it: sqlTime or ISO, UTC. */
const timeOf = s => Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z') / 1000;
const listOf = s => (s ? String(s).split(',').map(v => v.trim()) : []);

/** The rounds a global filter keeps (CONTRACT §6.2): a round counts by its UTC day's start. */
function keepRound(r, q) {
  const start = Math.floor(r.playedAt / DAY) * DAY;
  if (q.from && start < Math.floor(timeOf(q.from) / DAY) * DAY) return false;
  if (q.to && start >= timeOf(q.to)) return false;
  if (q.build && (r.build ? 'jp' : 'global') !== q.build) return false;
  if (q.tsum && !listOf(q.tsum).includes(r.tsum)) return false;
  if (q.skill && !listOf(q.skill).map(Number).includes(r.skill)) return false;
  if (q.items && !listOf(q.items).map(Number).includes(r.items)) return false;
  return true;
}

/** A round's cell (CONTRACT §3.1): its start day, build, Tsum, skill level, items and whether it earned medals. */
const cellKey = r => [dayOf(r.playedAt), r.build, r.tsum, r.skill, r.items, r.medals > 0 ? 1 : 0].join('|');

/**
 * The rounds an outlier range keeps (CONTRACT §6.2): those of each cell's bins
 * whose rounds' average (less the items' cost, for net coins) is in the
 * range. The medal range judges only the Tsums that earn medals.
 */
function cutRounds(rounds, q) {
  const n = k => (q[k] === undefined || q[k] === '' ? null : Number(q[k]));
  const coins = n('minCoins') !== null || n('maxCoins') !== null;
  const medals = !coins && (n('minMedals') !== null || n('maxMedals') !== null);
  if (!coins && !medals) return rounds;
  const [lo, hi] = coins ? [n('minCoins'), n('maxCoins')] : [n('minMedals'), n('maxMedals')];
  const net = coins && q.net === '1';
  const own = r => (medals ? r.medals : q.coins === 'final' ? r.final : r.base);
  const inside = v => (lo === null || v >= lo) && (hi === null || v <= hi);
  const groups = new Map();
  for (const r of rounds) {
    if (medals && (!MEDAL_TSUMS.has(r.tsum) || !(r.medals > 0))) continue;
    const k = `${cellKey(r)}|${bin(own(r))}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const keep = new Set();
  for (const g of groups.values()) {
    const cost = net ? itemCost(g[0].items < 0 ? null : g[0].items) : 0;
    if (cost !== null && inside(g.reduce((s, r) => s + own(r), 0) / g.length - cost)) for (const r of g) keep.add(r);
  }
  return rounds.filter(r => keep.has(r) || (medals && (!MEDAL_TSUMS.has(r.tsum) || (!(r.medals > 0) && inside(0)))));
}

/** The summary a brute force over the rounds gives: the snapshot engine's, with the spreads exact. */
async function expected(rounds, q) {
  const kept = cutRounds(rounds.filter(r => keepRound(r, q)), q);
  return snapshotOf(kept).call('summary', {coins: q.coins ?? '', net: q.net ?? ''});
}

// ---- Comparing ----

const SPREADS = new Set(['q1Coins', 'medianCoins', 'q3Coins', 'p90Coins']);
const by = (...keys) => (a, b) => {
  for (const k of keys) {
    const d = typeof a[k] === 'string' ? a[k].localeCompare(b[k]) : a[k] - b[k];
    if (d) return d;
  }
  return 0;
};
/** Puts the lists whose order the server leaves open (ties) in a fixed order (tests/parity.mjs: normalize). */
function normalize(v) {
  const sortTsums = t => [...t].sort(by('tsum'));
  return {
    ...v,
    tsums: sortTsums(v.tsums), medals: {...v.medals, tsums: sortTsums(v.medals.tsums)},
    dailyTsums: [...v.dailyTsums].sort(by('day', 'tsum')),
    mix: [...v.mix].sort(by('build', 'tsum', 'items')),
    chains: [...v.chains].sort(by('build', 'tsum', 'scan', 'chain')),
  };
}

/**
 * The differences between want (the brute force) and got (the engine). Numbers
 * are equal to 1e-9 relative, as sums are added in another order. A spread
 * figure is checked by spreadDiff; with spreads off it is null.
 */
function diff(want, got, spreads, path = '') {
  if (typeof want === 'number' && typeof got === 'number') {
    return Math.abs(want - got) <= 1e-9 * Math.max(1, Math.abs(want), Math.abs(got)) ? [] : [`${path}: want ${want}, got ${got}`];
  }
  if (want === null || got === null || typeof want !== 'object' || typeof got !== 'object') {
    return want === got ? [] : [`${path}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`];
  }
  if (Array.isArray(want) !== Array.isArray(got)) return [`${path}: array vs object`];
  if (Array.isArray(want) && want.length !== got.length) return [`${path}: want ${want.length} entries, got ${got.length}`];
  const out = [];
  for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
    if (k === 'net' || k === 'binned') continue; // markBinned's notes
    if (SPREADS.has(k) && typeof want[k] !== 'string') out.push(...spreadDiff(want[k], got[k], want, spreads, `${path}.${k}`));
    else out.push(...diff(want[k], got[k], spreads, `${path}.${k}`));
  }
  return out;
}

/**
 * One spread figure: got against the exact want of the group g (a totals or
 * Tsum row), and against what the bins give (g.binned, from binnedSpreads).
 * Within 2 % of the exact one, exact under 100; net coins, whose bins of
 * different item costs overlap, within two bins of their coins before the cost.
 */
function spreadDiff(want, got, g, spreads, path) {
  if (!spreads || want === null) return got === null ? [] : [`${path}: want null, got ${got}`];
  const key = path.split('.').at(-1);
  // A net figure's bin is 2 % of its coins before the cost (at most 7,000), and bins of different costs overlap.
  const close = Math.abs(want) < 100 && !g.net ? got === want : Math.abs(got - want) <= 0.02 * (g.net ? 2 * (Math.abs(want) + 7000) : Math.abs(want));
  const binned = g.binned?.[key];
  return close && (binned === undefined || Math.abs(got - binned) < 1e-9 * Math.max(1, Math.abs(got)))
    ? [] : [`${path}: exact ${want}, binned ${binned}, got ${got}`];
}

/**
 * The spreads the bins give for some rounds: a bin's rounds of each item cost
 * at their average (less the cost), in that order, the lower nearest rank's,
 * kept within lo and hi. valueOf gives a round's stat before any cost, costOf its cost.
 */
function binnedSpreads(rounds, valueOf, costOf, lo, hi) {
  const groups = new Map();
  for (const r of rounds) {
    const v = valueOf(r), cost = costOf(r);
    if (v === null || cost === null) continue;
    const k = `${cellKey(r)}|${bin(v)}`;
    if (!groups.has(k)) groups.set(k, {bin: bin(v), cost, n: 0, sum: 0});
    const g = groups.get(k);
    g.n++; g.sum += v;
  }
  const merged = new Map();
  for (const g of groups.values()) {
    const k = `${g.bin}|${g.cost}`;
    const m = merged.get(k) ?? {n: 0, sum: 0, cost: g.cost};
    m.n += g.n; m.sum += g.sum;
    merged.set(k, m);
  }
  const pairs = [...merged.values()].map(m => [m.sum / m.n - m.cost, m.n]).sort((a, b) => a[0] - b[0]);
  const n = pairs.reduce((s, [, k]) => s + k, 0);
  const at = (num, den) => {
    const rank = Math.floor(((n - 1) * num) / den);
    let seen = 0;
    for (const [v, k] of pairs) if ((seen += k) > rank) return Math.min(hi, Math.max(lo, v));
    return hi;
  };
  return n ? {q1Coins: at(1, 4), medianCoins: at(1, 2), q3Coins: at(3, 4), p90Coins: at(9, 10)} : null;
}

/** A round's stat before any items' cost, and the cost (0 unless net; null when its items are unknown). */
/** A round medal figures count (queries.go: medalRoundsSQL): a medal Tsum's, with medals read, 0s included. */
const medalRound = r => r.medals !== null && MEDAL_TSUMS.has(r.tsum);
const grossOf = (r, q) => (q.coins === 'medals' ? r.medals : q.coins === 'final' ? r.final : r.base);
const costOf = (r, q) => (q.coins !== 'medals' && q.net === '1' ? itemCost(r.items < 0 ? null : r.items) : 0);

/**
 * The histogram the bins give, worked out from the raw rounds: each bin's
 * rounds of one item cost at their average, kept within its Tsum's lowest and
 * highest, bucketed on the engine's bounds.
 */
function expectedHistogram(rounds, q, got) {
  const bounds = histBounds(got.totals);
  if (!bounds) return {width: 0, cap: null, bins: []};
  const range = new Map(got.tsums.map(t => [t.tsum, t]));
  const groups = new Map();
  for (const r of cutRounds(rounds.filter(r => keepRound(r, q)), q)) {
    const v = grossOf(r, q), cost = costOf(r, q);
    if (v === null || cost === null || (q.coins === 'medals' && !medalRound(r))) continue;
    const k = `${r.tsum}|${bin(v)}|${cost}`;
    if (!groups.has(k)) groups.set(k, {tsum: r.tsum, cost, n: 0, sum: 0});
    const g = groups.get(k);
    g.n++; g.sum += v;
  }
  const buckets = new Map();
  for (const g of groups.values()) {
    const t = range.get(g.tsum);
    const from = bucketOf(Math.min(t.maxCoins, Math.max(t.minCoins, g.sum / g.n - g.cost)), bounds);
    const key = `${from}|${g.tsum}`;
    if (!buckets.has(key)) buckets.set(key, {from, tsum: g.tsum, rounds: 0});
    buckets.get(key).rounds += g.n;
  }
  return {width: bounds.width, cap: got.totals.maxCoins >= bounds.limit ? bounds.limit : null, bins: [...buckets.values()].sort(by('from', 'tsum'))};
}

const {files, manifest} = publish(ROUNDS);

/** Each group of want (totals and Tsums, of the primary stat and of the medal set) told what its bins give. */
function markBinned(want, q) {
  const kept = cutRounds(ROUNDS.filter(r => keepRound(r, q)), q);
  const mark = (set, rounds, valueOf, cost, net) => {
    const of = rs => binnedSpreads(rs, valueOf, cost, -Infinity, Infinity);
    Object.assign(set.totals, {net, binned: clampTo(of(rounds), set.totals)});
    for (const t of set.tsums) Object.assign(t, {net, binned: clampTo(of(rounds.filter(r => r.tsum === t.tsum)), t)});
  };
  const clampTo = (s, g) => s && Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Math.min(g.maxCoins, Math.max(g.minCoins, v))]));
  const primary = q.coins === 'medals' ? kept.filter(medalRound) : kept;
  mark(want, primary, r => grossOf(r, q), r => costOf(r, q), q.net === '1' && q.coins !== 'medals');
  mark(want.medals, kept.filter(medalRound), r => r.medals, () => 0, false);
}
/** markBinned's notes, taken out again. */
const unmark = set => [set.totals, ...set.tsums].forEach(g => { delete g.net; delete g.binned; });

/**
 * Checks one filter's summary against the brute force; returns what the engine
 * answered. spreads: the primary stat has them; medalSpreads: the medal figures do.
 * cut: an outlier range is set, so the lowest, highest, spread and score extremes are about.
 */
async function check(engine, q, {spreads = true, medalSpreads = spreads, range = null, ignored = [], cut = false} = {}) {
  const got = await engine.call('summary', q);
  const want = await expected(ROUNDS, q);
  assert.deepEqual(got.global, {approx: true, spreads, range, ignored}, 'global note');
  // The server's orders, before the open ties are fixed.
  for (const list of [got.tsums, got.medals.tsums, got.mix, got.chains]) {
    assert.ok(list.every((t, i) => !i || list[i - 1].rounds >= t.rounds), 'most rounds first');
  }
  assert.ok(got.daily.every((d, i) => !i || got.daily[i - 1].day < d.day), 'days in order');
  assert.ok(got.histogram.bins.every((b, i) => !i || got.histogram.bins[i - 1].from <= b.from), 'buckets in order');

  const {global, histogram, ...rest} = got;
  const [w, g] = [normalize({...want, histogram: undefined}), normalize(structuredClone({...rest, histogram: undefined}))];
  if (cut) { aboutOnly(w, spreads, medalSpreads); aboutOnly(g); }
  else markBinned(w, q);
  const problems = [...diff({...w, medals: undefined}, {...g, medals: undefined}, spreads), ...diff(w.medals, g.medals, medalSpreads, '.medals')];
  if (!cut) { unmark(w); unmark(w.medals); }
  assert.deepEqual(problems.slice(0, 10), [], `${JSON.stringify(q)}: ${problems.length} differences`);

  if (!spreads) {
    assert.deepEqual(histogram, {width: 0, cap: null, bins: []}, 'no histogram without spreads');
  } else if (cut) {
    assert.equal(histogram.bins.reduce((n, b) => n + b.rounds, 0), want.totals.coinRounds, 'histogram rounds');
  } else {
    assert.deepEqual({...histogram, bins: [...histogram.bins].sort(by('from', 'tsum'))}, expectedHistogram(ROUNDS, q, got), 'histogram');
    // Every round with the stat (net coins: whose items are known) is in it, once.
    for (const t of got.tsums) {
      const n = histogram.bins.filter(b => b.tsum === t.tsum).reduce((s, b) => s + b.rounds, 0);
      const has = ROUNDS.filter(r => r.tsum === t.tsum && keepRound(r, q) && grossOf(r, q) !== null && costOf(r, q) !== null);
      assert.equal(n, q.coins === 'medals' ? t.rounds : has.length, `histogram rounds of ${t.tsum}`);
    }
  }
  return got;
}

/**
 * Under an outlier range, the figures a cut cell keeps only about (CONTRACT
 * §6.2) are taken out, and the spreads too, leaving whether there are any:
 * the rest must match exactly. primary and medals: whether the brute force's
 * spreads should be there (the engine's are left as they are).
 */
function aboutOnly(v, primary = true, medals = true) {
  const sets = [[[v.totals, ...v.tsums, ...v.daily], primary], [[v.medals.totals, ...v.medals.tsums], medals]];
  for (const [rows, on] of sets) {
    for (const r of rows) {
      for (const k of ['minCoins', 'maxCoins', 'stdCoins', 'maxScore', 'minScore', 'first', 'last', ...SPREADS]) {
        if (k in r) r[k] = SPREADS.has(k) ? (r[k] === null || !on ? null : 'some') : 'about';
      }
    }
  }
}

// ---- The cases ----

test('the synthetic data covers what the cases need', () => {
  assert.ok(manifest.parts.length > 40, 'a month part and many day parts');
  assert.ok(ROUNDS.some(r => r.playedAt % DAY === 0) && ROUNDS.some(r => r.playedAt % DAY === DAY - 1), 'rounds on day edges');
  assert.ok(ROUNDS.some(r => r.items === -1) && ROUNDS.some(r => r.skill === -1), 'unknown items and skill levels');
});

test('summary matches the brute force over every filter', async t => {
  const engine = createGlobalEngine(loaderOf(files));
  const cases = [
    {},
    {coins: 'final'},
    {coins: 'medals'},
    {build: 'jp'},
    {build: 'global', coins: 'final'},
    {tsum: 'mickey'},
    {tsum: 'tiny'},
    {tsum: 'beastda,stitch', coins: 'medals'},
    {tsum: 'beastda'},
    {skill: '3'},
    {skill: '3,-1', coins: 'final'},
    {skill: '2', tsum: 'stitch', coins: 'medals'},
    {from: '2026-09-10T00:00:00Z', to: '2026-09-20T00:00:00Z'},
    // A bound inside a day: from is rounded down to its day, and a day counts when it starts before to.
    {from: '2026-09-10 13:45:00', to: '2026-09-20 06:00:00'},
    {from: '2026-08-25T00:00:00.000Z', to: '2026-08-28T00:00:00.000Z'}, // inside the month part
    {from: '2026-08-30T00:00:00Z', to: '2026-09-02T00:00:00Z'}, // across the month part and day parts
    {from: '2026-10-07T00:00:00Z'}, // the page's last 7 days
    {to: '2026-08-21T00:00:00Z', coins: 'medals'},
    {build: 'global', tsum: 'mickey,pooh', skill: '4,5', from: '2026-09-01T00:00:00Z', coins: 'final'},
    // Medals are not net, so medals mode keeps its spreads whatever net says.
    {coins: 'medals', net: '1'},
  ];
  for (const q of cases) await t.test(JSON.stringify(q), () => check(engine, q));
});

test('net coins and an items filter have their spreads too: the bins are kept per item set', async t => {
  const engine = createGlobalEngine(loaderOf(files));
  const cases = [
    {net: '1'},
    {net: '1', coins: 'final', build: 'jp'},
    {net: '1', tsum: 'tiny'},
    {items: '7'},
    {items: '-1,0', coins: 'final'},
    {items: '65', coins: 'medals'},
    {items: '1,5', net: '1', skill: '2,3', from: '2026-09-15T00:00:00Z'},
  ];
  for (const q of cases) await t.test(JSON.stringify(q), () => check(engine, q));
});

test('an outlier range keeps whole bins: exact sums, the range\'s own spreads', async t => {
  const engine = createGlobalEngine(loaderOf(files));
  // [query, the range applied, the primary stat keeps its spreads, the medal figures do]
  const cases = [
    [{minCoins: '1500', maxCoins: '4000'}, 'base', true, false],
    [{maxCoins: '2500', tsum: 'mickey,beastda'}, 'base', true, false],
    [{minCoins: '3000', coins: 'final', build: 'jp'}, 'final', true, false],
    [{minCoins: '1000', maxCoins: '3000', net: '1'}, 'base', true, false],
    [{maxCoins: '60', tsum: 'tiny'}, 'base', true, false],
    [{minCoins: '2000', coins: 'medals'}, 'base', false, false],
    [{minMedals: '50', maxMedals: '300'}, 'medals', false, true],
    [{minMedals: '100', coins: 'medals', skill: '2,3'}, 'medals', true, true],
    [{maxMedals: '200', items: '0,7'}, 'medals', false, true],
    [{minMedals: '0', maxMedals: '80', tsum: 'stitch'}, 'medals', false, true],
    // Nothing is in it.
    [{minCoins: '900000'}, 'base', true, false],
  ];
  for (const [q, range, spreads, medalSpreads] of cases) {
    await t.test(JSON.stringify(q), () => check(engine, q, {spreads, medalSpreads, range, cut: true}));
  }
  await t.test('both ranges: the coins\' is applied, the medals\' left out', () =>
    check(engine, {minCoins: '1500', minMedals: '100'}, {spreads: true, medalSpreads: false, range: 'base', ignored: ['medals'], cut: true}));
});

test('a range on one round: its bin is kept or left out whole', async () => {
  const solo = {...ROUNDS[0], tsum: 'solo', base: 12345, final: 23456, medals: null, playedAt: day0 + 3600};
  const engine = createGlobalEngine(loaderOf(publish([solo, ...ROUNDS]).files));
  for (const [q, rounds] of [[{minCoins: '12345'}, 1], [{maxCoins: '12345'}, 1], [{minCoins: '12346'}, 0], [{maxCoins: '12344'}, 0]]) {
    const s = await engine.call('summary', {...q, tsum: 'solo'});
    assert.equal(s.totals.rounds, rounds, JSON.stringify(q));
    if (rounds) assert.deepEqual([s.totals.minCoins, s.totals.maxCoins, s.totals.medianCoins], [12345, 12345, 12345]);
  }
});

test('a Tsum with one round has its spreads exact', async () => {
  // Its bin's middle is off the round's own figure; the group's lowest and highest pull it back.
  const solo = {...ROUNDS[0], tsum: 'solo', base: 12345, final: 23456, medals: 150, playedAt: day0 + 3600};
  assert.notEqual(mid(bin(solo.base)), solo.base);
  // A medal Tsum, as the catalog says, so medals mode counts it.
  const published = publish([solo, ...ROUNDS]).files;
  const man = JSON.parse(published.get('manifest.json'));
  published.set('manifest.json', JSON.stringify({...man, medalTsums: [...man.medalTsums, 'solo']}));
  const engine = createGlobalEngine(loaderOf(published));
  for (const [coins, v] of [['', 12345], ['final', 23456], ['medals', 150]]) {
    const s = await engine.call('summary', {tsum: 'solo', coins});
    for (const k of SPREADS) assert.equal(s.totals[k], v, `${coins || 'base'} ${k}`);
    assert.deepEqual(s.histogram.bins, [{from: bucketOf(v, histBounds(s.totals)), tsum: 'solo', rounds: 1}]);
  }
});

test('net coins leave out rounds whose items are unknown', async () => {
  const engine = createGlobalEngine(loaderOf(files));
  const s = await engine.call('summary', {net: '1'});
  const known = ROUNDS.filter(r => r.items >= 0);
  assert.equal(s.totals.rounds, ROUNDS.length);
  assert.equal(s.totals.coinRounds, known.length);
  assert.equal(s.totals.totalCoins, known.reduce((n, r) => n + r.base - itemCost(r.items), 0));
});

test('an empty filter gives the empty summary', async t => {
  const engine = createGlobalEngine(loaderOf(files));
  for (const q of [{tsum: 'nobody'}, {from: '2027-01-01T00:00:00Z'}, {to: '2026-08-01T00:00:00Z'}, {skill: '9'}, {items: '2', coins: 'medals'}]) {
    await t.test(JSON.stringify(q), async () => {
      const got = await check(engine, q);
      assert.equal(got.totals.rounds, 0);
      assert.equal(got.totals.avgCoins, null);
      assert.equal(got.totals.first, null);
      assert.deepEqual([got.tsums, got.daily, got.mix, got.chains, got.histogram.bins], [[], [], [], [], []]);
    });
  }
});

test('ignored parameters change nothing', async () => {
  const engine = createGlobalEngine(loaderOf(files));
  const plain = await engine.call('summary', {coins: 'final'});
  const noisy = await engine.call('summary', {coins: 'final', device: 'Phone', minScore: '4000', maxScore: '1', incomplete: '1', tz: '540'});
  assert.deepEqual(noisy, plain);
});

test('only the parts a range touches are read, once', async () => {
  const log = [];
  const engine = createGlobalEngine(loaderOf(files, log));
  await engine.call('summary', {from: '2026-09-12T00:00:00Z', to: '2026-09-13T00:00:00Z'});
  assert.deepEqual(log.map(l => l.name), ['manifest.json', manifest.parts.find(p => p.from === '2026-09-12').file]);
  await engine.call('summary', {from: '2026-09-12T08:00:00Z', to: '2026-09-12T20:00:00Z', coins: 'medals'});
  assert.equal(log.length, 2, 'the same part again is not read again');
  await engine.call('summary', {from: '2026-08-20T00:00:00Z', to: '2026-08-21T00:00:00Z'});
  assert.equal(log.at(-1).name, manifest.parts.find(p => p.from === '2026-08-01').file, 'August is the month part');
  assert.equal(log.length, 3);
});

test('a part published as several files adds up as one', async t => {
  const split = publish(ROUNDS, {split: 3});
  const days = manifest.parts.filter(p => p.file.startsWith('day-'));
  assert.equal(split.manifest.parts.length, manifest.parts.length + 2 * days.length, 'each day part in three files');
  for (const p of days) {
    const shares = split.manifest.parts.filter(s => s.from === p.from);
    assert.ok(shares.every(s => s.to === p.to), `${p.from}: the same days`);
    assert.equal(shares.reduce((n, s) => n + s.rounds, 0), p.rounds, `${p.from}: the files' rounds add up`);
  }
  const log = [];
  const engine = createGlobalEngine(loaderOf(split.files, log));
  const cases = [{}, {coins: 'medals'}, {tsum: 'stitch,mickey', coins: 'final', skill: '2,-1'}, {from: '2026-09-12T00:00:00Z', to: '2026-09-13T00:00:00Z'}];
  for (const q of cases) await t.test(JSON.stringify(q), () => check(engine, q));
  // Each of a day's files is read, once.
  const files = split.manifest.parts.filter(p => p.from === '2026-09-12').map(p => p.file);
  assert.deepEqual(log.filter(l => files.includes(l.name)).map(l => l.name).sort(), [...files].sort());
});

test('a part replaced since the manifest was read: the manifest is read again, once', async () => {
  // The old manifest names a part that has since been replaced (its file is gone).
  const old = publish(ROUNDS, {skipDays: []});
  const oldManifest = JSON.parse(old.files.get('manifest.json'));
  const day = oldManifest.parts.find(p => p.from === '2026-10-01');
  const gone = {...oldManifest, parts: oldManifest.parts.map(p => (p === day ? {...p, file: 'day-2026-10-01.deadbeef.json'} : p))};
  let reads = 0;
  const log = [];
  const engine = createGlobalEngine(loaderOf(name => (name === 'manifest.json' ? JSON.stringify(reads++ ? oldManifest : gone) : old.files.get(name)), log));
  const q = {from: '2026-09-29T00:00:00Z', to: '2026-10-03T00:00:00Z'};
  await check(engine, q);
  const manifestReads = log.filter(l => l.name === 'manifest.json');
  assert.deepEqual(manifestReads.map(l => l.fresh), [false, true], 'read again past the cache');

  // Still missing after the second read: the error comes through, after one retry.
  const log2 = [];
  const stuck = createGlobalEngine(loaderOf(name => (name === 'manifest.json' ? JSON.stringify(gone) : old.files.get(name)), log2));
  await assert.rejects(stuck.call('summary', q), e => e.status === 404);
  assert.equal(log2.filter(l => l.name === 'manifest.json').length, 2);

  // Any other failure is not retried, and is not kept: the next call tries again.
  let fail = true;
  const log3 = [];
  const flaky = createGlobalEngine(loaderOf(name => {
    if (name !== 'manifest.json' && fail) { fail = false; throw Object.assign(new Error('offline'), {status: 0}); }
    return old.files.get(name);
  }, log3));
  await assert.rejects(flaky.call('summary', q), /offline/);
  assert.equal(log3.filter(l => l.name === 'manifest.json').length, 1);
  await check(flaky, q);
});

test('the other routes', async () => {
  const engine = createGlobalEngine(loaderOf(files));
  assert.deepEqual(await engine.call('status'), {
    global: true, rounds: manifest.rounds, contributors: 12, devices: 40, generatedAt: manifest.generatedAt,
    first: manifest.first, last: manifest.last, minContributors: 3, skills: manifest.skills,
  });
  assert.deepEqual(await engine.call('tsums'), manifest.tsums);
  assert.deepEqual((await engine.call('themes')).map(t => t.file), ['halloween.css', 'midnight-felt.css', 'daylight-felt.css', 'ember.css']);
  for (const route of ['devices', 'round-devices', 'owned-sources']) assert.deepEqual(await engine.call(route), []);
  assert.deepEqual(await engine.call('owned', {build: 'jp'}), {list: null});
  for (const route of ['rounds', 'publish']) {
    await assert.rejects(engine.call(route, {id: 'mickey'}), /not available on the global site/);
  }
});

test('the Tsum page: its figures, its rank, by skill level', async () => {
  const engine = createGlobalEngine(loaderOf(files));
  const q = {id: 'mickey', coins: 'final', from: '2026-09-01T00:00:00Z', target: '3000'};
  const d = await engine.call('tsum', q);
  assert.deepEqual(d.summary, await engine.call('summary', {...q, tsum: 'mickey'}));
  const rs = ROUNDS.filter(r => r.tsum === 'mickey' && keepRound(r, {from: q.from}));
  // By skill level: exact, the unknown level left out.
  const levels = [...new Set(rs.map(r => r.skill))].filter(s => s >= 0).sort();
  assert.deepEqual(d.settings.map(s => [s.setting, s.key, s.rounds]),
    levels.map(s => ['skillLevel', String(s), rs.filter(r => r.skill === s).length]));
  const lvl = d.settings[0], at = rs.filter(r => r.skill === Number(lvl.key));
  assert.ok(Math.abs(lvl.avgCoins - at.reduce((n, r) => n + r.final, 0) / at.length) < 1e-9);
  assert.deepEqual([d.versions, d.devices, d.form], [[], [], []]);
  // By chains per scan and max chain together: these parts predate the play settings, so one pair, not recorded.
  assert.deepEqual(d.chains.map(g => [g.key, g.scan, g.chain, g.rounds]), [[',', '', '', rs.length]]);
  // Every Tsum's rate in the same filter.
  const field = new Map(d.field.map(t => [t.tsum, t]));
  for (const t of Object.keys(TSUMS)) {
    const ts = ROUNDS.filter(r => r.tsum === t && keepRound(r, {from: q.from}));
    assert.equal(field.get(t).rounds, ts.length, t);
    assert.ok(Math.abs(field.get(t).coinsPerSec - ts.reduce((n, r) => n + r.final, 0) / ts.reduce((n, r) => n + r.duration, 0)) < 1e-9, t);
  }
  // The skill levels' buckets add up to the rounds of known levels; the rounds under the target are about right.
  assert.equal(d.skillBins.reduce((n, b) => n + b.rounds, 0), rs.filter(r => r.skill >= 0).length);
  assert.equal(d.target.rounds, rs.length);
  const under = rs.filter(r => r.final < 3000).length;
  assert.ok(Math.abs(d.target.under - under) <= 0.05 * rs.length, `under ${d.target.under}, exactly ${under}`);
  const all = ROUNDS.filter(r => keepRound(r, {from: q.from}));
  assert.ok(Math.abs(d.earn.medalsPerSec - all.reduce((n, r) => n + (r.medals ?? 0), 0) / all.reduce((n, r) => n + r.duration, 0)) < 1e-9);
  await assert.rejects(engine.call('tsum', {}), /id is required/);
});
