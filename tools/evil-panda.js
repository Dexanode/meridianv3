/**
 * Opt-in "Evil Panda + bid-ask flip" preset.
 *
 * Off unless config.strategy.preset or the active strategy id is
 * "evil_panda_bid_ask_flip". Defaults (including the 15% ranging cap and
 * maxPositions) stay in force while it is off.
 *
 * single_sided_reseed is a different idea (token-only below the active bin,
 * reseed on a downside OOR). This preset enters SOL-sided below price and,
 * on the exit trigger, flips a token-heavy position to token-sided above price.
 */

import { config } from "../config.js";
import { getActiveStrategy } from "../strategy-library.js";

export const EVIL_PANDA_PRESET = "evil_panda_bid_ask_flip";

// No free source for these. Never treat a missing source as a pass.
// Same-symbol PVP (screening is_pvp) is a rival heuristic, not a celebrity gate.
export const UNAVAILABLE_ANTIRUG_SIGNALS = [
  {
    id: "vamp",
    status: "skipped",
    reason: "Jupiter, SolanaTracker, and DexScreener have no vamp or copycat field",
  },
  {
    id: "celebrity",
    status: "skipped",
    reason: "no celebrity-token flag on Jupiter, SolanaTracker, or DexScreener. Same-symbol PVP is not this gate.",
  },
  {
    id: "cumulative_meteora_lp_fees_sol",
    status: "skipped",
    reason: "discovery fee is the timeframe window in USD, not lifetime Meteora LP fees in SOL",
  },
];

// Soft preference among pools that already passed the hard gates.
export const EVIL_PANDA_PREFERENCES = {
  binStep: 125,
  baseFeePctMin: 5,
  baseFeePctMax: 10,
};

function finiteNumber(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function withFallback(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function evilPandaParams(strategy = config.strategy) {
  return {
    downsidePct: withFallback(strategy?.evilPandaDownsidePct, 85),
    upsidePct: withFallback(strategy?.evilPandaUpsidePct, 85),
    maxTotalBins: withFallback(strategy?.evilPandaMaxTotalBins, 140),
    minFeesSol: withFallback(strategy?.evilPandaMinFeesSol, 50),
    maxTop10Pct: withFallback(strategy?.evilPandaMaxTop10Pct, 30),
    // Holding percentages on a 0–100 scale, matching Jupiter topHoldersPercentage.
    maxBundlerPct: withFallback(strategy?.evilPandaMaxBundlerPct, 10),
    maxInsiderPct: withFallback(strategy?.evilPandaMaxInsiderPct, 10),
    maxSniperPct: withFallback(strategy?.evilPandaMaxSniperPct, 10),
    maxDevPct: withFallback(strategy?.evilPandaMaxDevPct, 5),
    maxDevMints: withFallback(strategy?.evilPandaMaxDevMints, 5),
    maxPositions: withFallback(strategy?.evilPandaMaxPositions, 1),
    exitRsiAbove: withFallback(strategy?.evilPandaExitRsiAbove, 90),
    tokenMajorityPct: withFallback(strategy?.evilPandaTokenMajorityPct, 50),
    maxBotHoldersPct: withFallback(strategy?.maxBotHoldersPct, config.screening.maxBotHoldersPct),
  };
}

export function isEvilPandaActive(strategy = config.strategy, activeId = getActiveStrategy()?.id ?? null) {
  return strategy?.preset === EVIL_PANDA_PRESET || activeId === EVIL_PANDA_PRESET;
}

export function effectiveMaxPositions(cfg = config, activeId = getActiveStrategy()?.id ?? null) {
  if (!isEvilPandaActive(cfg.strategy, activeId)) return cfg.risk.maxPositions;
  return evilPandaParams(cfg.strategy).maxPositions;
}

/**
 * Copy of screening thresholds for this cycle.
 * The stored 15% cap is left alone. null is the existing disable path in
 * getRawPoolScreeningRejectReason — this preset wants pumps and dumps.
 */
export function screeningForActivePreset(screening = config.screening, strategy = config.strategy, activeId = getActiveStrategy()?.id ?? null) {
  if (!isEvilPandaActive(strategy, activeId)) return screening;
  return {
    ...screening,
    maxAbsPriceChange24hPct: null,
    evilPandaGates: true,
  };
}

function percentOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function evaluateEvilPandaGates(candidate, gates = evilPandaParams(), options = {}) {
  const {
    checkTop10 = true,
    checkFees = true,
    checkBots = false,
  } = options;
  const reasons = [];

  if (checkTop10) {
    const top10 = finiteNumber(
      candidate?.top_holders_pct,
      candidate?.token_x?.top_holders_pct,
      candidate?.audit?.top_holders_pct,
    );
    if (top10 == null) reasons.push("top10 holders unavailable — skipped");
    else if (top10 > gates.maxTop10Pct) {
      reasons.push(`top10 ${top10}% exceeds maxTop10Pct ${gates.maxTop10Pct}%`);
    }
  }

  if (checkFees) {
    // global_fees_sol is the SOL fee total already fetched (GMGN total_fee, else Jupiter).
    // Lifetime Meteora LP fees are not on the discovery payload — see unavailable signals.
    const fees = finiteNumber(candidate?.global_fees_sol, candidate?.fees_sol);
    if (fees == null) reasons.push("SOL fee total unavailable — skipped");
    else if (!(fees > gates.minFeesSol)) {
      reasons.push(`fees ${fees} SOL not above ${gates.minFeesSol} SOL`);
    }
  }

  if (checkBots) {
    const bots = finiteNumber(candidate?.bot_holders_pct, candidate?.audit?.bot_holders_pct);
    if (bots == null) reasons.push("bot holders unavailable — skipped");
    else if (gates.maxBotHoldersPct != null && bots > gates.maxBotHoldersPct) {
      reasons.push(`bot holders ${bots}% exceeds maxBotHoldersPct ${gates.maxBotHoldersPct}%`);
    }
  }

  const signalStatus = Object.fromEntries(UNAVAILABLE_ANTIRUG_SIGNALS.map((signal) => [signal.id, "skipped"]));
  signalStatus.insider = "not_checked";
  signalStatus.sniper = "not_checked";
  signalStatus.bundler = "not_checked";
  signalStatus.dev = "not_checked";
  signalStatus.cto = "not_checked";
  return {
    pass: reasons.length === 0,
    reasons,
    unavailable: UNAVAILABLE_ANTIRUG_SIGNALS.map((signal) => signal.id),
    signalStatus,
  };
}

/**
 * Jupiter audit gates. bundlerStats missing does not fail here: the caller
 * must fill bundler from SolanaTracker instead of treating it as a pass.
 */
export function evaluateJupiterPreset(candidate, gates = evilPandaParams(), { checkFees = true } = {}) {
  if (!candidate?.jupiter_ok) {
    return {
      pass: false,
      reasons: [candidate?.jupiter_reason || "Jupiter audit unavailable — skipped"],
      bundlerDeferred: false,
    };
  }
  const base = evaluateEvilPandaGates(candidate, gates, { checkTop10: true, checkFees, checkBots: true });
  const reasons = [...base.reasons];
  const dev = percentOrNull(candidate.dev_pct);
  if (dev == null) reasons.push("Jupiter audit.devBalancePercentage unavailable — skipped");
  else if (dev > gates.maxDevPct) reasons.push(`Jupiter audit.devBalancePercentage ${dev}% exceeds ${gates.maxDevPct}%`);
  const devMints = percentOrNull(candidate.dev_mints);
  if (devMints == null) reasons.push("Jupiter audit.devMints unavailable — skipped");
  else if (devMints > gates.maxDevMints) reasons.push(`Jupiter audit.devMints ${devMints} exceeds ${gates.maxDevMints}`);

  let bundlerDeferred = false;
  if (!candidate.bundler_stats_present) {
    bundlerDeferred = true;
  } else {
    const bundler = percentOrNull(candidate.bundler_pct);
    if (bundler == null) bundlerDeferred = true;
    else if (bundler > gates.maxBundlerPct) {
      reasons.push(`Jupiter audit.bundlerStats.holdingPct ${bundler}% exceeds ${gates.maxBundlerPct}%`);
    }
  }
  return { pass: reasons.length === 0, reasons, bundlerDeferred };
}

/** Insider, sniper, and the bundler cross-check. A missing SolanaTracker field skips. */
export function evaluateTrackerPreset(tracker, gates = evilPandaParams(), { bundlerDeferred = false } = {}) {
  if (!tracker?.ok) {
    return { pass: false, reasons: [tracker?.reason || "SolanaTracker risk unavailable — skipped"] };
  }
  const reasons = [];
  const insider = percentOrNull(tracker.insider_pct);
  if (insider == null) reasons.push("SolanaTracker risk.insiders.totalPercentage unavailable — skipped");
  else if (insider > gates.maxInsiderPct) reasons.push(`SolanaTracker risk.insiders.totalPercentage ${insider}% exceeds ${gates.maxInsiderPct}%`);
  const sniper = percentOrNull(tracker.sniper_pct);
  if (sniper == null) reasons.push("SolanaTracker risk.snipers.totalPercentage unavailable — skipped");
  else if (sniper > gates.maxSniperPct) reasons.push(`SolanaTracker risk.snipers.totalPercentage ${sniper}% exceeds ${gates.maxSniperPct}%`);
  const bundler = percentOrNull(tracker.bundler_pct);
  if (bundler == null) reasons.push("SolanaTracker risk.bundlers.totalPercentage unavailable — skipped");
  else if (bundler > gates.maxBundlerPct) {
    reasons.push(`SolanaTracker bundler ${bundler}% exceeds ${gates.maxBundlerPct}%${bundlerDeferred ? "" : " (cross-check)"}`);
  }
  return { pass: reasons.length === 0, reasons };
}

export function evaluateCtoPreset(dex) {
  if (!dex?.ok) return { pass: false, reasons: [dex?.reason || "DexScreener CTO unavailable — skipped"] };
  if (dex.community_takeover) return { pass: false, reasons: ["DexScreener communityTakeover approved"] };
  return { pass: true, reasons: [] };
}

export function evilPandaDiscoveryReject(pool, strategy = config.strategy, activeId = getActiveStrategy()?.id ?? null) {
  if (!isEvilPandaActive(strategy, activeId)) return null;
  const result = evaluateEvilPandaGates(
    { top_holders_pct: pool?.token_x?.top_holders_pct ?? pool?.top_holders_pct },
    evilPandaParams(strategy),
    { checkTop10: true, checkFees: false, checkBots: false },
  );
  return result.pass ? null : result.reasons[0];
}

export function evilPandaPreferenceScore(pool) {
  const step = finiteNumber(pool?.bin_step, pool?.dlmm_params?.bin_step);
  const fee = finiteNumber(pool?.fee_pct, pool?.base_fee);
  let score = 0;
  if (step != null) score += Math.max(0, 40 - Math.abs(step - EVIL_PANDA_PREFERENCES.binStep));
  if (fee != null && fee >= EVIL_PANDA_PREFERENCES.baseFeePctMin && fee <= EVIL_PANDA_PREFERENCES.baseFeePctMax) {
    score += 50;
  } else if (fee != null) {
    score += Math.max(0, 20 - Math.abs(fee - 7.5) * 2);
  }
  return score;
}

/**
 * 5m exit: RSI(2) strictly above the threshold (default 90) AND close strictly
 * above the upper Bollinger band. bb_plus_rsi is the looser `>= overbought`
 * (default 80) and `close >= upper` check — this is not that preset.
 * rsiLength=2 is the fetch parameter; this function only sees the number.
 */
export function evilPandaExitTrigger({ rsi, close, upperBand } = {}, { rsiAbove = 90 } = {}) {
  const rsiNum = Number(rsi);
  const closeNum = Number(close);
  const upperNum = Number(upperBand);
  const rsiOk = Number.isFinite(rsiNum) && rsiNum > rsiAbove;
  const bbOk = Number.isFinite(closeNum) && Number.isFinite(upperNum) && closeNum > upperNum;
  return {
    confirmed: rsiOk && bbOk,
    rsiOk,
    bbOk,
    reason: rsiOk && bbOk
      ? `RSI ${rsiNum} > ${rsiAbove} and close ${closeNum} > upper band ${upperNum}`
      : `RSI ${Number.isFinite(rsiNum) ? rsiNum : "n/a"} > ${rsiAbove}? ${rsiOk}; close > upper band? ${bbOk}`,
  };
}

export function decideBidAskFlip(position = {}, params = evilPandaParams()) {
  if (position?.leg === "token_flip") {
    return { action: "close", reason: "already token-sided — close only", via: "flip_leg" };
  }
  const token = finiteNumber(position?.token_value_usd, position?.tokenValueUsd);
  const sol = finiteNumber(position?.sol_value_usd, position?.solValueUsd);
  if (token == null || sol == null) {
    return { action: "close", reason: "composition unavailable — close only", via: "composition" };
  }
  const total = token + sol;
  if (total <= 0) {
    return { action: "close", reason: "empty position — close only", via: "composition" };
  }
  const tokenPct = (token / total) * 100;
  if (tokenPct > params.tokenMajorityPct) {
    return {
      action: "flip",
      side: "token",
      abovePrice: true,
      strategy: "bid_ask",
      binsBelow: 0,
      tokenPct,
      reason: "mostly token — close and redeploy token-sided bid-ask above price",
      via: "composition",
    };
  }
  return {
    action: "close",
    side: null,
    abovePrice: false,
    tokenPct,
    reason: "mostly SOL — close only; re-enter via screening",
    via: "composition",
  };
}

/**
 * Cut-loss (existing stop-loss / OOR from updatePnlAndCheckExits) wins.
 * The indicator exit then either flips a token-heavy SOL leg or closes.
 */
export function planEvilPandaManagement({ position, exitTrigger, cutLossRule, params = evilPandaParams() } = {}) {
  if (cutLossRule) {
    return {
      action: "close",
      reason: cutLossRule.reason || cutLossRule.action || "existing cut-loss",
      via: "cut_loss",
    };
  }
  if (position?.pnl_pct_suspicious) {
    return { action: "stay", reason: "unpriced tick — hold" };
  }
  if (!exitTrigger?.confirmed) {
    return { action: "stay", reason: exitTrigger?.reason || "exit trigger not confirmed" };
  }
  return decideBidAskFlip(position, params);
}

export function capBins(binsBelow, binsAbove, maxTotalBins) {
  let below = Math.max(0, Math.round(Number(binsBelow) || 0));
  let above = Math.max(0, Math.round(Number(binsAbove) || 0));
  const cap = Math.max(0, Math.round(Number(maxTotalBins) || 0));
  if (below + above <= cap) return { binsBelow: below, binsAbove: above, capped: false };
  if (above === 0) return { binsBelow: cap, binsAbove: 0, capped: true };
  if (below === 0) return { binsBelow: 0, binsAbove: cap, capped: true };
  const scaledBelow = Math.floor((below / (below + above)) * cap);
  return { binsBelow: scaledBelow, binsAbove: cap - scaledBelow, capped: true };
}
