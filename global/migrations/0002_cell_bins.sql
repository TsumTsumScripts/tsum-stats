-- Bins per cell, with their rounds' figures (CONTRACT §3.1, §5): the page's
-- outlier ranges, and spreads under an items filter or net coins. They take
-- the place of `bins` (per day × build × Tsum × skill, counts only), which is
-- left as it is and no longer written: migrations only ever add, so a Worker
-- rolled back to the version before still finds the tables it knows.

-- Public: one row per cells row, each a JSON object {"<bin>": [rounds, secs, score, base, final, medals]}.
CREATE TABLE cell_bins (
  day TEXT NOT NULL, build INTEGER NOT NULL, tsum TEXT NOT NULL, skill INTEGER NOT NULL,
  items INTEGER NOT NULL, medal INTEGER NOT NULL,
  base TEXT NOT NULL, final TEXT NOT NULL, medals TEXT NOT NULL,  -- medals: {} unless medal = 1
  PRIMARY KEY (day, build, tsum, skill, items, medal)
) WITHOUT ROWID;

-- An upload's cell_bins rows: [day, build, tsum, skill, items, medal, {base}, {final}, {medals}].
-- `pending.bins` is left '[]' from now on.
ALTER TABLE pending ADD COLUMN cell_bins TEXT NOT NULL DEFAULT '[]';

-- Every day with figures, and every day an upload waits for, is recomputed
-- in full by the next runs, which makes its cell_bins and publishes it again
-- in part format 2. The waiting uploads' old-style bins are left out: the
-- recompute reads their rounds.
INSERT OR IGNORE INTO dirty_days (day)
  SELECT DISTINCT day FROM cells
  UNION SELECT d.value FROM pending p, json_each(p.days) d;
UPDATE pending SET bins = '[]';
