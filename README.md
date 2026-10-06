# Tsum Tsum Stats

A local website for your own Tsum Tsum data: every round played, and which Tsums
you own. One program, no install: download it, run it, and it opens in your
browser at <http://127.0.0.1:8090>.

- **Stats:** coin efficiency, charts and a searchable table of rounds, filtered
  by Tsum, device, dates, outliers and game build.
- **Catalog:** every Tsum, with what your latest Tsum list export says about it,
  and what it costs to max.
- **Help:** how to get data in (live script events, `stats_*.csv` files, or
  Import from devices over adb).

Everything stays on your computer. Sharing a read-only copy (Share) is opt-in.

## Run it

**macOS and Linux:** paste this into a terminal. It downloads the right file,
checks it, and starts Tsum Tsum Stats.

```
curl -fsSL https://raw.githubusercontent.com/TsumTsumScripts/tsum-stats/main/install.sh | sh
```

Next time, run `tsum-stats` (the installer says where it put it). Prefer a
download? Get `tsum-stats-<system>.tar.gz` from the
[latest release](https://github.com/TsumTsumScripts/tsum-stats/releases/latest),
extract it and run `./tsum-stats`.

**Windows:** download [`tsum-stats.cmd`](https://github.com/TsumTsumScripts/tsum-stats/releases/latest/download/tsum-stats.cmd)
and double-click it. It is a short text file you can read first: it downloads
the program, checks it, and starts it. If Windows asks whether to run it, choose
Run (or More info, then Run anyway). Prefer the program itself? The release also
has `tsum-stats-windows-amd64.zip`.

It opens in your browser at <http://127.0.0.1:8090>. Starting it again while it
runs just opens the page. Stop it with Ctrl+C in its window. It updates itself
from new releases, checking a sha256 before replacing itself;
`TSUM_STATS_NO_UPDATE=1` turns that off. Data lives in your user config folder
under `TsumTsumStats/data` (`--dir` changes it).

## Build

```
cd ui && npm ci && npm run build   # the page, embedded into the binary
cd .. && go test ./... && go run . serve --dir /tmp/tsum-stats-data
tools/build.sh                     # all five binaries and the pin
```

Full documentation: [docs/USING.md](docs/USING.md) is the manual — what every
figure means, getting data in, themes and publishing a snapshot.
[docs/INTERNALS.md](docs/INTERNALS.md) is how it is built and how to change it.

## License

MIT, see [LICENSE](LICENSE).
