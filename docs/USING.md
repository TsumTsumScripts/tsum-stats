# Using Tsum Tsum Stats

**A local website for your own Tsum Tsum data: every round played, and which
Tsums you own.** One program, `tsum-stats`, serves it on
<http://127.0.0.1:8090>. Download the binary and run it; nothing is sent
anywhere unless you publish a snapshot yourself.

This is the manual. For how the program is built and how to change it, see
[INTERNALS.md](INTERNALS.md).

- **Stats.** Coin efficiency first, then charts and two tables, all filterable.
  See [The Stats page](#the-stats-page).
- **Catalog.** Every Tsum, what your latest Tsum List export says about it, and
  what it costs to max. See [The catalog](#the-catalog).
- **Help.** How to get data in: the address to paste into the app's Script
  events, Record round stats, **Import from devices**, and the Tsum List chore.

## Running it

`tsum-stats` with no command (a double-click) does four things:

1. Checks for a newer version and, when there is one, downloads it, verifies
   its sha256, replaces itself and restarts. Skipped when offline, when the
   build has no update address, or with `TSUM_STATS_NO_UPDATE=1`.
   `tsum-stats update` does it on demand.
2. Serves the site on `127.0.0.1:8090`.
3. Keeps its database in your user config folder
   (`<UserConfigDir>/TsumTsumStats/data`; `--dir` overrides).
4. Opens the site in your default browser.

Stop it with Ctrl+C in its window. Starting it again while it runs just opens
the page.

It needs no adb and no device of its own: **Import from devices** finds adb
itself (`--adb` points it at one). When none is on the PC, the program
downloads Google's platform-tools for your system in the background on start,
and Import from devices works once that finishes.

Databases made by 0.6 and earlier are migrated on first start.

### Options

| Flag | Default |
|:--|:--|
| `--dir DIR` | the data folder, under your user config folder |
| `--http` | `127.0.0.1:8090` |
| `--events-addr` | `127.0.0.1:21025`; `""` turns the live listener off |
| `--events-token` | none. Refuses any device whose `hello` does not carry it. **Set one before binding the listener to anything other than loopback** |
| `--events-connect HOST:PORT` | none. Repeatable |
| `--import-dir DIR` | none. Repeatable |
| `--scan-interval` | `10s` |
| `--web-dir DIR` | none. Files here replace the built-in site's — see [Changing the site](#changing-the-site) |
| `--adb PATH` | adb on `PATH`, else the Android SDK's, else Google's platform-tools |
| `--device-storage DIR` | `/sdcard/Download/GameAutomationPlatform` |
| `--starter DIR` | none. Also serves the service starter for that starter bundle at `/starter/` — see [The service starter](#the-service-starter) |
| `--open` | off. Opens the site in the browser once it is up |

### The service starter

The Tsum Tsum script's starter bundle runs this program with `--starter
<bundle>` (its `Start-Linux.sh` and `Start-Windows.cmd` download it). The
starter page is then at <http://127.0.0.1:8090/starter/> and this site at `/`,
each linking to the other. The starter uses the bundle's adb for Import from
devices too, and imports what it copies into the bundle's `collected/` folder.
Without `--starter` nothing changes.

The starter keeps this program and its own scripts current. Each launch runs
`tsum-stats update` first, and while it runs the page looks for newer versions
every six hours and has a **Check for updates** button.

- **Update tsum-stats** downloads the new version, checks its sha256 and exits
  with `TSUM_STATS_RESTART_CODE`; the launcher starts the new version.
- **Update the starter** reads the bundle's `starter-version.txt`
  (`version=`, `update_url=`), fetches the `starter.txt` it names, downloads
  that scripts `.tar.gz`, checks its sha256 and moves its files into the
  bundle (never `adb/`, `apk/`, `collected/`, `server/`, `channel.txt`,
  `last-device.txt` or `Start-Windows.cmd`). It then exits with
  `GAP_STARTER_RELOAD_CODE`, and the launcher starts itself again.

The page reloads once the new process answers. Without those variables (a
hand-started `serve --starter`) an update is installed and takes effect on the
next start. A bundle with no `update_url`, or the source tree (it still has
`build-starter.sh`), does not update its scripts. `TSUM_STATS_NO_UPDATE=1`
turns off the launch update and the background checks; the buttons still work.

## Getting your data in

| Source | How |
|:--|:--|
| Live rounds | A device dials `127.0.0.1:21025` (`--events-addr`). An emulator on the same PC reaches that as `10.0.2.2:21025`. Each finished round becomes a row. `--events-connect` dials a device's own listener through `adb forward` instead |
| `stats_*.csv` | Found under your `--import-dir` folders, and under `~/Documents/MuMuSharedFolder` when it exists. Rescanned every few seconds, skipping files that have not changed |
| `tsum_list_*.csv` | Found the same way. The script rewrites the file after every page, so a re-import replaces the list; the newest export per device and build is the one shown |
| Dropped or picked files | Drag them onto the page, or use the file picker |
| Help › Import from devices | Lists the devices adb can see, pulls both kinds of CSV from each, and imports them |

**A live round and its CSV row are one row**, matched on the round's id, so
recording live and importing the CSV later does not double-count. The import
fills in any figure the live event did not carry.

**Builds.** INTL or JP is on every round and in the Tsum List export. For
exports older than that column, the build is guessed from the Tsum names.

**Device names** come from the export's `device` column, the same name the
live events carry, so a list and its rounds are filed together. An export
without one is filed under the folder it was found in, else *Unknown device*.
After a device is updated and exports again it appears under its real name;
the old entry stays until its lists are deleted.

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

**Less item costs** under the switch (`net=1`) subtracts what each round's
boost items cost from its coins, base or final, in every figure, chart, the
coin range and the Rounds table's rate and *Net coins* column: +Score, +Coin
and +Exp 500, +Time 1,000, +Combo 1,200, +Bubble 1,500 and 5>4 1,800
(`itemBits` in `summary.go`). A round recorded before items were has no net
coins, so it drops out of the coin figures like an unread one. Medals mode
hides the box and ignores it.

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
- **Tables** use TanStack Table's framework-free core
  (`@tanstack/table-core` v8, MIT). The Tsums table sorts and pages in the
  page; the Rounds table hands both to the server.
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
legends, tables and the Catalog's cards all use it.

With hundreds of Tsums some colours are close. So a colour never stands alone:
charts show the portrait where the mark has room, and a named legend or
tooltip everywhere else.

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
Tsum.

Boxes left (`ui/src/lib/boxes.js`): a Tsum not owned needs every box; an owned
one needs the rest of its current level, less the Tsum List's `skill_progress`
(the percent through that level; a list from before that column counts as 0%),
plus every level above. A box is 30,000 coins, or 10,000 medals for a medal
Tsum.

The **Cost to max** panel totals coins and medals over the Tsums shown (build,
Owned filter and search), takes away what you type as on hand, and divides by
your pace: this build's coins (after the coin bonus) and medals per day over
the last 7 or 30 days or every round. Every device's rounds count, so devices
playing other accounts make the pace look too fast. The chart draws each Tsum's
share still to earn down to its finish date. Pace window and on-hand figures
are saved in the browser.

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

### Sharing it on GitHub Pages

The top bar's **Share** button publishes a snapshot to the player's own
GitHub Pages site, at `https://<account>.github.io/tsum-stats/`. It needs no
git and no command line:

1. **Connect.** Help section 4 walks the player through it: a link opens
   GitHub's token page with `public_repo` and the name filled in; the player
   generates a token and pastes it into the dialog (`POST /publish/token`,
   `Publisher.SaveToken`, which checks it against GitHub first). The player's
   password never reaches Tsum Tsum Stats. Each time the dialog opens it asks
   GitHub whether the saved token still works (`POST /publish/check`); one
   that has expired or been revoked is forgotten, and the dialog asks for a
   new one.
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

- **Built in:** `ui/public/themes/`, listed Halloween, Midnight Felt, Daylight Felt, Ember (`themeOrder` in
  `internal/stats/site.go`), then a player's own by name. *Halloween* is the
  default (`DEFAULT_THEME` in `ui/src/lib/ui.svelte.js`, and `ui/index.html`).
  The tokens in `ui/src/styles.css` sit under every theme and show only if its
  file fails to load. *Midnight Felt* is the Tsum
  Tsum website's dark look: indigo felt, dashed stitching and a marigold accent.
  *Daylight Felt* is the same patches on a cream ground. Both set tokens only,
  and their fonts (Caprasimo, Figtree) come from Google Fonts, with system fonts
  offline. Text is 7:1 or better on its panel; keep that if you change a colour.
- **Ember:** a warm dark theme. Besides tokens it restyles
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
- **Start from:** `themes/daylight-felt.css`, which sets every token. A theme
  may set only what it changes.

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

**Favourite Tsums** (the Tsum List's `favorite` column, the game's gold star)
show a `.fav-star` at the portrait's lower left in a card and after the name in
a list, coloured by `--fav`. The shape is drawn by its `::before`.

## Where to go next

- The program's own **Help** section walks through getting data in, with
  screenshots.
- [INTERNALS.md](INTERNALS.md) — how it is built, and how to change it.
