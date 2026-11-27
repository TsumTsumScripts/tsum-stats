// Whether skill levels are shown as recorded, page-wide: by default a round
// counts at the level the skill level correction files it under
// (lib/skillFix.js, the server's skillfix.go); `recorded` turns that off, so
// the two can be compared. A per-browser preference, set from the note the
// page shows wherever rounds were re-filed (components/Refiled.svelte).
// Imports nothing.
const KEY = 'tsum-stats.levels';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) === 'recorded'; } catch { return false; }
}

export const levels = $state({recorded: load()});

export function setRecorded(on) {
  levels.recorded = Boolean(on);
  try { localStorage.setItem(KEY, JSON.stringify(on ? 'recorded' : '')); } catch { /* private mode: reset next visit */ }
}

/** The `levels` parameter every stats route takes (queries.go: Filter.AsRecorded). */
export const levelsParam = () => (levels.recorded ? 'recorded' : '');

/** A summary's re-filed rounds (summary.go: Refiled) added up: {rounds, byTsum: Map(tsum → rounds)}. */
export function refiledTotals(refiled) {
  const byTsum = new Map();
  let rounds = 0;
  for (const r of refiled ?? []) {
    rounds += r.rounds;
    byTsum.set(r.tsum, (byTsum.get(r.tsum) ?? 0) + r.rounds);
  }
  return {rounds, byTsum};
}

/**
 * What a by-skill-level row should say of the re-filed rounds in it, for one
 * Tsum's refiled list: the rounds that came from another recorded level (or,
 * as recorded, the ones the correction would move away). null when none.
 */
export function refiledInLevel(refiled, level) {
  const mine = (refiled ?? []).filter(r => (levels.recorded ? r.from : r.to) === String(level));
  if (!mine.length) return null;
  const n = mine.reduce((sum, r) => sum + r.rounds, 0);
  const others = [...new Set(mine.map(r => (levels.recorded ? r.to : r.from)))].sort().join(', ');
  return levels.recorded
    ? {rounds: n, text: `${n.toLocaleString()} would count as skill ${others}`, title: `The skill level correction counts ${n.toLocaleString()} of these rounds at skill ${others}: they are shown here as recorded`}
    : {rounds: n, text: `${n.toLocaleString()} recorded as skill ${others}`, title: `${n.toLocaleString()} of these rounds were recorded as skill ${others} and are counted here: the skill level correction`};
}
