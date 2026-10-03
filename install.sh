#!/bin/sh
# Installs Tsum Tsum Stats on macOS or Linux and starts it:
#   curl -fsSL https://raw.githubusercontent.com/TsumTsumScripts/tsum-stats/main/install.sh | sh
# It downloads the newest release for this computer into ~/.local/bin, checks
# the sha256 against the release's pin, and runs it. Run it again to start it
# later, or just run `tsum-stats`.
set -eu

REPO=TsumTsumScripts/tsum-stats
BASE="https://github.com/$REPO/releases/latest/download"
DIR="${TSUM_STATS_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) echo "This installer is for macOS and Linux. Windows: download the .zip from https://github.com/$REPO/releases/latest" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=amd64 ;;
  *) echo "No build for $(uname -m)." >&2; exit 1 ;;
esac

sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading Tsum Tsum Stats for $os-$arch ..."
curl -fsSL "$BASE/tsum-stats.txt" -o "$tmp/pin"
want="$(sed -n "s/^sha256_${os}_${arch}=//p" "$tmp/pin" | tr -d '\r')"
curl -fsSL "$BASE/tsum-stats-$os-$arch" -o "$tmp/tsum-stats"
[ -n "$want" ] && [ "$(sha256_of "$tmp/tsum-stats")" = "$want" ] || { echo "The download did not match its checksum; nothing was installed." >&2; exit 1; }

mkdir -p "$DIR"
chmod +x "$tmp/tsum-stats"
mv -f "$tmp/tsum-stats" "$DIR/tsum-stats"
echo "Installed $DIR/tsum-stats"
case ":$PATH:" in *":$DIR:"*) ;; *) echo "Next time, run: $DIR/tsum-stats" ;; esac
echo "Starting it. It opens in your browser; press Ctrl+C here to stop it."
exec "$DIR/tsum-stats"
