// SolanaTracker Data API. Free plan is 10k requests/month and 3 requests/second.
// Evil Panda reads risk fields from GET /tokens/{mint}. The key is
// SOLANATRACKER_API_KEY. This module never logs the key.

const BASE = "https://data.solanatracker.io";
let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pace(minGapMs) {
  if (!minGapMs) return;
  const wait = lastRequestAt + minGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function miss(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

/**
 * Insider, sniper, and bundler percentages for one mint.
 * risk.bundlers.totalPercentage absent → GET /tokens/{mint}/bundlers percentage.
 * Pass fetchImpl in tests; that path does not pace and does not read a real key
 * unless apiKey is passed in.
 */
export async function getSolanaTrackerRisk(mint, { fetchImpl, apiKey, paceMs } = {}) {
  if (!mint) return miss("SolanaTracker risk unavailable — skipped");
  const key = String(apiKey ?? process.env.SOLANATRACKER_API_KEY ?? "").trim();
  if (!key) return miss("SolanaTracker risk unavailable — skipped");
  const fetchFn = fetchImpl || fetch;
  const gap = paceMs ?? (fetchImpl ? 0 : 340);
  const headers = { "x-api-key": key };
  try {
    await pace(gap);
    const res = await fetchFn(`${BASE}/tokens/${encodeURIComponent(mint)}`, { headers });
    if (!res?.ok) return miss("SolanaTracker risk call failed — skipped");
    const data = await res.json();
    const risk = data?.risk;
    if (!risk || typeof risk !== "object") return miss("SolanaTracker risk unavailable — skipped");
    const insider = num(risk.insiders?.totalPercentage);
    const sniper = num(risk.snipers?.totalPercentage);
    let bundler = num(risk.bundlers?.totalPercentage);
    let bundlerSource = bundler == null ? null : "risk.bundlers.totalPercentage";
    if (bundler == null) {
      await pace(gap);
      const bundled = await fetchFn(`${BASE}/tokens/${encodeURIComponent(mint)}/bundlers`, { headers });
      if (!bundled?.ok) {
        return miss("SolanaTracker bundlers call failed — skipped", { insider_pct: insider, sniper_pct: sniper, bundler_pct: null });
      }
      const body = await bundled.json();
      bundler = num(body?.percentage);
      bundlerSource = bundler == null ? null : "bundlers.percentage";
    }
    return {
      ok: true,
      insider_pct: insider,
      sniper_pct: sniper,
      bundler_pct: bundler,
      bundler_source: bundlerSource,
    };
  } catch {
    return miss("SolanaTracker risk call failed — skipped");
  }
}
