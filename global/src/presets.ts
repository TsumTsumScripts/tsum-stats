// The preset gallery (CONTRACT §2.7): contributors submit Tsum share codes; the hourly job
// publishes the visible ones as presets.json (publishPresets). Codes are read with the page's
// own codec over the script's synced table, and refused when any field can't be read, so a
// code from a script newer than the table is never stored with a setting silently dropped.
import { spend } from "./budget";
import { TSUMS } from "./catalog";
import type { Contributor } from "./contributors";
import { limits, type Env } from "./env";
import { HttpError, isoTime, ok, readObject } from "./http";
import { DATA } from "./parts";
import type { Job } from "./job";
import { SCRIPT_VERSION, TABLE, read } from "../../ui/src/lib/presets/shareCode.js";

export const NAME_MAX = 40;
export const DESCRIPTION_MAX = 280;
/** A contributor's presets at once, and new ones a UTC day. */
export const PER_CONTRIBUTOR = 50;
export const PER_DAY = 20;
/** The newest this many visible presets are published. */
export const PUBLISH_MAX = 2000;
/** State key: the published file is out of date. */
export const DIRTY = "presets_dirty";
export const FILE = "presets.json";

/**
 * Marks presets.json for the next run (a statement for a caller's batch). A fresh value each time,
 * so the job clears only the mark it published for, never one set while it worked.
 */
export const markDirty = (db: D1Database) =>
  db.prepare(`INSERT OR REPLACE INTO state (key, value) VALUES ('${DIRTY}', lower(hex(randomblob(8))))`);

/** A name as the script keeps one: whitespace collapsed, trimmed, cut to 40. */
export const cleanName = (raw: string) => raw.replace(/\s+/g, " ").trim().slice(0, NAME_MAX).trimEnd();

const SKILL_DEFAULT = (TABLE.slots as ({ key: string; default: unknown } | null)[]).find(s => s?.key === "skillType")?.default as string;

/** POST /api/v1/presets {code, name?, description?, tsum?}: 201 {id}. */
export async function submit(req: Request, env: Env, c: Contributor, nowMs: number): Promise<Response> {
  const body = await readObject(req);
  if (typeof body.code !== "string" || body.code.length > 2000) throw new HttpError(400, "bad-request");
  const got = read(body.code) as { presets: { name: string | null; code: string; values: Record<string, unknown>; skipped: number }[]; bad: number; otherFormat: boolean };
  // Exactly one code, read whole.
  if (got.otherFormat) throw new HttpError(400, "old-code");
  if (got.presets.length !== 1 || got.bad) throw new HttpError(400, "bad-code");
  const p = got.presets[0];
  if (p.skipped) throw new HttpError(400, "newer-code");
  const name = cleanName(typeof body.name === "string" ? body.name : p.name ?? "");
  if (!name) throw new HttpError(400, "bad-name");
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (description.length > DESCRIPTION_MAX) throw new HttpError(400, "bad-description");
  const tsum = typeof body.tsum === "string" && body.tsum !== "" ? body.tsum : null;
  if (tsum !== null && !TSUMS.has(tsum)) throw new HttpError(400, "bad-tsum");

  const db = env.DB;
  const now = Math.floor(nowMs / 1000);
  const dayStart = now - (now % 86400);
  const counts = await db.prepare("SELECT count(*) AS total, count(*) FILTER (WHERE created_at >= ?2) AS today FROM presets WHERE contributor = ?1")
    .bind(c.id, dayStart).first<{ total: number; today: number }>();
  if ((counts?.total ?? 0) >= PER_CONTRIBUTOR) throw new HttpError(429, "preset-limit");
  if ((counts?.today ?? 0) >= PER_DAY) throw new HttpError(429, "preset-limit");

  const lim = limits(env);
  const [made] = await spend(db, nowMs, { est: 3, cap: lim.budget - lim.reserve }, [
    db.prepare(`INSERT INTO presets (contributor, name, description, tsum, skill, code, script, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id`)
      .bind(c.id, name, description, tsum, String(p.values.skillType ?? SKILL_DEFAULT), p.code, SCRIPT_VERSION, now),
    markDirty(db),
  ]);
  return ok({ id: (made.results[0] as { id: number }).id }, 201);
}

interface Row {
  id: number; name: string; description: string; tsum: string | null; skill: string; code: string;
  script: string; created_at: number; hidden: number;
}

const shape = (r: Row) => ({
  id: r.id, name: r.name, description: r.description, tsum: r.tsum, skill: r.skill, code: r.code,
  script: r.script, createdAt: isoTime(r.created_at),
});

/** GET /api/v1/presets/mine: the contributor's own, newest first, taken-down ones marked. */
export async function mine(env: Env, c: Contributor): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT * FROM presets WHERE contributor = ?1 ORDER BY id DESC").bind(c.id).all<Row>();
  return ok({ presets: results.map(r => ({ ...shape(r), hidden: r.hidden === 1 })) });
}

/** POST /api/v1/presets/delete {id}: one of the contributor's own; 404 for any other. */
export async function remove(req: Request, env: Env, c: Contributor, nowMs: number): Promise<Response> {
  const id = presetId((await readObject(req)).id);
  const db = env.DB;
  const [del] = await spend(db, nowMs, { est: 2, cap: null }, [
    db.prepare("DELETE FROM presets WHERE id = ?1 AND contributor = ?2").bind(id, c.id),
    markDirty(db),
  ]);
  if (!del.meta.changes) throw new HttpError(404, "not-found");
  return ok();
}

/** Admin takedown {id, hidden}: hides or shows one preset. Never refused for the budget. */
export async function takedown(body: Record<string, unknown>, env: Env, nowMs: number): Promise<Response> {
  const id = presetId(body.id);
  const hidden = body.hidden === false ? 0 : 1;
  const db = env.DB;
  const [upd] = await spend(db, nowMs, { est: 2, cap: null }, [
    db.prepare("UPDATE presets SET hidden = ?2 WHERE id = ?1").bind(id, hidden),
    markDirty(db),
  ]);
  if (!upd.meta.changes) throw new HttpError(404, "not-found");
  return ok({ id, hidden: hidden === 1 });
}

const presetId = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new HttpError(400, "bad-request");
  return v;
};

/**
 * The job's step: when presets changed, D1 builds presets.json (the newest PUBLISH_MAX visible
 * presets of active contributors) and it is put to R2; then the mark it published for is cleared.
 * Two queries and one R2 operation.
 */
export async function publishPresets(job: Job): Promise<void> {
  const run = job.run;
  if (job.presetsDirty === null || !run.room(2, 1)) return;
  const doc = await run.first<{ doc: string }>(`SELECT json_object('kind', 'tsum-presets', 'format', 1,
      'generatedAt', strftime('%Y-%m-%dT%H:%M:%SZ', ?1, 'unixepoch'), 'script', ?2,
      'presets', json((SELECT coalesce(json_group_array(json_object('id', id, 'name', name, 'description', description,
        'tsum', tsum, 'skill', skill, 'code', code, 'script', script,
        'createdAt', strftime('%Y-%m-%dT%H:%M:%SZ', created_at, 'unixepoch'))), '[]')
      FROM (SELECT p.* FROM presets p JOIN contributors c ON c.id = p.contributor
        WHERE p.hidden = 0 AND c.status = 'active' ORDER BY p.id DESC LIMIT ?3)))) AS doc`,
  Math.floor(run.now), SCRIPT_VERSION, PUBLISH_MAX);
  await run.put(DATA + FILE, doc!.doc);
  await run.all("DELETE FROM state WHERE key = ?1 AND value = ?2", DIRTY, job.presetsDirty);
}
