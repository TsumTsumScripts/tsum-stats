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

The page gets live updates from three custom realtime topics — `ts/devices`,
`ts/rounds` and `ts/imports` — none of them a collection subscription.
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
page is plain files in `internal/starter/site/`, embedded as they are, in the
website's felt design. It shares its adb with the `Puller` (`SetADB`), which
then skips its own download.

Its `/api/starter` routes run adb, so they answer only on a loopback Host and
refuse cross-origin writes. Actions stream NDJSON (`{"log"}` lines, then
`{"done"}`), with the 5-minute write deadline cleared. Every action except the
live log holds a per-device lock, since a probe would otherwise re-push the
device script mid-run. `go test ./internal/starter` drives it through a fake adb.

Updates (`update.go`): main hands the starter an `Updater` built on its own
`selfUpdate`, since only main knows `updateURL` and its binary. After an apply,
the route shuts the HTTP server down (closing the stats page's realtime stream
if it holds on), PocketBase's `Execute` closes the database, and main exits
with the launcher's `TSUM_STATS_RESTART_CODE`.

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

Help, the Data dialog, importing and the live device pills are hidden in a
snapshot; a note in the top bar says when it was taken.

## Publishing to GitHub Pages

The player-facing flow is in [USING.md](USING.md#sharing-it-on-github-pages).
The GitHub calls are in `internal/stats/github.go`; the sign-in, saved choices
and background job are in `publish.go`. `publish_test.go` runs them against an
in-memory fake of GitHub's API with git's real content hashing.

## The catalog

`ui/public/data/catalog.json` is generated from the Tsum script's portrait
library (a tool that lives with the scripts, not here) and committed, so
building the site needs nothing else. The generator also assigns each Tsum its
chart colour, keeping one once given and handing a new Tsum the next free slot;
a Tsum the catalog does not know falls back to a hue derived from its id. Box
counts come from a box-count file, and without it the counts already in the
catalog are kept.

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

## Working on the page

```
cd ui && npm install
npm run dev     # hot reload on http://localhost:5173, /api sent to tsum-stats on :8090
npm run build   # writes ../web, which go build embeds
npm run check   # svelte-check
```

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
- the snapshot engine against the server's own queries.
