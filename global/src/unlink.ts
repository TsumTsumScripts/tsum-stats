// Step 3 of the hourly job: finishing unlinks (CONTRACT §2.4). Per
// contributor being unlinked, day by day (the days noted at unlink, with the
// rounds it had in each): its archive files are renamed so no file names it,
// and its rounds still in D1 are re-filed under contributor 0, or deleted for
// a banned one. Neither changes a public figure, so no day is marked dirty.
// The contributor row goes when no day is left.
import { archiveKey, bannedName, namedPrefix, unlinkedName } from "./archive";
import { addDays, DAY_ROUNDS, dayParams, dayRange } from "./days";
import type { Job } from "./job";

/** unlink:<id>, written by contributors.ts: unlink. */
interface Unlinking {
  /** The days left, each with about how many of its rounds are there (for the write budget). */
  days: [string, number][];
  /** The ids whose archive files are this contributor's: its own, and those merged into it. */
  ids: number[];
}

// Each file's id is the last thing before its rounds: `..."day":"…","contributor":17,"n":…`.
const NAMED = /^(\{"kind":"tsum-global-archive","format":\d+,"day":"\d{4}-\d{2}-\d{2}","contributor":)\d+,/;

/** Reads re-filing a day's rounds costs per round of the day (one scan). */
const READS_PER_ROUND = 1;

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
    const u: Unlinking = row.value ? JSON.parse(row.value) : { days: [], ids: [row.id] };
    const banned = row.status === "unlinking-banned";
    const state = "unlink:" + row.id;
    let budget = job.lim.unlinkChunk;

    while (u.days.length) {
      const [day, rounds] = u.days[0];
      // Files exist only for days archived, or being archived now.
      const archived = job.archivedThrough !== "" && day <= addDays(job.archivedThrough, 1);
      // Rounds are in D1 unless the day was dropped (and not restored since).
      const inD1 = !job.droppedThrough || day > job.droppedThrough || job.restored.some(([d]) => d === day);
      const dayRounds = job.parts.get(day)?.rounds ?? rounds;
      if (budget <= 0 || !run.room(2, archived ? u.ids.length : 0) ||
        (inD1 && (!run.canWrite(rounds + 1) || !run.canRead(dayRounds * READS_PER_ROUND)))) {
        job.more = true;
        break;
      }
      if (archived && !(await renameFiles(job, day, u.ids, banned))) {
        job.more = true;
        break;
      }
      // The day's D1 part and its progress in one batch: done, or not at all.
      const after: Unlinking = { ...u, days: u.days.slice(1) };
      const stmts = [run.stmt("INSERT OR REPLACE INTO state (key, value) VALUES (?1, ?2)", state, JSON.stringify(after))];
      if (inD1) {
        // A banned contributor's rounds were never public: leaving must not bring them in.
        const range = `${DAY_ROUNDS} AND contributor = ?3`;
        stmts.unshift(banned
          ? run.stmt(`DELETE FROM rounds WHERE ${range}`, ...dayParams(dayRange(day)), row.id)
          : run.stmt(`UPDATE rounds SET contributor = 0 WHERE ${range}`, ...dayParams(dayRange(day)), row.id));
      }
      await run.batch(stmts);
      u.days = after.days;
      budget -= rounds;
    }

    if (!u.days.length) {
      if (!run.room(5)) {
        job.more = true;
        return;
      }
      const stmts = [
        run.stmt("DELETE FROM contributors WHERE id = ?1", row.id),
        // Deleted at unlink, and an upload landing after it is refused (ingest.ts), but no
        // device row may outlive the contributor: it would tie a device hash to the id.
        run.stmt("DELETE FROM devices WHERE contributor = ?1", row.id),
        run.stmt("DELETE FROM state WHERE key = ?1", state),
        // Its merges are done with: no file names a merged id any more.
        run.stmt("DELETE FROM state WHERE key IN (SELECT 'merged:' || value FROM json_each(?1))", JSON.stringify(u.ids.filter(id => id !== row.id))),
      ];
      // A banned contributor is remembered as gone, so a file that still
      // names it (or an id merged into it) is never restored as anyone's.
      if (banned) {
        stmts.push(run.stmt("INSERT OR REPLACE INTO state (key, value) SELECT 'gone:' || value, 'banned' FROM json_each(?1)", JSON.stringify(u.ids)));
      }
      await run.batch(stmts);
      job.report.unlinked.push(row.id);
    }
  }
}

/**
 * Renames one day's archive files of the ids (c<id>.json and its further
 * parts): an R2 list per id, then a get, a put and a delete per file. A
 * banned contributor's go to b files, which a restore never reads. False when
 * the run's R2 budget ran out first; what was renamed stays renamed, and the
 * day is done again next run.
 */
async function renameFiles(job: Job, day: string, ids: number[], banned: boolean): Promise<boolean> {
  const { run } = job;
  for (const id of ids) {
    if (!run.room(0, 1)) return false;
    const page = await run.list({ prefix: namedPrefix(day, id) });
    for (const obj of page.objects) {
      if (!run.room(0, 3, obj.size)) return false;
      const got = await run.get(obj.key);
      if (!got) continue;
      const text = await got.text();
      if (!NAMED.test(text)) {
        console.error("unlink: unexpected archive file", obj.key);
        continue;
      }
      const what = `rename:${id}:${obj.key.slice(obj.key.lastIndexOf("/") + 1)}`;
      const to = archiveKey(day, banned ? await bannedName(run.env, what) : await unlinkedName(run.env, what));
      await run.put(to, text.replace(NAMED, "$1null,"));
      await run.del(obj.key);
    }
    if (page.truncated) return false;
  }
  return true;
}
