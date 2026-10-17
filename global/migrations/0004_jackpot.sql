-- Coin-bonus jackpots (CONTRACT §3.1): a round whose final coins are over 10
-- times its base coins (ui/src/lib/snapshot/engine.js: JACKPOT_TIMES), the
-- +Coin item's rare 11×, 21× and 51× bonuses. The Tsum page leaves them out
-- of its final-coin figures, so the day tables key by it: `cells3` and
-- `cell_bins3` take the place of `cells2` and `cell_bins2` (whose key cannot
-- grow in place), keyed by `jackpot` too. It comes from each round's base and
-- final coins, which every stored round has, so `rounds` gains nothing. The
-- old tables are left as they are and no longer written: migrations only ever
-- add, so a Worker rolled back to the version before still finds them.

-- Public: one row per day × build × Tsum × skill × skill type × items × scan × chain × bubble × (medals > 0) × jackpot.
CREATE TABLE cells3 (
  day TEXT NOT NULL, build INTEGER NOT NULL, tsum TEXT NOT NULL, skill INTEGER NOT NULL, skill_type TEXT NOT NULL,
  items INTEGER NOT NULL, scan INTEGER NOT NULL, chain INTEGER NOT NULL, bubble TEXT NOT NULL, medal INTEGER NOT NULL,
  jackpot INTEGER NOT NULL,
  rounds INTEGER NOT NULL, secs REAL NOT NULL,
  score_sum INTEGER NOT NULL, score_min INTEGER NOT NULL, score_max INTEGER NOT NULL,
  first INTEGER NOT NULL, last INTEGER NOT NULL,
  base_sum INTEGER NOT NULL, base_sq REAL NOT NULL, base_min INTEGER NOT NULL, base_max INTEGER NOT NULL,
  final_sum INTEGER NOT NULL, final_sq REAL NOT NULL, final_min INTEGER NOT NULL, final_max INTEGER NOT NULL,
  medals_n INTEGER NOT NULL, medals_sum INTEGER NOT NULL, medals_sq REAL NOT NULL,
  medals_min INTEGER, medals_max INTEGER, medals_secs REAL NOT NULL,
  PRIMARY KEY (day, build, tsum, skill, skill_type, items, scan, chain, bubble, medal, jackpot)
) WITHOUT ROWID;

CREATE TABLE cell_bins3 (
  day TEXT NOT NULL, build INTEGER NOT NULL, tsum TEXT NOT NULL, skill INTEGER NOT NULL, skill_type TEXT NOT NULL,
  items INTEGER NOT NULL, scan INTEGER NOT NULL, chain INTEGER NOT NULL, bubble TEXT NOT NULL, medal INTEGER NOT NULL,
  jackpot INTEGER NOT NULL,
  base TEXT NOT NULL, final TEXT NOT NULL, medals TEXT NOT NULL,
  PRIMARY KEY (day, build, tsum, skill, skill_type, items, scan, chain, bubble, medal, jackpot)
) WITHOUT ROWID;

-- Every day's figures so far, as no jackpot: a day whose rounds have left D1
-- can never be recomputed, so it is copied (its jackpots stay in its figures
-- until a restore brings its rounds back).
INSERT INTO cells3 SELECT day, build, tsum, skill, skill_type, items, scan, chain, bubble, medal, 0, rounds, secs, score_sum, score_min, score_max,
  first, last, base_sum, base_sq, base_min, base_max, final_sum, final_sq, final_min, final_max,
  medals_n, medals_sum, medals_sq, medals_min, medals_max, medals_secs FROM cells2;
INSERT INTO cell_bins3 SELECT day, build, tsum, skill, skill_type, items, scan, chain, bubble, medal, 0, base, final, medals FROM cell_bins2;
-- A day whose rounds are still in D1 is made again from them, jackpots apart
-- (a day that has left D1 is passed over: rollup.ts recomputeStep).
INSERT OR IGNORE INTO dirty_days (day) SELECT DISTINCT day FROM cells3;

-- An upload's sums say which layout they are in: 1 has the jackpot key. A
-- row of 0 (summed before this, or by the Worker before this in the moment
-- between this migration and the deploy) is not added into the day tables:
-- its days are recomputed from the rounds instead (rollup.ts foldStep).
ALTER TABLE pending ADD COLUMN format INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO dirty_days (day) SELECT DISTINCT d.value FROM pending p, json_each(p.days) d;
