// Contributors (CONTRACT §2.1, §2.3, §2.4): joining, the bearer check, the
// contributor's own record, and unlinking.
import { hmacHex, hmacKey, newKey, sha256Hex } from "./crypto";
import { addDays, dayOf } from "./days";
import { limits, type Env } from "./env";
import { HttpError, bearer, isoTime, ok, readObject, untilMidnight } from "./http";

/** The contributor a request's key belongs to. */
export interface Contributor {
  id: number;
  status: string;
  day: string | null;
  day_rounds: number;
}

/** Joins a day from one address (CF-Connecting-IP). */
const JOINS_PER_DAY = 5;

/** The contributor whose key the request carries; 401 for none, or one that is unlinked. */
export async function authContributor(req: Request, env: Env): Promise<Contributor> {
  const key = bearer(req);
  if (!key) throw new HttpError(401, "unauthorized");
  const c = await env.DB.prepare(
    "SELECT id, status, day, day_rounds FROM contributors WHERE key_hash = ?1 AND status IN ('active', 'banned')",
  ).bind(await sha256Hex(key)).first<Contributor>();
  if (!c) throw new HttpError(401, "unauthorized");
  return c;
}

/** POST /api/v1/join: a new contributor and its key, shown once. */
export async function join(req: Request, env: Env, nowMs: number): Promise<Response> {
  const body = await readObject(req);
  const client = typeof body.client === "string" ? body.client.slice(0, 64) : null;
  const now = Math.floor(nowMs / 1000);
  const ip = await hmacHex(await hmacKey(env.DEVICE_KEY), req.headers.get("cf-connecting-ip") ?? "");
  const seen = await env.DB.prepare(
    "INSERT INTO join_limits (ip_hash, day, n) VALUES (?1, ?2, 1) ON CONFLICT (ip_hash, day) DO UPDATE SET n = n + 1 RETURNING n",
  ).bind(ip, dayOf(now)).first<{ n: number }>();
  if (!seen || seen.n > JOINS_PER_DAY) throw new HttpError(429, "join-limit", untilMidnight(nowMs));

  // Ids are never handed out twice, even after the newest contributor's row
  // is deleted: archive files and merges name contributors by id.
  const key = newKey();
  const [, made] = await env.DB.batch<{ id: number }>([
    env.DB.prepare(`INSERT INTO state (key, value) VALUES ('contributor_seq', (SELECT max(id) + 1 FROM contributors))
      ON CONFLICT (key) DO UPDATE SET value = max(CAST(value AS INTEGER) + 1, (SELECT max(id) + 1 FROM contributors))`),
    env.DB.prepare(`INSERT INTO contributors (id, key_hash, created_at, client)
      VALUES ((SELECT CAST(value AS INTEGER) FROM state WHERE key = 'contributor_seq'), ?1, ?2, ?3) RETURNING id`)
      .bind(await sha256Hex(key), now, client),
  ]);
  return ok({ id: made.results[0].id, key }, 201);
}

/** GET /api/v1/me. */
export async function me(env: Env, c: Contributor, nowMs: number): Promise<Response> {
  const row = await env.DB.prepare(`SELECT id, created_at, last_seen, rounds_total, dup_rounds, day, day_rounds,
      (SELECT count(*) FROM devices WHERE contributor = c.id) AS devices,
      (SELECT value ->> 'first' FROM state WHERE key = 'span:' || c.id) AS first,
      (SELECT value ->> 'last' FROM state WHERE key = 'span:' || c.id) AS last
    FROM contributors c WHERE id = ?1`).bind(c.id).first<{
    id: number; created_at: number; last_seen: number | null; rounds_total: number; dup_rounds: number;
    day: string | null; day_rounds: number; devices: number; first: string | null; last: string | null;
  }>();
  if (!row) throw new HttpError(401, "unauthorized");
  return ok({
    id: row.id,
    // A banned contributor is not told.
    status: "active",
    since: dayOf(row.created_at),
    lastSeen: isoTime(row.last_seen),
    rounds: row.rounds_total,
    duplicates: row.dup_rounds,
    devices: row.devices,
    first: row.first,
    last: row.last,
    today: { rounds: row.day === dayOf(nowMs / 1000) ? row.day_rounds : 0, quota: limits(env).quota },
  });
}

/**
 * POST /api/v1/me/unlink. The key, devices and contrib_cells go now; the
 * hourly job (unlink.ts) re-files the rounds and renames the archive files.
 * The days whose files may name the contributor are noted first, since
 * contrib_cells is the record of them.
 */
export async function unlink(env: Env, c: Contributor, nowMs: number): Promise<Response> {
  const archivable = addDays(dayOf(nowMs / 1000), -limits(env).acceptDays);
  const db = env.DB;
  await db.batch([
    db.prepare(`INSERT OR REPLACE INTO state (key, value) SELECT 'unlink:' || CAST(?1 AS INTEGER), json_object('cursor', '', 'refiled', json('false'),
      'days', json((SELECT json_group_array(day) FROM (SELECT DISTINCT day FROM contrib_cells WHERE contributor = ?1 AND day <= ?2 ORDER BY day))))`)
      .bind(c.id, archivable),
    db.prepare("UPDATE contributors SET key_hash = NULL, status = CASE status WHEN 'banned' THEN 'unlinking-banned' ELSE 'unlinking' END WHERE id = ?1").bind(c.id),
    db.prepare("DELETE FROM devices WHERE contributor = ?1").bind(c.id),
    db.prepare("DELETE FROM contrib_cells WHERE contributor = ?1").bind(c.id),
    db.prepare("DELETE FROM state WHERE key = 'span:' || CAST(?1 AS INTEGER)").bind(c.id),
  ]);
  return ok();
}
