# Jack Portfolio

A self-updating dashboard of **live prices across both personal portfolios**
(Individual + Joint), modeled on the AI-Newsletter build. A GitHub Actions cron
runs every 30 minutes, fetches a keyless quote for each holding, and publishes a
static dashboard via GitHub Pages.

```
GitHub Actions (cron */30) ──► scripts/collect.mjs ──► docs/data/portfolio.json ──► GitHub Pages (docs/)
```

## What it shows

- Every holding as a card grouped by portfolio: **last price, day change,
  trailing-window (~1mo) move, and an inline sparkline**. Cards link to the
  TradingView chart.
- A per-portfolio summary strip: holdings count, average move today, up/down
  split, and the day's top gainer / loser.
- Symbols held in **both** portfolios (e.g. MSTR, GOOGL) are fetched once and
  shown in each.

## Sources (no API keys)

- **Yahoo Finance v8 chart endpoint** (keyless, browser User-Agent) for stocks,
  ETFs, and crypto alike. Crypto quotes via Yahoo's `<SYM>-USD` pseudo-symbols
  (e.g. `ETH-USD`). Data is end-of-day / lightly-delayed and unofficial —
  a dashboard glance, never anything actionable.

## Configuration — `config.json`

- `portfolios[]` — each has a `key`, `name`, optional `note`, and `holdings[]`.
- Each holding: `symbol`, `name`, `type` (`stock` | `etf` | `crypto`), and an
  optional `yahoo` override (used for crypto, e.g. `"yahoo": "ETH-USD"`).

To add or remove a holding, edit `config.json` — nothing else needs to change.

## Privacy

The site carries a `noindex, nofollow` robots tag so search engines don't index
it. It lists tickers only (no share counts or dollar values).

## Operating it

- **Force a refresh:** Actions → `update-portfolio` → Run workflow.
- **Local run:** `node scripts/collect.mjs` (Node 20+), then open `docs/index.html`
  via any static server.
- **Enable Pages (one-time):** repo Settings → Pages → deploy from branch `main`,
  folder `/docs`.

## Roadmap (engines ready to switch on)

The AI-Newsletter codebase already has keyless engines for **ranked news**, **SEC
filings**, and **Cboe options positioning**. The dashboard is priced-first by
design; those modules can be layered onto the equity cards later.

*Informational only. Prices are delayed and unofficial. Not investment advice.*
