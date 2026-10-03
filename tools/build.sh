#!/usr/bin/env bash
# Builds tsum-stats for every system it runs on, and optionally publishes it.
#
#   tools/build.sh [--publish]
#
# Out come build/<version>/tsum-stats-<os>-<arch>[.exe] -- single binaries with
# the site embedded, pure Go (PocketBase's SQLite is modernc), so every target
# cross-compiles from one machine -- and build/<version>/tsum-stats.txt, the
# pin: version, then url_/sha256_/size_ per system.
#
# Also written: a .tar.gz (macOS, Linux; executable inside) or .zip (Windows)
#   per system, for people to download.
#
# --publish creates the GitHub release v<version> with the binaries and the pin
#   as assets. A running tsum-stats updates itself from the newest release's
#   pin, so publish the binaries in the same step (this does) and never edit a
#   published pin by hand. Needs gh, signed in with write access to the repo.
#
# Needs Go (GOTOOLCHAIN fetches the version go.mod asks for) and node with npm,
# which builds the page (ui/) into web/ for the binary to embed. The version is
# in VERSION. TSUM_GITHUB_CLIENT_ID is the GitHub OAuth app the Share dialog
# signs in through; public, and empty turns the dialog's sign-in off.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${TSUM_STATS_REPO:-TsumTsumScripts/tsum-stats}"
GITHUB_CLIENT_ID="${TSUM_GITHUB_CLIENT_ID:-}"
TARGETS="darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64"

PUBLISH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --publish) PUBLISH=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "error: $*" >&2; exit 1; }
command -v go >/dev/null || die "go is not on PATH"
command -v npm >/dev/null || die "npm is not on PATH (it builds the page)"
sha256_of() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
size_of() { wc -c < "$1" | tr -d ' '; }

VERSION="$(tr -d ' \r\n' < "$root/VERSION")"
TAG="v$VERSION"
BASE="https://github.com/$REPO/releases/download/$TAG"
# The newest release's copy of the pin, wherever it was published.
UPDATE_URL="https://github.com/$REPO/releases/latest/download/tsum-stats.txt"
OUT="$root/build/$VERSION"

( cd "$root/ui" && npm ci && npm run build )
[ -n "$GITHUB_CLIENT_ID" ] || echo "note: TSUM_GITHUB_CLIENT_ID is not set, so this build's Share dialog cannot sign in to GitHub"
( cd "$root" && go vet ./... && go test ./... )

rm -rf "$OUT" && mkdir -p "$OUT"
PIN="$OUT/tsum-stats.txt"
{
  echo "# Where Tsum Tsum Stats updates itself from."
  echo "#"
  echo "# One binary per system, checked against the sha256 here before it replaces"
  echo "# the running one. Written by tools/build.sh."
  echo "version=$VERSION"
} > "$PIN"
for t in $TARGETS; do
  os="${t%/*}" arch="${t#*/}" exe=""
  [ "$os" = windows ] && exe=".exe"
  name="tsum-stats-$os-$arch$exe"
  echo "building $name"
  ( cd "$root" && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
      go build -trimpath -ldflags "-s -w -X main.version=$VERSION -X main.githubClientID=$GITHUB_CLIENT_ID -X main.updateURL=$UPDATE_URL" -o "$OUT/$name" . )
  {
    echo "url_${os}_${arch}=$BASE/$name"
    echo "sha256_${os}_${arch}=$(sha256_of "$OUT/$name")"
    echo "size_${os}_${arch}=$(size_of "$OUT/$name")"
  } >> "$PIN"
done
cp "$PIN" "$root/tsum-stats.txt"

# Archives for people: the executable bit survives a tar.gz, so macOS and Linux
# users extract and run. The raw binaries above are what the updater and
# install.sh's fallback use.
for t in $TARGETS; do
  os="${t%/*}" arch="${t#*/}"
  if [ "$os" = windows ]; then
    stage="$(mktemp -d)"; cp "$OUT/tsum-stats-$os-$arch.exe" "$stage/tsum-stats.exe"
    ( cd "$stage" && zip -q "$OUT/tsum-stats-$os-$arch.zip" tsum-stats.exe )
  else
    stage="$(mktemp -d)"; cp "$OUT/tsum-stats-$os-$arch" "$stage/tsum-stats"; chmod +x "$stage/tsum-stats"
    tar -czf "$OUT/tsum-stats-$os-$arch.tar.gz" -C "$stage" tsum-stats
  fi
  rm -rf "$stage"
done

if [ "$PUBLISH" = 1 ]; then
  command -v gh >/dev/null || die "gh is needed to publish"
  gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 && die "release $TAG already exists; bump VERSION"
  # Binaries and pin in one release: the pin is only visible once it exists.
  gh release create "$TAG" --repo "$REPO" --title "Tsum Tsum Stats $VERSION" \
    --notes "Download the file for your system and run it. It opens in your browser and updates itself." \
    "$OUT"/*
  echo "published $TAG"
fi

echo "built tsum-stats $VERSION into ${OUT#$root/}"
