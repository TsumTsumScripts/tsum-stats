// What a skill level-up earns, from a summary's mix (summary.go: MixStat, by
// build × Tsum × skill level × item set, with expected coins' sums): for each
// Tsum and level, the change in expected net coins an hour from that level to
// the next, compared within each item set both levels were played with and
// weighted by the smaller side, so a level played with other items does not
// count for or against it. The Catalog runs it over everyone's rounds (the
// global site's), as one player's rarely cover two levels of one Tsum.

import {expErr, expRate} from './expected.js';

/**
 * Map tsum → Map(level → {gain, err, rounds}): gain in expected coins an hour
 * from that level to the one above, err its standard error (null when
 * unknown), rounds those compared at the level above.
 */
export function levelGains(mix) {
  // tsum → level → items → summed expected sums
  const by = new Map();
  for (const m of mix) {
    const level = Number(m.skill);
    if (!m.skill || !Number.isInteger(level) || m.items < 0 || !m.expRounds) continue;
    if (!by.has(m.tsum)) by.set(m.tsum, new Map());
    const levels = by.get(m.tsum);
    if (!levels.has(level)) levels.set(level, new Map());
    const sets = levels.get(level);
    const s = sets.get(m.items) ?? {expCoins: 0, expSeconds: 0, expRounds: 0, expSq: 0};
    s.expCoins += m.expCoins;
    s.expSeconds += m.expSeconds;
    s.expRounds += m.expRounds;
    s.expSq = s.expSq === null || m.expSq === null ? null : s.expSq + m.expSq;
    sets.set(m.items, s);
  }
  const out = new Map();
  for (const [tsum, levels] of by) {
    const gains = new Map();
    for (const [level, sets] of levels) {
      const up = levels.get(level + 1);
      if (!up) continue;
      let weight = 0, diff = 0, variance = 0, known = true, rounds = 0;
      for (const [items, lo] of sets) {
        const hi = up.get(items);
        if (!hi) continue;
        const r0 = expRate(lo), r1 = expRate(hi), e0 = expErr(lo), e1 = expErr(hi);
        if (r0 === null || r1 === null) continue;
        const w = Math.min(lo.expRounds, hi.expRounds);
        weight += w;
        diff += w * (r1 - r0);
        rounds += hi.expRounds;
        if (e0 === null || e1 === null) known = false;
        else variance += w * w * ((r1 * e1) ** 2 + (r0 * e0) ** 2);
      }
      if (weight) gains.set(level, {gain: (diff / weight) * 3600, err: known ? (Math.sqrt(variance) / weight) * 3600 : null, rounds});
    }
    if (gains.size) out.set(tsum, gains);
  }
  return out;
}
