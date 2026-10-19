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
import { GMGN_ANTIRUG_FIELDS, getGmgnAntiRug, parseGmgnAntiRug } from "../tools/gmgn.js";

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
check("preset rat-trader cap is 0", config.strategy.evilPandaMaxRatTraderRatio === 0);
check("preset bundler cap is 0", config.strategy.evilPandaMaxBundlerRatio === 0);
check("preset max positions is 1", config.strategy.evilPandaMaxPositions === 1);
check("preset bin cap is 140", config.strategy.evilPandaMaxTotalBins === 140);
check("preset exit RSI is 90", config.strategy.evilPandaExitRsiAbove === 90);

const example = JSON.parse(fs.readFileSync(new URL("../user-config.example.json", import.meta.url), "utf8"));
check("example strategyPreset is null", example.strategyPreset == null);
check("example still has the 15% cap", example.maxAbsPriceChange24hPct === 15);
check("example evilPandaMinFeesSol is 50", example.evilPandaMinFeesSol === 50);
check("example evilPandaMaxTop10Pct is 30", example.evilPandaMaxTop10Pct === 30);
check("example rat-trader cap is 0", example.evilPandaMaxRatTraderRatio === 0);
check("example bundler cap is 0", example.evilPandaMaxBundlerRatio === 0);
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
  "evilPandaMaxRatTraderRatio",
  "evilPandaMaxBundlerRatio",
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
  maxRatTraderRatio: 0,
  maxBundlerRatio: 0,
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
check("GMGN gates stay off unless screening asks for them", passed.signalStatus.insider === "not_checked" && passed.pass === true);

const cleanGmgn = {
  ok: true,
  rat_trader_ratio: 0,
  bundler_ratio: 0,
  cto_flag: 0,
  renowned_wallets: 4,
};
const gmgnOptions = { checkTop10: true, checkFees: true, checkBots: true, checkGmgn: true };
const gmgnPass = evaluateEvilPandaGates({ ...clean, gmgn: cleanGmgn }, gates, gmgnOptions);
check("clean GMGN ratios and cto_flag 0 pass", gmgnPass.pass === true && gmgnPass.signalStatus.insider === "pass" && gmgnPass.signalStatus.bundler === "pass" && gmgnPass.signalStatus.cto === "pass");
check("KOL holder count does not clear the celebrity skip", gmgnPass.signalStatus.celebrity === "skipped" && gmgnPass.signalStatus.vamp === "skipped");
check("rat trader above 0 fails", evaluateEvilPandaGates({ ...clean, gmgn: { ...cleanGmgn, rat_trader_ratio: 0.2 } }, gates, gmgnOptions).signalStatus.insider === "fail");
check("bundler above 0 fails", evaluateEvilPandaGates({ ...clean, gmgn: { ...cleanGmgn, bundler_ratio: 0.15 } }, gates, gmgnOptions).signalStatus.bundler === "fail");
check("cto_flag 1 fails", evaluateEvilPandaGates({ ...clean, gmgn: { ...cleanGmgn, cto_flag: 1 } }, gates, gmgnOptions).reasons.join(" ").includes("cto_flag"));
check("missing rat-trader field skips", evaluateEvilPandaGates({ ...clean, gmgn: { ...cleanGmgn, rat_trader_ratio: null } }, gates, gmgnOptions).reasons.join(" ").includes("top_rat_trader_percentage unavailable"));
check("missing GMGN object skips", evaluateEvilPandaGates(clean, gates, gmgnOptions).reasons.join(" ").includes("unavailable"));

function gmgnEnvelope({ rat = 0, bundler = 0, cto = 0, renowned = 3 } = {}) {
  return {
    data: {
      data: {
        stat: { top_rat_trader_percentage: rat, top_bundler_trader_percentage: bundler },
        dev: { cto_flag: cto },
        wallet_tags_stat: { renowned_wallets: renowned },
      },
    },
  };
}

check("parser reads the documented GMGN fields", (() => {
  const parsed = parseGmgnAntiRug(gmgnEnvelope({ rat: 0.05, bundler: 0.1, cto: 1, renowned: 2 }).data.data);
  return parsed.rat_trader_ratio === 0.05
    && parsed.bundler_ratio === 0.1
    && parsed.cto_flag === 1
    && parsed.renowned_wallets === 2
    && GMGN_ANTIRUG_FIELDS.insider === "stat.top_rat_trader_percentage"
    && GMGN_ANTIRUG_FIELDS.bundler === "stat.top_bundler_trader_percentage"
    && GMGN_ANTIRUG_FIELDS.cto === "dev.cto_flag";
})());

const mockedPass = await getGmgnAntiRug("MintMock111", { fetchTokenInfo: async () => gmgnEnvelope() });
const mockedGate = evaluateEvilPandaGates({ ...clean, gmgn: mockedPass }, gates, gmgnOptions);
check("mocked GMGN token info passes the gates", mockedPass.ok === true && mockedGate.pass === true);

const mockedMissing = await getGmgnAntiRug("MintMock111", {
  fetchTokenInfo: async () => ({ data: { data: { symbol: "NOFIELDS" } } }),
});
const missingGate = evaluateEvilPandaGates({ ...clean, gmgn: mockedMissing }, gates, gmgnOptions);
check("mocked GMGN payload with missing fields skips", mockedMissing.ok === true && missingGate.pass === false && missingGate.reasons.join(" ").includes("unavailable") && missingGate.signalStatus.insider === "skipped" && missingGate.signalStatus.cto === "skipped");

const mockedNull = await getGmgnAntiRug("MintMock111", { fetchTokenInfo: async () => null });
const nullGate = evaluateEvilPandaGates({ ...clean, gmgn: mockedNull }, gates, gmgnOptions);
check("mocked empty GMGN response skips", mockedNull.ok === false && mockedNull.reason.includes("unavailable") && nullGate.pass === false);

const mockedThrow = await getGmgnAntiRug("MintMock111", {
  fetchTokenInfo: async () => { throw new Error("socket down"); },
});
const throwGate = evaluateEvilPandaGates({ ...clean, gmgn: mockedThrow }, gates, gmgnOptions);
check("mocked GMGN call failure skips", mockedThrow.ok === false && mockedThrow.reason.includes("call failed") && throwGate.pass === false && throwGate.signalStatus.insider === "skipped" && throwGate.signalStatus.bundler === "skipped");

const noKey = await getGmgnAntiRug("MintMock111", { hasKey: false });
check("missing GMGN key skips without a network call", noKey.ok === false && noKey.reason.includes("unavailable"));

const envExample = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
check("example env documents GMGN_API_KEY", envExample.includes("GMGN_API_KEY="));
check("README documents GMGN_API_KEY", readme.includes("GMGN_API_KEY"));
const indexSrc = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
check("screening fetches GMGN only for the preset", indexSrc.includes("getGmgnAntiRug") && indexSrc.includes("checkGmgn: true"));
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
