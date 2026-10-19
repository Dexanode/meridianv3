// DexScreener token orders. Keyless, 60 requests/minute.
// An approved communityTakeover order is the CTO reject. An empty order list
// is a real "no CTO" answer, not missing data.

const BASE = "https://api.dexscreener.com/orders/v1/solana";
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

export async function getDexScreenerCto(mint, { fetchImpl, paceMs } = {}) {
  if (!mint) return { ok: false, reason: "DexScreener CTO unavailable — skipped", community_takeover: null };
  const fetchFn = fetchImpl || fetch;
  const gap = paceMs ?? (fetchImpl ? 0 : 1100);
  try {
    await pace(gap);
    const res = await fetchFn(`${BASE}/${encodeURIComponent(mint)}`);
    if (!res?.ok) return { ok: false, reason: "DexScreener CTO call failed — skipped", community_takeover: null };
    const data = await res.json();
    if (!Array.isArray(data)) {
      return { ok: false, reason: "DexScreener CTO unavailable — skipped", community_takeover: null };
    }
    const community_takeover = data.some((order) => order?.type === "communityTakeover" && order?.status === "approved");
    return { ok: true, community_takeover };
  } catch {
    return { ok: false, reason: "DexScreener CTO call failed — skipped", community_takeover: null };
  }
}
