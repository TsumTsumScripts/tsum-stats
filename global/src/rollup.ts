// Step 1 and 2 of the hourly job: recompute each claimed day's cells, bins
// and contrib_cells from its rounds, then render the part that holds it.
//
// A day is one key-range scan (days.ts: dayRange). The aggregates come back
// from D1 as three JSON strings that the Worker hands straight to the upserts
// without reading them, so its own CPU stays flat however big the day is.
import { DAY_ROUNDS, dayParams, dayRange } from "./days";
import type { Job } from "./job";
import { partFor, publish, RENDER } from "./parts";

/** What recomputing one day costs: the aggregate, then six writes and the render. */
export const DAY_QUERIES = 8;

// Each table's columns as [name, aggregate over the day's rounds r]. The
// first few are the key; the upserts read the JSON arrays in this order.
const CELLS: [string, string][] = [
  ["build", "build"], ["tsum", "tsum"], ["skill", "skill"], ["items", "items"], ["medal", "coalesce(medals > 0, 0)"],
  ["rounds", "count(*)"], ["secs", "sum(duration)"],
  ["score_sum", "sum(score)"], ["score_min", "min(score)"], ["score_max", "max(score)"],
  ["first", "min(played_at)"], ["last", "max(played_at)"],
  ["base_sum", "sum(base)"], ["base_sq", "sum(base * base)"], ["base_min", "min(base)"], ["base_max", "max(base)"],
  ["final_sum", "sum(final)"], ["final_sq", "sum(final * final)"], ["final_min", "min(final)"], ["final_max", "max(final)"],
  // Medals over the rounds that read them (medals not null); a medal = 1
  // cell is the rounds that earned any.
  ["medals_n", "count(medals)"], ["medals_sum", "coalesce(sum(medals), 0)"], ["medals_sq", "coalesce(sum(medals * medals), 0)"],
  ["medals_min", "min(medals)"], ["medals_max", "max(medals)"],
  ["medals_secs", "coalesce(sum(CASE WHEN medals IS NOT NULL THEN duration END), 0)"],
];
const CELLS_KEY = 5;

const CONTRIB: [string, string][] = [
  ["contributor", "contributor"], ["build", "build"], ["tsum", "tsum"],
  ["rounds", "count(*)"], ["secs", "sum(duration)"], ["base_sum", "sum(base)"], ["final_sum", "sum(final)"],
  ["medals_sum", "coalesce(sum(medals), 0)"], ["devices", "count(DISTINCT device)"],
];
const CONTRIB_KEY = 3;

const BINS = ["build", "tsum", "skill", "base", "final", "medals"];
const BINS_KEY = 3;

const names = (cols: [string, string][]) => cols.map(([c]) => c);
const grouped = (cols: [string, string][], key: number) =>
  `SELECT ${cols.map(([c, e]) => `${e} AS ${c}`).join(", ")} FROM r WHERE %WHERE% GROUP BY ${names(cols).slice(0, key).join(", ")}`;

/**
 * One day's aggregates as JSON arrays of rows. The day's rounds are read once
 * (r, materialised). cells and bins leave out banned contributors;
 * contrib_cells leaves out contributor 0 and the ones being unlinked, whose
 * rows were deleted at unlink.
 */
const AGGREGATE = `WITH r AS MATERIALIZED (
    SELECT contributor, played_at, build, tsum, skill, items, duration, score, base, final, medals,
      bin_base, bin_final, bin_medals, substr(key, 21) AS device,
      contributor IN (SELECT id FROM contributors WHERE status IN ('banned', 'unlinking-banned')) AS hidden,
      contributor = 0 OR contributor IN (SELECT id FROM contributors WHERE status IN ('unlinking', 'unlinking-banned')) AS anon
    FROM rounds WHERE ${DAY_ROUNDS})
  SELECT (SELECT count(*) FROM r) AS n,
    (SELECT json_group_array(json_array(${names(CELLS).join(", ")})) FROM (${grouped(CELLS, CELLS_KEY).replace("%WHERE%", "NOT hidden")})) AS cells,
    (SELECT json_group_array(json_array(build, tsum, skill, json(base), json(final), json(medals))) FROM (
      SELECT build, tsum, skill,
        json_group_object(b, n) FILTER (WHERE k = 0) AS base,
        json_group_object(b, n) FILTER (WHERE k = 1) AS final,
        json_group_object(b, n) FILTER (WHERE k = 2) AS medals
      FROM (SELECT build, tsum, skill, k, CAST(v AS TEXT) AS b, count(*) AS n FROM (
          SELECT build, tsum, skill, 0 AS k, bin_base AS v FROM r WHERE NOT hidden
          UNION ALL SELECT build, tsum, skill, 1, bin_final FROM r WHERE NOT hidden
          UNION ALL SELECT build, tsum, skill, 2, bin_medals FROM r WHERE NOT hidden AND bin_medals IS NOT NULL)
        GROUP BY build, tsum, skill, k, v ORDER BY build, tsum, skill, k, v)
      GROUP BY build, tsum, skill)) AS bins,
    (SELECT json_group_array(json_array(${names(CONTRIB).join(", ")})) FROM (${grouped(CONTRIB, CONTRIB_KEY).replace("%WHERE%", "NOT anon")})) AS cc`;

/**
 * The upsert of a table's rows for day ?1 from the JSON array ?2, writing only
 * rows that changed, and the delete of the day's rows the array no longer has.
 */
function sync(table: string, cols: string[], key: number): [string, string] {
  const at = cols.map((_, i) => `c->>${i}`);
  const vals = cols.slice(key);
  const rows = "FROM (SELECT value AS c FROM json_each(?2))";
  return [
    `INSERT INTO ${table} (day, ${cols.join(", ")}) SELECT ?1, ${at.join(", ")} ${rows} WHERE true
      ON CONFLICT (day, ${cols.slice(0, key).join(", ")}) DO UPDATE SET ${vals.map(v => `${v} = excluded.${v}`).join(", ")}
      WHERE (${vals.join(", ")}) IS NOT (${vals.map(v => `excluded.${v}`).join(", ")})`,
    `DELETE FROM ${table} WHERE day = ?1 AND (${cols.slice(0, key).join(", ")}) NOT IN (SELECT ${at.slice(0, key).join(", ")} ${rows})`,
  ];
}

const SYNC_CELLS = sync("cells", names(CELLS), CELLS_KEY);
const SYNC_BINS = sync("bins", BINS, BINS_KEY);
const SYNC_CONTRIB = sync("contrib_cells", names(CONTRIB), CONTRIB_KEY);

interface Aggregate {
  n: number;
  cells: string;
  bins: string;
  cc: string;
}

export interface Rendered {
  body: string;
  bytes: number;
  rounds: number;
  summary: string;
}

/** Steps 1 and 2: the claimed days, oldest first, while the budget lasts. */
export async function recomputeStep(job: Job): Promise<void> {
  const { run } = job;
  for (const day of job.claimed) {
    if (!run.room(DAY_QUERIES, 1)) {
      job.more = true;
      return;
    }
    const agg = (await run.first<Aggregate>(AGGREGATE, ...dayParams(dayRange(day))))!;
    // A day whose rounds are in the archive has none in D1: its cells stand.
    if (agg.n === 0 && job.archivedThrough && day <= job.archivedThrough) {
      job.done.push(day);
      continue;
    }
    const part = partFor(job, day);
    const res = await run.batch<Rendered>([
      run.stmt(SYNC_CELLS[0], day, agg.cells), run.stmt(SYNC_CELLS[1], day, agg.cells),
      run.stmt(SYNC_BINS[0], day, agg.bins), run.stmt(SYNC_BINS[1], day, agg.bins),
      run.stmt(SYNC_CONTRIB[0], day, agg.cc), run.stmt(SYNC_CONTRIB[1], day, agg.cc),
      run.stmt(RENDER, part.from, part.to),
    ]);
    await publish(job, part, res[6].results[0]);
    job.done.push(day);
    job.report.recomputed.push(day);
  }
}

/** Contributors' first and last contrib_cells days, widened by the days just recomputed (for /me). */
export const SPANS = `INSERT INTO state (key, value)
  SELECT * FROM (SELECT 'span:' || contributor, json_object('first', min(day), 'last', max(day)) FROM contrib_cells
    WHERE day IN (SELECT value FROM json_each(?1)) GROUP BY contributor) WHERE true
  ON CONFLICT (key) DO UPDATE SET value = json_object('first', min(value ->> 'first', excluded.value ->> 'first'),
    'last', max(value ->> 'last', excluded.value ->> 'last'))
  WHERE value ->> 'first' > excluded.value ->> 'first' OR value ->> 'last' < excluded.value ->> 'last'`;
