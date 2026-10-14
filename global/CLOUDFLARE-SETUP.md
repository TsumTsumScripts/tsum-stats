# Setting up the global site on Cloudflare

The global Tsum Tsum Stats site is one Worker, `tsum-global`, with one D1
database and one R2 bucket of the same name, on `tsum-stats.gapscripts.app`.
It lives on your **personal** Cloudflare account, the one that owns
`gapscripts.app`. Nothing here may touch the GAP account: `gapapp.app`, the
`gap-companion` and `gap-tester-gate` Workers, the `gap-companion` database,
the `app-assets` and `gap-testers` buckets. Read [Never](#never) before you
start.

You do this once, by hand. Afterwards `./deploy.sh` is how the site is
deployed. Every Cloudflare command runs on a scoped API token, never on
`wrangler login`, so whatever account an OAuth login points at is never used.

You need Node 22 or newer and a terminal in `global/`. How the Worker works is
in [README.md](README.md); every shape it uses is in [CONTRACT.md](CONTRACT.md).

## 1. Sign in and make a token

1. Sign in at <https://dash.cloudflare.com>. If your login has more than one
   account, pick the personal one on **Account home**.
   - **Check:** Account home → **Domains** lists `gapscripts.app` and not
     `gapapp.app`. If you see `gapapp.app`, you are in the GAP account: switch.
   - **Check:** **Domains → gapscripts.app → DNS → Records** has no record
     named `tsum-stats`. The first deploy makes it, and a custom domain cannot
     be made over an existing CNAME.
2. Copy the **Account ID**: **Domains → gapscripts.app → Overview**, the
   **API** section near the bottom (32 hex characters). Workers & Pages →
   **Account Details** shows it too. You need it in step 2.
3. Create the token. Either kind works:
   - **An account API token** (better: it belongs to the personal account, so
     it can never reach another one): **Manage Account → Account API Tokens →
     Create Token → Create Custom Token**.
   - **A user API token**: **My Profile → API Tokens → Create Token → Create
     Custom Token**, with **Account Resources: Include →** the personal
     account, and only that one.

   Name it `tsum-global deploy` and give it these permissions:

   | Scope | Permission | Access | Used for |
   |:--|:--|:--|:--|
   | Account | Workers Scripts | Edit | The Worker, its secrets, attaching the custom domain |
   | Account | D1 | Edit | `d1 create`, the migrations |
   | Account | Workers R2 Storage | Edit | `r2 bucket create` |
   | Account | Account Settings | Read | `wrangler whoami` lists the account, which `deploy.sh` checks |
   | Account | Workers Tail | Read | Optional: only `wrangler tail` needs it |
   | Zone | Workers Routes | Edit | The custom domain |
   | Zone | DNS | Edit | The custom domain's DNS record |
   | Zone | Zone | Read | Finding the zone |

   **Zone Resources: Include → Specific zone → `gapscripts.app`.** No other
   zone.

   Why the zone permissions: for a `custom_domain` route, wrangler (4.151)
   makes one account-level call,
   `POST /accounts/<id>/workers/scripts/tsum-global/domains/changeset`, and
   looks up no zone itself. Cloudflare then creates the DNS record and the
   certificate on the zone. Cloudflare's API reference lists only Workers
   Scripts Edit for attaching a domain, but scoped tokens are reported to fail
   at that step without Workers Routes and DNS Edit on the zone. So grant both,
   on this one zone.
4. **Continue to summary → Create Token**, and copy the token: it is shown
   once. With it on the clipboard (macOS), save it outside the repo, readable
   only by you. `$(pbpaste)` keeps it out of your shell history:

   ```sh
   mkdir -p ~/.config/tsum-global && chmod 700 ~/.config/tsum-global
   printf 'CLOUDFLARE_API_TOKEN=%s\n' "$(pbpaste)" > ~/.config/tsum-global/cloudflare.env
   chmod 600 ~/.config/tsum-global/cloudflare.env
   ```

**Check:** `ls -l ~/.config/tsum-global/cloudflare.env` shows `-rw-------`,
and `grep -c '^CLOUDFLARE_API_TOKEN=.\{30,\}' ~/.config/tsum-global/cloudflare.env`
prints `1`. `deploy.sh` refuses the file unless it is mode 600.

## 2. Pin the account

1. In `global/wrangler.jsonc`, replace `REPLACE_WITH_PERSONAL_ACCOUNT_ID` with
   the Account ID from step 1. It stays pinned there, so a token for any other
   account fails every command and the deploy.
2. Open a shell in `global/` that uses only the token. Do this in every new
   terminal before any `npx wrangler` command for this project:

   ```sh
   unset CLOUDFLARE_ACCOUNT_ID CF_ACCOUNT_ID CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL CF_API_KEY CF_EMAIL CF_API_TOKEN
   set -a; . ~/.config/tsum-global/cloudflare.env; set +a
   export WRANGLER_SEND_METRICS=false
   npm ci
   npx wrangler whoami
   ```

**Check:** `whoami` says you are logged in with a *User API Token* or an
*Account API Token*, read from `CLOUDFLARE_API_TOKEN`, not OAuth. Its table
lists **exactly one account**, with the Account ID you put in `wrangler.jsonc`.
A user token may add that it cannot read your email; that is fine. Stop and fix
the token's Account Resources (step 1) if it lists the GAP account, lists more
than one account, or warns that the `account_id` in your configuration matches
none of your accounts.

## 3. The database and the bucket

In the shell from step 2:

```sh
npx wrangler d1 create tsum-global --update-config=false
npx wrangler r2 bucket create tsum-global --update-config=false
```

`--update-config=false` stops wrangler offering to add the bindings:
`wrangler.jsonc` has them already.

1. `d1 create` prints a snippet with `"database_id": "…"`. In
   `wrangler.jsonc`, replace `REPLACE_WITH_D1_DATABASE_ID` with it.
2. Commit `wrangler.jsonc`. Neither id is a secret.

**Check:**

- `grep -c REPLACE_WITH_ wrangler.jsonc` prints `0`. Step 2 replaced the
  account id and this step the database id; `deploy.sh` refuses any left.
- `npx wrangler d1 list` and `npx wrangler r2 bucket list` show `tsum-global`.
- In the dashboard, **Storage & Databases → D1 SQL Database** and **R2 Object
  Storage** each list `tsum-global`. The bucket's **Settings** show the public
  development URL disabled and no custom domain. It stays that way: the
  Worker serves `data/global/*` from it and never `archive/`.

## 4. The two secrets

```sh
umask 077
{
  echo "DEVICE_KEY=$(openssl rand -base64 32)"
  echo "ADMIN_KEY=$(openssl rand -base64 32)"
} > ~/.config/tsum-global/secrets.env
chmod 600 ~/.config/tsum-global/secrets.env
```

- **`DEVICE_KEY`** keys the HMAC that replaces each round id's device tag,
  and hashes join addresses and archive names. **It must never change.** Under
  a new one, a round sent again gets a new key, so it is no longer seen as a
  duplicate and counts twice, and every device looks new. Cloudflare never
  shows a secret again, so put a copy in your password manager now. With
  `secrets.env`, it is the only copy.
- **`ADMIN_KEY`** opens `/api/v1/admin/*`. Keep it in your password manager
  too.

`deploy.sh` uploads both with the first deploy (`wrangler deploy
--secrets-file`), and afterwards only while the Worker lacks one, so a later
deploy can never change `DEVICE_KEY`. Do not set these first values with
`wrangler secret put`: before the first deploy there is no Worker, and `secret
put` would create an empty placeholder one.

To change `ADMIN_KEY` later, in a shell set up as in step 2, run `npx wrangler
secret put ADMIN_KEY` and paste a new `openssl rand -base64 32`. Then update
`secrets.env` and the password manager. Editing `secrets.env` alone changes
nothing.

**Check:** `ls -l ~/.config/tsum-global/secrets.env` shows `-rw-------`;
`sed -n 's/=.*//p' ~/.config/tsum-global/secrets.env` prints `DEVICE_KEY` and
`ADMIN_KEY`; both values are in your password manager.

## 5. Deploy

```sh
./deploy.sh --check   # only the checks
./deploy.sh
```

It reads the token from `cloudflare.env` itself, whatever your shell holds,
and refuses to go on unless:

- `cloudflare.env` exists, is mode 600 and has `CLOUDFLARE_API_TOKEN=`;
- `wrangler.jsonc` has no `REPLACE_WITH_` left, a 32-hex `account_id` and the
  route `tsum-stats.gapscripts.app`, and neither it nor `src/` mentions
  `gapapp.app`;
- `wrangler whoami` runs on an API token that sees exactly one account, the
  one `wrangler.jsonc` pins;
- the Worker has both secrets already, or `secrets.env` has them (mode 600, at
  least 32 characters each).

Then it:

1. builds the page in global mode (`cd ../ui && npm ci && npx vite build
   --mode global`, into `global/site/`) and checks that it has the global tag;
2. applies the D1 migrations (`wrangler d1 migrations apply tsum-global
   --remote`), which asks you to confirm: answer **yes**;
3. deploys the Worker with its page, the cron trigger `5 * * * *` and the
   custom domain, plus the secrets the first time.

The first deploy also creates the `tsum-stats.gapscripts.app` DNS record and
its certificate, which can take a few minutes. Workers Free allows 5 cron
triggers per account, and this Worker uses one. Every later deploy is the same
command and changes no secret.

**Check:** `--check` prints `deploy: the token sees only account <id>` and
`deploy: checks passed`, and the deploy ends with `deploy: done.`

## 6. Check it works

```sh
H=https://tsum-stats.gapscripts.app
ADMIN_KEY=$(sed -n 's/^ADMIN_KEY=//p' ~/.config/tsum-global/secrets.env)

curl -s $H/ | grep -c '<meta name="tsum-global"'                         # 1: the global page
curl -s $H/api/v1/me; echo                                               # {"ok":false,"error":"unauthorized"}
curl -s -o /dev/null -w '%{http_code}\n' $H/data/global/archive/x.json   # 404: the archive is never served
```

**The manifest** appears after the first hourly run, at 5 past the hour. To
make it now, run the job by hand. Its reply is the run's report, with
`"manifest":true` the first time:

```sh
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -d '{}' $H/api/v1/admin/rollup; echo
curl -s $H/data/global/manifest.json; echo                     # "rounds":0,"contributors":0 until uploads arrive
curl -sI $H/data/global/manifest.json | grep -i cache-control   # public, max-age=300
```

**A test contributor.** Join, send one made-up round, then remove both. **Ban
it before unlinking**: a banned contributor's rounds are deleted when it
unlinks, while an active contributor's unlinked rounds stay in the public
figures for good.

```sh
J=$(curl -s -X POST -d '{"client":"setup-check"}' $H/api/v1/join); echo "$J"   # {"ok":true,"id":1,"key":"…"}
ID=$(printf '%s' "$J" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
KEY=$(printf '%s' "$J" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')

# One round of Mickey that started 3 minutes ago: its id is a UUIDv7 of that time.
NOW=$(date -u +%s)
T=$(printf '%012x' $(( (NOW - 180) * 1000 )))
RID="${T:0:8}-${T:8:4}-7000-8000-00000000c0de"
END=$(date -u '+%Y-%m-%d %H:%M:%S')
curl -s -X POST -H "Authorization: Bearer $KEY" $H/api/v1/rounds -d '{"schema":"gap.round-stats/1","records":[
  {"id":"'"$RID"'","datetime":"'"$END"'","script_version":"setup-check","skill_type":"","tsum":"mickey","build":"global",
   "duration_seconds":"175","score":"1000000","base_coins":"1000","final_coins":"1500","medals":"0"}]}'; echo
                                                                   # {"ok":true,"accepted":1,"unchanged":0,…}
curl -s -H "Authorization: Bearer $KEY" $H/api/v1/me; echo         # "rounds":1,…,"devices":1

curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -d "{\"id\":$ID}" $H/api/v1/admin/ban; echo   # "status":"banned"
curl -s -X POST -H "Authorization: Bearer $KEY" $H/api/v1/me/unlink; echo                             # {"ok":true}
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -d '{}' $H/api/v1/admin/rollup; echo           # "unlinked":[1]
curl -s -H "Authorization: Bearer $ADMIN_KEY" $H/api/v1/admin/contributors; echo                     # "contributors":[]
curl -s $H/data/global/manifest.json; echo                                                           # "rounds":0 again
```

Contributor ids are never handed out twice, so the first real contributor is
#2. Joins are limited to 5 a day from one address.

In the personal account's dashboard, **Workers & Pages → tsum-global**:

- **Settings → Domains & Routes**: the custom domain
  `tsum-stats.gapscripts.app`, and no `workers.dev` or preview URL;
- **Settings → Trigger Events**: the cron `5 * * * *`;
- **Settings → Variables and Secrets**: `DEVICE_KEY` and `ADMIN_KEY` as
  secrets.

**Domains → gapscripts.app → DNS → Records** now has `tsum-stats`, of type
Worker. In the **GAP** account's dashboard there is no new Worker, database,
bucket or DNS record.

The logs are under **Workers & Pages → tsum-global → Observability**: each
hourly run logs `rollup {…}` with its report. Or run `npx wrangler tail` in a
shell set up as in step 2 (it needs the Workers Tail permission).

## 7. Watch the free-tier limits

The site starts on Workers Free, and its own limits keep it inside Free's:

| Free allows | The site |
|:--|:--|
| D1: 100,000 rows written a day | `BUDGET_ROWS_PER_DAY`: 80,000 rounds written a UTC day. Past it, uploads get `503 budget` until 00:00 UTC, and tsum-stats sends them later. The rollup's own writes come on top, which is why it is not 100,000 |
| D1: 5 million rows read a day | A rollup reads each changed day's rounds once, as a key range |
| D1: 50 queries per invocation | A run stops starting work at 45 queries or 40 R2 operations (`RUN_QUERY_BUDGET`, `RUN_R2_BUDGET`), and the next run carries on |
| D1: 500 MB a database | Only the last 60 days of rounds (`ACCEPT_DAYS`) stay in D1; older days move to the R2 archive |
| Workers: 100,000 requests a day, 10 ms CPU each (cron runs too) | Uploads are hourly per player, and a page view reads two or three data files. The page's own files are static assets, which are free and not counted. D1 builds every JSON file, so the Worker's CPU stays flat |

Apart from those, each contributor may add 5,000 rounds a UTC day
(`QUOTA_PER_CONTRIBUTOR`, `429 quota`), so one player cannot use up the
budget.

Where to look:

- **Storage & Databases → D1 SQL Database → tsum-global → Metrics**: rows read
  and rows written per day, against 5 million and 100,000, and the database
  size, against 500 MB.
- **Workers & Pages → tsum-global → Metrics**: requests per day, against
  100,000, errors and CPU time. A run that passes 10 ms shows as an
  exceeded-CPU error, in Observability too.
- **R2 Object Storage → tsum-global → Metrics**: storage (10 GB free) and
  operations.
- The budget guard, in a shell set up as in step 2. A `rows` figure near
  80,000 means it is about to refuse uploads:

  ```sh
  npx wrangler d1 execute tsum-global --remote --command "SELECT day, rows FROM budget ORDER BY day DESC LIMIT 7"
  ```

Once an account passes D1's free daily limits, every query fails until 00:00
UTC: uploads and the rollup stop for the rest of the day. The budget guard is
there so that writes never get that far.

**Move to Workers Paid** ($5 a month) when the budget guard starts refusing
uploads (the players' dialogs say the daily limit is reached), when the
database passes about 400 MB, when rows read approach 5 million a day, or when
runs log exceeded CPU. Upgrade on the personal account under **Workers & Pages
→ Plans**. Nothing in the code changes. Optionally, then:

- raise `BUDGET_ROWS_PER_DAY` in `wrangler.jsonc`: Paid includes 50 million
  rows written a month, about 1.6 million a day;
- raise `RUN_QUERY_BUDGET` and `RUN_R2_BUDGET`, so each run does more: Paid
  allows 1,000 D1 queries and 10,000 subrequests per invocation;
- run `./deploy.sh`.

## 8. After launch

1. **Release order.** A tsum-stats built from this branch sends rounds to
   `https://tsum-stats.gapscripts.app` once its player joins. Release it only
   after step 6 passes.
2. **The website.** Add the Global stats link and the contribute section:
   [WEBSITE-LINKS.md](WEBSITE-LINKS.md) has the exact edits for
   `../tsum-tsum-website`.
3. **Record it** in `../tools/DEPLOYMENTS.md`, which every repo reads before
   a deploy:
   - in **Rules first → Two Cloudflare accounts**, add to what the personal
     account owns: "the global stats (Worker, D1 and R2 `tsum-global`, on
     `tsum-stats.gapscripts.app`)";
   - under **Per part**, after *Tsum Tsum Stats*:

     ```md
     ### Tsum Tsum global stats (`tsum-stats/global`)
     - Worker `tsum-global` on `tsum-stats.gapscripts.app` (custom domain), D1 `tsum-global`,
       R2 `tsum-global` (private: the Worker serves `data/global/`, never `archive/`).
       Personal Cloudflare account.
     - **Local:** `cd global && npm run dev` (local D1 and R2; see `global/README.md`).
     - **Release:** not a Devkit card. `global/deploy.sh`, on the scoped token in
       `~/.config/tsum-global/cloudflare.env` (`global/CLOUDFLARE-SETUP.md`): checks the
       account, builds the page, migrates D1, deploys. Secrets `DEVICE_KEY` (never change it)
       and `ADMIN_KEY` are set once, from `~/.config/tsum-global/secrets.env`.
       Rollback = `wrangler rollback` in a shell set up as in CLOUDFLARE-SETUP.md step 2;
       migrations stay.
     ```

   DEPLOYMENTS.md's first rule says releases go through the Devkit, never a
   hand-run `wrangler deploy`. This Worker has no Devkit card, so either add
   one or keep the entry's "not a Devkit card" line, so the next session knows
   `deploy.sh` is the way.

## Never

- **`wrangler login`** for this project, or any wrangler command on an OAuth
  login. Every command runs on the token in `cloudflare.env`.
- **A bare `npx wrangler …` in a shell not set up as in step 2.** A
  `CLOUDFLARE_API_TOKEN` left from GAP work, or the OAuth login, would be used
  instead. `deploy.sh` is safe either way: it reads the token file itself.
- **A GAP-account token in `cloudflare.env`**, or a token for this project
  that can see the GAP account.
- **Routes, custom domains or DNS records on `gapapp.app`**, or a GAP name
  (`gap-companion`, `gap-tester-gate`, `app-assets`, `gap-testers`) anywhere in
  `wrangler.jsonc`. `deploy.sh` refuses `gapapp.app`; the rest is up to you.
- **Changing `DEVICE_KEY`.** Rounds sent again would count twice. If the
  Worker is ever deleted and made again, put the same value back from your
  password manager.
- **A public URL or custom domain on the `tsum-global` bucket.** `archive/`
  holds every round as it was sent.
- **`workers_dev` or `preview_urls`** turned on: the site has one address.

## Working on it locally

No account and no token: see [README.md](README.md#running-it-locally).
