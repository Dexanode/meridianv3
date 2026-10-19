/**
 * Evil Panda bid-ask flip decisions. No network, no .env, no transactions.
 * Run: node test/test-evil-panda.js
 */
import fs from "fs";
import { config } from "../config.js";
import { getRawPoolScreeningRejectReason } from "../tools/screening.js";
import { evaluateChartPreset } from "../tools/chart-indicators.js";
import {
  EVIL_PANDA_PRESET,
  UNAVAILABLE_ANTIRUG_SIGNALS,
  capBins,
  decideBidAskFlip,
  evilPandaDiscoveryReject,
  evilPandaExitTrigger,
  evilPandaPreferenceScore,
  evaluateEvilPandaGates,
  isEvilPandaActive,
  planEvilPandaManagement,
  screeningForActivePreset,
} from "../tools/evil-panda.js";
import { parseJupiterAssetAudit, batchJupiterAudits } from "../tools/token.js";
import { getSolanaTrackerRisk } from "../tools/solanatracker.js";
import { getDexScreenerCto } from "../tools/dexscreener.js";
import { runEvilPandaAntiRug } from "../tools/evil-panda-audit.js";
import { evaluateJupiterPreset, evaluateTrackerPreset, evaluateCtoPreset } from "../tools/evil-panda.js";

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
  else console.log(`ok  ${name}`);
}

const offStrategy = { preset: null };
const onStrategy = {
  preset: EVIL_PANDA_PRESET,
  evilPandaDownsidePct: 85,
  evilPandaUpsidePct: 85,
  evilPandaMaxTotalBins: 140,
  evilPandaMinFeesSol: 50,
  evilPandaMaxTop10Pct: 30,
  evilPandaMaxPositions: 1,
  evilPandaExitRsiAbove: 90,
  evilPandaTokenMajorityPct: 50,
  maxBotHoldersPct: 30,
};

check("preset default is off", config.strategy.preset == null);
check("active strategy was not switched to evil panda", isEvilPandaActive() === false);
check("explicit off stays off", isEvilPandaActive(offStrategy, null) === false);
check("preset flag turns it on", isEvilPandaActive(onStrategy, null) === true);
check("library id turns it on without the config flag", isEvilPandaActive(offStrategy, EVIL_PANDA_PRESET) === true);
check("maxPositions default stays 3", config.risk.maxPositions === 3);
check("ranging cap default stays 15", config.screening.maxAbsPriceChange24hPct === 15);
check("minTokenFeesSol default stays 30", config.screening.minTokenFeesSol === 30);
check("maxTop10Pct default stays 60", config.screening.maxTop10Pct === 60);
check("preset downside is 85 and unused while off", config.strategy.evilPandaDownsidePct === 85);
check("preset fee floor is 50", config.strategy.evilPandaMinFeesSol === 50);
check("preset top10 is 30", config.strategy.evilPandaMaxTop10Pct === 30);
check("preset bundler cap is 10", config.strategy.evilPandaMaxBundlerPct === 10);
check("preset insider cap is 10", config.strategy.evilPandaMaxInsiderPct === 10);
check("preset sniper cap is 10", config.strategy.evilPandaMaxSniperPct === 10);
check("preset dev cap is 5", config.strategy.evilPandaMaxDevPct === 5);
check("preset dev mint cap is 5", config.strategy.evilPandaMaxDevMints === 5);
check("preset max positions is 1", config.strategy.evilPandaMaxPositions === 1);
check("preset bin cap is 140", config.strategy.evilPandaMaxTotalBins === 140);
check("preset exit RSI is 90", config.strategy.evilPandaExitRsiAbove === 90);

const example = JSON.parse(fs.readFileSync(new URL("../user-config.example.json", import.meta.url), "utf8"));
check("example strategyPreset is null", example.strategyPreset == null);
check("example still has the 15% cap", example.maxAbsPriceChange24hPct === 15);
check("example evilPandaMinFeesSol is 50", example.evilPandaMinFeesSol === 50);
check("example evilPandaMaxTop10Pct is 30", example.evilPandaMaxTop10Pct === 30);
check("example bundler cap is 10", example.evilPandaMaxBundlerPct === 10);
check("example insider cap is 10", example.evilPandaMaxInsiderPct === 10);
check("example sniper cap is 10", example.evilPandaMaxSniperPct === 10);
check("example dev cap is 5", example.evilPandaMaxDevPct === 5);
check("example dev mint cap is 5", example.evilPandaMaxDevMints === 5);
check("example evilPandaMaxPositions is 1", example.evilPandaMaxPositions === 1);
check("example maxPositions stays 3", example.maxPositions === 3);

const executorSrc = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
for (const key of [
  "strategyPreset",
  "evilPandaDownsidePct",
  "evilPandaUpsidePct",
  "evilPandaMaxTotalBins",
  "evilPandaMinFeesSol",
  "evilPandaMaxTop10Pct",
  "evilPandaMaxBundlerPct",
  "evilPandaMaxInsiderPct",
  "evilPandaMaxSniperPct",
  "evilPandaMaxDevPct",
  "evilPandaMaxDevMints",
  "evilPandaMaxPositions",
  "evilPandaExitRsiAbove",
  "evilPandaTokenMajorityPct",
]) {
  check(`CONFIG_MAP has ${key}`, executorSrc.includes(`${key}:`));
}

const gates = {
  maxTop10Pct: 30,
  minFeesSol: 50,
  maxBotHoldersPct: 30,
  maxBundlerPct: 10,
  maxInsiderPct: 10,
  maxSniperPct: 10,
  maxDevPct: 5,
  maxDevMints: 5,
};
const clean = { top_holders_pct: 30, global_fees_sol: 50.01, bot_holders_pct: 30 };
const passed = evaluateEvilPandaGates(clean, gates, { checkTop10: true, checkFees: true, checkBots: true });
check("clean candidate passes real gates", passed.pass === true);
check("fees exactly 50 SOL do not pass", evaluateEvilPandaGates({ ...clean, global_fees_sol: 50 }, gates).pass === false);
check("fees above 50 SOL pass", evaluateEvilPandaGates({ ...clean, global_fees_sol: 50.01 }, gates).pass === true);
check("missing SOL fee total is an explicit skip", evaluateEvilPandaGates({ ...clean, global_fees_sol: null }, gates).reasons.join(" ").includes("unavailable"));
check("top10 exactly 30% passes", evaluateEvilPandaGates({ ...clean, top_holders_pct: 30 }, gates).pass === true);
check("top10 above 30% fails", evaluateEvilPandaGates({ ...clean, top_holders_pct: 30.1 }, gates).pass === false);
check("missing top10 is an explicit skip", evaluateEvilPandaGates({ ...clean, top_holders_pct: null }, gates).reasons.join(" ").includes("top10 holders unavailable"));
check("bot holders above 30% fail", evaluateEvilPandaGates({ ...clean, bot_holders_pct: 31 }, gates, { checkBots: true }).pass === false);
check("missing bot holders are an explicit skip", evaluateEvilPandaGates({ ...clean, bot_holders_pct: null }, gates, { checkBots: true }).reasons.join(" ").includes("bot holders unavailable"));
check("bot holders are not required before recon", evaluateEvilPandaGates({ top_holders_pct: 10 }, gates, { checkFees: false, checkBots: false }).pass === true);

for (const signal of UNAVAILABLE_ANTIRUG_SIGNALS) {
  check(`${signal.id} is skipped, not passed`, passed.signalStatus[signal.id] === "skipped");
}
check("vamp and celebrity still have no source", passed.unavailable.includes("vamp") && passed.unavailable.includes("celebrity") && !passed.unavailable.includes("insider") && !passed.unavailable.includes("bundler") && !passed.unavailable.includes("cto"));
check("free anti-rug stays unchecked until recon asks", passed.signalStatus.insider === "not_checked" && passed.signalStatus.cto === "not_checked" && passed.pass === true);

const jupBase = {
  jupiter_ok: true,
  top_holders_pct: 20,
  bot_holders_pct: 10,
  dev_pct: 2,
  dev_mints: 1,
  bundler_pct: 4,
  bundler_stats_present: true,
  global_fees_sol: 51,
};
check("jupiter audit within caps passes and does not defer bundler", evaluateJupiterPreset(jupBase, gates).pass === true && evaluateJupiterPreset(jupBase, gates).bundlerDeferred === false);
check("jupiter bundler above 10 fails", evaluateJupiterPreset({ ...jupBase, bundler_pct: 10.1 }, gates).reasons.join(" ").includes("holdingPct"));
check("jupiter dev above 5 fails", evaluateJupiterPreset({ ...jupBase, dev_pct: 5.1 }, gates).reasons.join(" ").includes("devBalancePercentage"));
check("jupiter dev mints above 5 fails", evaluateJupiterPreset({ ...jupBase, dev_mints: 6 }, gates).reasons.join(" ").includes("devMints"));
check("missing jupiter dev balance skips", evaluateJupiterPreset({ ...jupBase, dev_pct: null }, gates).reasons.join(" ").includes("devBalancePercentage unavailable"));
check("missing bundlerStats defers instead of passing", evaluateJupiterPreset({ ...jupBase, bundler_stats_present: false, bundler_pct: null }, gates).pass === true && evaluateJupiterPreset({ ...jupBase, bundler_stats_present: false, bundler_pct: null }, gates).bundlerDeferred === true);
check("jupiter call failure skips", evaluateJupiterPreset({ jupiter_ok: false, jupiter_reason: "Jupiter audit call failed — skipped" }, gates).reasons.join(" ").includes("call failed"));

const trackerClean = { ok: true, insider_pct: 4, sniper_pct: 3, bundler_pct: 2 };
check("solanatracker within caps passes", evaluateTrackerPreset(trackerClean, gates).pass === true);
check("insider above 10 fails", evaluateTrackerPreset({ ...trackerClean, insider_pct: 11 }, gates).reasons.join(" ").includes("insiders"));
check("sniper above 10 fails", evaluateTrackerPreset({ ...trackerClean, sniper_pct: 10.01 }, gates).reasons.join(" ").includes("snipers"));
check("tracker bundler above 10 fails the cross-check", evaluateTrackerPreset({ ...trackerClean, bundler_pct: 12 }, gates).reasons.join(" ").includes("cross-check"));
check("missing insider field skips", evaluateTrackerPreset({ ...trackerClean, insider_pct: null }, gates).reasons.join(" ").includes("unavailable"));
check("tracker call failure skips", evaluateTrackerPreset({ ok: false, reason: "SolanaTracker risk call failed — skipped" }, gates).reasons.join(" ").includes("call failed"));
check("deferred bundler still skips when tracker bundler is missing", evaluateTrackerPreset({ ...trackerClean, bundler_pct: null }, gates, { bundlerDeferred: true }).pass === false);
check("approved community takeover fails", evaluateCtoPreset({ ok: true, community_takeover: true }).reasons.join(" ").includes("communityTakeover"));
check("empty dexscreener orders pass", evaluateCtoPreset({ ok: true, community_takeover: false }).pass === true);
check("dexscreener call failure skips", evaluateCtoPreset({ ok: false, reason: "DexScreener CTO call failed — skipped" }).reasons.join(" ").includes("call failed"));

function jsonResponse(body, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}
function jupiterAsset(mint, audit) {
  return { id: mint, audit };
}
const MINT_A = "MintA1111111111111111111111111111111111";
const MINT_B = "MintB1111111111111111111111111111111111";
const cleanAudit = {
  topHoldersPercentage: 20,
  botHoldersPercentage: 8,
  devBalancePercentage: 1,
  devMints: 1,
  bundlerStats: { holdingPct: 4 },
};

const calls = [];
const fetchImpl = async (url, init) => {
  calls.push({ url: String(url), apiKey: init?.headers?.["x-api-key"] || null });
  const text = String(url);
  if (text.includes("assets/search")) {
    const query = decodeURIComponent(text.split("query=")[1] || "");
    const ids = query.split(",").filter(Boolean);
    return jsonResponse(ids.map((id) => jupiterAsset(id, id === MINT_B ? { ...cleanAudit, devBalancePercentage: 40 } : cleanAudit)));
  }
  if (text.includes("solanatracker.io") && text.endsWith("/bundlers")) {
    return jsonResponse({ percentage: 3 });
  }
  if (text.includes("solanatracker.io")) {
    const mint = text.split("/tokens/")[1];
    if (mint === "THROW") throw new Error("socket down");
    return jsonResponse({
      risk: {
        insiders: { totalPercentage: 2 },
        snipers: { totalPercentage: 1 },
        bundlers: { totalPercentage: mint === MINT_A ? 3 : 1 },
      },
    });
  }
  if (text.includes("dexscreener.com")) {
    return jsonResponse([]);
  }
  throw new Error(`unexpected url ${text}`);
};

const batched = await batchJupiterAudits([MINT_A, MINT_B], { fetchImpl });
check("jupiter search is one batched call", calls.filter((call) => call.url.includes("assets/search")).length === 1 && calls.some((call) => decodeURIComponent(call.url).includes(",")));
check("parser reads jupiter audit fields", (() => {
  const parsed = parseJupiterAssetAudit(jupiterAsset(MINT_A, cleanAudit));
  return parsed.bundler_pct === 4 && parsed.dev_pct === 1 && parsed.dev_mints === 1 && parsed.top_holders_pct === 20 && parsed.bundler_stats_present === true;
})());
check("batched jupiter returns both mints", batched.get(MINT_A)?.jupiter_ok === true && batched.get(MINT_B)?.dev_pct === 40);

calls.length = 0;
const both = await runEvilPandaAntiRug([
  { pool: { name: "A", base: { mint: MINT_A } }, ti: { global_fees_sol: 60 } },
  { pool: { name: "B", base: { mint: MINT_B } }, ti: { global_fees_sol: 60 } },
], gates, {
  batchJupiterAudits: (mints) => batchJupiterAudits(mints, { fetchImpl }),
  getSolanaTrackerRisk: (mint) => getSolanaTrackerRisk(mint, { fetchImpl, apiKey: "test-key", paceMs: 0 }),
  getDexScreenerCto: (mint) => getDexScreenerCto(mint, { fetchImpl, paceMs: 0 }),
});
check("jupiter dev reject does not call solanatracker", both.passing.length === 1 && both.passing[0].pool.name === "A" && calls.filter((call) => call.url.includes(MINT_B) && call.url.includes("solanatracker")).length === 0);
check("solanatracker request uses x-api-key and dexscreener runs only for the passer", calls.some((call) => call.url.includes("solanatracker") && call.apiKey === "test-key") && calls.filter((call) => call.url.includes("dexscreener")).length === 1);

calls.length = 0;
const missingBundlerFetch = async (url, init) => {
  calls.push(String(url));
  const text = String(url);
  if (text.includes("assets/search")) {
    const { bundlerStats, ...rest } = cleanAudit;
    return jsonResponse([jupiterAsset(MINT_A, rest)]);
  }
  if (text.endsWith("/bundlers")) return jsonResponse({ percentage: 6 });
  if (text.includes("solanatracker.io")) {
    return jsonResponse({ risk: { insiders: { totalPercentage: 1 }, snipers: { totalPercentage: 1 } } });
  }
  if (text.includes("dexscreener.com")) return jsonResponse([{ type: "tokenProfile", status: "approved" }]);
  throw new Error(text);
};
const deferred = await runEvilPandaAntiRug([
  { pool: { name: "A", base: { mint: MINT_A } }, ti: { global_fees_sol: 60 } },
], gates, {
  batchJupiterAudits: (mints) => batchJupiterAudits(mints, { fetchImpl: missingBundlerFetch }),
  getSolanaTrackerRisk: (mint) => getSolanaTrackerRisk(mint, { fetchImpl: missingBundlerFetch, apiKey: "test-key", paceMs: 0 }),
  getDexScreenerCto: (mint) => getDexScreenerCto(mint, { fetchImpl: missingBundlerFetch, paceMs: 0 }),
});
check("missing jupiter bundlerStats falls through to solanatracker bundlers", deferred.passing.length === 1 && calls.some((url) => url.endsWith("/bundlers")));

calls.length = 0;
const stillMissing = await runEvilPandaAntiRug([
  { pool: { name: "A", base: { mint: MINT_A } }, ti: { global_fees_sol: 60 } },
], gates, {
  batchJupiterAudits: (mints) => batchJupiterAudits(mints, { fetchImpl: missingBundlerFetch }),
  getSolanaTrackerRisk: async () => ({ ok: true, insider_pct: 1, sniper_pct: 1, bundler_pct: null }),
  getDexScreenerCto: async () => { calls.push("dex"); return { ok: true, community_takeover: false }; },
});
check("missing bundler on both sources skips and does not call dexscreener", stillMissing.passing.length === 0 && stillMissing.filteredOut[0].reason.includes("unavailable") && !calls.includes("dex"));

const thrown = await runEvilPandaAntiRug([
  { pool: { name: "A", base: { mint: MINT_A } }, ti: { global_fees_sol: 60 } },
], gates, {
  batchJupiterAudits: async () => new Map([[MINT_A, { jupiter_ok: false, jupiter_reason: "Jupiter audit call failed — skipped" }]]),
  getSolanaTrackerRisk: async () => { throw new Error("should not be called"); },
  getDexScreenerCto: async () => { throw new Error("should not be called"); },
});
check("jupiter call failure skips before later sources", thrown.passing.length === 0 && thrown.filteredOut[0].reason.includes("call failed"));

const trackerDown = await runEvilPandaAntiRug([
  { pool: { name: "A", base: { mint: MINT_A } }, ti: { global_fees_sol: 60 } },
], gates, {
  batchJupiterAudits: async () => new Map([[MINT_A, { jupiter_ok: true, ...parseJupiterAssetAudit(jupiterAsset(MINT_A, cleanAudit)) }]]),
  getSolanaTrackerRisk: async () => ({ ok: false, reason: "SolanaTracker risk call failed — skipped" }),
  getDexScreenerCto: async () => { throw new Error("should not be called"); },
});
check("solanatracker call failure skips", trackerDown.passing.length === 0 && trackerDown.filteredOut[0].reason.includes("call failed"));

const noTrackerKey = await getSolanaTrackerRisk(MINT_A, { apiKey: "", fetchImpl: async () => { throw new Error("network"); } });
check("missing solanatracker key skips without a fetch", noTrackerKey.ok === false && noTrackerKey.reason.includes("unavailable"));

const dexThrow = await getDexScreenerCto(MINT_A, { fetchImpl: async () => { throw new Error("socket down"); }, paceMs: 0 });
check("dexscreener throw skips", dexThrow.ok === false && dexThrow.reason.includes("call failed"));
const dexBad = await getDexScreenerCto(MINT_A, { fetchImpl: async () => jsonResponse({ orders: [] }), paceMs: 0 });
check("dexscreener non-array skips", dexBad.ok === false && dexBad.reason.includes("unavailable"));
const dexCto = await getDexScreenerCto(MINT_A, {
  fetchImpl: async () => jsonResponse([{ type: "communityTakeover", status: "approved" }]),
  paceMs: 0,
});
check("dexscreener approved communityTakeover is the reject flag", dexCto.community_takeover === true);

const envExample = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
const gmgnSrc = fs.readFileSync(new URL("../tools/gmgn.js", import.meta.url), "utf8");
check("example env documents SOLANATRACKER_API_KEY", envExample.includes("SOLANATRACKER_API_KEY="));
check("README documents SOLANATRACKER_API_KEY", readme.includes("SOLANATRACKER_API_KEY"));
check("preset docs no longer require a GMGN anti-rug key", !envExample.includes("GMGN_API_KEY") && !readme.includes("Evil Panda GMGN"));
check("fee client still exists and the preset anti-rug export is gone", gmgnSrc.includes("export async function getGmgnTokenFees") && !gmgnSrc.includes("getGmgnAntiRug"));
const indexSrc = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
check("screening uses the free anti-rug path", indexSrc.includes("runEvilPandaAntiRug") && !indexSrc.includes("getGmgnAntiRug"));
const dlmmSrc = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
check("bin cap and uninitialized-array refusal stay", dlmmSrc.includes("evilPandaMaxTotalBins ?? 140") && dlmmSrc.includes("assertRangeDoesNotRequireBinArrayInitialization"));

check("discovery top10 gate is off with the preset", evilPandaDiscoveryReject({ token_x: { top_holders_pct: 90 } }, offStrategy, null) == null);
check("discovery rejects top10 above 30 when the preset is on", String(evilPandaDiscoveryReject({ token_x: { top_holders_pct: 31 } }, onStrategy, null)).includes("top10"));
check("discovery skips a missing top10 instead of passing it", String(evilPandaDiscoveryReject({ token_x: {} }, onStrategy, null)).includes("unavailable"));

const screening = {
  excludeHighSupplyConcentration: true,
  minMcap: 1_000_000,
  maxMcap: 10_000_000,
  minHolders: 500,
  minVolume: 0,
  minTvl: 10_000,
  maxTvl: 150_000,
  minBinStep: 80,
  maxBinStep: 125,
  minFeeActiveTvlRatio: 0.05,
  minOrganic: 60,
  minQuoteOrganic: 60,
  allowedLaunchpads: [],
  blockedLaunchpads: [],
  minTokenAgeHours: 72,
  maxTokenAgeHours: null,
  minFeeActiveTvl24h: 5,
  maxAbsPriceChange24hPct: 15,
};
function pool(overrides = {}) {
  const { token_x: tokenX, ...rest } = overrides;
  return {
    pool_type: "dlmm",
    token_y: { organic_score: 80 },
    base_token_holders: 800,
    volume: null,
    tvl: 20_000,
    dlmm_params: { bin_step: 125 },
    fee_active_tvl_ratio: 0.2,
    volatility: 1.2,
    fee_active_tvl_ratio_24h: 8,
    pool_price_change_pct_24h: 4,
    price_trend_24h: [100, 102],
    ...rest,
    token_x: {
      market_cap: 1_000_000,
      organic_score: 80,
      created_at: Date.now() - 96 * 3_600_000,
      top_holders_pct: 20,
      ...(tokenX || {}),
    },
  };
}
const pumped = pool({ pool_price_change_pct_24h: 40, price_trend_24h: [100, 140] });
check("preset off still rejects a 40% day", String(getRawPoolScreeningRejectReason(pumped, screening)).includes("maxAbsPriceChange24hPct"));
const overlay = screeningForActivePreset(screening, onStrategy, null);
check("overlay does not rewrite the stored cap", screening.maxAbsPriceChange24hPct === 15);
check("overlay disables the ranging cap", overlay.maxAbsPriceChange24hPct == null);
check("preset on allows a 40% day through the ranging cap", getRawPoolScreeningRejectReason(pumped, overlay) == null);
check("null cap is the disable path", getRawPoolScreeningRejectReason(pumped, { ...screening, maxAbsPriceChange24hPct: null }) == null);

check("bin 125 and 8% fee outranks bin 80 and 1% fee", evilPandaPreferenceScore({ bin_step: 125, fee_pct: 8 }) > evilPandaPreferenceScore({ bin_step: 80, fee_pct: 1 }));

const triggerOn = { rsi: 91, close: 110, upperBand: 105 };
const trigger = evilPandaExitTrigger(triggerOn);
check("RSI above 90 and close above upper band fires", trigger.confirmed === true && trigger.rsiOk && trigger.bbOk);
check("RSI half failing does not fire", evilPandaExitTrigger({ rsi: 90, close: 110, upperBand: 105 }).confirmed === false);
check("RSI under 90 does not fire", evilPandaExitTrigger({ rsi: 85, close: 110, upperBand: 105 }).confirmed === false);
check("band half failing does not fire", evilPandaExitTrigger({ rsi: 95, close: 105, upperBand: 105 }).confirmed === false);
check("close under the band does not fire", evilPandaExitTrigger({ rsi: 95, close: 100, upperBand: 105 }).confirmed === false);
check("missing RSI does not fire", evilPandaExitTrigger({ rsi: null, close: 110, upperBand: 105 }).confirmed === false);

function candle(close, rsi, upper) {
  return { latest: { candle: { close }, rsi: { value: rsi }, bollinger: { upper, lower: 90, middle: 100 } } };
}
check("bb_plus_rsi confirms RSI 85 above its default 80", evaluateChartPreset("exit", "bb_plus_rsi", candle(110, 85, 105)).confirmed === true);
check("rsi2_above_bb does not confirm RSI 85", evaluateChartPreset("exit", "rsi2_above_bb", candle(110, 85, 105)).confirmed === false);
check("bb_plus_rsi confirms a close equal to the band", evaluateChartPreset("exit", "bb_plus_rsi", candle(105, 95, 105)).confirmed === true);
check("rsi2_above_bb requires a close strictly above the band", evaluateChartPreset("exit", "rsi2_above_bb", candle(105, 95, 105)).confirmed === false);
check("rsi2_above_bb confirms RSI 91 and a close above the band", evaluateChartPreset("exit", "rsi2_above_bb", candle(110, 91, 105)).confirmed === true);

const fired = { confirmed: true };
check("mostly token flips to token-sided above price", (() => {
  const decision = decideBidAskFlip({ token_value_usd: 80, sol_value_usd: 20, leg: "sol_entry" });
  return decision.action === "flip" && decision.side === "token" && decision.abovePrice === true && decision.strategy === "bid_ask" && decision.binsBelow === 0;
})());
check("mostly SOL closes only", decideBidAskFlip({ token_value_usd: 20, sol_value_usd: 80, leg: "sol_entry" }).action === "close");
check("even split is not mostly token", decideBidAskFlip({ token_value_usd: 50, sol_value_usd: 50 }).action === "close");
check("missing composition closes only", decideBidAskFlip({ token_value_usd: null, sol_value_usd: 10 }).reason.includes("unavailable"));
check("token leg does not flip again", decideBidAskFlip({ token_value_usd: 90, sol_value_usd: 10, leg: "token_flip" }).action === "close");

const tokenHeavy = { token_value_usd: 70, sol_value_usd: 30, leg: "sol_entry" };
check("exit trigger plus mostly token plans a flip", planEvilPandaManagement({ position: tokenHeavy, exitTrigger: fired, cutLossRule: null }).action === "flip");
check("exit trigger plus mostly SOL plans a close", planEvilPandaManagement({
  position: { token_value_usd: 10, sol_value_usd: 90, leg: "sol_entry" },
  exitTrigger: fired,
  cutLossRule: null,
}).action === "close");
check("one failing half of the trigger holds", planEvilPandaManagement({
  position: tokenHeavy,
  exitTrigger: evilPandaExitTrigger({ rsi: 95, close: 100, upperBand: 105 }),
  cutLossRule: null,
}).action === "stay");
check("existing stop-loss preempts a flip", planEvilPandaManagement({
  position: tokenHeavy,
  exitTrigger: fired,
  cutLossRule: { action: "STOP_LOSS", reason: "Stop loss: PnL -55% <= -50%" },
}).via === "cut_loss");
check("unpriced tick holds", planEvilPandaManagement({
  position: { ...tokenHeavy, pnl_pct_suspicious: true },
  exitTrigger: fired,
  cutLossRule: null,
}).action === "stay");

check("bin cap keeps a SOL-sided range on the downside", (() => {
  const capped = capBins(160, 0, 140);
  return capped.binsBelow === 140 && capped.binsAbove === 0 && capped.capped === true;
})());
check("bin cap keeps a token-sided range above price", (() => {
  const capped = capBins(0, 180, 140);
  return capped.binsBelow === 0 && capped.binsAbove === 140;
})());
check("range inside the cap is unchanged", capBins(100, 0, 140).capped === false && capBins(100, 0, 140).binsBelow === 100);

if (failures.length) {
  console.error(`\n${failures.length} failed:`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exit(1);
}
console.log("\nall evil panda checks passed");
