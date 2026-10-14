// Step 3 of the hourly job: finishing unlinks (CONTRACT §2.4). Per
// contributor being unlinked, up to UNLINK_CHUNK of its rounds a run are
// re-filed under contributor 0 (or deleted, for a banned one), in key order
// from a cursor; then its archive files are renamed so no file names it. The
// contributor row goes when nothing is left.
import { archiveKey, unlinkedName } from "./archive";
import { keyDaySQL } from "./days";
import type { Job } from "./job";

/** unlink:<id>, written by contributors.ts: unlink. */
interface Unlinking {
  /** The last key re-filed; rounds after it are left. */
  cursor: string;
  refiled: boolean;
  /** Days whose archive file may still be c<id>.json. */
  days: string[];
}

// Each file's id is the last thing before its rounds: `..."day":"…","contributor":17,"n":…`.
const NAMED = /^(\{"kind":"tsum-global-archive","format":1,"day":"\d{4}-\d{2}-\d{2}","contributor":)\d+,/;

export async function unlinkStep(job: Job): Promise<void> {
  const { run } = job;
  if (!run.room(1)) {
    job.more = true;
    return;
  }
  const rows = await run.all<{ id: number; status: string; value: string | null }>(`SELECT c.id, c.status, s.value
    FROM contributors c LEFT JOIN state s ON s.key = 'unlink:' || c.id
    WHERE c.status IN ('unlinking', 'unlinking-banned') ORDER BY c.id`);
  for (const row of rows) {
    const u: Unlinking = row.value ? JSON.parse(row.value) : { cursor: "", refiled: false, days: [] };
    const banned = row.status === "unlinking-banned";
    const state = "unlink:" + row.id;

    if (!u.refiled) {
      if (!run.room(4)) {
        job.more = true;
        return;
      }
      const chunk = (await run.first<{ n: number; last: string | null; days: string }>(`SELECT count(*) AS n, max(key) AS last,
          json_group_array(DISTINCT ${keyDaySQL()}) AS days
        FROM (SELECT key FROM rounds WHERE key > ?1 AND contributor = ?2 ORDER BY key LIMIT ?3)`,
        u.cursor, row.id, job.lim.unlinkChunk))!;
      const after = u.cursor;
      u.refiled = chunk.n < job.lim.unlinkChunk;
      const stmts = [];
      if (chunk.n > 0) {
        u.cursor = chunk.last!;
        const range = "key > ?1 AND key <= ?2 AND contributor = ?3";
        // A banned contributor's rounds were never public: leaving must not bring them in.
        stmts.push(banned
          ? run.stmt(`DELETE FROM rounds WHERE ${range}`, after, u.cursor, row.id)
          : run.stmt(`UPDATE rounds SET contributor = 0 WHERE ${range}`, after, u.cursor, row.id));
        if (!banned) stmts.push(run.stmt("INSERT OR IGNORE INTO dirty_days (day) SELECT value FROM json_each(?1)", chunk.days));
      }
      stmts.push(run.stmt("INSERT OR REPLACE INTO state (key, value) VALUES (?1, ?2)", state, JSON.stringify(u)));
      await run.batch(stmts);
      // The days it marked dirty are recomputed by the next run.
      if (!u.refiled || (chunk.n > 0 && !banned)) job.more = true;
    }

    // Renaming is a get, a put and a delete; the state write after it is one query.
    let renamed = false;
    while (u.days.length && run.room(2, 3)) {
      const day = u.days[0];
      const from = archiveKey(day, `c${row.id}.json`);
      const obj = await run.get(from);
      if (obj) {
        const text = await obj.text();
        if (NAMED.test(text)) {
          await run.put(archiveKey(day, await unlinkedName(run.env, `rename:${row.id}:${day}`)), text.replace(NAMED, "$1null,"));
          await run.del(from);
        } else {
          console.error("unlink: unexpected archive file", from);
        }
      }
      u.days.shift();
      renamed = true;
    }
    if (u.days.length) job.more = true;

    if (u.refiled && !u.days.length) {
      if (!run.room(2)) {
        job.more = true;
        return;
      }
      await run.batch([
        run.stmt("DELETE FROM contributors WHERE id = ?1", row.id),
        run.stmt("DELETE FROM state WHERE key = ?1", state),
      ]);
      job.report.unlinked.push(row.id);
    } else if (renamed) {
      if (!run.room(1)) return;
      await run.batch([run.stmt("INSERT OR REPLACE INTO state (key, value) VALUES (?1, ?2)", state, JSON.stringify(u))]);
    }
  }
}
