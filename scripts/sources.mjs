// Keyless feed fetchers for the portfolio: Google News RSS (per-holding
// headlines) and SEC EDGAR submissions JSON (per-company filings). Ported from
// the AI-Newsletter build. Dependency-free (Node 20+ global fetch). Each fetcher
// returns normalized items and THROWS on failure — the collector runs every
// fetch under try/catch and records per-source errors instead of failing the run.
//
//   news item:   { title, url, source, publishedAt, kind: "news" }
//   filing item: { title, url, source, publishedAt, kind: "filing", form, desc, explain }

// SEC's WAF rejects parenthesized/URL-bearing agents; its documented
// "Name email" contact format is accepted by Google News too.
const UA = "Jack Portfolio jack.wise@donoco.com";

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'", "&nbsp;": " " };
export function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);|&#39;/g, (m) => ENTITIES[m] ?? m);
}

// Forgiving extraction of one tag's inner text from an XML fragment.
function tag(fragment, name) {
  const m = fragment.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return null;
  return decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim());
}

function toIso(dateStr) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// --- Google News RSS (keyless) -------------------------------------------------
// Titles end with " - Publisher"; the render side strips that suffix. The <link>
// is a Google redirect that resolves to the publisher — fine for a link-out.
export async function fetchGoogleNews(query) {
  const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=en-US&gl=US&ceid=US:en";
  const xml = await fetchText(url);
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const title = tag(it, "title");
    const link = tag(it, "link");
    if (!title || !link || !/^https?:\/\//i.test(link)) continue;
    items.push({
      title,
      url: link,
      source: tag(it, "source") ?? "Google News",
      publishedAt: toIso(tag(it, "pubDate")),
      kind: "news",
    });
  }
  return items;
}

// --- SEC EDGAR company filings (data.sec.gov submissions API) ------------------
// The modern JSON API (the legacy browse-edgar atom feed 403s from some
// networks). Returns the most recent filings with a plain-English form
// explanation and a link to the primary document.
export async function fetchEdgarFilings(cik, limit = 12) {
  const padded = String(cik).replace(/\D/g, "").padStart(10, "0");
  const res = await fetch(`https://data.sec.gov/submissions/CIK${padded}.json`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for SEC submissions CIK${padded}`);
  const data = await res.json();
  const recent = data?.filings?.recent ?? {};
  const company = data?.name ?? "company";
  const cikNum = String(Number(padded));
  const items = [];
  const n = Math.min(recent.form?.length ?? 0, limit);
  for (let i = 0; i < n; i++) {
    const accession = String(recent.accessionNumber?.[i] ?? "").replace(/-/g, "");
    const doc = recent.primaryDocument?.[i];
    if (!accession || !doc) continue;
    const form = recent.form?.[i] ?? "?";
    const desc = recent.primaryDocDescription?.[i] || recent.items?.[i] || "";
    items.push({
      title: `${form} — ${company}${desc ? ` (${desc})` : ""}`,
      url: `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accession}/${doc}`,
      source: "SEC EDGAR",
      publishedAt: toIso(recent.acceptanceDateTime?.[i] ?? recent.filingDate?.[i]),
      kind: "filing",
      form,
      desc,
      explain: explainForm(form),
    });
  }
  return items;
}

// Plain-English one-liner for the common SEC form types, so a filing row is
// legible without knowing EDGAR's alphabet soup.
const FORM_EXPLAIN = {
  "8-K": "Material event — a significant development the company must disclose promptly.",
  "10-Q": "Quarterly report — unaudited financials for the quarter.",
  "10-K": "Annual report — audited financials and a full business review.",
  "4": "Insider transaction — an officer/director/10% owner bought or sold shares.",
  "3": "Initial insider ownership statement.",
  "5": "Annual insider ownership summary.",
  "144": "Notice of a proposed sale of restricted/insider stock.",
  "SC 13D": "Activist stake — a >5% holder intending to influence the company.",
  "SC 13G": "Passive stake — a >5% holder with no control intent.",
  "SCHEDULE 13D": "Activist stake — a >5% holder intending to influence the company.",
  "SCHEDULE 13G": "Passive stake — a >5% holder with no control intent.",
  "13F-HR": "Institutional manager's quarterly holdings disclosure.",
  "S-1": "Registration for a new securities offering (e.g. IPO).",
  "S-3": "Shelf registration — pre-clearing future securities sales.",
  "424B5": "Prospectus for a specific offering being sold.",
  "FWP": "Free writing prospectus — supplemental material for an offering.",
  "DEF 14A": "Definitive proxy statement — shareholder-vote materials.",
  "DEFA14A": "Additional proxy solicitation materials.",
  "DFAN14A": "Proxy solicitation by a non-management party (e.g. an activist).",
  "PX14A6G": "Exempt shareholder solicitation — a non-management proxy note.",
  "11-K": "Annual report for an employee stock/savings plan.",
  "8-A12B": "Registration of a security for exchange listing.",
  "CERT": "Exchange certification of a security's listing approval.",
  "25": "Notice of delisting or withdrawal of a security from an exchange.",
  "6-K": "Foreign-issuer interim report — a material update.",
  "20-F": "Foreign-issuer annual report.",
};
function explainForm(form) {
  if (!form) return null;
  if (FORM_EXPLAIN[form]) return FORM_EXPLAIN[form];
  // Fall back on the family (e.g. "4/A" -> "4", "10-K/A" -> "10-K").
  const base = form.replace(/\/A$/, "");
  if (FORM_EXPLAIN[base]) return `${FORM_EXPLAIN[base]} (amended).`;
  return null;
}
