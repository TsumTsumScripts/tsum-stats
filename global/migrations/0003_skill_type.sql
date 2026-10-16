-- The script's skill type per round (CONTRACT §1.2, §3.1): kept with the
-- round, and a key of the public day tables, so the page can filter and
-- break figures down by it. The cells and cell_bins key cannot grow in
-- place, so `cells2` and `cell_bins2` take their place, keyed by skill type
-- too; the old tables are left as they are and no longer written:
-- migrations only ever add, so a Worker rolled back to the version before
-- still finds the tables it knows.

-- Every round sent before this kept no skill type: '' (unknown) until its
-- contributor's forwarder sends it again (CONTRACT §7.2).
ALTER TABLE rounds ADD COLUMN skill_type TEXT NOT NULL DEFAULT '';
-- The archive's staged pieces carry it like every other column.
ALTER TABLE archive_parts ADD COLUMN skill_type TEXT NOT NULL DEFAULT '';

-- Public: one row per day × build × Tsum × skill × skill type × items × (medals > 0).
CREATE TABLE cells2 (
  day TEXT NOT NULL, build INTEGER NOT NULL, tsum TEXT NOT NULL, skill INTEGER NOT NULL, skill_type TEXT NOT NULL,
  items INTEGER NOT NULL, medal INTEGER NOT NULL,
  rounds INTEGER NOT NULL, secs REAL NOT NULL,
  score_sum INTEGER NOT NULL, score_min INTEGER NOT NULL, score_max INTEGER NOT NULL,
  first INTEGER NOT NULL, last INTEGER NOT NULL,
  base_sum INTEGER NOT NULL, base_sq REAL NOT NULL, base_min INTEGER NOT NULL, base_max INTEGER NOT NULL,
  final_sum INTEGER NOT NULL, final_sq REAL NOT NULL, final_min INTEGER NOT NULL, final_max INTEGER NOT NULL,
  medals_n INTEGER NOT NULL, medals_sum INTEGER NOT NULL, medals_sq REAL NOT NULL,
  medals_min INTEGER, medals_max INTEGER, medals_secs REAL NOT NULL,
  PRIMARY KEY (day, build, tsum, skill, skill_type, items, medal)
) WITHOUT ROWID;

CREATE TABLE cell_bins2 (
  day TEXT NOT NULL, build INTEGER NOT NULL, tsum TEXT NOT NULL, skill INTEGER NOT NULL, skill_type TEXT NOT NULL,
  items INTEGER NOT NULL, medal INTEGER NOT NULL,
  base TEXT NOT NULL, final TEXT NOT NULL, medals TEXT NOT NULL,
  PRIMARY KEY (day, build, tsum, skill, skill_type, items, medal)
) WITHOUT ROWID;

-- Every day's figures so far, under skill type '': what the rounds hold.
-- A day whose rounds have left D1 can never be recomputed, so it is copied.
INSERT INTO cells2 SELECT day, build, tsum, skill, '', items, medal, rounds, secs, score_sum, score_min, score_max,
  first, last, base_sum, base_sq, base_min, base_max, final_sum, final_sq, final_min, final_max,
  medals_n, medals_sum, medals_sq, medals_min, medals_max, medals_secs FROM cells;
INSERT INTO cell_bins2 SELECT day, build, tsum, skill, '', items, medal, base, final, medals FROM cell_bins;

-- Waiting uploads summed their rounds without a skill type: their days are
-- recomputed in full from the rounds instead (which re-makes everything a
-- fold would have: cells, bins, contrib_cells, spans, recent), and the sums go.
INSERT OR IGNORE INTO dirty_days (day) SELECT DISTINCT d.value FROM pending p, json_each(p.days) d;
DELETE FROM pending;
