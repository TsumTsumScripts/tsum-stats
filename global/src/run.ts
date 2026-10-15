// One invocation's share of D1 and R2. Workers Free allows 50 D1 queries per
// invocation, so the hourly job (and a restore) counts what it issues and
// stops starting new work at RUN_QUERY_BUDGET queries or RUN_R2_BUDGET R2
// operations (CONTRACT §3.2). A batch counts each of its statements. It also
// adds up the rows D1 says it read and wrote, for the day's budget, and the
// bytes it carries to R2, which is where its CPU goes.
import { limits, type Env, type Limits } from "./env";

const arities = new Map<string, number>();
/** The highest ?N a statement names. */
function arity(sql: string): number {
  let n = arities.get(sql);
  if (n === undefined) {
    n = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map(m => Number(m[1])));
    arities.set(sql, n);
  }
  return n;
}

export class Run {
  queries = 0;
  r2 = 0;
  /** Rows D1 read and wrote for this run (meta.rows_read, meta.rows_written). */
  read = 0;
  written = 0;
  /** Bytes put to R2. */
  bytes = 0;
  /** What today's budget held when the run began (job.ts: open). */
  spentRows = 0;
  spentReads = 0;
  readonly lim: Limits;
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
    this.lim = limits(env);
    this.maxQueries = this.lim.runQueries;
    this.maxR2 = this.lim.runR2;
  }

  get now(): number {
    return this.nowMs / 1000;
  }

  /**
   * Whether q more queries, r more R2 operations and `bytes` more bytes fit.
   * The first unit of bytes always fits, so a big one still gets done.
   */
  room(q: number, r = 0, bytes = 0): boolean {
    return this.queries + q + this.reserve.q <= this.maxQueries && this.r2 + r + this.reserve.r2 <= this.maxR2 &&
      (bytes === 0 || this.bytes === 0 || this.bytes + bytes <= this.lim.runBytes);
  }

  /**
   * Whether n more rows written today stay within the day's budget. Work that
   * can wait for another day asks with a margin, which keeps the last of the
   * budget for the work that cannot.
   */
  canWrite(n: number, wait = true): boolean {
    const margin = wait ? Math.floor(this.lim.reserve / 5) : 0;
    return this.spentRows + this.written + n <= this.lim.budget - margin;
  }

  /** Whether n more rows read today stay within the day's read budget (only work that can wait asks). */
  canRead(n: number): boolean {
    return this.spentReads + this.read + n <= this.lim.reads;
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

  private note(res: D1Result): void {
    this.read += res.meta.rows_read ?? 0;
    this.written += res.meta.rows_written ?? 0;
  }

  /**
   * A statement to run later in batch(); not counted until then. D1 binds a
   * JS number as REAL, so SQL that turns one into text (a state key, a file's
   * contributor) casts it: CAST(?1 AS INTEGER). Statements of one step may
   * share a parameter list: each is bound up to the highest ?N it names, as
   * D1 wants exactly that many.
   */
  stmt(sql: string, ...params: unknown[]): D1PreparedStatement {
    return this.env.DB.prepare(sql).bind(...params.slice(0, arity(sql)));
  }

  async first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null> {
    return (await this.all<T>(sql, ...params))[0] ?? null;
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    this.spend(1, 0);
    const res = await this.stmt(sql, ...params).all<T>();
    this.note(res);
    return res.results;
  }

  async batch<T = Record<string, unknown>>(stmts: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    if (stmts.length === 0) return [];
    this.spend(stmts.length, 0);
    const res = await this.env.DB.batch<T>(stmts);
    res.forEach(r => this.note(r));
    return res;
  }

  get(key: string): Promise<R2ObjectBody | null> {
    this.spend(0, 1);
    return this.env.BUCKET.get(key);
  }

  head(key: string): Promise<R2Object | null> {
    this.spend(0, 1);
    return this.env.BUCKET.head(key);
  }

  put(key: string, body: string | Uint8Array, meta?: Record<string, string>): Promise<R2Object | null> {
    this.spend(0, 1);
    this.bytes += typeof body === "string" ? body.length : body.byteLength;
    return this.env.BUCKET.put(key, body, { httpMetadata: { contentType: "application/json" }, customMetadata: meta });
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
