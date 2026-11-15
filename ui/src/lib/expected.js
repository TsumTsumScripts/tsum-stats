// Expected net coins (summary.go: Expected): what a round pays for its base
// coins on average. +Coin's bonus counts at its average (EXPECTED_BONUS), not
// at the multiplier the round happened to draw, and what the round's items
// cost comes off. So it is what a Tsum earns you, with the bonus's luck taken
// out: four or five times steadier than final coins, and the same figure on
// every page whatever the primary stat.
//
// Every group the API returns carries the sums behind it: expCoins,
// expSeconds, expRounds and expSq (its sum of squares).

import {EXPECTED_BONUS} from './snapshot/engine.js';
import {pct} from './util.js';

export {EXPECTED_BONUS};

/** Expected net coins per second of play; null without any. */
export const expRate = g => (g?.expSeconds ? g.expCoins / g.expSeconds : null);
/** Expected net coins per hour of play; null without any. */
export const expHour = g => (g?.expSeconds ? (g.expCoins / g.expSeconds) * 3600 : null);
/** Expected net coins a round; null without any. */
export const expAvg = g => (g?.expRounds ? g.expCoins / g.expRounds : null);

/** What the figure is, in one line, for notes and tooltips. */
export const EXP_WHAT = `base coins with +Coin's bonus at its ${pct(EXPECTED_BONUS)} average, less what the items cost`;

/** Groups' expected sums added up (a Tsum's item sets, every build's rows). */
export function sumExp(rows) {
  const out = {expCoins: 0, expSeconds: 0, expRounds: 0, expSq: 0};
  for (const r of rows) {
    if (!r.expRounds) continue;
    out.expCoins += r.expCoins;
    out.expSeconds += r.expSeconds;
    out.expRounds += r.expRounds;
    out.expSq = out.expSq === null || r.expSq === null ? null : out.expSq + r.expSq;
  }
  return out;
}

/**
 * The relative standard error of a group's expected figures: how far its
 * average (and, about, its rate) could be from the Tsum's true one by the luck
 * of which rounds were played, as a share of it. The rate's own error is
 * usually smaller, as longer rounds earn more, so this errs on the safe side.
 * Null with under 2 rounds, or when the sum of squares is unknown (a global
 * cell cut by an outlier range).
 */
export function expErr(g) {
  const n = g?.expRounds ?? 0;
  if (n < 2 || g.expSq === null || g.expSq === undefined || !g.expCoins) return null;
  const mean = g.expCoins / n;
  const variance = Math.max(0, g.expSq / n - mean * mean) * (n / (n - 1));
  return Math.sqrt(variance / n) / Math.abs(mean);
}

/** A share an error must stay under for its group's figure to be trusted (TRUST_ERR): ± 5 %. */
export const TRUST_ERR = 0.05;
/** Whether a group's expected figures are known well enough to rank or mark it: an error within TRUST_ERR. */
export const trusted = g => {
  const e = expErr(g);
  return e !== null && e <= TRUST_ERR;
};

/**
 * Whether two groups' expected rates differ by more than luck explains: by over
 * two standard errors of the difference (about 95 % sure). False when either
 * error is unknown.
 */
export function differs(a, b) {
  const ra = expRate(a), rb = expRate(b), ea = expErr(a), eb = expErr(b);
  if (ra === null || rb === null || ea === null || eb === null) return false;
  return Math.abs(ra - rb) > 2 * Math.hypot(ra * ea, rb * eb);
}

/** "± 3.1%" for a group's error, or '' when unknown. */
export const errText = g => {
  const e = expErr(g);
  return e === null ? '' : `± ${pct(e)}`;
};
