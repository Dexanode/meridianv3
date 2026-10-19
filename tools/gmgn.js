import { randomUUID } from "crypto";
import { setDefaultResultOrder } from "dns";
import { config } from "../config.js";
import { log } from "../logger.js";

// Force IPv4 — GMGN OpenAPI does not support IPv6
setDefaultResultOrder("ipv4first");

let lastGmgnRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paceGmgnRequest() {
  const delayMs = Math.max(0, Number(config.gmgn?.requestDelayMs ?? 2500));
  if (!delayMs) return;
  const elapsed = Date.now() - lastGmgnRequestAt;
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  lastGmgnRequestAt = Date.now();
}

function getApiKey() {
  const key = config.gmgn?.apiKey || process.env.GMGN_API_KEY;
  if (!key) throw new Error("GMGN_API_KEY is required for the GMGN fee source.");
  return key;
}

export function hasGmgnApiKey() {
  return !!(config.gmgn?.apiKey || process.env.GMGN_API_KEY);
}

function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value.filter((item) => item != null && item !== "")) {
        url.searchParams.append(key, String(entry));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

async function gmgnFetch(pathname, { method = "GET", params = {}, body = null } = {}) {
  const baseUrl = String(config.gmgn?.baseUrl || "https://openapi.gmgn.ai").replace(/\/+$/, "");
  const url = new URL(`${baseUrl}${pathname}`);
  appendParams(url, {
    ...params,
    timestamp: Math.floor(Date.now() / 1000),
    client_id: randomUUID(),
  });

  const maxRetries = Math.max(0, Number(config.gmgn?.maxRetries ?? 2));
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await paceGmgnRequest();
    const res = await fetch(url, {
      method,
      headers: {
        "X-APIKEY": getApiKey(),
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : null,
    });
    const text = await res.text().catch(() => "");
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    const message = payload?.message || payload?.error || payload?.raw || `GMGN ${pathname} ${res.status}`;
    const rateLimited = res.status === 429 || /rate limit|temporarily banned/i.test(String(message));
    if (res.ok) return payload;
    if (rateLimited && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : /temporarily banned/i.test(String(message))
          ? 60000
          : Math.min(30000, 3000 * Math.pow(2, attempt));
      await sleep(backoffMs);
      continue;
    }
    throw new Error(message);
  }
  throw new Error(`GMGN ${pathname} failed`);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function unwrapTokenInfo(payload) {
  const info = payload?.data?.data || payload?.data || payload;
  if (!info || typeof info !== "object" || Array.isArray(info)) return null;
  return info;
}

// Short cache so the fee lookup and the anti-rug lookup share one /v1/token/info call.
const tokenInfoCache = new Map();
const TOKEN_INFO_TTL_MS = 60_000;

async function loadGmgnTokenInfo(mint) {
  const key = String(mint);
  const hit = tokenInfoCache.get(key);
  if (hit && Date.now() - hit.at < TOKEN_INFO_TTL_MS) return hit.info;
  const payload = await gmgnFetch("/v1/token/info", { params: { chain: "sol", address: mint } });
  const info = unwrapTokenInfo(payload);
  if (info) tokenInfoCache.set(key, { at: Date.now(), info });
  return info;
}

// Fields GMGN documents on GET /v1/token/info. Rat trader is their insider label.
// renowned_wallets is a KOL holder count, not a celebrity-token flag, and is not gated.
export const GMGN_ANTIRUG_FIELDS = {
  insider: "stat.top_rat_trader_percentage",
  bundler: "stat.top_bundler_trader_percentage",
  cto: "dev.cto_flag",
  kol_holder_count: "wallet_tags_stat.renowned_wallets",
};

function ratioOrNull(value) {
  const n = num(value);
  if (n == null || n < 0) return null;
  return n;
}

/**
 * Pull the anti-rug numbers /v1/token/info actually returns.
 * Rat-trader and bundler values are left on GMGN's scale (documented as a
 * volume ratio, same family as the 0–1 rate fields). They are not rescaled.
 * cto_flag is 1 or 0. renowned_wallets is observed and not a reject signal.
 */
export function parseGmgnAntiRug(info) {
  const stat = info?.stat && typeof info.stat === "object" ? info.stat : null;
  const dev = info?.dev && typeof info.dev === "object" ? info.dev : null;
  const tags = info?.wallet_tags_stat && typeof info.wallet_tags_stat === "object" ? info.wallet_tags_stat : null;
  const cto = ratioOrNull(dev?.cto_flag);
  return {
    rat_trader_ratio: ratioOrNull(stat?.top_rat_trader_percentage),
    bundler_ratio: ratioOrNull(stat?.top_bundler_trader_percentage),
    cto_flag: cto === 0 || cto === 1 ? cto : null,
    renowned_wallets: ratioOrNull(tags?.renowned_wallets),
  };
}

function antiRugMiss(reason) {
  return { ok: false, reason };
}

/**
 * Evil Panda anti-rug fetch. Missing key, missing payload, and thrown errors
 * all return ok:false so the caller can skip the token. This does not fall
 * back the way getGmgnTokenFees does.
 * Pass fetchTokenInfo in tests; that path never calls the network.
 */
export async function getGmgnAntiRug(mint, { fetchTokenInfo, hasKey } = {}) {
  if (!mint) return antiRugMiss("GMGN anti-rug unavailable — skipped");
  const keyPresent = hasKey ?? hasGmgnApiKey();
  if (!fetchTokenInfo && !keyPresent) return antiRugMiss("GMGN anti-rug unavailable — skipped");
  try {
    const payload = fetchTokenInfo
      ? await fetchTokenInfo(mint)
      : await loadGmgnTokenInfo(mint);
    const info = fetchTokenInfo ? unwrapTokenInfo(payload) : payload;
    if (!info) return antiRugMiss("GMGN anti-rug unavailable — skipped");
    return { ok: true, ...parseGmgnAntiRug(info) };
  } catch (error) {
    log("gmgn", `anti-rug lookup failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return antiRugMiss("GMGN anti-rug call failed — skipped");
  }
}

// ─── Token fees (SOL) for the minTokenFeesSol gate ──────────────
// Returns { total_fee, trade_fee } in SOL, or null on missing key / error
// so callers can fall back to Jupiter's fee figure.
export async function getGmgnTokenFees(mint) {
  if (!mint || !hasGmgnApiKey()) return null;
  try {
    const info = await loadGmgnTokenInfo(mint);
    if (!info) return null;
    return {
      total_fee: num(info.total_fee),
      trade_fee: num(info.trade_fee),
    };
  } catch (error) {
    log("gmgn", `token fees lookup failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return null;
  }
}
