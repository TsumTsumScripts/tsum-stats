#!/usr/bin/env bash
# Builds and deploys the global site to the personal Cloudflare account, and
# nowhere else. CLOUDFLARE-SETUP.md has the one-time setup this expects.
#
# Every Cloudflare call runs on the scoped API token from
# ~/.config/tsum-global/cloudflare.env, never on a `wrangler login`, and the
# token must see exactly one account: the one wrangler.jsonc pins. The token
# is handed to each wrangler command alone (cf below), never exported, so
# npm's install scripts and the page's build never see it.
#
#   ./deploy.sh            check, build the page, migrate D1, deploy
#   ./deploy.sh --check    only the checks
set -euo pipefail

cd "$(dirname "$0")"
CONFIG_DIR="$HOME/.config/tsum-global"
TOKEN_FILE="$CONFIG_DIR/cloudflare.env"
SECRETS_FILE="$CONFIG_DIR/secrets.env"
export WRANGLER_SEND_METRICS=false

die() {
  echo "deploy: $*" >&2
  exit 1
}

# A file's permission bits, on Linux or macOS.
mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# A KEY=value line from an env file, without quotes; no file is sourced.
value() { sed -n "s/^[[:space:]]*\(export[[:space:]]*\)\{0,1\}$1=//p" "$2" | tail -n 1 | sed "s/^[\"']//; s/[\"'][[:space:]]*$//"; }

# ---- The token ----
# Nothing else may pick the account or the credentials, and no token the
# shell already exports reaches anything this script runs.
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CF_ACCOUNT_ID CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL CF_API_KEY CF_EMAIL CF_API_TOKEN
[ -f "$TOKEN_FILE" ] || die "no $TOKEN_FILE (CLOUDFLARE-SETUP.md, step 1)"
[ "$(mode "$TOKEN_FILE")" = "600" ] || die "$TOKEN_FILE must be mode 600: chmod 600 $TOKEN_FILE"
# A shell variable, not exported: only cf passes it on.
cf_token="$(value CLOUDFLARE_API_TOKEN "$TOKEN_FILE")"
[ -n "$cf_token" ] || die "$TOKEN_FILE has no CLOUDFLARE_API_TOKEN="

# wrangler, as package-lock.json pins it, with the token in its environment and no one else's.
cf() { CLOUDFLARE_API_TOKEN="$cf_token" npx wrangler "$@"; }

# ---- The configuration ----
grep -q 'REPLACE_WITH_' wrangler.jsonc && die "wrangler.jsonc still has REPLACE_WITH_ placeholders (CLOUDFLARE-SETUP.md, step 3)"
if grep -rqi 'gapapp\.app' wrangler.jsonc src; then
  die "wrangler.jsonc or src/ mentions gapapp.app: this project never touches the GAP account"
fi
ACCOUNT_ID="$(sed -n 's/^[[:space:]]*"account_id":[[:space:]]*"\([0-9a-f]\{32\}\)".*/\1/p' wrangler.jsonc)"
[ -n "$ACCOUNT_ID" ] || die "wrangler.jsonc has no 32-hex account_id"
grep -q '"pattern": "tsum-stats\.gapscripts\.app"' wrangler.jsonc || die "the route is not tsum-stats.gapscripts.app"

# ---- Wrangler, as package-lock.json pins it ----
npm ci --no-audit --no-fund

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
# DEVICE_KEY would re-key every device and contributor address. ----
SECRET_ARGS=()
NAMES="$(cf secret list --format json 2>/dev/null || echo '[]')"
if ! printf '%s' "$NAMES" | grep -q '"DEVICE_KEY"' || ! printf '%s' "$NAMES" | grep -q '"ADMIN_KEY"'; then
  [ -f "$SECRETS_FILE" ] || die "the Worker has no DEVICE_KEY/ADMIN_KEY yet and there is no $SECRETS_FILE (CLOUDFLARE-SETUP.md, step 4)"
  [ "$(mode "$SECRETS_FILE")" = "600" ] || die "$SECRETS_FILE must be mode 600"
  for name in DEVICE_KEY ADMIN_KEY; do
    [ "$(value "$name" "$SECRETS_FILE" | tr -d '\n' | wc -c)" -ge 32 ] || die "$SECRETS_FILE: $name must be at least 32 characters"
  done
  SECRET_ARGS=(--secrets-file "$SECRETS_FILE")
  echo "deploy: first deploy: the secrets come from $SECRETS_FILE"
fi

if [ "${1:-}" = "--check" ]; then
  echo "deploy: checks passed"
  exit 0
fi

# ---- The page, built in global mode into site/ ----
(cd ../ui && npm ci --no-audit --no-fund && npx vite build --mode global)
grep -q '<meta name="tsum-global"' site/index.html || die "site/index.html is not the global build"

# ---- D1, then the Worker ----
cf d1 migrations apply tsum-global --remote
cf deploy "${SECRET_ARGS[@]+"${SECRET_ARGS[@]}"}"

echo "deploy: done. https://tsum-stats.gapscripts.app/ (the first data appears after the next :05 rollup)"
