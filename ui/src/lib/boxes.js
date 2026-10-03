// Skill boxes left to max a Tsum. The catalog's `boxes` come from
// tools/stats-catalog.js: boxes[0] gets the Tsum, boxes[i] takes skill i to i+1.

// What one box costs: a medal Tsum's box takes medals, every other one coins.
export const BOX_PRICE = {coins: 30000, medals: 10000};

const sum = a => a.reduce((s, v) => s + v, 0);

/**
 * {boxes, cost, unit} still to spend on catalog Tsum t, given its Tsum List row
 * (null when not owned). Null when the catalog has no box counts for it.
 */
export function toMax(t, own) {
  const steps = t?.boxes;
  if (!steps?.length) return null;
  const unit = t.medal ? 'medals' : 'coins';
  let boxes;
  if (!own) {
    boxes = sum(steps);
  } else {
    const skill = own.skill ?? 1;
    if (skill >= steps.length || (own.skillMax && skill >= own.skillMax)) {
      boxes = 0;
    } else {
      // skillProgress is the percent through the current level; an older list has none.
      const next = steps[skill];
      const done = Math.min(next - 1, Math.round((next * (own.skillProgress ?? 0)) / 100));
      boxes = next - Math.max(0, done) + sum(steps.slice(skill + 1));
    }
  }
  return {boxes, cost: boxes * BOX_PRICE[unit], unit};
}

/** Totals per unit over entries ({left}), plus how many had no box counts. */
export function maxOutTotals(entries) {
  const t = {coins: {boxes: 0, cost: 0, tsums: 0}, medals: {boxes: 0, cost: 0, tsums: 0}, unknown: 0};
  for (const e of entries) {
    if (!e.left) { t.unknown++; continue; }
    if (!e.left.boxes) continue;
    const u = t[e.left.unit];
    u.boxes += e.left.boxes;
    u.cost += e.left.cost;
    u.tsums++;
  }
  return t;
}
