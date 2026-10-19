/**
 * Screening-criteria checks. No network, no .env.
 * Run: node test/test-screening-filters.js
 */
import { config } from "../config.js";
import { getRawPoolScreeningRejectReason } from "../tools/screening.js";
import { scaleScreeningToTimeframe } from "../screening-scales.js";
import fs from "fs";

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
  else console.log(`ok  ${name}`);
}

check("minTokenAgeHours default is 72", config.screening.minTokenAgeHours === 72);
check("minMcap default is 1000000", config.screening.minMcap === 1_000_000);
check("maxMcap default left at 10000000", config.screening.maxMcap === 10_000_000);
check("minVolume default is 0", config.screening.minVolume === 0);
check("minFeeActiveTvl24h default is 5", config.screening.minFeeActiveTvl24h === 5);
check("maxAbsPriceChange24hPct default is 15", config.screening.maxAbsPriceChange24hPct === 15);
check("minFeePerTvl24h default is 3", config.management.minFeePerTvl24h === 3);
check("window fee ratio was not retargeted", config.screening.minFeeActiveTvlRatio === 0.05);
check("5m scale has no volume floor", scaleScreeningToTimeframe("5m").minVolume === 0);
check("24h scale has no volume floor", scaleScreeningToTimeframe("24h").minVolume === 0);

const example = JSON.parse(fs.readFileSync(new URL("../user-config.example.json", import.meta.url), "utf8"));
check("example minTokenAgeHours 72", example.minTokenAgeHours === 72);
check("example minMcap 1000000", example.minMcap === 1_000_000);
check("example minVolume 0", example.minVolume === 0);
check("example minFeeActiveTvl24h 5", example.minFeeActiveTvl24h === 5);
check("example maxAbsPriceChange24hPct 15", example.maxAbsPriceChange24hPct === 15);
check("example minFeePerTvl24h 3", example.minFeePerTvl24h === 3);
check("example window fee ratio unchanged", example.minFeeActiveTvlRatio === 0.05);

const executorSrc = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
check("CONFIG_MAP has minFeeActiveTvl24h", executorSrc.includes('minFeeActiveTvl24h: ["screening", "minFeeActiveTvl24h"]'));
check("CONFIG_MAP has maxAbsPriceChange24hPct", executorSrc.includes('maxAbsPriceChange24hPct: ["screening", "maxAbsPriceChange24hPct"]'));

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
  const { token_x: tokenX, token_y: tokenY, ...rest } = overrides;
  return {
    pool_type: "dlmm",
    token_y: { organic_score: 80, ...(tokenY || {}) },
    base_token_holders: 800,
    volume: null,
    tvl: 20_000,
    dlmm_params: { bin_step: 100 },
    fee_active_tvl_ratio: 0.2,
    volatility: 1.2,
    fee_active_tvl_ratio_24h: 8,
    pool_price_change_pct_24h: 4,
    price_trend_24h: [100, 102, 99, 101],
    ...rest,
    token_x: {
      market_cap: 1_000_000,
      organic_score: 80,
      created_at: Date.now() - 96 * 3_600_000,
      ...(tokenX || {}),
    },
  };
}

check("qualifying pool passes", getRawPoolScreeningRejectReason(pool(), screening) == null);
check("null volume does not reject when floor is 0", getRawPoolScreeningRejectReason(pool({ volume: null }), screening) == null);
check("young token rejected", String(getRawPoolScreeningRejectReason(pool({ token_x: { created_at: Date.now() - 3_600_000 } }), screening)).includes("minTokenAgeHours"));
check("mcap under 1M rejected", String(getRawPoolScreeningRejectReason(pool({ token_x: { market_cap: 999_999 } }), screening)).includes("minMcap"));
check("mcap at 1M passes the mcap floor", getRawPoolScreeningRejectReason(pool({ token_x: { market_cap: 1_000_000 } }), screening) == null);
check("fee exactly 5% is not above the floor", String(getRawPoolScreeningRejectReason(pool({ fee_active_tvl_ratio_24h: 5 }), screening)).includes("minFeeActiveTvl24h"));
check("fee just above 5% passes", getRawPoolScreeningRejectReason(pool({ fee_active_tvl_ratio_24h: 5.01 }), screening) == null);
check("missing 24h fee rejected", String(getRawPoolScreeningRejectReason(pool({ fee_active_tvl_ratio_24h: null }), screening)).includes("minFeeActiveTvl24h"));
check("15% price change still ranges", getRawPoolScreeningRejectReason(pool({ pool_price_change_pct_24h: -15, price_trend_24h: [100, 85] }), screening) == null);
check("hard trend rejected", String(getRawPoolScreeningRejectReason(pool({ pool_price_change_pct_24h: 40 }), screening)).includes("maxAbsPriceChange24hPct"));
check("flat change with a trending path rejected", String(getRawPoolScreeningRejectReason(pool({ pool_price_change_pct_24h: 0, price_trend_24h: [100, 40] }), screening)).includes("maxAbsPriceChange24hPct"));
check("positive volume floor still rejects", String(getRawPoolScreeningRejectReason(pool({ volume: 10 }), { ...screening, minVolume: 500 })).includes("minVolume"));

if (failures.length) {
  console.error(`\n${failures.length} failed:`);
  for (const name of failures) console.error(`  - ${name}`);
  process.exit(1);
}
console.log("\nall screening filter checks passed");
