#!/usr/bin/env bash
# Builds and deploys the global site to the personal Cloudflare account, and
# nowhere else. CLOUDFLARE-SETUP.md has the one-time setup this expects.
# The GAP Devkit's Tsum Tsum global stats card is the deploy (it builds a pushed
# commit, checks the result and rolls back); this is for when the Devkit is not
# available, and builds this working tree as it is.
#
# Every Cloudflare call runs on the scoped API token from
# ~/.config/tsum-global/cloudflare.env, never on a `wrangler login`, and the
# token must see exactly one account: the one wrangler.jsonc pins. The token
# is handed to each wrangler command alone (cf below), never exported, so
# npm's install scripts and the page's build never see it. They run first, and
# everything wrangler reads is checked again after them: they may write here.
#
#   ./deploy.sh            check, build the page, migrate D1, deploy
#   ./deploy.sh --check    only the checks
set -euo pipefail

cd "$(dirname "$0")"
CONFIG_DIR="$HOME/.config/tsum-global"
TOKEN_FILE="$CONFIG_DIR/cloudflare.env"
SECRETS_FILE="$CONFIG_DIR/secrets.env"

die() {
  echo "deploy: $*" >&2
  exit 1
}

# A file's permission bits, on Linux or macOS.
mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# A KEY=value line from an env file, without quotes; no file is sourced.
value() { sed -n "s/^[[:space:]]*\(export[[:space:]]*\)\{0,1\}$1=//p" "$2" | tail -n 1 | sed "s/^[\"']//; s/[\"'][[:space:]]*$//"; }

# ---- The token ----
# Nothing else may pick the account, the credentials or the API host, and no
# token the shell already exports reaches anything this script runs: every
# variable wrangler reads such things from goes.
for v in $(compgen -e); do
  case "$v" in CLOUDFLARE_* | CF_* | WRANGLER_*) unset "$v" ;; esac
done
export WRANGLER_SEND_METRICS=false
[ -f "$TOKEN_FILE" ] || die "no $TOKEN_FILE (CLOUDFLARE-SETUP.md, step 1)"
[ "$(mode "$TOKEN_FILE")" = "600" ] || die "$TOKEN_FILE must be mode 600: chmod 600 $TOKEN_FILE"
# A shell variable, not exported: only cf passes it on.
cf_token="$(value CLOUDFLARE_API_TOKEN "$TOKEN_FILE")"
[ -n "$cf_token" ] || die "$TOKEN_FILE has no CLOUDFLARE_API_TOKEN="

# wrangler, as package-lock.json pins it (npm ci below; never npx, which would
# fetch one with the token in its environment), with the token and no one else's.
cf() { CLOUDFLARE_API_TOKEN="$cf_token" ./node_modules/.bin/wrangler "$@"; }

# ---- The configuration ----
check_config() {
  if grep -q 'REPLACE_WITH_' wrangler.jsonc; then
    die "wrangler.jsonc still has REPLACE_WITH_ placeholders (CLOUDFLARE-SETUP.md, step 3)"
  fi
  if grep -rqi 'gapapp\.app' wrangler.jsonc src; then
    die "wrangler.jsonc or src/ mentions gapapp.app: this project never touches the GAP account"
  fi
  ACCOUNT_ID="$(sed -n 's/^[[:space:]]*"account_id":[[:space:]]*"\([0-9a-f]\{32\}\)".*/\1/p' wrangler.jsonc)"
  [ -n "$ACCOUNT_ID" ] || die "wrangler.jsonc has no 32-hex account_id"
  grep -q '"pattern": "tsum-stats\.gapscripts\.app"' wrangler.jsonc || die "the route is not tsum-stats.gapscripts.app"
  # wrangler deploy runs a build command with its own environment, the token in it.
  if grep -q '"build"[[:space:]]*:' wrangler.jsonc; then
    die "wrangler.jsonc has a build command: wrangler deploy would run it with the token"
  fi
}

# wrangler reads a .env or .env.local here into its own environment (where a key and
# email would even win over the token), and takes a wrangler.json or a deploy redirect
# from any folder above here over wrangler.jsonc.
check_files() {
  local f d
  for f in .env .env.local; do
    [ ! -e "$f" ] || die "global/$f exists: wrangler would read it into its own environment; remove it"
  done
  d="$PWD"
  while :; do
    for f in wrangler.json .wrangler/deploy/config.json; do
      [ ! -e "$d/$f" ] || die "wrangler would read $d/$f instead of wrangler.jsonc; remove it"
    done
    [ "$d" != / ] || break
    d="$(dirname "$d")"
  done
}

# What the Worker is made of: global/ but what the build and npm ci write
# (site/, node_modules/, .wrangler/), and the ui files src/ bundles.
fingerprint() {
  local d dirs=(.)
  for d in ../ui/src ../ui/public; do [ ! -d "$d" ] || dirs+=("$d"); done
  find "${dirs[@]}" \( -path ./node_modules -o -path ./site -o -path ./.wrangler \) -prune -o -type f -exec cksum {} + | LC_ALL=C sort
}

check_config
check_files

# ---- The page, built in global mode into site/ ----
# Before anything has the token. ui's install scripts and the build may write
# anywhere, so what wrangler reads is checked again afterwards.
if [ "${1:-}" != "--check" ]; then
  BEFORE="$(fingerprint)"
  (cd ../ui && npm ci --no-audit --no-fund && npx vite build --mode global)
  grep -q '<meta name="tsum-global"' site/index.html || die "site/index.html is not the global build"
  [ "$(fingerprint)" = "$BEFORE" ] ||
    die "the page's build changed what the Worker is made of: $(diff <(printf '%s\n' "$BEFORE") <(fingerprint) | sed -n 's/^[<>] [0-9]* [0-9]* //p' | sort -u | head -n 5 | tr '\n' ' ')"
  check_config
  check_files
fi

# ---- Wrangler, as package-lock.json pins it ----
# After the build: npm ci replaces whatever node_modules its scripts left here.
npm ci --no-audit --no-fund
[ "${1:-}" = "--check" ] || [ "$(fingerprint)" = "$BEFORE" ] || die "npm ci changed what the Worker is made of"
check_files

# ---- The account the token sees ----
WHOAMI="$(cf whoami --json)" || die "wrangler whoami failed: is the token valid?"
SEEN="$(printf '%s' "$WHOAMI" | node -e '
  let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => {
    const w = JSON.parse(s);
    if (!w.loggedIn || !/API Token/.test(w.authType || "")) { console.log("not-a-token"); return; }
    console.log((w.accounts || []).map(a => a.id).join(" "));
  });')"
[ "$SEEN" != "not-a-token" ] || die "wrangler is not using the API token"
[ "$SEEN" = "$ACCOUNT_ID" ] || die "the token must see exactly one account, $ACCOUNT_ID; it sees: ${SEEN:-none}"
echo "deploy: the token sees only account $ACCOUNT_ID"

# ---- Secrets: set once. After that a deploy never changes them, since a new
# DEVICE_KEY would re-key every device and contributor address: only the ones the
# Worker lacks are sent, and wrangler keeps the others. ----
SECRET_ARGS=()
if ! NAMES="$(cf secret list --format json 2>&1)"; then
  # No Worker yet (the first deploy) means no secrets; any other failure stops here.
  [[ "$NAMES" == *'Worker "tsum-global"'*'not found'* ]] ||
    die "wrangler secret list failed: $(printf '%s\n' "$NAMES" | grep -v '^[[:space:]]*$' | tail -n 3)"
  NAMES='[]'
fi
MISSING=()
for name in DEVICE_KEY ADMIN_KEY; do
  [[ "$NAMES" == *"\"$name\""* ]] || MISSING+=("$name")
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  [ -f "$SECRETS_FILE" ] || die "the Worker has no ${MISSING[*]} yet and there is no $SECRETS_FILE (CLOUDFLARE-SETUP.md, step 4)"
  [ "$(mode "$SECRETS_FILE")" = "600" ] || die "$SECRETS_FILE must be mode 600"
  SEND="$(mktemp -d)"
  trap 'rm -rf "$SEND"' EXIT
  : > "$SEND/secrets.env"
  chmod 600 "$SEND/secrets.env"
  for name in "${MISSING[@]}"; do
    [ "$(value "$name" "$SECRETS_FILE" | tr -d '\n' | wc -c)" -ge 32 ] || die "$SECRETS_FILE: $name must be at least 32 characters"
    # Its line as secrets.env has it, so wrangler reads the same value.
    grep "^[[:space:]]*\(export[[:space:]]*\)\{0,1\}$name=" "$SECRETS_FILE" | tail -n 1 >> "$SEND/secrets.env"
  done
  SECRET_ARGS=(--secrets-file "$SEND/secrets.env")
  echo "deploy: the Worker has no ${MISSING[*]} yet: they come from $SECRETS_FILE"
fi

if [ "${1:-}" = "--check" ]; then
  echo "deploy: checks passed"
  exit 0
fi

# ---- D1, then the Worker ----
cf d1 migrations apply tsum-global --remote
cf deploy "${SECRET_ARGS[@]+"${SECRET_ARGS[@]}"}"

echo "deploy: done. https://tsum-stats.gapscripts.app/ (the first data appears after the next :05 rollup)"
