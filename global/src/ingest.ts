// POST /api/v1/rounds (CONTRACT §2.2): one gap.round-stats/1 batch. The rows
// D1 already has are read first, so an unchanged re-send writes no rounds.
// Then one D1 batch checks the contributor's quota, the day's budget and that
// the contributor has not unlinked meanwhile, and makes every write, so two
// uploads at once cannot both pass a limit, and none lands after an unlink. The new
// rounds, added up as the day tables keep them, also go to `pending`, from
// which the hourly job adds them in without reading the rounds table again.
import { LINKED_CHECK, spend } from "./budget";
import type { Contributor } from "./contributors";
import { hmacKey } from "./crypto";
import { dayOf, keyDay } from "./days";
import { limits, type Env } from "./env";
import { HttpError, ok, readObject } from "./http";
import { checkRecords, type Round } from "./records";

export const SCHEMA = "gap.round-stats/1";
export const MAX_RECORDS = 250;

/** A round D1 already has, with its settings' hash to compare by. */
interface Stored {
  key: string;
  contributor: number;
  played_at: number;
  build: number;
  tsum: string;
  skill: number;
  items: number;
  version: string;
  hash: string | null;
  duration: number;
  score: number;
  base: number;
  final: number;
  medals: number | null;
}

/** The figures a re-send may change: everything but the key and who sent it first. */
const FIGURES = [
  "played_at", "build", "tsum", "skill", "items", "version", "settings",
  "duration", "score", "base", "final", "medals", "bin_base", "bin_final", "bin_medals",
];

const same = (s: Stored, r: Round) =>
  s.played_at === r.playedAt && s.build === r.build && s.tsum === r.tsum && s.skill === r.skill &&
  s.items === r.items && s.version === r.version && s.hash === r.settingsHash && s.duration === r.duration &&
  s.score === r.score && s.base === r.base && s.final === r.final && s.medals === r.medals;

// One row per round in json_each(?1): [key, played_at, build, tsum, skill, items,
// version, settings hash, duration, score, base, final, medals, bins...]. The
// settings ids are looked up once, as a map, for the batch's hashes ?3. A
// conflict updates only this contributor's row, and only when it changed.
const UPSERT_ROUNDS = `INSERT INTO rounds (key, contributor, ${FIGURES.join(", ")})
  SELECT r->>0, ?2, r->>1, r->>2, r->>3, r->>4, r->>5, r->>6,
    (SELECT json_group_object(hash, id) FROM settings WHERE hash IN (SELECT value FROM json_each(?3))) ->> ('$."' || (r->>7) || '"'),
    r->>8, r->>9, r->>10, r->>11, r->>12, r->>13, r->>14, r->>15
  FROM (SELECT value AS r FROM json_each(?1)) WHERE true
  ON CONFLICT (key) DO UPDATE SET ${FIGURES.map(f => `${f} = excluded.${f}`).join(", ")}
  WHERE rounds.contributor = excluded.contributor
    AND (${FIGURES.map(f => `rounds.${f}`).join(", ")}) IS NOT (${FIGURES.map(f => `excluded.${f}`).join(", ")})`;

/**
 * Right after UPSERT_ROUNDS: when it wrote fewer rows than ?2 (another upload
 * stored one of these rounds first, a moment ago), the days ?1 are recomputed
 * in full, so the pending sums below, which count them, are never added on
 * top: a recompute reads the pending rows up to then as done (rollup.ts: skip).
 */
const RACED = "INSERT OR IGNORE INTO dirty_days (day) SELECT value FROM json_each(?1) WHERE changes() < ?2";

// `bins` is the old per-skill bins column, no longer written (migrations/0002_cell_bins.sql).
const PENDING = "INSERT INTO pending (contributor, n, days, tsums, cells, bins, cell_bins, cc) VALUES (?1, ?2, ?3, ?4, ?5, '[]', ?6, ?7)";

const row = (r: Round) => [
  r.key, r.playedAt, r.build, r.tsum, r.skill, r.items, r.version, r.settingsHash,
  r.duration, r.score, r.base, r.final, r.medals, r.binBase, r.binFinal, r.binMedals,
];

/** A bin's figures (CONTRACT §5): its rounds and their seconds, score, base coins, final coins and medals. */
export type BinFigures = [number, number, number, number, number, number];

/**
 * New rounds added up as the day tables keep them (rollup.ts: CELLS), for
 * the hourly job: cells and cell_bins rows of the catalog's Tsums (a Tsum it
 * lacks stays out of the public figures), and contrib_cells rows by device. A
 * few rows a batch, so the job reads a few rows for a hundred rounds.
 */
export function aggregate(rounds: Round[]) {
  const cells = new Map<string, (string | number | null)[]>();
  const bins = new Map<string, [string, number, string, number, number, number, ...Record<string, BinFigures>[]]>();
  const cc = new Map<string, (string | number)[]>();
  const min = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));
  const max = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));
  for (const r of rounds) {
    const day = keyDay(r.key);
    const medal = r.medals !== null && r.medals > 0 ? 1 : 0;
    if (r.known) {
      const k = JSON.stringify([day, r.build, r.tsum, r.skill, r.items, medal]);
      const m = r.medals, read = m !== null;
      const c = cells.get(k);
      if (!c) {
        cells.set(k, [day, r.build, r.tsum, r.skill, r.items, medal, 1, r.duration, r.score, r.score, r.score, r.playedAt, r.playedAt,
          r.base, r.base * r.base, r.base, r.base, r.final, r.final * r.final, r.final, r.final,
          read ? 1 : 0, m ?? 0, read ? m! * m! : 0, m, m, read ? r.duration : 0]);
      } else {
        const v = c as number[];
        v[6]++; v[7] += r.duration; v[8] += r.score; v[9] = Math.min(v[9], r.score); v[10] = Math.max(v[10], r.score);
        v[11] = Math.min(v[11], r.playedAt); v[12] = Math.max(v[12], r.playedAt);
        v[13] += r.base; v[14] += r.base * r.base; v[15] = Math.min(v[15], r.base); v[16] = Math.max(v[16], r.base);
        v[17] += r.final; v[18] += r.final * r.final; v[19] = Math.min(v[19], r.final); v[20] = Math.max(v[20], r.final);
        if (read) {
          v[21]++; v[22] += m!; v[23] += m! * m!; v[26] += r.duration;
          c[24] = min(c[24] as number | null, m); c[25] = max(c[25] as number | null, m);
        }
      }
      // The cell's bins: each of its rounds counted in the bin of its base
      // coins, of its final coins and, when it earned any, of its medals.
      let g = bins.get(k);
      if (!g) bins.set(k, (g = [day, r.build, r.tsum, r.skill, r.items, medal, {}, {}, {}]));
      for (const [kind, b] of [[6, r.binBase], [7, r.binFinal], [8, r.binMedals]] as const) {
        if (b === null) continue;
        const o = g[kind] as Record<string, BinFigures>;
        const f = (o[b] ??= [0, 0, 0, 0, 0, 0]);
        f[0]++; f[1] += r.duration; f[2] += r.score; f[3] += r.base; f[4] += r.final; f[5] += m ?? 0;
      }
    }
    const ck = JSON.stringify([day, r.build, r.tsum, r.device]);
    const e = cc.get(ck);
    if (!e) cc.set(ck, [day, r.build, r.tsum, r.device, 1, r.duration, r.base, r.final, r.medals ?? 0]);
    else {
      const v = e as number[];
      v[4]++; v[5] += r.duration; v[6] += r.base; v[7] += r.final; v[8] += r.medals ?? 0;
    }
  }
  return { cells: [...cells.values()], bins: [...bins.values()], cc: [...cc.values()] };
}

function readBatch(body: Record<string, unknown>): Record<string, unknown>[] {
  const records = body.records;
  if (body.schema !== SCHEMA || !Array.isArray(records) || records.length < 1 || records.length > MAX_RECORDS ||
    !records.every(r => r !== null && typeof r === "object" && !Array.isArray(r))) {
    throw new HttpError(400, "bad-request");
  }
  return records;
}

export async function postRounds(req: Request, env: Env, c: Contributor, nowMs: number): Promise<Response> {
  const records = readBatch(await readObject(req));
  const lim = limits(env);
  const db = env.DB;
  // A day already in the archive is final, even if ACCEPT_DAYS has grown since.
  const archived = await db.prepare("SELECT value FROM state WHERE key = 'archived_through'").all<{ value: string }>();
  let reads = archived.meta.rows_read ?? 0;
  const { rounds, rejected, retry } = await checkRecords(records, nowMs, lim.acceptDays, await hmacKey(env.DEVICE_KEY), archived.results[0]?.value);
  const now = Math.floor(nowMs / 1000), today = dayOf(now);

  // What D1 has of this batch: its rounds, its settings and this contributor's
  // rows for its devices, so the writes below can be counted before they run.
  let stored = new Map<string, Stored>();
  const knownSettings = new Set<string>();
  const knownDevices = new Map<string, { first_seen: number; last_seen: number }>();
  const hashes = [...new Set(rounds.map(r => r.settingsHash))];
  const tags = [...new Set(rounds.map(r => r.device))];
  if (rounds.length) {
    const [had, settings, devices] = await db.batch([
      db.prepare(`SELECT r.key, r.contributor, r.played_at, r.build, r.tsum, r.skill, r.items, r.version, s.hash,
          r.duration, r.score, r.base, r.final, r.medals
        FROM json_each(?1) j JOIN rounds r ON r.key = j.value LEFT JOIN settings s ON s.id = r.settings`)
        .bind(JSON.stringify(rounds.map(r => r.key))),
      db.prepare("SELECT s.hash FROM json_each(?1) j JOIN settings s ON s.hash = j.value").bind(JSON.stringify(hashes)),
      db.prepare(`SELECT d.device_hash, d.first_seen, d.last_seen FROM json_each(?1) j
        JOIN devices d ON d.device_hash = j.value AND d.contributor = ?2`).bind(JSON.stringify(tags), c.id),
    ]);
    stored = new Map((had.results as unknown as Stored[]).map(s => [s.key, s]));
    for (const s of settings.results as { hash: string }[]) knownSettings.add(s.hash);
    for (const d of devices.results as { device_hash: string; first_seen: number; last_seen: number }[]) knownDevices.set(d.device_hash, d);
    reads += had.meta.rows_read + settings.meta.rows_read + devices.meta.rows_read;
  }

  // New rows and this contributor's changed ones are written; another
  // contributor's are theirs. Every device seen is recorded, so a player's
  // second install shows up under the first one's devices.
  const write: Round[] = [];
  const fresh = new Set<string>();
  const freshTsums: Record<string, string> = {};
  const changedDays = new Set<string>();
  const devices = new Map<string, { first: number; last: number; rounds: number }>();
  let unchanged = 0, duplicates = 0;
  for (const r of rounds) {
    const d = devices.get(r.device) ?? { first: r.playedAt, last: r.playedAt, rounds: 0 };
    d.first = Math.min(d.first, r.playedAt);
    d.last = Math.max(d.last, r.playedAt);
    devices.set(r.device, d);
    const s = stored.get(r.key);
    if (!s) {
      write.push(r);
      const day = keyDay(r.key);
      fresh.add(day);
      if (!(freshTsums[r.tsum] >= day)) freshTsums[r.tsum] = day;
      d.rounds++;
    } else if (s.contributor !== c.id) {
      duplicates++;
    } else if (same(s, r)) {
      unchanged++;
    } else {
      // A changed round is not added on top of its old figures: its day is
      // recomputed in full. Its day is its start's, from the key, so a changed
      // end never moves it.
      write.push(r);
      changedDays.add(keyDay(r.key));
    }
  }
  const accepted = write.length;

  // The rows each statement writes, as D1 counts them (an indexed settings row is two).
  const newSettings = new Map(write.filter(r => !knownSettings.has(r.settingsHash)).map(r => [r.settingsHash, r.settings]));
  const deviceRows = [...devices].filter(([h, d]) => {
    const had = knownDevices.get(h);
    return !had || d.rounds > 0 || d.first < had.first_seen || d.last > had.last_seen;
  });
  const freshRows = write.filter(r => !stored.has(r.key));
  const est = accepted + 2 * newSettings.size + deviceRows.length + 1 + (freshRows.length ? 2 : 0) + changedDays.size;

  const stmts: D1PreparedStatement[] = [];
  if (accepted) {
    if (newSettings.size) {
      stmts.push(db.prepare(`INSERT INTO settings (hash, json) SELECT s->>0, s->>1 FROM (SELECT value AS s FROM json_each(?1)) WHERE true
        ON CONFLICT (hash) DO NOTHING`).bind(JSON.stringify([...newSettings])));
    }
    const freshDays = JSON.stringify([...fresh].sort());
    stmts.push(
      db.prepare(UPSERT_ROUNDS).bind(JSON.stringify(write.map(row)), c.id, JSON.stringify([...new Set(write.map(r => r.settingsHash))])),
      db.prepare(RACED).bind(freshDays, accepted),
    );
    if (freshRows.length) {
      const sums = aggregate(freshRows);
      stmts.push(db.prepare(PENDING).bind(c.id, freshRows.length, freshDays, JSON.stringify(freshTsums),
        JSON.stringify(sums.cells), JSON.stringify(sums.bins), JSON.stringify(sums.cc)));
    }
    if (changedDays.size) {
      stmts.push(db.prepare("INSERT OR IGNORE INTO dirty_days (day) SELECT value FROM json_each(?1)").bind(JSON.stringify([...changedDays])));
    }
  }
  if (deviceRows.length) {
    stmts.push(db.prepare(`INSERT INTO devices (device_hash, contributor, first_seen, last_seen, rounds)
        SELECT d->>0, ?2, d->>1, d->>2, d->>3 FROM (SELECT value AS d FROM json_each(?1)) WHERE true
        ON CONFLICT (device_hash, contributor) DO UPDATE SET first_seen = min(first_seen, excluded.first_seen),
          last_seen = max(last_seen, excluded.last_seen), rounds = rounds + excluded.rounds
        WHERE excluded.rounds > 0 OR excluded.first_seen < first_seen OR excluded.last_seen > last_seen`)
      .bind(JSON.stringify(deviceRows.map(([h, d]) => [h, d.first, d.last, d.rounds])), c.id));
  }
  stmts.push(db.prepare(`UPDATE contributors SET last_seen = ?2, rounds_total = rounds_total + ?3, dup_rounds = dup_rounds + ?4,
      day_rounds = CASE WHEN day = ?5 THEN day_rounds + ?6 ELSE ?6 END, day = ?5 WHERE id = ?1`)
    .bind(c.id, now, freshRows.length, duplicates, today, accepted));

  // The quota counts accepted rows; it, the budget and the key's contributor
  // still being linked are checked inside the batch.
  const checks = [db.prepare(LINKED_CHECK).bind(c.id)];
  if (accepted) {
    checks.push(db.prepare(`INSERT INTO refusals (quota) SELECT 1 FROM contributors
      WHERE id = ?1 AND (CASE WHEN day = ?2 THEN day_rounds ELSE 0 END) + ?3 > ?4`).bind(c.id, today, accepted, lim.quota));
  }
  await spend(db, nowMs, { est, cap: lim.budget - lim.reserve, reads, checks }, stmts);
  return ok({ accepted, unchanged, duplicates, rejected, retry });
}
