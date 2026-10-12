# withoutcheaty

An independent FPL mini-league table with all Manchester City fixtures removed.
Enter a classic league's numeric ID to calculate the full alternative standings
from the official Fantasy Premier League API. No account or API key is needed.

## Run locally

Requires Node.js 24.

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. The development server serves the Vite frontend and
the same Web Request/Response API handler deployed on Vercel.

```sh
npm test
npm run build
```

## Calculation

- Fetch every page of the classic league standings, up to 200 members. Larger
  leagues are rejected explicitly, never shown as a partial table.
- Fetch each gameweek's fixture-level points and each manager's submitted team.
- Remove the whole score for **both sides** of any Manchester City fixture,
  including negative points, bonus and defensive contributions. Other matches
  in a double gameweek remain eligible.
- Reverse the API's original automatic substitutions to recover submitted
  starters and bench order. Recalculate legal substitutions in bench order,
  preserving the goalkeeper constraint and valid outfield formation.
- Recalculate captaincy, vice-captain fallback and Triple Captain. If neither
  captain qualifies, no bonus is earned. Bench Boost counts all eligible picks.
- Keep actual transfers, chip decisions and transfer hits. Rank tied totals by
  fewer transfers, excluding Wildcard and Free Hit transfers.
- Respect the league's first scoring gameweek and managers who entered late.
- For unfinished gameweeks, count points earned so far and project substitutions.
  Players with pending retained fixtures reserve starting/bench/captain priority.
  Results are marked provisional and display pending fixtures and source notes.
- Validate completed gameweek and league totals before emitting a result.
  In-flight differences between player, gameweek and league feeds are explained
  as live corrections, so every displayed point decomposition still reconciles.

This is a scoring counterfactual, not an alternate transfer strategy. Historical
team decisions are kept intact. New unsupported chips fail clearly.

## Architecture

- `src/`: TypeScript frontend, accessible HTML and responsive CSS. No UI framework.
- `api/league.js`: Vercel Node.js Web-standard handler. `GET /api/league?id=309341`
  streams newline-delimited JSON progress, followed by a result or explicit error.
- `lib/fpl-client.js`: Fixed FPL origin, paginated fetches, bounded in-process
  cache (30 seconds live / six hours finalized), seven concurrent upstream calls,
  retry only for rate limits/server errors, cancellation and timeouts. Cache is
  opportunistic; correctness does not rely on instance persistence.
- `lib/scoring.js`: Pure scoring logic with shared gameweek contexts.
- `tests/`: Mocked API behavior, anonymized real scoring snapshots and synthetic
  edge cases for substitutions, captains, chips, ties and source reconciliation.

All live data stays server-side until the calculated response is returned. No
database, private FPL login, analytics or secrets are required. League/team names
are escaped before rendering. CSV exports protect against formula injection.
Lookups and Refresh obtain current data (live upstream responses may be cached
for up to 30 seconds). Shareable URLs use `?league=<id>`.

## Deploy to Vercel

Import this repository, select **Vite**, use Node.js **24.x**, and deploy. The
included configuration builds `dist/` and deploys `api/league.js` to London with
a 300-second maximum function duration. The API cancels requests after 250 seconds
and returns a useful timeout instead of partial results. No environment variables
are required. Production follows the repository's main branch.

## Sources

- [Fantasy Premier League](https://fantasy.premierleague.com/)
- [Official rules](https://fantasy.premierleague.com/help/rules)
- Public endpoints under `https://fantasy.premierleague.com/api/`: bootstrap,
  fixtures, classic-league standings, event live scores and entry gameweek picks.

The public API is unofficially documented and can change or be unavailable. The
site reports upstream access failures rather than displaying invented data.
