-- 0009: Tsum Lists as evidence for the skill level correction (CONTRACT §1.3,
-- §2.8). A contributor's app sends the Tsum Lists it has and which of them
-- each device's rounds were played under; the hourly job groups the lists
-- into game accounts and keeps, per device and Tsum, what they say of the
-- level at each time (§3.2, step 1b'). `rounds.skill` stays the recorded level.

-- Private. One row per list, its Tsums as one JSON value: every column the
-- list was sent with, as sent.
CREATE TABLE tsum_lists (
  contributor INTEGER NOT NULL,
  id TEXT NOT NULL,                      -- the sender's name for the list: 16 hex, the same for the same list
  build INTEGER NOT NULL,                -- 0 global, 1 jp
  stamp INTEGER NOT NULL,                -- epoch s, UTC: when the list was read on the device
  n INTEGER NOT NULL,                    -- its Tsums
  hash TEXT NOT NULL,                    -- hex SHA-256 of `tsums`: a list sent again the same writes nothing
  tsums TEXT NOT NULL,                   -- JSON: [{"order", "tsum", "name", "level", "level_cap", "skill", "skill_max", "skill_progress", "acquired", "favorite", …}], every value text
  at INTEGER NOT NULL,                   -- epoch s: when the site took it
  archived INTEGER NOT NULL DEFAULT 0,   -- 1 once it is in archive/lists/
  PRIMARY KEY (contributor, id)
) WITHOUT ROWID;

-- Private. The account a device's rounds of one game were played on, as its
-- contributor's app says: one of the account's lists; '' for "not known";
-- NULL for an answer taken back (the site then links it by itself, or not).
CREATE TABLE device_links (
  contributor INTEGER NOT NULL,
  build INTEGER NOT NULL,
  device TEXT NOT NULL,                  -- the device hash (§1.1)
  list TEXT,
  at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (contributor, build, device)
) WITHOUT ROWID;

-- Private, made from the two above: what a device's account's lists say of
-- one Tsum's level from `from_at` (a round's played_at) until the row after:
-- at least `floor`, at most `cap`, 0 for no such list. Only for the Tsums the
-- contributor has sent rounds of. A day's full recompute reads it by key.
CREATE TABLE skill_bound (
  tsum TEXT NOT NULL, build INTEGER NOT NULL, device TEXT NOT NULL, contributor INTEGER NOT NULL,
  from_at INTEGER NOT NULL,              -- epoch s; the first row of a device's Tsum is from 0
  floor INTEGER NOT NULL, cap INTEGER NOT NULL,
  PRIMARY KEY (tsum, build, device, contributor, from_at)
) WITHOUT ROWID;
CREATE INDEX skill_bound_contributor ON skill_bound (contributor);
