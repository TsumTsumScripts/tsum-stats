# The Tsum stats site

**A local website for a player's own Tsum Tsum data: every round played, and
which Tsums they own.** One binary, `tsum-stats`, serves it on
`http://127.0.0.1:8090`. It is its own program: a player downloads the binary and runs it. See [Running it](#running-it).

It has three sections:

- **Stats.** Coin efficiency first: KPI tiles (coins per second, average,
  median, lowest, highest, spread), then charts and two tables. All of it can
  be filtered by Tsum, any number of devices, date range (the last 7 days by default), outlier
  ranges for score, coins and medals, and game build. Incomplete rounds are left out. See [The Stats page](#the-stats-page).
- **Catalog.** Every Tsum in the game a device plays, with what that
  device's latest Tsum List export says about each: level and cap, skill and
  max, month acquired, and acquisition order. The Device menu lists the devices
  with an export (a device that has one for both games appears once per game);
  there is no separate INTL/JP switch, since a device's export knows its game. Shown as cards or a list, with
  names in English, Japanese or both, and sorted by several keys at once (each
  ascending or descending). Sort, layout and name language are saved in the
  browser (`localStorage`, `tsum-stats.catalog`); the link carries only the filters.
  Each Tsum also shows the skill boxes left to max it and their cost, and a
  **Cost to max** panel totals them for the Tsums shown. See
  [Cost to max](#cost-to-max).
- **Help.** How to get data in: the address to paste into the app's Script
  events (the port is read from `/api/stats/status`), Record round stats and
  **Import from devices**, and the Tsum List
  chore. Screenshots are in
  `ui/public/img/help/`. `status` carries `lanAddrs`, this computer's network
  addresses, because a browser cannot find them itself.

## The Stats page

**Coin efficiency is coins per second of play:** total coins over total
round time, counting only rounds that have both. The rail's **Primary stat**
switch picks what every figure and chart count:
**Base coins** (before the coin bonus, the default), **Final coins**
(`coins=final` in the link and the `/api/stats/summary` and `/api/stats/rounds`
queries) or **Medals** (`coins=medals`), which also keeps only rounds that
earned medals (`medals > 0`) and relabels the page. Coins per hour is the same
rate × 3600. The spread figures (quartiles, median, 90th percentile) are
nearest-rank values, so each is a real round's coins.

**Incomplete rounds are left out** of every figure and both tables: a round
with no Tsum, or no score, base coins, final coins or time. Medals count too,
but only for a medal Tsum: one that has earned medals in any round
(`medalTsumsSQL` in `queries.go`; a snapshot lists them as the manifest's
`medalTsums`). The script writes 0 for a round without medals, so a blank is
an unread figure, but older rows left it blank for Tsums that never earn any.
The rail's **Include incomplete rounds** box (`incomplete=1`) keeps them.

**Outliers.** The rail's Outliers box sets a lowest and highest score
(`minScore`/`maxScore`), coins (`minCoins`/`maxCoins`) and medals
(`minMedals`/`maxMedals`); rounds outside a set bound are left out. The coin
range is base or final coins even in Medals mode, and the medal range only
judges medal Tsums' rounds, so it does not drop other Tsums' 0-medal rounds.

With coins as the primary stat, the summary also carries `medals`: the same
totals and per-Tsum figures for medals, over the rounds that earned any. They
fill the medal KPI tiles and the Tsum table's medal columns, which drop out in
Medals mode because the coin columns already show medals.

**The time range** opens on the last 7 days. `days` in the link is `7` or
`30` (rolling windows that end today), `all`, or absent when fixed From/To
dates are set. A link with dates but no `days` keeps its dates.

**Picking Tsums.** `tsum` in the link is a comma list. Clicking a Tsum in a
chart or table focuses on it. Ctrl, ⌘ or Shift with the click adds it to the
selection instead. The rail's Tsums box adds each Tsum it matches. While any
Tsum is picked, a sticky bar over the charts shows which ones, with three ways
out:
- **✕ All Tsums**, or Esc;
- **← Back**, which restores the previous selection. Each change of Tsums is a
  browser history entry, so the browser's Back does the same;
- × on a Tsum, which takes it out of a comparison.

**Head to head** appears once two or more Tsums are picked:
- A scorecard puts each figure in a row and each Tsum in a column. A bar under
  each figure is scaled to the row's largest, and a ★ marks the best. Lower
  wins for spread and round time; Rounds and Total are not scored. The header
  counts each Tsum's wins.
- A line per Tsum per day shows the primary stat per second, the average, the
  total or the number of rounds.

To compare Tsums from the Tsum table, tick them and press *Compare ticked*. The
summary's `dailyTsums` rows carry `avgCoins` and `coinsPerSec` for the chart.

Each chart and table panel's ⤢ button blows it up to fill the window; Esc
closes it. A table's pager sticks to the bottom of the window while the table is
on screen. Column choices (and the Tsum table's sort and page size) are kept per
browser in `localStorage` under `tsum-stats.tables`.

| Panel | Views |
|:--|:--|
| Head to head | Only with 2+ Tsums picked: a scorecard with the best in each row marked, and a per-day line per Tsum |
| Coin efficiency by Tsum | Ranked bars (coins/s, average, median or best); Spread, a box plot of the 12 most played; Bubbles, average coins × coins/s sized by rounds |
| Coins per day | Stacked by Tsum (top 7 + Other); coins/s; average with the day's range |
| Where the coins come from | Donut by Tsum (top 8 + Other), or a sunburst of game › Tsum › items used; by coins, rounds or time |
| By hour of day | Radial bars in the viewer's time: coins/s, average or rounds |
| By items used | Radial rings for the six most played item sets |
| Coins per round | Histogram stacked by Tsum, with median, average and P90 lines |
| Tsums | Table: every statistic per Tsum; search, sort, choose columns, tick rows to compare |
| Rounds | Table: one page of rounds, sorted and paged by the server |

How it is put together:

- **Views** are remembered per browser (`localStorage`), not put in the
  link. The filters, the rounds sort and the page are in the link. The top
  bar's section buttons return to each section's last link.
- **Tables** use TanStack Table's framework-free core (`@tanstack/table-core`
  v8, MIT), wrapped by `ui/src/components/DataTable.svelte`.
  The Tsums table sorts and pages in the page. The Rounds table hands both to
  the server.
- **Items used** come from the round's settings (`bonusCoin`, `bonus5to4`
  …). Rounds recorded before those settings existed show as *Unknown*.
- **Outliers:** the box plot's scale stops past the highest P90 (the highest
  round is marked). The histogram's last bucket gathers every round from
  Q3 + 1.5 × IQR up (`cap` in the summary).
- **Filters and navigation stay on screen.** At 1180 px and wider they are a
  sticky side column with a jump menu. Narrower, they are a bar under the top
  bar: chips for the active filters, a *Filters* button that drops the form
  down, and the jump menu. The top bar is sticky everywhere.

**Every Tsum has its own colour,** `color` in `ui/public/data/catalog.json`. Charts,
legends, tables and the Catalog's cards all use it. the catalog generator
hands out colours: golden-angle hues in OKLCH, three lightness and two chroma
steps, kept in the band that reads on the dark panels. A colour, once given,
is kept, and a new Tsum gets the next slot (`slots`). A Tsum the catalog does
not know gets a hue from its id.

With hundreds of Tsums some colours are close. So a colour never stands alone:
charts show the portrait where the mark has room, and a named legend or
tooltip everywhere else.

## Why PocketBase, and why a custom build of it

The server is PocketBase used as a Go library (`main.go`). It
provides:

- the HTTP server;
- SQLite, pure Go, so every target cross-compiles from one machine;
- realtime over SSE (`/api/realtime`);
- the admin UI at `/_/`.

Stock PocketBase could not do the job. Its JS hooks can make outbound HTTP
calls but cannot listen on a TCP socket, and the app's event dialer speaks raw
newline-delimited JSON over TCP ([EVENTS.md](EVENTS.md)). Rather than change
the app's transport, the listener is a goroutine in the same binary. The site
is embedded with `go:embed`, so the download is a single file. A player can
still change it: see [Changing the site](#changing-the-site).

**The data is in plain SQL tables, not PocketBase collections**
(`internal/stats/schema.go`). A collection's number field cannot be NULL, and
an unread score has to stay NULL: stored as 0, it would drag every average
down. The tables are created at bootstrap with `IF NOT EXISTS`. The page gets
live updates from three custom realtime topics:

| Topic | Carries |
|:--|:--|
| `ts/devices` | each device's current state |
| `ts/rounds` | every round stored from an event |
| `ts/imports` | the result of each import |

None of these goes through a collection subscription.

## Where the data comes from

| Source | How | Code |
|:--|:--|:--|
| Live rounds | A device dials `127.0.0.1:21025` (`--events-addr`). An emulator on the same PC reaches that as `10.0.2.2:21025`. `round.end` becomes a row. `--events-connect` dials a device's own listener through `adb forward` instead | `internal/stats/events.go` |
| `stats_*.csv` | Found under `--import-dir` folders (`--import-dir`) and under `~/Documents/MuMuSharedFolder` when it exists. Rescanned every 10 s, skipping files whose size and mtime have not changed | `internal/stats/importer.go`, `csv.go` |
| `tsum_list_*.csv` | Found the same way. The script rewrites the file after every page, so a re-import replaces the list. The newest stamp per device and build is the one shown | same |
| Dropped or picked files | `POST /api/stats/import` | `server.go` |
| Help › Import from devices | `GET /api/stats/adb/devices` dials the usual emulator ports and lists adb's devices; `POST /api/stats/adb/import` pulls both CSV kinds from `--device-storage` into `<first --import-dir>/<serial>/` with `adb pull -a`, then imports them at once | `internal/stats/adb.go` |

**A live round and its CSV row are one row.** They share the round's UUIDv7,
which is the `id` on both the `round.*` events and the CSV row. An event
inserts the row and records the device. A later CSV import overwrites every
figure but keeps the device. An event arriving after its CSV row changes
nothing.

`build` (INTL/JP) is on every `round.*` event and in the Tsum List CSV. For
exports older than that column, the site guesses the build from the names:
Japanese characters mean JP.

The Tsum List CSV's `device` column is the script's `getDeviceName()`, the
same name the device's events carry, so a list and its rounds are filed under
one device. A CSV without one (older exports, or an app without
`getDeviceName()`) is filed under the folder it was found in below an import
folder (`collected/<serial>/...`, one emulator), else *Unknown device*. After a
device is updated and exports again, it appears under its real name as well;
the old serial entry stays until its lists are deleted.

## Scaling

The page never holds more than one page of rounds. The server filters, sorts,
pages and aggregates:

- `/api/stats/rounds` returns one page. Its sort is one of a fixed list of
  columns, with `NULLS LAST` and the id as a tie-break, so paging is stable.
- `/api/stats/summary` returns everything above the tables as `GROUP BY`
  results:
  - the KPIs;
  - per day and per hour, bucketed in the viewer's time zone through `tz`;
  - per Tsum, per day × Tsum, per game × Tsum × item set;
  - the coin histogram.

  The charts draw only these, so 100k rounds is still a few thousand numbers.
- The indexes are `(played_at, round_id)`, `(tsum, played_at)`,
  `(build, played_at)`, `(score)` and `(final_coins)`.

Measured on 50,000 rounds:

| Request | Time |
|:--|:--|
| A table page, any sort | 1–12 ms |
| A deep page (offset 45,000) | 8 ms |
| Unfiltered summary | about 400 ms |
| Summary for one Tsum of ten | about 70 ms |

The summary's queries run at once. The slowest are the two that rank every
round's coins for the median and quartiles (about 0.2 s each unfiltered).

## Publishing a snapshot

`tsum-stats snapshot DIR` writes the site and its data as plain files, for a
host that only serves files (GitHub Pages, Netlify, any web server). The
result is read-only and does not update by itself; run it again to refresh.

```
tsum-stats snapshot ./my-stats --dir path/to/stats/data
tsum-stats snapshot ./my-stats --devices keep --no-collection
```

| Flag | Does |
|:--|:--|
| `--devices` | How device names appear: `anonymous` (the default: *Device 1*, *Device 2*), `keep`, or `hide`. A public page shows them to anyone |
| `--no-collection` | Leaves out the Tsum lists, which say which Tsums the player owns |

**Layout.** The built site, plus `data/snapshot/`:

| File | Holds |
|:--|:--|
| `manifest.json` | Format, when it was taken, the months (rounds, first/last time, a hash each), every played Tsum with its count, the devices (named as `--devices` says), the theme list, and which `owned-<n>.json` file holds each device's Tsum list per game |
| `rounds-YYYY-MM.json` | One UTC month of rounds |
| `owned-<n>.json` | One device's newest Tsum list for one game (with `--devices hide`, only the newest per game) |

A month file is column by column: each figure is one array, repeated text
(Tsum, build, device) is a small dictionary the columns index into, and the
time is the gap in seconds after the round before. Rounds are in time order.
`null` is a figure the script could not read. Settings, round ids and
anything else the page does not show are left out.

**Why months.** A finished month never changes, so a host caches it for good,
and a repo grows by the current month per publish, not by the whole history.
Unchanged files are not rewritten (the command prints how many it wrote), so
DIR can be a git checkout that is updated in place. The page loads only the
months a filter's date range touches: its default 7 days is one or two files.

**In the page.** `index.html` gets `<meta name="tsum-snapshot">`; that is how the
page knows. `api()` then sends every route to `ui/src/lib/snapshot/engine.js`
in a Web Worker instead of the server. The engine reproduces the server's
filters, sorts and summary; `go test ./internal/stats` runs both on the same
rounds (timezones, ties, empty results, junk input) and fails if they differ.
Change a query in `queries.go` or `summary.go` and the engine has to change
with it. Help, the Data dialog, importing and the live device pills are
hidden; a note in the top bar says when the snapshot was taken.

### Sharing it on GitHub Pages

The top bar's **Share** button publishes a snapshot to the player's own
GitHub Pages site, at `https://<account>.github.io/tsum-stats/`. It needs no
git and no command line:

1. **Sign in.** Either of two ways; Help section 4 walks the player through
   the second, which every build has:
   - *GitHub's device flow* (only a build with an OAuth app, below): the dialog
     shows a short code and an *Open GitHub* button; the player types the code
     there and the dialog carries on by itself.
   - *A token the player makes*: a link opens GitHub's token page with
     `public_repo` and the name filled in; the player generates it and pastes
     it into the dialog (`POST /publish/token`, `Publisher.SaveToken`, which
     checks it against GitHub first). No OAuth app is needed, and the player's
     password never reaches Tsum Tsum Stats either way.
2. **Choose.** Device names (hidden as *Device 1*, not shown, or shown), and
   whether the Tsum lists go on the page. The player ticks *I understand that
   anyone with the link can see this page* before Publish is enabled.
3. **Publish.** Tsum Tsum Stats exports the snapshot, creates the public repo
   `tsum-stats` if it is missing, uploads what changed as **one commit**
   through GitHub's API, and turns Pages on. Later presses of **Update my
   page** upload only the changed files (each is compared by git's own hash
   first): usually the current month and the manifest, which records when the
   snapshot was taken. Months that no longer have rounds are removed.

The first time, GitHub takes a minute or two before the page answers. The
dialog says so.

What it will and will not touch:

- The token asks for the `public_repo` scope: it can create and write to
  public repos, nothing else. It is saved in `github.json` in the data folder
  (owner-readable only) and forgotten by **Sign out**. The state the page
  reads never contains it.
- A repo that already exists is only written to when it holds a published
  snapshot (or nothing but the README GitHub adds). Any other repo is refused
  (*that repository already exists and holds something else*), so a publish
  can never delete someone's other files. `README.md`, `LICENSE`, `CNAME` and
  `.gitignore` are always left alone.
- Signing out, or deleting `github.json`, leaves the published page up: it is
  the player's repo, and removing it is done on github.com.

**Optional setup for a build.** The code sign-in needs a GitHub OAuth app
owned by the project (not per player, and it has no secret). Without one the
dialog offers only the token steps:

1. github.com › Settings › Developer settings › OAuth Apps › New OAuth App.
   Name: *Tsum Tsum Stats*. Homepage and callback URL: anything (the project's page).
2. Tick **Enable Device Flow**, then register it.
3. Build with its Client ID: `TSUM_GITHUB_CLIENT_ID=... tools/build.sh`
   (or run with `--github-client-id`).

To publish from a machine with no browser, or to try it without the app, give
a personal access token with the `public_repo` scope instead:
`TSUM_GITHUB_TOKEN=... tsum-stats serve` (or `--github-token`, which shows in
the process list). The dialog then skips the sign-in.

The GitHub calls are in `internal/stats/github.go` and the sign-in, saved
choices and background job in `publish.go`. `publish_test.go` runs them
against an in-memory fake of GitHub's API with git's real content hashing.

Sizes and speed, measured on 100,000 synthetic rounds (about a year of heavy
play; random figures compress worse than real ones):

| | |
|:--|:--|
| Files | 12 months, 4.7 MB raw, 1.4 MB compressed; real data was about 13 bytes a round compressed |
| The default 7 days, first load | 25 ms to compute; 1 or 2 small files |
| All time, all 12 months | 230 ms to load and parse, then about 200 ms per summary |
| A table page, sorted by anything | 15–60 ms |
| Memory with every month loaded | about 50 MB |

## The catalog

`ui/public/data/catalog.json` lists every Tsum with its global and its JP name. It is
generated from the Tsum script's portrait library (a tool that lives with the
scripts, not here) and committed, so building the site needs nothing else.

A blank name means that build does not have the Tsum. The INTL/JP toggle
filters on this. 36 rows have neither name and are hidden.

Tsum art comes from `https://tsum-assets.gapapp.app/tsums/block_<id>_l.png`,
where `<id>` is the catalog id (the CSVs' `tsum` column). While an image is
missing, its initials show instead. The CDN refuses non-browser user agents,
so `curl` without `-A` gets a 404 for a URL that works in the page.

### Cost to max

`boxes` in the catalog is how many boxes each skill level takes: `boxes[0]`
gets the Tsum, `boxes[i]` takes skill *i* to *i*+1. `medal: true` marks a medal
Tsum. The generator reads them from a box-count file; without it the counts already
in the catalog are kept.

Boxes left (`ui/src/lib/boxes.js`): a Tsum not owned needs every box; an owned
one needs the rest of its current level, less the Tsum List's `skill_progress`
(the percent through that level; a list from before that column counts as 0%),
plus every level above. A box is 30,000 coins, or 10,000 medals for a medal
Tsum.

The panel (`ui/src/sections/catalog/MaxOut.svelte`) totals coins and medals
over the Tsums shown (build, Owned filter and search), takes away what the
player types as on hand, and divides by their pace: this build's coins (after
the coin bonus) and medals per day over the last 7 or 30 days or every round,
from `/api/stats/summary`. Every device's rounds count, so devices playing other
accounts make the pace too fast. The chart draws each one's share still to
earn down to its finish date. Pace window and on-hand figures are saved in the
browser (`tsum-stats.maxout`).

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

## Changing the site

`--web-dir DIR` puts files on disk in front of the embedded site, path by
path (`internal/stats/site.go`):

- `DIR/assets/app.css` is served in place of the built-in `assets/app.css`.
  The build keeps these names fixed (`assets/app.js`, `assets/app.css`).
- A file not in `DIR` still comes from the binary, so one edited file needs no
  copy of the rest.
- Files are read on every request and sent with `Cache-Control: no-cache`, so
  an edit shows on a browser refresh with no restart.
- `DIR` is created with a `README.txt` when missing.

**`DIR/override.json` lists the tsum-stats versions the files were written
for.** A copy in `DIR` shadows the built-in file, and a newer server may need
the newer file (a changed API, a renamed element). So the whole folder is
ignored unless the running version is listed:

```json
{"supports": ["0.2.0", "0.3.*"]}
```

- An entry is an exact version, a prefix ending in `*`, or `*` for any.
- A source build (`dev`) accepts any manifest.
- The manifest is re-read on every request, so a fix applies on refresh.

Themes in `DIR/themes/` are the exception: they are served and listed
whatever the manifest says, since a theme only sets tokens and cannot break a
newer page. See [Themes](#themes).

When the folder is ignored, the page shows why in a toast and in the Data
dialog (`override` in `/api/stats/status`), and the server logs it once. A folder
holding only the README is unused, not a mismatch, and says nothing.

`tsum-stats web export DIR` copies the embedded site out as a starting point,
with an `override.json` listing the exporting version. It keeps files already
there unless given `--force`. After an update, compare your copies with a fresh
export before adding the new version to `supports`.

## Themes

**A theme is a CSS file in `themes/` that overrides the colour and font
tokens on `:root`, and nothing else.** The top bar's Theme menu lists them.
The choice is saved in the browser (`localStorage`, `tsum-stats.theme`) and
applied in `index.html` before the page draws.

- **Built in:** `ui/public/themes/`. *Tsum Night*, the default, is the
  tokens in `ui/src/styles.css` and has no file. *Ember* is a warm dark theme. Besides tokens it restyles
  classes (panels, toggles, KPI tiles, the logo badge), so it may need a touch-up
  when the page's markup changes. It meets WCAG AA contrast (4.5:1 text, 3:1
  borders and focus rings), checked with the glass cards over the brightest
  glow; keep that if you change its colours. Its fonts come from Google Fonts,
  with system fonts offline.
- **Halloween:** a haunted-manor look from the October event's art (`gameres`
  event 144, "Villains Halloween"; Pumpkin King and Vampire Teddy from
  `gameres_jp`). Unlike *Ember* it is not glass cards: dark stone panels with
  scroll corners, leaf-cut buttons, ghost-fire green toggles, a green web under
  each title, the event's six pumpkins as nav and step markers, and a fixed
  night scene (moon, stars, forest, fog, two bats; the venue's monuments beside
  the page on screens over 1650px). The art is embedded once as `--i-*` custom
  properties at the top of the file; it is about 320 KB. Text meets WCAG AA.
  Cinzel and Alegreya Sans come from Google Fonts. Motion stops for people who
  prefer reduced motion. A maxed Tsum's portrait in the Catalog pulses
  green to violet.
- **A player's own:** `--web-dir DIR`, then `DIR/themes/mine.css` . `/api/stats/themes` lists both; a file
  with a built-in one's name replaces it. A file starting with `_` is left out.
- **Name:** `/* @name My theme */` near the top, else the file name.
- **Start from:** `themes/daylight.css`, which sets every token.
  `deep-sea.css` shows a theme that sets only what it changes.

A theme's `<link>` loads *before* the page's own styles, so a theme that
restyles classes (as `ember.css` does) must start each rule with `:root` for the
extra specificity; token overrides do not need it.

The base tokens are declared on `:where(:root)`, which has no specificity, so
a theme's `:root` wins wherever its `<link>` lands. Charts read the tokens
when they draw, and redraw when the theme changes.

| Tokens | Colour |
|:--|:--|
| `--font-body`, `--font-display`, `--radius` | Text and headings; panel corners |
| `--bg`, `--bg-top`, `--bg-mid`, `--bg-bottom`, `--dots`, `--noise` | The page background: a gradient, a dot grid and a noise texture |
| `--topbar-bg`, `--hairline`, `--backdrop` | The sticky top bar; the dimming behind dialogs and expanded panels |
| `--panel`, `--panel-hi`, `--panel-top`, `--panel-bottom`, `--panel-edge`, `--seam` | Panels and buttons: fill, gradient, border, the stitched inner seam |
| `--well`, `--cell`, `--sticky-bg`, `--tip-bg` | Inputs and toggles; table cells; the sticky pager; tooltips |
| `--ink`, `--muted`, `--faint` | Text, from strongest to faintest |
| `--drop`, `--press`, `--lift`, `--inset`, `--float` | Shadows: under panels, pressed buttons, top highlight, sunken wells, popovers |
| `--accent-a`, `--accent-b`, `--accent-edge`, `--accent-shadow`, `--accent-ink` | Pressed toggles, primary buttons, progress, focus rings |
| `--badge-a`, `--badge-b`, `--hero-top` | The logo badge and Help's step numbers; the hero KPI tile |
| `--score`, `--coin`, `--medal` (each with `-shadow`), `--good`, `--bad` | Figures by kind; online dots |
| `--axis-line`, `--grid-line`, `--chart-rule`, `--chart-track` | Chart axes, gridlines, the hover rule, the empty part of radial bars |
| `--chart-other`, `--build-intl`, `--build-jp`, `--build-none`, `--avatar-a`, `--avatar-b` | "Other" slices; the sunburst's game ring; a portrait's backing |

Tsums keep their own colours (`color` in the catalog) in every theme.

**Maxed Tsums** (level 50 and full skill) get a `maxed` class in the Catalog,
so a theme can restyle them completely. Hooks, all optional:

| Hook | Where |
|:--|:--|
| `--maxed-a`, `--maxed-b`, `--maxed-glow`, `--maxed-ink` | Tokens: main and highlight colour, glow, text on the badge. |
| `.card.maxed` | The card (Cards layout). |
| `.card.maxed .maxed-shine` | A full-card overlay for sheens and sparkles; ignores the pointer. |
| `.maxed-badge` | An empty mark: a corner badge in a card, inline after the name in a list. Fill it with `::before`/`::after` or a background. |
| `.tsum-list tr.maxed`, `tr.maxed td` | The list row (List layout). |

Start each rule with `:root` (see above). The default is a gold border, glow,
sheen and star badge.

## Working on the page

```
cd ui && npm install
npm run dev     # hot reload on http://localhost:5173, /api sent to tsum-stats on :8090
npm run build   # writes ../web, which go build embeds
npm run check   # svelte-check
```

The page is Svelte 5 (`ui/src/`, see CODEMAP.md). Markup lives in `.svelte`
files. The d3 charts in `lib/charts.js` draw the SVG; their legends and
tooltips come back as data that `Legend.svelte` and `Tip.svelte` render.

## Running it by hand

```
cd ui && npm install && npm run build   # once, and after changing the page
cd .. && go run . serve --dir /tmp/tsum-stats-data --import-dir ~/some/tsum_record
```

| Flag | Default |
|:--|:--|
| `--http` | `127.0.0.1:8090` (PocketBase's own flag) |
| `--events-addr` | `127.0.0.1:21025`; `""` turns the listener off |
| `--events-token` | none. Refuses any device whose `hello` does not carry it. Set one before binding the listener to anything other than loopback |
| `--events-connect HOST:PORT` | none. Repeatable |
| `--import-dir DIR` | none. Repeatable |
| `--scan-interval` | `10s` |
| `--web-dir DIR` | none. Files here replace the embedded site's |
| `--adb PATH` | adb on `PATH`, else the Android SDK's, else Google's platform-tools, downloaded on first start into `<data dir>/adb` |
| `--device-storage DIR` | `/sdcard/Download/GameAutomationPlatform`. |

`go test ./...` covers:

- CSV parsing: header drift, `T`/`F` switches, empty cells;
- merging an event and a CSV row for the same round;
- filters, sort order and the time-zone day buckets;
- a Tsum list being replaced;
- importing from a device, through a fake adb.

## Running it

`tsum-stats` with no command (a double-click) does four things:

1. Checks its update address (the pin) and, when a newer version is named,
   downloads it, checks the sha256, replaces itself and restarts. Skipped when
   offline, when the build has no address, or with `TSUM_STATS_NO_UPDATE=1`.
   `tsum-stats update` does it on demand. Code: `update.go`.
2. Serves the site on `127.0.0.1:8090`.
3. Keeps its database in the user's config folder
   (`<UserConfigDir>/TsumTsumStats/data`; `--dir` overrides). Code: `launch.go`.
4. Opens the site in the default browser.

Stop it with Ctrl+C in its window. It needs no adb and no device: **Import from
devices** finds adb itself (`--adb` points it at one). When none is on the PC, the
program downloads Google's platform-tools for this OS in the background on start
(`internal/stats/adb_install.go`); Import from devices works once it finishes.

Databases made by 0.6 and earlier (which named their tables `gap_*`) are
renamed on first start.
