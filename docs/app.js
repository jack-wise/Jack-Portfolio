// Jack Portfolio dashboard front end: fills the overview band and per-portfolio
// card grids from data/portfolio.json, draws a sparkline per holding, and
// re-polls every 5 minutes. All text is set via textContent (no HTML injection);
// the only markup built by hand is the inline SVG sparkline from numeric data.

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

const TYPE_LABELS = { stock: "Stock", etf: "ETF", crypto: "Crypto" };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function timeAgo(iso) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return "unknown";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Format a price with sensible precision: sub-$10 (many crypto / cheap tickers)
// keep 4 decimals, everything else 2, with thousands separators.
function fmtPrice(n) {
  if (!Number.isFinite(n)) return "—";
  // Sub-$1 assets (some crypto / pennies) need more precision; everything else 2dp.
  const dp = Math.abs(n) < 1 ? 4 : 2;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(2)}%`;
}

// Direction class for coloring a change value.
function dirClass(n) {
  if (!Number.isFinite(n) || n === 0) return "is-flat";
  return n > 0 ? "is-up" : "is-down";
}

// Build an inline SVG sparkline from a numeric close series, colored to match the
// trailing-window direction. Returns null if there's too little data to draw.
function sparkline(series, direction) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const w = 120;
  const h = 34;
  const pad = 2;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const step = (w - pad * 2) / (series.length - 1);
  const pts = series.map((v, i) => {
    const x = pad + i * step;
    const y = pad + (h - pad * 2) * (1 - (v - min) / span);
    return [x, y];
  });
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `spark ${direction}`);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");

  // Soft area fill under the line.
  const area = document.createElementNS("http://www.w3.org/2000/svg", "path");
  area.setAttribute("class", "spark-area");
  area.setAttribute("d", `${d} L${pts[pts.length - 1][0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`);
  svg.appendChild(area);

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("class", "spark-line");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return svg;
}

// A TradingView symbol for the chart link: crypto routes to the CRYPTO:<SYM>USD
// pair, everything else opens the plain ticker (TradingView resolves the venue).
function tvUrl(h) {
  const sym = h.type === "crypto" ? `CRYPTO:${h.symbol}USD` : h.symbol;
  return `https://www.tradingview.com/symbols/${encodeURIComponent(sym)}/`;
}

function holdingCard(h) {
  const q = h.quote;
  const dayDir = dirClass(q?.changePct);
  const winDir = dirClass(q?.windowChangePct);

  const card = el("a", `card ${q ? dayDir : "is-flat"}`);
  card.href = tvUrl(h);
  card.target = "_blank";
  card.rel = "noopener noreferrer";
  card.title = `Open ${h.symbol} chart on TradingView`;

  const head = el("div", "card-head");
  const idBlock = el("div", "card-id");
  idBlock.appendChild(el("span", "card-sym", h.symbol));
  idBlock.appendChild(el("span", "card-name", h.name));
  head.appendChild(idBlock);
  head.appendChild(el("span", `card-type type-${h.type}`, TYPE_LABELS[h.type] ?? "Stock"));
  card.appendChild(head);

  if (q) {
    const priceRow = el("div", "card-price-row");
    priceRow.appendChild(el("span", "card-price", fmtPrice(q.price)));
    const day = el("span", `card-day ${dayDir}`, `${fmtPct(q.changePct)} today`);
    priceRow.appendChild(day);
    card.appendChild(priceRow);

    const spark = sparkline(q.spark, winDir);
    if (spark) card.appendChild(spark);

    const foot = el("div", "card-foot");
    const win = el("span", `card-win ${winDir}`, `${fmtPct(q.windowChangePct)} · ${q.windowDays ?? "—"}d`);
    foot.appendChild(win);
    foot.appendChild(el("span", "card-open", "chart ↗"));
    card.appendChild(foot);
  } else {
    card.appendChild(el("p", "card-noquote", "Price unavailable — retries next cycle."));
  }
  return card;
}

function summaryChips(s) {
  const wrap = el("div", "pf-chips");
  const chip = (label, value, cls) => {
    const c = el("span", `pf-chip${cls ? " " + cls : ""}`);
    c.appendChild(el("span", "pf-chip-num", value));
    c.appendChild(el("span", "pf-chip-label", label));
    return c;
  };
  wrap.appendChild(chip("Holdings", String(s.holdings ?? "—")));
  if (Number.isFinite(s.avgChangePct)) wrap.appendChild(chip("Avg today", fmtPct(s.avgChangePct), dirClass(s.avgChangePct)));
  wrap.appendChild(chip("Up / Down", `${s.up ?? 0} / ${s.down ?? 0}`));
  if (s.topGainer) wrap.appendChild(chip(`▲ ${s.topGainer.symbol}`, fmtPct(s.topGainer.changePct), "is-up"));
  if (s.topLoser) wrap.appendChild(chip(`▼ ${s.topLoser.symbol}`, fmtPct(s.topLoser.changePct), "is-down"));
  return wrap;
}

function portfolioSection(p) {
  const section = el("section", "pf");
  section.id = `pf-${p.key}`;

  const head = el("div", "pf-head");
  const titleWrap = el("div");
  titleWrap.appendChild(el("h2", "pf-title", p.name));
  if (p.note) titleWrap.appendChild(el("p", "pf-note", p.note));
  head.appendChild(titleWrap);
  head.appendChild(summaryChips(p.summary ?? {}));
  section.appendChild(head);

  const grid = el("div", "grid");
  for (const h of p.holdings ?? []) grid.appendChild(holdingCard(h));
  section.appendChild(grid);
  return section;
}

function render(data) {
  document.getElementById("updated").textContent = `LIVE · UPDATED ${timeAgo(data.generatedAt).toUpperCase()}`;
  document.getElementById("foot-updated").textContent = data.generatedAt
    ? new Date(data.generatedAt).toLocaleString()
    : "";

  const portfolios = data.portfolios ?? [];

  // Top nav: one link per portfolio.
  const nav = document.getElementById("topnav");
  nav.replaceChildren(
    ...portfolios.map((p) => {
      const a = el("a", null, p.name);
      a.href = `#pf-${p.key}`;
      return a;
    }),
  );

  // Overview: distinct holdings + a portfolio breakdown line.
  const distinct = new Set();
  let totalCards = 0;
  for (const p of portfolios) for (const h of p.holdings ?? []) { distinct.add(h.symbol); totalCards++; }
  document.getElementById("ov-sub").textContent =
    `${distinct.size} distinct holdings across ${portfolios.length} portfolios ` +
    `(${totalCards} positions${totalCards !== distinct.size ? ", some held in both" : ""}).`;

  const stats = document.getElementById("ov-stats");
  stats.replaceChildren(
    ...portfolios.map((p) => {
      const s = p.summary ?? {};
      const box = el("div", "ov-stat");
      box.appendChild(el("span", "ov-stat-name", p.name.toUpperCase()));
      const val = el("span", `ov-stat-val ${dirClass(s.avgChangePct)}`, fmtPct(s.avgChangePct));
      box.appendChild(val);
      box.appendChild(el("span", "ov-stat-sub", `avg move today · ${s.priced ?? 0} priced`));
      return box;
    }),
  );

  const main = document.getElementById("portfolios");
  main.replaceChildren(...portfolios.map(portfolioSection));

  if (data.errors?.length) {
    const note = el("p", "errors-note", `${data.errors.length} price fetch${data.errors.length === 1 ? "" : "es"} failed this cycle: ${data.errors.map((e) => e.symbol).join(", ")}. They retry next refresh.`);
    main.appendChild(note);
  }
}

let loadedOnce = false;
async function load() {
  try {
    const res = await fetch(`data/portfolio.json?ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
    loadedOnce = true;
  } catch (e) {
    document.getElementById("updated").textContent = `OFFLINE · RETRYING (${e.message})`;
    if (!loadedOnce) {
      document.getElementById("loading").textContent =
        "Couldn't load portfolio data yet — it publishes on the next scheduled run.";
    }
  }
}

load();
setInterval(load, 5 * 60 * 1000);
