// The published files (CONTRACT §4): part files (step 2), month compaction
// (step 5), the manifest (step 6), and the run's closing writes.
//
// A part is built by D1 and handed to R2 as the string D1 returned. D1 first
// adds up how long the part will be, and builds it whole only when that fits
// in VALUE_MAX_BYTES (D1 refuses a value over 2,000,000 bytes); a bigger one
// is built as several files, each a share of the rows, which the manifest
// lists side by side for the same days. A file's name carries its hash, so a
// host may cache it forever; a replaced file goes to the trash and is deleted
// once no manifest a viewer may still hold (max-age 300) can name it.
import { MEDAL_TSUMS, catalogId, knownList } from "./catalog";
import { sha256Hex } from "./crypto";
import { DAY, addDays, dayOf, nextMonth } from "./days";
import { isoTime } from "./http";
import type { Job, Part, PartFile } from "./job";

export const DATA = "data/global/";
export const MANIFEST = DATA + "manifest.json";

/** How long a replaced part stays: past the manifest's max-age, and a reload. */
const TRASH_GRACE_MS = 15 * 60 * 1000;

// The part's columns, in the cells and cell_bins tables' meanings, camelCased.
const camel = (c: string) => c.replace(/_([a-z])/g, (_, x: string) => x.toUpperCase());
const CELL_COLUMNS = [
  "day", "build", "tsum", "skill", "items", "medal", "rounds", "secs", "score_sum", "score_min", "score_max",
  "first", "last", "base_sum", "base_sq", "base_min", "base_max", "final_sum", "final_sq", "final_min", "final_max",
  "medals_n", "medals_sum", "medals_sq", "medals_min", "medals_max", "medals_secs",
];
const BIN_COLUMNS = ["day", "build", "tsum", "skill", "items", "medal", "base", "final", "medals"];
const BIN_KEY_COLUMNS = 6;
const arrays = (cols: string[], json: string[] = []) =>
  cols.map(c => `'${camel(c)}', json_group_array(${json.includes(c) ? `json(${c})` : c})`).join(", ");

/**
 * A part's body from the cells rows `cells` and the cell_bins rows `bins`
 * (subqueries). Format 2: bins per cell, each bin with its rounds' figures.
 */
const body = (cells: string, bins: string) => `json_object('kind', 'tsum-global-part', 'format', 2, 'from', ?1, 'to', ?2,
    'cells', json((SELECT json_object('n', count(*), ${arrays(CELL_COLUMNS)}) FROM ${cells})),
    'bins', json((SELECT json_object('n', count(*), ${arrays(BIN_COLUMNS, ["base", "final", "medals"])}) FROM ${bins})))`;

const CELLS_OF = "(SELECT * FROM cells WHERE day >= ?1 AND day < ?2 ORDER BY day, build, tsum, skill, items, medal)";
const BINS_OF = "(SELECT * FROM cell_bins WHERE day >= ?1 AND day < ?2 ORDER BY day, build, tsum, skill, items, medal)";

/**
 * One part, [?1, ?2): about how long its file is (each row's values written
 * out, as the arrays hold them), its rows and rounds, its summary for the
 * manifest (rounds, first, last, rounds per Tsum and per skill level), and
 * its file, only when that is at most ?3 bytes long.
 */
export const RENDER = `WITH c AS (SELECT count(*) AS n, coalesce(sum(length(json_array(${CELL_COLUMNS.join(", ")}))), 0) AS est,
      coalesce(sum(rounds), 0) AS rounds, min(first) AS first, max(last) AS last FROM cells WHERE day >= ?1 AND day < ?2),
    b AS (SELECT count(*) AS n, coalesce(sum(length(json_array(${BIN_COLUMNS.slice(0, BIN_KEY_COLUMNS).join(", ")})) + length(base) + length(final) + length(medals)), 0) AS est
      FROM cell_bins WHERE day >= ?1 AND day < ?2),
    t AS MATERIALIZED (SELECT tsum, skill, sum(rounds) AS n FROM cells WHERE day >= ?1 AND day < ?2 GROUP BY tsum, skill)
  SELECT est, cells, bins, rounds, summary, CASE WHEN est <= ?3 THEN ${body(CELLS_OF, BINS_OF)} END AS body FROM (
    SELECT 600 + c.est + b.est AS est, c.n AS cells, b.n AS bins, c.rounds AS rounds,
      json_object('from', ?1, 'to', ?2, 'rounds', c.rounds, 'first', c.first, 'last', c.last,
        'tsums', json((SELECT json_group_object(tsum, n) FROM (SELECT tsum, sum(n) AS n FROM t GROUP BY tsum))),
        'skills', json((SELECT json_group_object(skill, n) FROM (SELECT skill, sum(n) AS n FROM t WHERE skill >= 0 GROUP BY skill)))) AS summary
    FROM c, b)`;

/** File ?3 of a part too long for one: the ?4 cells rows and ?5 bins rows from the ?3-th share on, and its rounds. */
const RENDER_SHARE = `SELECT ${body(
  "(SELECT * FROM (SELECT * FROM cells WHERE day >= ?1 AND day < ?2 ORDER BY day, build, tsum, skill, items, medal LIMIT ?4 OFFSET ?3 * ?4))",
  "(SELECT * FROM (SELECT * FROM cell_bins WHERE day >= ?1 AND day < ?2 ORDER BY day, build, tsum, skill, items, medal LIMIT ?5 OFFSET ?3 * ?5))",
)} AS body, (SELECT coalesce(sum(rounds), 0) FROM (SELECT rounds FROM cells WHERE day >= ?1 AND day < ?2
    ORDER BY day, build, tsum, skill, items, medal LIMIT ?4 OFFSET ?3 * ?4)) AS rounds`;

interface Rendered {
  est: number;
  cells: number;
  bins: number;
  rounds: number;
  summary: string;
  body: string | null;
}

/** Where a part's files are published: day-YYYY-MM-DD or month-YYYY-MM. */
export interface PartRange {
  from: string;
  to: string;
  name: string;
}

const isMonth = (p: Part) => p.files[0]?.file.startsWith("month-") ?? false;

/** The part a day is published in: its compacted month's, else its own. */
export function partFor(job: Job, day: string): PartRange {
  const month = day.slice(0, 7);
  const m = job.parts.get(month + "-01");
  if (m && isMonth(m)) return { from: m.from, to: m.to, name: "month-" + month };
  return { from: day, to: addDays(day, 1), name: "day-" + day };
}

/** One file's body and the rounds of its cells. */
interface Body {
  body: string;
  rounds: number;
}

/**
 * Builds a part's files: one, or as many shares as keep each well under
 * VALUE_MAX_BYTES. Null when the run has no room for them.
 */
async function build(job: Job, range: PartRange, r: Rendered): Promise<Body[] | null> {
  if (r.rounds === 0) return [];
  if (r.body !== null) return [{ body: r.body, rounds: r.rounds }];
  const { run, lim } = job;
  // Rows differ in length, so each share aims at half the limit.
  const n = Math.ceil(r.est / (lim.valueMax / 2));
  if (!run.room(n, n, r.est)) return null;
  const out: Body[] = [];
  const cells = Math.ceil(r.cells / n), bins = Math.ceil(r.bins / n);
  for (let i = 0; i < n; i++) out.push((await run.first<Body>(RENDER_SHARE, range.from, range.to, i, cells, bins))!);
  return out;
}

/**
 * Puts a part's files in R2 under their hashes and points the manifest at
 * them; a part with no rounds is taken out. An unchanged part is left alone.
 */
async function publish(job: Job, range: PartRange, summary: string, rounds: number, bodies: Body[]): Promise<void> {
  const cur = job.parts.get(range.from);
  if (rounds === 0) {
    if (cur) {
      for (const f of cur.files) throwAway(job, f.file);
      job.parts.delete(range.from);
      job.pointers.set(range.from, null);
    }
    return;
  }
  const files: PartFile[] = [];
  const data = new Map<string, Uint8Array>();
  for (const b of bodies) {
    const bytes = new TextEncoder().encode(b.body);
    const sha = (await sha256Hex(bytes)).slice(0, 8);
    const file = `${range.name}.${sha}.json`;
    files.push({ file, sha, rounds: b.rounds, bytes: bytes.byteLength });
    data.set(file, bytes);
  }
  const had = new Set(cur?.files.map(f => f.file) ?? []);
  if (cur && files.length === had.size && files.every(f => had.has(f.file))) return;
  for (const f of files) {
    if (had.has(f.file)) continue;
    await job.run.put(DATA + f.file, data.get(f.file)!);
    job.report.rendered.push(f.file);
  }
  const now = new Set(files.map(f => f.file));
  for (const f of cur?.files ?? []) if (!now.has(f.file)) throwAway(job, f.file);
  job.parts.set(range.from, { from: range.from, to: range.to, rounds, bytes: files.reduce((n, f) => n + f.bytes, 0), files });
  job.pointers.set(range.from, [summary, files]);
}

function throwAway(job: Job, file: string): void {
  job.trash.push([DATA + file, job.run.nowMs]);
  job.trashChanged = true;
}

/**
 * Step 2: publishes again the part of each day whose tables changed, oldest
 * first, while the run's queries, R2 operations and bytes last. A month part
 * is built once however many of its days changed.
 */
export async function renderStep(job: Job): Promise<void> {
  const { run } = job;
  const days = [...job.render].sort();
  for (const day of days) {
    if (job.rendered.has(day)) continue;
    const range = partFor(job, day);
    const cur = job.parts.get(range.from);
    if (!run.room(1, 1, cur?.bytes ?? 0)) {
      job.more = true;
      return;
    }
    const r = (await run.first<Rendered>(RENDER, range.from, range.to, job.lim.valueMax))!;
    const bodies = await build(job, range, r);
    if (!bodies) {
      job.more = true;
      return;
    }
    await publish(job, range, r.summary, r.rounds, bodies);
    for (const d of days) if (d >= range.from && d < range.to) job.rendered.add(d);
  }
}

/**
 * Step 5: the oldest month whose days are all archived and still published
 * one by one becomes one part, when its day parts' files add up to less than
 * VALUE_MAX_BYTES; a bigger month stays in day parts. One a run.
 */
export async function compactStep(job: Job): Promise<void> {
  const { run, lim } = job;
  const months = [...new Set([...job.parts.values()].filter(p => !isMonth(p)).map(p => p.from.slice(0, 7)))].sort();
  for (const month of months) {
    const from = month + "-01", to = nextMonth(month);
    if (!job.archivedThrough || job.archivedThrough < addDays(to, -1)) return;
    if (job.noCompact.has(month)) continue;
    if ([...job.render].some(d => d >= from && d < to && !job.rendered.has(d))) continue;
    const days = [...job.parts.values()].filter(p => p.from >= from && p.from < to);
    const bytes = days.reduce((n, p) => n + p.bytes, 0);
    const tooBig = (why: string) => {
      job.noCompact.add(month);
      job.state.set("nocompact:" + month, why);
    };
    if (bytes >= lim.valueMax) {
      tooBig(String(bytes));
      continue;
    }
    // A month's pointers are a few rows written: it waits when the day's budget is short.
    if (!run.room(2, 1, bytes) || !run.canWrite(days.length + 4)) {
      job.more = true;
      return;
    }
    try {
      const dirty = await run.first<{ n: number }>("SELECT count(*) AS n FROM dirty_days WHERE day >= ?1 AND day < ?2", from, to);
      if (dirty!.n > 0) continue;
      const r = (await run.first<Rendered>(RENDER, from, to, lim.valueMax))!;
      if (r.body === null) {
        tooBig(String(r.est));
        continue;
      }
      for (const p of days) {
        for (const f of p.files) throwAway(job, f.file);
        job.parts.delete(p.from);
        job.pointers.set(p.from, null);
      }
      await publish(job, { from, to, name: "month-" + month }, r.summary, r.rounds, [{ body: r.body, rounds: r.rounds }]);
      job.report.compacted.push(month);
    } catch (e) {
      // Whatever kept it from fitting, the month stays in day parts.
      console.error("compact", month, e);
      tooBig("error");
    }
    return;
  }
}

/**
 * The manifest (§4.1), from the part pointers, the rounds per Tsum and per
 * skill level kept up as they change (state totals), and its counts of
 * people (state people), so it reads neither the cells nor contrib_cells.
 */
const MANIFEST_SQL = `WITH p AS (SELECT value AS v FROM state WHERE key >= 'part:' AND key < 'part;'),
    t AS (SELECT json_object('rounds', coalesce(sum(v ->> 'rounds'), 0), 'first', min(v ->> 'first'), 'last', max(v ->> 'last')) AS s FROM p),
    totals AS (SELECT coalesce((SELECT value FROM state WHERE key = 'totals'), '{}') AS v),
    people AS (SELECT coalesce((SELECT value FROM state WHERE key = 'people'), '{}') AS v)
  SELECT json_object('kind', 'tsum-global', 'format', 1, 'generatedAt', ?1,
    'rounds', (SELECT s ->> 'rounds' FROM t),
    'contributors', coalesce((SELECT v ->> 'contributors' FROM people), 0),
    'devices', coalesce((SELECT v ->> 'devices' FROM people), 0),
    'first', (SELECT strftime('%Y-%m-%d %H:%M:%S', s ->> 'first', 'unixepoch') FROM t),
    'last', (SELECT strftime('%Y-%m-%d %H:%M:%S', s ->> 'last', 'unixepoch') FROM t),
    'parts', json((SELECT json_group_array(json_object('from', v ->> 'from', 'to', v ->> 'to', 'file', f ->> 'file',
      'rounds', f ->> 'rounds', 'sha', f ->> 'sha')) FROM (SELECT p.v, f.value AS f FROM p, json_each(p.v, '$.files') f ORDER BY p.v ->> 'from', f.key))),
    'tsums', json((SELECT json_group_array(json_object('tsum', key, 'rounds', value, 'contributors',
        coalesce((SELECT v FROM people) ->> ('$.tsums."' || key || '"'), 0)))
      FROM (SELECT key, value FROM json_each((SELECT v FROM totals), '$.tsums') ORDER BY value DESC, key))),
    'medalTsums', json(?2),
    'skills', json((SELECT json_group_array(CAST(key AS INTEGER)) FROM (SELECT key FROM json_each((SELECT v FROM totals), '$.skills') ORDER BY CAST(key AS INTEGER)))),
    'minContributors', CAST(?3 AS INTEGER)) AS body`;

/**
 * The manifest's counts of people, from `recent`: contributors (not 0, not
 * banned) with rounds of the catalog's Tsums ?3 since day ?1, per Tsum and
 * in all, and devices seen since ?2. Made again only when they can have
 * moved, or under another catalog (its id ?4, job.ts: open).
 */
const PEOPLE = `WITH r AS MATERIALIZED (SELECT contributor, tsum FROM recent WHERE day >= ?1 AND instr(?3, ',' || tsum || ',') > 0
    AND contributor NOT IN (SELECT id FROM contributors WHERE status IN ('banned', 'unlinking-banned')))
  INSERT OR REPLACE INTO state (key, value) SELECT 'people', json_object(
    'contributors', (SELECT count(DISTINCT contributor) FROM r),
    'devices', (SELECT count(DISTINCT device_hash) FROM devices WHERE last_seen >= ?2),
    'tsums', json((SELECT json_group_object(tsum, n) FROM (SELECT tsum, count(*) AS n FROM r GROUP BY tsum))),
    'catalog', ?4)`;

/** A running total over the parts, at `path` of each summary: the old total, less what parts ?1 had, plus what the summaries ?2 have. */
const moved = (path: string) => `json((SELECT json_group_object(k, n) FROM (
    SELECT k, sum(n) AS n FROM (
      SELECT key AS k, value AS n FROM json_each((SELECT value FROM state WHERE key = 'totals'), '${path}')
      UNION ALL SELECT j.key, -j.value FROM state o, json_each(o.value, '${path}') j WHERE o.key IN (SELECT 'part:' || value FROM json_each(?1))
      UNION ALL SELECT j.key, j.value FROM json_each(?2) s, json_each(s.value, '${path}') j)
    GROUP BY k HAVING sum(n) != 0 ORDER BY k)))`;
/** The same, made afresh from every pointer. */
const fresh = (path: string) => `json((SELECT json_group_object(k, n) FROM (
    SELECT j.key AS k, sum(j.value) AS n FROM state p, json_each(p.value, '${path}') j WHERE p.key >= 'part:' AND p.key < 'part;'
    GROUP BY j.key HAVING sum(j.value) != 0 ORDER BY j.key)))`;

/**
 * The rounds per Tsum and per skill level moved by the pointers this run
 * changes. It runs before the pointers are written, so it reads the old ones.
 */
const TOTALS_MOVE = `INSERT OR REPLACE INTO state (key, value)
  SELECT 'totals', json_object('tsums', ${moved("$.tsums")}, 'skills', ${moved("$.skills")})`;
/** The same over every part, afresh: with the day's first manifest, and whenever they are missing. */
const TOTALS_ALL = `INSERT OR REPLACE INTO state (key, value)
  SELECT 'totals', json_object('tsums', ${fresh("$.tsums")}, 'skills', ${fresh("$.skills")})`;

/**
 * Step 6 and the run's end: writes what the steps changed, empties the
 * trash that has waited long enough, and renders the manifest when a part
 * changed, an unlink finished, the day turned (its 30 days move), the one in
 * R2 is older than the pointers (its put failed), or it is missing. Runs on
 * the reserve the run held back for it.
 */
export async function finish(job: Job): Promise<void> {
  const { run } = job;
  const now = run.nowMs;
  const today = dayOf(now / 1000);

  // The manifest in R2, and when it was written. A replaced file is deleted
  // once that manifest, which no longer names it, has been out longer than a
  // viewer may keep the one before; never while a pointer names it again.
  const head = await run.head(MANIFEST);
  const manifestAt = Number(head?.customMetadata?.at ?? 0) || 0;
  const live = new Set([...job.parts.values()].flatMap(p => p.files.map(f => DATA + f.file)));
  const due = job.trash.filter(([key, at]) => live.has(key) || (head !== null && at <= manifestAt && manifestAt <= now - TRASH_GRACE_MS));
  if (due.length) {
    const gone = due.map(([key]) => key).filter(key => !live.has(key));
    if (gone.length) await run.del(gone);
    job.trash = job.trash.filter(t => !due.includes(t));
    job.trashChanged = true;
  }
  if (job.trashChanged) job.state.set("trash", JSON.stringify(job.trash));

  // The days still to publish, and the full recomputes that are done.
  const render = [...job.render].filter(d => !job.rendered.has(d)).sort();
  if (job.renderSaved || job.rendered.size || job.report.recomputed.length) job.state.set("render", render.length ? JSON.stringify(render) : null);

  // The claimed days not recomputed yet are claimed again by the next run.
  if (job.done.length) {
    const left = job.claimed.filter(d => !job.done.includes(d));
    job.state.set("recompute", JSON.stringify(left));
  }

  const set = [...job.pointers].filter(([, v]) => v !== null).map(([from, v]) => [from, v![0], v![1]] as const);
  const unset = [...job.pointers].filter(([, v]) => v === null).map(([from]) => from);
  const changed = set.length > 0 || unset.length > 0;
  if (changed) job.state.set("parts_at", String(now));
  // The first manifest of a day: its counts of people move with the day, and the totals are made afresh.
  const newDay = head === null || dayOf(manifestAt / 1000) !== today;
  // Who counts moves with recent, with an unlink and with the catalog; a ban or a merge drops them (admin.ts).
  const people = newDay || !job.hasPeople || job.recentChanged || job.report.unlinked.length > 0;

  const writes = [...job.state].filter(([, v]) => v !== null);
  const deletes = [...job.state].filter(([, v]) => v === null).map(([k]) => k);
  const stmts: D1PreparedStatement[] = [];
  if (changed && job.hasTotals && !newDay) {
    stmts.push(run.stmt(TOTALS_MOVE, JSON.stringify([...set.map(([from]) => from), ...unset]), JSON.stringify(set.map(([, s]) => JSON.parse(s)))));
  }
  if (writes.length) {
    stmts.push(run.stmt("INSERT OR REPLACE INTO state (key, value) SELECT s->>0, s->>1 FROM (SELECT value AS s FROM json_each(?1))", JSON.stringify(writes)));
  }
  if (deletes.length || unset.length) {
    stmts.push(run.stmt("DELETE FROM state WHERE key IN (SELECT value FROM json_each(?1))", JSON.stringify([...deletes, ...unset.map(f => "part:" + f)])));
  }
  if (set.length) {
    stmts.push(run.stmt(`INSERT OR REPLACE INTO state (key, value)
      SELECT 'part:' || (p->>0), json_set(p->>1, '$.files', json(p->>2), '$.bytes', p->>3) FROM (SELECT value AS p FROM json_each(?1))`,
    JSON.stringify(set.map(([from, s, files]) => [from, s, JSON.stringify(files), files.reduce((n, f) => n + f.bytes, 0)]))));
  }
  if ((changed && !job.hasTotals) || newDay) stmts.push(run.stmt(TOTALS_ALL));
  if (people) stmts.push(run.stmt(PEOPLE, addDays(today, -29), Math.floor(now / 1000) - 30 * DAY, knownList(), catalogId()));
  const manifest = changed || people || manifestAt < job.partsAt;
  if (manifest) stmts.push(run.stmt(MANIFEST_SQL, isoTime(Math.floor(now / 1000)), JSON.stringify(MEDAL_TSUMS), job.lim.minContributors));
  const res = await run.batch<{ body: string }>(stmts);
  if (manifest) {
    // Its time goes with it: a later run knows from it which trash is safe to delete.
    await run.put(MANIFEST, res[res.length - 1].results[0].body, { at: String(now) });
    job.report.manifest = true;
  }
}
