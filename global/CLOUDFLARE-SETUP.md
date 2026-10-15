# Setting up the global site on Cloudflare

The global Tsum Tsum Stats site is one Worker, `tsum-global`, with one D1
database and one R2 bucket of the same name, on `tsum-stats.gapscripts.app`.
It lives on your **personal** Cloudflare account, the one that owns
`gapscripts.app`. Nothing here may touch the GAP account: `gapapp.app`, the
`gap-companion` and `gap-tester-gate` Workers, the `gap-companion` database,
the `app-assets` and `gap-testers` buckets. Read [Never](#never) before you
start.

You do this once, by hand. Afterwards the site is deployed by the GAP
Devkit's **Tsum Tsum global stats** card (step 5); `./deploy.sh` does the same
from a terminal, only for when the Devkit is not available. Both run every
Cloudflare command on a scoped API token, never on `wrangler login`, so
whatever account an OAuth login points at (the GAP account, on this computer)
is never used.

You need Node 22 or newer and a terminal in `global/`. How the Worker works is
in [README.md](README.md); every shape it uses is in [CONTRACT.md](CONTRACT.md).

## 1. Sign in and make a token

1. Sign in at <https://dash.cloudflare.com>. If your login has more than one
   account, pick the personal one on **Account home**.
   - **Check:** Account home → **Domains** lists `gapscripts.app` and not
     `gapapp.app`. If you see `gapapp.app`, you are in the GAP account: switch.
   - **Check:** **Domains → gapscripts.app → DNS → Records** has no record
     named `tsum-stats`. The first deploy makes it. Run from the Devkit, not
     a terminal, wrangler has Cloudflare replace a record of that name (or
     take the name from another Worker) without asking, so nothing else may
     use it.
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

   Name it `tsum-global deploy` and give it these permissions, all on the
   account, none on a zone. The newer token page groups them by product, with
   a Read / Edit (or Write) box on each; the older one has an Account / Zone
   dropdown per row.

   | Permission (newer page) | Older page | Used for |
   |:--|:--|:--|
   | Workers Editor | Account · Workers Scripts · Edit | The Worker, its secrets, attaching the custom domain |
   | D1 Write | Account · D1 · Edit | `d1 create`, the migrations |
   | Workers R2 Storage Write | Account · Workers R2 Storage · Edit | `r2 bucket create` |
   | Account Settings Read | Account · Account Settings · Read | `wrangler whoami` lists the account, which the deploy checks |
   | Workers Tail Read | Account · Workers Tail · Read | Optional: only `wrangler tail` needs it |

   Leave everything under **DNS & Zones** (Account DNS Settings, DNS View,
   Registrar …) unticked.

   No zone permissions, on purpose. For the `custom_domain` route, every
   deploy with wrangler (4.145) makes two account-level calls on the Worker,
   even once the domain is attached:
   `POST /accounts/<id>/workers/scripts/tsum-global/domains/changeset` (what
   would change) and `PUT …/tsum-global/domains/records` (the attach).
   Cloudflare then creates the DNS record and certificate on the zone itself;
   its API reference lists only Workers Scripts for attaching a domain. Some
   scoped tokens are reported to fail there anyway. If the first deploy stops
   at attaching `tsum-stats.gapscripts.app`, attach it once by hand (step 5)
   before anything else; step 5 also says what to do if deploys still fail
   there.
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
prints `1`. The Devkit card and `deploy.sh` refuse the file unless it is
mode 600.

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
  account id and this step the database id; the deploy refuses any left.
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

The first deploy uploads both (`wrangler deploy --secrets-file`). Afterwards
a deploy sends one only while the Worker lacks it, and never one the Worker
has, so a later deploy can never change `DEVICE_KEY`. Keep `secrets.env`: the
Devkit card is "not set up" without it. Do not set these first values with
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

**Push first.** The deploy builds a commit from GitHub, not your working
tree: commit `wrangler.jsonc` (steps 2 and 3) and push the branch with
`global/` (`git push -u origin global-stats` until it is merged into `main`,
which has no `global/` before that).

**Plan, then deploy the card in the Devkit.** Start the GAP Devkit
(`tools/devkit/start.sh` of the GAP folder beside this repo, then
<http://127.0.0.1:8791>, **Release**), pick
**Tsum Tsum global stats** and choose the branch or commit. It offers `main`
once `main` has `global/`, and until then the newest branch on origin that
has it. Until steps 1 and 4 are done the card says "not set up" and lists
what is missing. **Plan** it
and read the plan: what is live (`no Worker yet` the first time) and the
commit it would deploy. Then **Deploy** it and confirm. `../tools/DEPLOYMENTS.md`
describes the card in full.

Before anything reads or changes Cloudflare, the card refuses to go on unless:

- `cloudflare.env` exists, is mode 600 and has `CLOUDFLARE_API_TOKEN=`, and
  `secrets.env` is mode 600 and has both secrets (at least 32 characters
  each);
- the commit's `wrangler.jsonc` has no `REPLACE_WITH_` left, a 32-hex
  `account_id`, the D1 `database_id`, only the custom domain
  `tsum-stats.gapscripts.app` and no `build` command (wrangler would run it
  with the token), and neither it nor `src/` mentions `gapapp.app`;
- `wrangler whoami`, on that token alone, runs on an API token that sees
  exactly one account, the one `wrangler.jsonc` pins.

Each wrangler command gets the token from `cloudflare.env` and no Cloudflare
variable from the Devkit's environment, so neither the `wrangler login` that
the Devkit's GAP cards use nor a token some shell exported is ever used, and
npm's install scripts and the page's build never get one. Then, in a worktree
of its own at the commit, it:

1. checks the worktree's `wrangler.jsonc` and `src/` the same way again;
2. builds the page in global mode (`cd ui && npm ci && npm run build:global`,
   into `global/site/`) and checks that it has the global tag;
3. checks that the worktree is still exactly the commit, apart from
   `global/site/` and `node_modules/`: the install scripts and the build run
   code that could change what wrangler reads. Then `npm ci` in `global/`,
   and the same check again;
4. applies the D1 migrations (`wrangler d1 migrations apply tsum-global
   --remote`);
5. deploys the Worker with its page, the cron trigger `5 * * * *` and the
   custom domain, tagged with the commit, plus the secrets the Worker lacks
   (both, the first time);
6. checks from outside: the page has the global tag, `/api/v1/me` without a
   key answers 401, and the Worker runs that commit. Only then does the card
   count the commit as live.

If a later deploy fails, the card rolls the Worker back to the version before
it; the migrations stay, as they only ever add. The first deploy has nothing
to roll back to: if it fails after the upload, the job ends **rollback
failed**, the new version stays up unchecked, and the plan then shows
`<commit> (not checked yet) → <commit>`. Fix what failed and deploy again:
the card deploys the same commit again (the secrets are not sent twice) and
checks it.

The first deploy also creates the `tsum-stats.gapscripts.app` DNS record and
its certificate, which can take a few minutes; the card's check waits up to
five for them.

**If it stops at the custom domain** (an authentication or permission error
while attaching `tsum-stats.gapscripts.app`, after the Worker itself
uploaded): the token has no zone permissions (step 1). Attach the domain once
by hand: **Workers & Pages → tsum-global → Settings → Domains & Routes → Add →
Custom domain → `tsum-stats.gapscripts.app`**, wait for it to show Active,
then deploy again. wrangler still sends the attach on every deploy (step 1),
so if deploys keep failing there, every one fails and the card rolls it
back. Then add zone permissions to the token (Workers Routes Edit, DNS Edit
and Zone Read, on `gapscripts.app` only; that needs a user API token if the
account token page offers no zone permissions) and deploy again. Workers Free
allows 5 cron triggers per account, and this Worker uses one. Every later
deploy is the same plan and deploy, and changes no secret.

**Without the Devkit**, `./deploy.sh` in `global/` makes the same token and
account checks and the same deploy, but from your working tree as it is, with
nothing checked afterwards and no rollback. It builds the page first, stops if
the build changed anything else in `global/` (or the `ui/` files the Worker
bundles), and runs `npm ci` in `global/` and the checks again before any
wrangler command. Use it only when the Devkit is not available:

```sh
./deploy.sh --check   # only the checks
./deploy.sh           # the migrations ask you to confirm: answer yes
```

**Check:** the plan showed `no Worker yet → <commit>` (or `<commit> (not
checked yet) → <commit>` when you deploy again after attaching the domain by
hand), and the job ends with the card **deployed**, its log saying
`tsum-stats.gapscripts.app runs <commit>`. A plan afterwards says **up to
date**. With `deploy.sh`, `--check` prints `deploy: the token sees only
account <id>` and `deploy: checks passed`, and the deploy ends with `deploy:
done.`

## 6. Check it works

```sh
H=https://tsum-stats.gapscripts.app
ADMIN_KEY=$(sed -n 's/^ADMIN_KEY=//p' ~/.config/tsum-global/secrets.env)
J='Content-Type: application/json'   # every POST says it is JSON, or gets 415

curl -s $H/ | grep -c '<meta name="tsum-global"'                         # 1: the global page
curl -s $H/api/v1/me; echo                                               # {"ok":false,"error":"unauthorized"}
curl -s -o /dev/null -w '%{http_code}\n' $H/data/global/archive/x.json   # 404: the archive is never served
```

**The manifest** appears after the first hourly run, at 5 past the hour. To
make it now, run the job by hand. Its reply is the run's report, with
`"manifest":true` the first time:

```sh
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -H "$J" -d '{}' $H/api/v1/admin/rollup; echo
curl -s $H/data/global/manifest.json; echo                     # "rounds":0,"contributors":0 until uploads arrive
curl -sI $H/data/global/manifest.json | grep -i cache-control   # public, max-age=300
```

**A test contributor.** Join, send one made-up round, then remove both. **Ban
it before unlinking**: a banned contributor's rounds are deleted when it
unlinks, while an active contributor's unlinked rounds stay in the public
figures for good.

```sh
JOINED=$(curl -s -X POST -H "$J" -d '{"client":"setup-check"}' $H/api/v1/join); echo "$JOINED"   # {"ok":true,"id":1,"key":"…"}
ID=$(printf '%s' "$JOINED" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
KEY=$(printf '%s' "$JOINED" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')

# One round of Mickey that started 3 minutes ago: its id is a UUIDv7 of that time.
NOW=$(date -u +%s)
T=$(printf '%012x' $(( (NOW - 180) * 1000 )))
RID="${T:0:8}-${T:8:4}-7000-8000-00000000c0de"
END=$(date -u '+%Y-%m-%d %H:%M:%S')
curl -s -X POST -H "Authorization: Bearer $KEY" -H "$J" $H/api/v1/rounds -d '{"schema":"gap.round-stats/1","records":[
  {"id":"'"$RID"'","datetime":"'"$END"'","script_version":"setup-check","skill_type":"","tsum":"mickey","build":"global",
   "duration_seconds":"175","score":"1000000","base_coins":"1000","final_coins":"1500","medals":"0"}]}'; echo
                                                                   # {"ok":true,"accepted":1,"unchanged":0,…,"retry":[]}
curl -s -H "Authorization: Bearer $KEY" $H/api/v1/me; echo         # "rounds":1,…,"devices":1

curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -H "$J" -d "{\"id\":$ID}" $H/api/v1/admin/ban; echo   # "status":"banned"
curl -s -X POST -H "Authorization: Bearer $KEY" -H "$J" -d '{}' $H/api/v1/me/unlink; echo                   # {"ok":true}
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -H "$J" -d '{}' $H/api/v1/admin/rollup; echo         # "unlinked":[1]
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
| D1: 100,000 rows written a day | `BUDGET_ROWS_PER_DAY`: 90,000 rows written a UTC day, everything the Worker does counted (each insert, change and delete, as D1 counts them). Uploads and joins stop at 65,000 (less `JOB_RESERVE_ROWS`, 25,000): past it they get `503 budget` until 00:00 UTC, and tsum-stats sends them later. The rest is the hourly job's |
| D1: 5 million rows read a day | About 11 a round in all (3 at upload, 8 for the job): about 850,000 at 80,000 rounds a day. Past `READ_BUDGET_PER_DAY` (4 million) the job puts off full recomputes, unlinks and the archive |
| D1: 50 queries per invocation | A run stops starting work at 45 queries or 40 R2 operations (`RUN_QUERY_BUDGET`, `RUN_R2_BUDGET`), and the next run carries on. An upload takes about 15 |
| D1: 500 MB a database | Rounds stay in D1 until it holds `RETAIN_ROWS` (3,000,000, about 290 MB), then the oldest archived days leave it. The day tables stay for good (below) |
| D1: 2 MB in one value | Nothing over `VALUE_MAX_BYTES` (1.5 MB) is built: a long part is split into several files, an archive day into pieces |
| Workers: 100,000 requests a day, 10 ms CPU each (cron runs too) | Uploads are hourly per player, at most 100 rounds a request, plus one `/api/v1/me`; a page view reads two or three data files. The page's own files are static assets, which are free and not counted. D1 builds every JSON file, so the Worker's CPU stays flat |

D1's daily limits are the account's, over all its databases. If the personal
account gets another D1 database, lower `BUDGET_ROWS_PER_DAY` by what it
writes.

**How many rounds a day that is.** Writes run out first. Measured in
Miniflare with D1's own counts (`test/volume.test.ts`, and the same day at
other sizes), every player sending around the clock:

- An upload writes a row per round, plus about 5 per request (its `pending`
  sums, the devices, the contributor, the budget).
- The hourly job adding new rounds in writes about 15 to 25 rows for each
  player who sent some that hour (the `cells`, `bins` and `contrib_cells` rows
  they change), however many rounds they sent.
- So each **player-hour** (a player whose hourly pass had new rounds) costs
  about 25 rows on top of the rounds themselves: 70 players wrote 67,700 rows
  in a day for 30,000 rounds, 20 players 32,900 for 20,000.
- Once D1 holds `RETAIN_ROWS` rounds, each archived day is deleted from D1:
  one more row a round. At V rounds a day that starts after about 3,000,000 / V
  days (100 days at 30,000 a day), and then goes on every day.

Uploads stop once the day's writes, the job's included, reach 65,000. With H
player-hours a day, Free takes about **65,000 − 25 × H rounds a day** at
first, and about **half that** once D1 holds `RETAIN_ROWS` rounds:

| Players | Rounds a day, the first months | Once D1 holds 3 million rounds |
|:--|--:|--:|
| 20, sending 8 hours a day (H = 160) | about 61,000 | about 30,000 |
| 50, 8 hours a day (H = 400) | about 55,000 | about 27,000 |
| 100, 8 hours a day (H = 800) | about 45,000 | about 22,000 |
| 70, around the clock (H = 1,680) | about 23,000 | about 11,000 |

Those are ceilings, not a forecast: a player sending 8 hours a day has a few
hundred rounds. Each contributor may add 5,000 rounds a UTC day
(`QUOTA_PER_CONTRIBUTOR`, `429 quota`), so one player cannot use up the
budget.

**Storage** is the other limit. A round takes about 95 bytes in D1, so 3
million take about 290 MB. The day tables (`cells`, `bins`, `contrib_cells`)
are kept for good, archived days' too, and grow with how many players send
how many different Tsums, skill levels and items: measured about 190 KB a day
for 10 players sending around the clock, 570 KB for 40 and 680 KB for 70,
most of it `bins`. That is 70 to 250 MB a year, so with `RETAIN_ROWS` rounds
held, the larger sizes reach 500 MB in about a year. Lower `RETAIN_ROWS` to
make room (the deletes then start sooner), or move to Paid.

Where to look:

- **Storage & Databases → D1 SQL Database → tsum-global → Metrics**: rows read
  and rows written per day, against 5 million and 100,000, and the database
  size, against 500 MB.
- **Workers & Pages → tsum-global → Metrics**: requests per day, against
  100,000, errors and CPU time. A run that passes 10 ms shows as an
  exceeded-CPU error, in Observability too.
- **R2 Object Storage → tsum-global → Metrics**: storage (10 GB free) and
  operations.
- The budget, in a shell set up as in step 2. A `rows` figure near 65,000
  means uploads are about to be refused; one near 90,000, that the job is
  putting work off:

  ```sh
  npx wrangler d1 execute tsum-global --remote --command "SELECT day, rows, reads FROM budget ORDER BY day DESC LIMIT 7"
  ```

- The hourly run's report, in the logs (`rollup {…}`): `errors` lists any
  step that failed, and `more: true` on run after run means work is waiting
  for budget.

Once an account passes D1's free daily limits, every query fails until 00:00
UTC: uploads and the rollup stop for the rest of the day. The budget is there
so that writes never get that far.

**The account moved to Workers Paid on 2026-10-15**, and `wrangler.jsonc`
now has the Paid numbers below (quota 250,000, budget 1,500,000, reserve
375,000, reads 500 million, `RETAIN_ROWS` 30 million, 500 queries and R2
operations a run). The Free table above is what `test/tunables.json` still
uses. Raising the numbers is not optional: the plan change alone leaves
the Free caps in place, the 5,000-round quota included.

**Move to Workers Paid** ($5 a month) when uploads keep getting `503 budget`
(the players' dialogs say the daily limit is reached), when the database
passes about 400 MB, when rows read approach 5 million a day, or when runs
log exceeded CPU. Upgrade on the personal account under **Workers & Pages →
Plans**. Nothing in the code changes. Then:

- raise `QUOTA_PER_CONTRIBUTOR`: 5,000 rounds a day was a share of Free's
  budget, and holds back a player sending their whole history;

- raise `BUDGET_ROWS_PER_DAY` in `wrangler.jsonc`: Paid includes 50 million
  rows written a month, about 1.6 million a day; keep `JOB_RESERVE_ROWS`
  about a quarter of it;
- raise `READ_BUDGET_PER_DAY` (Paid includes 25 billion rows read a month)
  and `RETAIN_ROWS` (a Paid database may grow to 10 GB, though storage past
  5 GB is billed);
- raise `RUN_QUERY_BUDGET` and `RUN_R2_BUDGET`, so each run does more: Paid
  allows 1,000 D1 queries and 10,000 subrequests per invocation.
  `VALUE_MAX_BYTES` stays: D1's limit on one value is the same on Paid;
- know what those caps do not cover. They hold D1 inside Paid's included
  amounts, but nothing caps Worker requests, CPU time or R2 reads: on Free a
  flood is stopped at 100,000 requests a day, on Paid it is billed (past 10
  million requests a month, $0.30 a million; past 10 million R2 reads, $0.36
  a million). Normal traffic is far below that. If a scraper ever shows up,
  a rate-limiting rule on `tsum-stats.gapscripts.app` is the fix;
- commit and push what you changed, and deploy (step 5).

## 8. After launch

1. **Release order.** A tsum-stats built from this branch sends rounds to
   `https://tsum-stats.gapscripts.app` once its player joins. Release it only
   after step 6 passes.
   - **A new Tsum.** The Worker knows the Tsums of the `catalog.json` it was
     deployed with. Rounds of a newer one are kept, but stay out of the
     public figures until a deploy knows it. When the script learns a Tsum,
     update `ui/public/data/catalog.json`, push it and deploy (step 5), then
     `POST /api/v1/admin/rebuild` with `{}` (README, *Admin routes*).
2. **The website.** Add the Global stats link and the contribute section:
   [WEBSITE-LINKS.md](WEBSITE-LINKS.md) has the exact edits for
   `../tsum-tsum-website`.
3. **DEPLOYMENTS.md**: done, nothing to record. `../tools/DEPLOYMENTS.md`,
   which every repo reads before a deploy, lists the global stats as the
   personal account's under **Rules first → Two Cloudflare accounts**, and
   **Per part → Tsum Tsum global stats** has the Devkit card: its token and
   secrets files, what live means, the rollback, that the branch must be on
   origin, and that it goes before a tsum-stats release with Contribute.

## Never

- **`wrangler login`** for this project, or any wrangler command on an OAuth
  login. Every command runs on the token in `cloudflare.env`.
- **A bare `npx wrangler …` in a shell not set up as in step 2.** A
  `CLOUDFLARE_API_TOKEN` left from GAP work, or the OAuth login, would be used
  instead. The Devkit card and `deploy.sh` are safe either way: they read the
  token file themselves.
- **A GAP-account token in `cloudflare.env`**, or a token for this project
  that can see the GAP account.
- **Routes, custom domains or DNS records on `gapapp.app`**, or a GAP name
  (`gap-companion`, `gap-tester-gate`, `app-assets`, `gap-testers`) as a value
  in `wrangler.jsonc`. The Devkit card refuses both; `deploy.sh` refuses
  `gapapp.app`, and the names are up to you.
- **Changing `DEVICE_KEY`.** Rounds sent again would count twice. If the
  Worker is ever deleted and made again, put the same value back from your
  password manager.
- **A public URL or custom domain on the `tsum-global` bucket.** `archive/`
  holds every round as it was sent.
- **`workers_dev` or `preview_urls`** turned on: the site has one address.
- **A `build` command in `wrangler.jsonc`.** `wrangler deploy` runs it with
  the token in its environment. The Devkit card and `deploy.sh` refuse it.

## Working on it locally

No account and no token: see [README.md](README.md#running-it-locally).
