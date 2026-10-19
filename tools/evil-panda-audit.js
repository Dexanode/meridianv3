/**
 * Evil Panda anti-rug order:
 * 1. Jupiter assets/search, batched, for every candidate.
 * 2. SolanaTracker only for mints that passed the Jupiter gates.
 * 3. DexScreener CTO only for mints that passed SolanaTracker.
 * A failed or incomplete lookup skips. It does not pass.
 */

import { log } from "../logger.js";
import { batchJupiterAudits } from "./token.js";
import { getSolanaTrackerRisk } from "./solanatracker.js";
import { getDexScreenerCto } from "./dexscreener.js";
import {
  evilPandaParams,
  evaluateJupiterPreset,
  evaluateTrackerPreset,
  evaluateCtoPreset,
} from "./evil-panda.js";

function rowMint(row) {
  return row?.pool?.base?.mint || row?.ti?.mint || null;
}

function rowName(row) {
  return row?.pool?.name || rowMint(row) || "unknown";
}

export async function runEvilPandaAntiRug(rows, gates = evilPandaParams(), deps = {}) {
  const batch = deps.batchJupiterAudits || batchJupiterAudits;
  const tracker = deps.getSolanaTrackerRisk || getSolanaTrackerRisk;
  const cto = deps.getDexScreenerCto || getDexScreenerCto;
  const checkFees = deps.checkFees !== false;
  const audits = await batch(rows.map(rowMint).filter(Boolean));
  const filteredOut = [];
  const afterJupiter = [];

  for (const row of rows) {
    const mint = rowMint(row);
    const audit = mint ? audits.get(mint) : null;
    const decision = evaluateJupiterPreset({
      jupiter_ok: !!audit?.jupiter_ok,
      jupiter_reason: audit?.jupiter_reason,
      top_holders_pct: audit?.top_holders_pct,
      bot_holders_pct: audit?.bot_holders_pct,
      dev_pct: audit?.dev_pct,
      dev_mints: audit?.dev_mints,
      bundler_pct: audit?.bundler_pct,
      bundler_stats_present: !!audit?.bundler_stats_present,
      global_fees_sol: row?.ti?.global_fees_sol,
    }, gates, { checkFees });
    if (!decision.pass) {
      filteredOut.push({ name: rowName(row), reason: decision.reasons[0] });
      continue;
    }
    afterJupiter.push({ row, mint, bundlerDeferred: decision.bundlerDeferred });
  }

  const afterTracker = [];
  for (const item of afterJupiter) {
    const risk = await tracker(item.mint);
    const decision = evaluateTrackerPreset(risk, gates, { bundlerDeferred: item.bundlerDeferred });
    if (!decision.pass) {
      filteredOut.push({ name: rowName(item.row), reason: decision.reasons[0] });
      continue;
    }
    afterTracker.push(item);
  }

  const passing = [];
  for (const item of afterTracker) {
    const dex = await cto(item.mint);
    const decision = evaluateCtoPreset(dex);
    if (!decision.pass) {
      filteredOut.push({ name: rowName(item.row), reason: decision.reasons[0] });
      continue;
    }
    passing.push(item.row);
  }

  for (const entry of filteredOut) {
    log("screening", `Evil panda filter: dropped ${entry.name} — ${entry.reason}`);
  }
  return { passing, filteredOut };
}
