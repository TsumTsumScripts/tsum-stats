// Contributors (CONTRACT §2.1, §2.3, §2.4): joining, the bearer check, the
// contributor's own record, and unlinking.
import { spend } from "./budget";
import { hmacHex, hmacKey, newKey, sha256Hex } from "./crypto";
import { dayOf } from "./days";
import { limits, type Env } from "./env";
import { HttpError, bearer, isoTime, ok, readObject } from "./http";

/** The contributor a request's key belongs to. */
export interface Contributor {
  id: number;
  status: string;
  day: string | null;
  day_rounds: number;
}

/** Joins a day from one address (joinAddress). */
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

/**
 * The address joins are counted against: an IPv4 address as it is, an IPv6
 * one by its /64, since a single host is usually handed a whole /64 to pick
 * addresses from. An IPv4 address written as IPv6 (::ffff:a.b.c.d) is IPv4.
 */
export function joinAddress(ip: string): string {
  const s = ip.trim().toLowerCase();
  if (!s.includes(":")) return s;
  const v4 = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) return v4[1];
  const [head, tail] = s.split("::", 2);
  const groups = (part: string | undefined) => (part ? part.split(":") : []).flatMap(g => {
    // An IPv4 tail (::1.2.3.4) is the last two groups.
    if (!g.includes(".")) return [g];
    const b = g.split(".").map(Number);
    return [((b[0] << 8) | b[1]).toString(16), ((b[2] << 8) | b[3]).toString(16)];
  });
  const h = groups(head), t = groups(tail);
  const all = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return all.slice(0, 4).map(g => g.padStart(4, "0")).join(":") + "::/64";
}

/** POST /api/v1/join: a new contributor and its key, shown once. */
export async function join(req: Request, env: Env, nowMs: number): Promise<Response> {
  const body = await readObject(req);
  const client = typeof body.client === "string" ? body.client.slice(0, 64) : null;
  const now = Math.floor(nowMs / 1000), day = dayOf(now);
  const lim = limits(env);
  const db = env.DB;
  const ip = await hmacHex(await hmacKey(env.DEVICE_KEY), joinAddress(req.headers.get("cf-connecting-ip") ?? ""));

  // The limit is checked in the batch that counts the join, and a refused join
  // writes nothing. Ids are never handed out twice, even after the newest
  // contributor's row is deleted: archive files and merges name contributors by id.
  const key = newKey();
  const [, , made] = await spend(db, nowMs, {
    // join_limits, the id sequence, and the contributor with its key's index.
    est: 4,
    cap: lim.budget - lim.reserve,
    checks: [db.prepare("INSERT INTO refusals (join_limit) SELECT 1 FROM join_limits WHERE ip_hash = ?1 AND day = ?2 AND n >= ?3")
      .bind(ip, day, JOINS_PER_DAY)],
  }, [
    db.prepare("INSERT INTO join_limits (ip_hash, day, n) VALUES (?1, ?2, 1) ON CONFLICT (ip_hash, day) DO UPDATE SET n = n + 1").bind(ip, day),
    db.prepare(`INSERT INTO state (key, value) VALUES ('contributor_seq', (SELECT max(id) + 1 FROM contributors))
      ON CONFLICT (key) DO UPDATE SET value = max(CAST(value AS INTEGER) + 1, (SELECT max(id) + 1 FROM contributors))`),
    db.prepare(`INSERT INTO contributors (id, key_hash, created_at, client)
      VALUES ((SELECT CAST(value AS INTEGER) FROM state WHERE key = 'contributor_seq'), ?1, ?2, ?3) RETURNING id`)
      .bind(await sha256Hex(key), now, client),
  ]);
  return ok({ id: (made.results[0] as { id: number }).id, key }, 201);
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
 * What the hourly job needs to finish unlinking contributor ?1 (unlink.ts):
 * every day whose rounds or archive files may name it, with about how many
 * rounds it has there (for the job's write budget), and the ids whose files
 * are its own (it, and every id merged into it). The days are its
 * contrib_cells days, all of them however long ago (read within its span, so
 * not the whole table), and the days of its rounds still pending.
 */
const UNLINK_STATE = `WITH RECURSIVE ids(id) AS (SELECT CAST(?1 AS INTEGER) UNION
      SELECT CAST(substr(s.key, 8) AS INTEGER) FROM state s, ids WHERE s.key >= 'merged:' AND s.key < 'merged;' AND CAST(s.value AS INTEGER) = ids.id),
    span AS (SELECT value ->> 'first' AS lo, value ->> 'last' AS hi FROM state WHERE key = 'span:' || CAST(?1 AS INTEGER)),
    days AS (SELECT day, sum(n) AS n FROM (
        SELECT day, rounds AS n FROM contrib_cells WHERE day >= (SELECT lo FROM span) AND day <= (SELECT hi FROM span) AND contributor = ?1
        UNION ALL SELECT d.value, p.n FROM pending p, json_each(p.days) d WHERE p.contributor = ?1)
      GROUP BY day)
  INSERT OR REPLACE INTO state (key, value) SELECT 'unlink:' || CAST(?1 AS INTEGER), json_object(
    'days', json((SELECT json_group_array(json_array(day, n)) FROM (SELECT day, n FROM days ORDER BY day))),
    'ids', json((SELECT json_group_array(id) FROM (SELECT id FROM ids ORDER BY id))))`;

/**
 * POST /api/v1/me/unlink. The key, devices and contrib_cells go now; the
 * hourly job (unlink.ts) re-files the rounds and renames the archive files.
 * The days whose files may name the contributor are noted first, in the same
 * batch, since contrib_cells is the record of them. Never refused: leaving
 * always works, and its writes are counted like any others.
 */
export async function unlink(env: Env, c: Contributor, nowMs: number): Promise<Response> {
  const db = env.DB;
  const span = "day >= (SELECT value ->> 'first' FROM state WHERE key = 'span:' || CAST(?1 AS INTEGER)) AND day <= (SELECT value ->> 'last' FROM state WHERE key = 'span:' || CAST(?1 AS INTEGER))";
  await spend(db, nowMs, { est: 3, cap: null }, [
    db.prepare(UNLINK_STATE).bind(c.id),
    db.prepare("UPDATE contributors SET key_hash = NULL, status = CASE status WHEN 'banned' THEN 'unlinking-banned' ELSE 'unlinking' END WHERE id = ?1").bind(c.id),
    db.prepare("DELETE FROM devices WHERE contributor = ?1").bind(c.id),
    db.prepare(`DELETE FROM contrib_cells WHERE ${span} AND contributor = ?1`).bind(c.id),
    db.prepare("DELETE FROM state WHERE key = 'span:' || CAST(?1 AS INTEGER)").bind(c.id),
    // The manifest's counts of people move with it.
    db.prepare("DELETE FROM recent WHERE contributor = ?1").bind(c.id),
    db.prepare("DELETE FROM state WHERE key = 'people'"),
  ]);
  return ok();
}
