# Using Tsum Tsum Stats

**A local website for your own Tsum Tsum data: every round played, and which
Tsums you own.** One program, `tsum-stats`, serves it on
<http://127.0.0.1:8090>. Download the binary and run it; nothing is sent
anywhere unless you publish a snapshot or join the global stats yourself.

This is the manual. For how the program is built and how to change it, see
[INTERNALS.md](INTERNALS.md).

- **Stats.** Coin efficiency first, then charts and two tables, all filterable.
  See [The Stats page](#the-stats-page).
- **Catalog.** Every Tsum, what your latest Tsum List export says about it, and
  what it costs to max. See [The catalog](#the-catalog).
- **Help.** How to get data in: the address to paste into the app's Script
  events, Record round stats, **Import from devices**, and the Tsum List chore.
- **Contribute.** Optional: add your rounds to the global stats, figures
  pooled from many players' rounds. See
  [Contributing to the global stats](#contributing-to-the-global-stats).

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
| `--events-addr` | `0.0.0.0:21025`: devices on this computer and on the network. `127.0.0.1:21025` keeps it to this computer; `""` turns the live listener off |
| `--events-token` | none. Refuses any device whose `hello` does not carry it. Events are plain text, so **set one on a network you do not trust** |
| `--events-connect HOST:PORT` | none. Repeatable |
| `--import-dir DIR` | none. Repeatable |
| `--scan-interval` | `10s` |
| `--web-dir DIR` | none. Files here replace the built-in site's — see [Changing the site](#changing-the-site) |
| `--global-url URL` | `https://tsum-stats.gapscripts.app`: the global stats site that contributing sends rounds to, and only once you join. A data folder contributes to one site, so a test site takes another `--dir`. `""` turns contributing off — see [Contributing to the global stats](#contributing-to-the-global-stats) |
| `--adb PATH` | adb on `PATH`, else the Android SDK's, else Google's platform-tools |
| `--device-storage DIR` | `/sdcard/Download/GeneralAutomationPlatform` |
| `--starter DIR` | none. Also serves the service starter for that starter bundle at `/starter/` — see [The service starter](#the-service-starter) |
| `--open` | off. Opens the site in the browser once it is up |

### The service starter

The Tsum Tsum script's starter bundle runs this program with `--starter
<bundle>` (its `Start-Linux.sh` and `Start-Windows.cmd` download it). The
starter page is then at <http://127.0.0.1:8090/starter/> and this site at `/`,
each linking to the other. The starter uses the bundle's adb for Import from
devices too, and imports what it copies into the bundle's `collected/` folder.
Without `--starter` nothing changes. The page's **Stop** button ends the
program (exit 0), which also ends the launcher and closes its window.

The starter keeps this program and its own scripts current. Each launch runs
`tsum-stats update` first, and while it runs the page looks for newer versions
every six hours and has a **Check for updates** button.

- **Update tsum-stats** downloads the new version, checks its sha256 and exits
  with `TSUM_STATS_RESTART_CODE`; the launcher starts the new version.
- **Update the starter** reads the bundle's `starter-version.txt`
  (`version=`, `update_url=`), fetches the `starter.txt` it names, downloads
  that scripts `.tar.gz`, checks its sha256 and moves its files into the
  bundle (never `adb/`, `apk/`, `collected/`, `server/`, `channel.txt`,
  `last-device.txt`, `watch.json`, `watch.log`, `watch.1.log` or `Start-Windows.cmd`). It then exits with
  `GAP_STARTER_RELOAD_CODE`, and the launcher starts itself again.

The page reloads once the new process answers. Without those variables (a
hand-started `serve --starter`) an update is installed and takes effect on the
next start. A bundle with no `update_url`, or the source tree (it still has
`build-starter.sh`), does not update its scripts. `TSUM_STATS_NO_UPDATE=1`
turns off the launch update and the background checks; the buttons still work.

#### Watch mode

The device panel's **Keep GAP running (watch mode)** card turns it on per
device (off by default). While this program runs it checks each watched
device every 15 s through the device script's `watch` verb and, in this order:

1. takes GAP's request to restart the device (GAP writes it when it wants a
   restart and a watcher is present, and waits 60 s for it to be taken), then
   restarts the emulator from this computer, or runs `adb reboot` when it
   cannot or the emulator restart fails. A request older than
   `requestMaxAgeSec` (50 s) is left to GAP, which then restarts by itself, and
   one that cannot be deleted is never acted on, so the device is not
   restarted twice;
2. starts GAP once Android is up and GAP is not running (not on a rooted
   device, whose app does it, and not after **Stop** until the next boot);
3. restarts GAP (`start --force`) when its alive stamp is over 3 minutes old;
4. when adb loses the device for 90 s: `adb connect`, then `adb reboot`, then
   the emulator restarted from this computer. A device that answers but whose
   reply cannot be used (the device script could not be copied, say) is only
   reported, never restarted;
5. when Android is still starting after `bootStuckSec` (5 minutes): the
   emulator restarted, else `adb reboot`, at most once an hour.

Emulators it can restart: MuMu Player 12 (`MuMuManager.exe`), LDPlayer 9
(`ldconsole.exe`) and BlueStacks 5 on Windows, BlueStacks Air on a Mac. The
device is matched to an instance by its adb port, and an instance is never
restarted when two share the port. Emulators on another computer (and USB
phones) get adb actions only. If a tool is not found, point
`GAP_MUMU_MANAGER`, `GAP_LDCONSOLE`, `GAP_BLUESTACKS_CONF`,
`GAP_BLUESTACKS_PLAYER` or `GAP_BLUESTACKS_APP` at it.

Settings are in the bundle's `watch.json` (written with the defaults on first
start, re-read when it changes; a broken file is left alone and the page says
so). Its `limits` bound every action: starts per hour, restarts of a frozen GAP
per hour, at most 3 emulator restarts in 6 hours at least 10 minutes apart
(doubled after each failure), giving up after 3 that did not bring the device
back until **Restart emulator now**. Each key is explained in the file's
`help`. What it did goes to `watch.log` (rotated to `watch.1.log` at 1 MB). The card also has confirmed **Restart emulator now** and
**Restart Android** buttons. Watch mode stops when this program does.

## Getting your data in

| Source | How |
|:--|:--|
| Live rounds | A device dials port `21025` (`--events-addr`): an emulator on the same PC as `10.0.2.2:21025`, a phone or another PC at this computer's network address, such as `192.168.1.50:21025`. Each finished round becomes a row. `--events-connect` dials a device's own listener through `adb forward` instead |
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
queries) or **Medals** (`coins=medals`), which also keeps only medal Tsums'
rounds with medals read, and relabels the page. A round that earned no medals
counts as 0, so medals an hour is what the Tsum pays over all its play, not
over its lucky rounds; the Rounds tile says what share earned any. Coins per
hour is the same
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

**Skill type.** The rail's Skill type list (`skillType` in the link, a comma
list) keeps the rounds the script played with the skill types ticked: the
script's way of playing the skill, such as `burst` or a Tsum's own
(`beastda`). *Not recorded* (`-`) is the rounds that came without one. It
shows when the rounds have more than one.

**Chains per scan, max chain length, bubble strategy.** Three of the script's
settings have lists of their own on the rail, the same way (`scan`, `chain`
and `bubble` in the link): how many chains the script takes from one look at
the board (*Chains per board scan*), the longest chain it draws (*Maximum
Chain Number*) and how it spends bubbles (*One Bubble Mid Chain*, *All
Bubbles Mid Chain* and so on). *Not recorded* (`-`) is the rounds without
the setting, or with a value that is not a whole number up to 999 (a strategy:
not a plain name). Each shows when the rounds have more than one value.

**Min rounds per Tsum.** The rail's box (`minRounds` in the link) leaves
Tsums with fewer rounds in the filter out of the Tsum table and the efficiency
chart, so a Tsum played a handful of times does not top the rankings. It is
the page's alone: every total, share and other chart still counts their
rounds.

With coins as the primary stat, the summary also carries `medals`: the same
totals and per-Tsum figures for medals, over the same medal Tsums' rounds,
0s included, with `earnedRounds` the rounds that earned any. They
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

The copy button beside it (and in the bottom corner of the overview's first
tile) copies the panel to the clipboard as a picture, ready to paste into a chat. The
picture is a compact card: the panel's title and the view picked in it, its
chart drawn again at the card's width (the efficiency chart's top 10) or its
table's first 10 rows and 5 columns (always with the sorted one), then the
filters in a line (always the time range and primary stat), the rounds they
count, and the date. With one Tsum focused, the card shows its portrait and
name, as on the Tsum page; compared Tsums are named in the filter line. A
browser that cannot put pictures on the clipboard downloads it as a PNG.
Portraits come through the stats server (`/api/stats/art/{id}`, `art.go`), as
their site does not let pages read them; in a snapshot or on the global site
a card shows initials in their place until it does.

| Panel | Views |
|:--|:--|
| Head to head | Only with 2+ Tsums picked: a scorecard with the best in each row marked, and a per-day line per Tsum |
| Coin efficiency by Tsum | Ranked bars (coins/s, average, median or best); Spread, a box plot of the 12 most played; Bubbles, average coins × coins/s sized by rounds |
| Coins per day | Stacked by Tsum (top 7 + Other); coins/s; average with the day's range |
| Where the coins come from | Donut by Tsum (top 8 + Other), or a sunburst of game › Tsum › items used; by coins, rounds or time |
| By items used | Radial rings for the six most played item sets |
| By chain settings | Chains per scan and max chain length taken as one pair, the way an item set is: *Every pair*, a bar per pair over every Tsum in the filter (coins/s, average or rounds); *Best per Tsum*, each Tsum's best pair of those with 20 rounds or more, against its most played pair |
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
- **Chain pairs** come from `maxChainsPerScan` and `maxChain` (the summary's
  `chains`). A part not recorded shows as `?`; a round with neither is *Not
  recorded*, which is drawn but never a Tsum's best pair. Rounds of several
  Tsums are pooled in *Every pair*, so pick one Tsum, or use *Best per Tsum*,
  to choose settings for it.
- **Outliers:** the box plot's scale stops past the highest P90 (the highest
  round is marked). The histogram's last bucket gathers every round from
  Q3 + 1.5 × IQR up (`cap` in the summary).
- **Filters and navigation stay on screen.** At 1180 px and wider they are a
  sticky side column with a jump menu. Narrower, they are a bar under the top
  bar: chips for the active filters, a *Filters* button that drops the form
  down, and the jump menu. The top bar is sticky everywhere. Its device chip
  names the one device and what it is doing, or counts several (*2/3 online ·
  1 playing*); click it for each device's status, script and when an offline
  one was last seen. **Share a snapshot**, the theme and the service starter
  are in its **⋯** menu.

**Every Tsum has its own colour,** `color` in `ui/public/data/catalog.json`. Charts,
legends, tables and the Catalog's cards all use it.

With hundreds of Tsums some colours are close. So a colour never stands alone:
charts show the portrait where the mark has room, and a named legend or
tooltip everywhere else.

## The Tsum page

**Tsum** in the top bar (`#/tsum?id=<tsum>`) is everything about one Tsum. Open
it from there, or with **Tsum page →** in the Stats focus bar, which carries the
range, primary stat, game and a single device across. It has its own time range
(7, 30 or 90 days, or all time, the default), the same primary stat and *Less
item costs* switches, and game, skill type and device pickers when there is more
than one.
Incomplete rounds are left out, as on Stats.

- **Header:** where the Tsum ranks by rate among the Tsums in the same filter,
  its rate against all of them together, its share of your rounds, and, from the
  newest Tsum list for the build, its level, skill and boxes to max.
- **Recent form:** the newest 50 rounds' rate against all the rounds in the
  filter and against the 50 before them.
- **To the next skill:** boxes and their cost to the next skill level and to full
  skill, from the catalog's box counts and the Tsum list's progress, as play
  time at what all your Tsums earned a second in the filter: final coins (less
  item costs with *Less item costs*), or medals for a medal Tsum.
- **Consistency:** half the rounds land within ± this share of the median (half
  the middle half's width over the median, so a misread round does not stretch
  it). Type a target to see what share of rounds fell under it; the target is
  kept per Tsum and primary stat in this browser (`target=` in the API).
- **By skill level:** the figures per `skillLevel` the script was set to, each
  against the level below. The level the Tsum list says it is at is marked
  *now*. Below it, each level with 20 rounds or more is a line of its share of
  rounds per coin bucket (the histogram's buckets).
- **Do the items pay?** Each boost item against the same other items without
  it: only item sets that differ by that item alone are compared, weighted by
  the smaller side. *Gain a round* is the extra coins less the item's cost
  (already taken off with *Less item costs*). Rounds without an item are often
  older, at a lower skill level, so check the rounds with · without column.
  Hidden in Medals mode.
- **By chain settings:** chains per scan and max chain length taken together,
  a row per pair the Tsum was played with, against the most played pair; the
  best pair with 20 rounds or more is marked. The pairs answer which
  combination suits the Tsum, which the two settings' own tables below cannot.
- **By script setting:** every other setting that took more than one value
  for this Tsum (the boost items have their own chart), against the most played
  value; chains per scan, max chain length and bubble strategy first. Settings often changed together, so a difference is not proof of cause.
- **By skill type**, **By script version** and **By device**, when there is
  more than one.
- The KPI tiles, per-day, histogram and items charts, as on Stats, for
  this Tsum alone, and its ten best rounds by coins, rate or score.

Every panel, and the overview tiles with the insights under them, can be copied
as a picture as on Stats; on this page the card always shows the Tsum's
portrait and name.

A row with fewer than 20 rounds is dimmed and never marked best. Catalog cards
of Tsums you have played link to their page. The page reads
`/api/stats/tsum?id=…` with the Stats filter parameters (`tsum.go`).

## The catalog

`ui/public/data/catalog.json` lists every Tsum with its global and its JP name. It is
generated from the Tsum script's portrait library (a tool that lives with the
scripts, not here) and committed, so building the site needs nothing else.

A blank name means that build does not have the Tsum. The INTL/JP toggle
filters on this. 36 rows have neither name and are hidden.

Tsum art comes from `https://tsum-assets.gapscripts.app/tsums/block_<id>_l.png`,
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

A month file is column by column: each figure is one array, repeated text is
a small dictionary the columns index into, and the time is the gap in seconds
after the round before. The dictionaries are the Tsum, build, skill type,
script version, device, source (live or CSV) and each round's script settings
as stored, which the Tsum page's *By script setting* reads, so a published
page shows them. Rounds are in time order. `null` is a figure the script could
not read. Round ids and anything else the page does not show are left out.

**Why months.** A finished month never changes, so a host caches it for good,
and a repo grows by the current month per publish, not by the whole history.
Unchanged files are not rewritten (the command prints how many it wrote), so
DIR can be a git checkout that is updated in place. The page loads only the
months a filter's date range touches: its default 7 days is one or two files.

### Sharing it on GitHub Pages

**Share a snapshot** in the top bar's **⋯** menu publishes a snapshot to the player's own
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

## Contributing to the global stats

**The global stats** at <https://tsum-stats.gapscripts.app> pool the rounds of
every player who chooses to send them: coin efficiency for each Tsum by skill
level, boost items and game, from far more rounds than one account plays. They
are worked out again every hour. Nothing is sent until you join.

**Joining.** Press **Contribute** in the top bar. The dialog says what is
sent and what the global site keeps; tick *I agree…* and press **Join**. The
first upload starts about two minutes later, so you can still back out. After
that, Tsum Tsum Stats sends your new rounds about once an hour, in the
background, while it runs. **Upload now** sends at once. The dialog shows your
contributor number, the rounds sent and waiting, when rounds were last sent,
when it last checked for new ones (every hourly pass, even with nothing to
send), when the next upload is due, and the global site's own count of your
rounds, devices and days.

**What is sent** is each round's stats CSV row as the script writes it: the
round id (which carries when the round began and a code for the device that
played it), when it ended, the script version, skill type, Tsum, game, round
time, score, base and final coins, medals, and every script setting (skill
level, boost items and the rest), with this app's version. Only rounds that:

- ended in the last 60 days, and at least 20 minutes ago (by then its CSV row
  has usually replaced the live event's);
- are complete: score, both coin figures and the round time, and medals for a
  medal Tsum;
- say their game, INTL or JP, directly or through the `jpVersion` setting.

A round is sent once, and again only if its figures change, such as when a
CSV import fills in what the live event lacked (`ts_global_sent` in the
database records what was sent), or when the global site starts keeping more
of each round, or asks every contributor to send everything again (after a
fault on its side, say): then every round of the last 60 days goes once more,
with the next upload. The global
site keeps every field of a round as it was sent. A round the global site cannot take yet,
because by its clock the round has not happened (this computer's or the
device's clock is ahead), is sent again with the next upload.

**Never sent**: device names, where a round came from (live or CSV), your
Tsum lists, and the names of files and folders.

**What the global site keeps:**

- Your rounds, for good, under a contributor number with no name or account.
  Numbers are given out in order as players join; yours is not published, and
  the dialog shows your own totals.
- What the public page shows of them: figures added up over the rounds of the
  same day, Tsum, game, skill level and boost items (counts, totals, best and
  lowest, the first and last end time), and how many contributors (in all and
  per Tsum) and devices sent rounds in the last 30 days. Where only you, or a
  few players, send a Tsum, those figures can come close to your own rounds:
  a group of one round shows that round's score, coins and end time. The page
  marks such Tsums *few players*.
- A hashed form of each round's device code. A round id ends with a code for
  the device that played it; the site keeps only a keyed hash of it, to tell
  devices apart and to count a round sent twice only once. The first sender
  keeps it: a round you send that another player already sent (from the same
  CSV files) counts once, under them.
- When you join, a hashed form of your internet address, for about a day, to
  limit how many joins one address makes.
- Rounds of a Tsum newer than the global site: kept, and counted as yours, but
  in no public figure until the site is updated to know that Tsum.
- Nothing of the rounds it turns away, which are counted and not sent again:
  a Tsum name that is not one, settings past their limits, figures out of
  range, a round that started more than 60 days ago, or one that starts less
  than 40 s after the device's previous round in the same upload. A round is
  never turned away for its length: some Tsums' rounds last hours.

Each contributor may add 5,000 rounds a UTC day, and the site has a daily
total for everyone. Past either, uploads wait until 00:00 UTC, and the dialog
says when they carry on. Any other trouble reaching the site shows in the
dialog as an error, and the next hourly upload tries again.

**Stop or unlink:**

- **Stop contributing** stops the uploads and keeps your key. **Join again**
  carries on under the same number.
- **Stop and unlink my rounds** also forgets the key and asks the global site
  to take your number off every round you sent, which it does over the
  following hours (a day or more if you have sent many rounds). An upload in
  progress finishes first. The rounds stay in the global figures, with their
  hashed device codes, and cannot be taken out of them. It cannot be undone:
  joining again makes you a new contributor, and rounds already sent are not
  sent again.

**The key** is in `global.json` in the data folder, readable only by you. It
is sent only to the site it came from, and the state the page reads never
contains it. `--global-url` picks the site (default
`https://tsum-stats.gapscripts.app`): it must be `https`, or plain `http` to
this computer for a local test copy. A data folder contributes to one site,
so joining another while a key for the first is saved is refused: start a
test copy with its own `--dir` too. `""` turns contributing off.

### The global page

The global site is this program's Stats page and Catalog, read-only, over
everyone's rounds, and in the *Midnight Felt* theme until you pick another:

- **Days are UTC days, and a round counts on the day it started.** Here a
  round counts on the day it ended, in your time zone, so day totals and date
  ranges differ a little where rounds cross midnight. The From and To fields
  say UTC.
- **The quartiles, median and P90 are approximate**, marked ≈. They come from
  bins 2 % wide, so each is within 2 % of the exact figure, and exact under
  100. Every count, total, average, best and rate is exact.
- **Filters:** Tsums, game, dates, skill type, primary stat, *Less item costs*
  and min rounds per Tsum, as here (chains per scan, max chain length and
  bubble strategy too), plus **skill level** and **items used**. No
  device or incomplete-round filters. Rounds sent before the global site kept
  skill types have none (*Not recorded*) until their player's app sends them
  again, which it does once by itself; rounds older than 60 days by then keep
  none.
- **Outliers:** coin and medal ranges, one at a time; no score range. Rounds
  are kept in their 2 % bins, so a range keeps or leaves out whole bins, by
  their rounds' average: the rounds, totals, averages and rates of what it
  keeps are exact for that, the lowest, highest and standard deviation are
  estimates, and the best score and first and last rounds are those of every
  round. Only the range's own figure keeps its median and histogram: with a
  coin range the medal spreads go, and with a medal range the coin ones
  (except in Medals mode).
- **Players.** The Tsums table's Players column counts the contributors who
  sent rounds of that Tsum in the last 30 days. Under 3, the row is dimmed and
  marked *few players*.
- **The Tsum page** is there, over everyone's rounds of the Tsum: its rank by
  rate among every Tsum, its share of all rounds and its players, the KPI
  tiles, consistency and rounds under a target (≈, from the bins), by skill
  level with its spread chart, per day, the histogram, by items and *Do the
  items pay?*, *By chain settings*, and *By script setting* for chains per scan, max chain length
  and bubble strategy. Not there: recent form, boxes to the next skill, other settings,
  versions, devices and best rounds. The Catalog links each
  played Tsum to it.
- **Not there:** the Rounds table, Help, and anything about
  one player's collection. The Catalog lists every Tsum with its global
  rounds.

## Changing the site

**Which version of the site is this?** The foot of every page, on this
program's site, a snapshot and the global site alike, says when its code
was last changed: `Site 2026-10-15 17:20 UTC · 64160c4`, the date and time
of the commit it was built from and its short hash, and `· with local changes` when it was built
from a working tree with changes not yet committed.

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
tokens on `:root`, and nothing else.** The Theme picker in the top bar's **⋯** menu lists them.
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
| `--link` | The accent as text: links, sort arrows, the head-to-head leader. `--accent-a` unless set; a light theme sets a darker one, since a fill colour is too pale to read as type |
| `--badge-a`, `--badge-b`, `--hero-top` | The logo badge and Help's step numbers; the hero KPI tile |
| `--score`, `--coin`, `--medal` (each with `-shadow`), `--good`, `--bad` | Figures by kind; online dots |
| `--axis-line`, `--grid-line`, `--chart-rule`, `--chart-track` | Chart axes, gridlines, the hover rule, the empty part of radial bars |
| `--chart-other`, `--build-intl`, `--build-jp`, `--build-none`, `--avatar-a`, `--avatar-b` | "Other" slices; the sunburst's game ring; a portrait's backing |

Tsums keep their own colours (`color` in the catalog) in every theme.

Text in the built-in felt themes is at least 4.5:1 against what it sits on
(3:1 for large type), disabled buttons aside. Under 720px wide (phones) the
top bar scrolls away with the page and only the Stats rail stays pinned; a
theme that restyles padding or type sizes should give them a phone size in
its own `@media (max-width: 719px)` block, as the felt themes do.

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
- [global/README.md](../global/README.md) — the global stats site's Worker.
