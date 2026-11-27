// The level a contributor's own app counts a round at (CONTRACT §1.3): its
// Tsum Lists know what the site cannot. An upload carries it with the round
// (ingest.ts); POST /api/v1/levels (§2.8) sends it alone, for a round the
// site already has, at any age: a correction is the one thing an archived
// day still takes. Both write round_levels, which a day's full recompute
// reads (rollup.ts: DAY_SOURCE), and level_log, which the hourly job writes
// to archive/levels/ (levelLogStep), so every level sent is kept for good.
import { LINKED_CHECK, spend } from "./budget";
import type { Contributor } from "./contributors";
import { fromHex, hmacHex, hmacKey } from "./crypto";
import { keyDay } from "./days";
import { limits, type Env } from "./env";
import { HttpError, ok, readObject } from "./http";
import type { Job } from "./job";
import { UUID7, readLevel } from "./records";

export const LEVELS_SCHEMA = "gap.round-levels/1";
export const MAX_LEVELS = 500;
/**
 * What the Worker does with levels, as a number its replies carry (rounds,
 * /me): 1 is "an upload may carry skill_eff and skill_src, and /api/v1/levels
 * is here". A forwarder sends neither until it has seen it, since a Worker
 * before it would file the two columns as settings.
 */
export const LEVELS = 1;

/** A level to store: [round key, level, source], or [key, null, null] to take the round's back. */
export type LevelChange = [string, number | null, string | null];

/** The statements that store `changes` at `now` (epoch s): round_levels, and each change in level_log. Two rows a change. */
export function levelStatements(db: D1Database, changes: LevelChange[], now: number): D1PreparedStatement[] {
  if (!changes.length) return [];
  const json = JSON.stringify(changes);
  return [
    db.prepare(`INSERT INTO round_levels (key, level, source, at)
      SELECT l ->> 0, l ->> 1, l ->> 2, ?2 FROM (SELECT value AS l FROM json_each(?1)) WHERE l ->> 1 IS NOT NULL
      ON CONFLICT (key) DO UPDATE SET level = excluded.level, source = excluded.source, at = excluded.at`).bind(json, now),
    db.prepare("DELETE FROM round_levels WHERE key IN (SELECT value ->> 0 FROM json_each(?1) WHERE value ->> 1 IS NULL)").bind(json),
    db.prepare("INSERT INTO level_log (key, level, source, at) SELECT value ->> 0, value ->> 1, value ->> 2, ?2 FROM json_each(?1)").bind(json, now),
  ];
}

/** Adds the days ?1 (a JSON array) to state level_days: days out of D1 with a level to apply (admin restore {levels}). */
const LEVEL_DAYS = `INSERT INTO state (key, value)
  SELECT 'level_days', json_group_array(day) FROM (SELECT value AS day FROM json_each(coalesce((SELECT value FROM state WHERE key = 'level_days'), '[]'))
    UNION SELECT value FROM json_each(?1) ORDER BY 1) WHERE true
  ON CONFLICT (key) DO UPDATE SET value = excluded.value`;

/**
 * POST /api/v1/levels: `{schema, levels: [{id, skill_eff, skill_src}]}`, each
 * a round this contributor sent before, by its id as sent, with the level its
 * app counts it at now; both empty takes the level back. Nothing else of the
 * round can change here.
 */
export async function postLevels(req: Request, env: Env, c: Contributor, nowMs: number): Promise<Response> {
  const body = await readObject(req);
  const items = body.levels;
  if (body.schema !== LEVELS_SCHEMA || !Array.isArray(items) || items.length < 1 || items.length > MAX_LEVELS ||
    !items.every(r => r !== null && typeof r === "object" && !Array.isArray(r))) {
    throw new HttpError(400, "bad-request");
  }
  const db = env.DB, lim = limits(env), now = Math.floor(nowMs / 1000);
  // Each item's key, as an upload makes it (records.ts: checkRecords), and its level. The last of two for one round counts.
  const deviceKey = await hmacKey(env.DEVICE_KEY);
  const tags = new Map<string, string>();
  const want = new Map<string, { level: number; source: string } | null>();
  let invalid = 0;
  for (const it of items as Record<string, unknown>[]) {
    const id = typeof it.id === "string" ? it.id.trim() : "";
    const level = readLevel(it.skill_eff, it.skill_src);
    if (!UUID7.test(id) || level === "bad") {
      invalid++;
      continue;
    }
    const hex = id.replaceAll("-", ""), tag = hex.slice(20);
    if (!tags.has(tag)) tags.set(tag, (await hmacHex(deviceKey, fromHex(tag))).slice(0, 12));
    want.set(hex.slice(0, 20) + tags.get(tag)!, level);
  }

  // What D1 has: each round's contributor and level, this contributor's devices, and the days that have left D1.
  let accepted = 0, unchanged = 0, unknown = 0, foreign = 0, reads = 0;
  const changes: LevelChange[] = [];
  const dirty = new Set<string>(), away = new Set<string>();
  if (want.size) {
    const [had, devices, state] = await db.batch([
      db.prepare(`SELECT j.value AS key, r.contributor, l.level, l.source FROM json_each(?1) j
        LEFT JOIN rounds r ON r.key = j.value LEFT JOIN round_levels l ON l.key = j.value`).bind(JSON.stringify([...want.keys()])),
      db.prepare("SELECT d.device_hash FROM json_each(?1) j JOIN devices d ON d.device_hash = j.value AND d.contributor = ?2")
        .bind(JSON.stringify([...tags.values()]), c.id),
      db.prepare("SELECT key, value FROM state WHERE key IN ('dropped_through', 'restored')"),
    ]);
    reads = had.meta.rows_read + devices.meta.rows_read + state.meta.rows_read;
    const mine = new Set((devices.results as { device_hash: string }[]).map(d => d.device_hash));
    const st = new Map((state.results as { key: string; value: string }[]).map(s => [s.key, s.value]));
    const dropped = st.get("dropped_through") ?? "";
    const restored = new Set((JSON.parse(st.get("restored") ?? "[]") as [string, number][]).map(([d]) => d));
    for (const h of had.results as { key: string; contributor: number | null; level: number | null; source: string | null }[]) {
      const day = keyDay(h.key), to = want.get(h.key)!;
      // A round whose day has left D1 cannot be looked up: it is taken for a device this contributor sent rounds of.
      const gone = h.contributor === null && dropped !== "" && day <= dropped && !restored.has(day);
      if (h.contributor === null && !(gone && mine.has(h.key.slice(20)))) unknown++;
      else if (h.contributor !== null && h.contributor !== c.id) foreign++;
      else if ((h.level === null ? "" : `${h.level}:${h.source}`) === (to ? `${to.level}:${to.source}` : "")) unchanged++;
      else {
        accepted++;
        changes.push([h.key, to?.level ?? null, to?.source ?? null]);
        (gone ? away : dirty).add(day);
      }
    }
  }
  const stmts = levelStatements(db, changes, now);
  if (dirty.size) stmts.push(db.prepare("INSERT OR IGNORE INTO dirty_days (day) SELECT value FROM json_each(?1)").bind(JSON.stringify([...dirty])));
  if (away.size) stmts.push(db.prepare(LEVEL_DAYS).bind(JSON.stringify([...away])));
  if (stmts.length) {
    await spend(db, nowMs, { est: 2 * changes.length + dirty.size + (away.size ? 1 : 0), cap: lim.budget - lim.reserve, reads,
      checks: [db.prepare(LINKED_CHECK).bind(c.id)] }, stmts);
  }
  return ok({ accepted, unchanged, unknown, foreign, invalid, levels: LEVELS });
}

/** Rows of level_log one file takes at most. */
const LOG_ROWS = 5000;

/**
 * The hourly job's step for level_log: its oldest rows into one file,
 * archive/levels/<first seq>-<last seq>.json, then out of D1. A few rows a
 * run usually; nothing when the log is empty (job.ts: open counts it).
 */
export async function levelLogStep(job: Job): Promise<void> {
  const { run } = job;
  while (job.levelLog > 0) {
    if (!run.room(2, 1) || !run.canWrite(Math.min(job.levelLog, LOG_ROWS) + 1)) {
      job.more = true;
      return;
    }
    const f = await run.first<{ lo: number | null; hi: number | null; n: number; body: string }>(`SELECT min(seq) AS lo, max(seq) AS hi, count(*) AS n,
        json_object('kind', 'tsum-global-levels', 'format', 1,
          'levels', json_group_array(json_object('seq', seq, 'key', key, 'level', level, 'source', source, 'at', at))) AS body
      FROM (SELECT * FROM level_log ORDER BY seq LIMIT ?1)`, LOG_ROWS);
    if (!f || f.lo === null || f.hi === null) {
      job.levelLog = 0;
      return;
    }
    const bytes = new TextEncoder().encode(f.body);
    const obj = await run.put(`archive/levels/${f.lo}-${f.hi}.json`, bytes);
    if (!obj || obj.size !== bytes.byteLength) throw new Error("levels: the file was not stored whole");
    await run.batch([run.stmt("DELETE FROM level_log WHERE seq <= ?1", f.hi)]);
    job.levelLog -= f.n;
  }
}
