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
against**: the upload format and its checks, the API, the D1 schema, the
hourly job, the R2 layout, the published files, the bins and the page's routes.
Change a shape there first, then every side. Code comments cite it by section
(`CONTRACT §3.2`).

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
| `src/index.ts` | Routing (`/api/v1/*`, `/data/global/*`, the page's files) and the cron entry |
| `src/env.ts` | The bindings, and the `vars` as numbers (`limits`) |
| `src/http.ts` | JSON replies and errors, gzipped bodies and the 1 MiB limit, Bearer keys, `Retry-After` |
| `src/crypto.ts` | SHA-256, the HMAC under `DEVICE_KEY`, new contributor keys, the constant-time compare |
| `src/days.ts` | UTC days, a day's key range, `keyDay` (in JS and in SQL), `bin` |
| `src/catalog.ts` | The Tsum ids and medal Tsums, from `ui/public/data/catalog.json` |
| `src/records.ts` | A batch's records → rounds: read as `csv.go` reads them, checked in §1.2's order, re-keyed |
| `src/ingest.ts` | `POST /api/v1/rounds`: the quota, the budget, the one D1 batch |
| `src/contributors.ts` | Join, the Bearer check, `/me`, `/me/unlink` |
| `src/admin.ts` | The admin routes |
| `src/run.ts` | `Run`: one invocation's count of D1 queries and R2 operations |
| `src/job.ts` | The hourly job: claims dirty days, runs the steps, and lists the `state` keys it keeps |
| `src/rollup.ts` | Steps 1 and 2: a day's `cells`, `bins` and `contrib_cells` from one aggregate |
| `src/parts.ts` | Part files, month compaction, the trash, the manifest |
| `src/unlink.ts` | Step 3: re-filing an unlinked contributor's rounds |
| `src/archive.ts` | Step 4 and restore: final days to `archive/`, and back |
| `src/data.ts` | `GET /data/global/*` from R2, through the edge cache |
| `migrations/0001_init.sql` | The D1 schema (§3.1) |
| `wrangler.jsonc` | Bindings, the route, the cron, the tunables |
| `deploy.sh` | The deploy, with its account checks |
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

## Tests

```sh
npm ci
npm test            # vitest inside workerd (Miniflare): a fresh local D1 and R2 per file
npm run typecheck   # tsc --noEmit
```

`test/setup.ts` migrates each file's D1. `test/helpers.ts` calls the Worker
with a chosen clock (`handle(req, env, ctx, nowMs)`) and makes rounds as the
Tsum script does; `test/reference.ts` works the rollup out again in plain JS
to compare against.

**The parity test** runs from Go and covers all three parts:

```sh
cd .. && go test ./internal/stats -run TestGlobalParity -count=1 -v
```

`TestGlobalParity` makes about 3,000 rounds from three players, some hours
long, some across midnight, and some the Worker must turn away. It puts them
through the forwarder's own selection and batching (`GlobalBatches`), and
writes `test/.parity/fixture.json` with what `Summarize` answers for the same
rounds, dated by the day each began. Then it runs `test/parity.test.ts`: the
uploads go through the Worker, `POST /api/v1/admin/rollup` publishes the
parts, and the page's engine answers from `/data/global/`. Every exact figure
must match, and the quartiles and P90 must be the right bin's middle. It runs
again after the days are archived and compacted into month parts. It skips
without Node or without `global/node_modules`, and `npm test` alone skips
`parity.test.ts`.

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
   npm run dev -- --ip 127.0.0.1
   ```

   `predev` copies `.dev.vars.example` to `.dev.vars` (throwaway `DEVICE_KEY`
   and `ADMIN_KEY`) and migrates a local D1 under `.wrangler/`. The page is at
   <http://127.0.0.1:8787/>, and `curl http://127.0.0.1:8787/__scheduled` runs
   the hourly job.

3. **Run tsum-stats against it**, from the repo root, with some rounds to send:

   ```sh
   go run . serve --dir /tmp/tsum-global-dev --global-url http://127.0.0.1:8787 --import-dir ~/some/tsum_record
   ```

   `--global-url` takes plain `http` only to this computer. On the local page,
   <http://127.0.0.1:8090>, press **Contribute**, tick the box, **Join**, then
   **Upload now**. Only rounds that ended in the last 60 days, and at least 20
   minutes ago, are sent.

4. **Roll up and look**:

   ```sh
   curl -s -X POST -H 'Authorization: Bearer local-admin-key-not-a-secret' -d '{}' http://127.0.0.1:8787/api/v1/admin/rollup
   ```

   then reload <http://127.0.0.1:8787/>.

For hot reload, `cd ui && npm run dev -- --mode global` serves the page on
:5173 and sends `/data/global` to the Worker on 127.0.0.1:8787.

gap-companion's local server (`cd cloud && npm run dev`, the Devkit's Cloud
server stage) also listens on :8787. While it runs, start this one with `npm
run dev -- --ip 127.0.0.1 --port 8788`, pass `--global-url
http://127.0.0.1:8788`, and open the page there: the Vite proxy only knows
8787.

The local D1 and R2 are under `.wrangler/state/`. Delete that folder to start
over; `predev` migrates a new one.

## Admin routes

Each takes `Authorization: Bearer <ADMIN_KEY>`, and each `POST` a JSON body.
Locally the key is `local-admin-key-not-a-secret`; in production it is in
`~/.config/tsum-global/secrets.env`.

```sh
H=https://tsum-stats.gapscripts.app        # or http://127.0.0.1:8787
ADMIN_KEY=$(sed -n 's/^ADMIN_KEY=//p' ~/.config/tsum-global/secrets.env)

curl -s -H "Authorization: Bearer $ADMIN_KEY" $H/api/v1/admin/contributors
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -d '{"id":17}' $H/api/v1/admin/ban
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -d '{"id":17}' $H/api/v1/admin/unban
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -d '{"from":18,"into":17}' $H/api/v1/admin/merge
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -d '{"from":"2026-09-01","to":"2026-09-30"}' $H/api/v1/admin/rebuild
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -d '{"day":"2026-08-01"}' $H/api/v1/admin/restore
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -d '{}' $H/api/v1/admin/rollup
```

| Route | Does | Reply |
|:--|:--|:--|
| `GET contributors` | Every contributor | `contributors: [{id, status, createdAt, lastSeen, client, rounds, duplicates, devices}]` |
| `POST ban`, `unban` | Leaves the contributor's rounds out of the public figures, or puts them back. Its days in D1 are recomputed by the next run. A banned contributor gets the same answers as before and is not told | `{id, status, days}` |
| `POST merge` | One player under two ids (a reinstall, a second PC): moves `from`'s rounds, devices and totals to `into`, and deletes `from` | `{from, into}` |
| `POST rebuild` | Marks days dirty for the next runs, at most 400: `{from, to}`, or `{}` for every day with rounds in D1 | `{from, to, days}` |
| `POST restore` | Reads an archived day back into D1 to recompute it. A big day takes several calls: repeat until `done` | `{day, done, files, left, rounds}` |
| `POST rollup` | Runs the hourly job now | The run's report |

Ban, unban and merge refuse id 0 and a contributor being unlinked (400), and
an unknown id (404); merge also refuses `from` = `into`.

To remove a contributor's rounds from everything, ban it, then have it unlink
(`POST /api/v1/me/unlink` with its own key): a banned contributor's rounds are
deleted instead of re-filed. An active contributor that unlinks keeps its
rounds in the figures, under contributor 0.

The report is `{recomputed, rendered, unlinked, archived, dropped, compacted,
manifest, more, queries, r2}`. `more: true` means work is left for the next
run; call rollup again to go on at once. Avoid calling it around 5 past the
hour, when the cron runs: both would take the same days. The result is the
same, but the budget is spent twice.

## Designed for Workers Free

The Worker runs on Workers Free, with Workers Paid as a plan change, not a
rewrite. These rules are why some code looks the way it does:

- **One row written per round.** `rounds` is `WITHOUT ROWID` and its key is
  its only index, so a new round is one row written and an unchanged re-send
  none: the upsert writes only when a figure differs (`WHERE … IS NOT`). The
  key starts with the round's start time, so a day is a key range
  (`days.ts: dayRange`) and needs no index. Free writes 100,000 rows a day;
  `BUDGET_ROWS_PER_DAY` (80,000) refuses a batch that would pass it, before
  anything is written.
- **D1 builds the JSON.** Free allows 10 ms of CPU per request and per cron
  run. Each day's aggregate, each part file, archive file and the manifest is
  one SQL statement (`json_object` over `json_group_array`), and the Worker
  hands the string to R2, or to the next statement, without parsing it. Rows
  go in as one JSON array bound once (`json_each(?1)`), which also gets past
  D1's limit on bound parameters. The manifest adds up per-part summaries kept
  in `state` instead of reading the cells.
- **Per-run budgets.** Free allows 50 D1 queries per invocation (each
  statement of a batch counts) and 50 subrequests. `Run` counts both and
  refuses work past `RUN_QUERY_BUDGET` (45) and `RUN_R2_BUDGET` (40); `job.ts`
  holds back what `finish()` needs for the manifest. Each step records its
  progress in D1 (`dirty_days`, `state`), so a run that stops early, or is cut
  off, loses nothing, and the next run carries on.
- **D1 stays small.** Only days that can still change are in D1. A day older
  than `ACCEPT_DAYS` + 1 is final: its rounds go to the private archive in R2,
  one file per contributor, and leave D1 once every file's row count is
  checked. Its cells stay. A month whose days are all final becomes one part
  file, if it is under 1.9 MB.
- **Not enforced by Miniflare**: D1's 2 MB limit on one value (a part, an
  archive file, a day's aggregate) and the 10 ms CPU limit. Watch the logs
  after a deploy.
- **D1's own rules**, found on the way: temporary tables are refused; a
  compound SELECT allows only 5 terms, so restore joins on array position
  instead of a UNION; a JS number binds as REAL, so SQL that turns one into
  text casts it first (`CAST(?1 AS INTEGER)`, see `run.ts`).

## Tunables

The `vars` in `wrangler.jsonc`, read by `env.ts: limits`:

| Var | Default | |
|:--|:--|:--|
| `QUOTA_PER_CONTRIBUTOR` | 5000 | Accepted rounds per contributor per UTC day |
| `BUDGET_ROWS_PER_DAY` | 80000 | Rounds written per UTC day, everyone together |
| `ACCEPT_DAYS` | 60 | How long ago a round may have started. Older days are final and archived |
| `ROLLUP_DAYS_PER_RUN` | 8 | Dirty days one run recomputes at most |
| `UNLINK_CHUNK` | 5000 | Rounds re-filed per unlinking contributor per run |
| `RUN_QUERY_BUDGET`, `RUN_R2_BUDGET` | 45, 40 | Where a run stops starting work |
| `MIN_CONTRIBUTORS` | 3 | Below this many contributors the page flags a Tsum "few players" |

Change one in `wrangler.jsonc` and deploy. The forwarder sends 60 days of
rounds (`globalWindow` in `internal/stats/global.go`), so change that with
`ACCEPT_DAYS`.

The secrets `DEVICE_KEY` and `ADMIN_KEY` are never in `wrangler.jsonc`:
locally they come from `.dev.vars`, in the tests from `vitest.config.ts`.
While `DEVICE_KEY` is unset, every `/api/*` request answers 500 and the cron
throws, so no key or device hash is ever made without it.
