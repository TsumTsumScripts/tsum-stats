// Step 1c of the hourly job (CONTRACT §3.2): the skill level correction.
//
// Until the script's Auto Set Skill Level a round's skill level was typed in,
// so some runs of rounds are recorded at a wrong one. The rules that tell
// which are the page's own (ui/src/lib/skillFix.js, where the reasoning is);
// this step feeds them one Tsum at a time and keeps their verdicts in
// `skill_fix`, which a day's full recompute applies (rollup.ts: DAY_SOURCE).
//
// It never reads `rounds`. What it judges by is `skill_units`, the per-day
// sums the fold and the recompute keep, and D1 puts those together into runs
// (one device's consecutive days under one recorded level) before the Worker
// sees them, so its CPU goes on a few rows per run, not on days or rounds.
//
// A Tsum is corrected at most once a UTC day, however often its units change,
// and only the past days a fix newly covers, leaves, or has more rounds on
// are recomputed. So a day's new rounds are filed as recorded until the next
// day's pass, and a day is recomputed for the correction once, when it is over.
import { refile } from "../../ui/src/lib/skillFix.js";
import { dayOf } from "./days";
import type { Job } from "./job";

/** What one Tsum costs to read: its runs and its fixes, one batch. */
const READ_QUERIES = 2;
/** What the step's one batch of writes costs at most: per Tsum that changed, its fixes' delete and insert; the dirty days; the queue and the days corrected. */
const writeQueries = (changed: number) => 2 * changed + 3;
/** Rows a Tsum's pass is taken to read when it has not been read before. */
const FIRST_READS = 2000;

/**
 * One Tsum's skill_units as runs: per device, its rows in time order, a new
 * run wherever the recorded level changes; then one row per run and item
 * context, with the run's rounds per day.
 */
const RUNS = `WITH o AS (SELECT *, CASE WHEN skill IS lag(skill) OVER w THEN 0 ELSE 1 END AS brk FROM skill_units WHERE tsum = ?1
      WINDOW w AS (PARTITION BY build, device ORDER BY first, last, skill, context, trusted, day)),
    r AS (SELECT *, sum(brk) OVER (PARTITION BY build, device ORDER BY first, last, skill, context, trusted, day ROWS UNBOUNDED PRECEDING) AS run FROM o)
  SELECT build, device, run, skill, context, sum(n) AS n, sum(trusted * n) AS tn, sum(vn) AS vn, sum(vsum) AS vsum,
    min(first) AS first, max(last) AS last, json_group_array(json_array(day, n)) AS days
  FROM r GROUP BY build, device, run, skill, context ORDER BY build, device, run, context`;

const FIXES = "SELECT build, device, stated, from_day, to_day, level, rule, rounds, days, at FROM skill_fix WHERE tsum = ?1";

interface RunRow {
  build: number;
  device: string;
  run: number;
  skill: number;
  context: number;
  n: number;
  tn: number;
  vn: number;
  vsum: number;
  first: number;
  last: number;
  days: string;
}

/** A skill_fix row. */
export interface Fix {
  build: number;
  device: string;
  stated: number;
  from_day: string;
  to_day: string;
  level: number;
  rule: string;
  rounds: number;
  /** {day: rounds} as of the last pass that asked for the day's recompute, as JSON. */
  days: string;
  at: number;
}

/** A run as skillFix.js judges it, with its rounds per day. */
interface UnitRun {
  build: number;
  device: string;
  player: string;
  level: number;
  first: number;
  last: number;
  n: number;
  trusted: number;
  contexts: { context: number; n: number; mid: number }[];
  days: Map<string, number>;
}

/** The runs RUNS' rows make: a run's value in a context is its mean (skill_units keeps sums, not rounds). */
export function unitRuns(rows: RunRow[]): UnitRun[] {
  const runs = new Map<string, UnitRun>();
  for (const r of rows) {
    const key = `${r.build}|${r.device}|${r.run}`;
    let run = runs.get(key);
    if (!run) {
      run = { build: r.build, device: r.device, player: `${r.build}|${r.device}`, level: r.skill, first: r.first, last: r.last, n: 0, trusted: 0, contexts: [], days: new Map() };
      runs.set(key, run);
    }
    run.first = Math.min(run.first, r.first);
    run.last = Math.max(run.last, r.last);
    run.n += r.n;
    run.trusted += r.tn;
    if (r.vn > 0) run.contexts.push({ context: r.context, n: r.vn, mid: r.vsum / r.vn });
    for (const [day, n] of JSON.parse(r.days) as [string, number][]) run.days.set(day, (run.days.get(day) ?? 0) + n);
  }
  return [...runs.values()];
}

/**
 * The fixes one Tsum's runs make, given the ones it has (which keep a fix
 * through a little drift, skillFix.js: FIX.KEEP), and the past days to
 * recompute: those where what a fix moves is not what the last pass moved.
 * `today` is left out of both, as its rounds are still coming in.
 */
export function decide(runs: UnitRun[], old: Fix[], today: string, now: number): { fixes: Fix[]; dirty: string[] } {
  const span = (r: UnitRun) => {
    const days = [...r.days.keys()].sort();
    return [days[0], days[days.length - 1]];
  };
  const prev = runs.map(r => {
    const [from, to] = span(r);
    return old.find(f => f.build === r.build && f.device === r.device && f.stated === r.level && f.from_day <= to && f.to_day >= from)?.level ?? null;
  });
  const made = new Map<string, Fix & { perDay: Map<string, number> }>();
  const judge = refile as unknown as (runs: UnitRun[], prev: (number | null)[]) => { level: number; rule: string | null }[];
  judge(runs, prev).forEach((d, i) => {
    if (!d.rule) return;
    const r = runs[i];
    const [from, to] = span(r);
    const key = `${r.build}|${r.device}|${r.level}|${from}`;
    const had = made.get(key);
    // Two runs of one level beginning on one day (their units interleave) are one fix; the later run's level stands.
    const fix = had ?? { build: r.build, device: r.device, stated: r.level, from_day: from, to_day: to, level: d.level, rule: d.rule, rounds: 0, days: "", at: now, perDay: new Map() };
    fix.level = d.level;
    fix.rule = d.rule;
    if (to > fix.to_day) fix.to_day = to;
    fix.rounds += r.n;
    for (const [day, n] of r.days) if (day < today) fix.perDay.set(day, (fix.perDay.get(day) ?? 0) + n);
    made.set(key, fix);
  });

  // What each pass moves, per device, recorded level and day: [level, rounds].
  const moved = (list: { build: number; device: string; stated: number; level: number }[], days: (i: number) => Iterable<[string, number]>) => {
    const out = new Map<string, string>();
    list.forEach((f, i) => { for (const [day, n] of days(i)) out.set(`${f.build}|${f.device}|${f.stated}|${day}`, `${f.level}:${n}`); });
    return out;
  };
  const fixes = [...made.values()];
  const before = moved(old, i => Object.entries(JSON.parse(old[i].days) as Record<string, number>));
  const after = moved(fixes, i => fixes[i].perDay);
  const dirty = new Set<string>();
  for (const [k, v] of after) if (before.get(k) !== v) dirty.add(k.slice(k.lastIndexOf("|") + 1));
  for (const k of before.keys()) if (!after.has(k)) dirty.add(k.slice(k.lastIndexOf("|") + 1));
  dirty.delete(today);

  const byKey = new Map(old.map(f => [`${f.build}|${f.device}|${f.stated}|${f.from_day}`, f]));
  return {
    fixes: fixes.map(({ perDay, ...f }) => ({
      ...f,
      days: JSON.stringify(Object.fromEntries([...perDay].sort())),
      at: byKey.get(`${f.build}|${f.device}|${f.stated}|${f.from_day}`)?.at ?? now,
    })).sort((a, b) => a.build - b.build || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0) || a.stated - b.stated || (a.from_day < b.from_day ? -1 : 1)),
    dirty: [...dirty].sort(),
  };
}

const sameFixes = (a: Fix[], b: Fix[]) => {
  const text = (list: Fix[]) => JSON.stringify(list.map(f => [f.build, f.device, f.stated, f.from_day, f.to_day, f.level, f.rule, f.rounds, f.days]).sort());
  return text(a) === text(b);
};

const INSERT_FIXES = `INSERT INTO skill_fix (tsum, build, device, stated, from_day, to_day, level, rule, rounds, days, at)
  SELECT ?1, f->>0, f->>1, f->>2, f->>3, f->>4, f->>5, f->>6, f->>7, f->>8, f->>9 FROM (SELECT value AS f FROM json_each(?2)) WHERE true`;
/** The Tsums ?1 (",a,b,") leave the queue: corrected, until their units change again. */
const UNQUEUE = `UPDATE state SET value = (SELECT json_group_object(key, value) FROM json_each(state.value) WHERE instr(?1, ',' || key || ',') = 0)
  WHERE key = 'refile_queue'`;
/** The day each was corrected on, and the rows its pass read: {tsum: [day, rows]}. */
const CORRECTED = `INSERT INTO state (key, value) VALUES ('refiled', ?1) ON CONFLICT (key) DO UPDATE SET value = json_patch(value, excluded.value)`;

/**
 * Step 1c: the Tsums waiting in the queue that were not corrected today,
 * REFILE_TSUMS_PER_RUN of them at most, while the run's queries and the
 * day's budgets last. Everything it writes is one batch at its end.
 */
export async function refileStep(job: Job): Promise<void> {
  const { run, lim } = job;
  const today = dayOf(run.now);
  const due = job.refileQueue.filter(t => job.refiledOn[t]?.[0] !== today).sort();
  if (!due.length) return;
  const stmts: D1PreparedStatement[] = [];
  const done: Record<string, [string, number]> = {};
  const dirty = new Set<string>();
  let changed = 0, writes = 0;
  for (const tsum of due.slice(0, lim.refileTsums)) {
    // Room for this Tsum's read and for everything decided so far, its own included.
    const reads = Math.ceil((job.refiledOn[tsum]?.[1] ?? FIRST_READS) * 1.5) + 100;
    if (!run.room(READ_QUERIES + writeQueries(changed + 1)) || !run.canRead(reads)) break;
    const read0 = run.read;
    const [runs, fixes] = await run.batch([run.stmt(RUNS, tsum), run.stmt(FIXES, tsum)]);
    const old = fixes.results as unknown as Fix[];
    const next = decide(unitRuns(runs.results as unknown as RunRow[]), old, today, Math.floor(run.now));
    // A day whose rounds have left D1 keeps its tables as they are (rollup.ts: recomputeStep).
    const days = next.dirty.filter(d => !(job.droppedThrough && d <= job.droppedThrough) || job.restored.some(([r]) => r === d));
    const rewrite = !sameFixes(old, next.fixes);
    const rows = (rewrite ? old.length + next.fixes.length : 0) + days.length;
    // Work that can wait: past the day's budget this Tsum, and the ones after it, stay queued.
    if (!run.canWrite(writes + rows + 2)) break;
    writes += rows;
    if (rewrite) {
      changed++;
      stmts.push(run.stmt("DELETE FROM skill_fix WHERE tsum = ?1", tsum));
      // An empty list still needs its statement's room; it inserts nothing.
      stmts.push(run.stmt(INSERT_FIXES, tsum, JSON.stringify(next.fixes.map(f => [f.build, f.device, f.stated, f.from_day, f.to_day, f.level, f.rule, f.rounds, f.days, f.at]))));
    }
    for (const d of days) dirty.add(d);
    done[tsum] = [today, run.read - read0];
  }
  const tsums = Object.keys(done);
  if (tsums.length < due.length) job.more = true;
  if (!tsums.length) return;
  if (dirty.size) {
    stmts.push(run.stmt("INSERT OR IGNORE INTO dirty_days (day) SELECT value FROM json_each(?1)", JSON.stringify([...dirty].sort())));
    // Their recompute is the next run's (this one claimed its days already).
    job.more = true;
  }
  stmts.push(run.stmt(UNQUEUE, "," + tsums.join(",") + ","), run.stmt(CORRECTED, JSON.stringify(done)));
  await run.batch(stmts);
  job.report.refiled.push(...tsums);
}
