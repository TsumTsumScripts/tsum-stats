-- 0009: the skill level a contributor's own app worked out for a round
-- (CONTRACT §1.3): from the Tsum Lists of the account it was played on, or
-- from its coins. The forwarder sends it with the round (`skill_eff`,
-- `skill_src`) or, for a round the site already has, alone at any age
-- (POST /api/v1/levels, §2.8). `rounds.skill` stays the recorded level.

-- Private, kept for good, also once a round's day has left D1: one row per
-- round with such a level. A day's full recompute reads it by the round's key.
CREATE TABLE round_levels (
  key TEXT PRIMARY KEY,                  -- the round's key (§1.1)
  level INTEGER NOT NULL,                -- 1-10: the level the round counts at
  source TEXT NOT NULL,                  -- list | pick (a Tsum List: hard evidence) | order | trusted (the app's coin rules)
  at INTEGER NOT NULL                    -- epoch s: when the site took it
) WITHOUT ROWID;

-- Every change to round_levels, in order, until the hourly job has written it
-- to archive/levels/ (§3.4): a level set (level and source), or taken back
-- (both NULL). The archive keeps every one sent.
CREATE TABLE level_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  level INTEGER,
  source TEXT,
  at INTEGER NOT NULL
);
