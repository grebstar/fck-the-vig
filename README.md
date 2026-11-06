# FCK The Vig — Parlay Price Check (demo)

Build a parlay once and see what it pays at every sportsbook and prediction market, ranked best to worst.

- **Sports:** NFL, NBA, college football: spreads, moneylines, totals, plus player props for the next few games
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
  └─ docs/index.html + app.js → reloads odds.json every 60 s, builds parlays, ranks books
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

**Default schedule (free plan, 500 credits/month).** One run per day at 10:47 AM Central:

- **Odd days: game lines + props.** Game lines for every NFL, NBA and college football game in the next 7 days cost about 9 credits.
- **Every day: props** for the next games that start within 30 hours: 3 NFL games (pass, rush and receiving yards, anytime TD), 2 NBA games (points, rebounds, assists) and 1 college game. That costs roughly 3–4 credits per game.

That works out to roughly 135 credits a month for lines and 350 for props. The script stops props first when credits run low, so game lines keep updating.

**Refresh now:** go to Actions → "Update odds and deploy site" → Run workflow, and pick all, lines or props.

**On the $30 plan (20K credits)**, change both `cron:` lines in `.github/workflows/update-odds.yml` to one line, `"*/20 * * * *"`, so it runs every 20 minutes. Then raise `PROP_GAMES_NFL` and `PROP_GAMES_NBA` (see below). GitHub won't schedule a job more often than every 5 minutes, and scheduled runs can start a few minutes late.

The page itself checks for a newer odds file every 60 seconds.

## Optional settings

You can override the defaults with repository variables (Settings → Secrets and variables → Actions → Variables):

| Variable | Default |
|---|---|
| `SPORTS` | `americanfootball_nfl,basketball_nba,americanfootball_ncaaf` |
| `BOOKMAKERS` | `draftkings,fanduel,betmgm,espnbet,betrivers,hardrockbet,kalshi,polymarket_us,novig,prophetx` |
| `MARKETS` | `h2h,spreads,totals` |
| `DAYS_AHEAD` | `7` |
| `PROP_GAMES_NFL` / `PROP_GAMES_NBA` / `PROP_GAMES_NCAAF` | `3` / `2` / `1` |
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
