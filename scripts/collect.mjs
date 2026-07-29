// The portfolio collector. Reads config.json, fetches a keyless quote for every
// distinct holding (symbols shared across portfolios — e.g. MSTR, GOOGL — are
// fetched ONCE and reused), and writes docs/data/portfolio.json which the static
// dashboard renders. Designed to ALWAYS produce a payload: an individual
// symbol's failure is recorded in `errors` and its card degrades gracefully,
// never failing the whole run.
//
// Run locally: node scripts/collect.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchQuote } from "./price.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));

// The Yahoo symbol for a holding: crypto carries an explicit "<SYM>-USD" mapping
// in config; everything else quotes under its own ticker.
const yahooSymbol = (h) => h.yahoo ?? h.symbol;

async function main() {
  // 1) Collect the distinct Yahoo symbols across both portfolios, fetch each once.
  const symbols = new Map(); // yahooSymbol -> { holding fields }
  for (const p of config.portfolios ?? []) {
    for (const h of p.holdings ?? []) {
      const ys = yahooSymbol(h);
      if (!symbols.has(ys)) symbols.set(ys, h);
    }
  }

  const errors = [];
  const quotes = {}; // keyed by yahooSymbol
  const entries = [...symbols.entries()];
  const results = await Promise.all(
    entries.map(async ([ys, h]) => {
      try {
        const q = await fetchQuote(ys);
        if (!q) {
          errors.push({ symbol: h.symbol, yahoo: ys, error: "no quote returned" });
          return [ys, null];
        }
        return [ys, q];
      } catch (e) {
        errors.push({ symbol: h.symbol, yahoo: ys, error: String(e?.message ?? e) });
        return [ys, null];
      }
    }),
  );
  for (const [ys, q] of results) if (q) quotes[ys] = q;

  // 2) Assemble per-portfolio holding lists with their quote attached, plus a
  //    deterministic (keyless) per-portfolio summary: best/worst mover today and
  //    the count of holdings that are up.
  const portfolios = (config.portfolios ?? []).map((p) => {
    const holdings = (p.holdings ?? []).map((h) => {
      const ys = yahooSymbol(h);
      return {
        symbol: h.symbol,
        name: h.name ?? h.symbol,
        type: h.type ?? "stock",
        yahoo: ys,
        quote: quotes[ys] ?? null,
      };
    });

    const withChange = holdings.filter((h) => h.quote && Number.isFinite(h.quote.changePct));
    const sortedByDay = [...withChange].sort((a, b) => b.quote.changePct - a.quote.changePct);
    const up = withChange.filter((h) => h.quote.changePct > 0).length;
    const down = withChange.filter((h) => h.quote.changePct < 0).length;
    const summary = withChange.length
      ? {
          holdings: holdings.length,
          priced: withChange.length,
          up,
          down,
          topGainer: sortedByDay[0]
            ? { symbol: sortedByDay[0].symbol, changePct: sortedByDay[0].quote.changePct }
            : null,
          topLoser: sortedByDay[sortedByDay.length - 1]
            ? {
                symbol: sortedByDay[sortedByDay.length - 1].symbol,
                changePct: sortedByDay[sortedByDay.length - 1].quote.changePct,
              }
            : null,
          avgChangePct:
            Math.round((withChange.reduce((a, h) => a + h.quote.changePct, 0) / withChange.length) * 100) / 100,
        }
      : { holdings: holdings.length, priced: 0, up: 0, down: 0, topGainer: null, topLoser: null, avgChangePct: null };

    return { key: p.key, name: p.name, note: p.note ?? null, summary, holdings };
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    siteTitle: config.siteTitle,
    tagline: config.tagline,
    portfolios,
    errors,
  };

  const dataDir = join(root, "docs", "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "portfolio.json"), JSON.stringify(payload, null, 2));

  const priced = Object.keys(quotes).length;
  console.log(
    `collected: ${priced}/${symbols.size} symbols priced across ${portfolios.length} portfolios ` +
      `(${errors.length} errors)`,
  );
  for (const e of errors) console.warn(`  error: ${e.symbol} (${e.yahoo}): ${e.error}`);
}

await main();
