# The global stats Worker

`global/` is the cloud side of the global Tsum Tsum Stats site,
<https://tsum-stats.gapscripts.app>. It is one Cloudflare Worker,
`tsum-global`, with a D1 database and an R2 bucket of the same name. It takes
rounds from the tsum-stats installs whose players joined, rolls them up every
hour into community figures, and serves those figures and the page that reads
them.

The site has three parts, and this folder is one:

| Part | Where | Does |
|:--|:--|:--|
| The Worker | `global/` | The upload API, the hourly rollup, the published files, the page's static files |
| The page in global mode | `ui/src/lib/global/` | The Stats page and Catalog, answered in the browser from the published files |
| The forwarder | `internal/stats/global.go` | Sends a contributing player's rounds, hourly |

**[CONTRACT.md](CONTRACT.md) is the one description all three are built
against**: the upload format and its checks, the API, the write budget, the
D1 schema, the hourly job, the R2 layout, the published files, the bins and
the page's routes. Change a shape there first, then every side. Code comments
cite it by section (`CONTRACT §3.2`).

- [CLOUDFLARE-SETUP.md](CLOUDFLARE-SETUP.md): the one-time setup on the
  personal account, the deploy, the checks and the free-tier limits.
- [WEBSITE-LINKS.md](WEBSITE-LINKS.md): the website's edits once the page is
  live.
- `../docs/INTERNALS.md`, *The global site*: where this fits in the program,
  and how to change a query on every side.
- `../docs/USING.md`, *Contributing to the global stats*: what a player sees.

## Layout

| File | Owns |
|:--|:--|
| `src/index.ts` | Routing (`/api/v1/*`, `/data/global/*`, the page's files), the JSON-only `POST` rule, and the cron entry |
| `src/env.ts` | The bindings, and the `vars` as numbers (`limits`) |
| `src/http.ts` | JSON replies and errors, gzipped bodies and the 1 MiB limit, Bearer keys, `Retry-After` |
| `src/crypto.ts` | SHA-256, the HMAC under `DEVICE_KEY`, new contributor keys, the constant-time compare |
| `src/budget.ts` | The day's write budget (§2.6): the refusals and the count, inside the batch they guard |
| `src/days.ts` | UTC days, a day's key range, `keyDay`, `bin` |
| `src/catalog.ts` | The Tsum ids and medal Tsums, from `ui/public/data/catalog.json` |
| `src/records.ts` | A batch's records → rounds: read as `csv.go` reads them, checked in §1.2's order, re-keyed; the `retry` list |
| `src/ingest.ts` | `POST /api/v1/rounds`: the one D1 batch with its checks, and the new rounds' sums for `pending` |
| `src/contributors.ts` | Join (and its per-address limit), the Bearer check, `/me`, `/me/unlink` |
| `src/admin.ts` | The admin routes |
| `src/run.ts` | `Run`: one invocation's D1 queries, R2 operations, bytes, and rows read and written |
| `src/job.ts` | The hourly job: claims dirty days, runs each step on its own, and lists the `state` keys it keeps |
| `src/rollup.ts` | Step 1: the `pending` sums folded into `cells`, `bins` and `contrib_cells`, and full recomputes |
| `src/parts.ts` | Part files (split when too long), month compaction, the trash, the manifest and its running totals |
| `src/unlink.ts` | Step 3: finishing an unlink, day by day |
| `src/archive.ts` | Steps 4 and 4b and restore: final days staged and written to `archive/`, dropped from D1 lazily, and back |
| `src/data.ts` | `GET /data/global/*` from R2, through the edge cache |
| `migrations/0001_init.sql` | The D1 schema (§3.1) |
| `wrangler.jsonc` | Bindings, the route, the cron, the local dev address, the tunables |
| `deploy.sh` | The deploy from a terminal, with its account checks, for when the GAP Devkit (its Tsum Tsum global stats card is the deploy) is not available |
| `test/` | vitest in workerd (below) |

The Worker shares code with the page rather than copying it: `parseTime` and
`sqlTime` from `ui/src/lib/snapshot/engine.js`, and the Tsum list from
`ui/public/data/catalog.json`. What it mirrors from Go is commented with the
Go name (`csv.go: settingValue`, `summary.go: itemBits`).

**A round's day is the UTC day it started**, read from its key (`keyDay`).
Rounds of some Tsums last hours, so a round may end on a later day, and
nothing is rejected for its length: only a `duration_seconds` of 0 or less is.
The local site files a round under the day it ended, so the two sites' per-day
figures differ where rounds cross midnight.

**A Tsum newer than the deploy** (its id well-formed but not in the bundled
catalog) is stored, archived and counted as its contributor's, but stays out
of every public figure. After a deploy whose catalog has it, `POST
/api/v1/admin/rebuild` brings in its days still in D1. So update
`ui/public/data/catalog.json`, push it and deploy (the Devkit card,
[CLOUDFLARE-SETUP.md](CLOUDFLARE-SETUP.md#5-deploy)) when the script learns a
new Tsum; no round of it is lost meanwhile.

## Tests

```sh
npm ci
npm test            # vitest inside workerd (Miniflare): a fresh local D1 and R2 per file
npm run typecheck   # tsc --noEmit
```

`test/setup.ts` migrates each file's D1. `test/helpers.ts` calls the Worker
with a chosen clock (`handle(req, env, ctx, nowMs)`) and makes rounds as the
Tsum script does; `test/reference.ts` works the rollup out again in plain JS
to compare against, and wraps D1 to count its queries, rows read and written
and to refuse values over a size, as production D1 does.
`test/volume.test.ts` runs a day of 80,000 rounds from 70 players, uploaded
as the forwarder does, with the hourly job after each hour, and checks what
D1 reads and that every row written is in the budget.

**The parity test** runs from Go and covers all three parts:

```sh
cd .. && go test ./internal/stats -run TestGlobalParity -count=1 -v
```

`TestGlobalParity` makes about 3,000 rounds from three players, some hours
long, some across midnight, and some the Worker must turn away. It puts them
through the forwarder's own passes (100-record batches, against a fake
Worker), and writes `test/.parity/fixture.json` with what `Summarize` answers
for the same rounds, dated by the day each began. Then it runs
`test/parity.test.ts`: the uploads go through the Worker, `POST
/api/v1/admin/rollup` publishes the parts, and the page's engine answers from
`/data/global/`. Every exact figure must match, and the quartiles and P90
must be the right bin's middle. On the way, a few rounds of a Tsum the catalog
lacks must be stored as the player's and stay out of every figure, and the
third player's first pass reaches a site whose clock is behind: its newest
rounds come back in `retry` and go with the next pass. It runs again with
every day part split into several files, and once more after the days are
archived and compacted into month parts. It skips without Node or without
`global/node_modules`, and `npm test` alone skips `parity.test.ts`.

The page's engine has its own test: `cd ../ui && npm run test:global`.

## Running it locally

All local: no account, no token.

1. **Build the page** in global mode, into `global/site/`:

   ```sh
   cd ui && npm ci && npm run build:global
   ```

2. **Run the Worker**, in `global/`:

   ```sh
   npm ci
   npm run dev
   ```

   `predev` copies `.dev.vars.example` to `.dev.vars` (throwaway `DEVICE_KEY`
   and `ADMIN_KEY`) and migrates a local D1 under `.wrangler/`. It listens on
   this computer only, at <http://127.0.0.1:8788/> (`dev` in
   `wrangler.jsonc`), with its inspector on 9230: gap-companion's local
   server has :8787 and the default inspector port. `curl
   http://127.0.0.1:8788/__scheduled` runs the hourly job.

3. **Run tsum-stats against it**, from the repo root, with some rounds to send:

   ```sh
   go run . serve --dir /tmp/tsum-global-dev --global-url http://127.0.0.1:8788 --import-dir ~/some/tsum_record
   ```

   `--global-url` takes plain `http` only to this computer. A data folder
   contributes to one site, so a test site gets its own `--dir`. On the local
   page, <http://127.0.0.1:8090>, press **Contribute**, tick the box,
   **Join**, then **Upload now**. Only rounds that ended in the last 60 days,
   and at least 20 minutes ago, are sent.

4. **Roll up and look**:

   ```sh
   curl -s -X POST -H 'Authorization: Bearer local-admin-key-not-a-secret' -H 'Content-Type: application/json' \
     -d '{}' http://127.0.0.1:8788/api/v1/admin/rollup
   ```

   then reload <http://127.0.0.1:8788/>.

For hot reload, `cd ui && npm run dev -- --mode global` serves the page on
:5173 and sends `/data/global` to the Worker on 127.0.0.1:8788.

The local D1 and R2 are under `.wrangler/state/`. Delete that folder to start
over; `predev` migrates a new one.

## Admin routes

Each takes `Authorization: Bearer <ADMIN_KEY>`, and each `POST` a JSON body
sent as `Content-Type: application/json` (anything else gets `415
content-type`). Locally the key is `local-admin-key-not-a-secret`; in
production it is in `~/.config/tsum-global/secrets.env`.

```sh
H=https://tsum-stats.gapscripts.app        # or http://127.0.0.1:8788
ADMIN_KEY=$(sed -n 's/^ADMIN_KEY=//p' ~/.config/tsum-global/secrets.env)
J='Content-Type: application/json'

curl -s -H "Authorization: Bearer $ADMIN_KEY" $H/api/v1/admin/contributors
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -H "$J" -d '{"id":17}' $H/api/v1/admin/ban
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -H "$J" -d '{"id":17}' $H/api/v1/admin/unban
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -H "$J" -d '{"from":18,"into":17}' $H/api/v1/admin/merge
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -H "$J" -d '{"from":"2026-09-01","to":"2026-09-30"}' $H/api/v1/admin/rebuild
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -H "$J" -d '{"day":"2026-08-01"}' $H/api/v1/admin/restore
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -H "$J" -d '{}' $H/api/v1/admin/rollup
```

| Route | Does | Reply |
|:--|:--|:--|
| `GET contributors` | Every contributor | `contributors: [{id, status, createdAt, lastSeen, client, rounds, duplicates, devices}]` |
| `POST ban`, `unban` | Leaves the contributor's rounds out of the public figures, or puts them back. Its days in D1 are recomputed by the next runs. A banned contributor gets the same answers as before and is not told | `{id, status, days}` |
| `POST merge` | One player under two ids (a reinstall, a second PC): moves `from`'s rounds, devices and totals to `into`, and deletes `from`. Refused (`503 budget`) on a day whose write budget it would pass | `{from, into}` |
| `POST rebuild` | Marks days dirty for the next runs, at most 400: `{from, to}`, or `{}` for every day with rounds in D1. Also how a Tsum the catalog learned comes into the figures | `{from, to, days}` |
| `POST restore` | Brings an archived day back to recompute it: marked dirty at once if its rounds are still in D1, else read back from its files. A big day takes several calls: repeat until `done` | `{day, done, files, left, rounds}` |
| `POST rollup` | Runs the hourly job now | The run's report |

Ban, unban and merge refuse id 0 and a contributor being unlinked (400), and
an unknown id (404); merge also refuses `from` = `into`.

To remove a contributor's rounds from everything, ban it, then have it unlink
(`POST /api/v1/me/unlink` with its own key): a banned contributor's rounds in
D1 are deleted instead of re-filed, and its archive files become `b` files,
which are kept but never restored. An active contributor that unlinks keeps
its rounds in the figures, under contributor 0.

The report is `{folded, recomputed, rendered, unlinked, archived, dropped,
compacted, manifest, more, queries, r2, read, written, bytes, errors}`.
`more: true` means work is left for the next run; call rollup again to go on
at once. `errors` lists the steps that failed (`"<step>: <message>"`); the
other steps ran regardless, and the next run tries again. Avoid calling it
around 5 past the hour, when the cron runs: both would take the same days.
The result is the same, but the budget is spent twice.

## Designed for Workers Free

The Worker runs on Workers Free, with Workers Paid as a plan change, not a
rewrite. These rules are why some code looks the way it does:

- **Every row written is counted.** D1 Free writes 100,000 rows a day and
  then refuses every query until 00:00 UTC. `budget` counts every row D1
  writes or deletes, as D1 reports it, for uploads, joins, unlinks, the admin
  routes and the job alike (CONTRACT §2.6). Uploads and joins stop at
  `BUDGET_ROWS_PER_DAY` − `JOB_RESERVE_ROWS` (65,000) for the day; the job
  spends the rest, and puts off what can wait. The checks are statements of
  the batch they guard, so uploads at once cannot both pass one.
- **Rounds are written once, and summed once.** `rounds` is `WITHOUT ROWID`
  and its key is its only index, so a new round is one row written and an
  unchanged re-send none. Its key starts with the round's start time, so a
  day is a key range (`days.ts: dayRange`) and needs no index. An upload adds
  up its own new rounds, as the day tables keep them, into one `pending` row;
  the hourly job folds those in a few rows at a time and never reads a day's
  rounds again for them. A day is recomputed from its rounds only when
  something other than new rounds changed it.
- **D1 builds the JSON**, and never one over `VALUE_MAX_BYTES`. Free allows
  10 ms of CPU per request and per cron run. Each part file, archive file and
  the manifest is one SQL statement (`json_object` over `json_group_array`),
  and the Worker hands the string to R2 without parsing it. D1 refuses a
  value over 2,000,000 bytes, so a part is sized first and split into several
  files when it is too long, and an archive day is staged into
  `archive_parts` a share at a time. Rows go in as one JSON array bound once
  (`json_each(?1)`), which also gets past D1's limit on bound parameters. The
  manifest is made from the part pointers and running totals in `state`,
  never from the cells.
- **Per-run budgets.** Free allows 50 D1 queries per invocation (each
  statement of a batch counts) and 50 subrequests. `Run` counts both and
  refuses work past `RUN_QUERY_BUDGET` (45) and `RUN_R2_BUDGET` (40), and
  about `RUN_BYTES` carried to R2; `job.ts` holds back what `finish()` needs
  for the manifest. Each step records its progress in D1 (`pending`,
  `dirty_days`, `state`), and each runs on its own: one that fails is
  reported, and the rest still run. A run that stops early, or is cut off,
  loses nothing, and the next run carries on.
- **Reads are bounded too.** Free reads 5 million rows a day; a day at 80,000
  rounds reads about 850,000 (`test/volume.test.ts`). `READ_BUDGET_PER_DAY`
  makes the job put off full recomputes, unlinks and the archive past 4
  million.
- **Deletes are put off.** A delete is a row written, so archived days stay in
  D1 until it holds more than `RETAIN_ROWS` rounds, and only then are the
  oldest dropped, when the day's budget has room. A month whose days are all
  final becomes one part file, if its days' files add up to under
  `VALUE_MAX_BYTES`. The day tables stay in D1 for good.
- **What Free carries** is in [CLOUDFLARE-SETUP.md](CLOUDFLARE-SETUP.md#7-watch-the-free-tier-limits):
  about a row written per round at upload, about 25 more per player-hour
  for the batches and the job, and one more per round once D1 holds
  `RETAIN_ROWS`.
- **Not enforced by Miniflare**: D1's 2 MB limit on one value and the 10 ms
  CPU limit. The tests wrap D1 to refuse big values, and uploads are kept to
  100 records; watch the logs after a deploy.
- **D1's own rules**, found on the way: temporary tables are refused; a
  compound SELECT allows only 5 terms, so restore joins on array position
  instead of a UNION; a JS number binds as REAL, so SQL that turns one into
  text casts it first (`CAST(?1 AS INTEGER)`, see `run.ts`).

## Tunables

The `vars` in `wrangler.jsonc`, read by `env.ts: limits`:

| Var | Default | |
|:--|:--|:--|
| `QUOTA_PER_CONTRIBUTOR` | 5000 | Accepted rounds per contributor per UTC day |
| `BUDGET_ROWS_PER_DAY` | 90000 | Rows D1 may write (insert, change or delete) per UTC day, for everything (Free writes 100,000) |
| `JOB_RESERVE_ROWS` | 25000 | Of those, what uploads and joins never take: the hourly job's. Its other work keeps a fifth of it as a margin |
| `READ_BUDGET_PER_DAY` | 4000000 | Rows read per UTC day before the job puts off the work that can wait (Free reads 5 million) |
| `RETAIN_ROWS` | 3000000 | Archived days stay in D1 until it holds more rounds than this (about 290 MB of rounds) |
| `ACCEPT_DAYS` | 60 | How long ago a round may have started. Older days are final and archived |
| `ROLLUP_DAYS_PER_RUN` | 8 | Dirty days one run recomputes in full at most |
| `UNLINK_CHUNK` | 5000 | About how many rounds one run re-files (or deletes) per unlinking contributor, a whole day at a time |
| `RUN_QUERY_BUDGET`, `RUN_R2_BUDGET` | 45, 40 | Where a run stops starting work |
| `RUN_BYTES` | 2000000 | Bytes of parts and archive files one run carries from D1 to R2 |
| `VALUE_MAX_BYTES` | 1500000 | The largest value the Worker has D1 build; longer files are split |
| `MIN_CONTRIBUTORS` | 3 | Below this many contributors the page flags a Tsum "few players" |

Change one in `wrangler.jsonc` and deploy. The forwarder sends 60 days of
rounds (`globalWindow` in `internal/stats/global.go`), so change that with
`ACCEPT_DAYS`.

The secrets `DEVICE_KEY` and `ADMIN_KEY` are never in `wrangler.jsonc`:
locally they come from `.dev.vars`, in the tests from `vitest.config.ts`.
While `DEVICE_KEY` is unset, every `/api/*` request answers 500 and the cron
throws, so no key or device hash is ever made without it.
