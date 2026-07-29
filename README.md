# Jack Portfolio

A self-updating dashboard of **live prices across both personal portfolios**
(Individual + Joint), modeled on the AI-Newsletter build. A GitHub Actions cron
runs every 30 minutes, fetches a keyless quote for each holding, and publishes a
static dashboard via GitHub Pages.

```
GitHub Actions (cron */30) ──► scripts/collect.mjs ──► docs/data/portfolio.json ──► GitHub Pages (docs/)
```

## What it shows

- **Holdings** — every position as a card grouped by portfolio: last price, day
  change, trailing-window (~1mo) move, and an inline sparkline. Click a card for a
  **detail drawer** with its price stats, recent news, and SEC filings.
- **News** — a unified, deduplicated wire of every holding's recent headlines,
  newest first, tagged by ticker.
- **Filings** — a unified SEC EDGAR feed across the equities, each with a
  plain-English note on the form type.
- An overview board (per-portfolio average move, up/down split) and a live ticker
  tape. Symbols held in **both** portfolios (e.g. MSTR, GOOGL) are fetched once
  and shown in each.
- Deep links: `?view=news|filings` opens a tab; `?holding=NVDA` opens a drawer.

## Sources (no API keys)

- **Yahoo Finance v8 chart endpoint** (keyless) for prices — stocks, ETFs, and
  crypto alike (crypto via `<SYM>-USD` pseudo-symbols, e.g. `ETH-USD`).
- **Google News RSS** (keyless) for per-holding headlines, deduped by title.
- **SEC EDGAR submissions API** (keyless) for equity filings, with CIKs in config.

All data is end-of-day / lightly-delayed and unofficial — a dashboard glance,
never anything actionable.

## Configuration — `config.json`

- `portfolios[]` — each has a `key`, `name`, optional `note`, and `holdings[]`.
- Each holding: `symbol`, `name`, `type` (`stock` | `etf` | `crypto`), a
  `newsQuery` (Google News search), and — for equities — a `cik` (SEC EDGAR).
  Crypto adds a `yahoo` override (e.g. `"yahoo": "ETH-USD"`).

To add or remove a holding, edit `config.json`. New equities need their SEC CIK
(look it up in `https://www.sec.gov/files/company_tickers.json`).

## Privacy

The site carries a `noindex, nofollow` robots tag so search engines don't index
it. It lists tickers only (no share counts or dollar values).

## Operating it

- **Force a refresh:** Actions → `update-portfolio` → Run workflow.
- **Local run:** `node scripts/collect.mjs` (Node 20+), then open `docs/index.html`
  via any static server.
- **Enable Pages (one-time):** repo Settings → Pages → deploy from branch `main`,
  folder `/docs`.

## Roadmap

Cboe options positioning (put/call, implied vol) is available keyless in the
AI-Newsletter codebase and can be layered onto the equity drawers next.

*Informational only. Prices, news, and filings are delayed and unofficial. Not
investment advice.*
