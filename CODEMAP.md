# CODEMAP

Which file owns what, and which document answers a question. Tsum Tsum Stats is
the player's local stats website (one Go binary, PocketBase as a library) plus
the global stats site. Not to be confused with **round stats**, the
`stats_*.csv` the Tsum script writes (`../tsum-tsum-script`, `roundShare.ts`),
which this app imports.

```
tsum-stats/
├── main.go, launch.go, update.go  the binary: commands and flags, double-click launch, self-update
├── internal/stats/    the server: tables, CSV importer, event listener, /api/stats routes, snapshot, Share, Contribute
├── internal/starter/  the script's service starter as a website (--starter), page in site/
├── ui/                the page (Svelte 5 + d3), built into web/ (ignored) and embedded
├── global/            the global stats Worker (tsum-global: D1, R2, hourly rollup) on tsum-stats.gapscripts.app
├── docs/              the manual (USING.md) and how it is built (INTERNALS.md)
├── tools/build.sh     five binaries and the pin, into build/<version>/ (ignored)
└── VERSION, tsum-stats.txt, install.sh, tsum-stats.cmd   version, update pin, installers
```

## Which document answers it

| Question | Document |
|:--|:--|
| What it is, how to install and run it | `README.md` |
| Every flag, getting data in, what each figure means, snapshots, Share, Contribute, themes, `--web-dir` | `docs/USING.md` |
| The pieces and which file owns each: server, starter, queries, snapshot engine, global site, catalog, build | `docs/INTERNALS.md` |
| Changing a figure (server, snapshot engine, global engine, in that order) | `docs/INTERNALS.md` § The global site, *Changing a query* |
| The global Worker: its files, tests, local run, admin routes, Workers limits, tunables | `global/README.md` |
| Upload format, Worker API, write budget, D1 schema, hourly job, R2 layout, published files, forwarder | `global/CONTRACT.md` (change a shape here first) |
| The global site's Cloudflare account, token, secrets, deploy by hand, free-tier limits | `global/CLOUDFLARE-SETUP.md` |
| Links to add on `../tsum-tsum-website` for the global site | `global/WEBSITE-LINKS.md` |
| Releasing either part | `../tools/DEPLOYMENTS.md` § Tsum Tsum Stats, § Tsum Tsum global stats |

## Finding a name

| Name | Where |
|:--|:--|
| Commands `serve`, `snapshot`, `web export`, `update`; `siteURL`, `updateURL`, `--global-url` | `main.go`; data dir and launch `launch.go`; `selfUpdate` `update.go` |
| `Config`, `StarterHook`, `/api/stats/*` routes, realtime topics `ts/*` | `internal/stats/server.go`; page side `ui/src/lib/realtime.js`, `ui/src/App.svelte` |
| Tables (`ts_rounds`, `ts_global_sent`, ...) and indexes | `internal/stats/schema.go`; `Round` in `store.go` |
| Live rounds over TCP (`Device`, `LiveRound`) | `internal/stats/events.go` |
| `stats_*.csv` / `tsum_list_*.csv` import (`Importer`) | `internal/stats/importer.go`, `csv.go` |
| Import from devices over adb (`Puller`, `InstallADB`) | `internal/stats/adb.go`, `adb_install.go` |
| `Filter`, rounds page; `Summary`; `TsumDetail` (Tsum page) | `internal/stats/queries.go`; `summary.go`; `tsum.go` |
| Snapshot (`ExportSnapshot`) and its in-browser engine | `internal/stats/snapshot.go`; `ui/src/lib/snapshot/` (`engine.js`, parity: `TestSnapshotParity`) |
| Share to GitHub Pages (`Publisher`) | `internal/stats/publish.go`, `github.go` |
| Contribute, the forwarder (`Contributor`, `GlobalRecord`) | `internal/stats/global.go`; `ui/src/components/ContributeDialog.svelte` |
| `--web-dir` override, `ExportSite` | `internal/stats/site.go` |
| Service starter: adb, emulators (`Emulator`), actions, watch mode (`observe`/`decide`) | `internal/starter/` (`adb.go`, `emulators.go`, `emu_*.go`, `actions.go`, `watch.go`, `watchpolicy.go`); page `internal/starter/site/` |
| `api()`: server, snapshot or global answer | `ui/src/lib/util.js`; `isSnapshot` in `ui/src/lib/snapshot/client.js`, `isGlobal` in `ui/src/lib/global/client.js` |
| Pages: Stats, Tsum, Catalog, Help | `ui/src/sections/` (`Stats.svelte`, `Tsum.svelte`, `Catalog.svelte`, `Help.svelte`, subfolders) |
| Charts, legends, tooltips | `ui/src/lib/charts.js`; `ui/src/components/Legend.svelte`, `Tip.svelte` |
| Page-wide state (catalog, devices, toasts, theme) | `ui/src/lib/ui.svelte.js` |
| Tsum catalog (names, colours, box counts), cost to max | `ui/public/data/catalog.json` (generated outside this repo, committed); `ui/src/lib/boxes.js`, `ui/src/sections/catalog/MaxOut.svelte` |
| Themes | `ui/public/themes/*.css`; `ui/src/components/ThemePicker.svelte` |
| Global page mode (`<meta name="tsum-global">`) | `ui/src/lib/global/` (`engine.js`, `worker.js`), `GlobalNote.svelte`; tests `ui/tests/` |
| Worker routes, cron, uploads, rollup, part files, archive | `global/src/` (`index.ts`, `ingest.ts`, `records.ts`, `job.ts`, `rollup.ts`, `parts.ts`, `archive.ts`); table in `global/README.md` § Layout |
| Write budget, tunables, D1 schema | `global/src/budget.ts`; `global/wrangler.jsonc`, `global/test/tunables.json`; `global/migrations/` |
| End-to-end global parity (`TestGlobalParity`) | `internal/stats/global_parity_test.go`, `global/test/parity.test.ts`, `global/test/reference.ts` |
| Global stats Devkit card | `../tools/deploy/tsumglobal.mjs`; stats release `../tools/deploy/components.mjs` (`tsum-stats`) |

## Commands

| Command | What |
|:--|:--|
| `cd ui && npm ci && npm run build` | The page into `web/`; needed before `go vet` / `go test` on a fresh clone |
| `go test ./...` / `go run . serve --dir /tmp/tsum-stats-data` | Server tests (incl. snapshot and global parity) / run it on :8090 |
| `cd ui && npm run dev` / `npm run check` | Page with hot reload on :5173 (`/api` to :8090) / svelte-check |
| `cd ui && npm run build:global` / `npm run test:global` | The global page into `global/site/` / its engine tests |
| `cd global && npm run dev` / `npm test` / `npm run typecheck` | The Worker locally on 127.0.0.1:8788 / vitest in workerd / tsc |
| `tools/build.sh` | Five binaries and `tsum-stats.txt`, version from `VERSION` |
| Releases | The GAP Devkit (`../tools/devkit`), cards **Tsum Tsum Stats** and **Tsum Tsum global stats**: read `../tools/DEPLOYMENTS.md` first. `tools/build.sh --publish` and `global/deploy.sh` only without the Devkit |
