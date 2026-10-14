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
/** What the bins give for an exact value v of a group from lo to hi: its bin's middle, kept within them. */
const approx = (v, lo, hi) => Math.min(hi, Math.max(lo, mid(bin(v))));
const dayOf = at => sqlTime(at).slice(0, 10);
const sha8 = s => createHash('sha256').update(s).digest('hex').slice(0, 8);

/** One part: the cells and bins of the rounds in [from, to). */
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
    const bk = [day, r.build, r.tsum, r.skill].join('|');
    if (!bins.has(bk)) bins.set(bk, {day, build: r.build, tsum: r.tsum, skill: r.skill, base: {}, final: {}, medals: {}});
    const b = bins.get(bk);
    const into = (o, v) => { o[bin(v)] = (o[bin(v)] ?? 0) + 1; };
    into(b.base, r.base);
    into(b.final, r.final);
    if (r.medals > 0) into(b.medals, r.medals);
  }
  // Rows are in no particular order: reversed, so nothing leans on the rounds' order.
  const columns = (rows, keys) => ({n: rows.length, ...Object.fromEntries(keys.map(k => [k, rows.map(row => row[k]).reverse()]))});
  const cellRows = [...cells.values()];
  return {
    kind: 'tsum-global-part', format: 1, from, to,
    cells: columns(cellRows, Object.keys(cellRows[0])),
    bins: columns([...bins.values()], ['day', 'build', 'tsum', 'skill', 'base', 'final', 'medals']),
  };
}

const nextDay = day => dayOf(Date.parse(`${day}T00:00:00Z`) / 1000 + DAY);

/**
 * The published files: August compacted into a month part, every later day
 * its own part, and the manifest. Returns {files: name → JSON text, manifest}.
 */
function publish(rounds, {skipDays = []} = {}) {
  const files = new Map();
  const parts = [];
  const put = (kind, from, to, label) => {
    const rs = rounds.filter(r => dayOf(r.playedAt) >= from && dayOf(r.playedAt) < to);
    if (!rs.length) return;
    const text = JSON.stringify(partOf(from, to, rs));
    const sha = sha8(text);
    const file = `${kind}-${label}.${sha}.json`;
    files.set(file, text);
    parts.push({from, to, file, rounds: rs.length, sha});
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

/** The summary a brute force over the rounds gives: the snapshot engine's, with the spreads exact. */
async function expected(rounds, q) {
  const kept = rounds.filter(r => keepRound(r, q));
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
  };
}

/**
 * The differences between want (the brute force) and got (the engine). Numbers
 * are equal to 1e-9 relative, as sums are added in another order. A spread
 * figure is the middle of the exact one's bin, kept within the group's lowest
 * and highest: so within 2 % of it, and exact under 100. With spreads off it is null.
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
    if (SPREADS.has(k)) out.push(...spreadDiff(want[k], got[k], want, spreads, `${path}.${k}`));
    else out.push(...diff(want[k], got[k], spreads, `${path}.${k}`));
  }
  return out;
}

/** One spread figure: got against the exact want of the group g (a totals or Tsum row). */
function spreadDiff(want, got, g, spreads, path) {
  if (!spreads || want === null) return got === null ? [] : [`${path}: want null, got ${got}`];
  const close = want < 100 ? got === want : Math.abs(got - want) <= 0.02 * Math.abs(want);
  return close && got === approx(want, g.minCoins, g.maxCoins) ? [] : [`${path}: exact ${want}, want ${approx(want, g.minCoins, g.maxCoins)}, got ${got}`];
}

/** The value a case's primary stat takes for a round (null when it has none). */
function statOf(r, q) {
  if (q.coins === 'medals') return r.medals;
  const v = q.coins === 'final' ? r.final : r.base;
  if (q.net !== '1') return v;
  const cost = itemCost(r.items < 0 ? null : r.items);
  return cost === null ? null : v - cost;
}

/**
 * The histogram the bins give, worked out from the raw rounds: each round's
 * bin middle, kept within its Tsum's exact lowest and highest, bucketed on the
 * engine's bounds.
 */
function expectedHistogram(rounds, q, got) {
  const bounds = histBounds(got.totals);
  if (!bounds) return {width: 0, cap: null, bins: []};
  const range = new Map(got.tsums.map(t => [t.tsum, t]));
  const buckets = new Map();
  for (const r of rounds) {
    if (!keepRound(r, q)) continue;
    const v = statOf(r, q);
    if (v === null || (q.coins === 'medals' && !(v > 0))) continue;
    const t = range.get(r.tsum);
    const from = bucketOf(approx(v, t.minCoins, t.maxCoins), bounds);
    const key = `${from}|${r.tsum}`;
    if (!buckets.has(key)) buckets.set(key, {from, tsum: r.tsum, rounds: 0});
    buckets.get(key).rounds++;
  }
  return {width: bounds.width, cap: got.totals.maxCoins >= bounds.limit ? bounds.limit : null, bins: [...buckets.values()].sort(by('from', 'tsum'))};
}

const {files, manifest} = publish(ROUNDS);

/**
 * Checks one filter's summary against the brute force; returns what the engine
 * answered. spreads: the primary stat has them; medalSpreads: the medal figures do.
 */
async function check(engine, q, {spreads = true, medalSpreads = spreads} = {}) {
  const got = await engine.call('summary', q);
  const want = await expected(ROUNDS, q);
  assert.deepEqual(got.global, {approx: true, spreads}, 'global note');
  assert.deepEqual(got.hours, [], 'hours');
  // The server's orders, before the open ties are fixed.
  for (const list of [got.tsums, got.medals.tsums, got.mix]) {
    assert.ok(list.every((t, i) => !i || list[i - 1].rounds >= t.rounds), 'most rounds first');
  }
  assert.ok(got.daily.every((d, i) => !i || got.daily[i - 1].day < d.day), 'days in order');
  assert.ok(got.histogram.bins.every((b, i) => !i || got.histogram.bins[i - 1].from <= b.from), 'buckets in order');

  const {global, hours, histogram, ...rest} = got;
  const [w, g] = [normalize({...want, hours: undefined, histogram: undefined}), normalize({...rest, hours: undefined, histogram: undefined})];
  const problems = [...diff({...w, medals: undefined}, {...g, medals: undefined}, spreads), ...diff(w.medals, g.medals, medalSpreads, '.medals')];
  assert.deepEqual(problems.slice(0, 10), [], `${JSON.stringify(q)}: ${problems.length} differences`);

  if (!spreads) {
    assert.deepEqual(histogram, {width: 0, cap: null, bins: []}, 'no histogram without spreads');
  } else {
    assert.deepEqual({...histogram, bins: [...histogram.bins].sort(by('from', 'tsum'))}, expectedHistogram(ROUNDS, q, got), 'histogram');
    // Every round with the stat is in it, once.
    for (const t of got.tsums) {
      const n = histogram.bins.filter(b => b.tsum === t.tsum).reduce((s, b) => s + b.rounds, 0);
      assert.equal(n, q.coins === 'medals' ? t.rounds : want.tsums.find(w => w.tsum === t.tsum).rounds, `histogram rounds of ${t.tsum}`);
    }
  }
  return got;
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

test('net coins and an items filter have exact figures but no spreads', async t => {
  const engine = createGlobalEngine(loaderOf(files));
  // Net coins have none; the medal figures (never net) keep theirs. An items filter leaves out both.
  const cases = [
    [{net: '1'}, true],
    [{net: '1', coins: 'final', build: 'jp'}, true],
    [{net: '1', tsum: 'tiny'}, true],
    [{items: '7'}, false],
    [{items: '-1,0', coins: 'final'}, false],
    [{items: '65', coins: 'medals'}, false],
    [{items: '1,5', net: '1', skill: '2,3', from: '2026-09-15T00:00:00Z'}, false],
  ];
  for (const [q, medalSpreads] of cases) await t.test(JSON.stringify(q), () => check(engine, q, {spreads: false, medalSpreads}));
});

test('a Tsum with one round has its spreads exact', async () => {
  // Its bin's middle is off the round's own figure; the group's lowest and highest pull it back.
  const solo = {...ROUNDS[0], tsum: 'solo', base: 12345, final: 23456, medals: 150, playedAt: day0 + 3600};
  assert.notEqual(mid(bin(solo.base)), solo.base);
  const engine = createGlobalEngine(loaderOf(publish([solo, ...ROUNDS]).files));
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
      const got = await check(engine, q, {spreads: !q.items});
      assert.equal(got.totals.rounds, 0);
      assert.equal(got.totals.avgCoins, null);
      assert.equal(got.totals.first, null);
      assert.deepEqual([got.tsums, got.daily, got.mix, got.histogram.bins], [[], [], [], []]);
    });
  }
});

test('ignored parameters change nothing', async () => {
  const engine = createGlobalEngine(loaderOf(files));
  const plain = await engine.call('summary', {coins: 'final'});
  const noisy = await engine.call('summary', {coins: 'final', device: 'Phone', minCoins: '4000', maxScore: '1', incomplete: '1', tz: '540'});
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
  for (const route of ['rounds', 'tsum', 'publish']) {
    await assert.rejects(engine.call(route, {id: 'mickey'}), /not available on the global site/);
  }
});
