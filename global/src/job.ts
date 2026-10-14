// The hourly job (CONTRACT §3.2), run by the cron trigger and by
// POST /api/v1/admin/rollup. Each step asks the run for room before it starts
// a unit of work and records its progress in D1 (dirty_days, state), so a
// run cut short, by the budget or by the runtime, loses nothing.
//
// State keys it keeps:
//   recompute         the days this or a cut-short run took from dirty_days
//   part:<from>       a published part: {from, to, file, sha, rounds, first, last, tsums, skills}
//   trash             [[R2 key, ms]] replaced parts, deleted once no cached manifest names them
//   archived_through  the newest day whose rounds left D1 for the archive
//   archive           the archive of one day in progress
//   restored          days a restore brought back into D1, to drop again once recomputed
//   settings_archived the newest settings id in archive/settings/
//   span:<id>         a contributor's first and last contrib_cells day, for /me
//   unlink:<id>       an unlink in progress
//   merged:<id>       the contributor an id was merged into, for restores
//   nocompact:<month> a month too big for one part
import { archiveStep, dropRestored } from "./archive";
import { limits, type Env, type Limits } from "./env";
import { compactStep, finish } from "./parts";
import { DAY_QUERIES, recomputeStep } from "./rollup";
import { Run } from "./run";
import { unlinkStep } from "./unlink";

/** A published part as the job tracks it; the rest of its pointer stays in D1. */
export interface Part {
  from: string;
  to: string;
  file: string;
  sha: string;
  rounds: number;
}

/** What one run knows and changes; finish() writes it back. */
export interface Job {
  run: Run;
  lim: Limits;
  /** Days taken from dirty_days, oldest first, and those recomputed. */
  claimed: string[];
  done: string[];
  parts: Map<string, Part>;
  /** Pointers to write at the end: [summary JSON from SQL, file, sha], or null to remove. */
  pointers: Map<string, [string, string, string] | null>;
  /** State keys to write (or delete, null) at the end. */
  state: Map<string, string | null>;
  trash: [string, number][];
  trashChanged: boolean;
  archivedThrough: string;
  archive: string | null;
  restored: string[];
  /** archive/settings/ has every settings row (checked once a run). */
  settingsArchived: boolean;
  noCompact: Set<string>;
  /** Some step left work for the next run. */
  more: boolean;
  report: Report;
}

export interface Report {
  recomputed: string[];
  rendered: string[];
  unlinked: number[];
  archived: string[];
  dropped: string[];
  compacted: string[];
  manifest: boolean;
  more: boolean;
  queries: number;
  r2: number;
}

/**
 * Held back for finish(): its state writes, the manifest's query, and the
 * manifest's head, put and the trash's delete.
 */
export const FINISH = { q: 8, r2: 3 };

/** The statements the job opens with (open()). */
const OPEN_QUERIES = 4;

export async function runJob(env: Env, nowMs: number): Promise<Report> {
  const run = new Run(env, nowMs, FINISH);
  const job = await open(run, limits(env));
  await recomputeStep(job);
  await unlinkStep(job);
  await dropRestored(job);
  await archiveStep(job);
  await compactStep(job);
  run.release();
  await finish(job);
  job.report.more = job.more;
  job.report.queries = run.queries;
  job.report.r2 = run.r2;
  return job.report;
}

/**
 * Takes the oldest dirty days, as many as this run can recompute (with any a
 * cut-short run left), and reads the state the steps need.
 */
async function open(run: Run, lim: Limits): Promise<Job> {
  // Claim no more days than the budget can recompute.
  const room = run.maxQueries - FINISH.q - OPEN_QUERIES;
  const take = Math.max(0, Math.min(lim.rollupDays, Math.floor(room / DAY_QUERIES)));
  const [, claim, , rows] = await run.batch([
    run.stmt(`INSERT OR IGNORE INTO dirty_days (day)
      SELECT value FROM json_each(coalesce((SELECT value FROM state WHERE key = 'recompute'), '[]'))`),
    // A day being restored waits until all its files are back.
    run.stmt(`INSERT OR REPLACE INTO state (key, value) SELECT 'recompute', json_group_array(day) FROM (
        SELECT day FROM dirty_days WHERE day NOT IN (SELECT substr(key, 9) FROM state WHERE key >= 'restore:' AND key < 'restore;')
        ORDER BY day LIMIT ?1) RETURNING value`, take),
    run.stmt("DELETE FROM dirty_days WHERE day IN (SELECT value FROM json_each((SELECT value FROM state WHERE key = 'recompute')))"),
    // The days left for later runs, and the state.
    run.stmt(`SELECT 'dirty' AS key, CAST(count(*) AS TEXT) AS value FROM dirty_days
      UNION ALL SELECT key, CASE WHEN key >= 'part:' AND key < 'part;'
        THEN json_object('from', value ->> 'from', 'to', value ->> 'to', 'file', value ->> 'file', 'sha', value ->> 'sha', 'rounds', value ->> 'rounds')
        ELSE value END
      FROM state WHERE key IN ('trash', 'archived_through', 'archive', 'restored')
        OR (key >= 'part:' AND key < 'part;') OR (key >= 'nocompact:' AND key < 'nocompact;')`),
  ]);
  const job: Job = {
    run, lim,
    claimed: JSON.parse((claim.results[0] as { value: string }).value),
    done: [],
    parts: new Map(),
    pointers: new Map(),
    state: new Map(),
    trash: [],
    trashChanged: false,
    archivedThrough: "",
    archive: null,
    restored: [],
    settingsArchived: false,
    noCompact: new Set(),
    more: false,
    report: { recomputed: [], rendered: [], unlinked: [], archived: [], dropped: [], compacted: [], manifest: false, more: false, queries: 0, r2: 0 },
  };
  for (const { key, value } of rows.results as { key: string; value: string }[]) {
    if (key.startsWith("part:")) {
      const p = JSON.parse(value) as Part;
      job.parts.set(p.from, p);
    } else if (key.startsWith("nocompact:")) job.noCompact.add(key.slice(10));
    else if (key === "trash") job.trash = JSON.parse(value);
    else if (key === "archived_through") job.archivedThrough = value;
    else if (key === "archive") job.archive = value;
    else if (key === "restored") job.restored = JSON.parse(value);
    else if (key === "dirty") job.more = value !== "0";
  }
  return job;
}
