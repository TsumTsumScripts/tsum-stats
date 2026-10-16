// Step 1 of the hourly job: the day tables (cells2, cell_bins2, contrib_cells).
//
// New rounds are added in from `pending`, where each upload left the rounds
// it inserted, already added up as these tables keep them (ingest.ts:
// aggregate), so the job reads a few rows per upload, whatever the size of
// the day: no day is ever re-read for a few rounds more. A day is recomputed
// in full from its rounds only when something other than new rounds changed
// it (a ban, a changed round, a merge, a rebuild, a restore), since only new
// rounds can be added in: a minimum cannot be taken back.
//
// Both are SQL that writes only the rows that change, so the Worker never
// carries the rows. Each is one D1 batch: a run cut short leaves nothing half done.
import { knownList } from "./catalog";
import { DAY_ROUNDS, dayRange } from "./days";
import type { Job } from "./job";

/** What recomputing one day in full costs: three upserts, three deletes, its spans, its `recent` and its mark in `skip`. */
export const DAY_QUERIES = 9;
/** What adding the pending rounds in costs (foldStep's batch). */
export const FOLD_QUERIES = 8;
/** Pending rounds one run adds in at most. */
const FOLD_ROUNDS = 25_000;

/** A set of ids as one string for instr(). */
const idList = (ids: Iterable<number>) => "," + [...ids].join(",") + ",";

// The cells' columns as [name, aggregate over a day's rounds, how pending sums
// join it]. The first few are the key; the rest add up, or take the smaller
// or larger, when new rounds come.
const CELLS: [string, string, string][] = [
  ["build", "build", ""], ["tsum", "tsum", ""], ["skill", "skill", ""], ["skill_type", "skill_type", ""], ["items", "items", ""],
  ["scan", "scan", ""], ["chain", "chain", ""], ["bubble", "bubble", ""],
  ["medal", "coalesce(medals > 0, 0)", ""],
  ["rounds", "count(*)", "+"], ["secs", "sum(duration)", "+"],
  ["score_sum", "sum(score)", "+"], ["score_min", "min(score)", "min"], ["score_max", "max(score)", "max"],
  ["first", "min(played_at)", "min"], ["last", "max(played_at)", "max"],
  ["base_sum", "sum(base)", "+"], ["base_sq", "sum(base * base)", "+"], ["base_min", "min(base)", "min"], ["base_max", "max(base)", "max"],
  ["final_sum", "sum(final)", "+"], ["final_sq", "sum(final * final)", "+"], ["final_min", "min(final)", "min"], ["final_max", "max(final)", "max"],
  // Medals over the rounds that read them (medals not null); a medal = 1
  // cell is the rounds that earned any. Their min and max may be null.
  ["medals_n", "count(medals)", "+"], ["medals_sum", "coalesce(sum(medals), 0)", "+"], ["medals_sq", "coalesce(sum(medals * medals), 0)", "+"],
  ["medals_min", "min(medals)", "min"], ["medals_max", "max(medals)", "max"],
  ["medals_secs", "coalesce(sum(CASE WHEN medals IS NOT NULL THEN duration END), 0)", "+"],
];
const CELLS_KEY = 9;
const cellNames = CELLS.map(([c]) => c);

/** The rounds of day ?1-?2 (dayRange), as columns the aggregates read. */
const DAY_SOURCE = `(SELECT contributor, played_at, build, tsum, skill, skill_type, items, scan, chain, bubble, duration, score, base, final, medals,
    bin_base, bin_final, bin_medals, substr(key, 21) AS device FROM rounds WHERE ${DAY_ROUNDS})`;

/** A pending sum its day's last full recompute already read (state skip: {day: seq}); `day` names its day. */
const notSkipped = (day: string) => `p.seq > coalesce((SELECT value FROM state WHERE key = 'skip') ->> ('$."' || ${day} || '"'), 0)`;

/** The cell_bins2 columns: the key (the cells2'), then a bins object per figure. */
const BIN_KEY = ["build", "tsum", "skill", "skill_type", "items", "scan", "chain", "bubble", "medal"];
const BIN_KINDS = ["base", "final", "medals"];
/** A bin's figures (CONTRACT §5), in order: rounds, secs, score, base, final, medals. */
const FIGURES = 6;

/**
 * Merging two JSON bins objects: the new figures added to the old, bin by bin,
 * without reading the old object through. A bin new to the row is taken as it is.
 */
const mergeBins = (col: string) => `${col} = json_patch(${col}, (SELECT json_group_object(key, json(CASE WHEN o IS NULL THEN value
    ELSE json_array(${Array.from({ length: FIGURES }, (_, i) => `(o ->> ${i}) + (value ->> ${i})`).join(", ")}) END))
  FROM (SELECT key, value, cell_bins2.${col} -> ('$."' || key || '"') AS o FROM json_each(excluded.${col}))))`;

/** The cell_bins2 rows of `source` where `where`, for day `day` (an expression): per cell, each bin's figures. */
const binsSelect = (day: string, source: string, where: string) => {
  const of = (k: number, v: string, also = "") =>
    `SELECT build, tsum, skill, skill_type, items, scan, chain, bubble, coalesce(medals > 0, 0) AS medal, ${k} AS k, ${v} AS v, duration, score, base, final, medals
      FROM ${source} WHERE ${where}${also}`;
  const key = BIN_KEY.join(", ");
  return `SELECT ${day} AS day, ${key},
    json_group_object(b, json(f)) FILTER (WHERE k = 0) AS base,
    json_group_object(b, json(f)) FILTER (WHERE k = 1) AS final,
    json_group_object(b, json(f)) FILTER (WHERE k = 2) AS medals
  FROM (SELECT ${key}, k, CAST(v AS TEXT) AS b,
      json_array(count(*), sum(duration), sum(score), sum(base), sum(final), coalesce(sum(medals), 0)) AS f
    FROM (${of(0, "bin_base")} UNION ALL ${of(1, "bin_final")} UNION ALL ${of(2, "bin_medals", " AND bin_medals IS NOT NULL")})
    GROUP BY ${key}, k, v ORDER BY ${key}, k, v)
  WHERE true GROUP BY ${key}`;
};

/** The contrib_cells rows of `source` where `where`: one per device first, so the devices come out sorted and counted. */
const contribSelect = (day: string, source: string, where: string) => `SELECT day, contributor, build, tsum, sum(n) AS rounds,
    sum(secs) AS secs, sum(base_sum) AS base_sum, sum(final_sum) AS final_sum, sum(medals_sum) AS medals_sum,
    count(*) AS devices, json_group_array(device) AS device_set
  FROM (SELECT ${day} AS day, contributor, build, tsum, device, count(*) AS n, sum(duration) AS secs, sum(base) AS base_sum,
      sum(final) AS final_sum, coalesce(sum(medals), 0) AS medals_sum
    FROM ${source} WHERE ${where} GROUP BY day, contributor, build, tsum, device ORDER BY day, contributor, build, tsum, device)
  WHERE true GROUP BY day, contributor, build, tsum`;

const CONTRIB_COLS = ["day", "contributor", "build", "tsum", "rounds", "secs", "base_sum", "final_sum", "medals_sum", "devices", "device_set"];

// ---- Adding pending rounds in: the sums each upload made (ingest.ts:
// aggregate), up to seq ?1. ?2 is the hidden contributors (banned), ?3 those
// whose rounds are no one's (contrib_cells). ----

/** The pending rows of `col`, each as e (a JSON array), from the uploads ?1 takes, of contributors not in `ids`. */
const pendingOf = (col: string, ids: string) => `pending p, json_each(p.${col}) e
  WHERE p.seq <= ?1 AND instr(${ids}, ',' || p.contributor || ',') = 0 AND ${notSkipped("(e.value ->> 0)")}`;

const FOLD_CELLS = `INSERT INTO cells2 (day, ${cellNames.join(", ")})
  SELECT e.value ->> 0, ${CELLS.map(([, , how], i) => {
    const v = `e.value ->> ${i + 1}`;
    return i < CELLS_KEY ? v : how === "+" ? `sum(${v})` : `${how}(${v})`;
  }).join(", ")}
  FROM ${pendingOf("cells", "?2")}
  GROUP BY ${cellNames.slice(0, CELLS_KEY + 1).map((_, i) => `e.value ->> ${i}`).join(", ")}
  ON CONFLICT (day, ${cellNames.slice(0, CELLS_KEY).join(", ")}) DO UPDATE SET ${CELLS.slice(CELLS_KEY).map(([c, , how]) =>
    how === "+" ? `${c} = ${c} + excluded.${c}` : `${c} = coalesce(${how}(${c}, excluded.${c}), ${c}, excluded.${c})`).join(", ")}`;

// Each upload's cell_bins2 rows are merged straight into the day's, one after
// the other (an upsert takes its rows in turn), so no sort of their figures is needed.
const FOLD_BINS = `INSERT INTO cell_bins2 (day, ${BIN_KEY.join(", ")}, ${BIN_KINDS.join(", ")})
  SELECT ${Array.from({ length: 1 + BIN_KEY.length }, (_, i) => `e.value ->> ${i}`).join(", ")}, ${BIN_KINDS.map((_, i) => `e.value -> ${1 + BIN_KEY.length + i}`).join(", ")}
  FROM ${pendingOf("cell_bins", "?2")}
  ON CONFLICT (day, ${BIN_KEY.join(", ")}) DO UPDATE SET ${BIN_KINDS.map(mergeBins).join(", ")}`;

const deviceUnion = `SELECT value FROM json_each(contrib_cells.device_set) UNION SELECT value FROM json_each(excluded.device_set) ORDER BY 1`;
/** Devices new to the row: usually none after its first upload of the day, so the set is merged only then. */
const newDevices = "(SELECT count(*) FROM json_each(excluded.device_set) WHERE instr(contrib_cells.device_set, '\"' || value || '\"') = 0)";
const FOLD_CONTRIB = `INSERT INTO contrib_cells (${CONTRIB_COLS.join(", ")})
  SELECT day, contributor, build, tsum, sum(n), sum(secs), sum(base_sum), sum(final_sum), sum(medals_sum), count(*), json_group_array(device)
  FROM (SELECT e.value ->> 0 AS day, p.contributor, e.value ->> 1 AS build, e.value ->> 2 AS tsum, e.value ->> 3 AS device,
      sum(e.value ->> 4) AS n, sum(e.value ->> 5) AS secs, sum(e.value ->> 6) AS base_sum, sum(e.value ->> 7) AS final_sum, sum(e.value ->> 8) AS medals_sum
    FROM ${pendingOf("cc", "?3")}
    GROUP BY day, p.contributor, build, tsum, device ORDER BY day, p.contributor, build, tsum, device)
  WHERE true GROUP BY day, contributor, build, tsum
  ON CONFLICT (day, contributor, build, tsum) DO UPDATE SET rounds = rounds + excluded.rounds, secs = secs + excluded.secs,
    base_sum = base_sum + excluded.base_sum, final_sum = final_sum + excluded.final_sum, medals_sum = medals_sum + excluded.medals_sum,
    device_set = CASE WHEN ${newDevices} = 0 THEN device_set ELSE (SELECT json_group_array(value) FROM (${deviceUnion})) END,
    devices = devices + ${newDevices}`;

/** Contributors' first and last days (for /me), widened by the pending rounds' days. */
const FOLD_SPANS = `INSERT INTO state (key, value)
  SELECT * FROM (SELECT 'span:' || p.contributor, json_object('first', min(d.value), 'last', max(d.value))
    FROM pending p, json_each(p.days) d WHERE p.seq <= ?1 AND instr(?3, ',' || p.contributor || ',') = 0 GROUP BY p.contributor) WHERE true
  ON CONFLICT (key) DO UPDATE SET value = json_object('first', min(value ->> 'first', excluded.value ->> 'first'),
    'last', max(value ->> 'last', excluded.value ->> 'last'))
  WHERE value ->> 'first' > excluded.value ->> 'first' OR value ->> 'last' < excluded.value ->> 'last'`;

/** The newest day each named contributor sent each Tsum, from the uploads' own summaries (pending.tsums). */
const FOLD_RECENT = `INSERT INTO recent (contributor, tsum, day)
  SELECT p.contributor, t.key, max(t.value) FROM pending p, json_each(p.tsums) t WHERE p.seq <= ?1 AND instr(?3, ',' || p.contributor || ',') = 0
  GROUP BY p.contributor, t.key
  ON CONFLICT (contributor, tsum) DO UPDATE SET day = excluded.day WHERE excluded.day > day`;

/** The pending rounds' days, to publish again (state render). */
const FOLD_RENDER = `INSERT INTO state (key, value)
  SELECT 'render', json_group_array(day) FROM (SELECT value AS day FROM json_each(coalesce((SELECT value FROM state WHERE key = 'render'), '[]'))
    UNION SELECT d.value FROM pending p, json_each(p.days) d WHERE p.seq <= ?1 ORDER BY 1) WHERE true
  ON CONFLICT (key) DO UPDATE SET value = excluded.value`;

/** A day's mark in `skip` is done with once the pending rounds it covers are gone. */
const FOLD_SKIP = `UPDATE state SET value = (SELECT json_group_object(key, value) FROM json_each(state.value) WHERE value > ?1) WHERE key = 'skip'`;

/** A pending upload, as open() reads it: its contributor's status now, and whether a banned one has gone. */
export interface Pending {
  seq: number;
  contributor: number;
  n: number;
  days: string;
  status: string | null;
  gone: string | null;
}

/**
 * Step 1a: the pending rounds into the day tables, oldest upload first, up to
 * FOLD_ROUNDS a run. Who a round counts for is decided now, by its
 * contributor's status now: a banned contributor's rounds stay out of cells
 * and cell_bins; an unlinked one's are no one's in contrib_cells.
 */
export async function foldStep(job: Job): Promise<void> {
  const { run } = job;
  if (!job.pending.length) return;
  if (!run.room(FOLD_QUERIES)) {
    job.more = true;
    return;
  }
  let upto = 0, rounds = 0;
  const days = new Set<string>();
  const hidden = new Set<number>(), anon = new Set<number>([0]);
  for (const p of job.pending) {
    if (upto && rounds + p.n > FOLD_ROUNDS) break;
    upto = p.seq;
    rounds += p.n;
    for (const d of JSON.parse(p.days) as string[]) days.add(d);
    const banned = p.status === "banned" || p.status === "unlinking-banned" || (p.status === null && p.gone === "banned");
    if (banned) hidden.add(p.contributor);
    if (p.status === null || p.status === "unlinking" || p.status === "unlinking-banned") anon.add(p.contributor);
  }
  // About what it writes: a few rows of the day tables for every few rounds.
  // It cannot wait like the steps after it, but past the day's whole budget
  // the rounds stay pending until the next day.
  if (!run.canWrite(Math.ceil(rounds / 2) + 20, false)) {
    job.more = true;
    return;
  }
  if (upto < job.pending.at(-1)!.seq) job.more = true;
  const params = [upto, idList(hidden), idList(anon)];
  const res = await run.batch([
    run.stmt(FOLD_CELLS, ...params),
    run.stmt(FOLD_BINS, ...params),
    run.stmt(FOLD_CONTRIB, ...params),
    run.stmt(FOLD_SPANS, ...params),
    run.stmt(FOLD_RECENT, ...params),
    run.stmt(FOLD_RENDER, ...params),
    run.stmt(FOLD_SKIP, ...params),
    run.stmt("DELETE FROM pending WHERE seq <= ?1", ...params),
  ]);
  if (res[4].meta.rows_written > 0) job.recentChanged = true;
  for (const d of days) job.render.add(d);
  job.renderSaved = true;
  job.report.folded += rounds;
}

// ---- Recomputing a day in full. ?1-?2 its key range, ?3 the hidden
// contributors, ?4 the catalog's Tsums, ?5 the day, ?6 the no one's. ----

const FULL_PUBLIC = "instr(?3, ',' || contributor || ',') = 0 AND instr(?4, ',' || tsum || ',') > 0";
const FULL_NAMED = "contributor != 0 AND instr(?6, ',' || contributor || ',') = 0";

const FULL_CELLS = `INSERT INTO cells2 (day, ${cellNames.join(", ")})
  SELECT ?5, ${CELLS.map(([c, e]) => `${e} AS ${c}`).join(", ")} FROM ${DAY_SOURCE} WHERE ${FULL_PUBLIC}
  GROUP BY ${cellNames.slice(0, CELLS_KEY).join(", ")}
  ON CONFLICT (day, ${cellNames.slice(0, CELLS_KEY).join(", ")}) DO UPDATE SET ${cellNames.slice(CELLS_KEY).map(c => `${c} = excluded.${c}`).join(", ")}
  WHERE (${cellNames.slice(CELLS_KEY).join(", ")}) IS NOT (${cellNames.slice(CELLS_KEY).map(c => `excluded.${c}`).join(", ")})`;
const FULL_CELLS_GONE = `DELETE FROM cells2 WHERE day = ?5 AND (${cellNames.slice(0, CELLS_KEY).join(", ")}) NOT IN (
  SELECT ${CELLS.slice(0, CELLS_KEY).map(([, e]) => e).join(", ")} FROM ${DAY_SOURCE} WHERE ${FULL_PUBLIC})`;

/**
 * A bins object as a recompute writes it: in bin order (a merged one has its
 * newer bins last), and secs a REAL (an upload's JavaScript writes a whole
 * sum as an integer).
 */
const inOrder = (col: string) => `(SELECT json_group_object(key, json_array(value ->> 0, (value ->> 1) + 0.0, ${
  Array.from({ length: FIGURES - 2 }, (_, i) => `value ->> ${i + 2}`).join(", ")}))
  FROM (SELECT key, value FROM json_each(cell_bins2.${col}) ORDER BY CAST(key AS INTEGER)))`;
const FULL_BINS = `INSERT INTO cell_bins2 (day, ${BIN_KEY.join(", ")}, ${BIN_KINDS.join(", ")})
  ${binsSelect("?5", DAY_SOURCE, FULL_PUBLIC)}
  ON CONFLICT (day, ${BIN_KEY.join(", ")}) DO UPDATE SET ${BIN_KINDS.map(c => `${c} = excluded.${c}`).join(", ")}
  WHERE (${BIN_KINDS.map(inOrder).join(", ")}) IS NOT (${BIN_KINDS.map(c => `excluded.${c}`).join(", ")})`;
const FULL_BINS_GONE = `DELETE FROM cell_bins2 WHERE day = ?5 AND (${BIN_KEY.join(", ")}) NOT IN (
  SELECT ${CELLS.slice(0, CELLS_KEY).map(([, e]) => e).join(", ")} FROM ${DAY_SOURCE} WHERE ${FULL_PUBLIC})`;

const FULL_CONTRIB = `INSERT INTO contrib_cells (${CONTRIB_COLS.join(", ")})
  ${contribSelect("?5", DAY_SOURCE, FULL_NAMED)}
  ON CONFLICT (day, contributor, build, tsum) DO UPDATE SET ${CONTRIB_COLS.slice(4).map(c => `${c} = excluded.${c}`).join(", ")}
  WHERE (${CONTRIB_COLS.slice(4).join(", ")}) IS NOT (${CONTRIB_COLS.slice(4).map(c => `excluded.${c}`).join(", ")})`;
const FULL_CONTRIB_GONE = `DELETE FROM contrib_cells WHERE day = ?5 AND (contributor, build, tsum) NOT IN (
  SELECT contributor, build, tsum FROM ${DAY_SOURCE} WHERE ${FULL_NAMED})`;

/** Contributors' first and last contrib_cells days, widened by day ?5 (for /me). */
const FULL_SPANS = `INSERT INTO state (key, value)
  SELECT * FROM (SELECT 'span:' || contributor, json_object('first', ?5, 'last', ?5) FROM contrib_cells
    WHERE day = ?5 GROUP BY contributor) WHERE true
  ON CONFLICT (key) DO UPDATE SET value = json_object('first', min(value ->> 'first', excluded.value ->> 'first'),
    'last', max(value ->> 'last', excluded.value ->> 'last'))
  WHERE value ->> 'first' > excluded.value ->> 'first' OR value ->> 'last' < excluded.value ->> 'last'`;

/** The newest day each contributor sent each Tsum, widened by day ?5. */
const FULL_RECENT = `INSERT INTO recent (contributor, tsum, day)
  SELECT contributor, tsum, ?5 FROM contrib_cells WHERE day = ?5 GROUP BY contributor, tsum
  ON CONFLICT (contributor, tsum) DO UPDATE SET day = excluded.day WHERE excluded.day > day`;

/**
 * The pending rounds of day ?5 that this recompute read (every one stored by
 * now): later folds must not add them again (state skip).
 */
const FULL_SKIP = `INSERT INTO state (key, value) SELECT 'skip', json_object(?5, max(seq)) FROM pending WHERE true HAVING max(seq) IS NOT NULL
  ON CONFLICT (key) DO UPDATE SET value = json_set(value, '$."' || ?5 || '"', excluded.value ->> ('$."' || ?5 || '"'))`;

/** Reads a full recompute costs per round of its day, about (for the read budget). */
const FULL_READS_PER_ROUND = 18;

/**
 * Step 1b: the claimed days recomputed in full, oldest first, while the run's
 * queries and the day's read budget last. A day whose rounds have left D1
 * (and were not restored) keeps its tables as they are.
 */
export async function recomputeStep(job: Job): Promise<void> {
  const { run } = job;
  const todo = job.claimed.filter(d => !job.done.includes(d));
  if (!todo.length) return;
  if (!run.room(1 + DAY_QUERIES)) {
    job.more = true;
    return;
  }
  const others = await run.all<{ id: number; status: string }>("SELECT id, status FROM contributors WHERE status != 'active'");
  const hidden = idList(others.filter(c => c.status === "banned" || c.status === "unlinking-banned").map(c => c.id));
  const anon = idList(others.filter(c => c.status === "unlinking" || c.status === "unlinking-banned").map(c => c.id));
  const catalog = knownList();
  for (const day of todo) {
    if (job.droppedThrough && day <= job.droppedThrough && !job.restored.some(([d]) => d === day)) {
      job.done.push(day);
      continue;
    }
    const rounds = job.parts.get(day)?.rounds ?? 0;
    if (!run.room(DAY_QUERIES) || !run.canRead(rounds * FULL_READS_PER_ROUND) || !run.canWrite(Math.ceil(rounds / 4) + 50)) {
      job.more = true;
      return;
    }
    const { lo, hi } = dayRange(day);
    const p = [lo, hi, hidden, catalog, day, anon];
    const res = await run.batch([
      run.stmt(FULL_CELLS, ...p), run.stmt(FULL_CELLS_GONE, ...p),
      run.stmt(FULL_BINS, ...p), run.stmt(FULL_BINS_GONE, ...p),
      run.stmt(FULL_CONTRIB, ...p), run.stmt(FULL_CONTRIB_GONE, ...p),
      run.stmt(FULL_SPANS, ...p), run.stmt(FULL_RECENT, ...p), run.stmt(FULL_SKIP, ...p),
    ]);
    if (res[7].meta.rows_written > 0) job.recentChanged = true;
    job.done.push(day);
    job.render.add(day);
    job.report.recomputed.push(day);
  }
}
