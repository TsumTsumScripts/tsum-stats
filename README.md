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

## Download

Get the file for your system from the
[latest release](https://github.com/TsumTsumScripts/tsum-stats/releases/latest)
and run it (on macOS and Linux, `chmod +x` first). It updates itself from new
releases, checking a sha256 before replacing itself; `TSUM_STATS_NO_UPDATE=1`
turns that off. Stop it with Ctrl+C. Data lives in your user config folder
under `TsumTsumStats/data` (`--dir` changes it).

## Build

```
cd ui && npm ci && npm run build   # the page, embedded into the binary
cd .. && go test ./... && go run . serve --dir /tmp/tsum-stats-data
tools/build.sh                     # all five binaries and the pin
```

The full documentation is [docs/STATS-SITE.md](docs/STATS-SITE.md).
