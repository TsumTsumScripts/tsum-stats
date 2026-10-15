CREATE TABLE contributors (
  id INTEGER PRIMARY KEY,                -- 0 is "unlinked"
  key_hash TEXT UNIQUE,                  -- hex SHA-256 of the key; NULL once unlinked
  status TEXT NOT NULL DEFAULT 'active', -- active | banned | unlinking | unlinking-banned
  created_at INTEGER NOT NULL,           -- epoch s
  last_seen INTEGER,
  client TEXT,
  rounds_total INTEGER NOT NULL DEFAULT 0,
  dup_rounds INTEGER NOT NULL DEFAULT 0,
  day TEXT,                              -- the day day_rounds counts
  day_rounds INTEGER NOT NULL DEFAULT 0
);
INSERT INTO contributors (id, key_hash, status, created_at) VALUES (0, NULL, 'active', 0);

CREATE TABLE devices (
  device_hash TEXT NOT NULL,             -- 12 hex
  contributor INTEGER NOT NULL,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,  -- epoch s of rounds' played_at
  rounds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_hash, contributor)
) WITHOUT ROWID;

CREATE TABLE settings (id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, json TEXT NOT NULL);

CREATE TABLE rounds (
  key TEXT PRIMARY KEY,                  -- §1.1, 32 hex
  contributor INTEGER NOT NULL,
  played_at INTEGER NOT NULL,            -- epoch s, UTC, round end
  build INTEGER NOT NULL,                -- 0 global, 1 jp
  tsum TEXT NOT NULL,
  skill INTEGER NOT NULL,                -- -1 unknown
  items INTEGER NOT NULL,                -- -1 unknown
  version TEXT NOT NULL,
  settings INTEGER NOT NULL,
  duration REAL NOT NULL,
  score INTEGER NOT NULL,
  base INTEGER NOT NULL,
  final INTEGER NOT NULL,
  medals INTEGER,
  bin_base INTEGER NOT NULL,
  bin_final INTEGER NOT NULL,
  bin_medals INTEGER                     -- NULL unless medals > 0
) WITHOUT ROWID;

-- Days to recompute in full from their rounds: a ban, a changed round, a rebuild, a restore.
CREATE TABLE dirty_days (day TEXT PRIMARY KEY) WITHOUT ROWID;

-- New rounds waiting to be added into the day tables, one row per upload batch,
-- added up by the upload as the day tables keep them (JSON, ingest.ts: aggregate),
-- so the hourly job never reads the rounds table for them.
CREATE TABLE pending (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  contributor INTEGER NOT NULL,
  n INTEGER NOT NULL,                    -- rounds
  days TEXT NOT NULL,                    -- the start days they fall on
  tsums TEXT NOT NULL,                   -- {tsum: the newest of those days with a round of it}
  cells TEXT NOT NULL,                   -- the cells rows they add to (the catalog's Tsums only)
  bins TEXT NOT NULL,                    -- the bins rows they add to: [day, build, tsum, skill, {base}, {final}, {medals}]
  cc TEXT NOT NULL                       -- [day, build, tsum, device, rounds, secs, base, final, medals]
);

-- What D1 wrote (rows inserted, changed or deleted) and read per UTC day, for everything the Worker does.
CREATE TABLE budget (day TEXT PRIMARY KEY, rows INTEGER NOT NULL, reads INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
-- Never holds a row: a batch inserts into it only to stop itself, and D1 rolls the whole batch back.
CREATE TABLE refusals (
  quota INTEGER CONSTRAINT quota CHECK (quota IS NULL),
  budget INTEGER CONSTRAINT budget CHECK (budget IS NULL),
  join_limit INTEGER CONSTRAINT join_limit CHECK (join_limit IS NULL),
  unlinked INTEGER CONSTRAINT unlinked CHECK (unlinked IS NULL)  -- the key's contributor left while its upload was on the way
);
CREATE TABLE join_limits (ip_hash TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, day)) WITHOUT ROWID;
CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

-- Public: one row per day × build × Tsum × skill × items × (medals > 0).
CREATE TABLE cells (
  day TEXT NOT NULL, build INTEGER NOT NULL, tsum TEXT NOT NULL, skill INTEGER NOT NULL,
  items INTEGER NOT NULL, medal INTEGER NOT NULL,           -- medal: 1 when medals > 0
  rounds INTEGER NOT NULL, secs REAL NOT NULL,
  score_sum INTEGER NOT NULL, score_min INTEGER NOT NULL, score_max INTEGER NOT NULL,
  first INTEGER NOT NULL, last INTEGER NOT NULL,            -- epoch s
  base_sum INTEGER NOT NULL, base_sq REAL NOT NULL, base_min INTEGER NOT NULL, base_max INTEGER NOT NULL,
  final_sum INTEGER NOT NULL, final_sq REAL NOT NULL, final_min INTEGER NOT NULL, final_max INTEGER NOT NULL,
  medals_n INTEGER NOT NULL, medals_sum INTEGER NOT NULL, medals_sq REAL NOT NULL,
  medals_min INTEGER, medals_max INTEGER, medals_secs REAL NOT NULL,
  PRIMARY KEY (day, build, tsum, skill, items, medal)
) WITHOUT ROWID;

-- Public: histogram bins per day × build × Tsum × skill, each a JSON object {"<bin>": rounds}.
CREATE TABLE bins (
  day TEXT NOT NULL, build INTEGER NOT NULL, tsum TEXT NOT NULL, skill INTEGER NOT NULL,
  base TEXT NOT NULL, final TEXT NOT NULL, medals TEXT NOT NULL,  -- medals: rounds with medals > 0
  PRIMARY KEY (day, build, tsum, skill)
) WITHOUT ROWID;

-- A final day's rounds on their way to the archive (archive.ts): its files' arrays as text,
-- one row per contributor per share of the day (in key order), until the files are written.
CREATE TABLE archive_parts (
  day TEXT NOT NULL, contributor INTEGER NOT NULL, part INTEGER NOT NULL,
  n INTEGER NOT NULL, bytes INTEGER NOT NULL, last TEXT NOT NULL,   -- rounds, their length as text, the last key
  key TEXT NOT NULL, played_at TEXT NOT NULL, build TEXT NOT NULL, tsum TEXT NOT NULL, skill TEXT NOT NULL,
  items TEXT NOT NULL, version TEXT NOT NULL, settings TEXT NOT NULL, duration TEXT NOT NULL, score TEXT NOT NULL,
  base TEXT NOT NULL, final TEXT NOT NULL, medals TEXT NOT NULL,
  PRIMARY KEY (day, contributor, part)
) WITHOUT ROWID;

-- Private: the newest day each contributor sent a round of each Tsum, for the manifest's counts of people.
CREATE TABLE recent (contributor INTEGER NOT NULL, tsum TEXT NOT NULL, day TEXT NOT NULL,
  PRIMARY KEY (contributor, tsum)) WITHOUT ROWID;

-- Private, kept forever: what each contributor sent.
CREATE TABLE contrib_cells (
  day TEXT NOT NULL, contributor INTEGER NOT NULL, build INTEGER NOT NULL, tsum TEXT NOT NULL,
  rounds INTEGER NOT NULL, secs REAL NOT NULL, base_sum INTEGER NOT NULL, final_sum INTEGER NOT NULL,
  medals_sum INTEGER NOT NULL, devices INTEGER NOT NULL,
  device_set TEXT NOT NULL DEFAULT '[]',                    -- JSON: the distinct device hashes, sorted
  PRIMARY KEY (day, contributor, build, tsum)
) WITHOUT ROWID;
