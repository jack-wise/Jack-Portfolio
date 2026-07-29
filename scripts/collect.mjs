// The portfolio collector. Reads config.json and, for every DISTINCT holding
// (symbols shared across portfolios — MSTR, GOOGL — are gathered once and
// reused), fetches: a keyless price quote, recent Google-News headlines, and
// (for equities) recent SEC EDGAR filings. Writes docs/data/portfolio.json which
// the static site renders. Designed to ALWAYS produce a payload: any single
// fetch failure is recorded in `errors` and that slice degrades gracefully,
// never failing the whole run.
//
// Run locally: node scripts/collect.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchQuote } from "./price.mjs";
import { fetchGoogleNews, fetchEdgarFilings } from "./sources.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));

const NEWS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // headlines older than 30d drop
const NEWS_PER_HOLDING = 8;
const FILINGS_PER_HOLDING = 8;

const yahooSymbol = (h) => h.yahoo ?? h.symbol;

// Dedupe key for a headline: strip the Google-News " - Publisher" suffix and
// punctuation so wire reprints of one story collapse to a single item.
function newsKey(title) {
  return String(title)
    .replace(/\s+-\s+[^-]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

const byDateDesc = (a, b) => String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? ""));

async function gatherNews(h, errors) {
  if (!h.newsQuery) return [];
  try {
    const raw = await fetchGoogleNews(h.newsQuery);
    const now = Date.now();
    const seen = new Map();
    for (const it of raw) {
      const t = Date.parse(it.publishedAt);
      if (!Number.isFinite(t) || now - t > NEWS_MAX_AGE_MS) continue; // fresh only
      const k = newsKey(it.title);
      if (!k || seen.has(k)) continue;
      seen.set(k, it);
    }
    return [...seen.values()].sort(byDateDesc).slice(0, NEWS_PER_HOLDING);
  } catch (e) {
    errors.push({ symbol: h.symbol, source: "news", error: String(e?.message ?? e) });
    return [];
  }
}

async function gatherFilings(h, errors) {
  if (!h.cik) return [];
  try {
    const raw = await fetchEdgarFilings(h.cik, FILINGS_PER_HOLDING);
    return raw.sort(byDateDesc).slice(0, FILINGS_PER_HOLDING);
  } catch (e) {
    errors.push({ symbol: h.symbol, source: "filings", error: String(e?.message ?? e) });
    return [];
  }
}

async function main() {
  // 1) Distinct holdings across both portfolios (keyed by symbol — shared names
  //    carry identical config, so one fetch serves every portfolio it's in).
  const distinct = new Map(); // symbol -> holding config
  for (const p of config.portfolios ?? []) {
    for (const h of p.holdings ?? []) if (!distinct.has(h.symbol)) distinct.set(h.symbol, h);
  }

  const errors = [];

  // 2) Fetch quote + news + filings for each distinct holding, concurrently.
  const enriched = new Map(); // symbol -> { quote, news, filings }
  await Promise.all(
    [...distinct.values()].map(async (h) => {
      const [quote, news, filings] = await Promise.all([
        fetchQuote(yahooSymbol(h)).catch((e) => {
          errors.push({ symbol: h.symbol, source: "price", error: String(e?.message ?? e) });
          return null;
        }),
        gatherNews(h, errors),
        gatherFilings(h, errors),
      ]);
      if (!quote) errors.push({ symbol: h.symbol, source: "price", error: "no quote returned" });
      enriched.set(h.symbol, { quote, news, filings });
    }),
  );

  // 3) Assemble per-portfolio holding lists + a deterministic per-portfolio
  //    summary (best/worst mover today, up/down split, average move).
  const portfolios = (config.portfolios ?? []).map((p) => {
    const holdings = (p.holdings ?? []).map((h) => {
      const e = enriched.get(h.symbol) ?? {};
      return {
        symbol: h.symbol,
        name: h.name ?? h.symbol,
        type: h.type ?? "stock",
        yahoo: yahooSymbol(h),
        cik: h.cik ?? null,
        weight: Number.isFinite(h.weight) ? h.weight : null,
        quote: e.quote ?? null,
        news: e.news ?? [],
        filings: e.filings ?? [],
      };
    });

    const withChange = holdings.filter((h) => h.quote && Number.isFinite(h.quote.changePct));
    const sorted = [...withChange].sort((a, b) => b.quote.changePct - a.quote.changePct);
    const up = withChange.filter((h) => h.quote.changePct > 0).length;
    const down = withChange.filter((h) => h.quote.changePct < 0).length;
    const summary = {
      holdings: holdings.length,
      priced: withChange.length,
      up,
      down,
      newsCount: holdings.reduce((a, h) => a + h.news.length, 0),
      filingsCount: holdings.reduce((a, h) => a + h.filings.length, 0),
      topGainer: sorted[0] ? { symbol: sorted[0].symbol, changePct: sorted[0].quote.changePct } : null,
      topLoser: sorted.length
        ? { symbol: sorted[sorted.length - 1].symbol, changePct: sorted[sorted.length - 1].quote.changePct }
        : null,
      avgChangePct: withChange.length
        ? Math.round((withChange.reduce((a, h) => a + h.quote.changePct, 0) / withChange.length) * 100) / 100
        : null,
    };
    return { key: p.key, name: p.name, note: p.note ?? null, summary, holdings };
  });

  // 4) A cross-portfolio "latest" wire: the freshest headlines and filings across
  //    all distinct holdings, tagged with their symbol, for the front-page feed.
  const allNews = [];
  const allFilings = [];
  for (const [symbol, e] of enriched) {
    for (const n of e.news ?? []) allNews.push({ ...n, symbol });
    for (const f of e.filings ?? []) allFilings.push({ ...f, symbol });
  }
  allNews.sort(byDateDesc);
  allFilings.sort(byDateDesc);

  const payload = {
    generatedAt: new Date().toISOString(),
    siteTitle: config.siteTitle,
    tagline: config.tagline,
    portfolios,
    latestNews: allNews.slice(0, 30),
    latestFilings: allFilings.slice(0, 20),
    errors,
  };

  const dataDir = join(root, "docs", "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "portfolio.json"), JSON.stringify(payload, null, 2));

  const priced = [...enriched.values()].filter((e) => e.quote).length;
  console.log(
    `collected: ${priced}/${distinct.size} priced · ${allNews.length} headlines · ${allFilings.length} filings ` +
      `across ${portfolios.length} portfolios (${errors.length} errors)`,
  );
  for (const e of errors) console.warn(`  error: ${e.symbol} [${e.source}]: ${e.error}`);
}

await main();
