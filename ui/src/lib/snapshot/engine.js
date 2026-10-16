// The snapshot's query engine: the same answers as the server's /api/stats
// routes (internal/stats/queries.go and summary.go), computed in the browser
// from the monthly files. A change to those queries must be made here too;
// `go test ./internal/stats` compares the two on the same rounds.
//
// It has no browser APIs, so it runs in a Web Worker and under Node. A
// `loader` supplies the files: {json(name) -> Promise<object>}.

const MAX_PER_PAGE = 200;
// How many rounds make up a Tsum's recent form (tsum.go: FormRounds).
const FORM_ROUNDS = 50;

// ---- Reading the files ----

// What each boost item costs, by its bit (summary.go: itemBits).
const ITEM_COSTS = [[1, 500], [2, 1800], [4, 1000], [8, 500], [16, 500], [32, 1500], [64, 1200]];
/** What a round's items cost; null when it predates the items. */
export function itemCost(mask) {
  if (mask === null || mask === undefined || mask < 0) return null;
  return ITEM_COSTS.reduce((sum, [bit, cost]) => (mask & bit ? sum + cost : sum), 0);
}

/** Turns a month file's columns into rows' worth of typed columns. */
function decodeMonth(m) {
  const at = new Float64Array(m.n);
  let t = 0;
  for (let i = 0; i < m.n; i++) { t += m.at[i]; at[i] = t; }
  // Coins less the items' cost (queries.go: Filter.Net).
  const net = coins => coins.map((c, i) => {
    const cost = itemCost(m.items[i]);
    return c === null || cost === null ? null : c - cost;
  });
  // Each round's settings object; a snapshot from before they were kept has none.
  const dict = {...m.dict, settings: (m.dict.settings ?? []).map(parseSettings)};
  return {...m, dict, settings: m.settings ?? new Array(m.n).fill(null),
    at, netBaseCoins: net(m.baseCoins), netFinalCoins: net(m.finalCoins)};
}

/** A round's settings JSON as an object; anything but an object is none (tsum.go: settingsSQL). */
function parseSettings(s) {
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/** A setting's value as text (tsum.go: settingValueSQL); undefined for an object or array. */
function settingText(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  return undefined;
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

/** How the skillType list names the rounds without a skill type (queries.go: NoSkillType). */
export const NO_SKILL_TYPE = '-';

/**
 * The script settings the filters and the global site's cells go by, under
 * their query parameters (queries.go: PlaySettings): how many chains a board
 * scan may take, the longest chain, and how bubbles are spent.
 */
export const PLAY_SETTINGS = [
  {param: 'scan', key: 'maxChainsPerScan', number: true},
  {param: 'chain', key: 'maxChain', number: true},
  {param: 'bubble', key: 'bubbleStrategy', number: false},
];
const PLAY_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * A play setting's value in a settings object, as text (queries.go:
 * playSettingSQL): a number setting's whole value 0–999, an id setting's
 * value of letters, digits, `_`, `.` and `-`, at most 64; anything else, or
 * none, is '' (not recorded). The global site keeps it per round the same way.
 */
export function playValue(settings, ps) {
  const v = settings?.[ps.key];
  if (ps.number) return Number.isInteger(v) && v >= 0 && v <= 999 ? String(v) : '';
  return typeof v === 'string' && PLAY_ID.test(v) ? v : '';
}

/** The query parameters as the server reads them. */

export function parseFilter(q) {
  const f = {tsums: [], devices: [], skillTypes: [], play: {}, build: '', from: null, to: null, finalCoins: false, medals: false, net: false};
  f.tsums = String(q.tsum ?? '').split(',').map(t => t.trim()).filter(Boolean);
  f.devices = String(q.device ?? '').split(',').map(d => d.trim()).filter(Boolean);
  // NO_SKILL_TYPE (queries.go: NoSkillType) is the rounds sent without one.
  f.skillTypes = String(q.skillType ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => (s === NO_SKILL_TYPE ? '' : s));
  // Each play setting's values, NO_SKILL_TYPE ('-') for not recorded (queries.go: Filter.Play).
  f.play = Object.fromEntries(PLAY_SETTINGS.map(ps => [ps.param,
    String(q[ps.param] ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => (s === NO_SKILL_TYPE ? '' : s))]));
  if (q.build === 'global' || q.build === 'jp') f.build = q.build;
  f.from = q.from ? parseTime(q.from) : null;
  f.to = q.to ? parseTime(q.to) : null;
  for (const k of ['minCoins', 'maxCoins', 'minScore', 'maxScore', 'minMedals', 'maxMedals']) f[k] = intCell(q[k]);
  f.complete = q.incomplete !== '1';
  f.finalCoins = q.coins === 'final';
  f.medals = q.coins === 'medals';
  f.net = q.net === '1';
  return f;
}

/** The coin range's column: base or final coins, net when asked, even in Medals mode. */
const rangeCol = f => (f.net ? (f.finalCoins ? 'netFinalCoins' : 'netBaseCoins') : f.finalCoins ? 'finalCoins' : 'baseCoins');
/** The primary stat's column: what the figures and the rate use. */
const coinCol = f => (f.medals ? 'medals' : rangeCol(f));
/** v is within [lo, hi]; a null bound is open, a null v is outside a set one. */
const within = (v, lo, hi) => (lo === null || (v !== null && v >= lo)) && (hi === null || (v !== null && v <= hi));

// ---- The histogram's buckets (the global engine uses these too) ----

/** The histogram's step: 1, 2 or 5 times a power of ten (summary.go: niceStep). */
function niceStep(raw) {
  if (raw <= 1) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

/** The bucket width and the last bucket's start (summary.go: histBounds); null without coin figures. */
export function histBounds(totals) {
  if (totals.minCoins === null || totals.maxCoins === null) return null;
  const lo = totals.minCoins;
  let hi = totals.maxCoins;
  if (totals.q1Coins !== null && totals.q3Coins !== null) {
    hi = Math.min(hi, totals.q3Coins + Math.trunc((3 * (totals.q3Coins - totals.q1Coins)) / 2));
  }
  const width = niceStep((hi - lo) / 24);
  return {width, limit: (Math.floor(hi / width) + 1) * width};
}
/** v's bucket: its floored multiple of the width, with everything from the limit up in the last. */
export const bucketOf = (v, {width, limit}) => Math.min(Math.floor(v / width) * width, limit);

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
    const skillTypeSet = f.skillTypes.length ? new Set(f.skillTypes) : null;
    const playSets = PLAY_SETTINGS.filter(ps => f.play[ps.param]?.length).map(ps => [ps, new Set(f.play[ps.param])]);
    const out = [];
    for (const sh of await monthsFor(f)) {
      const deviceOk = deviceSet ? sh.dict.device.map(d => deviceSet.has(d)) : null;
      const tsumOk = tsumSet ? sh.dict.tsum.map(t => tsumSet.has(t)) : null;
      const buildOk = f.build ? sh.dict.build.map(b => b === f.build) : null;
      const skillTypeOk = skillTypeSet ? sh.dict.skillType.map(s => skillTypeSet.has(s)) : null;
      // Each play setting picked: whether each of the month's settings objects (and none, '') has a value it keeps.
      const playOk = playSets.map(([ps, set]) => [set.has(''), sh.dict.settings.map(o => set.has(playValue(o, ps)))]);
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
        if (skillTypeOk && !skillTypeOk[sh.skillType[i]]) continue;
        if (playOk.length && !playOk.every(([none, ok]) => (sh.settings[i] === null ? none : ok[sh.settings[i]]))) continue;
        // Complete (queries.go: completeSQL): a Tsum and every figure read; medals only for a medal Tsum.
        if (f.complete && (sh.dict.tsum[sh.tsum[i]] === '' || sh.score[i] === null || sh.baseCoins[i] === null
          || sh.finalCoins[i] === null || sh.duration[i] === null || (sh.medals[i] === null && medalTsum[sh.tsum[i]]))) continue;
        if (!within(coins[i], f.minCoins, f.maxCoins)) continue;
        if (!within(sh.score[i], f.minScore, f.maxScore)) continue;
        if (medalRange && medalTsum[sh.tsum[i]] && !within(sh.medals[i], f.minMedals, f.maxMedals)) continue;
        // Medal figures (queries.go: medalRoundsSQL): a medal Tsum's rounds with medals read, 0s included.
        if ((f.medals || onlyMedals) && !(sh.medals[i] !== null && medalTsum[sh.tsum[i]])) continue;
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
    medalsN: 0, medalsSum: 0, earned: 0, first: null, last: null,
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
    if (m !== null) { a.medalsN++; a.medalsSum += m; if (m > 0) a.earned++; }
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
    coinsPerSec: rate(a), totalMedals: a.medalsN ? a.medalsSum : null, earnedRounds: a.earned,
    first: a.first === null ? null : sqlTime(a.first), last: a.last === null ? null : sqlTime(a.last),
  });

  const tsumOf = (tsum, a) => ({
    tsum, rounds: a.rounds, avgScore: avg(a.scoreSum, a.scoreN), maxScore: a.scoreMax,
    avgCoins: avg(a.sum, a.n), minCoins: a.min, maxCoins: a.max,
    avgBaseCoins: avg(a.baseSum, a.baseN), avgFinalCoins: avg(a.finalSum, a.finalN),
    coins: a.n ? a.sum : null, totalSeconds: a.secsN ? a.secsSum : null, avgSeconds: avg(a.secsSum, a.secsN),
    coinsPerSec: rate(a), earnedRounds: a.earned,
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

  function histogram(sel, c, totals) {
    const h = {width: 0, cap: null, bins: []};
    const bounds = histBounds(totals);
    if (!bounds) return h;
    h.width = bounds.width;
    const limit = bounds.limit;
    if (totals.maxCoins >= limit) h.cap = limit;
    const bins = new Map();
    each(sel, (sh, i) => {
      const v = sh[c][i];
      if (v === null) return;
      const bucket = bucketOf(v, bounds);
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

  /** /api/stats/tsum: one Tsum's page (tsum.go: DescribeTsum). */
  async function tsum(q) {
    const id = String(q.id ?? '').trim();
    if (!id) throw new Error('tsum: id is required');
    const f = parseFilter({...q, tsum: id});
    const c = coinCol(f);
    const settings = new Map(), skillTypes = new Map(), versions = new Map(), devices = new Map(), field = new Map(), form = new Map();
    const into = (map, key, sh, i, extra) => {
      if (!map.has(key)) map.set(key, {a: acc(), ...extra});
      add(map.get(key).a, sh, i, c);
    };
    const sel = await select(f);
    // Rounds are in time order, so the position stands for the server's round_id tie-break.
    const total = sel.reduce((n, {idx}) => n + idx.length, 0);
    let pos = 0;
    each(sel, (sh, i) => {
      const back = total - pos++; // 1 for the newest round
      if (back <= 2 * FORM_ROUNDS) into(form, back <= FORM_ROUNDS ? 'recent' : 'before', sh, i, {key: back <= FORM_ROUNDS ? 'recent' : 'before'});
      const s = sh.settings[i] === null ? {} : sh.dict.settings[sh.settings[i]];
      for (const [setting, v] of Object.entries(s)) {
        const key = settingText(v);
        if (key !== undefined) into(settings, `${setting}\u0000${key}`, sh, i, {setting, key});
      }
      const skillType = sh.dict.skillType[sh.skillType[i]];
      into(skillTypes, skillType, sh, i, {key: skillType});
      const version = sh.dict.scriptVersion[sh.scriptVersion[i]];
      into(versions, version, sh, i, {key: version});
      const device = sh.dict.device[sh.device[i]];
      into(devices, device, sh, i, {key: device});
    });
    each(await select({...f, tsums: []}), (sh, i) => {
      const t = sh.dict.tsum[sh.tsum[i]];
      into(field, t, sh, i, {tsum: t});
    });

    // What boxes are paid with: final coins (net when asked) and medals, a missing medal figure as 0.
    const ef = {...f, tsums: [], medals: false, finalCoins: true};
    const ec = rangeCol(ef);
    const earn = {coins: 0, coinSecs: 0, medals: 0, medalSecs: 0};
    each(await select(ef), (sh, i) => {
      const d = sh.duration[i];
      if (d === null || !(d > 0)) return;
      if (sh[ec][i] !== null) { earn.coins += sh[ec][i]; earn.coinSecs += d; }
      earn.medals += sh.medals[i] ?? 0;
      earn.medalSecs += d;
    });

    const summed = await summary({...q, tsum: id});

    // Rounds under the target, of those with the primary stat.
    const goal = intCell(q.target);
    let target = null;
    if (goal !== null) {
      target = {target: goal, rounds: 0, under: 0};
      each(sel, (sh, i) => {
        const v = sh[c][i];
        if (v === null) return;
        target.rounds++;
        if (v < goal) target.under++;
      });
    }

    // The histogram's buckets split by skill level (tsum.go: SkillBins).
    const skillBins = new Map();
    const bounds = histBounds(summed.totals);
    if (bounds) {
      each(sel, (sh, i) => {
        const v = sh[c][i];
        const s = sh.settings[i] === null ? {} : sh.dict.settings[sh.settings[i]];
        if (v === null || !Object.hasOwn(s, 'skillLevel')) return;
        const skill = settingText(s.skillLevel);
        if (skill === undefined) return;
        const from = bucketOf(v, bounds);
        const key = `${skill}\u0000${from}`;
        if (skillBins.has(key)) skillBins.get(key).rounds++;
        else skillBins.set(key, {skill, from, rounds: 1});
      });
    }

    const group = ({a, key}) => ({
      key, rounds: a.rounds, avgCoins: avg(a.sum, a.n), maxCoins: a.max, coinsPerSec: rate(a),
      avgScore: avg(a.scoreSum, a.scoreN), first: sqlTime(a.first), last: sqlTime(a.last),
    });
    const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
    return {
      summary: summed,
      settings: [...settings.values()].sort((x, y) => cmp(x.setting, y.setting) || cmp(x.key, y.key))
        .map(g => ({setting: g.setting, ...group(g)})),
      skillTypes: [...skillTypes.values()].map(group).sort((x, y) => y.rounds - x.rounds || cmp(x.key, y.key)),
      versions: [...versions.values()].map(group).sort((x, y) => cmp(y.last, x.last) || cmp(x.key, y.key)),
      devices: [...devices.values()].map(group).sort((x, y) => y.rounds - x.rounds || cmp(x.key, y.key)),
      field: [...field.values()].sort((x, y) => cmp(x.tsum, y.tsum)).map(({a, tsum: t}) => ({
        tsum: t, rounds: a.rounds, rateCoins: a.rateN ? a.rateCoins : null, rateSeconds: a.rateN ? a.rateSecs : null, coinsPerSec: rate(a),
      })),
      form: [...form.values()].map(group).sort((x, y) => cmp(y.key, x.key)),
      skillBins: [...skillBins.values()].sort((x, y) => cmp(x.skill, y.skill) || x.from - y.from),
      earn: {coinsPerSec: earn.coinSecs ? earn.coins / earn.coinSecs : null, medalsPerSec: earn.medalSecs ? earn.medals / earn.medalSecs : null},
      target,
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

  /** queries.go: PlayedSkillTypes; an older snapshot lists none. */
  async function skillTypes() {
    return (await getManifest()).skillTypes ?? [];
  }

  /** queries.go: PlayedPlaySettings; an older snapshot lists none. */
  async function playSettings() {
    const ps = (await getManifest()).playSettings ?? {};
    return Object.fromEntries(PLAY_SETTINGS.map(({param}) => [param, ps[param] ?? []]));
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
        case 'tsum': return tsum(params);
        case 'tsums': return tsums();
        case 'round-devices': return roundDevices();
        case 'skill-types': return skillTypes();
        case 'play-settings': return playSettings();
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
