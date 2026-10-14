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
  ACCEPT_DAYS: string;
  ROLLUP_DAYS_PER_RUN: string;
  UNLINK_CHUNK: string;
  RUN_QUERY_BUDGET: string;
  RUN_R2_BUDGET: string;
  MIN_CONTRIBUTORS: string;
}

/** The vars as numbers (CONTRACT.md names each). */
export interface Limits {
  quota: number;
  budget: number;
  acceptDays: number;
  rollupDays: number;
  unlinkChunk: number;
  runQueries: number;
  runR2: number;
  minContributors: number;
}

export function limits(env: Env): Limits {
  const n = (v: string | number | undefined, fallback: number) => {
    const x = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(x) ? x : fallback;
  };
  return {
    quota: n(env.QUOTA_PER_CONTRIBUTOR, 5000),
    budget: n(env.BUDGET_ROWS_PER_DAY, 80000),
    acceptDays: n(env.ACCEPT_DAYS, 60),
    rollupDays: n(env.ROLLUP_DAYS_PER_RUN, 8),
    unlinkChunk: n(env.UNLINK_CHUNK, 5000),
    runQueries: n(env.RUN_QUERY_BUDGET, 45),
    runR2: n(env.RUN_R2_BUDGET, 40),
    minContributors: n(env.MIN_CONTRIBUTORS, 3),
  };
}
