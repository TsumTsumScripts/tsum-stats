# Internals

How Tsum Tsum Stats is put together, for someone changing it. The manual is
[USING.md](USING.md); this document assumes it.

It says what the pieces are and which file owns each one. The reasoning behind
a particular number or query belongs beside that code, not here.

## The server

The server is PocketBase used as a Go library (`main.go`), for the HTTP
server, SQLite (pure Go, so every target cross-compiles from one machine),
realtime over SSE and the admin UI at `/_/`.

Two departures from stock PocketBase are worth knowing before changing
anything near them:

- **The device listener is a goroutine in the same binary.** The app's event
  dialer speaks newline-delimited JSON over TCP, which PocketBase's JS hooks
  cannot listen for. Keeping it in-process means the download stays a single
  file.
- **The data is in plain SQL tables, not PocketBase collections**
  (`internal/stats/schema.go`), because an unread figure has to stay NULL —
  stored as 0 it would drag every average down. Tables are created at bootstrap
  with `IF NOT EXISTS`.

The page gets live updates from five custom realtime topics — `ts/devices`,
`ts/rounds`, `ts/imports`, `ts/publish` and `ts/global` — none of them a
collection subscription. `TestPageSubscribesToEveryTopic` checks that
`App.svelte` subscribes to each.
Messages are sent from one goroutine, never from a device's event reader, and
a page that stops reading is dropped. The page reopens its stream when it
closes and refetches when a device looks stale.

## The service starter

`internal/starter` is the Tsum Tsum script's service starter as a website,
mounted with `--starter <bundle>` through `stats.Config.Starter`
(`StarterHook`). It ports the bundle's shell host: adb chosen and downloaded
against the bundle's `platform-tools.txt` (`adb.go`), emulator discovery and
the `device/gap-service.sh` protocol (`device.go`), the actions (`actions.go`),
APKs and the release channel (`apk.go`) and the zip export (`export.go`). The
page is plain files in `internal/starter/site/`, embedded as they are. Its
default look is `a11y.css` (flat, high contrast, light or dark, four sizes)
over the website's felt design (`felt.css`, `app.css`); the header's Aa
popover (`appearance.js`) switches style, theme and size, kept in
localStorage under `starter*` keys. It shares its adb with the `Puller` (`SetADB`), which
then skips its own download.

Its `/api/starter` routes run adb, so they answer only on a loopback Host and
refuse cross-origin writes. Actions stream NDJSON (`{"log"}` lines, then
`{"done"}`), with the 5-minute write deadline cleared. Every action except the
live log holds a per-device lock, since a probe would otherwise re-push the
device script mid-run. `go test ./internal/starter` drives it through a fake adb.

Watch mode (`watch.go`): a 15 s loop over the serials turned on in
`<bundle>/watch.json`, one goroutine per device, each skipping the device
while an action holds its lock. It runs `gap-service.sh watch` (pushing the
script only when the bundle's copy changed or the device's copy is missing or
another version). Only adb failing (a timeout, or adb's own `error:`) counts as
unreachable; any other unusable reply is a status line, never a restart. It folds the
reply into the device's state with `observe()` and acts on `decide()`
(`watchpolicy.go`, pure and table-tested; keep it free of starter specifics so
it can run for cloud hosts later). Emulator back ends sit behind the
`Emulator` interface (`emulators.go`, which also holds the parsers and the
port mapping; `Find` returns a new value, never changed afterwards, so a
restart can run while the next look-up does), one file per family built only on its OS
(`emu_*_windows.go`, `emu_bluestacks_darwin.go`, `emu_other.go`). Their
command lines are marked "Verify on device" until tried on a real install.

Updates (`update.go`, `bundle.go`): main hands the starter an `Updater` built
on its own `selfUpdate`, since only main knows `updateURL` and its binary; the
bundle's scripts update from the bundle's own `starter-version.txt`. An apply
stages everything (the archive unpacks into `<bundle>/.update/new`, and must
carry the required files and the pinned version) before renaming files into
place, so a shell still reading a script keeps the old file, and a failed
rename puts back the ones already moved. Then the route shuts the HTTP server
down (closing the stats page's realtime stream if it holds on), PocketBase's
`Execute` closes the database, and main exits with the launcher's restart
code. `boot` in `GET /update` tells the page a new process from the old one.

## Where the data comes from

| Source | Code |
|:--|:--|
| Live rounds over TCP | `internal/stats/events.go` |
| `stats_*.csv` and `tsum_list_*.csv` | `internal/stats/importer.go`, `csv.go` |
| Dropped or picked files (`POST /api/stats/import`) | `server.go` |
| Import from devices (adb) | `internal/stats/adb.go`, `adb_install.go` |

**A live round and its CSV row are one row.** They share the round's UUIDv7,
which is the `id` on both the round events and the CSV row. An event inserts
the row and records the device; a later CSV import overwrites every figure but
keeps the device; an event arriving after its CSV row changes nothing. The
device-name fallback chain is in the importer, and [USING.md](USING.md#getting-your-data-in)
describes what a player sees of it.

## Querying

The page never holds more than one page of rounds. The server filters, sorts,
pages and aggregates:

- `/api/stats/rounds` returns one page, sorted by one of a fixed list of
  columns, with `NULLS LAST` and the id as a tie-break so paging is stable.
- `/api/stats/summary` returns everything above the tables as `GROUP BY`
  results: the KPIs, per day and per hour bucketed in the viewer's time zone,
  per Tsum, per day × Tsum, per game × Tsum × item set, and the coin
  histogram. The charts draw only these, so a large history is still a few
  thousand numbers.
- `/api/stats/tsum` is the Tsum page: one Tsum's summary, its figures grouped
  by each script setting (`json_each` over `settings`), script version and
  device, recent form, per-skill histogram buckets, what all Tsums earn a
  second for box times, and every Tsum's rate in the same filter for its rank
  (`tsum.go`). Item payback is worked out in the page from the summary's `mix`.

The queries are in `queries.go` and `summary.go`, with their indexes declared
in `schema.go`. Both are sized against a large synthetic history; if you add a
query to the summary, check it the same way before shipping it, since they all
run on one request.

## The snapshot engine

`tsum-stats snapshot DIR` writes the site and its data as plain files
([USING.md](USING.md#publishing-a-snapshot) covers the layout and the flags).

In the page, `index.html` gets `<meta name="tsum-snapshot">`; `api()` then
sends every route to `ui/src/lib/snapshot/engine.js` in a Web Worker instead of
the server. **The engine reproduces the server's filters, sorts and summary,
and that parity is a test:** `go test ./internal/stats` runs both over the same
rounds — timezones, ties, empty results, junk input — and fails if they differ.
Change a query in `queries.go` or `summary.go` and the engine changes with it.

Help, the Data dialog, importing and the live device chip is hidden in a
snapshot; a note in the top bar says when it was taken.

## Publishing to GitHub Pages

The player-facing flow is in [USING.md](USING.md#sharing-it-on-github-pages).
The GitHub calls are in `internal/stats/github.go`; the sign-in, saved choices
and background job are in `publish.go`. `publish_test.go` runs them against an
in-memory fake of GitHub's API with git's real content hashing.

## The global site

<https://tsum-stats.gapscripts.app> pools the rounds of the players who
contribute into community figures. [USING.md](USING.md#contributing-to-the-global-stats)
is what a player sees, `global/README.md` the Worker in detail, and
`global/CLOUDFLARE-SETUP.md` its account, deploy and limits.

It has three parts, all in this repo:

| Part | Files | Does |
|:--|:--|:--|
| The forwarder | `internal/stats/global.go`; its routes in `server.go` (`registerGlobalRoutes`), `ts_global_sent` in `schema.go`, `--global-url` in `main.go`; `ui/src/components/ContributeDialog.svelte` | Joins, picks rounds, sends them hourly, and handles refusals. `GET /api/stats/global`, `POST /api/stats/global/{join,run,leave}`, topic `ts/global` |
| The Worker | `global/`: `src/`, `migrations/`, `wrangler.jsonc`, `deploy.sh` | Checks rounds and stores them in D1, rolls them up hourly, publishes part files and a manifest to R2, and serves them with the page |
| The page in global mode | `ui/src/lib/global/` (`engine.js`, `worker.js`, `client.js`), `ui/src/components/GlobalNote.svelte`, and `isGlobal()` in the sections | Answers `api()` in a Web Worker from the published files, and hides what they cannot answer |

**`global/CONTRACT.md` is the one description all three are built
against**: the upload format and its checks, the API, the write budget, the
D1 schema, the hourly job, the R2 layout, the published files, the bins, the
page's routes and the forwarder. Change a shape there first, then each side;
the code cites its sections.

**The rounds' path.** The forwarder sends each complete round from the last
60 days as the stats CSV row the script writes (`GlobalRecord`: no device
name, source or Tsum list), in the Tsum script's own upload format,
`gap.round-stats/1`, 100 to a batch, oldest first. It keeps each sent round's
fingerprint in `ts_global_sent`, so only new or changed rounds go again, and
the rounds the Worker names in its reply's `retry` (turned away as `future`,
a clock ahead of the site's) go again on the next pass. Two numbers in the
Worker's replies send every round once more: `keeps` going up (the site
keeps a field it did not), and `resend` going up (an admin's call for a full
re-upload, `POST /api/v1/admin/resend`); both are hashed into the
fingerprints, so a pass that hears of either finds every round changed. The Worker re-keys
each round: the id's start time and random bits, then an HMAC (the
`DEVICE_KEY` secret) of its device tag. So the same round from two players
still collides, the first sender keeps it, and the hardware tag is never
kept. `rounds` holds one row per round. A Tsum the Worker's catalog (the
`catalog.json` it was deployed with) lacks is stored and counted as its
sender's, but stays out of every public figure until a deploy knows it and
`rebuild` brings its days in. Only the Worker's own daily limits (`429
quota`/`join-limit`, `503 budget`) make the forwarder wait for `Retry-After`;
anything else is an error the next hourly pass tries again.

**Days.** On the global site a round's day is the UTC day it **started**, read
from its key; the local site files it under the day it ended, in the viewer's
time zone. Rounds of some Tsums last hours, so nothing is turned away for its
length, and the two sites' per-day figures differ where rounds cross midnight.

**The rollup.** Each upload adds up its own new rounds as the day tables keep
them, into one `pending` row. Every hour (cron `5 * * * *`) the job folds
those into `cells2` (sums per day × build × Tsum × skill × skill type × items
× medals > 0), `cell_bins2` (each cell's histogram bins, 2 % wide) and the
private `contrib_cells`, and
recomputes a day in full from its key range only when something else changed
it (a ban, a changed round, a merge, a rebuild, a restore). It renders the
changed days' part files, finishes unlinks day by day, archives days older
than 61 days to R2 (dropping them from D1 only once it holds more than
`RETAIN_ROWS` rounds), compacts final months into one part, and writes the
manifest. Each step runs on its own: one that fails is reported, and the rest
still run. It is sized for Workers Free:

- D1 builds every JSON string, and never one over `VALUE_MAX_BYTES` (a part
  too long for one value is published as several files), so the Worker's CPU
  stays within 10 ms however big a day is.
- `Run` (`global/src/run.ts`) makes a run stop starting new work at 45 D1
  queries or 40 R2 operations (Free allows 50), or about 2 MB carried to R2.
  Each step records its progress in `pending`, `dirty_days` and `state`, and
  the next run carries on.
- **One write budget counts every row D1 writes or deletes**, uploads and the
  job alike (90,000 a UTC day; Free writes 100,000). Uploads and joins stop
  at 65,000, the rest is the job's, and the checks are statements of the
  batch they guard. Each contributor may add 5,000 rounds a day.
  `global/CLOUDFLARE-SETUP.md` works out what that carries: roughly 45,000 to
  60,000 rounds a day at first for 20 to 100 players sending 8 hours a day,
  about half that once D1 holds `RETAIN_ROWS` rounds and every archived round
  is also a delete.

**The page.** `npm run build:global` (`vite build --mode global`) builds `ui/`
into `global/site/` with `<meta name="tsum-global">`. `engine.js` follows the
snapshot engine with cells in place of rounds, and reuses its `parseFilter`,
`parseTime`, `sqlTime`, `itemCost`, `histBounds` and `bucketOf`. Counts, sums,
averages, extremes, rates and the standard deviation add up exactly. Each cell
carries its bins (`cell_bins2`, CONTRACT §5): its rounds by 2 % bins of base
coins, final coins and medals, each bin with its rounds' sums. The quartiles,
P90 and histogram come from them, marked ≈, and so do the outlier ranges:
`cutCell` keeps the bins whose average is in the range and makes the cell
their sums (CONTRACT §6.2). It answers the Tsum page too (`tsum`, §6.3). It
loads only the parts a date range touches, all the files of a part the Worker
split, matched up as one; a part replaced since the manifest was read (a 404)
makes it read the manifest again, once.

**Tests:**

- `cd global && npm test`: the Worker in workerd (Miniflare), with its rollup
  checked against a plain-JS one (`global/test/reference.ts`).
- `cd ui && npm run test:global`: the engine over synthetic cells, against the
  snapshot engine over the same rounds.
- `go test ./internal/stats -run TestGlobal`: the forwarder against a fake
  Worker, and `TestGlobalParity` end to end. Three players' rounds go through
  the forwarder's passes (100 to a batch), then (in
  `global/test/parity.test.ts`, in Miniflare) the Worker's checks and hourly
  job, then the page's engine over the files it publishes. Every exact figure
  must match `Summarize` over the same rounds dated by their start, and the
  quartiles and P90 the right bin's middle. Rounds of a Tsum the catalog lacks
  must stay out of every figure, and rounds the site names in `retry` must go
  with the next pass. It runs again with every day part split into several
  files, and once the days are archived and compacted. It needs Node and
  `npm ci` in `global/`, and skips without them.

**Changing a query.** A figure lives in three places, changed in this order:

1. `summary.go` (or `queries.go`): the server's answer.
2. `ui/src/lib/snapshot/engine.js`, held to it by `TestSnapshotParity`.
3. `ui/src/lib/global/engine.js`, held to it by `TestGlobalParity`. When the
   figure needs a sum the cells lack, add a cell column first, everywhere at
   once: `CONTRACT.md` §3.1 and §4.2, a new migration, `aggregate` in
   `global/src/ingest.ts` (an upload's own sums) and `CELLS` in
   `global/src/rollup.ts`, `CELL_COLUMNS` in `global/src/parts.ts`,
   `decodePart` in the engine, and `global/test/reference.ts`. A figure a
   range must cut too needs it in the bins' figures as well (`binsSelect` and
   `mergeBins` in `rollup.ts`, `cutCell` in the engine).

A figure that cannot be added up from per-day sums (one that needs the order
of the rounds, or the time of day) is approximate from the bins, or left off
the global site as `hours` and the Rounds table are. A new cell column fills
only as days are recomputed: `POST /api/v1/admin/rebuild` does the days still
in D1, and an archived day needs `restore` first (`global/README.md`).

## The catalog

`ui/public/data/catalog.json` is generated from the Tsum script's portrait
library (a tool that lives with the scripts, not here) and committed, so
building the site needs nothing else. The generator also assigns each Tsum its
chart colour, keeping one once given and handing a new Tsum the next free slot;
a Tsum the catalog does not know falls back to a hue derived from its id. Box
counts come from a box-count file, and without it the counts already in the
catalog are kept. The global site's Worker bundles this file when it is
deployed: rounds of a Tsum it lacks are kept but stay out of the global
figures until a deploy carries a catalog that has it, then a `rebuild` brings
them in (`global/CLOUDFLARE-SETUP.md`, *After launch*).

## Building and shipping

```
tools/build.sh             # five binaries and the pin, into build/<version>/
tools/build.sh --publish   # also create the GitHub release v<version>
```

- **Go:** `GOTOOLCHAIN` fetches the version `go.mod` asks for.
- **Node and npm:** the script builds the page (`ui/`) into `web/` before
  `go build`, which embeds it. `web/` is build output and is not committed, so
  a fresh clone needs `cd ui && npm ci && npm run build` before `go vet` or
  `go test`.
- **Version:** read from `VERSION`.
- **Pin:** `tsum-stats.txt`: the version, then URL, sha256 and size per system.
  The build writes it into `build/<version>/` and copies it here. A running
  tsum-stats reads the newest release's copy
  (`releases/latest/download/tsum-stats.txt`, built in as `updateURL`) and
  refuses a download that does not match.
- **Publishing:** `--publish` uploads the binaries and the pin to one release,
  so the pin never names a missing file. Bump `VERSION` first; it refuses an
  existing tag.
- **The global site** is not part of the build: the GAP Devkit's **Tsum Tsum
  global stats** card deploys it from a pushed commit, on the personal
  Cloudflare account only (`../tools/DEPLOYMENTS.md`,
  `global/CLOUDFLARE-SETUP.md`; `global/deploy.sh` only when the Devkit is not
  available). The binaries name it as the `--global-url` default, so it goes
  live before the first release with Contribute: in a Devkit stack job that
  card runs before **Tsum Tsum Stats**.

## Working on the page

```
cd ui && npm install
npm run dev     # hot reload on http://localhost:5173, /api sent to tsum-stats on :8090
npm run build   # writes ../web, which go build embeds
npm run check   # svelte-check
npm run build:global   # the global site, into ../global/site
npm run test:global    # the global engine's tests
```

Each build stamps the page with the commit it came from (`siteBuild` in
`ui/vite.config.js`: the commit's UTC date and time to the minute, its short hash and whether the
tree had uncommitted changes; the build date without git), as
`__SITE_BUILD__` (declared in `ui/src/env.d.ts`), shown in the footer by
`App.svelte`. The global site's page and its Worker deploy from the same
commit, so its stamp dates the Worker too.

The page is Svelte 5 (`ui/src/`). Markup lives in `.svelte`
files. The d3 charts in `lib/charts.js` draw the SVG; their legends and
tooltips come back as data that `Legend.svelte` and `Tip.svelte` render.

## Running it by hand

```
cd ui && npm install && npm run build   # once, and after changing the page
cd .. && go run . serve --dir /tmp/tsum-stats-data --import-dir ~/some/tsum_record
```

The flags are listed in [USING.md](USING.md#options).

`go test ./...` covers:

- CSV parsing: header drift, `T`/`F` switches, empty cells;
- merging an event and a CSV row for the same round;
- filters, sort order and the time-zone day buckets;
- a Tsum list being replaced;
- importing from a device, through a fake adb;
- the snapshot engine against the server's own queries;
- contributing, against a fake global site;
- the global site end to end (`TestGlobalParity`), once `global/` has had
  `npm ci`.
