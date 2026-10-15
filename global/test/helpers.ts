// Test helpers: call the Worker directly with a chosen clock, make rounds the
// way the Tsum script does, and read D1 and R2 back.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { sqlTime } from "../../ui/src/lib/snapshot/engine.js";
import type { Env } from "../src/env";
import { handle } from "../src/index";
import { runJob, type Report } from "../src/job";

export { env };

/** The tests' "now": 2026-10-14 18:00 UTC. */
export const NOW = Date.UTC(2026, 9, 14, 18, 0, 0);
export const DAY_MS = 86400 * 1000;
export const ADMIN = "test-admin-key";

export interface CallInit {
  method?: string;
  body?: unknown;
  /** Sent as is, instead of JSON.stringify(body). */
  raw?: BodyInit;
  key?: string;
  headers?: Record<string, string>;
  ip?: string;
  now?: number;
  env?: Env;
}

export async function call(path: string, init: CallInit = {}): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": init.ip ?? "203.0.113.1", ...(init.headers ?? {}) };
  if (init.key) headers.authorization = "Bearer " + init.key;
  let body: BodyInit | undefined = init.raw;
  if (body === undefined && init.body !== undefined) body = JSON.stringify(init.body);
  const method = init.method ?? (body !== undefined ? "POST" : "GET");
  // Every POST says it is JSON, as the forwarder's do, unless a test says otherwise.
  if (method === "POST" && !Object.keys(headers).some(h => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  const req = new Request("https://tsum-stats.gapscripts.app" + path, { method, headers, body });
  const ctx = createExecutionContext();
  const res = await handle(req, init.env ?? env, ctx, init.now ?? NOW);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function json<T = Record<string, unknown>>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

let ips = 0;
/** A new contributor, from its own address so the join limit stays out of the way. */
export async function joinNew(now = NOW): Promise<{ id: number; key: string }> {
  const res = await call("/api/v1/join", { body: { client: "tsum-stats/test" }, ip: `198.51.100.${++ips}`, now });
  expect(res.status).toBe(201);
  return json(res);
}

export const admin = (action: string, body: unknown = {}, now = NOW) =>
  call("/api/v1/admin/" + action, { body, key: ADMIN, now });

const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
let seq = 0;

/** A UUIDv7 as roundStats.ts: statsUuidV7 makes it: start ms, random bits, the device tag. */
export function uuid7(startMs: number, tag: string, rand = ++seq): string {
  const time = hex(startMs, 12);
  const tail = hex(rand * 2654435761 % 0x10000000, 7);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${tail.slice(0, 3)}-${"89ab"[parseInt(tail[6], 16) & 3]}${tail.slice(3, 6)}-${tag}`;
}

export const TAG_A = "a1b2c3d4e5f6";
export const TAG_B = "0f1e2d3c4b5a";

export interface RoundSpec {
  /** End time (played_at), ms. */
  at?: number;
  /** Seconds from start to end. */
  took?: number;
  tag?: string;
  tsum?: string;
  build?: string;
  duration?: number | string;
  score?: number | string;
  base?: number | string;
  final?: number | string;
  medals?: number | string;
  skill?: number | string;
  /** Items used, as their setting names; null for settings from before items. */
  items?: string[] | null;
  version?: string;
  extra?: Record<string, string>;
  id?: string;
}

const ITEMS = ["bonusCoin", "bonus5to4", "bonusTime", "bonusExp", "bonusScore", "bonusBubble", "bonusCombo"];

/** A stats CSV row keyed by its header, every value text. */
export function record(s: RoundSpec = {}): Record<string, string> {
  const at = s.at ?? NOW - 3600 * 1000;
  const took = s.took ?? 190;
  const rec: Record<string, string> = {
    id: s.id ?? uuid7(at - took * 1000, s.tag ?? TAG_A),
    datetime: sqlTime(Math.floor(at / 1000)),
    script_version: s.version ?? "3.0b4",
    skill_type: "",
    tsum: s.tsum ?? "mickey",
    build: s.build ?? "global",
    duration_seconds: String(s.duration ?? 181.5),
    score: String(s.score ?? 12345678),
    base_coins: String(s.base ?? 3000),
    final_coins: String(s.final ?? 4500),
    medals: s.medals === undefined ? "" : String(s.medals),
    skillLevel: String(s.skill ?? 5),
    ...(s.extra ?? {}),
  };
  if (s.items !== null) {
    const used = new Set(s.items ?? ["bonusCoin", "bonusTime"]);
    for (const name of ITEMS) rec[name] = used.has(name) ? "T" : "F";
  }
  return rec;
}

/** Rounds a device played one after another, `gap` seconds apart, ending before `end`. */
export function series(n: number, spec: RoundSpec & { end?: number; gap?: number } = {}): Record<string, string>[] {
  const gap = spec.gap ?? 200;
  const end = spec.end ?? NOW - 3600 * 1000;
  return Array.from({ length: n }, (_, i) => record({ ...spec, at: end - (n - 1 - i) * gap * 1000 }));
}

export const batch = (records: unknown[]) => ({
  schema: "gap.round-stats/1", script: { id: "app.gap.Tsum" }, source: "tsum-stats", sentAt: new Date(NOW).toISOString(), records,
});

export async function upload(key: string, records: unknown[], now = NOW) {
  const res = await call("/api/v1/rounds", { body: batch(records), key, now });
  return { status: res.status, headers: res.headers, body: await json<{
    ok: boolean; accepted: number; unchanged: number; duplicates: number; rejected: Record<string, number>; error?: string;
  }>(res) };
}

/** Runs the hourly job until it says nothing is left (or `runs` times). */
export async function rollup(now = NOW, e: Env = env, runs = 50): Promise<Report[]> {
  const out: Report[] = [];
  for (let i = 0; i < runs; i++) {
    const r = await runJob(e, now);
    out.push(r);
    if (!r.more) break;
  }
  return out;
}

export async function rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...params).all<T>()).results;
}

export async function one<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T> {
  return (await env.DB.prepare(sql).bind(...params).first<T>())!;
}

export async function r2json<T = Record<string, unknown>>(key: string): Promise<T | null> {
  const obj = await env.BUCKET.get(key);
  return obj ? ((await obj.json()) as T) : null;
}

export async function r2keys(prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix, cursor });
    out.push(...page.objects.map(o => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.sort();
}

/** Empties D1's data tables (not the migration's contributor 0) and the bucket, for a fresh start. */
export async function wipe(): Promise<void> {
  await env.DB.batch([
    "DELETE FROM contributors WHERE id != 0", "DELETE FROM devices", "DELETE FROM settings", "DELETE FROM rounds",
    "DELETE FROM dirty_days", "DELETE FROM pending", "DELETE FROM budget", "DELETE FROM join_limits", "DELETE FROM state", "DELETE FROM cells",
    "DELETE FROM bins", "DELETE FROM cell_bins", "DELETE FROM contrib_cells", "DELETE FROM recent",
  ].map(s => env.DB.prepare(s)));
  const keys = await r2keys("");
  for (let i = 0; i < keys.length; i += 1000) await env.BUCKET.delete(keys.slice(i, i + 1000));
}
