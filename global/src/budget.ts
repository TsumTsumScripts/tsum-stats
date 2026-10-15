// The daily D1 budget (CONTRACT §2.6). Every row D1 writes or deletes, for an
// upload, a join, an unlink, an admin route or the hourly job, is counted in
// `budget` under its UTC day, as D1 itself counts it (meta.rows_written), and
// so are the rows it reads. Uploads and joins are refused (503 budget) once
// their writes would take the day past BUDGET_ROWS_PER_DAY − JOB_RESERVE_ROWS;
// the job spends the rest. A refusal is a statement of the same D1 batch as
// the writes it guards (a batch is one transaction), so requests running at
// once cannot both pass it.
import { HttpError, untilMidnight } from "./http";

type Refusal = "quota" | "budget" | "join_limit" | "unlinked";

/** Which refusals statement stopped a batch: its constraint's name, as D1 reports it. */
export function refusedBy(e: unknown): Refusal | null {
  const m = /CHECK constraint failed: (quota|budget|join_limit|unlinked)\b/.exec(String(e instanceof Error ? e.message : e));
  return m ? (m[1] as Refusal) : null;
}

/**
 * Stops an upload's batch when contributor ?1 is no longer active or banned:
 * it unlinked after the upload's key was checked, so nothing may be stored
 * under its id again (CONTRACT §2.4).
 */
export const LINKED_CHECK = `INSERT INTO refusals (unlinked) SELECT 1
  WHERE NOT EXISTS (SELECT 1 FROM contributors WHERE id = ?1 AND status IN ('active', 'banned'))`;

/** Stops its batch when ?2 more rows would take day ?1's writes past ?3. */
export const BUDGET_CHECK = "INSERT INTO refusals (budget) SELECT 1 WHERE coalesce((SELECT rows FROM budget WHERE day = ?1), 0) + ?2 > ?3";

/** Adds ?2 rows written and ?3 rows read to day ?1. It writes one row itself, which ?2 must include. */
export const RECORD = `INSERT INTO budget (day, rows, reads) VALUES (?1, ?2, ?3)
  ON CONFLICT (day) DO UPDATE SET rows = rows + excluded.rows, reads = reads + excluded.reads`;

export interface Spend {
  /** Write rows the batch is expected to make, besides its own budget row. */
  est: number;
  /** Refused past this many rows written today; null for writes that are never refused. */
  cap: number | null;
  /** Rows read before the batch, recorded with it. */
  reads?: number;
  /** Refusal statements that run first: any of them may stop the batch. */
  checks?: D1PreparedStatement[];
}

/**
 * Runs stmts as one D1 batch within today's budget: the checks, the budget's
 * own refusal, the reservation of what the batch should write, then stmts.
 * Afterwards the day is corrected to what D1 says the batch wrote (one more
 * row, when the estimate was off). A refusal throws the contract's error;
 * nothing of the batch is kept. Returns stmts' results.
 */
export async function spend(db: D1Database, nowMs: number, s: Spend, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const reserved = s.est + 1;
  const head = [...(s.checks ?? [])];
  if (s.cap !== null) head.push(db.prepare(BUDGET_CHECK).bind(day, reserved, s.cap));
  head.push(db.prepare(RECORD).bind(day, reserved, s.reads ?? 0));
  let res: D1Result[];
  try {
    res = await db.batch([...head, ...stmts]);
  } catch (e) {
    const by = refusedBy(e);
    if (by === "quota") throw new HttpError(429, "quota", untilMidnight(nowMs));
    if (by === "join_limit") throw new HttpError(429, "join-limit", untilMidnight(nowMs));
    if (by === "budget") throw new HttpError(503, "budget", untilMidnight(nowMs));
    if (by === "unlinked") throw new HttpError(401, "unauthorized");
    throw e;
  }
  const written = res.reduce((n, r) => n + (r.meta.rows_written ?? 0), 0);
  if (written !== reserved) {
    const read = res.reduce((n, r) => n + (r.meta.rows_read ?? 0), 0);
    await db.prepare("UPDATE budget SET rows = rows + ?2, reads = reads + ?3 WHERE day = ?1").bind(day, written - reserved + 1, read).run();
  }
  return res.slice(head.length);
}
