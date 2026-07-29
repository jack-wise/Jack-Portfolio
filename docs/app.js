// Jack Portfolio front end: renders the overview board, ticker tape, per-portfolio
// card grids, and the unified News + Filings wires from data/portfolio.json, wires
// up the tabs and a per-holding detail drawer, and re-polls every 5 minutes. All
// feed text is set via textContent (no HTML injection); the only hand-built markup
// is the inline SVG sparkline drawn from numeric data.

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const TYPE_LABELS = { stock: "Equity", etf: "ETF", crypto: "Crypto" };

let lastData = null;          // latest payload
const holdingIndex = new Map(); // symbol -> holding (for the drawer)

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

// Only absolute http(s) URLs reach an href; anything else collapses to "#".
function safeUrl(url) {
  if (typeof url !== "string") return "#";
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "#";
  } catch { return "#"; }
}

function timeAgo(iso) {
  if (!iso) return "—";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return "—";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtPrice(n) {
  if (!Number.isFinite(n)) return "—";
  const dp = Math.abs(n) < 1 ? 4 : 2;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}
function fmtPct(n) {
  if (!Number.isFinite(n)) return "—";
  const s = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${s}${Math.abs(n).toFixed(2)}%`;
}
function dirClass(n) {
  if (!Number.isFinite(n) || n === 0) return "is-flat";
  return n > 0 ? "is-up" : "is-down";
}

// EDGAR's primary-doc description often just repeats the form code ("10-K" for a
// 10-K). Show it only when it adds something beyond the form badge.
function filingDesc(f) {
  const d = (f.desc || "").trim();
  return d && d.toUpperCase() !== (f.form || "").toUpperCase() ? d : "";
}

// Strip a Google-News " - Publisher" suffix for a cleaner headline (the source is
// shown separately from the item's `source` field).
function cleanTitle(t) {
  const m = /^(.*\S)\s+-\s+[^-]{2,45}$/.exec(t ?? "");
  return (m ? m[1] : t ?? "").trim();
}

// Inline SVG sparkline from a numeric close series, colored by trailing direction.
function sparkline(series, direction) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const w = 120, h = 36, pad = 2;
  const min = Math.min(...series), max = Math.max(...series);
  const span = max - min || 1;
  const step = (w - pad * 2) / (series.length - 1);
  const pts = series.map((v, i) => [pad + i * step, pad + (h - pad * 2) * (1 - (v - min) / span)]);
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", `spark ${direction}`);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const area = document.createElementNS(NS, "path");
  area.setAttribute("class", "spark-area");
  area.setAttribute("d", `${d} L${pts[pts.length - 1][0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`);
  svg.appendChild(area);
  const line = document.createElementNS(NS, "path");
  line.setAttribute("class", "spark-line");
  line.setAttribute("d", d);
  svg.appendChild(line);
  return svg;
}

function tvUrl(h) {
  const sym = h.type === "crypto" ? `CRYPTO:${h.symbol}USD` : h.symbol;
  return `https://www.tradingview.com/symbols/${encodeURIComponent(sym)}/`;
}

// ---- ticker tape ----------------------------------------------------------------

function tapeItems(portfolios) {
  const seen = new Set();
  const out = [];
  for (const p of portfolios) {
    for (const h of p.holdings ?? []) {
      if (seen.has(h.symbol) || !h.quote) continue;
      seen.add(h.symbol);
      const item = el("span", "tape-item");
      item.appendChild(el("span", "tape-sym", h.symbol));
      item.appendChild(el("span", "tape-px", fmtPrice(h.quote.price)));
      item.appendChild(el("span", `tape-ch ${dirClass(h.quote.changePct)}`, fmtPct(h.quote.changePct)));
      out.push(item);
    }
  }
  return out;
}

// ---- overview board -------------------------------------------------------------

function boardCells(data) {
  const cells = [];
  for (const p of data.portfolios ?? []) {
    const s = p.summary ?? {};
    const cell = el("div", "board-cell is-hero");
    cell.appendChild(el("div", "bc-label", p.name.toUpperCase()));
    cell.appendChild(el("div", `bc-val ${dirClass(s.avgChangePct)}`, fmtPct(s.avgChangePct)));
    const sub = el("div", "bc-sub");
    sub.append(
      document.createTextNode(`${s.priced ?? 0} priced · `),
      Object.assign(el("span", "up", `${s.up ?? 0}▲`)),
      document.createTextNode(" "),
      Object.assign(el("span", "down", `${s.down ?? 0}▼`)),
    );
    cell.appendChild(sub);
    cells.push(cell);
  }
  const distinct = new Set();
  for (const p of data.portfolios ?? []) for (const h of p.holdings ?? []) distinct.add(h.symbol);
  const stat = (label, val, sub) => {
    const c = el("div", "board-cell");
    c.appendChild(el("div", "bc-label", label));
    c.appendChild(el("div", "bc-val", val));
    c.appendChild(el("div", "bc-sub", sub));
    return c;
  };
  cells.push(stat("Positions", String(distinct.size), `${(data.portfolios ?? []).length} portfolios`));
  cells.push(stat("Headlines", String((data.latestNews ?? []).length), "last 30 days"));
  cells.push(stat("Filings", String((data.latestFilings ?? []).length), "SEC EDGAR"));
  return cells;
}

// ---- holdings -------------------------------------------------------------------

function holdingCard(h) {
  const q = h.quote;
  const card = el("div", `card ${q ? dirClass(q.changePct) : "is-flat"}`);
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `${h.symbol} details`);

  const head = el("div", "card-head");
  const id = el("div", "card-id");
  id.appendChild(el("span", "card-sym", h.symbol));
  id.appendChild(el("span", "card-name", h.name));
  head.appendChild(id);
  head.appendChild(el("span", `card-type type-${h.type}`, TYPE_LABELS[h.type] ?? "Equity"));
  card.appendChild(head);

  if (q) {
    const px = el("div", "card-px-row");
    px.appendChild(el("span", "card-px", fmtPrice(q.price)));
    px.appendChild(el("span", `card-ch ${dirClass(q.changePct)}`, `${fmtPct(q.changePct)}`));
    card.appendChild(px);
    const sp = sparkline(q.spark, dirClass(q.windowChangePct));
    if (sp) card.appendChild(sp);
    const foot = el("div", "card-foot");
    foot.appendChild(el("span", "card-win", `${fmtPct(q.windowChangePct)} · ${q.windowDays ?? "—"}d`));
    const tags = el("span", "card-tags");
    const nTag = el("span", "card-tag"); nTag.append(Object.assign(el("b", null, String(h.news?.length ?? 0))), document.createTextNode(" news"));
    tags.appendChild(nTag);
    if (h.type !== "crypto" && h.type !== "etf") {
      const fTag = el("span", "card-tag"); fTag.append(Object.assign(el("b", null, String(h.filings?.length ?? 0))), document.createTextNode(" SEC"));
      tags.appendChild(fTag);
    }
    foot.appendChild(tags);
    card.appendChild(foot);
  } else {
    card.appendChild(el("p", "card-noquote", "Price unavailable — retries next cycle."));
  }

  const open = () => openDrawer(h.symbol);
  card.addEventListener("click", open);
  card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  return card;
}

function portfolioSection(p) {
  const sec = el("section", "pf");
  const head = el("div", "pf-head");
  const title = el("h2", "pf-title", p.name);
  if (p.note) title.appendChild(el("span", "pf-note", p.note));
  head.appendChild(title);
  const s = p.summary ?? {};
  const meta = el("span", "pf-meta");
  meta.append(
    document.createTextNode(`${s.holdings ?? 0} holdings · avg `),
    Object.assign(el("span", dirClass(s.avgChangePct), fmtPct(s.avgChangePct))),
  );
  head.appendChild(meta);
  sec.appendChild(head);
  const grid = el("div", "grid");
  for (const h of p.holdings ?? []) grid.appendChild(holdingCard(h));
  sec.appendChild(grid);
  return sec;
}

// ---- wires (news + filings) -----------------------------------------------------

function newsRow(item) {
  const a = el("a", "wire-row");
  a.href = safeUrl(item.url);
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  if (item.symbol) a.appendChild(el("span", "chip", item.symbol));
  const main = el("div", "wire-main");
  main.appendChild(el("div", "wire-title", cleanTitle(item.title)));
  const sub = el("div", "wire-sub");
  if (item.source) sub.appendChild(el("span", null, item.source));
  sub.appendChild(el("span", "dot", "·"));
  sub.appendChild(el("span", "wire-when", timeAgo(item.publishedAt)));
  main.appendChild(sub);
  a.appendChild(main);
  return a;
}

function filingRow(item) {
  const a = el("a", "wire-row");
  a.href = safeUrl(item.url);
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  if (item.symbol) a.appendChild(el("span", "chip", item.symbol));
  const main = el("div", "wire-main");
  const head = el("div", "wire-title");
  head.appendChild(el("span", "form-badge", item.form ?? "FILING"));
  const dtext = filingDesc(item);
  if (dtext) head.appendChild(document.createTextNode(` ${dtext}`));
  main.appendChild(head);
  if (item.explain) main.appendChild(el("div", "wire-explain", item.explain));
  const sub = el("div", "wire-sub");
  sub.appendChild(el("span", null, "SEC EDGAR"));
  sub.appendChild(el("span", "dot", "·"));
  sub.appendChild(el("span", "wire-when", item.publishedAt ? item.publishedAt.slice(0, 10) : "—"));
  main.appendChild(sub);
  a.appendChild(main);
  return a;
}

// ---- detail drawer --------------------------------------------------------------

let drawerLastFocus = null;

function drawerStat(label, val, cls) {
  const s = el("div", "dr-stat");
  s.appendChild(el("div", "dr-stat-l", label));
  s.appendChild(el("div", `dr-stat-v ${cls ?? ""}`.trim(), val));
  return s;
}

function openDrawer(symbol) {
  const h = holdingIndex.get(symbol);
  if (!h) return;
  drawerLastFocus = document.activeElement;
  const body = document.getElementById("drawer-body");
  const q = h.quote;

  const head = el("div", "dr-head");
  const id = el("div");
  id.appendChild(Object.assign(el("div", "dr-sym"), { id: "drawer-sym", textContent: h.symbol }));
  id.appendChild(el("div", "dr-name", `${h.name} · ${TYPE_LABELS[h.type] ?? "Equity"}`));
  head.appendChild(id);
  const nodes = [head];

  if (q) {
    const pxRow = el("div", "dr-px-row");
    pxRow.appendChild(el("span", "dr-px", fmtPrice(q.price)));
    pxRow.appendChild(el("span", `dr-ch ${dirClass(q.changePct)}`, `${fmtPct(q.changePct)} today`));
    nodes.push(pxRow);

    const sp = sparkline(q.spark, dirClass(q.windowChangePct));
    if (sp) { const wrap = el("div", "dr-spark"); wrap.appendChild(sp); nodes.push(wrap); }

    const stats = el("div", "dr-stats");
    stats.appendChild(drawerStat("Prev close", fmtPrice(q.prevClose)));
    stats.appendChild(drawerStat(`~${q.windowDays ?? ""}d move`, fmtPct(q.windowChangePct), dirClass(q.windowChangePct)));
    stats.appendChild(drawerStat("Currency", q.currency ?? "USD"));
    nodes.push(stats);
  } else {
    nodes.push(el("p", "dr-empty", "Live price unavailable right now — it retries on the next refresh."));
  }

  const chart = el("a", "dr-chart-link", "Open full chart on TradingView ↗");
  chart.href = tvUrl(h); chart.target = "_blank"; chart.rel = "noopener noreferrer";
  nodes.push(chart);

  // News section
  const newsSec = el("div", "dr-section");
  newsSec.appendChild(Object.assign(el("h3", "dr-h", "News"), {}));
  newsSec.appendChild(el("p", "dr-h-sub", `${h.news?.length ?? 0} recent headlines`));
  if (h.news?.length) {
    for (const n of h.news) {
      const a = el("a", "dr-item");
      a.href = safeUrl(n.url); a.target = "_blank"; a.rel = "noopener noreferrer";
      a.appendChild(el("div", "dr-item-title", cleanTitle(n.title)));
      const sub = el("div", "dr-item-sub");
      sub.appendChild(el("span", null, n.source ?? "News"));
      sub.appendChild(el("span", null, timeAgo(n.publishedAt)));
      a.appendChild(sub);
      newsSec.appendChild(a);
    }
  } else {
    newsSec.appendChild(el("p", "dr-empty", "No recent headlines."));
  }
  nodes.push(newsSec);

  // Filings section (equities only)
  if (h.type !== "crypto" && h.type !== "etf") {
    const fSec = el("div", "dr-section");
    fSec.appendChild(el("h3", "dr-h", "SEC filings"));
    fSec.appendChild(el("p", "dr-h-sub", `${h.filings?.length ?? 0} recent · via EDGAR`));
    if (h.filings?.length) {
      for (const f of h.filings) {
        const a = el("a", "dr-item");
        a.href = safeUrl(f.url); a.target = "_blank"; a.rel = "noopener noreferrer";
        const t = el("div", "dr-item-title");
        t.appendChild(el("span", "form-badge", f.form ?? "FILING"));
        const dtext = filingDesc(f);
        if (dtext) t.appendChild(document.createTextNode(` ${dtext}`));
        a.appendChild(t);
        if (f.explain) a.appendChild(el("div", "dr-item-explain", f.explain));
        a.appendChild(el("div", "dr-item-sub", f.publishedAt ? f.publishedAt.slice(0, 10) : "—"));
        fSec.appendChild(a);
      }
    } else {
      fSec.appendChild(el("p", "dr-empty", "No recent filings."));
    }
    nodes.push(fSec);
  }

  body.replaceChildren(...nodes);
  const drawer = document.getElementById("drawer");
  drawer.hidden = false;
  document.body.style.overflow = "hidden";
  document.getElementById("drawer-close").focus();
}

function closeDrawer() {
  document.getElementById("drawer").hidden = true;
  document.body.style.overflow = "";
  if (drawerLastFocus && typeof drawerLastFocus.focus === "function") drawerLastFocus.focus();
}
document.getElementById("drawer-close").addEventListener("click", closeDrawer);
document.getElementById("drawer-backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

// ---- tabs -----------------------------------------------------------------------

function activateTab(name) {
  for (const t of document.querySelectorAll(".tab")) {
    const on = t.dataset.tab === name;
    t.classList.toggle("is-active", on);
    t.setAttribute("aria-selected", String(on));
  }
  for (const p of document.querySelectorAll(".panel")) {
    const on = p.id === `panel-${name}`;
    p.classList.toggle("is-active", on);
    p.hidden = !on;
  }
  for (const a of document.querySelectorAll(".mast-nav a")) a.classList.toggle("is-active", a.dataset.nav === name);
}
for (const t of document.querySelectorAll(".tab")) t.addEventListener("click", () => activateTab(t.dataset.tab));
for (const a of document.querySelectorAll(".mast-nav a")) a.addEventListener("click", () => activateTab(a.dataset.nav));

// ---- render ---------------------------------------------------------------------

function render(data) {
  lastData = data;
  holdingIndex.clear();
  for (const p of data.portfolios ?? []) for (const h of p.holdings ?? []) if (!holdingIndex.has(h.symbol)) holdingIndex.set(h.symbol, h);

  document.getElementById("updated").textContent = `Updated ${timeAgo(data.generatedAt)}`;
  document.getElementById("foot-updated").textContent = data.generatedAt ? new Date(data.generatedAt).toLocaleString() : "";
  document.getElementById("board-date").textContent = data.generatedAt
    ? new Date(data.generatedAt).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
    : "";

  // Ticker tape (rendered twice for a seamless -50% loop).
  const items = tapeItems(data.portfolios ?? []);
  const track = document.getElementById("tape");
  track.replaceChildren(...items, ...items.map((n) => n.cloneNode(true)));

  // Board
  document.getElementById("board").replaceChildren(...boardCells(data));

  // Tab counts
  const distinct = new Set();
  for (const p of data.portfolios ?? []) for (const h of p.holdings ?? []) distinct.add(h.symbol);
  document.getElementById("tc-holdings").textContent = String(distinct.size);
  document.getElementById("tc-news").textContent = String((data.latestNews ?? []).length);
  document.getElementById("tc-filings").textContent = String((data.latestFilings ?? []).length);

  // Holdings panel
  document.getElementById("holdings").replaceChildren(...(data.portfolios ?? []).map(portfolioSection));

  // News wire
  const news = data.latestNews ?? [];
  document.getElementById("news-wire").replaceChildren(...news.map(newsRow));
  document.getElementById("news-empty").hidden = news.length > 0;

  // Filings wire
  const filings = data.latestFilings ?? [];
  document.getElementById("filings-wire").replaceChildren(...filings.map(filingRow));
  document.getElementById("filings-empty").hidden = filings.length > 0;
}

const initialHolding = (new URLSearchParams(location.search).get("holding") || "").toUpperCase();
let drawerOpened = false;

let loadedOnce = false;
async function load() {
  try {
    const res = await fetch(`data/portfolio.json?ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
    loadedOnce = true;
    // Shareable holding deep-link: ?holding=NVDA opens its drawer once, after data loads.
    if (initialHolding && !drawerOpened && holdingIndex.has(initialHolding)) {
      openDrawer(initialHolding);
      drawerOpened = true;
    }
  } catch (e) {
    document.getElementById("updated").textContent = `Offline · retrying`;
    if (!loadedOnce) document.getElementById("loading").textContent =
      "Couldn't load portfolio data yet — it publishes on the next scheduled run.";
  }
}

// Deep-linkable tab: ?view=news / ?view=filings opens that panel on load.
const initialView = new URLSearchParams(location.search).get("view");
if (["holdings", "news", "filings"].includes(initialView)) activateTab(initialView);

load();
setInterval(load, 5 * 60 * 1000);
