// The skill level correction: which rounds were most likely played at another
// skill level than the one recorded, and the level they count at instead (the
// effective level). The recorded level is never changed; this only answers
// "file it under which level".
//
// Why a recorded level can be wrong: until the script's Auto Set Skill Level
// (6.0a19) the level was a setting the player typed in, 3 unless changed, and
// it stays as it was through a preset, another Tsum or a level-up. So a wrong
// level comes as a run, one player's consecutive rounds of one Tsum under one
// recorded level, never as a lone round, and a run is what is judged here.
//
// One Tsum at a time, from every run of it (never a filtered subset, so a
// round's effective level does not move with the page's filters). Two rules,
// both of which leave a run alone unless the evidence is clear:
//
//   order    A player's level only goes up. Where their recorded levels go
//            down, the fewest rounds are re-filed that put them in order
//            (orderRule), and only a run whose coins match a run that kept
//            its level, at the level it moves to.
//   trusted  A run from before 6.0a19 whose coins match the same player's own
//            later trusted run (6.0a19 and on) at a higher level moves up to
//            that level, when trusted rounds show the two levels clearly
//            apart for this Tsum. So a level that barely changes a Tsum's
//            coins moves nothing, and a real level-up, which shows as a step
//            in the coins, stays.
//
// A run is never held to another player's coins: devices and script versions
// differ by more than a level's worth (a Tsum List confirmed level 4 on one
// device earned less than trusted level 3 rounds on another).
//
// It works on run summaries, not rounds, so the local server (its Go port,
// internal/stats/skillfix.go, held to this file by TestSkillFixParity) and the
// global Worker (global/src/refile.ts, from its per-day sums) share it.
// docs/INTERNALS.md § The skill level correction is the long form.

/** The thresholds. Every side reads them from here (Go: the same names in skillfix.go). */
export const FIX = {
  /** Rounds a run needs in one item context before its coins are compared. */
  MIN_ROUNDS: 20,
  /** |ln(a / b)| at or under this is the same performance (12 %). */
  SAME: 0.12,
  /** The same, for a run already re-filed to that level: a fix is not undone by a little drift. */
  KEEP: 0.2,
  /** ln(a / b) at or over this is two levels' references clearly apart (28 %). */
  GAP: 0.25,
  /** Trusted rounds a level's reference needs in an item context. */
  REF_ROUNDS: 50,
  /** A round's weight in the order rule: trusted, default level (3) before 6.0a19, any other. */
  W_TRUSTED: 6, W_DEFAULT: 1, W_PLAIN: 2,
  /** The level the script starts with. */
  DEFAULT_LEVEL: 3,
};

const VERSION = /^(\d+)\.(\d+)(?:\.\d+)*(?:([ab])(\d+)?)?/;

/**
 * True for a script version with Auto Set Skill Level: 6.0a19 and every later
 * alpha, beta and release. Anything unreadable is not trusted.
 */
export function trustedVersion(version) {
  const m = VERSION.exec(String(version ?? '').trim());
  if (!m) return false;
  const major = Number(m[1]), minor = Number(m[2]);
  if (major !== 6 || minor !== 0) return major > 6 || (major === 6 && minor > 0);
  if (m[3] === 'a') return Number(m[4] ?? 0) >= 19;
  return true;
}

/**
 * The item context a round's coins are compared within: its item set less the
 * items that do not change base coins or medals (+Coin, +Exp, +Score); -1
 * when the items are not known.
 */
export function fixContext(items) {
  return items === null || items === undefined || items < 0 ? -1 : items & ~(1 | 8 | 16);
}

/** The lower median of numbers (a real value, as the summaries' quartiles are). */
export function lowerMedian(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[(sorted.length - 1) >> 1];
}

/**
 * One Tsum's runs from its rounds, each {player, level, at, id, trusted,
 * context, value}: level an integer 1 and up or null (no level: left out),
 * at a sortable time, value the round's base coins (medals for a medal Tsum)
 * or null. A run is one player's consecutive rounds under one level; its
 * `rounds` are their indexes into the list given.
 */
export function runsOf(rounds) {
  const order = rounds.map((r, i) => i).filter(i => rounds[i].level !== null && rounds[i].level !== undefined)
    .sort((a, b) => cmp(rounds[a].player, rounds[b].player) || cmp(rounds[a].at, rounds[b].at) || cmp(rounds[a].id, rounds[b].id));
  const runs = [];
  let run = null, values = null;
  const close = () => {
    if (!run) return;
    run.contexts = [...values].sort((a, b) => a[0] - b[0]).map(([context, v]) => ({context, n: v.length, mid: lowerMedian(v)}));
  };
  for (const i of order) {
    const r = rounds[i];
    if (!run || run.player !== r.player || run.level !== r.level) {
      close();
      run = {player: r.player, level: r.level, first: r.at, last: r.at, n: 0, trusted: 0, rounds: [], contexts: []};
      values = new Map();
      runs.push(run);
    }
    run.rounds.push(i);
    run.n++;
    run.last = r.at;
    if (r.trusted) run.trusted++;
    if (r.value !== null && r.value !== undefined && r.value > 0) {
      if (!values.has(r.context)) values.set(r.context, []);
      values.get(r.context).push(r.value);
    }
  }
  close();
  return runs;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A run's weight in the order rule. */
function weight(run) {
  const rest = run.n - run.trusted;
  return run.trusted * FIX.W_TRUSTED + rest * (run.level === FIX.DEFAULT_LEVEL ? FIX.W_DEFAULT : FIX.W_PLAIN);
}

/** True when most of a run's rounds are from a trusted version. */
const isTrusted = run => run.trusted * 2 > run.n;

/** The rounds of a run's best-covered context, 0 with none. */
const judged = run => run.contexts.reduce((n, c) => Math.max(n, c.n), 0);

/**
 * Two runs' coins compared in the item context both have most rounds of
 * (FIX.MIN_ROUNDS each at least): {context, n, log} with log = ln(a / b), or
 * null when they share none.
 */
export function compare(a, b) {
  let best = null;
  for (const ca of a.contexts) {
    if (ca.n < FIX.MIN_ROUNDS || !(ca.mid > 0)) continue;
    const cb = b.contexts.find(c => c.context === ca.context);
    if (!cb || cb.n < FIX.MIN_ROUNDS || !(cb.mid > 0)) continue;
    const n = Math.min(ca.n, cb.n);
    if (!best || n > best.n) best = {context: ca.context, n, log: Math.log(ca.mid / cb.mid)};
  }
  return best;
}

/**
 * The order rule for one player's runs (in time order, each with FIX.MIN_ROUNDS
 * in some context): the levels, never going down, that cost least. Changing a
 * run's level costs its weight; two neighbouring runs with the same coins at
 * different levels cost the smaller one's weight. Returns each run's level and,
 * for one that changed, what keeping its recorded level would have cost over
 * the best (`margin`).
 */
function orderRule(runs) {
  const levels = [...new Set(runs.map(r => r.level))].sort((a, b) => a - b);
  const w = runs.map(weight);
  const same = runs.map((r, i) => {
    if (i === 0) return 0;
    const c = compare(r, runs[i - 1]);
    return c && Math.abs(c.log) <= FIX.SAME ? Math.min(w[i], w[i - 1]) : 0;
  });
  // solve(pin) is the least cost, and its levels, with run `pin` kept at its recorded level.
  const solve = pin => {
    let cost = levels.map(() => 0);
    const from = [];
    for (let i = 0; i < runs.length; i++) {
      const next = levels.map(() => Infinity), back = levels.map(() => 0);
      for (let l = 0; l < levels.length; l++) {
        const label = levels[l] === runs[i].level ? 0 : i === pin ? Infinity : w[i];
        if (i === 0) { next[l] = label; continue; }
        for (let k = 0; k <= l; k++) {
          const c = cost[k] + label + (k !== l ? same[i] : 0);
          if (c < next[l]) { next[l] = c; back[l] = k; }
        }
      }
      cost = next;
      from.push(back);
    }
    let l = 0;
    for (let k = 1; k < levels.length; k++) if (cost[k] < cost[l]) l = k;
    const total = cost[l], out = new Array(runs.length);
    for (let i = runs.length - 1; i >= 0; i--) { out[i] = levels[l]; l = from[i][l]; }
    return {total, levels: out};
  };
  const best = solve(-1);
  return runs.map((r, i) => (best.levels[i] === r.level ? {level: r.level}
    : {level: best.levels[i], margin: solve(i).total - best.total, weight: w[i]}));
}

/**
 * Each run's effective level for one Tsum. `runs` are runsOf's (or the same
 * shape made from sums: {player, level, first, last, n, trusted, contexts:
 * [{context, n, mid}]}), in any order. `prev`, optional, is the level each
 * run was re-filed to last time (same order as runs, null for none), which
 * keeps a fix through a little drift.
 *
 * Returns, per run in the order given: {level, rule, ...why}: rule null when
 * the recorded level stands, else 'order' or 'trusted' with
 *   against  {level, n, mid}: what the run's coins were held to
 *   context, n, mid: the run's own side of that comparison
 *   ratio    mid / against.mid
 *   confidence  'high' or 'medium'
 */
export function refile(runs, prev = null) {
  const out = runs.map(r => ({level: r.level, rule: null}));
  const kept = (i, target) => (prev && prev[i] === target ? FIX.KEEP : FIX.SAME);
  const why = (i, target, rule, c, against) => {
    const mine = runs[i].contexts.find(x => x.context === c.context);
    out[i] = {level: target, rule, context: c.context, n: mine.n, mid: mine.mid, against, ratio: Math.exp(c.log),
      confidence: Math.abs(c.log) <= FIX.SAME / 2 && c.n >= 2 * FIX.MIN_ROUNDS ? 'high' : 'medium'};
  };

  // Per player, in time order; only the runs with enough rounds to judge.
  const players = new Map();
  runs.forEach((r, i) => {
    if (judged(r) < FIX.MIN_ROUNDS) return;
    if (!players.has(r.player)) players.set(r.player, []);
    players.get(r.player).push(i);
  });
  for (const list of players.values()) list.sort((a, b) => cmp(runs[a].first, runs[b].first) || cmp(runs[a].last, runs[b].last) || a - b);

  // The order rule.
  for (const list of players.values()) {
    const mine = list.map(i => runs[i]);
    if (!mine.some((r, k) => k > 0 && r.level < mine[k - 1].level)) continue;
    const solved = orderRule(mine);
    solved.forEach((s, k) => {
      if (s.level === mine[k].level || s.margin < s.weight) return;
      // Its coins must match a run that kept its level, at the level it moves to: the nearest in time first.
      const near = list.map((_, j) => j).filter(j => j !== k && solved[j].level === s.level && mine[j].level === s.level)
        .sort((a, b) => Math.abs(a - k) - Math.abs(b - k) || a - b);
      for (const j of near) {
        const c = compare(mine[k], mine[j]);
        if (!c || Math.abs(c.log) > kept(list[k], s.level)) continue;
        const other = mine[j].contexts.find(x => x.context === c.context);
        why(list[k], s.level, 'order', c, {level: s.level, n: other.n, mid: other.mid});
        break;
      }
    });
  }

  // The trusted rule's references: per level and context, the trusted runs that kept their level.
  const refs = new Map();
  runs.forEach((r, i) => {
    if (!isTrusted(r) || out[i].rule) return;
    for (const c of r.contexts) {
      if (!(c.mid > 0)) continue;
      const key = `${r.level}|${c.context}`;
      const ref = refs.get(key) ?? {level: r.level, context: c.context, n: 0, sum: 0};
      ref.n += c.n;
      ref.sum += c.n * c.mid;
      refs.set(key, ref);
    }
  });
  const refList = [...refs.values()].filter(r => r.n >= FIX.REF_ROUNDS).map(r => ({...r, mid: r.sum / r.n}));
  if (!refList.length) return out;
  // True when, in a context, trusted rounds at `to` earn clearly more than trusted rounds at a level from `from` to just under it.
  const apart = (context, from, to) => {
    const top = refList.find(r => r.context === context && r.level === to);
    return !!top && refList.some(r => r.context === context && r.level >= from && r.level < to && Math.log(top.mid / r.mid) >= FIX.GAP);
  };

  // The trusted rule, each player's runs from the newest back, so a run moves after the ones it must stay under.
  for (const list of players.values()) {
    for (let k = list.length - 1; k >= 0; k--) {
      const i = list[k], run = runs[i];
      if (out[i].rule || isTrusted(run)) continue;
      for (let m = k + 1; m < list.length; m++) {
        const j = list[m], later = runs[j];
        if (!isTrusted(later) || out[j].rule || later.level <= run.level) continue;
        const c = compare(run, later);
        if (!c || Math.abs(c.log) > kept(i, later.level) || !apart(c.context, run.level, later.level)) continue;
        // The player's other runs must still be in order with it.
        if (list.some((x, n) => (n < k ? out[x].level > later.level : n > k ? out[x].level < later.level : false))) continue;
        const other = later.contexts.find(x => x.context === c.context);
        why(i, later.level, 'trusted', c, {level: later.level, n: other.n, mid: other.mid});
        break;
      }
    }
  }
  return out;
}

/**
 * Every round's effective level for one Tsum: refile over runsOf(rounds).
 * Returns {levels, fixes}: levels[i] the effective level of rounds[i] (its
 * own when it stands, null with none), fixes the runs that moved: {player,
 * from, to, rounds, first, last, rule, ...why}.
 */
export function refileRounds(rounds) {
  const runs = runsOf(rounds);
  const decided = refile(runs);
  const levels = rounds.map(r => r.level ?? null);
  const fixes = [];
  decided.forEach((d, k) => {
    if (!d.rule) return;
    const run = runs[k];
    for (const i of run.rounds) levels[i] = d.level;
    const {level, ...rest} = d;
    fixes.push({player: run.player, from: run.level, to: level, rounds: run.n, first: run.first, last: run.last, ...rest});
  });
  return {levels, fixes};
}
