// The Worker's bindings (wrangler.jsonc) and its tunables.

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  // Secrets: DEVICE_KEY re-keys device tags and addresses, ADMIN_KEY opens the admin routes.
  DEVICE_KEY: string;
  ADMIN_KEY: string;
  // vars, written as text.
  QUOTA_PER_CONTRIBUTOR: string;
  BUDGET_ROWS_PER_DAY: string;
  JOB_RESERVE_ROWS: string;
  READ_BUDGET_PER_DAY: string;
  RETAIN_ROWS: string;
  ACCEPT_DAYS: string;
  ROLLUP_DAYS_PER_RUN: string;
  UNLINK_CHUNK: string;
  RUN_QUERY_BUDGET: string;
  RUN_R2_BUDGET: string;
  RUN_BYTES: string;
  VALUE_MAX_BYTES: string;
  MIN_CONTRIBUTORS: string;
}

/** The vars as numbers (CONTRACT.md names each). */
export interface Limits {
  quota: number;
  /** Rows D1 may write a day, everything counted. */
  budget: number;
  /** Of those, what uploads and joins may not take: the hourly job's. */
  reserve: number;
  /** Rows D1 may read a day before the job puts off the work that can wait. */
  reads: number;
  /** Archived days stay in D1 until the rounds table holds more than this. */
  retain: number;
  acceptDays: number;
  rollupDays: number;
  unlinkChunk: number;
  runQueries: number;
  runR2: number;
  /** Bytes one run carries from D1 to R2 (its CPU goes on them). */
  runBytes: number;
  /** The largest value the Worker asks D1 to build (D1 refuses one over 2,000,000 bytes). */
  valueMax: number;
  minContributors: number;
}

export function limits(env: Env): Limits {
  const n = (v: string | number | undefined, fallback: number) => {
    const x = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(x) ? x : fallback;
  };
  return {
    quota: n(env.QUOTA_PER_CONTRIBUTOR, 5000),
    budget: n(env.BUDGET_ROWS_PER_DAY, 90000),
    reserve: n(env.JOB_RESERVE_ROWS, 25000),
    reads: n(env.READ_BUDGET_PER_DAY, 4_000_000),
    retain: n(env.RETAIN_ROWS, 3_000_000),
    acceptDays: n(env.ACCEPT_DAYS, 60),
    rollupDays: n(env.ROLLUP_DAYS_PER_RUN, 8),
    unlinkChunk: n(env.UNLINK_CHUNK, 5000),
    runQueries: n(env.RUN_QUERY_BUDGET, 45),
    runR2: n(env.RUN_R2_BUDGET, 40),
    runBytes: n(env.RUN_BYTES, 2_000_000),
    valueMax: n(env.VALUE_MAX_BYTES, 1_500_000),
    minContributors: n(env.MIN_CONTRIBUTORS, 3),
  };
}
