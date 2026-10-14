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

CREATE TABLE dirty_days (day TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE budget (day TEXT PRIMARY KEY, rows INTEGER NOT NULL) WITHOUT ROWID;
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

-- Private, kept forever: what each contributor sent.
CREATE TABLE contrib_cells (
  day TEXT NOT NULL, contributor INTEGER NOT NULL, build INTEGER NOT NULL, tsum TEXT NOT NULL,
  rounds INTEGER NOT NULL, secs REAL NOT NULL, base_sum INTEGER NOT NULL, final_sum INTEGER NOT NULL,
  medals_sum INTEGER NOT NULL, devices INTEGER NOT NULL,
  PRIMARY KEY (day, contributor, build, tsum)
) WITHOUT ROWID;
