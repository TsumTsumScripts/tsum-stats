// What the rollup should produce, worked out in plain JS from the rounds
// table, and a test dataset to compare it on. Also an env whose D1 and R2
// count every call, independently of the job's own counter.
import { expect } from "vitest";
import { bin, keyDay } from "../src/days";
import type { Env } from "../src/env";
import { DAY_MS, NOW, env, joinNew, record, rows, upload, type RoundSpec } from "./helpers";

export interface RoundRow {
  key: string;
  contributor: number;
  played_at: number;
  build: number;
  tsum: string;
  skill: number;
  items: number;
  duration: number;
  score: number;
  base: number;
  final: number;
  medals: number | null;
}

const REAL = new Set(["secs", "base_sq", "final_sq", "medals_sq", "medals_secs"]);

const group = <T>(list: T[], key: (x: T) => string) => {
  const out = new Map<string, T[]>();
  for (const x of list) out.set(key(x), [...(out.get(key(x)) ?? []), x]);
  return out;
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const minOf = (xs: number[]) => (xs.length ? Math.min(...xs) : null);
const maxOf = (xs: number[]) => (xs.length ? Math.max(...xs) : null);

/** The cells, bins and contrib_cells the rounds make; hidden contributors are banned, anon ones unlinking. */
export function reference(rounds: RoundRow[], hidden: Set<number>, anon: Set<number> = new Set()) {
  const pub = rounds.filter(r => !hidden.has(r.contributor));
  const cells = [...group(pub, r => JSON.stringify([keyDay(r.key), r.build, r.tsum, r.skill, r.items, (r.medals ?? 0) > 0 ? 1 : 0])).entries()]
    .map(([k, rs]) => {
      const [day, build, tsum, skill, items, medal] = JSON.parse(k);
      const m = rs.filter(r => r.medals !== null);
      return {
        day, build, tsum, skill, items, medal, rounds: rs.length, secs: sum(rs.map(r => r.duration)),
        score_sum: sum(rs.map(r => r.score)), score_min: minOf(rs.map(r => r.score)), score_max: maxOf(rs.map(r => r.score)),
        first: minOf(rs.map(r => r.played_at)), last: maxOf(rs.map(r => r.played_at)),
        base_sum: sum(rs.map(r => r.base)), base_sq: sum(rs.map(r => r.base ** 2)), base_min: minOf(rs.map(r => r.base)), base_max: maxOf(rs.map(r => r.base)),
        final_sum: sum(rs.map(r => r.final)), final_sq: sum(rs.map(r => r.final ** 2)), final_min: minOf(rs.map(r => r.final)), final_max: maxOf(rs.map(r => r.final)),
        medals_n: m.length, medals_sum: sum(m.map(r => r.medals!)), medals_sq: sum(m.map(r => r.medals! ** 2)),
        medals_min: minOf(m.map(r => r.medals!)), medals_max: maxOf(m.map(r => r.medals!)), medals_secs: sum(m.map(r => r.duration)),
      };
    });
  const counts = (vs: number[]) => {
    const o: Record<string, number> = {};
    for (const v of vs) o[String(v)] = (o[String(v)] ?? 0) + 1;
    return o;
  };
  const bins = [...group(pub, r => JSON.stringify([keyDay(r.key), r.build, r.tsum, r.skill])).entries()].map(([k, rs]) => {
    const [day, build, tsum, skill] = JSON.parse(k);
    return {
      day, build, tsum, skill, base: counts(rs.map(r => bin(r.base))), final: counts(rs.map(r => bin(r.final))),
      medals: counts(rs.filter(r => (r.medals ?? 0) > 0).map(r => bin(r.medals!))),
    };
  });
  const named = rounds.filter(r => r.contributor !== 0 && !anon.has(r.contributor));
  const contrib = [...group(named, r => JSON.stringify([keyDay(r.key), r.contributor, r.build, r.tsum])).entries()].map(([k, rs]) => {
    const [day, contributor, build, tsum] = JSON.parse(k);
    return {
      day, contributor, build, tsum, rounds: rs.length, secs: sum(rs.map(r => r.duration)), base_sum: sum(rs.map(r => r.base)),
      final_sum: sum(rs.map(r => r.final)), medals_sum: sum(rs.map(r => r.medals ?? 0)), devices: new Set(rs.map(r => r.key.slice(20))).size,
    };
  });
  return { cells, bins, contrib };
}

const order = (keys: string[]) => (a: Record<string, unknown>, b: Record<string, unknown>) => {
  for (const k of keys) {
    if (a[k]! < b[k]!) return -1;
    if (a[k]! > b[k]!) return 1;
  }
  return 0;
};
export const CELL_KEY = ["day", "build", "tsum", "skill", "items", "medal"];
export const BIN_KEY = ["day", "build", "tsum", "skill"];
export const CONTRIB_KEY = ["day", "contributor", "build", "tsum"];

/** Rows equal, in any order: integers exactly, REAL sums to rounding. */
export function sameRows(got: Record<string, unknown>[], want: Record<string, unknown>[], key: string[]) {
  const g = [...got].sort(order(key)), w = [...want].sort(order(key));
  expect(g.map(r => key.map(k => r[k]))).toEqual(w.map(r => key.map(k => r[k])));
  g.forEach((row, i) => {
    for (const [col, v] of Object.entries(w[i])) {
      if (REAL.has(col)) expect(row[col] as number, `${col} of ${JSON.stringify(key.map(k => row[k]))}`).toBeCloseTo(v as number, 6);
      else expect(row[col], `${col} of ${JSON.stringify(key.map(k => row[k]))}`).toEqual(v);
    }
  });
}

/** The tables as D1 has them, bins parsed. */
export async function tables() {
  return {
    cells: await rows("SELECT * FROM cells"),
    bins: (await rows<Record<string, unknown> & { base: string; final: string; medals: string }>("SELECT * FROM bins"))
      .map((b): Record<string, unknown> => ({ ...b, base: JSON.parse(b.base), final: JSON.parse(b.final), medals: JSON.parse(b.medals) })),
    contrib: await rows("SELECT * FROM contrib_cells"),
  };
}

/** The tables match the reference over D1's rounds; `days` limits it to the days D1 still has. */
export async function checkAgainstReference(hidden: Set<number>, anon: Set<number> = new Set(), days?: string[]) {
  const want = reference(await rows<RoundRow>("SELECT * FROM rounds"), hidden, anon);
  const got = await tables();
  const only = <T extends Record<string, unknown>>(list: T[]) => (days ? list.filter(r => days.includes(r.day as string)) : list);
  sameRows(only(got.cells), want.cells, CELL_KEY);
  sameRows(only(got.bins), want.bins, BIN_KEY);
  sameRows(only(got.contrib), want.contrib, CONTRIB_KEY);
  return want;
}

/** A small deterministic generator (mulberry32). */
export function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TSUMS = ["mickey", "minnie", "donald", "mickeyplus", "aliceplus", "beastda"];
const ITEM_SETS: (string[] | null)[] = [null, [], ["bonusCoin"], ["bonusCoin", "bonusTime"], ["bonusTime", "bonusScore", "bonusCombo"], ["bonus5to4", "bonusBubble"]];

/**
 * One device's rounds ending between `from` and `to` (ms): each starts 10-200 s
 * after the last ended, with figures that vary enough to fill many cells. A
 * few last hours, as some Tsums' rounds do, so some cross midnight.
 */
export function deviceRounds(rnd: () => number, tag: string, from: number, to: number): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (let start = from; ;) {
    const duration = rnd() < 0.03 ? Math.round(3600 + rnd() * 4 * 3600) : Math.round((30 + rnd() * 400) * 2) / 2;
    const took = Math.ceil(duration) + 5 + Math.floor(rnd() * 10);
    const at = start + took * 1000;
    if (at >= to) break;
    const tsum = TSUMS[Math.floor(rnd() * TSUMS.length)];
    const base = Math.floor(rnd() * (rnd() < 0.1 ? 90 : 6000));
    const spec: RoundSpec = {
      at, took, tag, tsum, duration,
      build: rnd() < 0.7 ? "global" : "jp",
      score: Math.floor(rnd() * 30_000_000),
      base, final: Math.floor(base * (1 + rnd())),
      skill: rnd() < 0.15 ? "" : 1 + Math.floor(rnd() * 6),
      items: ITEM_SETS[Math.floor(rnd() * ITEM_SETS.length)],
    };
    if (tsum.endsWith("plus")) spec.medals = rnd() < 0.3 ? 0 : Math.floor(rnd() * 400);
    else if (rnd() < 0.05) spec.medals = Math.floor(rnd() * 10);
    out.push(record(spec));
    start = at + 10_000 + Math.floor(rnd() * 190_000);
  }
  return out;
}

/** Sends a contributor's records in batches of 250, expecting each accepted. */
export async function send(key: string, records: Record<string, string>[], now = NOW) {
  let accepted = 0;
  for (let i = 0; i < records.length; i += 250) {
    const res = await upload(key, records.slice(i, i + 250), now);
    expect(res.status).toBe(200);
    accepted += res.body.accepted;
  }
  return accepted;
}

/**
 * Three contributors with two devices each over the `days` days before NOW,
 * with rounds across every midnight; the second also re-sends some of the
 * first's rounds.
 */
export async function dataset(days = 3, seed = 7, now = NOW) {
  const rnd = random(seed);
  const people = [await joinNew(now), await joinNew(now), await joinNew(now)];
  const tags = [["0a0000000001", "0a0000000002"], ["0b0000000001", "0b0000000002"], ["0c0000000001", "0c0000000002"]];
  const sent: Record<string, string>[][] = [];
  for (let p = 0; p < 3; p++) {
    const recs = tags[p].flatMap(tag => deviceRounds(rnd, tag, now - days * DAY_MS, now - 1800_000));
    recs.sort((a, b) => (a.id < b.id ? -1 : 1));
    sent.push(recs);
    await send(people[p].key, recs, now);
  }
  await upload(people[1].key, sent[0].slice(0, 20), now);
  return { people, sent };
}

/** D1 refuses to make a string or blob longer than this (Miniflare does not). */
export const D1_VALUE_MAX = 2_000_000;

/**
 * An env whose D1 and R2 count each query (a batch: each statement) and
 * operation, what each write touched, and every row D1 says it read and
 * wrote (first() is run as all(), so its meta counts too). With `valueMax`, a
 * statement given or giving back a string longer than that fails as D1 would.
 */
export function counted(base: Env = env, opts: { valueMax?: number } = {}) {
  const n = {
    q: 0, r2: 0, read: 0, written: 0,
    writes: [] as { sql: string; rows: number }[],
    bySql: new Map<string, { n: number; read: number; written: number }>(),
  };
  const real = new WeakMap<object, D1PreparedStatement>();
  const sqlOf = new WeakMap<object, string>();
  const tooBig = (v: unknown) => typeof v === "string" && v.length > (opts.valueMax ?? Infinity);
  const check = (sql: string, params: unknown[], rows: unknown[]) => {
    if (params.some(tooBig) || rows.some(r => Object.values(r as object).some(tooBig))) {
      throw new Error(`D1_ERROR: string or blob too big: SQLITE_TOOBIG (${sql.trim().slice(0, 60)})`);
    }
  };
  const note = (sql: string, r: D1Result) => {
    n.read += r.meta.rows_read ?? 0;
    n.written += r.meta.rows_written ?? 0;
    const k = sql.replace(/\s+/g, " ").trim().slice(0, 90);
    const e = n.bySql.get(k) ?? { n: 0, read: 0, written: 0 };
    e.n++;
    e.read += r.meta.rows_read ?? 0;
    e.written += r.meta.rows_written ?? 0;
    n.bySql.set(k, e);
  };
  const paramsOf = new WeakMap<object, unknown[]>();
  const wrap = (s: D1PreparedStatement, sql: string, params: unknown[] = []): D1PreparedStatement => {
    const p = new Proxy(s, {
      get(t, k) {
        if (k === "bind") return (...a: unknown[]) => wrap(t.bind(...a), sql, a);
        if (k === "first" || k === "all" || k === "run" || k === "raw") {
          return async (...a: unknown[]) => {
            n.q++;
            if (k === "raw") return t.raw(...(a as []));
            const r = await t.all();
            check(sql, params, r.results);
            note(sql, r);
            if (k !== "first") return r;
            const row = r.results[0] as Record<string, unknown> | undefined;
            return row === undefined ? null : typeof a[0] === "string" ? row[a[0]] : row;
          };
        }
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    real.set(p, s);
    sqlOf.set(p, sql);
    paramsOf.set(p, params);
    return p;
  };
  const DB = {
    prepare: (sql: string) => wrap(base.DB.prepare(sql), sql),
    batch: async (stmts: D1PreparedStatement[]) => {
      n.q += stmts.length;
      for (const s of stmts) check(sqlOf.get(s) ?? "", paramsOf.get(s) ?? [], []);
      const res = await base.DB.batch(stmts.map(s => real.get(s) ?? s));
      res.forEach((r, i) => {
        const sql = sqlOf.get(stmts[i]) ?? "";
        check(sql, [], r.results ?? []);
        note(sql, r);
        n.writes.push({ sql, rows: r.meta.rows_written ?? 0 });
      });
      return res;
    },
  } as unknown as D1Database;
  const BUCKET = new Proxy(base.BUCKET, {
    get(t, k) {
      const v = Reflect.get(t, k);
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => {
        if (["get", "put", "head", "delete", "list"].includes(String(k))) n.r2++;
        return v.apply(t, a);
      };
    },
  });
  return {
    env: { ...base, DB, BUCKET } as Env, n,
    reset: () => Object.assign(n, { q: 0, r2: 0, read: 0, written: 0, writes: [], bySql: new Map() }),
    /** The statements that read or wrote most, for a failing test's message. */
    top: (k = 8) => [...n.bySql].sort((a, b) => b[1].read + 50 * b[1].written - a[1].read - 50 * a[1].written).slice(0, k)
      .map(([s, e]) => `${e.n}x read ${e.read} written ${e.written}: ${s}`).join("\n"),
  };
}
