// The archive (CONTRACT §3.4): step 4 of the hourly job writes each final
// day's rounds to R2, one file per contributor (more for a big one), and a
// restore reads a day back. Step 4b drops archived days from D1, oldest
// first, only once D1 holds more than RETAIN_ROWS rounds: a delete is a row
// written, so a small deployment never pays for them.
//
// A day is read once: D1 turns it, a share at a time, into archive_parts,
// each contributor's columns as text, so no value it builds passes its limit
// however big the day. The files are then put together from those pieces, a
// few a run, as many as the run's bytes allow (the Worker's CPU goes on
// them), without reading the rounds again. A file is built by D1, so the
// Worker only carries the string. Every name is deterministic (c<id>, or an
// HMAC for unnamed rounds), so a run cut short simply writes the same files again.
import { BUDGET_CHECK, RECORD, refusedBy } from "./budget";
import { hmacHex, hmacKey } from "./crypto";
import { DAY, DAY_ROUNDS, addDays, dayOf, dayParams, dayRange, dayStart, hex48, keyDay } from "./days";
import type { Env } from "./env";
import { HttpError } from "./http";
import type { Job } from "./job";
import { FIELD_MAX } from "./records";
import { Run } from "./run";

export const ARCHIVE = "archive/";
export const archiveKey = (day: string, name: string) => `${ARCHIVE}${day.slice(0, 7)}/${day}/${name}`;

const hmac16 = async (env: Env, what: string) => (await hmacHex(await hmacKey(env.DEVICE_KEY), "archive:" + what)).slice(0, 16);

/**
 * An unlinked file's name: u + an HMAC of what it holds, so the name says
 * nothing about whose rounds they were and a re-run writes the same file.
 */
export async function unlinkedName(env: Env, what: string): Promise<string> {
  return "u" + (await hmac16(env, what)) + ".json";
}

/**
 * A file of a banned contributor that unlinked: b + an HMAC. Kept, since the
 * raw rounds are archived for good, but a restore never reads one back, so
 * those rounds never reach the public figures.
 */
export async function bannedName(env: Env, what: string): Promise<string> {
  return "b" + (await hmac16(env, what)) + ".json";
}

/** A contributor's own file of a day: c<id>.json, then c<id>.<k>.json for a day too big for one. */
export const namedFile = (id: number, chunk: number) => (chunk === 0 ? `c${id}.json` : `c${id}.${chunk}.json`);
/** The R2 prefix of every file namedFile gives for id. */
export const namedPrefix = (day: string, id: number) => archiveKey(day, `c${id}.`);

// The file's arrays, in the rounds table's columns: every field the round
// was sent with, so a restore loses nothing.
const COLUMNS: [string, string][] = [
  ["key", "key"], ["playedAt", "played_at"], ["build", "build"], ["tsum", "tsum"], ["skill", "skill"],
  ["skillType", "skill_type"], ["items", "items"], ["version", "version"], ["settings", "settings"],
  ["duration", "duration"], ["score", "score"], ["base", "base"], ["final", "final"], ["medals", "medals"],
];
/** Archive format 2 has skillType; a format 1 file has none, and its rounds come back with "". */
const OPTIONAL = new Set(["skillType"]);

/**
 * How long one round can be in a file, at most: a 48-character Tsum id,
 * every figure at its longest (174 characters), and a version and a skill
 * type of FIELD_MAX characters each with every one escaped (`"` or `\\`; a
 * control character rejects the record), quoted. A share of a day is sized
 * by it, so no piece passes the value limit.
 */
const ROUND_BYTES = 174 + 2 * (2 * FIELD_MAX + 3);

/**
 * Share ?5 of day ?3 into archive_parts: the ?4 rounds after the last key
 * already there (or after ?1, just before the day's first key), up to ?2, one
 * piece per contributor, each column's values as the text of a JSON array's
 * items, in key order. Its one lower bound is where the scan starts.
 */
const STAGE = `INSERT INTO archive_parts (day, contributor, part, n, bytes, last, ${COLUMNS.map(([, c]) => c).join(", ")})
  SELECT ?3, contributor, ?5, count(*),
    sum(length(json_array(${COLUMNS.map(([, c]) => c).join(", ")}))), max(key),
    ${COLUMNS.map(([, c]) => `group_concat(json_quote(${c}), ',')`).join(", ")}
  FROM (SELECT * FROM (SELECT * FROM rounds WHERE key > coalesce((SELECT max(last) FROM archive_parts WHERE day = ?3), ?1) AND key < ?2
      ORDER BY key LIMIT ?4) ORDER BY contributor, key)
  GROUP BY contributor`;

/** Who a file of contributor c is: c (named), u (no one's, unlinked) or b (a banned contributor's that left). */
const kindOf = (c: string) => `CASE WHEN ${c} = 0 THEN 'u'
    WHEN (SELECT status FROM contributors WHERE id = ${c}) IN ('active', 'banned') THEN 'c'
    WHEN (SELECT status FROM contributors WHERE id = ${c}) = 'unlinking-banned' OR (SELECT value FROM state WHERE key = 'gone:' || ${c}) = 'banned' THEN 'b'
    WHEN (SELECT value FROM state WHERE key = 'merged:' || ${c}) IS NOT NULL THEN 'c'
    ELSE 'u' END`;

/**
 * Files of day ?1 from its pieces: ?2 maps each piece wanted ("<contributor>:<part>")
 * to its file's place in the list. A file names its contributor only when
 * that one is still linked (or was merged into another, which a restore follows).
 */
const FILES = `SELECT i, n, ${kindOf("c")} AS kind,
    json_object('kind', 'tsum-global-archive', 'format', 2, 'day', ?1,
      'contributor', CASE WHEN ${kindOf("c")} = 'c' THEN c END, 'n', n, ${COLUMNS.map(([j, c]) => `'${j}', json('[' || ${c} || ']')`).join(", ")}) AS body
  FROM (SELECT ?2 ->> ('$."' || contributor || ':' || part || '"') AS i, contributor AS c, sum(n) AS n,
      ${COLUMNS.map(([, c]) => `group_concat(${c}, ',' ORDER BY part) AS ${c}`).join(", ")}
    FROM archive_parts WHERE day = ?1 AND (?2 ->> ('$."' || contributor || ':' || part || '"')) IS NOT NULL GROUP BY i, contributor)
  ORDER BY i`;

/** Settings rows after id ?1 into one file, up to about ?2 bytes (always at least one). */
const SETTINGS = `SELECT min(id) AS lo, max(id) AS hi, json_object('kind', 'tsum-global-settings', 'format', 1,
    'settings', json_group_array(json_object('id', id, 'hash', hash, 'json', json))) AS body
  FROM (SELECT * FROM (SELECT id, hash, json, sum(length(json) + length(hash) + 40) OVER (ORDER BY id) AS upto
    FROM (SELECT * FROM settings WHERE id > ?1 ORDER BY id LIMIT 5000)) WHERE upto <= ?2 OR id = (SELECT min(id) FROM settings WHERE id > ?1))`;

/** days.ts: bin, in SQL, for rounds read back from a file. */
const binSQL = (v: string) => `CASE WHEN ${v} < 100 THEN ${v} ELSE 100 + CAST(floor(ln(${v} / 100.0) / ln(1.02)) AS INTEGER) END`;

/**
 * A file's rounds back into D1 as contributor ?2. Each column becomes a table
 * of (position, value), joined on the position, so the Worker never parses
 * the file. (D1 allows only five terms in a compound SELECT, so not a UNION.)
 * A column an older format lacks (OPTIONAL) comes back as "". A round D1
 * already has is left alone.
 */
const RESTORE = `WITH ${COLUMNS.map(([j]) => `c_${j} AS MATERIALIZED (SELECT key AS i, value AS v FROM json_each(?1, '$.${j}'))`).join(",\n    ")}
  INSERT OR IGNORE INTO rounds (key, contributor, ${COLUMNS.slice(1).map(([, c]) => c).join(", ")}, bin_base, bin_final, bin_medals)
  SELECT key, ?2, ${COLUMNS.slice(1).map(([, c]) => c).join(", ")},
    ${binSQL("base")}, ${binSQL("final")}, CASE WHEN medals > 0 THEN ${binSQL("medals")} END
  FROM (SELECT ${COLUMNS.map(([j, c]) => (OPTIONAL.has(j) ? `coalesce(c_${j}.v, '') AS ${c}` : `c_${j}.v AS ${c}`)).join(", ")}
    FROM c_key ${COLUMNS.slice(1).map(([j]) => `${OPTIONAL.has(j) ? "LEFT JOIN" : "JOIN"} c_${j} ON c_${j}.i = c_key.i`).join(" ")})`;

/** A file to put together: [contributor, first part, after its last part, its number, its bytes]. */
type Plan = [number, number, number, number, number];

/**
 * An archive in progress: the day, its shares in archive_parts and whether
 * that is all of it, its files, how many are written, and whether the last
 * run had no bytes left for any of them.
 */
interface Progress {
  day: string;
  parts: number;
  staged: boolean;
  files: Plan[] | null;
  done: number;
  starved?: boolean;
}

/** Whether the archive in progress (state archive) wrote no file last run for want of the run's bytes. */
export const archiveStarved = (archive: string | null): boolean => archive !== null && JSON.parse(archive).starved === true;

const isFinal = (job: Job, day: string) => dayStart(day) + DAY + (job.lim.acceptDays + 1) * DAY <= job.run.now;

async function putWhole(run: Run, key: string, body: string): Promise<void> {
  const bytes = new TextEncoder().encode(body);
  const obj = await run.put(key, bytes);
  if (!obj || obj.size !== bytes.byteLength) throw new Error(`archive: ${key} was not stored whole`);
}

/** Where file k of contributor c goes, by who it is now (FILES: kind). */
async function fileKey(env: Env, day: string, c: number, k: number, kind: string): Promise<string> {
  if (kind === "b") return archiveKey(day, await bannedName(env, `${c}:${day}:${k}`));
  if (kind === "u") return archiveKey(day, await unlinkedName(env, `${c}:${day}:${k}`));
  return archiveKey(day, namedFile(c, k));
}

/** Reads putting a day into archive_parts costs per round, about (the scan, and sorting it by contributor). */
const ARCHIVE_READS_PER_ROUND = 2;
/** Shares one batch puts into archive_parts, at most. */
const STAGE_PER_BATCH = 8;

/**
 * Step 4: each day older than ACCEPT_DAYS + 1, in order, while the run's
 * budget, its bytes and the day's reads last. Its files are written, then it
 * counts as archived; its rounds stay in D1 until dropStep drops them.
 */
export async function archiveStep(job: Job): Promise<void> {
  const { run } = job;
  let progress: Progress | null = job.archive ? JSON.parse(job.archive) : null;
  for (;;) {
    let day = progress?.day ?? (job.archivedThrough ? addDays(job.archivedThrough, 1) : null);
    if (!day) {
      // Nothing archived yet: start at the oldest round's day.
      if (!run.room(1)) return;
      const oldest = await run.first<{ key: string }>("SELECT key FROM rounds ORDER BY key LIMIT 1");
      if (!oldest) return;
      day = keyDay(oldest.key);
    }
    if (!isFinal(job, day)) return;
    try {
      if (!(await archiveDay(job, day, progress))) {
        job.more = true;
        return;
      }
    } catch (e) {
      // Start the day over next run, from its rounds.
      console.error("archive", day, e);
      job.state.set("archive", null);
      job.more = true;
      return;
    }
    progress = null;
  }
}

/** Archives one day; false when the budget ran out first (its progress is kept). */
async function archiveDay(job: Job, day: string, progress: Progress | null): Promise<boolean> {
  const { run, lim } = job;
  const env = run.env;
  const p: Progress = progress?.day === day ? progress : { day, parts: 0, staged: false, files: null, done: 0 };
  // A run that writes none of the day's files, once they are planned, leaves the next one to go first.
  const had = p.files ? p.done : -1;
  const stop = () => {
    if (p.files) p.starved = p.done === had;
    job.state.set("archive", JSON.stringify(p));
    return false;
  };

  // The day into archive_parts, a share of at most `share` rounds a statement.
  const share = Math.max(1, Math.floor((lim.valueMax * 0.8) / ROUND_BYTES));
  while (!p.staged) {
    const fresh = progress?.day !== day && p.done === 0 && !p.files;
    // As many shares as the run has room for, up to STAGE_PER_BATCH. A share
    // writes a piece per contributor in it (about), which the end deletes again.
    const fits = (k: number) => run.room(k + (fresh ? 1 : 0)) && run.canRead(share * k * ARCHIVE_READS_PER_ROUND) && run.canWrite(k * 50);
    let k = STAGE_PER_BATCH;
    while (k > 0 && !fits(k)) k--;
    if (k === 0) return stop();
    // Just before the day's first key, so a bound of `key >` takes all of it.
    const before = hex48(dayStart(day) * 1000 - 1) + "f".repeat(20);
    const params = [before, dayRange(day).hi, day, share];
    // A day started afresh drops what an earlier, failed start left.
    const res = await run.batch([
      ...(fresh ? [run.stmt("DELETE FROM archive_parts WHERE day = ?1", day)] : []),
      ...Array.from({ length: k }, (_, i) => run.stmt(STAGE, ...params, p.parts + i)),
    ]);
    progress = p;
    const staged = res.slice(fresh ? 1 : 0);
    p.parts += staged.filter(r => r.meta.changes > 0).length;
    if (staged.at(-1)!.meta.changes === 0) p.staged = true;
  }

  if (!p.files) {
    if (!run.room(1)) return stop();
    const pieces = await run.all<{ c: number; part: number; n: number; bytes: number }>(
      "SELECT contributor AS c, part, n, bytes FROM archive_parts WHERE day = ?1 ORDER BY contributor, part", day);
    // Each contributor's pieces, in order, a file for as many as stay well under the value limit.
    const files: Plan[] = [];
    for (const x of pieces) {
      const f = files.at(-1);
      if (f && f[0] === x.c && f[4] + x.bytes <= lim.valueMax * 0.8) {
        f[2] = x.part + 1;
        f[4] += x.bytes;
      } else files.push([x.c, x.part, x.part + 1, f && f[0] === x.c ? f[3] + 1 : 0, x.bytes]);
    }
    p.files = files;
    p.done = 0;
    if (files.length && !(await archiveSettings(job))) return stop();
  } else if (p.done < p.files.length && !(await archiveSettings(job))) return stop();

  // The files, as many a run as its bytes and R2 operations allow.
  const files = p.files!;
  while (p.done < files.length) {
    const take: Plan[] = [];
    let bytes = 0;
    for (const f of files.slice(p.done)) {
      if (take.length && (bytes + f[4] > lim.runBytes - run.bytes || !run.room(1, take.length + 2))) break;
      take.push(f);
      bytes += f[4];
    }
    if (!run.room(1, take.length, bytes)) return stop();
    const wanted: Record<string, number> = {};
    take.forEach(([c, from, to], i) => {
      for (let part = from; part < to; part++) wanted[`${c}:${part}`] = i;
    });
    const got = await run.all<{ i: number; n: number; kind: string; body: string }>(FILES, day, JSON.stringify(wanted));
    if (got.length !== take.length || got.some((g, i) => g.i !== i)) throw new Error(`the pieces of ${day} changed`);
    for (const [i, f] of take.entries()) await putWhole(run, await fileKey(env, day, f[0], f[3], got[i].kind), got[i].body);
    p.done += take.length;
  }

  // Every file is written: the day is archived. Its rounds stay in D1 for now.
  if (!run.room(3) || !run.canWrite(files.length * 2 + 4)) return stop();
  const total = await run.first<{ n: number }>("SELECT coalesce(sum(n), 0) AS n FROM archive_parts WHERE day = ?1", day);
  const held: [string, number][] = [...job.held.filter(([d]) => d !== day), [day, total!.n]];
  await run.batch([
    run.stmt("DELETE FROM archive_parts WHERE day = ?1", day),
    run.stmt(`INSERT OR REPLACE INTO state (key, value) SELECT key, value FROM (
      SELECT 'archived_through' AS key, ?1 AS value UNION ALL SELECT 'held', ?2)`, day, JSON.stringify(held)),
    run.stmt("DELETE FROM state WHERE key = 'archive'"),
  ]);
  job.state.delete("archive");
  job.held = held;
  job.archivedThrough = day;
  job.archive = null;
  job.report.archived.push(day);
  return true;
}

/** The fewest bytes a settings file is worth writing for (always at least one row). */
const SETTINGS_MIN_BYTES = 50_000;

/** Every settings row into archive/settings/ before a round naming it is archived. */
async function archiveSettings(job: Job): Promise<boolean> {
  const { run } = job;
  if (job.settingsArchived) return true;
  if (!run.room(2, 1)) return false;
  const s = (await run.first<{ done: number; top: number }>(`SELECT
    coalesce((SELECT CAST(value AS INTEGER) FROM state WHERE key = 'settings_archived'), 0) AS done,
    coalesce((SELECT max(id) FROM settings), 0) AS top`))!;
  let done = s.done;
  while (done < s.top) {
    // As many rows as the run's bytes left allow, up to a share of the value
    // limit: a run whose part took most of its bytes still writes some.
    const cap = Math.floor(job.lim.valueMax * 0.8);
    const room = run.bytes === 0 ? cap : Math.min(cap, job.lim.runBytes - run.bytes);
    if (room < Math.min(SETTINGS_MIN_BYTES, cap) || !run.room(1, 1, room)) return false;
    const f = (await run.first<{ lo: number; hi: number; body: string }>(SETTINGS, done, room))!;
    await putWhole(run, `${ARCHIVE}settings/${f.lo}-${f.hi}.json`, f.body);
    done = f.hi;
    job.state.set("settings_archived", String(done));
  }
  job.settingsArchived = true;
  return true;
}

/**
 * About how many rounds D1 holds: the archived days not yet dropped, and the
 * public rounds of the days after them (their parts' counts).
 */
function heldRows(job: Job): number {
  const held = job.held.reduce((n, [, rounds]) => n + rounds, 0);
  let open = 0;
  for (const p of job.parts.values()) if (p.from > job.archivedThrough) open += p.rounds;
  return held + open;
}

/**
 * Step 4b: drops archived days from D1, oldest first, while D1 holds more
 * than RETAIN_ROWS rounds and the day's write budget has room to spare (each
 * deleted round is a row written). Their files are written already, and
 * every later change to them (an unlink, a merge) is carried to the files too.
 */
export async function dropStep(job: Job): Promise<void> {
  const { run } = job;
  while (job.held.length && heldRows(job) > job.lim.retain) {
    const [day, rounds] = job.held[0];
    if (!run.room(2) || !run.canWrite(rounds + 2) || !run.canRead(rounds)) {
      job.more = true;
      return;
    }
    const held = job.held.slice(1);
    await run.batch([
      run.stmt(`DELETE FROM rounds WHERE ${DAY_ROUNDS}`, ...dayParams(dayRange(day))),
      run.stmt(`INSERT OR REPLACE INTO state (key, value) SELECT key, value FROM (
        SELECT 'dropped_through' AS key, ?1 AS value UNION ALL SELECT 'held', ?2)`, day, JSON.stringify(held)),
    ]);
    job.held = held;
    job.droppedThrough = day;
    job.report.dropped.push(day);
  }
}

/**
 * A restored day's rounds leave D1 again once it is recomputed, within the
 * day's write budget. Its files are already in the archive, so nothing is written.
 */
export async function dropRestored(job: Job): Promise<void> {
  const { run } = job;
  for (const [day, rounds] of job.restored) {
    if (job.claimed.includes(day) && !job.done.includes(day)) continue;
    if (!run.room(2) || !run.canWrite(rounds + 1)) {
      job.more = true;
      return;
    }
    const params = dayParams(dayRange(day));
    const [gone] = await run.batch([
      run.stmt(`DELETE FROM rounds WHERE ${DAY_ROUNDS} AND NOT EXISTS (SELECT 1 FROM dirty_days WHERE day = ?3)`, ...params, day),
      run.stmt(`UPDATE state SET value = (SELECT json_group_array(json(value)) FROM json_each(state.value) WHERE value ->> 0 != ?3)
        WHERE key = 'restored' AND NOT EXISTS (SELECT 1 FROM rounds WHERE ${DAY_ROUNDS})`, ...params, day),
    ]);
    if (gone.meta.changes > 0) job.report.dropped.push(day);
  }
}

/**
 * POST /api/v1/admin/restore {day}: an archived day's files back into D1,
 * then the day is marked dirty so the next rollup recomputes it. A day with
 * many files takes several calls (each within the invocation's budget and
 * the day's write budget); `done` says when it is complete. A day whose
 * rounds are still in D1 needs no files: it is only marked dirty.
 */
export async function restore(env: Env, day: string, nowMs: number): Promise<Record<string, unknown>> {
  const run = new Run(env, nowMs);
  const key = "restore:" + day;
  const at = (await run.first<{ files: string | null; through: string | null; dropped: string | null }>(`SELECT
    (SELECT value FROM state WHERE key = ?1) AS files, (SELECT value FROM state WHERE key = 'archived_through') AS through,
    (SELECT value FROM state WHERE key = 'dropped_through') AS dropped`, key))!;
  // A day still in D1 is not in the archive yet, or not all of it.
  if (!at.through || day > at.through) throw new HttpError(400, "bad-request");
  try {
    if (!at.dropped || day > at.dropped) {
      await run.batch([run.stmt("INSERT OR IGNORE INTO dirty_days (day) VALUES (?1)", day)]);
      return { day, done: true, files: 0, left: 0, rounds: 0 };
    }
    return await restoreFiles(run, day, key, at.files);
  } finally {
    // Whatever happened, what D1 did for it is counted.
    await run.batch([run.stmt(RECORD, dayOf(nowMs / 1000), run.written + 1, run.read)]).catch(e => console.error("restore budget", e));
  }
}

async function restoreFiles(run: Run, day: string, key: string, saved: string | null): Promise<Record<string, unknown>> {
  const listing = async () => {
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await run.list({ prefix: archiveKey(day, ""), cursor });
      found.push(...page.objects.map(o => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return found.sort();
  };
  let files: string[] = saved ? JSON.parse(saved) : await listing();

  const owner = await owners(run);
  const today = dayOf(run.now);
  const cap = run.lim.budget - Math.floor(run.lim.reserve / 5);
  let read = 0, rounds = 0, relisted = false;
  // Each file is a get and an insert; four statements are kept for the end.
  while (files.length && run.room(2 + 4, 1)) {
    const to = owner(files[0]);
    if (to !== null) {
      const obj = await run.get(files[0]);
      if (!obj) {
        // Renamed since the listing (an unlink): list again. A file read
        // twice adds nothing, since D1 keeps the rounds it already has.
        if (relisted || !run.room(2 + 4, 2)) break;
        files = await listing();
        relisted = true;
        continue;
      }
      const text = await obj.text();
      // Its rounds are rows written: stop, keeping the rest for later, when today has no room for them.
      const n = Number(/"n":(\d+)/.exec(text.slice(0, 400))?.[1] ?? 0);
      try {
        const [, res] = await run.batch([run.stmt(BUDGET_CHECK, today, run.written + n + 4, cap), run.stmt(RESTORE, text, to)]);
        rounds += res.meta.changes;
      } catch (e) {
        if (refusedBy(e) !== "budget") throw e;
        break;
      }
    }
    files.shift();
    read++;
  }
  if (files.length) {
    await run.batch([run.stmt("INSERT OR REPLACE INTO state (key, value) VALUES (?1, ?2)", key, JSON.stringify(files))]);
    return { day, done: false, files: read, left: files.length, rounds };
  }
  await run.batch([
    run.stmt("INSERT OR IGNORE INTO dirty_days (day) VALUES (?1)", day),
    run.stmt("DELETE FROM state WHERE key = ?1", key),
    run.stmt(`INSERT INTO state (key, value) VALUES ('restored', json_array(json_array(?1, ?2)))
      ON CONFLICT (key) DO UPDATE SET value = json_insert(value, '$[#]', json_array(?1, ?2))
      WHERE NOT EXISTS (SELECT 1 FROM json_each(state.value) WHERE value ->> 0 = ?1)`, day, rounds),
  ]);
  return { day, done: true, files: read, left: 0, rounds };
}

/**
 * Who a file's rounds belong to now: its contributor, or the one it was
 * merged into; contributor 0 once unlinked (or for a u file). Null (left out)
 * for a b file, and for a banned contributor that unlinked or is unlinking
 * (state gone:<id>), even through a merge: those rounds never come back.
 */
async function owners(run: Run): Promise<(file: string) => number | null> {
  const [statuses, merges, gone] = await run.batch<{ id: number; status: string; value: string }>([
    run.stmt("SELECT id, status FROM contributors"),
    run.stmt("SELECT CAST(substr(key, 8) AS INTEGER) AS id, value FROM state WHERE key >= 'merged:' AND key < 'merged;'"),
    run.stmt("SELECT CAST(substr(key, 6) AS INTEGER) AS id, value FROM state WHERE key >= 'gone:' AND key < 'gone;'"),
  ]);
  const status = new Map(statuses.results.map(r => [r.id, r.status]));
  const merged = new Map(merges.results.map(r => [r.id, Number(r.value)]));
  const banned = new Set(gone.results.filter(r => r.value === "banned").map(r => r.id));
  return file => {
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (/^u[0-9a-f]+\.json$/.test(name)) return 0;
    const m = /^c(\d+)(?:\.\d+)?\.json$/.exec(name);
    if (!m) return null;
    let id = Number(m[1]);
    for (let hops = 0; hops < 32 && merged.has(id) && !banned.has(id); hops++) id = merged.get(id)!;
    if (banned.has(id)) return null;
    const s = status.get(id);
    if (s === undefined || s === "unlinking") return 0;
    return s === "unlinking-banned" ? null : id;
  };
}
