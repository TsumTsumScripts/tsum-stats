// The archive (CONTRACT §3.4): step 4 of the hourly job moves each final day's
// rounds to R2, one file per contributor, and restore reads a day back.
//
// A file is built by D1 in one statement, so the Worker only carries the
// string. Every name is deterministic (c<id>, or an HMAC for unlinked
// rounds), so a run cut short simply writes the same files again.
import { hmacHex, hmacKey } from "./crypto";
import { DAY, DAY_ROUNDS, addDays, dayParams, dayRange, dayStart, keyDay } from "./days";
import type { Env } from "./env";
import { HttpError } from "./http";
import type { Job } from "./job";
import { Run } from "./run";

export const ARCHIVE = "archive/";
export const archiveKey = (day: string, name: string) => `${ARCHIVE}${day.slice(0, 7)}/${day}/${name}`;

/**
 * An unlinked file's name: u + an HMAC of what it holds, so the name says
 * nothing about whose rounds they were and a re-run writes the same file.
 */
export async function unlinkedName(env: Env, what: string): Promise<string> {
  return "u" + (await hmacHex(await hmacKey(env.DEVICE_KEY), "archive:" + what)).slice(0, 16) + ".json";
}

/** Unlinked rounds (contributor 0) are filed this many a file; anyone else's day is one file. */
const UNLINKED_PER_FILE = 5000;
/** Settings rows per archive/settings file. */
const SETTINGS_PER_FILE = 2000;

// The file's arrays, in the rounds table's columns.
const COLUMNS: [string, string][] = [
  ["key", "key"], ["playedAt", "played_at"], ["build", "build"], ["tsum", "tsum"], ["skill", "skill"], ["items", "items"],
  ["version", "version"], ["settings", "settings"], ["duration", "duration"], ["score", "score"], ["base", "base"],
  ["final", "final"], ["medals", "medals"],
];

/** One file: contributor ?3's rounds of the day (?1-?2) after key ?4, at most ?5, filed as day ?6 and contributor ?7. */
const FILE = `SELECT count(*) AS n, max(key) AS last,
    json_object('kind', 'tsum-global-archive', 'format', 1, 'day', ?6, 'contributor', CAST(?7 AS INTEGER), 'n', count(*),
      ${COLUMNS.map(([j, c]) => `'${j}', json_group_array(${c})`).join(", ")}) AS body
  FROM (SELECT * FROM rounds WHERE ${DAY_ROUNDS} AND contributor = ?3 AND key > ?4 ORDER BY key LIMIT ?5)`;

const SETTINGS = `SELECT min(id) AS lo, max(id) AS hi, json_object('kind', 'tsum-global-settings', 'format', 1,
    'settings', json_group_array(json_object('id', id, 'hash', hash, 'json', json))) AS body
  FROM (SELECT * FROM settings WHERE id > ?1 ORDER BY id LIMIT ${SETTINGS_PER_FILE})`;

/** days.ts: bin, in SQL, for rounds read back from a file. */
const binSQL = (v: string) => `CASE WHEN ${v} < 100 THEN ${v} ELSE 100 + CAST(floor(ln(${v} / 100.0) / ln(1.02)) AS INTEGER) END`;

/**
 * A file's rounds back into D1 as contributor ?2. Each column becomes a table
 * of (position, value), joined on the position, so the Worker never parses
 * the file. (D1 allows only five terms in a compound SELECT, so not a UNION.)
 * A round D1 already has is left alone.
 */
const RESTORE = `WITH ${COLUMNS.map(([j]) => `c_${j} AS MATERIALIZED (SELECT key AS i, value AS v FROM json_each(?1, '$.${j}'))`).join(",\n    ")}
  INSERT OR IGNORE INTO rounds (key, contributor, played_at, build, tsum, skill, items, version, settings,
    duration, score, base, final, medals, bin_base, bin_final, bin_medals)
  SELECT key, ?2, played_at, build, tsum, skill, items, version, settings, duration, score, base, final, medals,
    ${binSQL("base")}, ${binSQL("final")}, CASE WHEN medals > 0 THEN ${binSQL("medals")} END
  FROM (SELECT ${COLUMNS.map(([j, c]) => `c_${j}.v AS ${c}`).join(", ")}
    FROM c_key ${COLUMNS.slice(1).map(([j]) => `JOIN c_${j} ON c_${j}.i = c_key.i`).join(" ")})`;

/** An archive in progress: the day, its contributors' row counts when it began, and what is written. */
interface Progress {
  day: string;
  groups: string;
  done: number[];
  /** Contributor 0's files: the last key filed, how many files, how many rounds. */
  after: string;
  chunk: number;
  unlinked: number;
}

const isFinal = (job: Job, day: string) => dayStart(day) + DAY + (job.lim.acceptDays + 1) * DAY <= job.run.now;

async function putWhole(run: Run, key: string, body: string): Promise<void> {
  const bytes = new TextEncoder().encode(body);
  const obj = await run.put(key, bytes);
  if (!obj || obj.size !== bytes.byteLength) throw new Error(`archive: ${key} was not stored whole`);
}

/**
 * Step 4: each day older than ACCEPT_DAYS + 1, in order, while the budget
 * lasts. A day leaves D1 only once all its files are written and it still
 * has exactly the rows they hold.
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
      // Rows changed under it (a merge, say): start the day over next run.
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
  const { run } = job;
  const env = run.env;
  const params = dayParams(dayRange(day));
  if (!run.room(1)) return false;
  const groups = await run.all<{ c: number; n: number; status: string | null }>(`SELECT g.c, g.n, s.status
    FROM (SELECT contributor AS c, count(*) AS n FROM rounds WHERE ${DAY_ROUNDS} GROUP BY contributor) g
    LEFT JOIN contributors s ON s.id = g.c ORDER BY g.c`, ...params);
  const signature = groups.map(g => `${g.c}:${g.n}`).join(",");
  const p: Progress = progress?.day === day && progress.groups === signature
    ? progress
    : { day, groups: signature, done: [], after: "", chunk: 0, unlinked: 0 };
  const stop = () => {
    job.state.set("archive", JSON.stringify(p));
    return false;
  };
  const total = groups.reduce((n, g) => n + g.n, 0);
  if (total > 0 && !(await archiveSettings(job))) return stop();

  for (const g of groups) {
    if (p.done.includes(g.c)) continue;
    if (g.c === 0) {
      while (p.unlinked < g.n) {
        if (!run.room(1, 1)) return stop();
        const f = (await run.first<{ n: number; last: string; body: string }>(FILE, ...params, 0, p.after, UNLINKED_PER_FILE, day, null))!;
        if (f.n === 0) throw new Error(`unlinked rounds of ${day} changed`);
        await putWhole(run, archiveKey(day, await unlinkedName(env, `0:${day}:${p.chunk}`)), f.body);
        p.after = f.last;
        p.chunk++;
        p.unlinked += f.n;
      }
      if (p.unlinked !== g.n) throw new Error(`unlinked rounds of ${day} changed`);
    } else if (g.status !== "unlinking-banned") {
      // A banned contributor's rounds are kept like anyone's; an unlinking
      // one's are already unnamed; an unlinking banned one's go with the day.
      if (!run.room(1, 1)) return stop();
      const unlinking = g.status === "unlinking";
      const f = (await run.first<{ n: number; body: string }>(FILE, ...params, g.c, "", -1, day, unlinking ? null : g.c))!;
      if (f.n !== g.n) throw new Error(`contributor ${g.c}'s rounds of ${day} changed`);
      const name = unlinking ? await unlinkedName(env, `${g.c}:${day}`) : `c${g.c}.json`;
      await putWhole(run, archiveKey(day, name), f.body);
    }
    p.done.push(g.c);
  }

  if (!run.room(3)) return stop();
  const [dropped] = await run.batch([
    run.stmt(`DELETE FROM rounds WHERE ${DAY_ROUNDS} AND (SELECT count(*) FROM rounds WHERE ${DAY_ROUNDS}) = ?3`, ...params, total),
    run.stmt(`INSERT OR REPLACE INTO state (key, value) SELECT 'archived_through', ?3
      WHERE NOT EXISTS (SELECT 1 FROM rounds WHERE ${DAY_ROUNDS})`, ...params, day),
    run.stmt("DELETE FROM state WHERE key = 'archive'"),
  ]);
  job.state.delete("archive");
  if (dropped.meta.changes !== total) throw new Error(`${day} has other rows than its files`);
  job.archivedThrough = day;
  job.archive = null;
  job.report.archived.push(day);
  return true;
}

/** Every settings row into archive/settings/ before a round naming it leaves D1. */
async function archiveSettings(job: Job): Promise<boolean> {
  const { run } = job;
  if (job.settingsArchived) return true;
  if (!run.room(2, 1)) return false;
  const s = (await run.first<{ done: number; top: number }>(`SELECT
    coalesce((SELECT CAST(value AS INTEGER) FROM state WHERE key = 'settings_archived'), 0) AS done,
    coalesce((SELECT max(id) FROM settings), 0) AS top`))!;
  let done = s.done;
  while (done < s.top) {
    if (!run.room(1, 1)) return false;
    const f = (await run.first<{ lo: number; hi: number; body: string }>(SETTINGS, done))!;
    await putWhole(run, `${ARCHIVE}settings/${f.lo}-${f.hi}.json`, f.body);
    done = f.hi;
    job.state.set("settings_archived", String(done));
  }
  job.settingsArchived = true;
  return true;
}

/**
 * A restored day's rounds leave D1 again once it is recomputed. Its files
 * are already in the archive, so nothing is written.
 */
export async function dropRestored(job: Job): Promise<void> {
  const { run } = job;
  for (const day of job.restored) {
    if (job.claimed.includes(day) && !job.done.includes(day)) continue;
    if (!run.room(2)) {
      job.more = true;
      return;
    }
    const params = dayParams(dayRange(day));
    const [gone] = await run.batch([
      run.stmt(`DELETE FROM rounds WHERE ${DAY_ROUNDS} AND NOT EXISTS (SELECT 1 FROM dirty_days WHERE day = ?3)`, ...params, day),
      run.stmt(`UPDATE state SET value = (SELECT json_group_array(value) FROM json_each(state.value) WHERE value != ?3)
        WHERE key = 'restored' AND NOT EXISTS (SELECT 1 FROM rounds WHERE ${DAY_ROUNDS})`, ...params, day),
    ]);
    if (gone.meta.changes > 0) job.report.dropped.push(day);
  }
}

/**
 * POST /api/v1/admin/restore {day}: an archived day's files back into D1,
 * then the day is marked dirty so the next rollup recomputes it. A day with
 * many files takes several calls (each within the invocation's budget);
 * `done` says when it is complete.
 */
export async function restore(env: Env, day: string, nowMs: number): Promise<Record<string, unknown>> {
  const run = new Run(env, nowMs);
  const key = "restore:" + day;
  const at = (await run.first<{ files: string | null; through: string | null }>(`SELECT
    (SELECT value FROM state WHERE key = ?1) AS files, (SELECT value FROM state WHERE key = 'archived_through') AS through`, key))!;
  // A day still in D1 is not in the archive yet, or not all of it.
  if (!at.through || day > at.through) throw new HttpError(400, "bad-request");
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
  let files: string[] = at.files ? JSON.parse(at.files) : await listing();

  const owner = await owners(run);
  let read = 0, rounds = 0, relisted = false;
  // Each file is a get and an insert; three statements are kept for the end.
  while (files.length && run.room(1 + 3, 1)) {
    const to = owner(files[0]);
    if (to !== null) {
      const obj = await run.get(files[0]);
      if (!obj) {
        // Renamed since the listing (an unlink): list again. A file read
        // twice adds nothing, since D1 keeps the rounds it already has.
        if (relisted || !run.room(1 + 3, 2)) break;
        files = await listing();
        relisted = true;
        continue;
      }
      const [res] = await run.batch([run.stmt(RESTORE, await obj.text(), to)]);
      rounds += res.meta.changes;
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
    run.stmt(`INSERT INTO state (key, value) VALUES ('restored', json_array(?1))
      ON CONFLICT (key) DO UPDATE SET value = json_insert(value, '$[#]', ?1)
      WHERE NOT EXISTS (SELECT 1 FROM json_each(state.value) WHERE value = ?1)`, day),
  ]);
  return { day, done: true, files: read, left: 0, rounds };
}

/**
 * Who a file's rounds belong to now: its contributor, or the one it was
 * merged into; contributor 0 once unlinked (or for a u file); null (left out)
 * for a banned contributor being unlinked, whose rounds are being deleted.
 */
async function owners(run: Run): Promise<(file: string) => number | null> {
  const [statuses, merges] = await run.batch<{ id: number; status: string; value: string }>([
    run.stmt("SELECT id, status FROM contributors"),
    run.stmt("SELECT CAST(substr(key, 8) AS INTEGER) AS id, value FROM state WHERE key >= 'merged:' AND key < 'merged;'"),
  ]);
  const status = new Map(statuses.results.map(r => [r.id, r.status]));
  const merged = new Map(merges.results.map(r => [r.id, Number(r.value)]));
  return file => {
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (/^u[0-9a-f]+\.json$/.test(name)) return 0;
    const m = /^c(\d+)\.json$/.exec(name);
    if (!m) return null;
    let id = Number(m[1]);
    for (let hops = 0; hops < 32 && merged.has(id); hops++) id = merged.get(id)!;
    const s = status.get(id);
    if (s === undefined || s === "unlinking") return 0;
    return s === "unlinking-banned" ? null : id;
  };
}
