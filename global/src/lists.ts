// Tsum Lists as evidence (CONTRACT §1.3). A Tsum List says what level each
// Tsum of an account was at when it was read, and a level never goes down, so
// a list bounds the level of that account's rounds before and after it: what
// no coins can show (800 rounds recorded at 6 on a level 1 Tsum look like
// nothing but themselves). Only a player's own app has the lists; it sends
// them here, with which list each device's rounds belong under where it knows
// (POST /api/v1/lists, §2.8), and the site works the levels out over the
// rounds it has, whoever's computer holds them now.
//
// The upload only stores (tsum_lists, device_links) and queues its
// contributor. The hourly job's step (evidenceStep) groups the contributor's
// lists into game accounts and reads their bounds with the page's own rules
// (ui/src/lib/accounts.js, which the local server ports), links each of its
// devices to an account, and keeps the result in skill_bound, which a day's
// full recompute applies ahead of the coin rules (rollup.ts: DAY_SOURCE). The
// days a changed bound can move go into dirty_days. It also writes each new
// list, and the links when they change, to archive/lists/.
import { groupAccounts, readingsOf, segmentsOf } from "../../ui/src/lib/accounts.js";
import { parseTime } from "../../ui/src/lib/snapshot/engine.js";
import { LINKED_CHECK, spend } from "./budget";
import type { Contributor } from "./contributors";
import { fromHex, hmacHex, hmacKey, sha256Hex } from "./crypto";
import { limits, type Env } from "./env";
import { HttpError, ok, readObject } from "./http";
import type { Job } from "./job";
import { TSUM_ID } from "./records";

export const LISTS_SCHEMA = "gap.tsum-lists/1";
/**
 * What the Worker does with Tsum Lists, as a number its replies carry
 * (rounds, /me): 1 is "/api/v1/lists is here". A forwarder sends none until
 * it has seen it. It is not `keeps`: no round is sent again for it.
 */
export const LISTS = 1;
/** What one request may hold, and one list. */
export const MAX_LISTS = 20, MAX_LINKS = 200, MAX_TSUMS = 2000;
const ROW_MAX = { columns: 16, name: 32, value: 128 };

const LIST_ID = /^[0-9a-f]{16}$/, TAG = /^[0-9a-f]{12}$/;

/** A list as sent, checked: its Tsums as canonical JSON (each row's columns sorted), or null when it cannot be kept whole. */
function readList(l: Record<string, unknown>): { id: string; build: number; stamp: number; n: number; tsums: string } | null {
  const id = typeof l.id === "string" ? l.id : "";
  const stamp = parseTime(l.stamp);
  const build = l.build === "jp" ? 1 : l.build === "global" ? 0 : -1;
  const rows = l.tsums;
  if (!LIST_ID.test(id) || stamp === null || build < 0 || !Array.isArray(rows) || rows.length < 1 || rows.length > MAX_TSUMS) return null;
  const out: Record<string, string>[] = [];
  for (const r of rows) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) return null;
    const entries = Object.entries(r as Record<string, unknown>);
    if (entries.length > ROW_MAX.columns) return null;
    const row: [string, string][] = [];
    for (const [k, v] of entries) {
      const s = typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null;
      if (s === null || k.length > ROW_MAX.name || s.length > ROW_MAX.value) return null;
      row.push([k, s]);
    }
    const o = Object.fromEntries(row.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
    if (!TSUM_ID.test(o.tsum ?? "")) return null;
    out.push(o);
  }
  return { id, build, stamp, n: out.length, tsums: JSON.stringify(out) };
}

/** Adds contributor ?1 to state evidence_queue: its lists or links changed, so its bounds are to be made again. */
export const QUEUE_EVIDENCE = `INSERT INTO state (key, value) VALUES ('evidence_queue', json_object(CAST(CAST(?1 AS INTEGER) AS TEXT), 1))
  ON CONFLICT (key) DO UPDATE SET value = json_set(value, '$."' || CAST(?1 AS INTEGER) || '"', 1)`;

/** POST /api/v1/lists: `{schema, lists: [...], links: [...]}` (CONTRACT §2.8). */
export async function postLists(req: Request, env: Env, c: Contributor, nowMs: number): Promise<Response> {
  return ok(await storeLists(await readObject(req), env, c, nowMs));
}

/** Checks a gap.tsum-lists/1 body's shape: 400 for one that cannot be read. */
export function checkLists(body: Record<string, unknown>): void {
  const lists = body.lists ?? [], links = body.links ?? [];
  const objects = (a: unknown) => Array.isArray(a) && a.every(x => x !== null && typeof x === "object" && !Array.isArray(x));
  if (body.schema !== LISTS_SCHEMA || !objects(lists) || !objects(links) || (lists as unknown[]).length > MAX_LISTS ||
    (links as unknown[]).length > MAX_LINKS || (lists as unknown[]).length + (links as unknown[]).length < 1) {
    throw new HttpError(400, "bad-request");
  }
}

/** Stores one gap.tsum-lists/1 body under contributor c; the reply's fields. */
export async function storeLists(body: Record<string, unknown>, env: Env, c: Contributor, nowMs: number): Promise<Record<string, unknown>> {
  checkLists(body);
  const lists = body.lists ?? [], links = body.links ?? [];
  const db = env.DB, lim = limits(env), now = Math.floor(nowMs / 1000);
  const reply = { accepted: 0, unchanged: 0, invalid: 0, links: { accepted: 0, unchanged: 0, invalid: 0 } };

  // The lists, the last of two with one id counting; and the links, each device tag re-keyed as a round id's is (§1.1).
  const sent = new Map<string, NonNullable<ReturnType<typeof readList>> & { hash: string }>();
  for (const l of lists as Record<string, unknown>[]) {
    const read = readList(l);
    if (!read) reply.invalid++;
    else sent.set(read.id, { ...read, hash: await sha256Hex(read.tsums) });
  }
  const deviceKey = await hmacKey(env.DEVICE_KEY);
  const hashes = new Map<string, string>();
  const linked = new Map<string, { build: number; device: string; list: string | null }>();
  for (const k of links as Record<string, unknown>[]) {
    const build = k.build === "jp" ? 1 : k.build === "global" ? 0 : -1;
    const tag = typeof k.tag === "string" ? k.tag : "";
    const list = k.list === null || k.list === undefined ? null : typeof k.list === "string" ? k.list : "?";
    if (build < 0 || !TAG.test(tag) || (list !== null && list !== "" && !LIST_ID.test(list))) {
      reply.links.invalid++;
      continue;
    }
    if (!hashes.has(tag)) hashes.set(tag, (await hmacHex(deviceKey, fromHex(tag))).slice(0, 12));
    linked.set(`${build}:${hashes.get(tag)}`, { build, device: hashes.get(tag)!, list });
  }

  // What D1 has of them, so only what changed is written.
  const [had, hadLinks] = await db.batch([
    db.prepare("SELECT l.id, l.hash, l.build, l.stamp FROM json_each(?1) j JOIN tsum_lists l ON l.contributor = ?2 AND l.grp = '' AND l.id = j.value")
      .bind(JSON.stringify([...sent.keys()]), c.id),
    db.prepare("SELECT build, device, list FROM device_links WHERE contributor = ?1 AND grp = ''").bind(c.id),
  ]);
  const reads = had.meta.rows_read + hadLinks.meta.rows_read;
  const stored = new Map((had.results as { id: string; hash: string; build: number; stamp: number }[]).map(l => [l.id, l]));
  const write = [...sent.values()].filter(l => {
    const s = stored.get(l.id);
    return !s || s.hash !== l.hash || s.build !== l.build || s.stamp !== l.stamp;
  });
  reply.accepted = write.length;
  reply.unchanged = sent.size - write.length;
  const storedLinks = new Map((hadLinks.results as { build: number; device: string; list: string | null }[]).map(k => [`${k.build}:${k.device}`, k.list]));
  // A link taken back that was never there is no news.
  const writeLinks = [...linked.entries()].filter(([key, k]) => (storedLinks.has(key) ? storedLinks.get(key) !== k.list : k.list !== null)).map(([, k]) => k);
  reply.links.accepted = writeLinks.length;
  reply.links.unchanged = linked.size - writeLinks.length;

  const stmts: D1PreparedStatement[] = [];
  for (const l of write) {
    // One statement a list: a list is one value, and D1 has its size to itself.
    stmts.push(db.prepare(`INSERT INTO tsum_lists (contributor, id, build, stamp, n, hash, tsums, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT (contributor, grp, id) DO UPDATE SET build = excluded.build, stamp = excluded.stamp, n = excluded.n, hash = excluded.hash,
        tsums = excluded.tsums, at = excluded.at, archived = 0`).bind(c.id, l.id, l.build, l.stamp, l.n, l.hash, l.tsums, now));
  }
  if (writeLinks.length) {
    stmts.push(db.prepare(`INSERT INTO device_links (contributor, build, device, list, at)
      SELECT ?1, k ->> 0, k ->> 1, k ->> 2, ?3 FROM (SELECT value AS k FROM json_each(?2)) WHERE true
      ON CONFLICT (contributor, grp, build, device) DO UPDATE SET list = excluded.list, at = excluded.at, archived = 0`)
      .bind(c.id, JSON.stringify(writeLinks.map(k => [k.build, k.device, k.list])), now));
  }
  if (stmts.length) {
    stmts.push(db.prepare(QUEUE_EVIDENCE).bind(c.id));
    await spend(db, nowMs, { est: write.length + writeLinks.length + 1, cap: lim.budget - lim.reserve, reads, checks: [db.prepare(LINKED_CHECK).bind(c.id)] }, stmts);
  }
  return { ...reply, lists: LISTS };
}

// ---- The job's step ----

/** A contributor's lists as the grouping reads them: each Tsum's skill (1-10) and level, in SQL, so the Worker never parses a list. */
const READINGS = `SELECT id, build, stamp, archived, coalesce((SELECT json_group_object(t.value ->> 'tsum', json_array(CAST(t.value ->> 'skill' AS INTEGER), CAST(t.value ->> 'level' AS INTEGER)))
    FROM json_each(l.tsums) t WHERE CAST(t.value ->> 'skill' AS INTEGER) BETWEEN 1 AND 10), '{}') AS readings
  FROM tsum_lists l WHERE contributor = ?1 AND grp = '' ORDER BY stamp, id`;

/** What reading one contributor's evidence costs (one batch), and writing its bounds at most. */
const READ_QUERIES = 5, WRITE_QUERIES = 6;
/** Lists one run writes to the archive at most, a query and a put each. */
const ARCHIVE_PER_RUN = 6;

type BoundRow = [string, number, string, number, number, number];

/**
 * The bounds a contributor's lists and links give its devices (CONTRACT
 * §3.2, step 1b'): [tsum, build, device, from_at, floor, cap] rows, for the
 * Tsums in `played`. A device is linked, per game, to the account its link
 * names a list of; to none when its link says "not known"; and with no link,
 * to the game's account when the contributor's lists of that game are one
 * account's.
 */
export function boundsOf(
  lists: { id: string; build: number; stamp: number; readings: Record<string, [number, number]> }[],
  links: { build: number; device: string; list: string | null }[], devices: string[], played: Set<string>,
): BoundRow[] {
  const accounts = groupAccounts(lists.map(l => ({
    id: l.id, build: l.build, at: l.stamp,
    skill: Object.fromEntries(Object.entries(l.readings).map(([t, [s]]) => [t, s])),
    // A level not read is left out, as the local server leaves a NULL out.
    level: Object.fromEntries(Object.entries(l.readings).filter(([, [, lv]]) => lv > 0).map(([t, [, lv]]) => [t, lv])),
  }))) as { build: number; lists: { id: string }[] }[];
  const byList = new Map<string, number>();
  accounts.forEach((a, i) => a.lists.forEach(l => byList.set(l.id, i)));
  const said = new Map(links.map(k => [`${k.build}:${k.device}`, k.list]));
  const segments = new Map<number, [string, [number, number, number][]][]>();
  const out: BoundRow[] = [];
  for (const build of [0, 1]) {
    const ofBuild = accounts.map((a, i) => (a.build === build ? i : -1)).filter(i => i >= 0);
    // Every device the contributor has sent rounds of, and any a link names.
    const all = new Set([...devices, ...links.filter(k => k.build === build).map(k => k.device)]);
    for (const device of [...all].sort()) {
      const link = said.get(`${build}:${device}`);
      let account = -1;
      if (link === "") continue;
      if (link && byList.has(link)) account = byList.get(link)!;
      else if (ofBuild.length === 1) account = ofBuild[0];
      if (account < 0) continue;
      if (!segments.has(account)) {
        segments.set(account, Object.entries(readingsOf(accounts[account]) as Record<string, [number, number][]>)
          .filter(([t]) => played.has(t)).map(([t, r]) => [t, segmentsOf(r, 0) as [number, number, number][]]));
      }
      for (const [tsum, segs] of segments.get(account)!) for (const [from, floor, cap] of segs) out.push([tsum, build, device, from, floor, cap]);
    }
  }
  return out;
}

/** The days with rounds of the (tsum, build, device) triples ?1, by skill_units. */
const DAYS_OF = `SELECT DISTINCT u.day FROM json_each(?1) c JOIN skill_units u
  ON u.tsum = c.value ->> 0 AND u.build = c.value ->> 1 AND u.device = c.value ->> 2`;
/** Of those, the ones whose rounds are in D1 (after ?2, dropped_through, or restored: ?3): to recompute. */
const DIRTY = `INSERT OR IGNORE INTO dirty_days (day) SELECT day FROM (${DAYS_OF}) WHERE day > ?2 OR day IN (SELECT value FROM json_each(?3))`;
/** And the ones whose rounds have left D1, into state evidence_days: they wait for a restore (admin restore {evidence}). */
const EVIDENCE_DAYS = `INSERT INTO state (key, value)
  SELECT 'evidence_days', json_group_array(day) FROM (SELECT value AS day FROM json_each(coalesce((SELECT value FROM state WHERE key = 'evidence_days'), '[]'))
    UNION SELECT day FROM (${DAYS_OF}) WHERE day <= ?2 AND day NOT IN (SELECT value FROM json_each(?3)) ORDER BY 1) WHERE true
  ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE value IS NOT excluded.value`;

/**
 * Step 1b' of the hourly job: for each contributor whose lists or links
 * changed (state evidence_queue), its bounds made again, and its new lists
 * and changed links written to archive/lists/. A contributor leaves the
 * queue once both are done.
 */
export async function evidenceStep(job: Job): Promise<void> {
  const { run } = job;
  let archived = 0;
  for (const id of job.evidenceQueue) {
    if (!run.room(READ_QUERIES + WRITE_QUERIES + 2, 1)) {
      job.more = true;
      return;
    }
    const [lists, links, devices, recent, bounds] = await run.batch([
      run.stmt(READINGS, id),
      run.stmt("SELECT build, device, list, archived FROM device_links WHERE contributor = ?1 AND grp = ''", id),
      run.stmt("SELECT device_hash FROM devices WHERE contributor = ?1", id),
      run.stmt("SELECT tsum FROM recent WHERE contributor = ?1", id),
      run.stmt("SELECT tsum, build, device, from_at, floor, cap FROM skill_bound WHERE contributor = ?1", id),
    ]);
    const mine = lists.results as unknown as { id: string; build: number; stamp: number; archived: number; readings: string }[];
    const said = links.results as unknown as { build: number; device: string; list: string | null; archived: number }[];
    const want = boundsOf(mine.map(l => ({ ...l, readings: JSON.parse(l.readings) })), said,
      (devices.results as { device_hash: string }[]).map(d => d.device_hash), new Set((recent.results as { tsum: string }[]).map(r => r.tsum)));
    // Per device's Tsum, its rows as one word: the ones that differ are written, and their days made again.
    const word = (rows: BoundRow[]) => {
      const m = new Map<string, string[]>();
      for (const [t, b, d, from, floor, cap] of rows) {
        const k = JSON.stringify([t, b, d]);
        m.set(k, [...(m.get(k) ?? []), `${from}:${floor}:${cap}`]);
      }
      return new Map([...m].map(([k, v]) => [k, v.sort().join(",")]));
    };
    const now = word(want), was = word((bounds.results as { tsum: string; build: number; device: string; from_at: number; floor: number; cap: number }[])
      .map(b => [b.tsum, b.build, b.device, b.from_at, b.floor, b.cap]));
    const changed = [...new Set([...now.keys(), ...was.keys()])].filter(k => now.get(k) !== was.get(k));
    if (changed.length) {
      const triples = JSON.stringify(changed.map(k => JSON.parse(k)));
      const rows = want.filter(([t, b, d]) => changed.includes(JSON.stringify([t, b, d])));
      if (!run.canWrite(2 * (rows.length + changed.length) + 40)) {
        job.more = true;
        return;
      }
      const dropped = job.droppedThrough, restored = JSON.stringify(job.restored.map(([d]) => d));
      await run.batch([
        run.stmt(`DELETE FROM skill_bound WHERE contributor = ?2 AND (tsum, build, device) IN (SELECT value ->> 0, value ->> 1, value ->> 2 FROM json_each(?1))`, triples, id),
        run.stmt(`INSERT INTO skill_bound (tsum, build, device, contributor, from_at, floor, cap)
          SELECT value ->> 0, value ->> 1, value ->> 2, ?2, value ->> 3, value ->> 4, value ->> 5 FROM json_each(?1)`, JSON.stringify(rows), id),
        // The days those devices played those Tsums: recomputed when their rounds are in D1, else kept for a restore.
        run.stmt(DIRTY, triples, dropped, restored),
        run.stmt(EVIDENCE_DAYS, triples, dropped, restored),
      ]);
      job.more = true; // the days it marked are the next run's
      job.report.evidence.push(id);
    }

    // The archive: each list not there yet, then the links when one changed.
    let left = false;
    for (const l of mine.filter(x => !x.archived)) {
      if (archived >= ARCHIVE_PER_RUN || !run.room(2 + 2, 1)) {
        left = true;
        break;
      }
      const f = await run.first<{ hash: string; body: string }>(`SELECT hash, json_object('kind', 'tsum-global-list', 'format', 1, 'contributor', contributor, 'id', id,
        'build', build, 'stamp', stamp, 'at', at, 'hash', hash, 'n', n, 'tsums', json(tsums)) AS body FROM tsum_lists WHERE contributor = ?1 AND grp = '' AND id = ?2`, id, l.id);
      if (!f) continue;
      await put(job, `${listsPrefix(id)}${l.id}.${f.hash.slice(0, 8)}.json`, f.body);
      await run.batch([run.stmt("UPDATE tsum_lists SET archived = 1 WHERE contributor = ?1 AND grp = '' AND id = ?2 AND hash = ?3", id, l.id, f.hash)]);
      archived++;
    }
    if (!left && said.some(k => !k.archived)) {
      if (!run.room(2 + 2, 1)) left = true;
      else {
        const f = await run.first<{ body: string }>(`SELECT json_object('kind', 'tsum-global-links', 'format', 1, 'contributor', CAST(?1 AS INTEGER), 'at', CAST(?2 AS INTEGER),
          'links', json_group_array(json_object('build', build, 'device', device, 'list', list, 'at', at))) AS body FROM device_links WHERE contributor = ?1 AND grp = ''`, id, Math.floor(run.now));
        await put(job, `${listsPrefix(id)}links.${Math.floor(run.now)}.json`, f!.body);
        await run.batch([run.stmt("UPDATE device_links SET archived = 1 WHERE contributor = ?1 AND grp = ''", id)]);
      }
    }
    if (left) {
      job.more = true;
      return;
    }
    await run.batch([run.stmt(`UPDATE state SET value = json_remove(value, '$."' || CAST(?1 AS INTEGER) || '"') WHERE key = 'evidence_queue'`, id)]);
  }
}

/** Where a contributor's lists and links are in the archive; `who` is c<id>, or what an unlink renamed it to. */
export const listsPrefix = (who: number | string) => `archive/lists/${typeof who === "number" ? "c" + who : who}/`;
/** A lists or links file's contributor, as its JSON begins: what an unlink blanks. */
export const NAMED_LISTS = /^(\{"kind":"tsum-global-(?:list|links)","format":\d+,"contributor":)\d+,/;

async function put(job: Job, key: string, body: string): Promise<void> {
  const bytes = new TextEncoder().encode(body);
  const obj = await job.run.put(key, bytes);
  if (!obj || obj.size !== bytes.byteLength) throw new Error(`lists: ${key} was not stored whole`);
}
