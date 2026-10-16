# Code map

**Read this before searching the tree.** It exists so a session can start with
one targeted read instead of a sweep: which file owns what, which document
already answers a question, and where a given name is defined. It is
deliberately short -- the depth lives in the documents it points at.

Paths are relative to the repo root. `node tools/codemap-check.js` verifies this
file against the tree: a path that moved, a source file, test, document or tool
nobody listed. Run it after moving or adding anything.

## Repo shape

```
tsum-stats/
├── README.md          what it is, how to install and run it, the short build
├── CLAUDE.md          read this file first; deployments are ../tools/DEPLOYMENTS.md
├── CODEMAP.md         this file
├── VERSION            the release version (tools/build.sh reads it)
├── tsum-stats.txt     the update pin: version, then url/sha256/size per system.
│                      Written by tools/build.sh, never by hand
├── install.sh         the macOS/Linux one-liner installer (curl | sh)
├── tsum-stats.cmd     the Windows launcher: downloads, checks, starts
├── main.go · launch.go · update.go
│                      the program: commands and flags, double-click launch,
│                      self-update
├── internal/stats/    the stats site's server: tables, importers, queries,
│                      snapshot, Share, the forwarder to the global site
├── internal/starter/  the service starter's website (/starter/, --starter)
├── ui/                the page (Svelte 5), built three ways: web/ (local),
│                      a snapshot, global/site/ (vite build --mode global)
├── global/            the global site's Cloudflare Worker (D1 + R2, hourly
│                      rollup); CONTRACT.md is the spec all three sides share
├── docs/              USING.md (the manual), INTERNALS.md (how it is built)
├── tools/             build.sh (binaries, pin, release), codemap-check.js
├── web/               build output of ui/, embedded by main.go; git-ignored
└── build/             tools/build.sh output, build/<version>/; git-ignored
```

The server is PocketBase used as a library: its SQLite holds **plain SQL
tables, not collections** (`internal/stats/schema.go`), and the page's live
updates are custom realtime topics. The global site lives on the **personal**
Cloudflare account only, never the GAP one (`global/README.md`,
`global/CLOUDFLARE-SETUP.md`). Not to be confused with **round stats**, the
`stats_*.csv` the Tsum script writes and shares (`roundStats.ts`,
`roundShare.ts` in `../tsum-tsum-script`), which this program imports.

## Which document answers which question

| Question | Read |
|:--|:--|
| What a change has to touch before it is finished | [§ Adding something](#adding-something--what-a-change-has-to-touch), below |
| What it is, installing it, the one-paragraph build | `README.md` |
| Every flag; the starter page and watch mode as a player sees them | `docs/USING.md` § Running it, § Options, § The service starter, § Watch mode |
| Getting rounds and Tsum lists in (live events, CSVs, adb) | `docs/USING.md` § Getting your data in; the code side `docs/INTERNALS.md` § Where the data comes from |
| What a figure on Stats, the Tsum page or the Catalog means | `docs/USING.md` § The Stats page, § The Tsum page, § The catalog (§ Cost to max) |
| Snapshots and GitHub Pages | `docs/USING.md` § Publishing a snapshot, § Sharing it on GitHub Pages; `docs/INTERNALS.md` § The snapshot engine, § Publishing to GitHub Pages |
| `--web-dir` overrides; themes | `docs/USING.md` § Changing the site, § Themes |
| Contributing to the global stats, as a player | `docs/USING.md` § Contributing to the global stats, § The global page |
| Why PocketBase, why plain tables, the realtime topics | `docs/INTERNALS.md` § The server |
| The starter's adb, actions, watch mode and updates, inside | `docs/INTERNALS.md` § The service starter |
| Why the server pages and aggregates; where queries and indexes live | `docs/INTERNALS.md` § Querying |
| The global site's three parts, its days, the rollup, its tests; **changing a figure on every side** | `docs/INTERNALS.md` § The global site (its "Changing a query") |
| Upload format, Worker API, write budget, D1 schema, hourly job, R2 layout, published files, bins, page routes, forwarder settings | `global/CONTRACT.md` §1--§7 (code cites it as `CONTRACT §n`) |
| The Worker's files, tests, running it locally, admin routes, Free vs Paid, tunables | `global/README.md` § Layout, § Tests, § Running it locally, § Admin routes, § Designed for Workers Free, § Tunables |
| The Cloudflare account, token, D1/R2, secrets, deploy, checks, limits, what never to do | `global/CLOUDFLARE-SETUP.md` §1--§8, § Never |
| The website edits that link to the global site | `global/WEBSITE-LINKS.md` |
| Where `catalog.json` comes from; a Tsum the Worker does not know | `docs/INTERNALS.md` § The catalog; `global/README.md` (a Tsum newer than the deploy) |
| Building the binaries, the pin, publishing a release | `docs/INTERNALS.md` § Building and shipping; the header of `tools/build.sh` |
| Releasing either part (binaries, Worker) the way it is actually done | `../tools/DEPLOYMENTS.md` § Tsum Tsum Stats, § Tsum Tsum global stats -- the GAP Devkit's cards |
| Working on the page; running it by hand; what `go test` covers | `docs/INTERNALS.md` § Working on the page, § Running it by hand |
| What one `ui/` or `global/` file owns, in depth | That file's header comment; the tables below index them. Most Go files have none, so their rows below say it |

## Source map -- Go

### The program -- repo root

| File | Owns |
|:--|:--|
| `main.go` | The command line: PocketBase app, every flag (`--events-addr`, `--import-dir`, `--web-dir`, `--global-url`, `--starter`, ...), `serve` when launched bare, the `web export`, `snapshot` and `update` commands; embeds `web/` |
| `launch.go` | The data folder (`dataDir`), opening the browser, the already-running checks |
| `update.go` | Self-update from the pin (`updateURL`, set by the build): compare versions, download, check sha256, swap, restart |
| `update_test.go` | Version order and pin parsing |

### `internal/stats/` -- the stats server

| File | Owns |
|:--|:--|
| `internal/stats/schema.go` | The tables (`ts_rounds`, `ts_tsum_lists`, `ts_owned`, `ts_imports`, `ts_global_sent`) and indexes; legacy table renames; columns added later (`addListColumn`). The package doc |
| `internal/stats/store.go` | `Round`, `OwnedTsum`; the round upserts (an event and its CSV row are one row), time normalising, replacing a Tsum list |
| `internal/stats/csv.go` | Reading `stats_*.csv` and `tsum_list_*.csv`: header-keyed cells, `T`/`F`, setting values |
| `internal/stats/importer.go` | `Importer`: scanning the import folders, files already seen, the device name from the folder, dropped files |
| `internal/stats/events.go` | `Events`: the TCP listener (and dialler) for the script's live events, live devices, a round end stored as a row |
| `internal/stats/adb.go` | `Puller`: Import from devices over adb -- find adb, connect emulators, pull the device's files into the importer |
| `internal/stats/adb_install.go` | Downloading platform-tools when no adb is found |
| `internal/stats/queries.go` | `Filter` (`ParseFilter`, the WHERE), the play settings (`PlaySettings`, `playSettingSQL`), the rounds page and its sort columns, played Tsums, devices, skill types and play settings, the latest Tsum list |
| `internal/stats/summary.go` | `Summarize`: everything above the tables (KPIs, per day / hour / Tsum / mix, spreads, the coin histogram); item sets and their cost (`itemBits`) |
| `internal/stats/tsum.go` | `DescribeTsum`: the Tsum page's answer (by setting, version, device; form, skill bins, rank) |
| `internal/stats/art.go` | `Art`: Tsum portraits fetched for the page at `/api/stats/art/{id}` (their origin sends no CORS headers), kept in memory |
| `internal/stats/server.go` | `Register`, `Config`, `StarterHook`: wiring into PocketBase, the `/api/stats` routes (`registerRoutes`, `registerGlobalRoutes`), the topics `ts/devices`, `ts/rounds`, `ts/imports` and their broadcaster, the loopback and same-origin guards |
| `internal/stats/site.go` | The site's files: the embedded build, `--web-dir` overrides gated by `override.json` (`Manifest`), themes and `themeOrder`, `ExportSite` |
| `internal/stats/snapshot.go` | `ExportSnapshot`: the `snapshot` command's static site and monthly data files (`SnapshotFormat`) |
| `internal/stats/github.go` | GitHub API calls for Share: who is signed in, the repo, one commit of the snapshot, Pages |
| `internal/stats/publish.go` | `Publisher`: Share's saved token and choices, the background publish, topic `ts/publish` |
| `internal/stats/global.go` | `Contributor`: the forwarder to the global site (CONTRACT §7) -- join, leave and unlink, the hourly passes, refusals and `Retry-After`, `GlobalRecord`, `RoundBatch`, topic `ts/global` |

Tests: `stats_test.go` (CSV parsing, event + CSV merge, filters, summary, Tsum
lists, heartbeats), `stats/adb_test.go` and `adb_install_test.go` (device import
through a fake adb; unzip refusing escapes), `legacy_test.go`, `site_test.go`
(overrides, themes), `snapshot_test.go` (`TestSnapshotParity` runs
`ui/tests/parity.mjs`), `publish_test.go` (a fake GitHub;
`TestPageSubscribesToEveryTopic`), `art_test.go` (portraits through a fake
origin), `global_test.go` (the forwarder against a
fake Worker), `global_parity_test.go` (`TestGlobalParity`, which runs
`global/test/parity.test.ts`).

### `internal/starter/` -- the service starter's website

Package doc in `internal/starter/starter.go`; `docs/INTERNALS.md` § The service
starter is the long form.

| File | Owns |
|:--|:--|
| `internal/starter/starter.go` | `Starter`, `New`, `Mount`: the `/starter/` page and `/api/starter` routes (loopback only, NDJSON action streams) |
| `internal/starter/actions.go` | `Run`: a device's actions (start, stop, reboot, log, install, update, copy, import stats, delete) |
| `internal/starter/adb.go` | Choosing adb, downloading it against the bundle's `platform-tools.txt`, restarting the adb server |
| `internal/starter/device.go` | Listing and probing devices, emulator ports, the bundle's `gap-service.sh` verbs, the per-device lock, the catalogue source |
| `internal/starter/apk.go` | The bundled APKs per ABI, installing one, the release channel and its manifest |
| `internal/starter/export.go` | The zip export (script, service, stats, lists), the save dialog, reveal in folder |
| `internal/starter/update.go` | `Updater` and the `/update` routes: the program's and the bundle's updates, the restart code |
| `internal/starter/bundle.go` | Updating the bundle's own scripts from `starter-version.txt`: staged, then swapped in |
| `internal/starter/watch.go` | `Watcher`: watch mode's loop over `watch.json`, `gap-service.sh watch`, acting on a decision |
| `internal/starter/watchpolicy.go` | `observe`, `decide`, `record`, `WatchLimits`: watch mode's pure, table-tested policy |
| `internal/starter/emulators.go` | The `Emulator` interface, serial → instance mapping, the emulators' list parsers |
| `internal/starter/emu_windows.go` | Windows: PowerShell, processes, finding a tool, the emulator list |
| `emu_mumu_windows.go`, `emu_ldplayer_windows.go`, `emu_bluestacks_windows.go`, `emu_bluestacks_darwin.go` | One emulator family each: MuMu Player 12, LDPlayer 9, BlueStacks 5, BlueStacks Air |
| `internal/starter/emu_other.go` | No emulator back ends on other systems |
| `internal/starter/site/` | The page, plain files embedded as they are: `site/index.html`, `app.js` (devices, actions, export, log), `appearance.js` (style, theme, size), `a11y.css` (the default style), `felt.css` (the website's felt, keep in step), `app.css`, `coin.svg` |
| `internal/starter/testdata/` | Emulator and watch-reply fixtures for the parsers |

Tests: `starter_test.go` (protocol parsing, channel, device probe, export zip,
adb restart -- through a fake adb), `starter/adb_test.go`, `emulators_test.go`,
`starter/update_test.go`, `watch_test.go`.

## Source map -- the page, `ui/`

`ui/vite.config.js` stamps the build with its commit (`siteBuild`, shown in
the page footer; typed in `ui/src/env.d.ts`) and builds into `web/` (local; the binary embeds it) or, with
`--mode global`, into `global/site/` tagged `<meta name="tsum-global">`. A
snapshot is the local build tagged `<meta name="tsum-snapshot">` by
`snapshot.go`. `ui/public/` holds `data/catalog.json`, the themes, art and fonts.

| File | Owns |
|:--|:--|
| `ui/src/main.js`, `ui/src/styles.css` | Mounting `App.svelte`; the page-wide styles |
| `ui/src/App.svelte` | The shell: hash routing, the top bar, live updates, importing CSVs. Read-only in a snapshot and on the global site |
| `ui/src/sections/Stats.svelte` | Filter rail, KPIs, charts, per-Tsum and rounds tables. Global: no rounds table or hours |
| `sections/stats/` | `FilterRail.svelte` (filters, jump menu), `FocusBar.svelte` (picked Tsums), `HeadToHead.svelte`, `Kpis.svelte` |
| `ui/src/sections/Tsum.svelte` | The Tsum page: one Tsum's figures, settings, rank, ownership, best rounds (on the global site: everyone's rounds of it, by skill level and items) |
| `sections/tsum/` | `Breakdown.svelte` (by skill, setting, version, device), `Insights.svelte` (form, pace, steadiness), `ItemPayback.svelte` |
| `ui/src/sections/Catalog.svelte` | Every Tsum against the latest Tsum list; the roster on the global site. `catalog/MaxOut.svelte`: cost and time to max |
| `ui/src/sections/Help.svelte` | How to get data in |
| `components/` dialogs | `DataDialog.svelte` (what is stored, importing), `PublishDialog.svelte` (Share), `ContributeDialog.svelte` (the global stats) |
| `components/` top bar | `LivePills.svelte` (live devices), `SnapshotNote.svelte`, `GlobalNote.svelte`, `ThemePicker.svelte`, `Dropdown.svelte` |
| `components/` building blocks | `CopyButton.svelte` (copy as an image), `Panel.svelte`, `Chart.svelte`, `Legend.svelte`, `Tip.svelte`, `DataTable.svelte` (TanStack core; client or server paging), `Seg.svelte`, `Toasts.svelte`, `Avatar.svelte`, `TsumCell.svelte`, `TsumChip.svelte` |
| `ui/src/lib/util.js` | Formats, `api()`, the catalog, Tsum colours, `IMAGE_URL` |
| `ui/src/lib/ui.svelte.js` | Shared page state: catalog, devices, tooltip, toasts, expanded panel, theme |
| `ui/src/lib/realtime.js` | PocketBase realtime over SSE, resubscribing on reconnect |
| `ui/src/lib/card.js` | Copy as an image: the compact card (title, condensed panel, the page's `cardContext`: Tsum, filters, rounds), drawn with html-to-image, onto the clipboard |
| `ui/src/lib/charts.js` | The d3 charts; each returns legend items |
| `ui/src/lib/boxes.js` | Skill boxes left to max a Tsum, from the catalog's `boxes` |
| `ui/src/lib/snapshot/engine.js` | **The server's `/api/stats` answers in the browser**, from a snapshot's monthly files. Held to Go by `TestSnapshotParity` |
| `snapshot/client.js`, `snapshot/worker.js` | Is this a snapshot; run the engine in a Web Worker and keep loaded months |
| `ui/src/lib/global/engine.js` | The same answers from the global site's part files (cells, not rounds; quartiles, P90 and the outlier ranges from each cell's bins), the Tsum page's included. Reuses the snapshot engine's helpers |
| `global/client.js`, `global/worker.js` | Is this the global site (`isGlobal`); run the engine in a Web Worker, keep parts, refetch a replaced part |
| `ui/tests/parity.mjs` | The snapshot engine against the server's answers, run by `TestSnapshotParity` |
| `ui/tests/global-engine.test.mjs` | The global engine against the snapshot engine over the same rounds (`npm run test:global`) |

## Source map -- the Worker, `global/`

`global/README.md` § Layout is the file table, one row per `global/src/` file;
this is its index. `migrations/0001_init.sql` is the D1 schema (CONTRACT §3.1),
`migrations/0002_cell_bins.sql` its bins per cell,
`wrangler.jsonc` the bindings, route, cron and tunables, `deploy.sh` the
by-hand deploy when the Devkit is not available.

| File | Owns |
|:--|:--|
| `global/src/index.ts` | Routing, the JSON-only POST rule, the cron entry |
| `global/src/env.ts`, `global/src/http.ts`, `global/src/crypto.ts`, `global/src/days.ts` | Bindings and tunables; replies and bodies; hashes, HMAC and keys; UTC days, keys, bins |
| `global/src/catalog.ts` | Tsum ids and medal Tsums, bundled from `ui/public/data/catalog.json` |
| `global/src/records.ts`, `global/src/ingest.ts` | An upload's records → rounds (read as `csv.go` reads them); `POST /api/v1/rounds` in one D1 batch, sums to `pending` |
| `global/src/contributors.ts`, `global/src/admin.ts` | Join, bearer check, `/me`, unlink; the admin routes |
| `global/src/budget.ts`, `global/src/run.ts` | The day's write and read budget (§2.6); one invocation's D1/R2 share |
| `global/src/job.ts` | The hourly job: claims dirty days, runs each step on its own |
| `global/src/rollup.ts`, `global/src/parts.ts`, `global/src/unlink.ts`, `global/src/archive.ts` | Steps: `cells`/`cell_bins`/`contrib_cells`; part files, compaction and the manifest; finishing unlinks; archive, drop and restore |
| `global/src/data.ts` | `GET /data/global/*` from R2 through the edge cache |

Tests (vitest in workerd; `vitest.config.ts` binds `test/tunables.json`, the
Free numbers, in place of `wrangler.jsonc`'s): `admin.test.ts`,
`archive.test.ts`, `data.test.ts`, `deploy.test.ts` (the token reaches wrangler
only), `ingest.test.ts`, `records.test.ts`, `rollup.test.ts`,
`unlink.test.ts`, `tunables.test.ts`, `volume.test.ts` (a day of 80,000
rounds), `parity.test.ts` (driven by Go's `TestGlobalParity`; skipped by `npm
test` alone). Support: `setup.ts` (migrates D1), `helpers.ts` (the Worker at a
chosen clock, rounds as the script makes them), `reference.ts` (the rollup in
plain JS, counting D1), `env.d.ts`.

## Commands

| Command | What |
|:--|:--|
| `cd ui && npm ci && npm run build` | The page into `web/`. Needed before `go vet`, `go test` or `go build` on a fresh clone |
| `go test ./...` | Every Go test, including `TestSnapshotParity` (needs node) and `TestGlobalParity` (needs `npm ci` in `global/`; both skip without) |
| `go test ./internal/stats -run TestGlobalParity -count=1 -v` | Forwarder → Worker → global engine, end to end, against `Summarize` |
| `go run . serve --dir /tmp/tsum-stats-data` | Run it by hand (`--import-dir`, `--global-url` and the rest: `docs/USING.md` § Options) |
| `cd ui && npm run dev` / `npm run check` | Hot reload on :5173 proxying `/api` to :8090 / svelte-check |
| `cd ui && npm run build:global` / `npm run test:global` | The global page into `global/site/` / the global engine's tests |
| `cd global && npm ci && npm test` / `npm run typecheck` | The Worker's tests in workerd / tsc |
| `cd global && npm run dev` | The Worker locally on 127.0.0.1:8788 (`global/README.md` § Running it locally) |
| `tools/build.sh [--publish]` | Builds the page, vets and tests, five binaries, archives and the pin into `build/<version>/`, copies the pin to `tsum-stats.txt`; `--publish` makes the GitHub release |
| `node tools/codemap-check.js` | Checks this file against the tree |
| Releases | The GAP Devkit (`../tools/devkit`), cards **Tsum Tsum Stats** and **Tsum Tsum global stats**: read `../tools/DEPLOYMENTS.md` first. `tools/build.sh --publish` and `global/deploy.sh` only without the Devkit |

## Where a name lives

| Name | Defined in |
|:--|:--|
| Commands `serve`, `snapshot`, `web export`, `update`; `siteURL`, `version`, every flag | `main.go`; `updateURL`, `selfUpdate` in `update.go`; `dataDir` in `launch.go` |
| `Config`, `StarterHook`, `Register`, the `/api/stats` routes, `TopicDevices` / `TopicRounds` / `TopicImports` | `internal/stats/server.go`; `TopicPublish` in `publish.go`, `TopicGlobal` in `global.go`; the page side `ui/src/lib/realtime.js`, `App.svelte` |
| `Round`, `OwnedTsum`, `roundColumns`; the `ts_*` tables | `internal/stats/store.go`; `internal/stats/schema.go` |
| `Filter`, `ParseFilter`, `RoundsPage`; `Summary`, `Summarize`, `itemBits`; `TsumDetail`, `DescribeTsum` | `internal/stats/queries.go`; `summary.go`; `tsum.go` |
| `Events`, `Device`, `LiveRound`; `Importer`; `Puller`, `FindADB`, `InstallADB` | `internal/stats/events.go`; `importer.go`; `stats/adb.go`, `adb_install.go` |
| `ExportSnapshot`, `SnapshotFormat`; `Publisher`, `GitHub`; `Contributor`, `GlobalRecord`, `RoundBatch`, `DefaultGlobalURL` | `internal/stats/snapshot.go`; `publish.go`, `github.go`; `global.go` |
| `SiteFS`, `Overlay`, `Manifest`, `ExportSite`, `Themes`, `themeOrder` | `internal/stats/site.go` |
| `Starter`, `Mount`; `Watcher`; `observe` / `decide` / `record`, `WatchLimits`; `Emulator`, `EmuInstance`, `mapSerial`; `Updater` | `internal/starter/starter.go`; `watch.go`; `watchpolicy.go`; `emulators.go`; `starter/update.go` |
| `api()`, `IMAGE_URL`; `isSnapshot`; `isGlobal` | `ui/src/lib/util.js`; `snapshot/client.js`; `global/client.js` |
| `parseFilter`, `parseTime`, `sqlTime`, `itemCost`, `histBounds`, `bucketOf` (the global engine reuses them; the Worker imports `parseTime` and `sqlTime`) | `ui/src/lib/snapshot/engine.js` |
| `decodePart`, `cutCell` (an outlier range on a cell's bins), `THEMES` (the global site's theme list) | `ui/src/lib/global/engine.js` |
| `aggregate`; `CELLS`; `CELL_COLUMNS`; `Run`; `limits` | `global/src/ingest.ts`; `rollup.ts`; `parts.ts`; `run.ts`; `env.ts` |

## Adding something -- what a change has to touch

| Adding | Touch, in this order | Then run |
|:--|:--|:--|
| a figure or field in an `/api/stats` answer | `internal/stats/summary.go` (or `queries.go`, `tsum.go`) → `ui/src/lib/snapshot/engine.js` → `ui/src/lib/global/engine.js`, or hide it on the global site; a sum the cells lack is a new cell column everywhere at once (`docs/INTERNALS.md` § The global site, "Changing a query") → the section that shows it → `docs/USING.md` if a player sees it | `go test ./internal/stats` (both parity tests), `npm run test:global` |
| a new `/api/stats` route | its handler in `registerRoutes`, `internal/stats/server.go` → a `case` in the snapshot engine's and the global engine's route switch (an empty answer where it has no meaning) → cases in `snapshot_test.go` and, when the global site answers it, `global_parity_test.go` | as above |
| a change to the **published global format** or the upload | `global/CONTRACT.md` first → the Worker (`global/src/`, a new file in `global/migrations/` for D1) → the global engine (`decodePart`) → `global/test/reference.ts` and the parity fixture → the forwarder (`internal/stats/global.go`) if the upload changed | `cd global && npm test`, `npm run test:global`, `TestGlobalParity` |
| a column the script's stats CSV gained | `csv.go` (`parseStatsCSV`) → `Round` and `roundColumns` in `store.go` → `schema.go` (and a migration for existing databases) → `snapshot.go` and the snapshot engine if the page reads it → `global/CONTRACT.md` §1.2 and `global/src/records.ts` if the global site keeps it | `go test ./...` |
| a realtime topic | a `Topic*` constant and its sends in `internal/stats/` → its subscription in `App.svelte` → `docs/INTERNALS.md` § The server | `TestPageSubscribesToEveryTopic` |
| a new Tsum | `ui/public/data/catalog.json`, regenerated by `stats-catalog.js` (External trees) → commit, push, deploy the Worker (the Devkit card) → `POST /api/v1/admin/rebuild` to bring its days in (`global/README.md`) | `npm test` in `global/` |
| a built-in theme | `ui/public/themes/<name>.css` with an `@name` line → `themeOrder` in `internal/stats/site.go` → `THEMES` in `ui/src/lib/global/engine.js` → `docs/USING.md` § Themes | `go test ./internal/stats` |
| a Worker tunable | `wrangler.jsonc` `vars` (deployed, Paid) → its fallback in `global/src/env.ts` and `test/tunables.json` (Free) → `global/README.md` § Tunables, and `global/CONTRACT.md` §2.6 when it is a budget | `npm test`, `npm run typecheck` |
| a starter action or route | `internal/starter/actions.go` (or a route in `starter.go`) → `internal/starter/site/app.js` → `docs/USING.md` § The service starter | `go test ./internal/starter` |
| a new source file, test, document or tool | a row or mention here | `node tools/codemap-check.js` |
| a **release** | `VERSION` (commit "Bump to x.y") → `tools/build.sh --publish` → commit the rewritten `tsum-stats.txt` ("Pin for x.y"). The Devkit's **Tsum Tsum Stats** card does the build and release; deploy the global Worker first when the release changes what the forwarder sends | `go test ./...` (the build runs it) |

## External trees

<!-- map:external -->

Paths here are in other checkouts beside this one, under `~/Projects/GAP/`.

| Tree | Path | Relationship |
|:--|:--|:--|
| **tsum-tsum-script** | `../tsum-tsum-script` | Writes what this imports: `app.gap.Tsum/src/roundStats.ts` (the stats CSV, the round's UUIDv7 id), `tsumList.ts` (`tsum_list_*.csv`), the live events (`EVENTS.md` there). `roundShare.ts` is the `gap.round-stats/1` upload format the forwarder and Worker reuse (`global/CONTRACT.md` §1). `starter/build-starter.sh` copies `tsum-stats.txt` into the starter bundle (`MIN_STATS` is the oldest version it accepts); its `starter/device/gap-service.sh` is what `internal/starter` drives |
| **general-automation-app** | `../general-automation-app` | GAP, the host app: dials the events listener, keeps the device files the importer pulls. Its `tools/stats-catalog.js` regenerates `ui/public/data/catalog.json` from the script's `tsums.dat` and `../tools/tsum_box_counts.json` |
| **tsum-tsum-website** | `../tsum-tsum-website` | The public site: its felt design (`src/css/felt.css`, mirrored by the starter page) and the links to the global site (`global/WEBSITE-LINKS.md`) |
| **tools** (GAP Devkit) | `../tools` | `DEPLOYMENTS.md` § Tsum Tsum Stats and § Tsum Tsum global stats: the cards that release the binaries (`deploy/components.mjs`, `tsum-stats`) and deploy the Worker (`deploy/tsumglobal.mjs`), on the personal Cloudflare account only. The Devkit itself is `devkit/` |
| **tsum-tsum-catalogue** | GitHub Pages | The script catalogue the starter offers as a source (`sourceURL`, `internal/starter/device.go`) |

## Keeping this file true

`node tools/codemap-check.js` checks that every path named here exists (build
output such as `web/` and `global/site/` excepted), and that every Go file,
`ui/src` and `ui/tests` file, `global/src` and `global/test` file, starter page
file, document under `docs/` and `global/`, and tool is mentioned. A basename
shared by two of them (`engine.js`, `adb.go`, `update.go`) has to carry its
folder. A section that talks in another tree's paths marks itself
`<!-- map:external -->` and is skipped until the next heading.

A row here is a clause, not a paragraph: the reasoning belongs in the file's
header comment or the document the row points at.
