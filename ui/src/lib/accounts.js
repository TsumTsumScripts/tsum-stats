// Game accounts from Tsum Lists, and what a list says of a round's skill
// level: the evidence side of the skill level correction (lib/skillFix.js is
// the coin rules). Shared by the global Worker (global/src/lists.ts), which
// runs it over each contributor's lists, and held to the local server's Go
// port (internal/stats/accounts.go) by TestAccountsParity.
//
// A Tsum List names the device folder it came from, not the account, and one
// emulator can hold another account later. So lists are grouped by what they
// say: lists are one account's when, from one to the next, no Tsum's skill or
// level goes down and most Tsums are at the very same skill. On the
// developer's data same-account lists agree on 95 to 100 % of skills, and two
// accounts on one emulator on 8 %, with 34 of 37 common Tsums lower.
//
// A Tsum's level never goes down. So an account's list reading level N at
// time T means every round of that Tsum on that account before T was at N at
// most (a cap), and every round from T on at N at least (a floor). A round
// recorded outside counts at the nearest bound; inside, it stands.
// docs/INTERNALS.md § The skill level correction is the long form.

/** The grouping's thresholds (Go: the same names in accounts.go). */
export const ACCOUNT = {
  /** Tsums a list must share with an account before it can join it. */
  MIN_COMMON: 5,
  /** The share of those that must be at the very same skill level. */
  SAME_SHARE: 0.5,
  /** The share of them that may read lower than before (a misread digit) and still join. */
  MISREADS: 0.02,
};

/** True when list `l` ({skill, level}: tsum → number) can be the next list of an account whose highest readings so far are `a`. */
function joins(a, l) {
  let common = 0, down = 0, same = 0;
  for (const [t, s] of Object.entries(l.skill)) {
    if (!Object.hasOwn(a.skill, t)) continue;
    const was = a.skill[t];
    common++;
    if (s < was || (Object.hasOwn(l.level, t) && l.level[t] < (a.level[t] ?? 0))) down++;
    if (s === was) same++;
  }
  return common >= ACCOUNT.MIN_COMMON && down <= ACCOUNT.MISREADS * common && same >= ACCOUNT.SAME_SHARE * common;
}

/**
 * Lists into accounts. `lists` are oldest first: {id, build, at, skill:
 * {tsum: skill}, level: {tsum: level}} (a Tsum with no skill read left out of
 * both; `at` a sortable time). A list with no skill read is left out. Each
 * list joins the account, of its build, with the newest list that it can
 * follow, else starts one. Returns the accounts by build, then first list:
 * {build, lists: [the lists, oldest first]}.
 */
export function groupAccounts(lists) {
  let out = [];
  for (const l of lists) {
    if (!Object.keys(l.skill).length) continue;
    let into = null;
    for (let k = out.length - 1; k >= 0 && !into; k--) {
      if (out[k].build === l.build && joins(out[k], l)) {
        into = out[k];
        out = [...out.slice(0, k), ...out.slice(k + 1), into];
      }
    }
    if (!into) {
      into = {build: l.build, lists: [], skill: {}, level: {}};
      out.push(into);
    }
    into.lists.push(l);
    for (const [t, s] of Object.entries(l.skill)) into.skill[t] = Math.max(into.skill[t] ?? 0, s);
    for (const [t, s] of Object.entries(l.level)) into.level[t] = Math.max(into.level[t] ?? 0, s);
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return out.map((a, i) => ({a, i})).sort((x, y) => cmp(x.a.build, y.a.build) || cmp(x.a.lists[0].at, y.a.lists[0].at) || cmp(x.a.lists[0].id, y.a.lists[0].id) || x.i - y.i)
    .map(({a}) => ({build: a.build, lists: a.lists}));
}

/** An account's readings of each Tsum's skill, oldest first: {tsum: [[at, skill], ...]}. */
export function readingsOf(account) {
  const out = {};
  for (const l of account.lists) for (const [t, s] of Object.entries(l.skill)) (out[t] ??= []).push([l.at, s]);
  return out;
}

/**
 * What one Tsum's readings ([[at, skill]], oldest first) say of its level at
 * time `at`: {floor, cap}, at least the highest reading at or before it, at
 * most the lowest after it; 0 for none. Readings lower after than before (a
 * misread) say nothing: {floor: 0, cap: 0}.
 */
export function boundAt(readings, at) {
  let floor = 0, cap = 0;
  for (const [when, s] of readings) {
    if (when <= at) floor = Math.max(floor, s);
    else if (cap === 0 || s < cap) cap = s;
  }
  return cap > 0 && floor > cap ? {floor: 0, cap: 0} : {floor, cap};
}

/** A recorded level held within a bound; a level of 0 or less (none) stays. */
export function clamp(level, {floor, cap}) {
  if (level <= 0) return level;
  if (cap > 0 && level > cap) return cap;
  return level < floor ? floor : level;
}

/**
 * One Tsum's readings as the stretches of time they bound: [[from, floor,
 * cap], ...], each from its time (the first from `start`) until the next one's,
 * stretches with the same bound merged and those with none left out of the
 * ends. Empty when the readings bound nothing.
 */
export function segmentsOf(readings, start = 0) {
  const times = [start, ...new Set(readings.map(([at]) => at))];
  const out = [];
  for (const from of times) {
    const {floor, cap} = boundAt(readings, from);
    const last = out.at(-1);
    if (last && last[1] === floor && last[2] === cap) continue;
    out.push([from, floor, cap]);
  }
  return out.every(([, floor, cap]) => floor === 0 && cap === 0) ? [] : out;
}
