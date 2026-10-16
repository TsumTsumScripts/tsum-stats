-- The script's skill type per round (CONTRACT §1.2, §3.1): kept with the
-- round, and a key of the public day tables, so the page can filter and
-- break figures down by it; and so are three of its settings, the play
-- settings: chains per board scan (scan), the longest chain (chain) and the
-- bubble strategy (bubble). The cells and cell_bins key cannot grow in
-- place, so `cells2` and `cell_bins2` take their place, keyed by all four
-- too; the old tables are left as they are and no longer written:
-- migrations only ever add, so a Worker rolled back to the version before
-- still finds the tables it knows.

-- Every round sent before this kept no skill type: '' (unknown) until its
-- contributor's forwarder sends it again (CONTRACT §7.2).
ALTER TABLE rounds ADD COLUMN skill_type TEXT NOT NULL DEFAULT '';
-- The play settings, from the round's settings (records.ts: playValue):
-- -1 and '' where not recorded.
ALTER TABLE rounds ADD COLUMN scan INTEGER NOT NULL DEFAULT -1;
ALTER TABLE rounds ADD COLUMN chain INTEGER NOT NULL DEFAULT -1;
ALTER TABLE rounds ADD COLUMN bubble TEXT NOT NULL DEFAULT '';
-- The archive's staged pieces carry them like every other column.
ALTER TABLE archive_parts ADD COLUMN skill_type TEXT NOT NULL DEFAULT '';
ALTER TABLE archive_parts ADD COLUMN scan TEXT NOT NULL DEFAULT '';
ALTER TABLE archive_parts ADD COLUMN chain TEXT NOT NULL DEFAULT '';
ALTER TABLE archive_parts ADD COLUMN bubble TEXT NOT NULL DEFAULT '';

-- Every round stored so far kept its settings, so its play settings are
-- known now: as playValue reads them (a whole number 0-999; an id of
-- letters, digits, '_', '.' and '-', at most 64), in records.ts: playSQL's
-- words exactly (test/records.test.ts holds them to it).
UPDATE rounds SET
  scan = (CASE WHEN json_type(s.json, '$.maxChainsPerScan') IN ('integer', 'real') AND json_extract(s.json, '$.maxChainsPerScan') BETWEEN 0 AND 999 AND json_extract(s.json, '$.maxChainsPerScan') = CAST(json_extract(s.json, '$.maxChainsPerScan') AS INTEGER) THEN CAST(json_extract(s.json, '$.maxChainsPerScan') AS INTEGER) ELSE -1 END),
  chain = (CASE WHEN json_type(s.json, '$.maxChain') IN ('integer', 'real') AND json_extract(s.json, '$.maxChain') BETWEEN 0 AND 999 AND json_extract(s.json, '$.maxChain') = CAST(json_extract(s.json, '$.maxChain') AS INTEGER) THEN CAST(json_extract(s.json, '$.maxChain') AS INTEGER) ELSE -1 END),
  bubble = (CASE WHEN json_type(s.json, '$.bubbleStrategy') = 'text' AND length(json_extract(s.json, '$.bubbleStrategy')) BETWEEN 1 AND 64 AND json_extract(s.json, '$.bubbleStrategy') NOT GLOB '*[^A-Za-z0-9_.-]*' THEN json_extract(s.json, '$.bubbleStrategy') ELSE '' END)
FROM settings s WHERE s.id = rounds.settings;

-- Public: one row per day × build × Tsum × skill × skill type × items × scan × chain × bubble × (medals > 0).
CREATE TABLE cells2 (
  day TEXT NOT NULL, build INTEGER NOT NULL, tsum TEXT NOT NULL, skill INTEGER NOT NULL, skill_type TEXT NOT NULL,
  items INTEGER NOT NULL, scan INTEGER NOT NULL, chain INTEGER NOT NULL, bubble TEXT NOT NULL, medal INTEGER NOT NULL,
  rounds INTEGER NOT NULL, secs REAL NOT NULL,
  score_sum INTEGER NOT NULL, score_min INTEGER NOT NULL, score_max INTEGER NOT NULL,
  first INTEGER NOT NULL, last INTEGER NOT NULL,
  base_sum INTEGER NOT NULL, base_sq REAL NOT NULL, base_min INTEGER NOT NULL, base_max INTEGER NOT NULL,
  final_sum INTEGER NOT NULL, final_sq REAL NOT NULL, final_min INTEGER NOT NULL, final_max INTEGER NOT NULL,
  medals_n INTEGER NOT NULL, medals_sum INTEGER NOT NULL, medals_sq REAL NOT NULL,
  medals_min INTEGER, medals_max INTEGER, medals_secs REAL NOT NULL,
  PRIMARY KEY (day, build, tsum, skill, skill_type, items, scan, chain, bubble, medal)
) WITHOUT ROWID;

CREATE TABLE cell_bins2 (
  day TEXT NOT NULL, build INTEGER NOT NULL, tsum TEXT NOT NULL, skill INTEGER NOT NULL, skill_type TEXT NOT NULL,
  items INTEGER NOT NULL, scan INTEGER NOT NULL, chain INTEGER NOT NULL, bubble TEXT NOT NULL, medal INTEGER NOT NULL,
  base TEXT NOT NULL, final TEXT NOT NULL, medals TEXT NOT NULL,
  PRIMARY KEY (day, build, tsum, skill, skill_type, items, scan, chain, bubble, medal)
) WITHOUT ROWID;

-- Every day's figures so far, under skill type '' and no play settings:
-- a day whose rounds have left D1 can never be recomputed, so it is copied.
INSERT INTO cells2 SELECT day, build, tsum, skill, '', items, -1, -1, '', medal, rounds, secs, score_sum, score_min, score_max,
  first, last, base_sum, base_sq, base_min, base_max, final_sum, final_sq, final_min, final_max,
  medals_n, medals_sum, medals_sq, medals_min, medals_max, medals_secs FROM cells;
INSERT INTO cell_bins2 SELECT day, build, tsum, skill, '', items, -1, -1, '', medal, base, final, medals FROM cell_bins;
-- A day whose rounds are still in D1 is made again from them, play settings
-- and all (a day that has left D1 is passed over: rollup.ts recomputeStep).
INSERT OR IGNORE INTO dirty_days (day) SELECT DISTINCT day FROM cells2;

-- Waiting uploads summed their rounds without a skill type: their days are
-- recomputed in full from the rounds instead (which re-makes everything a
-- fold would have: cells, bins, contrib_cells, spans, recent), and the sums go.
INSERT OR IGNORE INTO dirty_days (day) SELECT DISTINCT d.value FROM pending p, json_each(p.days) d;
DELETE FROM pending;
