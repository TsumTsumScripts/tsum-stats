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
