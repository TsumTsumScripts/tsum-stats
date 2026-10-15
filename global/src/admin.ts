// The admin routes (CONTRACT §2.5), behind the ADMIN_KEY secret. Their writes
// are counted in the day's budget. A merge, which may move many rounds, is
// refused (503 budget) when it would take the day past BUDGET_ROWS_PER_DAY;
// a ban, an unban or a rebuild writes a few rows and always goes through, so
// moderation never waits for a budget a bad contributor may have spent.
import { restore } from "./archive";
import { spend } from "./budget";
import { addDays, dayOf, isDay, keyDay } from "./days";
import { limits, type Env } from "./env";
import { HttpError, isoTime, ok, readObject } from "./http";
import { runJob } from "./job";

/** A rebuild marks at most this many days. */
const MAX_REBUILD_DAYS = 400;

/** The span of contributor ?1's contrib_cells days (state span:<id>), as a condition on `day`. */
const SPAN = `day >= (SELECT value ->> 'first' FROM state WHERE key = 'span:' || CAST(?1 AS INTEGER))
  AND day <= (SELECT value ->> 'last' FROM state WHERE key = 'span:' || CAST(?1 AS INTEGER))`;

/**
 * The days contributor ?1 has rounds in D1: its contrib_cells days not yet
 * dropped from D1, and the days of its rounds still pending.
 */
const DAYS_OF = `SELECT day FROM contrib_cells WHERE ${SPAN} AND contributor = ?1
    AND day > coalesce((SELECT value FROM state WHERE key = 'dropped_through'), '')
  UNION SELECT d.value FROM pending p, json_each(p.days) d WHERE p.contributor = ?1`;

/** Marks those days dirty: they are recomputed in full. */
const DIRTY_DAYS_OF = `INSERT OR IGNORE INTO dirty_days (day) SELECT day FROM (${DAYS_OF}) WHERE true`;

/** A day's key range in SQL (days.ts: dayRange), for a `day` column. */
const LO = "printf('%012x', unixepoch(day) * 1000) || '00000000000000000000'";
const HI = "printf('%012x', (unixepoch(day) + 86400) * 1000) || '00000000000000000000'";

const contributorId = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new HttpError(400, "bad-request");
  return v;
};

/** A contributor that is active or banned; 404 for none, 400 for one being unlinked. */
async function linked(env: Env, id: number): Promise<string> {
  const c = await env.DB.prepare("SELECT status FROM contributors WHERE id = ?1").bind(id).first<{ status: string }>();
  if (!c) throw new HttpError(404, "not-found");
  if (c.status !== "active" && c.status !== "banned") throw new HttpError(400, "bad-request");
  return c.status;
}

export async function contributors(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(`SELECT c.id, c.status, c.created_at, c.last_seen, c.client,
      c.rounds_total, c.dup_rounds, coalesce(d.n, 0) AS devices
    FROM contributors c LEFT JOIN (SELECT contributor, count(*) AS n FROM devices GROUP BY contributor) d ON d.contributor = c.id
    WHERE c.id != 0 ORDER BY c.id`).all<{
    id: number; status: string; created_at: number; last_seen: number | null; client: string | null;
    rounds_total: number; dup_rounds: number; devices: number;
  }>();
  return ok({
    contributors: results.map(c => ({
      id: c.id, status: c.status, createdAt: isoTime(c.created_at), lastSeen: isoTime(c.last_seen),
      client: c.client, rounds: c.rounds_total, duplicates: c.dup_rounds, devices: c.devices,
    })),
  });
}

/** POST /api/v1/admin/<action>. */
export async function adminPost(action: string, req: Request, env: Env, nowMs: number): Promise<Response> {
  const body = await readObject(req);
  const db = env.DB;
  const cap = limits(env).budget;
  switch (action) {
    case "ban":
    case "unban": {
      const id = contributorId(body.id);
      await linked(env, id);
      const status = action === "ban" ? "banned" : "active";
      const [, dirty] = await spend(db, nowMs, { est: 3, cap: null }, [
        db.prepare("UPDATE contributors SET status = ?2 WHERE id = ?1").bind(id, status),
        db.prepare(DIRTY_DAYS_OF).bind(id),
        // The manifest's counts of people are made again.
        db.prepare("DELETE FROM state WHERE key = 'people'"),
      ]);
      return ok({ id, status, days: dirty.meta.changes });
    }

    case "merge": {
      const from = contributorId(body.from), into = contributorId(body.into);
      if (from === into) throw new HttpError(400, "bad-request");
      await linked(env, from);
      await linked(env, into);
      // About what it writes: the rounds it moves and the rows of from it moves.
      const size = (await db.prepare(`SELECT
          coalesce((SELECT sum(rounds) FROM contrib_cells WHERE ${SPAN} AND contributor = ?1
            AND day > coalesce((SELECT value FROM state WHERE key = 'dropped_through'), '')), 0)
          + coalesce((SELECT sum(n) FROM pending WHERE contributor = ?1), 0) AS rounds,
          (SELECT count(*) FROM contrib_cells WHERE ${SPAN} AND contributor = ?1) AS cells,
          (SELECT count(*) FROM devices WHERE contributor = ?1) AS devices`).bind(from).first<{ rounds: number; cells: number; devices: number }>())!;
      // contrib_cells add up for days already archived; the days still in D1
      // are recomputed, which also counts their devices exactly. Its rounds
      // are found by day, so not by reading the whole rounds table.
      const deviceUnion = "SELECT value FROM json_each(contrib_cells.device_set) UNION SELECT value FROM json_each(excluded.device_set) ORDER BY 1";
      await spend(db, nowMs, { est: size.rounds + 2 * size.cells + 2 * size.devices + 8, cap }, [
        db.prepare(DIRTY_DAYS_OF).bind(from),
        db.prepare(`UPDATE rounds SET contributor = ?2 WHERE key IN (SELECT r.key FROM (${DAYS_OF}) d, rounds r
          WHERE r.key >= ${LO} AND r.key < ${HI} AND r.contributor = ?1)`).bind(from, into),
        db.prepare("UPDATE pending SET contributor = ?2 WHERE contributor = ?1").bind(from, into),
        db.prepare(`INSERT INTO contrib_cells (day, contributor, build, tsum, rounds, secs, base_sum, final_sum, medals_sum, devices, device_set)
          SELECT day, ?2, build, tsum, rounds, secs, base_sum, final_sum, medals_sum, devices, device_set FROM contrib_cells
          WHERE ${SPAN} AND contributor = ?1
          ON CONFLICT (day, contributor, build, tsum) DO UPDATE SET rounds = rounds + excluded.rounds, secs = secs + excluded.secs,
            base_sum = base_sum + excluded.base_sum, final_sum = final_sum + excluded.final_sum,
            medals_sum = medals_sum + excluded.medals_sum,
            device_set = (SELECT json_group_array(value) FROM (${deviceUnion})), devices = (SELECT count(*) FROM (${deviceUnion}))`).bind(from, into),
        db.prepare(`DELETE FROM contrib_cells WHERE ${SPAN} AND contributor = ?1`).bind(from),
        db.prepare(`INSERT INTO devices (device_hash, contributor, first_seen, last_seen, rounds)
          SELECT device_hash, ?2, first_seen, last_seen, rounds FROM devices WHERE contributor = ?1
          ON CONFLICT (device_hash, contributor) DO UPDATE SET first_seen = min(first_seen, excluded.first_seen),
            last_seen = max(last_seen, excluded.last_seen), rounds = rounds + excluded.rounds`).bind(from, into),
        db.prepare("DELETE FROM devices WHERE contributor = ?1").bind(from),
        db.prepare(`UPDATE contributors SET rounds_total = contributors.rounds_total + f.rounds_total,
            dup_rounds = contributors.dup_rounds + f.dup_rounds,
            last_seen = max(coalesce(contributors.last_seen, 0), coalesce(f.last_seen, 0)),
            day_rounds = CASE WHEN f.day = contributors.day THEN contributors.day_rounds + f.day_rounds
              WHEN f.day > coalesce(contributors.day, '') THEN f.day_rounds ELSE contributors.day_rounds END,
            day = nullif(max(coalesce(contributors.day, ''), coalesce(f.day, '')), '')
          FROM (SELECT * FROM contributors WHERE id = ?1) AS f WHERE contributors.id = ?2`).bind(from, into),
        db.prepare(`INSERT INTO state (key, value) SELECT 'span:' || CAST(?2 AS INTEGER), value FROM state WHERE key = 'span:' || CAST(?1 AS INTEGER)
          ON CONFLICT (key) DO UPDATE SET value = json_object('first', min(value ->> 'first', excluded.value ->> 'first'),
            'last', max(value ->> 'last', excluded.value ->> 'last'))`).bind(from, into),
        db.prepare("DELETE FROM state WHERE key = 'span:' || CAST(?1 AS INTEGER)").bind(from),
        // A restore files the archive's c<from>.json rounds under into.
        db.prepare("INSERT OR REPLACE INTO state (key, value) VALUES ('merged:' || CAST(?1 AS INTEGER), ?2)").bind(from, String(into)),
        db.prepare(`INSERT INTO recent (contributor, tsum, day) SELECT ?2, tsum, day FROM recent WHERE contributor = ?1
          ON CONFLICT (contributor, tsum) DO UPDATE SET day = excluded.day WHERE excluded.day > day`).bind(from, into),
        db.prepare("DELETE FROM recent WHERE contributor = ?1").bind(from),
        db.prepare("DELETE FROM contributors WHERE id = ?1").bind(from),
        db.prepare("DELETE FROM state WHERE key = 'people'"),
      ]);
      return ok({ from, into });
    }

    case "rebuild": {
      const now = Math.floor(nowMs / 1000);
      if ((body.from !== undefined && !isDay(body.from)) || (body.to !== undefined && !isDay(body.to))) {
        throw new HttpError(400, "bad-request");
      }
      let from = body.from as string | undefined;
      const to = (body.to as string | undefined) ?? dayOf(now);
      if (from === undefined) {
        // Every day with rounds in D1: from the oldest round's.
        const oldest = await db.prepare("SELECT key FROM rounds ORDER BY key LIMIT 1").first<{ key: string }>();
        if (!oldest) return ok({ days: 0 });
        from = keyDay(oldest.key);
      }
      const days: string[] = [];
      for (let d = from; d <= to && days.length <= MAX_REBUILD_DAYS; d = addDays(d, 1)) days.push(d);
      if (days.length > MAX_REBUILD_DAYS) throw new HttpError(400, "bad-request");
      await spend(db, nowMs, { est: days.length, cap: null }, [
        db.prepare("INSERT OR IGNORE INTO dirty_days (day) SELECT value FROM json_each(?1)").bind(JSON.stringify(days)),
      ]);
      return ok({ from, to, days: days.length });
    }

    case "restore": {
      if (!isDay(body.day)) throw new HttpError(400, "bad-request");
      return ok(await restore(env, body.day, nowMs));
    }

    case "rollup":
      return ok({ ...(await runJob(env, nowMs)) });
  }
  throw new HttpError(404, "not-found");
}
