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
The forwarder sends exactly what the script sends when it posts directly
(Share round stats, §2.2.1).

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
  script does not send it). The Worker takes up to 250; the forwarder sends at
  most 100 (§7.2) and the script 50, which keeps one request's CPU well under
  Workers Free's 10 ms.
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
- **A round's day is the UTC day it started**, from the id's time, not its
  end (`played_at`). Rounds of some Tsums last hours, so the end can fall on
  a later day. Keys sort by start time, so a day is exactly the key range
  `hex48(dayStartMs) + "00000000000000000000"` ≤ key <
  `hex48(dayEndMs) + "00000000000000000000"`, with no margin and no
  `played_at` filter. This is the one place the global figures differ from
  the local site's, which files a round under the day it ended.

### 1.2 What is accepted

A record is **rejected** (counted under the reason, never stored) when,
checked in this order:

| reason | rule |
|:--|:--|
| `id` | not a UUIDv7 as above, or `datetime` unreadable, or `played_at` more than 10 minutes **before** the id's start time (clock skew). There is no limit on how long after the start a round may end |
| `old` | the id's start time is more than **60 days** (`ACCEPT_DAYS`) before now, or its start day is on or before a day already archived (§3.4; such a day is final even if `ACCEPT_DAYS` grows) |
| `future` | the id's start time or `played_at` is more than 10 minutes after now |
| `tsum` | `tsum` is not a Tsum id at all: not `/^[A-Za-z0-9_.-]{1,48}$/` |
| `settings` | the settings are past their bounds: more than 64 setting columns with a value, a setting name over 64 characters, a value over 256 characters, or the canonical settings JSON over 4,096 bytes (UTF-8). Empty cells do not count |
| `field` | `script_version` or `skill_type` over 64 characters (`records.ts: FIELD_MAX`), or with a control character (U+0000–U+001F, U+007F). A field is kept whole or the record is not kept: never cut short |
| `build` | `build` is not `global`/`jp`, and the settings have no boolean `jpVersion` (true → `jp`, false → `global`) |
| `incomplete` | `score`, `base_coins`, `final_coins` or `duration_seconds` is null, or `medals` is null for a catalog `medal: true` Tsum |
| `duration` | `duration_seconds` is 0 or less (no rate can be made of it). There is **no upper limit**: rounds of some Tsums last hours |
| `range` | `score` outside 0–200,000,000, `base_coins` 0–50,000, `final_coins` 0–1,500,000, `medals` 0–2,000 |
| `repeat` | the same key twice in one batch (the first, in batch order, is kept) |
| `pace` | within the batch, a round from the same device starting less than 40 s after the device's previous kept round (sorted by key) |

**`future` is the one reason that can pass later** (the sender's clock is
ahead of the site's): the reply names those records in `retry` (§2.2), and
the forwarder sends them again. Every other rejection is final for that
record as sent; only a change to the record sends it again.

**A Tsum the catalog lacks.** The Worker bundles `ui/public/data/catalog.json`
at deploy. A well-formed id it does not have (a Tsum newer than the deploy)
is **accepted**: stored, archived, counted in `contrib_cells`, `recent` and
the contributor's counters, but left out of every public table and file
(`cells3`, `cell_bins3`, the parts, the manifest) until a deploy's catalog has it.
Then `POST /api/v1/admin/rebuild` brings in its days still in D1 (an archived
day needs `restore` first). Its medals may be null: `incomplete` applies the
medals rule only to the catalog's `medal: true` Tsums.

Derived from an accepted record:

- **build**: 0 = global, 1 = jp.
- **skill**: `settings.skillLevel` when it is an integer 1–10, else **-1**.
- **items**: when the settings have `bonusCoin`, the bitmask of the true
  `bonus*` items (`summary.go: itemBits`: bonusCoin 1, bonus5to4 2,
  bonusTime 4, bonusExp 8, bonusScore 16, bonusBubble 32, bonusCombo 64);
  else **-1**. Item costs, for net coins: 1→500, 2→1800, 4→1000, 8→500,
  16→500, 32→1500, 64→1200.
- **medals**: null stays null (a non-medal Tsum's unread medals).
- **version**: `script_version`, in full (trimmed, as every cell is).
- **skill type**: `skill_type`, in full; `""` when the record has none.
- **play settings** (`snapshot/engine.js: PLAY_SETTINGS`, `playValue`;
  `queries.go: PlaySettings`): **scan** from `maxChainsPerScan` and
  **chain** from `maxChain`, each a whole number 0–999, else **-1**;
  **bubble** from `bubbleStrategy`, a string of 1–64 letters, digits, `_`,
  `.` or `-`, else `""`. The settings keep the value as sent either way.
- **settings id**: the settings object as canonical JSON (keys sorted,
  `JSON.stringify` of the sorted object) → its SHA-256 hex `hash` → the
  `settings` row with that hash (inserted once).
- **bins** (§5): `bin(base)`, `bin(final)`, and `bin(medals)` when medals > 0
  (else null).
- **known**: whether the bundled catalog has the Tsum; only then do its rounds
  reach the public figures.

## 2. The Worker's HTTP API

Host `https://tsum-stats.gapscripts.app`. JSON in and out; every reply has
`ok`. **Every `POST` under `/api/` must say `Content-Type: application/json`**
(parameters such as `charset` allowed), or it is refused with 415, after the
route and method are checked and before the key is: a page on another site
can send a form or `text/plain` without asking first (CORS), and so could
otherwise join, or spend its visitors' joins. A request body may be gzipped
(`Content-Encoding: gzip`) and is at most 1 MiB after inflating.

| Route | Auth | Does |
|:--|:--|:--|
| `POST /api/v1/join` | none | Makes a contributor |
| `POST /api/v1/rounds` | contributor, or none to join first (§2.2.1) | Takes a `gap.round-stats/1` batch |
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
| 401 | `unauthorized` | No key (an upload with no `Authorization` header joins instead, §2.2.1), or one that matches no active/banned contributor; or, for an upload, the contributor unlinked while the upload was on the way (checked in the upload's own batch) |
| 404 | `not-found` | No such route |
| 405 | `method` | Wrong method |
| 413 | `too-large` | Body over 1 MiB |
| 415 | `content-type` | A `POST` that is not `application/json` |
| 429 | `quota` | The contributor's daily quota (`QUOTA_PER_CONTRIBUTOR`, 250,000 rounds as deployed) would be passed; `Retry-After` = seconds to the next 00:00 UTC |
| 429 | `join-limit` | More than 5 joins today from this address (§2.1); `Retry-After` as for quota |
| 500 | `internal` | A fault, or the `DEVICE_KEY` secret is not set (no key or device hash is ever made without it) |
| 503 | `budget` | Today's write budget (§2.6) would be passed; `Retry-After` as for quota |

A 401, 429 or 503 refuses the **whole batch**; nothing is stored. Only
`quota`, `join-limit` and `budget` ask the sender to wait (`Retry-After`);
the forwarder treats any other refusal, and any reply that is not the
Worker's JSON (a platform error page), as a plain failure (§7.2).

### 2.1 `POST /api/v1/join`

Body `{}` or `{"client": "tsum-stats/0.25"}`. Reply **201**
`{"ok": true, "id": 17, "key": "<43 chars base64url of 32 random bytes>"}`.
The key is shown once; only its hash is kept. Ids are given out in order and
never twice, even after the newest contributor's row is deleted (`state`
`contributor_seq`): archive files and merges name contributors by id.

Joins are limited to 5 a UTC day per address: `join_limits` keyed by
`HMAC(DEVICE_KEY, address)` hex and the day, where the address is
`CF-Connecting-IP` read as:

- an IPv4 address, as sent;
- an IPv6 address, by its **/64** (a host is usually handed a whole /64),
  written as its first four groups zero-padded plus `::/64`, e.g.
  `2001:0db8:0001:0002::/64`;
- an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`), as the IPv4 address.

The limit and the budget (§2.6: a join is 4 rows, refused past the uploads'
cap) are checked inside the batch that counts the join, so a refused join
(`429 join-limit`, `503 budget`) writes nothing. `join_limits` rows are
deleted at the first run after 00:00 UTC.

### 2.2 `POST /api/v1/rounds`

Reply **200**:

```json
{"ok": true, "accepted": 240, "unchanged": 5, "duplicates": 3, "rejected": {"pace": 2, "future": 1}, "retry": ["0192…"], "keeps": 2, "resend": 0}
```

- `accepted`: rows inserted, or this contributor's rows whose figures changed.
- `unchanged`: this contributor's rows already stored with the same figures
  (no write).
- `duplicates`: rows another contributor sent first. Never changed; counted in
  this contributor's `dup_rounds`.
- `rejected`: §1.2 reasons with counts; only reasons that occurred.
- `retry`: the record ids, exactly as sent, of the records rejected for a
  reason that can pass later (`future`). Always there, possibly `[]`.
- `keeps`: what the Worker keeps of a record (`ingest.ts: KEEPS`): **2** is
  every field in full, `skill_type` included (`0003_skill_type.sql`). A
  Worker before it leaves `keeps` out. When it goes up, the forwarder sends
  every round in its window once more (§7.2), so the rounds the site kept
  without a field get it.
- `resend`: the site's last **call for a full re-upload** (`state` `resend`,
  raised by `POST /api/v1/admin/resend`, §2.5), 0 until the first. Read in
  the key's own query (`contributors.ts: authContributor`), so it costs no
  statement. When it goes up, the forwarder sends every round it has once
  more (§7.2). `/api/v1/me` carries it too, so a pass with nothing new to
  send hears of it. A Worker before it leaves `resend` out (0).

`ok: true` means "do not send these again" (the script moves its cursor on
it), even when rows were rejected, **except the records named in `retry`**,
which the sender sends again later. A **banned** contributor gets the same
answers; their rounds are stored but left out of the public figures.

The rows D1 already has of the batch are read first: its rounds, its settings
hashes and this contributor's `devices` rows for its devices, so an unchanged
re-send writes no rounds and the writes can be counted before they run. Then
**one D1 batch** (one transaction) makes three checks, any of which rolls the
whole batch back: the contributor is still `active` or `banned` (else 401:
it unlinked after its key was checked, and nothing may land under its id
again), its quota (`429 quota`, on accepted rows) and today's budget
(`503 budget`, §2.6). The same batch writes:

- `settings`: the batch's new settings objects (each new row is 2 rows
  written, for the UNIQUE index);
- `rounds`: inserts, and this contributor's changed rows (one statement; the
  settings ids are looked up as one map for the batch's hashes);
- `pending`: one row for the batch's newly inserted rounds, added up as the
  day tables keep them (`ingest.ts: aggregate`): their `cells3` and `cell_bins3`
  rows (the catalog's Tsums only), their `contrib_cells` rows by device,
  their start days, and `{tsum: the newest of those days}`. The hourly job
  adds these in (§3.2, step 1a) without reading `rounds`;
- `dirty_days`: the start days of this contributor's **changed** rows (a
  changed round is recomputed, never added on top: a minimum cannot be taken
  back), and, when another upload stored one of this batch's new rounds a
  moment earlier (the insert wrote fewer rows than expected), the batch's
  days, so its `pending` sums are never counted twice (§3.2: `skip`). A start
  day never moves, since it comes from the key;
- `devices`: per device with a round that passed the checks (duplicates and
  unchanged rows included, so a player's second install shows up): insert or
  widen first/last seen; `rounds` adds newly inserted rows. A row is written
  only when something changes;
- `contributors`: last seen; `day_rounds` adds accepted rows (the quota),
  `rounds_total` inserted rows, `dup_rounds` duplicates;
- `budget`: the rows the batch writes (§2.6).

The quota counts accepted rows; the budget counts every row written. A batch
of 250 records takes about 15 D1 statements in all.

### 2.2.1 An upload with no key

The Tsum script can only send to the one URL the player's GAP setting names,
so it cannot call `/join`. An upload with **no `Authorization` header at all**
joins first, as §2.1 does (same join limit, same budget, `client` read from
the batch's own `client` field), then is stored under the new contributor.
A header that is not a valid Bearer key is still a 401, never a join.

- The batch is read and checked (400 `bad-request`) **before** joining, so a
  bad one makes no contributor and counts no join.
- A refused join (429 `join-limit`, 503 `budget`) writes nothing and hands out
  no key.
- Otherwise the reply carries `id` and `key` beside the usual fields: on
  **200** with `ok: true`, and also on a refusal of the batch itself
  (`quota`, `budget`), since the contributor exists by then and the key is
  the sender's only way back to it.
- The sender keeps the key and sends it from then on; a 401 for it later
  (unlinked) means dropping it and sending keyless again.

### 2.3 `GET /api/v1/me`

```json
{"ok": true, "id": 17, "status": "active", "since": "2026-10-14", "lastSeen": "2026-10-14T18:05:00Z",
 "rounds": 12345, "duplicates": 3, "devices": 4, "first": "2026-08-20", "last": "2026-10-14",
 "today": {"rounds": 800, "quota": 250000}, "resend": 0}
```

`rounds` is `rounds_total` (a Tsum the catalog lacks included); `devices`
counts the contributor's `devices` rows; `first`/`last` are the days of its
earliest and latest `contrib_cells` row (null before the first rollup), kept
as `state` `span:<id>`, which each rollup only widens (reading
`contrib_cells` by contributor would scan the whole table). A banned
contributor sees `"status": "active"`.

### 2.4 `POST /api/v1/me/unlink`

Reply `{"ok": true}`. Never refused: leaving always works, and its writes are
counted like any others (§2.6). **At once**, in one batch:

- `key_hash` is cleared (the key stops working), and the status becomes
  `unlinking` (or `unlinking-banned` for a banned contributor);
- its `devices` rows are deleted, its `contrib_cells` within its span, its
  `span:<id>` and its `recent` rows; `state` `people` is dropped (§3.2,
  step 6);
- `state` `unlink:<id>` = `{days: [[day, about its rounds there], …], ids:
  [it, and every id merged into it]}`: every `contrib_cells` day it ever had
  (read within its span, however long ago) and the days of its rounds still
  in `pending`; the ids by a walk of `merged:*`.

An upload whose key was checked before the unlink and whose batch lands after
it gets 401 and stores nothing (§2.2).

**The hourly job then finishes it** (§3.2, step 3), day by day, about
`UNLINK_CHUNK` (5,000) rounds a run in whole days, within the day's write and
read budgets:

- for a day archived, or being archived (on or before `archived_through` + 1),
  each id's files (`c<id>.json`, `c<id>.<k>.json`) are renamed to
  `u<hex>.json`, or to **`b<hex>.json` for a banned contributor**, and the
  `"contributor"` in each becomes null;
- for a day with rounds in D1, they are re-filed under contributor **0** (one
  `UPDATE` on the day's key range and contributor), or **deleted** for a
  banned contributor (whose rounds were never public, and must not become so
  by leaving);
- no day is marked dirty: neither changes a public figure.

When no day is left it deletes the contributor row (and any `devices` row
left), `unlink:<id>` and `merged:<from>` for the merged ids; for a banned
contributor it writes `state` `gone:<id>` = `"banned"` for it and each merged
id, so a file that still names one is never restored as anyone's. Unlinked
rounds stay in the public figures and keep their device hash (de-duplication
needs it). A banned contributor's rounds of days not yet archived are deleted,
so never archived; its files already archived are kept as `b` files, and
never restored.

### 2.5 Admin

All `POST` with a JSON body, reply `{"ok": true, ...}`. Their writes are
counted in the day's budget (§2.6).

- `ban {id}` / `unban {id}`: status `banned` ↔ `active`; marks dirty the days
  the contributor has rounds in D1 (its `contrib_cells` days within its span
  after `dropped_through`, and its `pending` days), and drops `state`
  `people`. Never refused for the budget, so moderation never waits for a
  budget a bad contributor may have spent. Reply `{id, status, days}`.
- `merge {from, into}`: moves `from` to `into`: its rounds (found by those
  days' key ranges, not by a scan of the whole table), its `pending` rows,
  `contrib_cells` (archived days too: rows of the same key add up, and
  `devices` is the exact count of the union of their `device_set`), devices,
  counters, span and `recent` rows; deletes `from`; marks its days dirty; drops
  `state` `people`; sets `state` `merged:<from>` = `into`, so a restore files
  `c<from>.json`'s rounds under `into` (archive files are not renamed).
  Refuses `from = into` (400). Refused with `503 budget` when it would take
  the day past `BUDGET_ROWS_PER_DAY`.
- ban, unban and merge refuse a contributor being unlinked or id 0 (400) and
  an unknown id (404).
- `rebuild {from?, to?}`: marks the days (default: from the oldest round in D1
  to today) dirty, at most 400 (else 400). A day whose rounds have left D1 is
  left as it is when its turn comes. Reply `{from, to, days}`.
- `restore {day}`: for a day on or before `archived_through` only (else 400).
  A day archived but not yet dropped (its rounds still in D1) is only marked
  dirty: `{day, done: true, files: 0, left: 0, rounds: 0}`. Otherwise its
  archive files come back into `rounds` (§3.4), a file at a time, each
  checked against the day's write budget less `JOB_RESERVE_ROWS` / 5; within
  one invocation's budget, so a big day takes several calls: reply `{day,
  done, files, left, rounds}`, progress kept in `state` `restore:<day>`.
  After the last file the day is marked dirty and added to `state`
  `restored`; once recomputed its rounds leave D1 again, with no files
  rewritten.
- `resend {}`: calls for a full re-upload: `state` `resend` goes up by one
  (from 0), and every reply after it names the new number (§2.2). Reply
  `{resend}`. Never refused for the budget (one row). Each contributor's next
  pass sends every round in its window again; unchanged rounds write nothing,
  changed ones are recomputed as any change is. The window is the
  forwarder's 60 days, which is all §1.2 accepts: an archived day stays final.
- `rollup {}`: runs the hourly job now (also how tests trigger it); the reply
  is the run's report: `{folded, recomputed, rendered, unlinked, archived,
  dropped, compacted, manifest, more, queries, r2, read, written, bytes,
  errors}`. `folded` counts the rounds added in from `pending`;
  `recomputed` the days recomputed in full; `rendered` the files published;
  `read`/`written` the rows D1 read and wrote; `bytes` what it put to R2;
  `errors` the steps that failed, as `"<step>: <message>"`; `more: true`
  means work is left for the next run.

`GET /api/v1/admin/contributors` → `{"ok": true, "contributors": [{id,
status, createdAt, lastSeen, client, rounds, duplicates, devices}]}`.

### 2.6 The daily write budget

D1 Free writes 100,000 rows a day and refuses every query for the rest of the
UTC day past it. **One budget, `budget.rows` for the UTC day, counts every row
D1 writes or deletes** (`meta.rows_written`) for anything the Worker does:
uploads, joins, unlinks, the admin routes, restores and the hourly job.
`budget.reads` adds up the rows read, roughly.

- `BUDGET_ROWS_PER_DAY` (1,500,000 as deployed on Paid; 90,000 on Free): the day's cap for everything.
- `JOB_RESERVE_ROWS` (375,000; 25,000 on Free): the part of it uploads and joins never take.
  **An upload or a join is refused (`503 budget`) when its writes would take
  the day past `BUDGET_ROWS_PER_DAY − JOB_RESERVE_ROWS`** (1,125,000; 65,000 on Free), counting
  everything already written that day, the job's included.
- The check and the count are statements of the same D1 batch as the writes
  (a batch is one transaction): a refusal statement inserts into `refusals`,
  whose `CHECK` constraints (`quota`, `budget`, `join_limit`, `unlinked`) abort
  the whole batch, and an upsert reserves the batch's expected rows. So
  requests running at once cannot both pass a limit. After the batch the day
  is corrected to what D1 says it wrote.
- Admin `merge` is refused past `BUDGET_ROWS_PER_DAY`. Ban, unban, rebuild
  and unlink are never refused, only counted.
- The hourly job spends from the reserve. Adding new rounds in (step 1a) may
  go to `BUDGET_ROWS_PER_DAY`; every other step keeps a margin of
  `JOB_RESERVE_ROWS` / 5 and puts off what does not fit (a recompute, an
  unlink's next day, archive work, a drop, a compaction) to the next run, or
  the next day. Each run records what it wrote at its end, whatever happened.
- `READ_BUDGET_PER_DAY` (4,000,000, under Free's 5 million): past it the job
  puts off the work that reads a lot (full recomputes, unlinks, the archive,
  drops).

Budget rows older than 7 days are deleted at the first run after 00:00 UTC.

## 3. Storage

### 3.1 D1 schema (`global/migrations/0001_init.sql`, `0002_cell_bins.sql`, `0003_skill_type.sql`)

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
  bin_medals INTEGER,                    -- NULL unless medals > 0
  skill_type TEXT NOT NULL DEFAULT '',   -- 0003: as sent; '' for none, and for every round stored before 0003
  scan INTEGER NOT NULL DEFAULT -1,      -- 0003: the play settings (§1.2), -1 and '' not recorded;
  chain INTEGER NOT NULL DEFAULT -1,     --   made from their settings for the rounds stored before
  bubble TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;

-- Days to recompute in full from their rounds: a ban, a changed round, a rebuild, a restore.
CREATE TABLE dirty_days (day TEXT PRIMARY KEY) WITHOUT ROWID;

-- New rounds waiting to be added into the day tables, one row per upload batch,
-- added up by the upload as the day tables keep them.
CREATE TABLE pending (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  contributor INTEGER NOT NULL,
  n INTEGER NOT NULL,                    -- rounds
  days TEXT NOT NULL,                    -- the start days they fall on
  tsums TEXT NOT NULL,                   -- {tsum: the newest of those days with a round of it}
  cells TEXT NOT NULL,                   -- the cells3 rows they add to (the catalog's Tsums only)
  bins TEXT NOT NULL,                    -- '[]': the per-skill bins of before 0002, no longer written
  cell_bins TEXT NOT NULL DEFAULT '[]',  -- the cell_bins3 rows they add to: [day, build, tsum, skill, skill_type, items, scan, chain, bubble, medal, jackpot, {base}, {final}, {medals}]
  cc TEXT NOT NULL,                      -- [day, build, tsum, device, rounds, secs, base, final, medals]
  format INTEGER NOT NULL DEFAULT 0      -- 0004: 1 when cells and cell_bins have the jackpot key; 0, summed before, is not folded (§3.2)
);

-- What D1 wrote (rows inserted, changed or deleted) and read per UTC day, for everything (§2.6).
CREATE TABLE budget (day TEXT PRIMARY KEY, rows INTEGER NOT NULL, reads INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
-- Never holds a row: a batch inserts into it only to stop itself, and D1 rolls the whole batch back.
CREATE TABLE refusals (
  quota INTEGER CONSTRAINT quota CHECK (quota IS NULL),
  budget INTEGER CONSTRAINT budget CHECK (budget IS NULL),
  join_limit INTEGER CONSTRAINT join_limit CHECK (join_limit IS NULL),
  unlinked INTEGER CONSTRAINT unlinked CHECK (unlinked IS NULL)
);
CREATE TABLE join_limits (ip_hash TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, day)) WITHOUT ROWID;
CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

-- Public: one row per day × build × Tsum × skill × skill type × items × scan × chain × bubble × (medals > 0) × jackpot (0004).
CREATE TABLE cells3 (
  day TEXT NOT NULL, build INTEGER NOT NULL, tsum TEXT NOT NULL, skill INTEGER NOT NULL, skill_type TEXT NOT NULL,
  items INTEGER NOT NULL, scan INTEGER NOT NULL, chain INTEGER NOT NULL, bubble TEXT NOT NULL,
  medal INTEGER NOT NULL,                                   -- medal: 1 when medals > 0
  jackpot INTEGER NOT NULL,                                 -- jackpot: 1 when final > 10 × base (a coin-bonus jackpot)
  rounds INTEGER NOT NULL, secs REAL NOT NULL,
  score_sum INTEGER NOT NULL, score_min INTEGER NOT NULL, score_max INTEGER NOT NULL,
  first INTEGER NOT NULL, last INTEGER NOT NULL,            -- epoch s
  base_sum INTEGER NOT NULL, base_sq REAL NOT NULL, base_min INTEGER NOT NULL, base_max INTEGER NOT NULL,
  final_sum INTEGER NOT NULL, final_sq REAL NOT NULL, final_min INTEGER NOT NULL, final_max INTEGER NOT NULL,
  medals_n INTEGER NOT NULL, medals_sum INTEGER NOT NULL, medals_sq REAL NOT NULL,
  medals_min INTEGER, medals_max INTEGER, medals_secs REAL NOT NULL,
  PRIMARY KEY (day, build, tsum, skill, skill_type, items, scan, chain, bubble, medal, jackpot)
) WITHOUT ROWID;

-- Public: one row per cells3 row (its key), each a JSON object {"<bin>": [rounds, secs, score, base, final, medals]}.
CREATE TABLE cell_bins3 (
  day TEXT NOT NULL, build INTEGER NOT NULL, tsum TEXT NOT NULL, skill INTEGER NOT NULL, skill_type TEXT NOT NULL,
  items INTEGER NOT NULL, scan INTEGER NOT NULL, chain INTEGER NOT NULL, bubble TEXT NOT NULL, medal INTEGER NOT NULL,
  jackpot INTEGER NOT NULL,
  base TEXT NOT NULL, final TEXT NOT NULL, medals TEXT NOT NULL,  -- medals: {} unless medal = 1
  PRIMARY KEY (day, build, tsum, skill, skill_type, items, scan, chain, bubble, medal, jackpot)
) WITHOUT ROWID;

-- Before 0004: cells3 and cell_bins3 without jackpot (0003). Kept, no longer written or read, so a Worker
-- rolled back to before 0004 still finds them.
CREATE TABLE cells2 (… cells3's columns but jackpot …, PRIMARY KEY (day, build, tsum, skill, skill_type, items, scan, chain, bubble, medal)) WITHOUT ROWID;
CREATE TABLE cell_bins2 (… cell_bins3's columns but jackpot …, PRIMARY KEY (day, build, tsum, skill, skill_type, items, scan, chain, bubble, medal)) WITHOUT ROWID;

-- Before 0003: cells2 and cell_bins2 without skill_type or the play settings (cell_bins from 0002). Kept, no longer
-- written or read, so a Worker rolled back to before 0003 still finds them.
CREATE TABLE cells (… cells2's columns but skill_type, scan, chain and bubble …, PRIMARY KEY (day, build, tsum, skill, items, medal)) WITHOUT ROWID;
CREATE TABLE cell_bins (… cell_bins2's columns but skill_type, scan, chain and bubble …, PRIMARY KEY (day, build, tsum, skill, items, medal)) WITHOUT ROWID;

-- Before 0002: histogram bins per day × build × Tsum × skill, {"<bin>": rounds}. Kept, no longer
-- written or read, so a Worker rolled back to before 0002 still finds it.
CREATE TABLE bins (
  day TEXT NOT NULL, build INTEGER NOT NULL, tsum TEXT NOT NULL, skill INTEGER NOT NULL,
  base TEXT NOT NULL, final TEXT NOT NULL, medals TEXT NOT NULL,  -- medals: rounds with medals > 0
  PRIMARY KEY (day, build, tsum, skill)
) WITHOUT ROWID;

-- A final day's rounds on their way to the archive: its files' arrays as text,
-- one row per contributor per share of the day (in key order), until the files are written.
CREATE TABLE archive_parts (
  day TEXT NOT NULL, contributor INTEGER NOT NULL, part INTEGER NOT NULL,
  n INTEGER NOT NULL, bytes INTEGER NOT NULL, last TEXT NOT NULL,   -- rounds, their length as text, the last key
  key TEXT NOT NULL, played_at TEXT NOT NULL, build TEXT NOT NULL, tsum TEXT NOT NULL, skill TEXT NOT NULL,
  items TEXT NOT NULL, version TEXT NOT NULL, settings TEXT NOT NULL, duration TEXT NOT NULL, score TEXT NOT NULL,
  base TEXT NOT NULL, final TEXT NOT NULL, medals TEXT NOT NULL,
  skill_type TEXT NOT NULL DEFAULT '',   -- 0003, with scan, chain and bubble
  scan TEXT NOT NULL DEFAULT '', chain TEXT NOT NULL DEFAULT '', bubble TEXT NOT NULL DEFAULT '',
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
```

A cell's figures are over its rounds: `secs` their durations; `score_*`,
`base_*`, `final_*` every round's (`*_sq` is the exact integer sum of squares,
kept as REAL). The `medals_*` columns are over the rounds whose medals were
read (not null): `medals_n` counts them, `medals_secs` adds their durations.
A `cell_bins3` row holds the bins of the same cell's rounds: each of its
rounds counted in the bin of its base coins, of its final coins and, when it
earned any, of its medals. An object's keys are bin numbers (§5) as text, in
any order; each value is that bin's figures (§5). `medals` is `{}` in a
`medal = 0` row. `jackpot` is 1 for a cell of coin-bonus jackpots: rounds
whose final coins are over 10 times their base coins (`JACKPOT_TIMES` in
`ui/src/lib/snapshot/engine.js`, `records.ts: JACKPOT_SQL`, `queries.go:
jackpotSQL`), the +Coin item's rare 11×, 21× and 51× bonuses, which the Tsum
page leaves out of final coins (§6.3). `cells3` and `cell_bins3` hold the catalog's Tsums
only (§1.2); `contrib_cells` every Tsum. The day tables are kept for good,
archived days' too.

`0002_cell_bins.sql` adds `cell_bins` and `pending.cell_bins`, and marks
every day with cells or waiting uploads dirty, so the next runs recompute
each one into `cell_bins` and publish it again in part format 2. A day whose
rounds have left D1 (`dropped_through`) cannot be recomputed, and keeps no
bins (none had when it was added).

`0003_skill_type.sql` adds `skill_type` and the play settings (`scan`,
`chain`, `bubble`) to `rounds` and `archive_parts`, and `cells2` and
`cell_bins2` in place of `cells` and `cell_bins` (whose key cannot grow in
place). The rounds stored before it get their play settings from their
settings, in SQL with `records.ts: playSQL`'s words (held to `playValue` by
`test/records.test.ts`). Every `cells` row is copied in under skill type `''`
and no play settings, so a day whose rounds have left D1 keeps its figures,
and every day is marked dirty, so a day whose rounds are still in D1 is made
again from them, play settings and all. Waiting uploads summed their rounds
without either, so their days are marked dirty too and their `pending` rows
deleted: the recompute makes from the rounds everything the fold would have.
A round's skill type arrives when its contributor's forwarder sends it again
(§2.2: `keeps`, §7.2), which changes the round and recomputes its day.

`0004_jackpot.sql` adds `cells3` and `cell_bins3` in place of `cells2` and
`cell_bins2`, keyed by `jackpot` too, which comes from each round's base and
final coins, so `rounds` gains nothing. Every `cells2` row is copied in as no
jackpot, so a day whose rounds have left D1 keeps its figures (its jackpots
stay in them until a `restore`), and every day is marked dirty, so a day still
in D1 is made again from its rounds. It adds `pending.format`: an upload's
sums made before it, or by the Worker before it in the moment between the
migration and the deploy, are 0, and the fold does not add their cells and
bins in but marks their days dirty to be made again from the rounds
(`rollup.ts: FOLD_OLD`); their `contrib_cells` sums are added as before.

`rounds` has no secondary index on purpose: one row written per round. Every
scan of `rounds` is a key range (§1.1); none reads it by contributor.

### 3.2 Hourly job (cron `5 * * * *`, and `POST /api/v1/admin/rollup`)

Each step is bounded so a run fits Workers Free:

- **CPU.** 10 ms: D1 builds every part and archive file, and the Worker hands
  the string to R2 without parsing it. A run carries about `RUN_BYTES`
  (2,000,000) from D1 to R2 at most (the first file always goes).
- **Queries.** 50 D1 queries per invocation: a run stops issuing new work at
  **45 queries or 40 R2 operations** (`RUN_QUERY_BUDGET`, `RUN_R2_BUDGET`),
  holding back what step 6 needs, and leaves the rest for the next run.
- **Values.** D1 refuses a value over 2,000,000 bytes, so the Worker never
  asks it to build one over `VALUE_MAX_BYTES` (1,500,000): parts, archive
  files and settings files are sized first and split.
- **The day's budget** (§2.6).

Each step records its progress in D1 (`pending`, `dirty_days`, `state`), so a
run cut short loses nothing. **Each step is isolated**: one that fails is
logged, added to the report's `errors`, and the steps after it and step 6
still run; the next run tries it again.

The steps:

1. **The day tables** (`cells3`, `cell_bins3`, `contrib_cells`):
   1. **Fold** the `pending` sums in, oldest upload first, up to 25,000 rounds
      a run, in one batch. Who a round counts for is decided by its
      contributor's status at fold time: a banned one's (`banned`,
      `unlinking-banned`, or gone as `gone:<id>` = `"banned"`) stay out of
      `cells3` and `cell_bins3`; those of contributor 0 or of one `unlinking`,
      `unlinking-banned` or no longer there stay out of `contrib_cells`,
      `span:<id>` and `recent`. Bins objects are merged per upload without a
      sort; a `contrib_cells` row's `device_set` is merged only when a new
      device appears. A day's sums already read by a full recompute are not
      added again: `state` `skip` = `{day: seq}`. The fold may spend to the
      full `BUDGET_ROWS_PER_DAY`. An upload's sums of an older layout
      (`pending.format` 0) add only their `contrib_cells`; their days are
      marked dirty, and the run asks for another.
   2. **Recompute** the claimed dirty days in full, oldest first, at most
      `ROLLUP_DAYS_PER_RUN` (8), within the run's queries and
      `READ_BUDGET_PER_DAY`. Only a ban, an unban, a changed round, a merge, a
      rebuild or a restore makes a day dirty. Over the day's key range (§1.1):
      `cells3` and `cell_bins3` from rounds of the catalog's Tsums whose contributor
      is not `banned`/`unlinking-banned`; `contrib_cells` from every round
      **except contributor 0's and those of contributors being unlinked**,
      with `devices` = distinct device hashes (`device_set`). It upserts only
      changed rows and deletes rows the day no longer has, in SQL, widens
      spans and `recent`, and marks the day in `skip`. A day whose rounds have
      left D1 (and were not restored) keeps its tables as they are.
2. **Render** the part (§4.2) of each day whose tables changed (`state`
   `render` keeps the days still to do), oldest first. A replaced file goes
   to `state` `trash` (step 6).
3. **Unlink** (§2.4), day by day, about `UNLINK_CHUNK` rounds a run per
   contributor in whole days.
   - 3b. A **restored** day's rounds leave D1 again once it is recomputed.
4. **Archive** (§3.4) each day older than `ACCEPT_DAYS` + 1 days, in order:
   **stage** it into `archive_parts` a share at a time (at most 0.8 ·
   `VALUE_MAX_BYTES` / `ROUND_BYTES` rounds a statement, `ROUND_BYTES` = 436
   being the longest a round can be with a 64-character version and skill
   type; each share starting after the last key staged, so the day is read
   once; up to 8 shares a batch, fewer when the run has room for fewer),
   then write any new settings rows to `archive/settings/` (each file as
   big as the run's bytes left allow, up to 0.8 · `VALUE_MAX_BYTES`), then
   put its files together from the pieces, as many a run as `RUN_BYTES` and
   the R2 budget allow, without reading the rounds again. A run whose bytes
   went to step 2 before any file of the day was written marks the archive
   `starved`, and the next run takes step 4 **before** step 2, so a busy day's
   part, rendered every hour, never keeps the archive waiting for good. Once all its files are written the day
   is `archived_through`, goes into `state` `held` and its pieces are deleted.
   Nothing is deleted from `rounds` here.
   - 4b. **Drop** archived days from D1, oldest first, only while the held
     days and the open days' public rounds add up to more than `RETAIN_ROWS`
     (3,000,000), and the day's budget has room (each deleted round is a row
     written): `dropped_through`. A small deployment never pays for deletes.
5. **Compact**: the oldest calendar month whose days are all archived and
   still published one by one becomes one month part (§4.2) when its day
   parts' files add up to less than `VALUE_MAX_BYTES`; its day parts go to the
   trash. A bigger month, or one whose render fails, gets `state`
   `nocompact:<month>` and stays in day parts. One a run.
6. **Finish and the manifest** (§4.1): the run's state writes, then the
   manifest, when a part pointer changed, the counts of people may have moved
   (`recent` changed, an unlink finished, the first manifest of a UTC day, or
   a ban, merge or unlink dropped `state` `people`), the catalog changed, the
   manifest in R2 is older than `state` `parts_at` (its put failed), or it is
   missing. The manifest is put with `customMetadata` `at` = the run's time in
   ms. A trashed file is deleted only once the manifest in R2 was written
   after the file was thrown away, at least 15 minutes ago (past its max-age
   of 300 and a reload), and never while a pointer names it again. The run's
   rows read and written go into the day's budget, whatever happened.

The counts of people (`state` `people`) are made again only when they can
have moved: from `recent` (the newest day per contributor and Tsum), the
catalog's Tsums only, banned contributors left out at that time; and
`devices` seen in the last 30 days. The rounds per Tsum, per skill level,
per skill type and per value of each play setting (`state` `totals`) move with the changed pointers' old and new summaries, and
are made afresh with each day's first manifest.

`state` keys the job keeps (`job.ts` lists them too): `recompute` (claimed
days), `skip`, `render`, `part:<from>` (a part's pointer: `{from, to, rounds,
first, last, tsums: {tsum: rounds}, skills: {skill: rounds}, skillTypes:
{type: rounds}, scan, chain, bubble: {value: rounds}, bytes, files: [{file,
sha, rounds, bytes}]}`, each count leaving out what is not recorded; a
pointer from before 0003 has no `skillTypes` or play settings), `parts_at`,
`totals` (`{tsums, skills, skillTypes, scan, chain, bubble}`),
`people` (`{contributors, devices, tsums: {tsum: contributors}, catalog}`),
`trash` (`[[R2 key, ms]]`), `archived_through`, `dropped_through`, `held`
(`[[day, rounds]]`), `archive` (the day in progress), `restored` (`[[day,
rounds]]`), `restore:<day>`, `settings_archived`, `span:<id>`,
`unlink:<id>`, `merged:<id>`, `gone:<id>`, `nocompact:<month>`,
`contributor_seq`; and `resend`, written only by its admin route (§2.5).

### 3.3 R2 layout (bucket `tsum-global`)

| Key | Public | Holds |
|:--|:--|:--|
| `data/global/manifest.json` | yes | §4.1 |
| `data/global/day-YYYY-MM-DD.<sha8>.json` | yes | One day's part, or one file of it (§4.2) |
| `data/global/month-YYYY-MM.<sha8>.json` | yes | One compacted month's part |
| `archive/YYYY-MM/YYYY-MM-DD/c<id>.json` | no | One contributor's rounds for one day, and `c<id>.<k>.json` (k ≥ 1) when they are too big for one file |
| `archive/YYYY-MM/YYYY-MM-DD/u<hex>.json` | no | Unlinked rounds for one day, files sized by bytes |
| `archive/YYYY-MM/YYYY-MM-DD/b<hex>.json` | no | A banned contributor's files once it unlinked: kept for good, never restored |
| `archive/settings/<firstId>-<lastId>.json` | no | Settings rows, written once per new range, sized by bytes |

`<sha8>` is the first 8 hex digits of the file's SHA-256. Only
`data/global/*` is served; the Worker answers `/data/global/<name>` from
R2, parts with `Cache-Control: public, max-age=31536000, immutable`, the
manifest with `public, max-age=300`, both `application/json`.

### 3.4 Archive files

```json
{"kind": "tsum-global-archive", "format": 2, "day": "2026-08-20", "contributor": 17, "n": 2,
 "key": ["…32 hex…"], "playedAt": [1787250000], "build": [0], "tsum": ["beastda"], "skill": [5],
 "skillType": ["beastda"], "items": [7], "scan": [3], "chain": [-1], "bubble": ["all_mid_chain"],
 "version": ["3.0b4"], "settings": [12], "duration": [181.5],
 "score": [12345678], "base": [3000], "final": [4500], "medals": [null]}
```

Every field a round was stored with is in its file, so a restore loses
nothing. Format 1 (before `0003_skill_type.sql`) has no `skillType`,
`scan`, `chain` or `bubble`: a restore files its rounds with skill type `''`
and their play settings made from their settings (`records.ts: playSQL`).

`contributor` is null in a `u` or `b` file. `<hex>` is the first 16 hex digits
of an HMAC (`DEVICE_KEY`) of what the file holds, so it names no one and a
re-run writes the same file. Each file is at most 0.8 · `VALUE_MAX_BYTES`
(always at least one round). Whose a file is, when it is written: `c<id>`
for a contributor `active` or `banned`, or one merged into another; `b` for
one `unlinking-banned` or gone banned; `u` for contributor 0, or one being
unlinked or no longer there. Every settings id an archived round names is in
some `archive/settings/*.json`
(`{"kind": "tsum-global-settings", "format": 1, "settings": [{"id", "hash", "json"}]}`).

A day counts as archived (`archived_through`) once all its files are written,
from its staged pieces; its rows leave D1 later, if ever (§3.2, step 4b:
`dropped_through`). Every later change to an archived day (an unlink, a
merge) is carried to its files too.

A restore files each file's rounds under: `u` → 0; `b` → never;
`c<id>` → `id`, following `merged:*`; never for a gone-banned id or one merged
into it; 0 for a contributor being unlinked or no longer there; never for one
`unlinking-banned`. A round D1 already has is left alone.

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
  "skillTypes": [{"skillType": "burst", "rounds": 80000}, {"skillType": "beastda", "rounds": 5000}],
  "playSettings": {"scan": [{"value": "3", "rounds": 60000}], "chain": [{"value": "4", "rounds": 50000}],
                   "bubble": [{"value": "all_mid_chain", "rounds": 70000}]},
  "minContributors": 3
}
```

- `rounds`, `first`, `last` (sqlTime UTC): over the public cells, from the
  part pointers.
- `contributors`: distinct contributors (not 0, not banned) with rounds of the
  catalog's Tsums begun in the last 30 days (today and the 29 before), from
  `recent`; `devices`: distinct device hashes of `devices` rows seen (a round
  ended) in the last 30 days. Both exact as of their last refresh, which
  happens whenever they can move (§3.2, step 6).
- `parts`: `[from, to)` days, sorted by `from`. A part may list **several
  files for the same `[from, to)`** (§4.2), one entry each, in the part's
  order, each with its own `rounds` and `sha`; different ranges never overlap.
- `tsums`: every Tsum in the public cells, most rounds first; `contributors`
  as above but per Tsum.
- `medalTsums`: the catalog's `medal: true` ids. `skills`: the distinct
  skill levels (not -1) in the cells, ascending. `skillTypes`: every skill
  type (not `''`) in the cells, most rounds first; the rest of `rounds` have
  none. `playSettings`: per play setting (§1.2), every value recorded in
  the cells, as text, most rounds first; the rest of `rounds` have it not
  recorded. Only the parts published since `0003_skill_type.sql` count,
  until the day's first manifest makes the totals afresh.
- `minContributors`: below this the page flags a Tsum "few players".

### 4.2 Part files

One day (`day-…`) or one month (`month-…`), columnar like the snapshot's
month files. Format 5 (since `0004_jackpot.sql`) keys every cell and bins
row by `jackpot` too; format 4 (since `0003_skill_type.sql`) by skill type
(`skillType`) and the play settings (`scan`, `chain`, `bubble`); format 3 had
the skill type only, and format 2 (since `0002_cell_bins.sql`) neither: the
page reads what a part lacks as not recorded (`''`, -1) and no jackpot (0). Each has bins per cell, each with its figures; format 1 had bins per
day × build × Tsum × skill, counts only, and the page reads a format 1 part's
cells but none of its bins:

```json
{
  "kind": "tsum-global-part", "format": 5, "from": "2026-10-14", "to": "2026-10-15",
  "cells": {"n": 2, "day": ["2026-10-14", "…"], "build": [0, 1], "tsum": ["beastda", "…"], "skill": [5, -1],
            "skillType": ["beastda", ""], "items": [7, -1], "scan": [3, -1], "chain": [4, -1], "bubble": ["all_mid_chain", ""], "medal": [0, 1], "jackpot": [0, 0], "rounds": [], "secs": [], "scoreSum": [], "scoreMin": [], "scoreMax": [],
            "first": [], "last": [], "baseSum": [], "baseSq": [], "baseMin": [], "baseMax": [],
            "finalSum": [], "finalSq": [], "finalMin": [], "finalMax": [],
            "medalsN": [], "medalsSum": [], "medalsSq": [], "medalsMin": [], "medalsMax": [], "medalsSecs": []},
  "bins": {"n": 1, "day": ["2026-10-14"], "build": [0], "tsum": ["beastda"], "skill": [5], "skillType": ["beastda"], "items": [7],
           "scan": [3], "chain": [4], "bubble": ["all_mid_chain"], "medal": [0], "jackpot": [0], "base": [{"231": [4, 726.5, 48020000, 3801, 5702, 0]}], "final": [{"…": […]}], "medals": [{}]}
}
```

Each array holds one value per row (`n` rows), in the `cells3` and `cell_bins3`
tables' column meanings (§3.1). A bins row has the key of one cells row,
which may be in another file of the same part. Rows are in no particular
order, and a bins object may list its bins in any order. A file is built in one SQL statement (`json_object`
over `json_group_array` of one ordered subquery), so its arrays line up.

**A part too long for one value.** D1 first adds up how long the part's file
would be. A part over `VALUE_MAX_BYTES` (1,500,000) is published as several
files for the same `[from, to)`, each holding a share of the part's `cells3`
rows and, apart from those, a share of its `cell_bins3` rows, about half the limit
each. The files together hold the part's rows, each row once, and the page
adds up every file the manifest lists (§6). Their `rounds` add up to the
part's.

## 5. Bins

For integer `v ≥ 0`:

```
bin(v) = v < 100 ? v : 100 + floor(ln(v / 100) / ln(1.02))
low(b) = b < 100 ? b : 100 · 1.02^(b − 100)      // the bin's lowest value
mid(b) = b < 100 ? b : round(100 · 1.02^(b − 99.5))
```

Values under 100 are exact; above, a bin is 2 % wide. The Worker computes
bins at ingest (JavaScript `Math.log`; a restore the same in SQL), so the page
only ever uses `low`/`mid`.

**A bin's figures**, in a `cell_bins3` object: `[rounds, secs, score, base,
final, medals]`, the count of the cell's rounds in the bin and the sums of
their durations, scores, base coins, final coins and medals (null as 0).
`secs` is a REAL; an upload's sums may write a whole one as an integer, which
a recompute compares as a REAL. The bin's own value (`base` for base bins,
and so on) over `rounds` is its **average**, which the page uses in place of
`mid(b)`: exact for a bin of one round, and within the bin always.

## 6. The page in global mode

Built with `vite build --mode global` into `global/site/`; `index.html`
carries `<meta name="tsum-global" content="1">`. `api()` then sends every
route to `ui/src/lib/global/engine.js` in a Web Worker, reading
`data/global/` relative to the page. The engine reads files through a
loader, `json(name, {fresh}) → Promise`: `fresh` asks past any cache (for the
manifest's reload), and a missing file rejects with an error whose `status`
is 404. For a filter it reads every file the manifest lists for the days it
can touch, several for one part included, and adds them up.

### 6.1 Routes

| Route | Answer |
|:--|:--|
| `summary` | The server's `Summary` shape (`summary.go`), from the cells, see §6.2 |
| `tsums` | `manifest.tsums` (`{tsum, rounds, contributors}`) |
| `skill-types` | `manifest.skillTypes`, and `{skillType: "", rounds}` for the rest of `manifest.rounds`; most rounds first (`queries.go: PlayedSkillTypes`) |
| `play-settings` | Per play setting, `manifest.playSettings`'s values, and `{value: "", rounds}` for the rest of `manifest.rounds`; most rounds first (`queries.go: PlayedPlaySettings`) |
| `status` | `{global: true, rounds, contributors, devices, generatedAt, first, last, minContributors, skills}` |
| `themes` | The built-in themes in `site.go: themeOrder` order, `[{file, name}]` |
| `devices`, `round-devices`, `owned-sources` | `[]` |
| `owned` | `{list: null}` |
| `tsum` | The server's `TsumDetail` shape (`tsum.go`) as the cells can answer it, see §6.3 |
| `rounds`, anything else | throws "not available on the global site" |

### 6.2 Filters and figures

Parameters as `queries.go: ParseFilter`, plus two:

- Kept: `tsum` (comma list), `skillType` (comma list; `-` = none), `scan`,
  `chain` and `bubble` (comma lists of the play settings' values as text;
  `-` = not recorded; a cell matches by its value, -1 and `''` as `-`), `build`,
  `from`, `to`, `coins` (`final` / `medals`), `net=1`, and the coin and medal
  outlier ranges (`minCoins`, `maxCoins`, `minMedals`, `maxMedals`), one at a
  time (below).
- New: `skill` (comma list of integers; `-1` = unknown) and `items` (comma
  list of item masks; `-1` = unknown).
- Ignored: `device`, the score range (there are no score bins),
  `incomplete`, `tz` (days are UTC).
- **Days**: a cell's day is the UTC day its rounds **started** (§1.1). A cell
  counts when its day's 00:00 UTC is ≥ `from` (rounded down to a UTC day) and
  < `to`.

The figures follow `summary.go` and the snapshot engine exactly, from the
cells' sums (per-cell `n` = `rounds` for base and final; net coins are base or
final less `cost(items)` per round, so a cell's net sum = sum − rounds·cost,
min/max = min/max − cost, sq = sq − 2·cost·sum + rounds·cost², and a cell with
`items = -1` has no net coins; medals use the `medals*` columns with the rate
over `medalsSecs`). Medals mode (`coins=medals`) and the `medals` set use the
manifest's `medalTsums`' cells with `medalsN > 0`, `medal = 0` ones included
(`summary.go: medalRoundsSQL`): a round that earned none counts as 0. Such a
cell has no medal bins (§5), but every round in it is a 0, so the page stands
them all in bin 0 with the cell's own sums. `earnedRounds` is the `medal = 1`
cells' rounds.

- **Exact**: every count, sum, average, min, max, `coinsPerSec`,
  `stdCoins` (population variance from `Σsq/n − (Σ/n)²`), `first`, `last`,
  `daily`, `dailyTsums`, `mix`, `chains` (from the cells' `scan` and `chain`),
  and the `medals` set's totals and Tsums.
- **Approximate**: `q1Coins`, `medianCoins`, `q3Coins`, `p90Coins` from the
  bins of the group's cells. A bin's rounds of one item cost (net coins; 0
  otherwise) across the group stand at their average less that cost; in that
  order, the nearest rank `1 + ⌊(n − 1)·k⌋` falls in one, and its value,
  clamped to the group's min and max, is the answer. That is within 2 % of
  the exact value, exact under 100; for net coins, whose bins of different
  costs overlap, within about two bins of the coins before the cost.
- **Histogram**: `histBounds` from the min/max and the approximate q1/q3,
  each bin's rounds put in the bucket holding its value, clamped to its
  Tsum's min and max.

**Outlier ranges.** The coin range applies to the primary coin stat as
`queries.go` has it (base or final, net under `net=1`, base coins in medals
mode); the medal range to the catalog's `medal: true` Tsums only. With both
set, the coin range is applied and the medal range is ignored. A range cuts
each cell by its bins of the range's figure: a bin is kept when its average
(less the cell's items' cost, for net coins) is within the range, and a cell
whose items are unknown has no net coins, so is left out by a net range. A
medal range keeps a medal Tsum's `medal = 0` cell whole when 0 is within it,
else leaves it out. A cell whose bins are all kept stays as it is. A cut cell
becomes the sums of its kept bins:

- **Exact** (given the range snapped to whole bins): its rounds, `secs`,
  score, base, final and medals sums, so every count, sum, average and
  `coinsPerSec`, `daily`, `dailyTsums`, `mix` and `chains`.
- **Approximate**: the range's own figure's min and max (the cell's own where
  its lowest or highest bin is kept, else that bin's average) and its sum of
  squares (from the bins' averages), so its `stdCoins`.
- **The cell's**: the other figures' min and max, the score's, `first` and
  `last`; these may be a left-out round's.
- **Unknown**: the other figures' sums of squares, so their `stdCoins` is null.
- **Spreads** only for the range's own figure: the primary stat's when the
  range is of it (a coin range out of medals mode, a medal range in it), the
  `medals` set's under a medal range. The others are null, and the histogram
  empty, since one figure's bins cannot be cut by another's range.

An extra top-level `global: {approx: true, spreads, range, ignored}`:
`spreads` whether the primary stat's spreads were computed (false too when a
part of format 1 has no bins for a cell), `range` the range applied
(`'base'`, `'final'`, `'medals'` or null), `ignored` the ranges left out
(`['medals']` or `[]`).

A part that 404s (replaced since the manifest was read) makes the engine
reload the manifest once and retry.

### 6.3 The Tsum page (`tsum`)

`id` is the Tsum; the other parameters as §6.2, `target` a number. The
answer has `tsum.go: TsumDetail`'s fields, plus `global: {approx: true}`:

- **Jackpots.** With final coins the primary stat (`coins=final`, net or
  not), every figure leaves out the `jackpot = 1` cells, `field`'s other
  Tsums' too, except: `summary.totals.maxCoins` (and its Tsum row's) and
  `summary.mix` are over every cell, and `earn` is as below. `jackpots` is
  `{rounds, coins}` of the cells left out (`coins` the primary stat's sum,
  null when none has it); null in base coins and medals, which a jackpot
  does not touch.
- `summary`: `summary` with `tsum = id`.
- `chains`: by chains per scan and max chain length together (the cells'
  `scan` and `chain` as text, `''` not recorded, kept), as `{scan, chain,
  key: "scan,chain", rounds, …}` like `settings`' rows, most rounds first,
  then by scan and chain as text.
- `settings`: the skill level (the cells' `skill`, `-1` left out) and the
  play settings (`maxChainsPerScan`, `maxChain`, `bubbleStrategy`, their
  values as text, not recorded left out), as `{setting, key, rounds,
  avgCoins, maxCoins, coinsPerSec, avgScore, first, last}`, by setting and
  then key, as text. `versions`, `devices` and `form` are `[]`: the
  cells keep no versions, devices or rounds.
- `skillTypes`: by the cells' `skillType` (`''` included), as `tsum.go`'s,
  most rounds first.
- `field`: every Tsum in the same filter less `tsum`, as `tsum.go`.
- `earn`: final coins (net under `net=1`) per second, and medals per second
  over every round's seconds, of every Tsum in the filter.
- `skillBins` and `target` (`{target, rounds, under, approx: true}`) from the
  bins: each bin's rounds at its value as §6.2, clamped to the Tsum's min and
  max; null and `[]` when the summary has no spreads.

## 7. The local side

### 7.1 Settings (`<data dir>/global.json`, mode 0600)

`{"url": "https://tsum-stats.gapscripts.app", "id": 17, "key": "…", "enabled": true, "joinedAt": "…", "sent": 12345, "lastUpload": "…", "lastCheck": "…", "lastError": "", "retryAt": "", "keeps": 2, "resend": 1}`

`keeps` is the highest `keeps` an upload's reply named (§2.2), and
`resend` the highest `resend` an upload's or `/me`'s reply named; each is
left out while it is 0. They stay through a refused key and a new join of the
same site, and go back to 0 with a join of another.

`url` is the site the key came from: a key is used only while `--global-url`
names that site, and is never sent anywhere else. It is also the site
`ts_global_sent` records uploads to, so it **stays after an unlink or a
refused key** (`{"url": "…"}`, or `{"url": "…", "lastError": "…"}`).

**A data folder contributes to one site.** A join while a key for another
site is saved is refused, with an error naming that site and suggesting
`--global-url <it>`, or another `--dir` for a test site: that key is the only
way to unlink the rounds sent there, so it is never replaced. Joining a
different site with no key saved first empties `ts_global_sent` (its rounds
were sent to the other site). Leave for a site that has no key here changes
nothing. `lastError` is shown only for its own site (or when `url` is `""`).

### 7.2 The forwarder

- It runs while `enabled`: first 2 minutes after start or a join, then every
  hour plus 0–10 minutes of jitter, and on **Upload now**.
- **Rounds it picks.** From `ts_rounds`: complete rounds (`completeSQL`); for
  a catalog `medal: true` Tsum, also a medals figure (the flags come from the
  catalog built into the binary, `data/catalog.json`: §1.2's `incomplete`
  rule); with `build` `global`/`jp` or a `jpVersion` setting; `played_at`
  within the last 60 days and at least 20 minutes ago. A Tsum the catalog
  lacks is sent like any other (§1.2). The fingerprint is the record's
  FNV-1a 64 over its canonical JSON, with `keeps <n>\n` hashed first once
  `keeps` is 2 or more, then `resend <n>\n` once `resend` is 1 or more. It sends rows with no `ts_global_sent`
  row or a different fingerprint, oldest first, **at most 100 a request**
  (`GlobalBatchRows`; fewer when their JSON passes 768 KiB, to stay under
  the 1 MiB body limit), and stops at the first refusal.
- **Never sent**: `device`, `source`, the Tsum lists, paths.
- **After `ok: true`**: every row in the batch **except those the reply names
  in `retry`** goes into
  `ts_global_sent(round_id TEXT PRIMARY KEY, hash INTEGER NOT NULL, sent_at TEXT NOT NULL)`
  (other rejected rows included, which a change of figures sends again);
  `sent` and `pending` count only those. The cursor still moves past the
  `retry` rows, so each is offered once a pass until the site takes it. A
  reply with no `retry` (an older Worker) records every row.
- **When the site keeps more.** A reply whose `keeps` is above the saved one
  saves it, and the fingerprints follow: every round in the window then
  differs from what `ts_global_sent` holds and is sent **once** more, the
  batch that learned it included. So the Worker that keeps a new field is
  deployed first; an older one never names a higher `keeps`, and nothing is
  sent again for it.
- **When the site calls for a re-upload.** A reply whose `resend` is above
  the saved one saves it, and the fingerprints follow, as for `keeps`: every
  round in the window is sent once more. From an upload's reply, the pass
  starts again from the oldest round at once; from `/me`'s (fetched at the
  end of every pass), the pass sends them then. So the next pass after a call
  re-sends everything, whether or not it had anything new.
- **On refusals.** Only the Worker's own daily limits, read from the JSON
  `error`: **429 `quota` or `join-limit`, and 503 `budget`**. Then `retryAt`
  = now + `Retry-After` (an hour when it has none), and the pass stops; until
  then a pass only fetches `/api/v1/me`, and Upload now is refused. **401
  with the Worker's body** (`{"ok": false, "error": "unauthorized"}`, from
  any route but unlink): the key is forgotten, `enabled` is off and
  `lastError` says to join again. **Anything else** (another 4xx or 5xx, a
  429 or 503 that is not one of those codes, a 401 page that is not the
  Worker's, an unreadable reply, or a 2xx without `ok: true`): `lastError`,
  the key is kept, and the next hourly pass tries again.
- A new join of the **same site** starts `sent` at 0 but keeps
  `ts_global_sent`: rounds sent under an earlier id are in the global figures
  already. A join of another site empties it (§7.1).

### 7.3 Local routes (`server.go`)

`POST` routes are guarded by `sameOrigin`.

- `GET /api/stats/global`:
  `{enabled, joined, url, id, sent, pending, lastUpload, lastCheck, nextUpload, lastError, retryAt, me, running}`.
  `pending` counts rows waiting; `me` is the last `/api/v1/me` answer or null;
  `running` is true while a pass uploads.
- `POST /api/stats/global/join`: joins (or re-enables a saved key) and fetches
  `me`; the first pass follows 2 minutes later (§7.2), so a player can still
  back out before anything is sent. Refused while a key for another site is
  saved (§7.1).
- `POST /api/stats/global/run`: a pass now.
- `POST /api/stats/global/leave` `{unlink: bool}`: stops, keeping the key so a
  join resumes the same id. With `unlink`: uploads stop at once; it waits for
  the batch in flight to be answered (up to 90 s, longer than the HTTP
  client's 60 s timeout; past that it errors and keeps the key), and no pass
  and no join start meanwhile, and a stopped pass skips its `/me` fetch. Then
  it calls `/api/v1/me/unlink` and forgets the key (the Worker's 401 there
  counts as unlinked already; an unreachable site, or any other refusal,
  keeps the key, so unlinking can be tried again).
- Realtime topic `ts/global`: the `GET` state after every change.
- Flag `--global-url` (default `https://tsum-stats.gapscripts.app`): `https`,
  or `http` to this computer (a local `wrangler dev`); empty turns contributing
  off. A data folder contributes to one site, so a test site takes another
  `--dir`.
