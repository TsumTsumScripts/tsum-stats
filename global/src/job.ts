// The hourly job (CONTRACT §3.2), run by the cron trigger and by
// POST /api/v1/admin/rollup. Each step asks the run for room before it starts
// a unit of work and records its progress in D1 (pending, dirty_days, state),
// so a run cut short, by the budget or by the runtime, loses nothing. A step
// that fails is logged and reported, and the steps after it still run.
//
// State keys it keeps:
//   recompute         the days this or a cut-short run took from dirty_days
//   skip              {day: seq}: pending rounds up to seq are in day's tables already (a recompute read them)
//   render            days whose tables changed and whose part is still to be published again
//   part:<from>       a published part: {from, to, rounds, first, last, tsums, skills, bytes, files: [{file, sha, rounds, bytes}]}
//   parts_at          when a part pointer last changed (ms): a manifest older than that is written again
//   totals            {tsums: {tsum: rounds}, skills: {skill: rounds}, skillTypes: {type: rounds}} over every part, kept up as the pointers change
//   people            {contributors, devices, tsums: {tsum: contributors}, catalog}: the manifest's counts of people
//   trash             [[R2 key, ms]] replaced parts, deleted once no cached manifest names them
//   archived_through  the newest day whose rounds are in the archive
//   dropped_through   the newest day whose rounds have left D1
//   held              [[day, rounds]] archived days still in D1, dropped only once D1 holds over RETAIN_ROWS
//   archive           the archive of one day in progress
//   restored          [[day, rounds]] days a restore brought back into D1, to drop again once recomputed
//   settings_archived the newest settings id in archive/settings/
//   span:<id>         a contributor's first and last contrib_cells day, for /me
//   unlink:<id>       an unlink in progress
//   merged:<id>       the contributor an id was merged into, for restores
//   gone:<id>         "banned": a banned contributor that unlinked; its archive files are never restored
//   nocompact:<month> a month too big for one part
// and, written by the admin route only, resend (the full re-upload number, CONTRACT §2.2).
import { archiveStarved, archiveStep, dropRestored, dropStep } from "./archive";
import { RECORD } from "./budget";
import { catalogId } from "./catalog";
import { addDays, dayOf } from "./days";
import { limits, type Env, type Limits } from "./env";
import { compactStep, finish, renderStep } from "./parts";
import { DAY_QUERIES, foldStep, recomputeStep, type Pending } from "./rollup";
import { Run } from "./run";
import { unlinkStep } from "./unlink";

/** One file of a published part. */
export interface PartFile {
  file: string;
  sha: string;
  rounds: number;
  bytes: number;
}

/** A published part as the job tracks it; the rest of its pointer stays in D1. */
export interface Part {
  from: string;
  to: string;
  rounds: number;
  bytes: number;
  files: PartFile[];
}

/** What one run knows and changes; finish() writes it back. */
export interface Job {
  run: Run;
  lim: Limits;
  /** Uploads waiting in `pending`, oldest first. */
  pending: Pending[];
  /** Days taken from dirty_days, oldest first, and those recomputed. */
  claimed: string[];
  done: string[];
  /** Days to publish again, and those published this run. */
  render: Set<string>;
  rendered: Set<string>;
  /** The fold wrote state render itself (finish writes it whole). */
  renderSaved: boolean;
  parts: Map<string, Part>;
  /** Pointers to write at the end: [summary JSON from SQL, files], or null to remove. */
  pointers: Map<string, [string, PartFile[]] | null>;
  /** State keys to write (or delete, null) at the end. */
  state: Map<string, string | null>;
  trash: [string, number][];
  trashChanged: boolean;
  archivedThrough: string;
  droppedThrough: string;
  archive: string | null;
  held: [string, number][];
  restored: [string, number][];
  /** archive/settings/ has every settings row (checked once a run). */
  settingsArchived: boolean;
  noCompact: Set<string>;
  partsAt: number;
  hasTotals: boolean;
  hasPeople: boolean;
  /** A step changed `recent`, so the counts of people may have moved. */
  recentChanged: boolean;
  /** Some step left work for the next run. */
  more: boolean;
  report: Report;
}

export interface Report {
  /** Rounds added in from pending. */
  folded: number;
  /** Days recomputed in full from their rounds. */
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
  /** Rows D1 read and wrote for the run, everything counted, and the bytes it put to R2. */
  read: number;
  written: number;
  bytes: number;
  /** Steps that failed: "<step>: <message>". */
  errors: string[];
}

/**
 * Held back for finish(): the totals, its state writes and deletes, the
 * pointers, the people, the manifest's query and the budget's record; the
 * manifest's head, put and the trash's delete.
 */
export const FINISH = { q: 7, r2: 3 };

/** The statements the job opens with (open()), and the daily clean-up's. */
const OPEN_QUERIES = 6;
const CLEANUP_QUERIES = 2;
/** Kept for publishing the days a run changes (renderStep), a query each. */
const RENDER_QUERIES = 4;

export async function runJob(env: Env, nowMs: number): Promise<Report> {
  const run = new Run(env, nowMs, FINISH);
  const job = await open(run, limits(env));
  // A busy day's part can take a run's bytes every hour, leaving the archive
  // none for its files: an archive that got none last run goes before render.
  type Step = [string, (job: Job) => Promise<void>];
  const archive: Step[] = [["archive", archiveStep]];
  const starved = archiveStarved(job.archive);
  const steps: Step[] = [
    ["fold", foldStep], ["recompute", recomputeStep], ...(starved ? archive : []),
    ["render", renderStep], ["unlink", unlinkStep], ["restored", dropRestored],
    ...(starved ? [] : archive), ["drop", dropStep], ["compact", compactStep],
  ];
  for (const [name, step] of steps) {
    try {
      await step(job);
    } catch (e) {
      console.error("rollup", name, e);
      job.report.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      job.more = true;
    }
  }
  run.release();
  try {
    await finish(job);
  } finally {
    // Whatever happened, what D1 did for the run is counted.
    await run.batch([run.stmt(RECORD, dayOf(run.now), run.written + 1, run.read)]).catch(e => console.error("rollup budget", e));
    job.report.more = job.more;
    job.report.queries = run.queries;
    job.report.r2 = run.r2;
    job.report.read = run.read;
    job.report.written = run.written;
    job.report.bytes = run.bytes;
  }
  return job.report;
}

/**
 * Takes the oldest dirty days, as many as this run can recompute (with any a
 * cut-short run left), and reads the state the steps need.
 */
async function open(run: Run, lim: Limits): Promise<Job> {
  // Claim no more days than the budget can recompute, besides publishing
  // them. A day claimed but not reached (the pending rounds came first) is
  // claimed again by the next run.
  const today = dayOf(run.now);
  const cleanup = new Date(run.nowMs).getUTCHours() === 0;
  const room = run.maxQueries - FINISH.q - OPEN_QUERIES - (cleanup ? CLEANUP_QUERIES : 0) - 1 - RENDER_QUERIES;
  const take = Math.max(0, Math.min(lim.rollupDays, Math.floor(room / DAY_QUERIES)));
  const [, claim, , rows, budget, pending] = await run.batch([
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
          THEN json_object('from', value ->> 'from', 'to', value ->> 'to', 'rounds', value ->> 'rounds', 'bytes', value ->> 'bytes', 'files', value -> 'files')
        WHEN key = 'totals' THEN '1' WHEN key = 'people' THEN coalesce(value ->> 'catalog', '') ELSE value END
      FROM state WHERE key IN ('trash', 'archived_through', 'dropped_through', 'archive', 'held', 'restored', 'render', 'parts_at', 'totals', 'people')
        OR (key >= 'part:' AND key < 'part;') OR (key >= 'nocompact:' AND key < 'nocompact;')`),
    run.stmt("SELECT rows, reads FROM budget WHERE day = ?1", today),
    // Uploads to add in, and whether each one's rounds are public and named now.
    run.stmt(`SELECT p.seq, p.contributor, p.n, p.days, c.status, (SELECT value FROM state WHERE key = 'gone:' || p.contributor) AS gone
      FROM pending p LEFT JOIN contributors c ON c.id = p.contributor ORDER BY p.seq LIMIT 5000`),
    // Once a day, the counters that only matter on their own day.
    ...(cleanup ? [
      run.stmt("DELETE FROM budget WHERE day < ?1", addDays(today, -7)),
      run.stmt("DELETE FROM join_limits WHERE day < ?1", today),
    ] : []),
  ]);
  const spent = budget.results[0] as { rows: number; reads: number } | undefined;
  run.spentRows = spent?.rows ?? 0;
  run.spentReads = spent?.reads ?? 0;
  const job: Job = {
    run, lim,
    pending: pending.results as unknown as Pending[],
    claimed: JSON.parse((claim.results[0] as { value: string }).value),
    done: [],
    render: new Set(),
    rendered: new Set(),
    renderSaved: false,
    parts: new Map(),
    pointers: new Map(),
    state: new Map(),
    trash: [],
    trashChanged: false,
    archivedThrough: "",
    droppedThrough: "",
    archive: null,
    held: [],
    restored: [],
    settingsArchived: false,
    noCompact: new Set(),
    partsAt: 0,
    hasTotals: false,
    hasPeople: false,
    recentChanged: false,
    more: false,
    report: {
      folded: 0, recomputed: [], rendered: [], unlinked: [], archived: [], dropped: [], compacted: [], manifest: false, more: false,
      queries: 0, r2: 0, read: 0, written: 0, bytes: 0, errors: [],
    },
  };
  for (const { key, value } of rows.results as { key: string; value: string }[]) {
    if (key.startsWith("part:")) {
      const p = JSON.parse(value) as Part;
      job.parts.set(p.from, p);
    } else if (key.startsWith("nocompact:")) job.noCompact.add(key.slice(10));
    else if (key === "trash") job.trash = JSON.parse(value);
    else if (key === "archived_through") job.archivedThrough = value;
    else if (key === "dropped_through") job.droppedThrough = value;
    else if (key === "archive") job.archive = value;
    else if (key === "held") job.held = JSON.parse(value);
    else if (key === "restored") job.restored = JSON.parse(value);
    else if (key === "render") for (const d of JSON.parse(value) as string[]) job.render.add(d);
    else if (key === "parts_at") job.partsAt = Number(value);
    else if (key === "totals") job.hasTotals = true;
    // Counts made under another catalog are made again: a Tsum it lacked now counts.
    else if (key === "people") job.hasPeople = value === catalogId();
    else if (key === "dirty") job.more = value !== "0";
  }
  return job;
}
