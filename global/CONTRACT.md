# Global stats contract

The one description every part of the global stats site is built against: the
cloud Worker (`global/`), the page's global mode (`ui/src/lib/global/`) and the
local forwarder (`internal/stats/global.go`). Change a shape here first, then
every side.

Words: a **round** is one finished game round; a **contributor** is one
tsum-stats install that joined; a **day** is a UTC calendar day
`YYYY-MM-DD`; **now** is the server's clock.

## 1. Uploads: `gap.round-stats/1`

The Tsum script's own format (`tsum-tsum-script/app.gap.Tsum/src/roundShare.ts`).
The forwarder sends exactly what the script would, so a device can later post
directly with no new contract.

```json
{
  "schema": "gap.round-stats/1",
  "script": {"id": "app.gap.Tsum"},
  "source": "tsum-stats",
  "sentAt": "2026-10-14T18:05:00.000Z",
  "client": "tsum-stats/0.25",
  "records": [{"id": "0192…", "datetime": "2026-10-14 17:58:03", "tsum": "beastda", "...": "..."}]
}
```

- `records` is 1–250 objects, each **a stats CSV row keyed by its header**,
  every value a **string** (an empty cell is `""`). `client` is optional (the
  script does not send it).
- **Base columns** (`csv.go: statsBaseColumns`): `id`, `datetime`,
  `script_version`, `skill_type`, `tsum`, `build`, `duration_seconds`,
  `score`, `base_coins`, `final_coins`, `medals`.
- **Every other column is a setting.** Its cell becomes a value as
  `csv.go: settingValue` does: `T` → true, `F` → false, a number (Go
  `ParseFloat`) → number, anything else the string; an empty cell is left out.
  The **settings object** is those values keyed by column.
- Base figures parse as `csv.go: intCell` / `floatCell` (an int, or a float
  truncated toward zero; empty or junk → null). `datetime` is UTC
  `YYYY-MM-DD HH:MM:SS` or ISO (`queries.go: normalizeTime`); it is the round's
  **end** time, `played_at`.
- The forwarder writes a setting back as text the same way: true → `T`,
  false → `F`, a number with Go `strconv.FormatFloat(v, 'f', -1, 64)` (so
  `3`, `0.5`), a string as it is; null, objects and arrays are left out.

### 1.1 The round's key

`id` is a UUIDv7 as the script makes it (`roundStats.ts: 2331-2349`): 32 hex
digits in 8-4-4-4-12 groups, version nibble `7`. Bytes 0–5 are the round's
**start** time in ms; the **last 6 bytes are the device tag**.

- **key** = the id's bytes 0–9, then the first 6 bytes of
  `HMAC-SHA256(DEVICE_KEY, the 6 tag bytes)`. 16 bytes, stored as **32
  lowercase hex characters** (TEXT). The hardware tag is never stored.
- **device hash** = the key's last 12 hex characters.
- Keys sort by start time, so a day is a key range: from
  `hex48(dayStartMs − 15 min)` + `"00000000000000000000"` to
  `hex48(dayEndMs + 15 min)` + `"ffffffffffffffffffff"`, filtered by
  `played_at` within the day.

### 1.2 What is accepted

A record is **rejected** (counted under the reason, never stored) when,
checked in this order:

| reason | rule |
|:--|:--|
| `id` | not a UUIDv7 as above, or `datetime` unreadable, or `played_at` more than 1 day from the id's start time |
| `old` | `played_at` or the id's start time is more than **60 days** (`ACCEPT_DAYS`) before now |
| `future` | `played_at` is more than 10 minutes after now |
| `tsum` | `tsum` is not an `id` in `ui/public/data/catalog.json` |
| `build` | `build` is not `global`/`jp`, and the settings have no boolean `jpVersion` (true → `jp`, false → `global`) |
| `incomplete` | `score`, `base_coins`, `final_coins` or `duration_seconds` is null, or `medals` is null for a catalog `medal: true` Tsum |
| `duration` | `duration_seconds` outside 30–900 |
| `range` | `score` outside 0–200,000,000, `base_coins` 0–50,000, `final_coins` 0–1,500,000, `medals` 0–2,000 |
| `pace` | within the batch, a round from the same device starting less than 40 s after the device's previous kept round (sorted by key) |
| `repeat` | the same key twice in one batch (the first is kept) |

Derived from an accepted record:

- **build**: 0 = global, 1 = jp.
- **skill**: `settings.skillLevel` when it is an integer 1–10, else **-1**.
- **items**: when the settings have `bonusCoin`, the bitmask of the true
  `bonus*` items (`summary.go: itemBits`: bonusCoin 1, bonus5to4 2,
  bonusTime 4, bonusExp 8, bonusScore 16, bonusBubble 32, bonusCombo 64);
  else **-1**. Item costs, for net coins: 1→500, 2→1800, 4→1000, 8→500,
  16→500, 32→1500, 64→1200.
- **medals**: null stays null (a non-medal Tsum's unread medals).
- **version**: `script_version`, at most 16 characters (cut).
- **settings id**: the settings object as canonical JSON (keys sorted,
  `JSON.stringify` of the sorted object) → its SHA-256 hex `hash` → the
  `settings` row with that hash (inserted once).
- **bins** (§5): `bin(base)`, `bin(final)`, and `bin(medals)` when medals > 0
  (else null).

## 2. The Worker's HTTP API

Host `https://tsum-stats.gapscripts.app`. JSON in and out
(`Content-Type: application/json`); every reply has `ok`. A request body may
be gzipped (`Content-Encoding: gzip`) and is at most 1 MiB after inflating.

| Route | Auth | Does |
|:--|:--|:--|
| `POST /api/v1/join` | none | Makes a contributor |
| `POST /api/v1/rounds` | contributor | Takes a `gap.round-stats/1` batch |
| `GET /api/v1/me` | contributor | The contributor's own record |
| `POST /api/v1/me/unlink` | contributor | Unlinks the contributor |
| `GET /api/v1/admin/contributors` | admin | Every contributor's record |
| `POST /api/v1/admin/{ban,unban,merge,rebuild,restore,rollup}` | admin | See §2.5 |
| `GET /data/global/*` | none | The published files (§4), from R2 |
| anything else | none | The page (static assets) |

**Auth**: `Authorization: Bearer <key>`. A contributor key is compared by its
SHA-256 hex against `contributors.key_hash` (status `active` or `banned`); the
admin key is the `ADMIN_KEY` secret, compared in constant time.

**Errors** (`{"ok": false, "error": "<code>"}`):

| Status | code | When |
|:--|:--|:--|
| 400 | `bad-request` | Unreadable JSON, wrong `schema`, `records` not 1–250 objects |
| 401 | `unauthorized` | No key, or one that matches no active/banned contributor |
| 404 | `not-found` | No such route |
| 405 | `method` | Wrong method |
| 413 | `too-large` | Body over 1 MiB |
| 429 | `quota` | The contributor's daily quota (`QUOTA_PER_CONTRIBUTOR`, 5,000 rounds) would be passed; `Retry-After` = seconds to the next 00:00 UTC |
| 429 | `join-limit` | More than 5 joins today from this address |
| 503 | `budget` | Today's write budget (`BUDGET_ROWS_PER_DAY`, 80,000) would be passed; `Retry-After` as for quota |

A 429/503 refuses the **whole batch**; nothing is stored.

### 2.1 `POST /api/v1/join`

Body `{}` or `{"client": "tsum-stats/0.25"}`. Reply **201**
`{"ok": true, "id": 17, "key": "<43 chars base64url of 32 random bytes>"}`.
The key is shown once; only its hash is kept. Joins are limited per address:
`join_limits` keyed by `HMAC(DEVICE_KEY, CF-Connecting-IP)` hex and the day.

### 2.2 `POST /api/v1/rounds`

Reply **200**:

```json
{"ok": true, "accepted": 240, "unchanged": 5, "duplicates": 3, "rejected": {"pace": 2}}
```

- `accepted`: rows inserted, or this contributor's rows whose figures changed.
- `unchanged`: this contributor's rows already stored with the same figures
  (no write).
- `duplicates`: rows another contributor sent first. Never changed; counted in
  this contributor's `dup_rounds`.
- `rejected`: §1.2 reasons with counts; only reasons that occurred.

`ok: true` means "do not send these again" (the script moves its cursor on
it), even when rows were rejected. A **banned** contributor gets the same
answers; their rounds are stored but left out of the public figures.

Writes, in one D1 batch: the rounds (insert, or update figures for this
contributor's changed rows), the settings, `devices` (per device in the batch:
insert or add `rounds`, widen first/last seen), `contributors` (last seen,
day rounds, `rounds_total`, `dup_rounds`), `budget` (rows written today), and
`dirty_days` (the UTC days of accepted rows). The quota counts accepted rows;
the budget counts rounds rows written.

### 2.3 `GET /api/v1/me`

```json
{"ok": true, "id": 17, "status": "active", "since": "2026-10-14", "lastSeen": "2026-10-14T18:05:00Z",
 "rounds": 12345, "duplicates": 3, "devices": 4, "first": "2026-08-20", "last": "2026-10-14",
 "today": {"rounds": 800, "quota": 5000}}
```

`rounds` is `rounds_total`; `devices` counts the contributor's `devices`
rows; `first`/`last` are the days of its earliest and latest `contrib_cells`
row (null before the first rollup). A banned contributor sees
`"status": "active"`.

### 2.4 `POST /api/v1/me/unlink`

Reply `{"ok": true}`. At once: `key_hash` is cleared (the key stops working),
the contributor's `devices` and `contrib_cells` rows are deleted, and its
status becomes `unlinking` (or stays marked banned: `unlinking-banned`). The
hourly job then re-files its rounds under contributor **0** in chunks
(`UNLINK_CHUNK`, 5,000 rows a run) and renames its archive files; a banned
contributor's rounds are deleted instead. When none are left, its row is
deleted. Unlinked rounds stay in the public figures and keep their device
hash (de-duplication needs it).

### 2.5 Admin

All `POST` with a JSON body, reply `{"ok": true, ...}`:

- `ban {id}` / `unban {id}`: status `banned` ↔ `active`; marks every day the
  contributor has rounds in D1 dirty.
- `merge {from, into}`: moves `from`'s rounds, devices, contrib_cells and
  counters to `into`, deletes `from`; marks their days dirty.
- `rebuild {from?, to?}`: marks the days (default: every day with rounds in
  D1) dirty.
- `restore {day}`: reads that day's archive files back into `rounds` (§3.4)
  and marks it dirty, so the next rollup recomputes it.
- `rollup {}`: runs the hourly job now (also how tests trigger it).

`GET /api/v1/admin/contributors` → `{"ok": true, "contributors": [{id,
status, createdAt, lastSeen, client, rounds, duplicates, devices}]}`.

## 3. Storage

### 3.1 D1 schema (`global/migrations/0001_init.sql`)

```sql
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
```

`rounds` has no secondary index on purpose: one row written per round. Every
scan of `rounds` is a key range (§1.1) or a `contributor` scan run in chunks
by the hourly job.

### 3.2 Hourly job (cron `5 * * * *`, and `POST /api/v1/admin/rollup`)

In order, each step bounded so a run fits Workers Free:

- **CPU.** 10 ms: the Worker passes SQL-built strings to R2 and never parses
  rows in bulk.
- **Queries.** 50 D1 queries per invocation: a run stops issuing new work at
  **45 queries or 40 R2 operations** (`RUN_QUERY_BUDGET`, `RUN_R2_BUDGET`) and
  leaves the rest for the next run. Each step records its progress in D1
  (`dirty_days`, `state`), so a run cut short loses nothing.

The steps:

1. **Recompute dirty days**, oldest first, at most `ROLLUP_DAYS_PER_RUN` (8).
   For each day, over its key range filtered to the day: `cells` from rounds
   whose contributor's status is not `banned`/`unlinking-banned`; `bins` the
   same way; `contrib_cells` from every round **except contributor 0's**, with
   `devices` = distinct device hashes. Upsert only changed rows; delete rows
   the day no longer has. Remove the day from `dirty_days`.
2. **Render** each recomputed day's **part file** (§4.2) to R2.
3. **Unlink**: per `unlinking` contributor, re-file up to `UNLINK_CHUNK`
   rounds to contributor 0 (marking their days dirty); per
   `unlinking-banned`, delete them instead. Rename its archive files
   (`c<id>.json` → `u<random hex>.json`, R2 copy then delete). Delete the
   contributor row when nothing is left.
4. **Archive and drop** (§3.4) each day older than `ACCEPT_DAYS + 1` days that
   still has rounds in D1.
5. **Compact**: a calendar month whose days are all older than
   `ACCEPT_DAYS + 1` and whose parts are all days gets one month part (§4.2)
   when its JSON is under 1.9 MB; its day parts are deleted.
6. **Manifest** (§4.1), when anything above changed or it is missing.

### 3.3 R2 layout (bucket `tsum-global`)

| Key | Public | Holds |
|:--|:--|:--|
| `data/global/manifest.json` | yes | §4.1 |
| `data/global/day-YYYY-MM-DD.<sha8>.json` | yes | One day's part |
| `data/global/month-YYYY-MM.<sha8>.json` | yes | One compacted month's part |
| `archive/YYYY-MM/YYYY-MM-DD/c<id>.json` | no | One contributor's rounds for one day |
| `archive/YYYY-MM/YYYY-MM-DD/u<hex>.json` | no | Unlinked rounds for one day |
| `archive/settings/<firstId>-<lastId>.json` | no | Settings rows, written once per new range |

`<sha8>` is the first 8 hex digits of the file's SHA-256. Only
`data/global/*` is served; the Worker answers `/data/global/<name>` from
R2, parts with `Cache-Control: public, max-age=31536000, immutable`, the
manifest with `public, max-age=300`, both `application/json`.

### 3.4 Archive files

```json
{"kind": "tsum-global-archive", "format": 1, "day": "2026-08-20", "contributor": 17, "n": 2,
 "key": ["…32 hex…"], "playedAt": [1787250000], "build": [0], "tsum": ["beastda"], "skill": [5],
 "items": [7], "version": ["3.0b4"], "settings": [12], "duration": [181.5], "score": [12345678],
 "base": [3000], "final": [4500], "medals": [null]}
```

`contributor` is null in a `u<hex>.json` file. Every settings id an archived
round names is in some `archive/settings/*.json`
(`{"kind": "tsum-global-settings", "format": 1, "settings": [{"id", "hash", "json"}]}`).
A day is deleted from D1 only after each of its files is written and its row
count matches.

## 4. Published files (the page reads these)

### 4.1 `manifest.json`

```json
{
  "kind": "tsum-global", "format": 1, "generatedAt": "2026-10-14T19:05:12Z",
  "rounds": 123456, "contributors": 12, "devices": 40,
  "first": "2026-08-20 00:01:02", "last": "2026-10-14 18:59:59",
  "parts": [{"from": "2026-10-14", "to": "2026-10-15", "file": "day-2026-10-14.1a2b3c4d.json", "rounds": 9000, "sha": "1a2b3c4d"}],
  "tsums": [{"tsum": "beastda", "rounds": 5000, "contributors": 4}],
  "medalTsums": ["…"],
  "skills": [2, 3, 4, 5, 6],
  "minContributors": 3
}
```

- `rounds`, `first`, `last` (sqlTime UTC): over the public cells.
- `contributors`: distinct contributors (not 0, not banned) with rounds in
  the last 30 days, from `contrib_cells`; `devices`: distinct device hashes of
  `devices` rows seen in the last 30 days.
- `parts`: `[from, to)` days, sorted by `from`, never overlapping.
- `tsums`: every Tsum in the public cells, most rounds first; `contributors`
  as above but per Tsum.
- `medalTsums`: the catalog's `medal: true` ids. `skills`: the distinct
  skill levels (not -1) in the cells, ascending.
- `minContributors`: below this the page flags a Tsum "few players".

### 4.2 Part files

One day (`day-…`) or one month (`month-…`), columnar like the snapshot's
month files:

```json
{
  "kind": "tsum-global-part", "format": 1, "from": "2026-10-14", "to": "2026-10-15",
  "cells": {"n": 2, "day": ["2026-10-14", "…"], "build": [0, 1], "tsum": ["beastda", "…"], "skill": [5, -1],
            "items": [7, -1], "medal": [0, 1], "rounds": [], "secs": [], "scoreSum": [], "scoreMin": [], "scoreMax": [],
            "first": [], "last": [], "baseSum": [], "baseSq": [], "baseMin": [], "baseMax": [],
            "finalSum": [], "finalSq": [], "finalMin": [], "finalMax": [],
            "medalsN": [], "medalsSum": [], "medalsSq": [], "medalsMin": [], "medalsMax": [], "medalsSecs": []},
  "bins": {"n": 1, "day": ["2026-10-14"], "build": [0], "tsum": ["beastda"], "skill": [5],
           "base": [{"231": 4, "232": 9}], "final": [{"…": 1}], "medals": [{}]}
}
```

Each array holds one value per row (`n` rows), in the `cells` table's column
meanings (§3.1). Rows are in no particular order. A part is built in one SQL
statement (`json_object` over `json_group_array` of one ordered subquery), so
its arrays line up.

## 5. Bins

For integer `v ≥ 0`:

```
bin(v) = v < 100 ? v : 100 + floor(ln(v / 100) / ln(1.02))
low(b) = b < 100 ? b : 100 · 1.02^(b − 100)      // the bin's lowest value
mid(b) = b < 100 ? b : round(100 · 1.02^(b − 99.5))
```

Values under 100 are exact; above, a bin is 2 % wide. The Worker computes
bins at ingest (JavaScript `Math.log`), so the page only ever uses `low`/`mid`.

## 6. The page in global mode

Built with `vite build --mode global` into `global/site/`; `index.html`
carries `<meta name="tsum-global" content="1">`. `api()` then sends every
route to `ui/src/lib/global/engine.js` in a Web Worker, reading
`data/global/` relative to the page.

### 6.1 Routes

| Route | Answer |
|:--|:--|
| `summary` | The server's `Summary` shape (`summary.go`), from the cells, see §6.2 |
| `tsums` | `manifest.tsums` (`{tsum, rounds, contributors}`) |
| `status` | `{global: true, rounds, contributors, devices, generatedAt, first, last, minContributors, skills}` |
| `themes` | The built-in themes in `site.go: themeOrder` order, `[{file, name}]` |
| `devices`, `round-devices`, `owned-sources` | `[]` |
| `owned` | `{list: null}` |
| `rounds`, `tsum`, anything else | throws "not available on the global site" |

### 6.2 Filters and figures

Parameters as `queries.go: ParseFilter`, plus two:

- Kept: `tsum` (comma list), `build`, `from`, `to`, `coins` (`final` /
  `medals`), `net=1`.
- New: `skill` (comma list of integers; `-1` = unknown) and `items` (comma
  list of item masks; `-1` = unknown).
- Ignored: `device`, the outlier bounds, `incomplete`, `tz` (days are UTC).
- **Days**: a cell counts when its day's 00:00 UTC is ≥ `from` (rounded down
  to a UTC day) and < `to`.

The figures follow `summary.go` and the snapshot engine exactly, from the
cells' sums (per-cell `n` = `rounds` for base and final; net coins are base or
final less `cost(items)` per round, so a cell's net sum = sum − rounds·cost,
min/max = min/max − cost, sq = sq − 2·cost·sum + rounds·cost², and a cell with
`items = -1` has no net coins; medals use the `medals*` columns with the rate
over `medalsSecs`). Medals mode (`coins=medals`) and the `medals` set use only
`medal = 1` cells.

- **Exact**: every count, sum, average, min, max, `coinsPerSec`,
  `stdCoins` (population variance from `Σsq/n − (Σ/n)²`), `first`, `last`,
  `daily`, `dailyTsums`, `mix`, and the `medals` set's totals and Tsums.
- **Approximate**: `q1Coins`, `medianCoins`, `q3Coins`, `p90Coins` from the
  bins. The nearest rank `1 + ⌊(n − 1)·k⌋` falls in a bin, and its `mid(b)`,
  clamped to the group's exact min and max, is the answer. That is within 2 %
  of the exact value, or exact under 100.
- **Histogram**: `histBounds` from the exact min/max and the approximate
  q1/q3, each bin's rounds put in the bucket holding `mid(b)`.
- **Not available** (null spreads, an empty histogram): with `net=1` or an
  `items` filter, since bins are kept per skill but not per item set.
- `hours` is always `[]`.
- An extra top-level `global: {approx: true, spreads: <bool>}` says whether
  spreads were computed.

A part that 404s (replaced since the manifest was read) makes the engine
reload the manifest once and retry.

## 7. The local side

### 7.1 Settings (`<data dir>/global.json`, mode 0600)

`{"url": "https://tsum-stats.gapscripts.app", "id": 17, "key": "…", "enabled": true, "joinedAt": "…", "sent": 12345, "lastUpload": "…", "lastError": "", "retryAt": ""}`

### 7.2 The forwarder

- It runs while `enabled`: first 2 minutes after start or a join, then every
  hour plus 0–10 minutes of jitter, and on **Upload now**.
- **Rounds it picks.** From `ts_rounds`: complete rounds (`completeSQL`), with
  `build` `global`/`jp` or a `jpVersion` setting, `played_at` within the last
  60 days and at least 20 minutes ago. The fingerprint is the record's
  FNV-1a 64 over its canonical JSON. It sends rows with no `ts_global_sent`
  row or a different fingerprint, oldest first, 250 at a time, and stops at
  the first refusal.
- **Never sent**: `device`, `source`, the Tsum lists, paths.
- **After `ok: true`**: every row in the batch goes into
  `ts_global_sent(round_id TEXT PRIMARY KEY, hash INTEGER NOT NULL, sent_at TEXT NOT NULL)`
  (including rejected rows, which a change of figures sends again).
- **On refusals.** 429/503: `retryAt` = now + `Retry-After`, and the pass
  stops. 401: the key is forgotten, `enabled` is off and `lastError` says to
  join again. Anything else: `lastError`, and the next hourly pass.

### 7.3 Local routes (`server.go`)

`POST` routes are guarded by `sameOrigin`.

- `GET /api/stats/global`:
  `{enabled, joined, url, id, sent, pending, lastUpload, lastError, retryAt, me}`.
  `pending` counts rows waiting; `me` is the last `/api/v1/me` answer or null.
- `POST /api/stats/global/join`: joins (or re-enables a saved key), then runs a
  pass.
- `POST /api/stats/global/run`: a pass now.
- `POST /api/stats/global/leave` `{unlink: bool}`: stops; with `unlink`, calls
  `/api/v1/me/unlink` and forgets the key.
- Realtime topic `ts/global`: the `GET` state after every change.
- Flag `--global-url` (default `https://tsum-stats.gapscripts.app`).
