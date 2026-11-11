-- The preset gallery (CONTRACT §2.7, §3.1): presets contributors submit as Tsum share codes.
-- Only the code is kept; the page reads it with the same table (ui/src/lib/presets/shareCode.js).
CREATE TABLE presets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT, -- public id, never reused
  contributor INTEGER NOT NULL,
  name        TEXT NOT NULL,                 -- cleaned as the script does, 1..40 chars
  description TEXT NOT NULL DEFAULT '',      -- at most 280 chars
  tsum        TEXT,                          -- a catalog Tsum id the submitter picked, or NULL
  skill       TEXT NOT NULL,                 -- the code's skillType (or its default), for filters
  code        TEXT NOT NULL,                 -- the share code, without the name
  script      TEXT NOT NULL,                 -- the script version of the table that read it
  created_at  INTEGER NOT NULL,              -- epoch seconds
  hidden      INTEGER NOT NULL DEFAULT 0     -- 1: taken down by an admin
);
CREATE INDEX presets_by_contributor ON presets (contributor, created_at);
