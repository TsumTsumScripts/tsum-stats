-- The skill level correction (CONTRACT §3.1, §3.2 step 1c). Until the script's
-- Auto Set Skill Level (6.0a19) a round's skill level was typed in by the
-- player, so some runs of rounds are recorded at a wrong one. The job works
-- out which (src/refile.ts, with the rules of ui/src/lib/skillFix.js) and
-- files those rounds under the level they count at. A round's recorded level
-- (`rounds.skill`) never changes, and nothing here touches `rounds`.

-- Public: `cells4` and `cell_bins4` take the place of `cells3` and
-- `cell_bins3` (whose key cannot grow in place), keyed by `stated` too: the
-- skill level the rounds were recorded at. `skill` is now the level they count
-- at; the two are the same for every round the correction left alone. The old
-- tables are left as they are and no longer written: migrations only ever
-- add, so a Worker rolled back to the version before still finds them.
CREATE TABLE cells4 (
  day TEXT NOT NULL, build INTEGER NOT NULL, tsum TEXT NOT NULL, skill INTEGER NOT NULL, skill_type TEXT NOT NULL,
  items INTEGER NOT NULL, scan INTEGER NOT NULL, chain INTEGER NOT NULL, bubble TEXT NOT NULL, medal INTEGER NOT NULL,
  jackpot INTEGER NOT NULL,
  stated INTEGER NOT NULL,
  rounds INTEGER NOT NULL, secs REAL NOT NULL,
  score_sum INTEGER NOT NULL, score_min INTEGER NOT NULL, score_max INTEGER NOT NULL,
  first INTEGER NOT NULL, last INTEGER NOT NULL,
  base_sum INTEGER NOT NULL, base_sq REAL NOT NULL, base_min INTEGER NOT NULL, base_max INTEGER NOT NULL,
  final_sum INTEGER NOT NULL, final_sq REAL NOT NULL, final_min INTEGER NOT NULL, final_max INTEGER NOT NULL,
  medals_n INTEGER NOT NULL, medals_sum INTEGER NOT NULL, medals_sq REAL NOT NULL,
  medals_min INTEGER, medals_max INTEGER, medals_secs REAL NOT NULL,
  gap_sum REAL NOT NULL DEFAULT 0, gap_n INTEGER NOT NULL DEFAULT 0, secs_max REAL,
  PRIMARY KEY (day, build, tsum, skill, skill_type, items, scan, chain, bubble, medal, jackpot, stated)
) WITHOUT ROWID;

CREATE TABLE cell_bins4 (
  day TEXT NOT NULL, build INTEGER NOT NULL, tsum TEXT NOT NULL, skill INTEGER NOT NULL, skill_type TEXT NOT NULL,
  items INTEGER NOT NULL, scan INTEGER NOT NULL, chain INTEGER NOT NULL, bubble TEXT NOT NULL, medal INTEGER NOT NULL,
  jackpot INTEGER NOT NULL,
  stated INTEGER NOT NULL,
  base TEXT NOT NULL, final TEXT NOT NULL, medals TEXT NOT NULL,
  PRIMARY KEY (day, build, tsum, skill, skill_type, items, scan, chain, bubble, medal, jackpot, stated)
) WITHOUT ROWID;

-- Every day's figures so far, each cell at the level it was recorded at: an
-- exact copy, so no day has to be recomputed for the new key alone. (A past
-- day comes into the correction only when it is recomputed, which fills its
-- skill_units: the admin `rebuild` route, CONTRACT §2.5.)
INSERT INTO cells4 SELECT day, build, tsum, skill, skill_type, items, scan, chain, bubble, medal, jackpot, skill, rounds, secs,
  score_sum, score_min, score_max, first, last, base_sum, base_sq, base_min, base_max, final_sum, final_sq, final_min, final_max,
  medals_n, medals_sum, medals_sq, medals_min, medals_max, medals_secs, gap_sum, gap_n, secs_max FROM cells3;
INSERT INTO cell_bins4 SELECT day, build, tsum, skill, skill_type, items, scan, chain, bubble, medal, jackpot, skill, base, final, medals FROM cell_bins3;

-- Private: what the correction judges by. One row per day × build × Tsum ×
-- device × recorded skill level × item context × trusted: the rounds of the
-- catalog's Tsums with a level, of contributors who are not banned.
CREATE TABLE skill_units (
  build INTEGER NOT NULL, tsum TEXT NOT NULL,
  device TEXT NOT NULL,                  -- the device hash (§1.1)
  skill INTEGER NOT NULL,                -- as recorded, 1-10
  context INTEGER NOT NULL,              -- the item set less +Coin, +Exp and +Score; -1 unknown (skillFix.js: fixContext)
  trusted INTEGER NOT NULL,              -- 1: a script version with Auto Set Skill Level (skillFix.js: trustedVersion)
  day TEXT NOT NULL,                     -- the day the rounds started (§1.1)
  n INTEGER NOT NULL,                    -- rounds
  vn INTEGER NOT NULL, vsum INTEGER NOT NULL,   -- those with a value over 0, and the values' sum: medals for a medal Tsum, else base coins
  first INTEGER NOT NULL, last INTEGER NOT NULL, -- epoch s (played_at)
  PRIMARY KEY (tsum, build, device, skill, context, trusted, day)
) WITHOUT ROWID;
-- A day's recompute makes its rows again; the correction reads one Tsum's (the key).
CREATE INDEX skill_units_day ON skill_units (day);

-- Private: the runs counted at another level than recorded. A day's full
-- recompute files the rounds of `device` recorded at `stated`, of the days
-- from_day to to_day, under `level`.
CREATE TABLE skill_fix (
  build INTEGER NOT NULL, tsum TEXT NOT NULL, device TEXT NOT NULL,
  stated INTEGER NOT NULL,
  from_day TEXT NOT NULL, to_day TEXT NOT NULL,
  level INTEGER NOT NULL,
  rule TEXT NOT NULL,                    -- order | trusted (skillFix.js)
  rounds INTEGER NOT NULL,               -- the run's rounds when it was last judged
  days TEXT NOT NULL,                    -- {day: rounds}: the run's rounds per day as of the last pass that asked for that day's recompute
  at INTEGER NOT NULL,                   -- epoch s: when the fix was first made
  PRIMARY KEY (tsum, build, device, stated, from_day)
) WITHOUT ROWID;

-- An upload's sums carry its skill_units rows from format 2 on. One of format
-- 1 (summed before this, or by the Worker before this in the moment between
-- this migration and the deploy) is added into the cells as before, each at
-- its recorded level, and its days are recomputed for their units
-- (rollup.ts: FOLD_OLD).
ALTER TABLE pending ADD COLUMN units TEXT NOT NULL DEFAULT '[]';
