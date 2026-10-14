// The published files (CONTRACT §4): part files, month compaction (step 5),
// the manifest (step 6), and the run's closing writes.
//
// A part is built by D1 in one statement and handed to R2 as the string D1
// returned. Its name carries its hash, so a host may cache it forever; a
// replaced part goes to the trash and is deleted once no manifest a viewer
// may still hold (max-age 300) can name it.
import { MEDAL_TSUMS } from "./catalog";
import { sha256Hex } from "./crypto";
import { DAY, addDays, dayOf, nextMonth } from "./days";
import { isoTime } from "./http";
import type { Job, Part } from "./job";
import { SPANS, type Rendered } from "./rollup";

export const DATA = "data/global/";
export const MANIFEST = DATA + "manifest.json";

/** A month is compacted into one part only while its JSON stays under this. */
const MONTH_MAX = 1_900_000;
/** How long a replaced part stays: past the manifest's max-age, and a reload. */
const TRASH_GRACE_MS = 15 * 60 * 1000;

// The part's columns, in the cells and bins tables' meanings, camelCased.
const camel = (c: string) => c.replace(/_([a-z])/g, (_, x: string) => x.toUpperCase());
const CELL_COLUMNS = [
  "day", "build", "tsum", "skill", "items", "medal", "rounds", "secs", "score_sum", "score_min", "score_max",
  "first", "last", "base_sum", "base_sq", "base_min", "base_max", "final_sum", "final_sq", "final_min", "final_max",
  "medals_n", "medals_sum", "medals_sq", "medals_min", "medals_max", "medals_secs",
];
const arrays = (cols: string[], json: string[] = []) =>
  cols.map(c => `'${camel(c)}', json_group_array(${json.includes(c) ? `json(${c})` : c})`).join(", ");

/**
 * One part, [?1, ?2): its file, its rounds, and its summary for the manifest
 * (rounds, first, last, rounds per Tsum, skills). The arrays of each table
 * come from one aggregate over one ordered subquery, so they line up.
 */
export const RENDER = `SELECT body, length(CAST(body AS BLOB)) AS bytes, rounds, summary FROM (
  SELECT json_object('kind', 'tsum-global-part', 'format', 1, 'from', ?1, 'to', ?2,
      'cells', json((SELECT json_object('n', count(*), ${arrays(CELL_COLUMNS)})
        FROM (SELECT * FROM cells WHERE day >= ?1 AND day < ?2 ORDER BY day, build, tsum, skill, items, medal))),
      'bins', json((SELECT json_object('n', count(*), ${arrays(["day", "build", "tsum", "skill", "base", "final", "medals"], ["base", "final", "medals"])})
        FROM (SELECT * FROM bins WHERE day >= ?1 AND day < ?2 ORDER BY day, build, tsum, skill)))) AS body,
    s.rounds AS rounds,
    json_object('from', ?1, 'to', ?2, 'rounds', s.rounds, 'first', s.first, 'last', s.last,
      'tsums', json((SELECT json_group_object(tsum, n) FROM (
        SELECT tsum, sum(rounds) AS n FROM cells WHERE day >= ?1 AND day < ?2 GROUP BY tsum))),
      'skills', json((SELECT json_group_array(skill) FROM (
        SELECT DISTINCT skill FROM cells WHERE day >= ?1 AND day < ?2 AND skill >= 0 ORDER BY skill)))) AS summary
  FROM (SELECT coalesce(sum(rounds), 0) AS rounds, min(first) AS first, max(last) AS last
    FROM cells WHERE day >= ?1 AND day < ?2) s)`;

/** Where a part's file is published: day-YYYY-MM-DD or month-YYYY-MM. */
export interface PartRange {
  from: string;
  to: string;
  name: string;
}

const isMonth = (p: Part) => p.file.startsWith("month-");

/** The part a day is published in: its compacted month's, else its own. */
export function partFor(job: Job, day: string): PartRange {
  const month = day.slice(0, 7);
  const m = job.parts.get(month + "-01");
  if (m && isMonth(m)) return { from: m.from, to: m.to, name: "month-" + month };
  return { from: day, to: addDays(day, 1), name: "day-" + day };
}

/**
 * Puts a rendered part in R2 under its hash and points the manifest at it;
 * a part with no rounds is taken out. An unchanged part is left alone.
 */
export async function publish(job: Job, range: PartRange, r: Rendered): Promise<void> {
  const cur = job.parts.get(range.from);
  if (r.rounds === 0) {
    if (cur) {
      throwAway(job, cur.file);
      job.parts.delete(range.from);
      job.pointers.set(range.from, null);
    }
    return;
  }
  const bytes = new TextEncoder().encode(r.body);
  const sha = (await sha256Hex(bytes)).slice(0, 8);
  const file = `${range.name}.${sha}.json`;
  if (cur?.file === file) return;
  await job.run.put(DATA + file, bytes);
  if (cur) throwAway(job, cur.file);
  job.parts.set(range.from, { from: range.from, to: range.to, file, sha, rounds: r.rounds });
  job.pointers.set(range.from, [r.summary, file, sha]);
  job.report.rendered.push(file);
}

function throwAway(job: Job, file: string): void {
  job.trash.push([DATA + file, job.run.nowMs]);
  job.trashChanged = true;
}

/**
 * Step 5: the oldest month whose days are all archived and still published
 * one by one becomes one part, when it fits. One a run.
 */
export async function compactStep(job: Job): Promise<void> {
  const { run } = job;
  const months = [...new Set([...job.parts.values()].filter(p => !isMonth(p)).map(p => p.from.slice(0, 7)))].sort();
  for (const month of months) {
    const from = month + "-01", to = nextMonth(month);
    if (!job.archivedThrough || job.archivedThrough < addDays(to, -1)) return;
    if (job.noCompact.has(month)) continue;
    if (job.claimed.some(d => d >= from && d < to && !job.done.includes(d))) continue;
    if (!run.room(2, 1)) {
      job.more = true;
      return;
    }
    const dirty = await run.first<{ n: number }>("SELECT count(*) AS n FROM dirty_days WHERE day >= ?1 AND day < ?2", from, to);
    if (dirty!.n > 0) continue;
    const r = (await run.first<Rendered>(RENDER, from, to))!;
    if (r.bytes >= MONTH_MAX) {
      job.noCompact.add(month);
      job.state.set("nocompact:" + month, String(r.bytes));
      continue;
    }
    for (const p of [...job.parts.values()]) {
      if (p.from >= from && p.from < to) {
        throwAway(job, p.file);
        job.parts.delete(p.from);
        job.pointers.set(p.from, null);
      }
    }
    await publish(job, { from, to, name: "month-" + month }, r);
    job.report.compacted.push(month);
    return;
  }
}

/**
 * The manifest (§4.1), from the part pointers: the totals are the parts'
 * summaries added up, so it never reads the cells themselves.
 */
const MANIFEST_SQL = `WITH p AS (SELECT value AS v FROM state WHERE key >= 'part:' AND key < 'part;'),
  recent AS (SELECT contributor, tsum FROM contrib_cells WHERE day >= ?2 AND contributor != 0
    AND contributor NOT IN (SELECT id FROM contributors WHERE status IN ('banned', 'unlinking-banned')))
  SELECT json_object('kind', 'tsum-global', 'format', 1, 'generatedAt', ?1,
    'rounds', (SELECT coalesce(sum(v ->> 'rounds'), 0) FROM p),
    'contributors', (SELECT count(DISTINCT contributor) FROM recent),
    'devices', (SELECT count(DISTINCT device_hash) FROM devices WHERE last_seen >= ?3),
    'first', (SELECT strftime('%Y-%m-%d %H:%M:%S', min(v ->> 'first'), 'unixepoch') FROM p),
    'last', (SELECT strftime('%Y-%m-%d %H:%M:%S', max(v ->> 'last'), 'unixepoch') FROM p),
    'parts', json((SELECT json_group_array(json_object('from', v ->> 'from', 'to', v ->> 'to', 'file', v ->> 'file',
      'rounds', v ->> 'rounds', 'sha', v ->> 'sha')) FROM (SELECT v FROM p ORDER BY v ->> 'from'))),
    'tsums', json((SELECT json_group_array(json_object('tsum', tsum, 'rounds', rounds, 'contributors', coalesce(n, 0))) FROM (
      SELECT t.tsum, t.rounds, k.n FROM (SELECT j.key AS tsum, sum(j.value) AS rounds FROM p, json_each(p.v, '$.tsums') j GROUP BY j.key) t
        LEFT JOIN (SELECT tsum, count(DISTINCT contributor) AS n FROM recent GROUP BY tsum) k ON k.tsum = t.tsum
      ORDER BY t.rounds DESC, t.tsum))),
    'medalTsums', json(?4),
    'skills', json((SELECT json_group_array(s) FROM (SELECT DISTINCT j.value AS s FROM p, json_each(p.v, '$.skills') j ORDER BY s))),
    'minContributors', CAST(?5 AS INTEGER)) AS body`;

/**
 * Step 6 and the run's end: writes what the steps changed, empties the
 * trash that has waited long enough, and renders the manifest when anything
 * changed or it is missing. Runs on the reserve the run held back for it.
 */
export async function finish(job: Job): Promise<void> {
  const { run } = job;
  const now = run.nowMs;

  // A part whose content came back is live again; never delete what a pointer names.
  const live = new Set([...job.parts.values()].map(p => DATA + p.file));
  const due = job.trash.filter(([key, at]) => at <= now - TRASH_GRACE_MS || live.has(key));
  if (due.length) {
    const gone = due.map(([key]) => key).filter(key => !live.has(key));
    if (gone.length) await run.del(gone);
    job.trash = job.trash.filter(t => !due.includes(t));
    job.trashChanged = true;
  }
  if (job.trashChanged) job.state.set("trash", JSON.stringify(job.trash));

  const writes = [...job.state].filter(([, v]) => v !== null);
  const deletes = [...job.state].filter(([, v]) => v === null).map(([k]) => k);
  const set = [...job.pointers].filter(([, v]) => v !== null).map(([from, v]) => [from, ...v!]);
  const unset = [...job.pointers].filter(([, v]) => v === null).map(([from]) => "part:" + from);
  const stmts: D1PreparedStatement[] = [];
  if (writes.length) {
    stmts.push(run.stmt("INSERT OR REPLACE INTO state (key, value) SELECT s->>0, s->>1 FROM (SELECT value AS s FROM json_each(?1))", JSON.stringify(writes)));
  }
  if (deletes.length || unset.length) {
    stmts.push(run.stmt("DELETE FROM state WHERE key IN (SELECT value FROM json_each(?1))", JSON.stringify([...deletes, ...unset])));
  }
  if (set.length) {
    stmts.push(run.stmt(`INSERT OR REPLACE INTO state (key, value)
      SELECT 'part:' || (p->>0), json_set(p->>1, '$.file', p->>2, '$.sha', p->>3) FROM (SELECT value AS p FROM json_each(?1))`, JSON.stringify(set)));
  }
  if (job.done.length) {
    stmts.push(
      run.stmt(`UPDATE state SET value = (SELECT json_group_array(value) FROM json_each(state.value)
        WHERE value NOT IN (SELECT value FROM json_each(?1))) WHERE key = 'recompute'`, JSON.stringify(job.done)),
      run.stmt(SPANS, JSON.stringify(job.done)),
    );
  }
  // Once a day, the counters that only matter on their own day.
  const today = dayOf(now / 1000);
  if (new Date(now).getUTCHours() === 0) {
    stmts.push(
      run.stmt("DELETE FROM budget WHERE day < ?1", addDays(today, -7)),
      run.stmt("DELETE FROM join_limits WHERE day < ?1", today),
    );
  }
  // Its counts of contributors and devices move with a recompute or an unlink
  // even when no part does.
  const r = job.report;
  const changed = set.length > 0 || unset.length > 0 || r.recomputed.length > 0 || r.unlinked.length > 0;
  const manifest = changed || !(await run.head(MANIFEST));
  if (manifest) {
    stmts.push(run.stmt(MANIFEST_SQL, isoTime(Math.floor(now / 1000)), addDays(today, -29),
      Math.floor(now / 1000) - 30 * DAY, JSON.stringify(MEDAL_TSUMS), job.lim.minContributors));
  }
  const res = await run.batch<{ body: string }>(stmts);
  if (manifest) {
    await run.put(MANIFEST, res[res.length - 1].results[0].body);
    job.report.manifest = true;
  }
}
