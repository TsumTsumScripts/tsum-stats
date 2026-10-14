// One invocation's share of D1 and R2. Workers Free allows 50 D1 queries per
// invocation, so the hourly job (and a restore) counts what it issues and
// stops starting new work at RUN_QUERY_BUDGET queries or RUN_R2_BUDGET R2
// operations (CONTRACT §3.2). A batch counts each of its statements.
import { limits, type Env } from "./env";

export class Run {
  queries = 0;
  r2 = 0;
  readonly maxQueries: number;
  readonly maxR2: number;

  /**
   * reserve is held back for the run's last step (the manifest), so the
   * steps before it cannot spend it; release() hands it over.
   */
  constructor(
    readonly env: Env,
    readonly nowMs: number,
    private reserve: { q: number; r2: number } = { q: 0, r2: 0 },
  ) {
    const lim = limits(env);
    this.maxQueries = lim.runQueries;
    this.maxR2 = lim.runR2;
  }

  get now(): number {
    return this.nowMs / 1000;
  }

  /** Whether q more queries and r more R2 operations fit. */
  room(q: number, r = 0): boolean {
    return this.queries + q + this.reserve.q <= this.maxQueries && this.r2 + r + this.reserve.r2 <= this.maxR2;
  }

  release(): void {
    this.reserve = { q: 0, r2: 0 };
  }

  private spend(q: number, r: number): void {
    // A step that forgot to ask for room is a bug, not a slow run.
    if (this.queries + q > this.maxQueries || this.r2 + r > this.maxR2) {
      throw new Error(`run budget passed: ${this.queries + q} queries, ${this.r2 + r} R2 operations`);
    }
    this.queries += q;
    this.r2 += r;
  }

  /**
   * A statement to run later in batch(); not counted until then. D1 binds a
   * JS number as REAL, so SQL that turns one into text (a state key, a file's
   * contributor) casts it: CAST(?1 AS INTEGER).
   */
  stmt(sql: string, ...params: unknown[]): D1PreparedStatement {
    return this.env.DB.prepare(sql).bind(...params);
  }

  first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null> {
    this.spend(1, 0);
    return this.stmt(sql, ...params).first<T>();
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    this.spend(1, 0);
    return (await this.stmt(sql, ...params).all<T>()).results;
  }

  batch<T = Record<string, unknown>>(stmts: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    if (stmts.length === 0) return Promise.resolve([]);
    this.spend(stmts.length, 0);
    return this.env.DB.batch<T>(stmts);
  }

  get(key: string): Promise<R2ObjectBody | null> {
    this.spend(0, 1);
    return this.env.BUCKET.get(key);
  }

  head(key: string): Promise<R2Object | null> {
    this.spend(0, 1);
    return this.env.BUCKET.head(key);
  }

  put(key: string, body: string | Uint8Array | ReadableStream): Promise<R2Object | null> {
    this.spend(0, 1);
    return this.env.BUCKET.put(key, body, { httpMetadata: { contentType: "application/json" } });
  }

  /** Deletes up to 1000 objects in one operation. */
  del(keys: string | string[]): Promise<void> {
    this.spend(0, 1);
    return this.env.BUCKET.delete(keys);
  }

  list(options: R2ListOptions): Promise<R2Objects> {
    this.spend(0, 1);
    return this.env.BUCKET.list(options);
  }
}
