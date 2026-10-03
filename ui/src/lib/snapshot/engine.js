// The snapshot's query engine: the same answers as the server's /api/stats
// routes (internal/stats/queries.go and summary.go), computed in the browser
// from the monthly files. A change to those queries must be made here too;
// `go test ./internal/stats` compares the two on the same rounds.
//
// It has no browser APIs, so it runs in a Web Worker and under Node. A
// `loader` supplies the files: {json(name) -> Promise<object>}.

const MAX_PER_PAGE = 200;

// ---- Reading the files ----

/** Turns a month file's columns into rows' worth of typed columns. */
function decodeMonth(m) {
  const at = new Float64Array(m.n);
  let t = 0;
  for (let i = 0; i < m.n; i++) { t += m.at[i]; at[i] = t; }
  return {...m, at};
}

const two = n => String(n).padStart(2, '0');
/** Seconds since 1970 (UTC) → "YYYY-MM-DD HH:MM:SS", the server's played_at. */
export function sqlTime(sec) {
  const d = new Date(sec * 1000);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}

const SQL_TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
/** A sqlTime or ISO time → seconds since 1970, or null when it is neither. */
export function parseTime(s) {
  s = String(s ?? '').trim();
  const m = SQL_TIME.exec(s);
  if (m) return Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]) / 1000;
  // ISO, with or without a zone; the server reads a bare one as UTC.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(s)) {
    const ms = Date.parse(/(Z|[+-]\d{2}:\d{2})$/.test(s) ? s : s + 'Z');
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  return null;
}

// ---- The filter (queries.go: Filter, ParseFilter) ----

function intCell(s) {
  if (s === '' || s === null || s === undefined) return null;
  s = String(s);
  if (/^[+-]?\d+$/.test(s)) return Number(s);
  const f = Number(s);
  return s.trim() !== '' && Number.isFinite(f) ? Math.trunc(f) : null;
}

/** The query parameters as the server reads them. */
export function parseFilter(q) {
  const f = {tsums: [], devices: [], build: '', from: null, to: null, finalCoins: false, medals: false};
  f.tsums = String(q.tsum ?? '').split(',').map(t => t.trim()).filter(Boolean);
  f.devices = String(q.device ?? '').split(',').map(d => d.trim()).filter(Boolean);
  if (q.build === 'global' || q.build === 'jp') f.build = q.build;
  f.from = q.from ? parseTime(q.from) : null;
  f.to = q.to ? parseTime(q.to) : null;
  for (const k of ['minCoins', 'maxCoins', 'minScore', 'maxScore', 'minMedals', 'maxMedals']) f[k] = intCell(q[k]);
  f.complete = q.incomplete !== '1';
  f.finalCoins = q.coins === 'final';
  f.medals = q.coins === 'medals';
  return f;
}

/** The primary stat's column: what the figures and the rate use. */
const coinCol = f => (f.medals ? 'medals' : f.finalCoins ? 'finalCoins' : 'baseCoins');
/** The coin range's column: base or final coins, even in Medals mode. */
const rangeCol = f => (f.finalCoins ? 'finalCoins' : 'baseCoins');
/** v is within [lo, hi]; a null bound is open, a null v is outside a set one. */
const within = (v, lo, hi) => (lo === null || (v !== null && v >= lo)) && (hi === null || (v !== null && v <= hi));

// ---- The engine ----

export function createEngine(loader) {
  let manifest;
  const months = new Map(); // month → Promise<decoded month>

  const getManifest = () => (manifest ??= loader.json('manifest.json'));
  const getMonth = async name => {
    const man = await getManifest();
    const entry = man.months.find(m => m.month === name);
    if (!months.has(name)) months.set(name, loader.json(entry.file).then(decodeMonth));
    return months.get(name);
  };

  /** The months a filter's time range can touch. */
  async function monthsFor(f) {
    const man = await getManifest();
    const need = man.months.filter(m => {
      const first = parseTime(m.first), last = parseTime(m.last);
      return !(f.to !== null && first >= f.to) && !(f.from !== null && last < f.from);
    });
    return Promise.all(need.map(m => getMonth(m.month)));
  }

  /**
   * The rounds a filter keeps, as {sh, idx}: a month and the row numbers in it.
   * extra is what the summary adds on top (onlyMedals).
   */
  async function select(f, {onlyMedals = false} = {}) {
    const coinsCol = rangeCol(f);
    // Tsums that have earned medals (queries.go: medalTsumsSQL); an older snapshot has none.
    const medalSet = new Set((await getManifest()).medalTsums ?? []);
    const medalRange = f.minMedals !== null || f.maxMedals !== null;
    const tsumSet = f.tsums.length ? new Set(f.tsums) : null;
    const deviceSet = f.devices.length ? new Set(f.devices) : null;
    const out = [];
    for (const sh of await monthsFor(f)) {
      const deviceOk = deviceSet ? sh.dict.device.map(d => deviceSet.has(d)) : null;
      const tsumOk = tsumSet ? sh.dict.tsum.map(t => tsumSet.has(t)) : null;
      const buildOk = f.build ? sh.dict.build.map(b => b === f.build) : null;
      const medalTsum = sh.dict.tsum.map(t => medalSet.has(t));
      const idx = [];
      const coins = sh[coinsCol];
      for (let i = 0; i < sh.n; i++) {
        const at = sh.at[i];
        if (f.from !== null && at < f.from) continue;
        if (f.to !== null && at >= f.to) continue;
        if (tsumOk && !tsumOk[sh.tsum[i]]) continue;
        if (deviceOk && !deviceOk[sh.device[i]]) continue;
        if (buildOk && !buildOk[sh.build[i]]) continue;
        // Complete (queries.go: completeSQL): a Tsum and every figure read; medals only for a medal Tsum.
        if (f.complete && (sh.dict.tsum[sh.tsum[i]] === '' || sh.score[i] === null || sh.baseCoins[i] === null
          || sh.finalCoins[i] === null || sh.duration[i] === null || (sh.medals[i] === null && medalTsum[sh.tsum[i]]))) continue;
        if (!within(coins[i], f.minCoins, f.maxCoins)) continue;
        if (!within(sh.score[i], f.minScore, f.maxScore)) continue;
        if (medalRange && medalTsum[sh.tsum[i]] && !within(sh.medals[i], f.minMedals, f.maxMedals)) continue;
        if ((f.medals || onlyMedals) && !(sh.medals[i] !== null && sh.medals[i] > 0)) continue;
        idx.push(i);
      }
      if (idx.length) out.push({sh, idx});
    }
    return out;
  }

  const each = (sel, fn) => { for (const {sh, idx} of sel) for (const i of idx) fn(sh, i); };

  // ---- Aggregates (SQL's AVG, SUM, MIN, MAX skip nulls and are null over none) ----

  /** Running figures of one group, for one coin column. */
  const acc = () => ({
    rounds: 0, n: 0, sum: 0, sumSq: 0, min: null, max: null,
    scoreN: 0, scoreSum: 0, scoreMin: null, scoreMax: null,
    baseN: 0, baseSum: 0, finalN: 0, finalSum: 0,
    secsN: 0, secsSum: 0, rateCoins: 0, rateSecs: 0, rateN: 0,
    medalsN: 0, medalsSum: 0, first: null, last: null,
  });

  function add(a, sh, i, c) {
    a.rounds++;
    const v = sh[c][i];
    if (v !== null) {
      a.n++; a.sum += v; a.sumSq += v * v;
      if (a.min === null || v < a.min) a.min = v;
      if (a.max === null || v > a.max) a.max = v;
    }
    const s = sh.score[i];
    if (s !== null) {
      a.scoreN++; a.scoreSum += s;
      if (a.scoreMin === null || s < a.scoreMin) a.scoreMin = s;
      if (a.scoreMax === null || s > a.scoreMax) a.scoreMax = s;
    }
    const b = sh.baseCoins[i];
    if (b !== null) { a.baseN++; a.baseSum += b; }
    const fc = sh.finalCoins[i];
    if (fc !== null) { a.finalN++; a.finalSum += fc; }
    const d = sh.duration[i];
    if (d !== null) { a.secsN++; a.secsSum += d; }
    // Rate: coins and seconds over the rounds that have both.
    if (v !== null && d !== null && d > 0) { a.rateN++; a.rateCoins += v; a.rateSecs += d; }
    const m = sh.medals[i];
    if (m !== null) { a.medalsN++; a.medalsSum += m; }
    const at = sh.at[i];
    if (a.first === null || at < a.first) a.first = at;
    if (a.last === null || at > a.last) a.last = at;
  }

  const avg = (sum, n) => (n ? sum / n : null);
  const rate = a => (a.rateN ? a.rateCoins / a.rateSecs : null);
  /** Population variance of the coins, as the server computes it. */
  const variance = a => (a.n ? a.sumSq / a.n - (a.sum / a.n) ** 2 : null);
  const std = v => (v === null ? null : Math.sqrt(Math.max(0, v)));

  const totalsOf = a => ({
    rounds: a.rounds, avgScore: avg(a.scoreSum, a.scoreN), maxScore: a.scoreMax,
    avgCoins: avg(a.sum, a.n), minCoins: a.min, maxCoins: a.max,
    avgBaseCoins: avg(a.baseSum, a.baseN), avgFinalCoins: avg(a.finalSum, a.finalN),
    coinRounds: a.n, totalCoins: a.n ? a.sum : null,
    totalSeconds: a.secsN ? a.secsSum : null, avgSeconds: avg(a.secsSum, a.secsN),
    coinsPerSec: rate(a), totalMedals: a.medalsN ? a.medalsSum : null,
    first: a.first === null ? null : sqlTime(a.first), last: a.last === null ? null : sqlTime(a.last),
  });

  const tsumOf = (tsum, a) => ({
    tsum, rounds: a.rounds, avgScore: avg(a.scoreSum, a.scoreN), maxScore: a.scoreMax,
    avgCoins: avg(a.sum, a.n), minCoins: a.min, maxCoins: a.max,
    avgBaseCoins: avg(a.baseSum, a.baseN), avgFinalCoins: avg(a.finalSum, a.finalN),
    coins: a.n ? a.sum : null, totalSeconds: a.secsN ? a.secsSum : null, avgSeconds: avg(a.secsSum, a.secsN),
    coinsPerSec: rate(a),
  });

  /**
   * Quartiles and the 90th percentile of column c per group: the lower nearest
   * rank, so each is a real round (summary.go: coinSpreads).
   */
  function spreads(sel, c, groupOf) {
    const groups = new Map();
    each(sel, (sh, i) => {
      const v = sh[c][i];
      if (v === null) return;
      const g = groupOf(sh, i);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(v);
    });
    const out = new Map();
    for (const [g, values] of groups) {
      values.sort((a, b) => a - b);
      const n = values.length;
      const at = (num, den) => values[Math.floor(((n - 1) * num) / den)];
      out.set(g, {q1Coins: at(1, 4), medianCoins: at(1, 2), q3Coins: at(3, 4), p90Coins: at(9, 10)});
    }
    return out;
  }

  const noSpread = {stdCoins: null, q1Coins: null, medianCoins: null, q3Coins: null, p90Coins: null};

  /** The KPI totals and per-Tsum figures, with spreads, of column c (summary.go: statSet). */
  function statSet(sel, c) {
    const total = acc();
    const byTsum = new Map();
    each(sel, (sh, i) => {
      add(total, sh, i, c);
      const t = sh.dict.tsum[sh.tsum[i]];
      if (!byTsum.has(t)) byTsum.set(t, acc());
      add(byTsum.get(t), sh, i, c);
    });
    const perTsum = spreads(sel, c, (sh, i) => sh.dict.tsum[sh.tsum[i]]);
    const all = spreads(sel, c, () => '');

    const totals = totalsOf(total);
    totals.stdCoins = std(variance(total));
    Object.assign(totals, all.get('') ?? {q1Coins: null, medianCoins: null, q3Coins: null, p90Coins: null});

    const tsums = [...byTsum].map(([t, a]) => {
      const row = tsumOf(t, a);
      row.stdCoins = std(variance(a));
      return Object.assign(row, perTsum.get(t) ?? {q1Coins: null, medianCoins: null, q3Coins: null, p90Coins: null});
    }).sort((a, b) => b.rounds - a.rounds);
    return {totals, tsums};
  }

  // ---- Boost items ----

  const itemsOf = (sh, i) => (sh.items[i] === null ? -1 : sh.items[i]);

  /** The histogram's step: 1, 2 or 5 times a power of ten (summary.go: niceStep). */
  function niceStep(raw) {
    if (raw <= 1) return 1;
    const mag = 10 ** Math.floor(Math.log10(raw));
    for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag;
    return 10 * mag;
  }

  function histogram(sel, c, totals) {
    const h = {width: 0, cap: null, bins: []};
    if (totals.minCoins === null || totals.maxCoins === null) return h;
    const lo = totals.minCoins;
    let hi = totals.maxCoins;
    if (totals.q1Coins !== null && totals.q3Coins !== null) {
      hi = Math.min(hi, totals.q3Coins + Math.trunc((3 * (totals.q3Coins - totals.q1Coins)) / 2));
    }
    h.width = niceStep((hi - lo) / 24);
    const limit = (Math.floor(hi / h.width) + 1) * h.width;
    if (totals.maxCoins >= limit) h.cap = limit;
    const bins = new Map();
    each(sel, (sh, i) => {
      const v = sh[c][i];
      if (v === null) return;
      const bucket = Math.min(Math.floor(v / h.width) * h.width, limit);
      const key = bucket + '\u0000' + sh.dict.tsum[sh.tsum[i]];
      const bin = bins.get(key);
      if (bin) bin.rounds++;
      else bins.set(key, {from: bucket, tsum: sh.dict.tsum[sh.tsum[i]], rounds: 1});
    });
    h.bins = [...bins.values()].sort((a, b) => a.from - b.from);
    return h;
  }

  // ---- The routes ----

  /** /api/stats/summary (summary.go: Summarize). tz is the viewer's minutes east of UTC. */
  async function summary(q) {
    const f = parseFilter(q);
    const shift = (Number(q.tz) || 0) * 60;
    const c = f.medals ? 'medals' : coinCol(f);
    const sel = await select(f);

    const main = statSet(sel, c);
    // With medals as the primary stat the two sets are the same rounds and column.
    const medals = f.medals ? main : statSet(await select(f, {onlyMedals: true}), 'medals');

    const daily = new Map(), dailyTsums = new Map(), hours = new Map(), mix = new Map();
    const dayOf = at => sqlTime(at + shift).slice(0, 10);
    each(sel, (sh, i) => {
      const at = sh.at[i] + shift;
      const day = dayOf(sh.at[i]);
      const tsum = sh.dict.tsum[sh.tsum[i]];
      const hour = new Date(at * 1000).getUTCHours();
      for (const [map, key] of [[daily, day], [dailyTsums, day + '\u0000' + tsum], [hours, hour]]) {
        if (!map.has(key)) map.set(key, {a: acc(), day, tsum, hour});
        add(map.get(key).a, sh, i, c);
      }
      const build = sh.dict.build[sh.build[i]];
      const items = itemsOf(sh, i);
      const mk = `${build}\u0000${tsum}\u0000${items}`;
      if (!mix.has(mk)) mix.set(mk, {build, tsum, items, a: acc()});
      add(mix.get(mk).a, sh, i, c);
    });

    const byKey = (a, b, k) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0);
    return {
      totals: main.totals,
      daily: [...daily.values()].sort((a, b) => byKey(a, b, 'day')).map(({a, day}) => ({
        day, rounds: a.rounds, avgScore: avg(a.scoreSum, a.scoreN), minScore: a.scoreMin, maxScore: a.scoreMax,
        coins: a.n ? a.sum : null, avgCoins: avg(a.sum, a.n), minCoins: a.min, maxCoins: a.max, coinsPerSec: rate(a),
      })),
      tsums: main.tsums,
      dailyTsums: [...dailyTsums.values()].sort((a, b) => byKey(a, b, 'day')).map(({a, day, tsum}) => ({
        day, tsum, rounds: a.rounds, coins: a.n ? a.sum : null, avgCoins: avg(a.sum, a.n), coinsPerSec: rate(a),
      })),
      hours: [...hours.values()].sort((a, b) => a.hour - b.hour).map(({a, hour}) => ({
        hour, rounds: a.rounds, coins: a.n ? a.sum : null, avgCoins: avg(a.sum, a.n), coinsPerSec: rate(a),
      })),
      mix: [...mix.values()].sort((a, b) => b.a.rounds - a.a.rounds).map(({a, build, tsum, items}) => ({
        build, tsum, items, rounds: a.rounds, coins: a.n ? a.sum : null, coinRounds: a.n,
        rateCoins: a.rateN ? a.rateCoins : null, rateSeconds: a.rateN ? a.rateSecs : null,
      })),
      histogram: histogram(sel, c, main.totals),
      medals,
    };
  }

  // Sortable columns by the page's names (queries.go: sortColumns).
  const SORTS = {
    playedAt: (sh, i) => sh.at[i], tsum: (sh, i) => sh.dict.tsum[sh.tsum[i]], score: (sh, i) => sh.score[i],
    baseCoins: (sh, i) => sh.baseCoins[i], finalCoins: (sh, i) => sh.finalCoins[i], medals: (sh, i) => sh.medals[i],
    durationSeconds: (sh, i) => sh.duration[i], device: (sh, i) => sh.dict.device[sh.device[i]],
    medalsPerSec: (sh, i) => perSec(sh.medals[i], sh.duration[i]),
  };
  const perSec = (v, d) => (v === null || d === null || d === 0 ? null : v / d);

  const rowOf = (sh, i) => ({
    id: `${sh.month}:${i}`, playedAt: sqlTime(sh.at[i]), tsum: sh.dict.tsum[sh.tsum[i]], build: sh.dict.build[sh.build[i]],
    skillType: sh.dict.skillType[sh.skillType[i]], scriptVersion: sh.dict.scriptVersion[sh.scriptVersion[i]],
    durationSeconds: sh.duration[i], score: sh.score[i], baseCoins: sh.baseCoins[i], finalCoins: sh.finalCoins[i],
    medals: sh.medals[i], device: sh.dict.device[sh.device[i]], source: sh.dict.source[sh.source[i]], items: sh.items[i],
  });

  /** /api/stats/rounds: one page of the table (queries.go: RoundsPage). */
  async function rounds(q) {
    const f = parseFilter(q);
    const sort = String(q.sort ?? '');
    const desc0 = sort.startsWith('-');
    const name = desc0 ? sort.slice(1) : sort;
    let key = SORTS[name];
    let desc = desc0;
    if (name === 'coinsPerSec') { const c = coinCol(f); key = (sh, i) => perSec(sh[c][i], sh.duration[i]); }
    if (!key) { key = SORTS.playedAt; desc = true; }
    const sortsByTime = key === SORTS.playedAt;

    let perPage = Number(q.perPage);
    if (!(perPage >= 1 && perPage <= MAX_PER_PAGE)) perPage = 50;
    const page = Math.max(1, Math.trunc(Number(q.page)) || 1);

    // Months are in time order and so are their rows, so the position in this
    // list stands for the server's tie-break on round_id.
    const refs = [];
    for (const {sh, idx} of await select(f)) for (const i of idx) refs.push([sh, i]);
    const dir = desc ? -1 : 1;
    const keyed = refs.map((r, pos) => ({r, pos, k: key(r[0], r[1])}));
    keyed.sort((a, b) => {
      // Unread figures sort last either way, except the time, which is never unread.
      if (!sortsByTime && (a.k === null) !== (b.k === null)) return a.k === null ? 1 : -1;
      if (a.k !== b.k && !(a.k === null && b.k === null)) return (a.k < b.k ? -1 : 1) * dir;
      return (a.pos - b.pos) * dir;
    });
    const items = keyed.slice((page - 1) * perPage, page * perPage).map(({r}) => rowOf(r[0], r[1]));
    return {items, page};
  }

  async function tsums() {
    return (await getManifest()).tsums;
  }

  async function roundDevices() {
    return (await getManifest()).devices ?? [];
  }

  // One device's newest list for a build; null when it has none.
  async function owned(q) {
    const man = await getManifest();
    const src = (man.owned ?? []).find(o => o.device === (q.device ?? '') && o.build === (q.build === 'jp' ? 'jp' : 'global'));
    return src ? loader.json(src.file) : {list: null};
  }

  async function ownedSources() {
    return ((await getManifest()).owned ?? []).map(({device, build, stamp}) => ({device, build, stamp}));
  }

  async function status() {
    const man = await getManifest();
    return {snapshot: true, rounds: man.rounds, generatedAt: man.generatedAt, first: man.first, last: man.last, version: man.version};
  }

  async function themes() {
    return (await getManifest()).themes;
  }

  return {
    async call(path, params = {}) {
      switch (path) {
        case 'summary': return summary(params);
        case 'rounds': return rounds(params);
        case 'tsums': return tsums();
        case 'round-devices': return roundDevices();
        case 'owned': return owned(params);
        case 'owned-sources': return ownedSources();
        case 'status': return status();
        case 'themes': return themes();
        case 'devices': return [];
        default: throw new Error(`${path}: not available in a snapshot`);
      }
    },
  };
}
