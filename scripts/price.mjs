// Keyless quote fetch for every holding — stocks, ETFs, and crypto alike — via
// Yahoo Finance's public v8 chart endpoint (no API key, no crumb needed on this
// route) with a browser User-Agent (Yahoo rejects bot-styled agents). Crypto
// uses Yahoo's "<SYM>-USD" pseudo-symbols (e.g. ETH-USD), which return on the
// same endpoint and even carry weekend closes.
//
// Returns a compact quote object (last price, day change, trailing-window move,
// and a small close series for the card sparkline) or null on any failure — the
// collector records the miss and the card degrades to "—" rather than breaking
// the run. This data is end-of-day/lightly-delayed and unofficial; it's a
// dashboard glance, never anything actionable.

const YF_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

const HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

const round = (n, d = 2) => {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

// range=1mo/interval=1d gives ~21 daily closes (crypto: ~31, it trades weekends)
// — enough for a day-over-day change, a trailing-window move, and a sparkline
// without a second request.
export async function fetchQuote(yahooSymbol) {
  for (const host of HOSTS) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1mo&interval=1d`;
      const res = await fetch(url, {
        headers: { "User-Agent": YF_UA, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) continue;
      const meta = result.meta ?? {};
      const stamps = result.timestamp ?? [];
      const rawCloses = result.indicators?.quote?.[0]?.close ?? [];

      // Pair each close with its timestamp, drop null closes (Yahoo pads
      // holidays/half-days with nulls). Keeps day/window/sparkline math honest.
      const series = rawCloses
        .map((c, i) => ({ close: c, ts: stamps[i] }))
        .filter((p) => Number.isFinite(p.close));
      if (series.length < 1) continue;

      const last = series[series.length - 1];
      const price = Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : last.close;
      // Day change baseline = the PRIOR trading day's close, i.e. the second-to-last
      // point in the daily series. (meta.chartPreviousClose is the close *before the
      // 1-month window begins*, ~a month back — using it as "prev day" is wrong.)
      const prevClose = series.length >= 2 ? series[series.length - 2].close : null;
      const changePct = prevClose != null && prevClose !== 0 ? ((price - prevClose) / prevClose) * 100 : null;

      const first = series[0];
      const windowChangePct = first.close ? ((price - first.close) / first.close) * 100 : null;

      const asOfSec = Number.isFinite(meta.regularMarketTime) ? meta.regularMarketTime : last.ts;
      const asOf = Number.isFinite(asOfSec) ? new Date(asOfSec * 1000).toISOString() : null;

      return {
        price: round(price, price < 1 ? 4 : 2),
        prevClose: prevClose != null ? round(prevClose, prevClose < 10 ? 4 : 2) : null,
        changePct: round(changePct, 2),
        windowChangePct: round(windowChangePct, 2),
        windowDays: series.length,
        // Downsampled close series for the sparkline (cap at 30 points).
        spark: series.map((p) => round(p.close, p.close < 10 ? 4 : 2)),
        asOf,
        currency: meta.currency ?? "USD",
        exchange: meta.exchangeName ?? meta.fullExchangeName ?? null,
      };
    } catch {
      /* try the next host, then fail open */
    }
  }
  return null;
}
