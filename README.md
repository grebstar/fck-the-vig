# FCK The Vig — Parlay Price Check (demo)

Build a parlay once and see what it pays at every sportsbook and prediction market, ranked best to worst.

- **Sports:** NFL, NBA, NHL, college football, college basketball: spreads, moneylines, totals, plus player props for the next few games (college basketball props are off on the free plan)
- **Books (default):** DraftKings, FanDuel, BetMGM, theScore Bet, BetRivers, Hard Rock Bet
- **Exchanges (default):** Kalshi, Polymarket (US), Novig, ProphetX
- **Data:** [The Odds API](https://the-odds-api.com)
- **Hosting:** GitHub Pages. A scheduled GitHub Action pulls fresh odds and redeploys the site.

The site loads `docs/data/odds.json`, which the GitHub Action writes from live odds. Until the first update runs, the page says it is waiting for odds. Made-up test data lives in `test/` and is never deployed.

## How it works

```
GitHub Action (on a schedule)
  └─ scripts/fetch-odds.mjs  → calls The Odds API with your secret key
       └─ writes docs/data/odds.json → commits it → deploys docs/ to GitHub Pages
Browser
  └─ docs/index.html + js/main.js → reloads odds.json every 60 s, builds parlays, ranks books
```

Your API key stays in GitHub Secrets and never reaches the browser.

## Setup (about 10 minutes)

1. **Get an API key.** Sign up at https://the-odds-api.com. The free plan is enough to start.
2. **Create a GitHub repo** (for example `fck-the-vig`). Make it **public**: free GitHub accounts only get Pages on public repos.
3. **Upload this folder** to the repo, including the hidden `.github` folder.
   - Website upload: on the repo page, click "Add file → Upload files" and drag in the contents of this folder. On a Mac, press **Cmd+Shift+.** in Finder to show the hidden `.github` folder first.
   - Command line, from inside this folder:
     ```
     git init && git add . && git commit -m "Initial demo" && git branch -M main
     git remote add origin https://github.com/<you>/fck-the-vig.git && git push -u origin main
     ```
4. **Add the key.** Go to Settings → Secrets and variables → Actions → New repository secret. Use the name `ODDS_API_KEY` and paste your key as the value.
5. **Turn on Pages.** Go to Settings → Pages → Build and deployment → Source and choose **GitHub Actions**.
6. **Run the first update.** Go to the Actions tab, enable workflows if GitHub asks, open "Update odds and deploy site", and click **Run workflow**.
7. **Open the site** at `https://<you>.github.io/fck-the-vig/`.

## How often it refreshes, and what it costs

According to The Odds API docs, each market costs 1 credit per region, and up to 10 bookmakers count as 1 region. Player props have to be requested one game at a time and cost 1 credit per prop market returned. Requests that return nothing are free.

**Current schedule ($30 plan, 20,000 credits/month, resets on the 7th).** One run every 2 hours at :17 past the hour (UTC), so 12:17 AM, 2:17 AM, ... Central:

- **Every run: game lines + props.** Game lines for every NFL, NBA and college football game in the next 14 days, plus college basketball games in the next 7 days, cost about 12 credits a run (about 4,300 a month).
- **Props** for games that start within 30 hours: up to 16 NFL games (pass, rush and receiving yards, anytime TD), 15 NBA games (points, rebounds, assists) and 12 college football games, about 3–4 credits per game. `fetch-odds.mjs` paces props: it sets aside credits for every remaining game-line run and the weekly futures until the next reset (`QUOTA_RESET_DAY`), splits the rest across the remaining runs, and refreshes the games with the oldest props first, so on a busy slate it rotates through them.

The script stops props first when credits run low, so game lines keep updating.

**Refresh now:** go to Actions → "Update odds and deploy site" → Run workflow, and pick all, lines or props.

**Changing the schedule:** if you edit the `cron:` line in `.github/workflows/update-odds.yml`, also update `RUN_EVERY_HOURS`, `RUN_MINUTE`, `LINES_RUNS_PER_DAY` and `PROPS_RUNS_PER_DAY` in the same file so the pacing and the site's "Good to know" panel stay right. GitHub won't schedule a job more often than every 5 minutes, and scheduled runs can start a few minutes late. (The old free-plan setup was one run a day at 16:47 UTC, lines every other day.)

The page itself checks for a newer odds file every 60 seconds.

## Optional settings

You can override the defaults with repository variables (Settings → Secrets and variables → Actions → Variables):

| Variable | Default |
|---|---|
| `SPORTS` | `americanfootball_nfl,basketball_nba,americanfootball_ncaaf,basketball_ncaab,icehockey_nhl` |
| `BOOKMAKERS` | `draftkings,fanduel,betmgm,espnbet,betrivers,hardrockbet,kalshi,polymarket_us,novig,prophetx` |
| `MARKETS` | `h2h,spreads,totals` |
| `DAYS_AHEAD` | `14` |
| `PROP_GAMES_NFL` / `PROP_GAMES_NBA` / `PROP_GAMES_NCAAF` / `PROP_GAMES_NHL` | `16` / `15` / `12` / `8` |
| `QUOTA_RESET_DAY` | `7` (day of the month your Odds API credits reset) |
| `PROP_WINDOW_HOURS` | `30` (only fetch props for games starting this soon) |

Adding an 11th to 20th bookmaker doubles the credit cost. Caesars (`williamhill_us`) and Fanatics are only available on paid plans.

## Known limitations

- **Parlay math is leg-by-leg.** Standard multi-game parlays pay the product of the leg prices, which is what the site calculates. Same-game parlays are priced by each book's own correlation model, so the site shows a warning when two legs come from the same game.
- **Exchange prices exclude fees.** Kalshi, Polymarket, Novig and ProphetX are priced leg-by-leg, and their native combo products may be priced differently.
- **The state filter is preliminary.** `docs/data/states.json` is an unverified starting list and must be checked against each state's regulator. Prediction markets are not filtered by state.
- **Different lines are listed separately.** When a book has a different line (for example -3 vs -2.5), it goes under "Different lines" instead of being ranked against books with the exact same bet.
- **Props cover only some games.** On the free plan, props are fetched for the next few games per sport only. Exchanges and some books may not offer props in the feed.
- Boosts and DFS pick'em apps (PrizePicks, Underdog) are not included yet.

## Testing locally

The `test/` folder is in the project zip (C:\Users\coryg\code\fck-the-vig\test); it is not in this repo yet.

```
node test/mock-odds-api.mjs 8787 &      # fake Odds API with made-up games
ODDS_API_KEY=test ODDS_API_BASE=http://localhost:8787 OUT_FILE=test/sample-odds.json PROP_WINDOW_HOURS=72 node scripts/fetch-odds.mjs
cp test/sample-odds.json docs/data/      # local only: remove before committing
cd docs && python3 -m http.server 8000  # open http://localhost:8000
```
`test/ui-test.mjs` and `test/props-test.mjs` build parlays (game lines, and lines mixed with props) in a headless browser. It checks every displayed payout against an independent calculation, and it also checks the state filter and the phone layout.

## Saved bets, season-long markets and accounts

- **My bets.** Tap *Save to My bets* on a parlay (or *Save* on a season-long market) and pick the book you used. Saving needs a free account (see Membership below); bets are kept in the browser (`localStorage`) and in the account. Game lines and player props are graded automatically from ESPN's public final scores and box scores (`docs/js/grade.js`). If a team or player can't be matched, or a game is postponed, the leg is marked *Needs review* instead of guessing. Futures are settled by hand.
- **Season.** `scripts/fetch-futures.mjs` writes `docs/data/futures.json` on every scheduled run: championships, awards, stat leaders and win totals from Kalshi's public market data (free), plus sportsbook championship futures from The Odds API about once a week (about 3 credits). Run it on demand with Actions → Run workflow → `futures`.
- **Accounts.** Needed to save bets. `worker/index.js` is a Cloudflare Worker with a D1 database (binding `DB`) served at `https://api.fckvig.com`. It stores a username, an email (used only for password resets), a salted PBKDF2 password hash and each user's bets, and syncs them across devices (newest edit wins). There's no account lockout; logins are only throttled per network (100 tries in 10 minutes). Password reset emails need either a Cloudflare Email Service binding named `EMAIL` (Workers Paid plan) or a Resend API key stored as the worker secret `RESEND_API_KEY`; until one is set, "Forgot password?" says resets aren't switched on yet. Local testing: `cd worker && npx wrangler dev --local --port 8787`, then serve `docs/` on `http://localhost:8000`.

Tests: `node test/grade-test.mjs` (grading rules), `node test/api-test.mjs` (accounts API against wrangler dev), `node test/features-test.mjs` (end to end in Playwright).

## Membership: Free and Unlimited

- **Free accounts** save 2 bets a day (worker constant `FREE_SAVES_PER_DAY`, or the worker variable of the same name). The count resets at midnight Central. Browsing odds, pricing parlays, alerts and grading are never limited. Saving a bet needs an account. The worker counts saves in `POST /api/bets/save` and in `/api/bets/sync` (bets it hasn't seen before), so the limit can't be skipped from the browser. Editing, grading or deleting a saved bet never counts. Bets saved in a browser before limits switched on (the `limits_start` row in `config`) merge into an account for free.
- **Unlimited** comes from one of three places, shown as `plan_source` on the user:
  - `stripe`: a subscription bought through Stripe Checkout. The webhook (`POST /api/billing/webhook`) re-reads the subscription from Stripe on every event and keeps Unlimited until 3 days past the paid period. Members manage or cancel through Stripe's customer portal. Deleting an account cancels its subscription first.
  - `code`: a secret code made on the admin page. Codes are stored hashed and shown in full only once. They aren't case-sensitive, and dashes are optional when typed. Each person can use a code once. A code can be single-use, limited to N people, or open to everyone, and can last forever or N days, with an optional last day to redeem.
  - `admin`: given by hand on the admin page.
- **Admin page:** `https://www.fckvig.com/admin.html`. It only works for the account whose email is in `ADMIN_EMAILS` (default `cory@fckvig.com`). The first such account to use it is pinned in `config.admin_ids`.
- **Prices on the site** are labels in `docs/js/main.js` (`PLAN_PRICE`, plus `COMPETITORS` for the comparison table). The amount actually charged is whatever price is set in Stripe, so keep the two in step.
- **iPhone app:** the app shows plan status only. It has no checkout and no code box, because App Store rules require Apple's in-app purchase for digital subscriptions sold inside an app and bar unlock codes there. Unlimited bought or redeemed on the website still works in the app.

### Turning on card payments (Stripe)
1. Create a Stripe account for GrebStar Ventures LLC. Describe the business accurately (odds comparison data subscription, takes no bets).
2. Products → add *fck the vig Unlimited* with a monthly recurring price (and an annual one if wanted). Copy the price IDs (`price_…`).
3. Settings → Billing → Customer portal: turn it on (let customers cancel and update cards).
4. Developers → Webhooks → add endpoint `https://api.fckvig.com/api/billing/webhook` with events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy its signing secret (`whsec_…`).
5. Cloudflare → Workers → `fckvig-api` → Settings → Variables and Secrets: add secrets `STRIPE_SECRET_KEY` (`sk_live_…`) and `STRIPE_WEBHOOK_SECRET`, and variables `STRIPE_PRICE_MONTHLY` (and `STRIPE_PRICE_ANNUAL`).
Until all of these are set, the upgrade button says "Payments open soon", and codes and gifts still work. Test the whole flow with Stripe's test-mode keys first.

## Sports Book Arbitrage, search, sharing and alerts

- **Search.** Type a team or player above the board to find every bet for them across all sports.
- **Game tabs.** Each game has a *Team bets* tab (spread, moneyline, total) and a *Player props* tab.
- **Share.** *Share* on the parlay (or on an open saved bet) makes a link like `https://www.fckvig.com/#p=…`. Opening it loads the same legs, priced for the viewer's own state.
- **Sports Book Arbitrage** (`docs/js/odds-math.js`). *Sure things* are arbitrage: both sides of a bet at different books whose prices add up to less than 100% implied, with a stake split. *Beat the market* lists prices at least 2% better than the median no-vig price across 4+ books. Kalshi prices include its estimated fee (0.07 × P × (1 − P) per contract); other exchanges are shown before fees. Quotes far from the rest of the market are ignored.
- **Stats.** My bets breaks your settled record down by sport, by bet type, and by player-prop stat (hit rate, including legs inside parlays).
- **Line-move alerts.** Tap the bell on a leg. Alerts are stored by the worker; after every odds refresh, `scripts/check-alerts.mjs` compares them with the new odds and calls `/api/alerts/fire`, which sends web push (VAPID keys are generated by the worker and kept in D1) and/or email. The Action proves who it is with its GitHub OIDC token (audience `fckvig-api`, this repo, `main` branch), so there's no shared secret. Texts aren't offered: US carriers forbid gambling content on every business number type. On iPhone, push needs the site added to the Home Screen.
- **Page refresh.** The Action writes `docs/data/meta.json` with the time of the last odds and futures update, so open pages only download the big odds file when it changed.
