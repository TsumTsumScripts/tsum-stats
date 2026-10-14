// POST /api/v1/rounds (CONTRACT §2.2): one gap.round-stats/1 batch. The rows
// D1 already has are read first, so the quota and the budget are checked
// before anything is written, and an unchanged re-send writes no rounds.
import type { Contributor } from "./contributors";
import { hmacKey } from "./crypto";
import { dayOf, keyDay } from "./days";
import { limits, type Env } from "./env";
import { HttpError, ok, readObject, untilMidnight } from "./http";
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
// version, settings hash, duration, score, base, final, medals, bins...]. A
// conflict updates only this contributor's row, and only when it changed.
const UPSERT_ROUNDS = `INSERT INTO rounds (key, contributor, ${FIGURES.join(", ")})
  SELECT r->>0, ?2, r->>1, r->>2, r->>3, r->>4, r->>5, r->>6, (SELECT id FROM settings WHERE hash = r->>7),
    r->>8, r->>9, r->>10, r->>11, r->>12, r->>13, r->>14, r->>15
  FROM (SELECT value AS r FROM json_each(?1)) WHERE true
  ON CONFLICT (key) DO UPDATE SET ${FIGURES.map(f => `${f} = excluded.${f}`).join(", ")}
  WHERE rounds.contributor = excluded.contributor
    AND (${FIGURES.map(f => `rounds.${f}`).join(", ")}) IS NOT (${FIGURES.map(f => `excluded.${f}`).join(", ")})`;

const row = (r: Round) => [
  r.key, r.playedAt, r.build, r.tsum, r.skill, r.items, r.version, r.settingsHash,
  r.duration, r.score, r.base, r.final, r.medals, r.binBase, r.binFinal, r.binMedals,
];

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
  const archived = await db.prepare("SELECT value FROM state WHERE key = 'archived_through'").first<{ value: string }>();
  const { rounds, rejected } = await checkRecords(records, nowMs, lim.acceptDays, await hmacKey(env.DEVICE_KEY), archived?.value);
  const now = Math.floor(nowMs / 1000), today = dayOf(now);

  let stored = new Map<string, Stored>();
  let spent = 0;
  if (rounds.length) {
    const [had, budget] = await db.batch([
      db.prepare(`SELECT r.key, r.contributor, r.played_at, r.build, r.tsum, r.skill, r.items, r.version, s.hash,
          r.duration, r.score, r.base, r.final, r.medals
        FROM rounds r LEFT JOIN settings s ON s.id = r.settings WHERE r.key IN (SELECT value FROM json_each(?1))`)
        .bind(JSON.stringify(rounds.map(r => r.key))),
      db.prepare("SELECT rows FROM budget WHERE day = ?1").bind(today),
    ]);
    stored = new Map((had.results as unknown as Stored[]).map(s => [s.key, s]));
    spent = (budget.results[0] as { rows: number } | undefined)?.rows ?? 0;
  }

  // New rows and this contributor's changed ones are written; another
  // contributor's are theirs. Every device seen is recorded, so a player's
  // second install shows up under the first one's devices.
  const write: Round[] = [];
  const dirty = new Set<string>();
  const devices = new Map<string, { first: number; last: number; rounds: number }>();
  let inserted = 0, unchanged = 0, duplicates = 0;
  for (const r of rounds) {
    const d = devices.get(r.device) ?? { first: r.playedAt, last: r.playedAt, rounds: 0 };
    d.first = Math.min(d.first, r.playedAt);
    d.last = Math.max(d.last, r.playedAt);
    devices.set(r.device, d);
    const s = stored.get(r.key);
    if (!s) {
      write.push(r);
      inserted++;
      d.rounds++;
      dirty.add(keyDay(r.key));
    } else if (s.contributor !== c.id) {
      duplicates++;
    } else if (same(s, r)) {
      unchanged++;
    } else {
      // Its day is its start's, from the key, so a changed end never moves it.
      write.push(r);
      dirty.add(keyDay(r.key));
    }
  }

  const accepted = write.length;
  const dayRounds = c.day === today ? c.day_rounds : 0;
  if (accepted && dayRounds + accepted > lim.quota) throw new HttpError(429, "quota", untilMidnight(nowMs));
  if (accepted && spent + accepted > lim.budget) throw new HttpError(503, "budget", untilMidnight(nowMs));

  const stmts: D1PreparedStatement[] = [];
  if (accepted) {
    const settings = new Map(write.map(r => [r.settingsHash, r.settings]));
    stmts.push(
      db.prepare(`INSERT INTO settings (hash, json) SELECT s->>0, s->>1 FROM (SELECT value AS s FROM json_each(?1)) WHERE true
        ON CONFLICT (hash) DO NOTHING`).bind(JSON.stringify([...settings])),
      db.prepare(UPSERT_ROUNDS).bind(JSON.stringify(write.map(row)), c.id),
      db.prepare("INSERT INTO budget (day, rows) VALUES (?1, ?2) ON CONFLICT (day) DO UPDATE SET rows = rows + excluded.rows")
        .bind(today, accepted),
      db.prepare("INSERT OR IGNORE INTO dirty_days (day) SELECT value FROM json_each(?1)").bind(JSON.stringify([...dirty])),
    );
  }
  if (devices.size) {
    stmts.push(db.prepare(`INSERT INTO devices (device_hash, contributor, first_seen, last_seen, rounds)
        SELECT d->>0, ?2, d->>1, d->>2, d->>3 FROM (SELECT value AS d FROM json_each(?1)) WHERE true
        ON CONFLICT (device_hash, contributor) DO UPDATE SET first_seen = min(first_seen, excluded.first_seen),
          last_seen = max(last_seen, excluded.last_seen), rounds = rounds + excluded.rounds
        WHERE excluded.rounds > 0 OR excluded.first_seen < first_seen OR excluded.last_seen > last_seen`)
      .bind(JSON.stringify([...devices].map(([h, d]) => [h, d.first, d.last, d.rounds])), c.id));
  }
  stmts.push(db.prepare(`UPDATE contributors SET last_seen = ?2, rounds_total = rounds_total + ?3, dup_rounds = dup_rounds + ?4,
      day_rounds = CASE WHEN day = ?5 THEN day_rounds + ?6 ELSE ?6 END, day = ?5 WHERE id = ?1`)
    .bind(c.id, now, inserted, duplicates, today, accepted));
  await db.batch(stmts);

  return ok({ accepted, unchanged, duplicates, rejected });
}
