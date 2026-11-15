-- The time between rounds and each cell's longest round (CONTRACT §3.1).
--
-- rounds.gap: a round's time between rounds, the seconds from the previous
-- round's end on the same device to this one's start when that is 0 to 300
-- (longer is a break: 0), worked out at upload (ingest.ts). NULL when it
-- cannot be told: the device's first round here, a round sent out of order,
-- and every round stored before this.
ALTER TABLE rounds ADD COLUMN gap REAL;

-- cells3: the gaps' sum and how many rounds have one, so the page can
-- estimate the time between rounds from the rounds that tell it; and the
-- longest round, so it can flag one round owning a Tsum's rate. A cell made
-- before this has no gaps (gap_n 0) and no longest round (NULL) until its day
-- is recomputed from rounds that still have them.
ALTER TABLE cells3 ADD COLUMN gap_sum REAL NOT NULL DEFAULT 0;
ALTER TABLE cells3 ADD COLUMN gap_n INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cells3 ADD COLUMN secs_max REAL;

-- Archive files carry each round's gap (CONTRACT §3.4); a share staged before
-- this has none, and its rounds come back without one.
ALTER TABLE archive_parts ADD COLUMN gap TEXT NOT NULL DEFAULT '';
