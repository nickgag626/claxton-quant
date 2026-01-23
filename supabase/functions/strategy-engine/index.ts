import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Entry cooldown cache: key -> expiry timestamp (prevents spam on rejected entries)
// Key format: strategyId:underlying:expiration:sortedStrikes
const entryCooldownCache = new Map<string, number>();
const ENTRY_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes

// In-flight order cache: tracks recently submitted orders to prevent duplicate entries
// Key format: underlying:expiration:sortedSymbols (symbols, not strikes, for exact match)
// This prevents race conditions where broker positions haven't updated yet
const inFlightOrderCache = new Map<string, number>();
const IN_FLIGHT_ORDER_TTL_MS = 90 * 1000; // 90 seconds (covers 60s verification window + buffer)

// === VERIFIED ENTRY CONSTANTS ===
const VERIFICATION_TIMEOUT_MS = 60 * 1000; // 60 seconds max wait for fill
const VERIFICATION_POLL_INTERVAL_MS = 3000; // Poll every 3 seconds
const BAILOUT_ORDER_DELAY_MS = 300; // 300ms between bail-out orders to avoid throttling

// === SAFETY CONSTANTS ===
const DEFAULT_MAX_BID_ASK_SPREAD_PERCENT = 10; // Default max spread 10%
const ORDER_TIMEOUT_MS = 60 * 1000; // Mark order as timeout_unknown after 60s in submitted state

// === MAX DAILY LOSS TRACKING ===
const dailyLossTracker = new Map<string, { date: string; realizedLoss: number; haltTriggered: boolean }>();
const DEFAULT_MAX_DAILY_LOSS_DOLLARS = 1000; // Default max daily loss $1000

function generateInFlightKey(underlying: string, expiration: string, legs: any[]): string {
  // Use sorted option symbols for exact match (catches duplicate condors with same strikes)
  const symbols = legs.map(l => l.option_symbol || l.symbol).filter(Boolean).sort().join(',');
  return `${underlying}:${expiration}:${symbols}`;
}

function isOrderInFlight(key: string): boolean {
  const expiry = inFlightOrderCache.get(key);
  if (!expiry) return false;
  if (Date.now() < expiry) return true;
  inFlightOrderCache.delete(key);
  return false;
}

function setOrderInFlight(key: string): void {
  inFlightOrderCache.set(key, Date.now() + IN_FLIGHT_ORDER_TTL_MS);
  console.log(`[IN_FLIGHT] Set order in-flight: ${key}`);
}

function getInFlightSymbols(): Set<string> {
  // Return all symbols from orders currently in-flight
  const symbols = new Set<string>();
  const now = Date.now();
  for (const [key, expiry] of inFlightOrderCache.entries()) {
    if (now < expiry) {
      // Extract symbols from key (format: underlying:expiration:sym1,sym2,sym3,sym4)
      const parts = key.split(':');
      if (parts.length >= 3) {
        const symbolList = parts[2].split(',');
        symbolList.forEach(s => symbols.add(s));
      }
    } else {
      inFlightOrderCache.delete(key);
    }
  }
  return symbols;
}

/**
 * Extract underlying from OCC option symbol (e.g., SPY260115P00580000 -> SPY)
 */
function extractUnderlyingFromOccSymbol(symbol: string): string | null {
  const match = symbol.match(/^([A-Z]+)\d{6}[CP]/);
  return match ? match[1] : null;
}

function generateEntryCooldownKey(strategyId: string, underlying: string, expiration: string, legs: any[]): string {
  const strikes = legs.map(l => l.strike).sort((a, b) => a - b).join('-');
  return `${strategyId}:${underlying}:${expiration}:${strikes}`;
}

function isEntryCoolingDown(key: string): boolean {
  const expiry = entryCooldownCache.get(key);
  if (!expiry) return false;
  if (Date.now() < expiry) return true;
  entryCooldownCache.delete(key);
  return false;
}

function setEntryCooldown(key: string): void {
  entryCooldownCache.set(key, Date.now() + ENTRY_COOLDOWN_MS);
}

/**
 * Normalize leg side to direction: 'short' or 'long'
 * Short: sell_to_open, sold, short
 * Long: buy_to_open, bought, long
 */
function normalizeLegDir(side: string | null | undefined): 'short' | 'long' | null {
  if (!side) return null;
  const s = side.toLowerCase();
  if (s.includes('sell') || s === 'short' || s === 'sold') return 'short';
  if (s.includes('buy') || s === 'long' || s === 'bought') return 'long';
  return null;
}

/**
 * Validate bid/ask spread for all legs before order submission.
 * Returns validation result with spread details per leg.
 */
interface SpreadValidationResult {
  valid: boolean;
  maxSpreadPercent: number;
  legs: Array<{
    symbol: string;
    bid: number;
    ask: number;
    spreadPercent: number;
    exceedsMax: boolean;
  }>;
  failedSymbols: string[];
  reason?: string;
}

async function validateBidAskSpreads(
  legSymbols: string[],
  maxSpreadPercent: number,
  apiToken: string,
  baseUrl: string
): Promise<SpreadValidationResult> {
  const result: SpreadValidationResult = {
    valid: true,
    maxSpreadPercent,
    legs: [],
    failedSymbols: [],
  };

  if (legSymbols.length === 0) {
    return result;
  }

  try {
    // Fetch quotes for all leg symbols
    const quotesUrl = `${baseUrl}/markets/quotes?symbols=${legSymbols.join(',')}`;
    const headers = { 'Authorization': `Bearer ${apiToken}`, 'Accept': 'application/json' };
    const response = await fetch(quotesUrl, { headers });
    const data = await response.json();

    const quotesRaw = data?.quotes?.quote;
    const quotes = quotesRaw ? (Array.isArray(quotesRaw) ? quotesRaw : [quotesRaw]) : [];
    const quoteMap = new Map<string, { bid: number; ask: number }>();

    for (const q of quotes) {
      if (q.symbol) {
        quoteMap.set(q.symbol, { bid: q.bid || 0, ask: q.ask || 0 });
      }
    }

    // Validate each leg
    for (const symbol of legSymbols) {
      const quote = quoteMap.get(symbol);
      if (!quote) {
        result.legs.push({
          symbol,
          bid: 0,
          ask: 0,
          spreadPercent: 100,
          exceedsMax: true,
        });
        result.failedSymbols.push(symbol);
        result.valid = false;
        continue;
      }

      const { bid, ask } = quote;
      const midpoint = (bid + ask) / 2;
      const spreadPercent = midpoint > 0 ? ((ask - bid) / midpoint) * 100 : 100;
      const exceedsMax = spreadPercent > maxSpreadPercent;

      result.legs.push({
        symbol,
        bid,
        ask,
        spreadPercent: Math.round(spreadPercent * 100) / 100,
        exceedsMax,
      });

      if (exceedsMax) {
        result.failedSymbols.push(symbol);
        result.valid = false;
      }
    }

    if (!result.valid) {
      result.reason = `Bid/ask spread exceeds ${maxSpreadPercent}% on: ${result.failedSymbols.join(', ')}`;
    }

  } catch (error) {
    console.error('[validateBidAskSpreads] Error fetching quotes:', error);
    result.valid = false;
    result.reason = 'Failed to fetch quotes for spread validation';
  }

  return result;
}

/**
 * Get current ET date string (YYYY-MM-DD)
 */
function getETDateString(): string {
  const now = new Date();
  const etString = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(etString);
  return `${etDate.getFullYear()}-${String(etDate.getMonth() + 1).padStart(2, '0')}-${String(etDate.getDate()).padStart(2, '0')}`;
}

/**
 * Check if max daily loss has been triggered.
 * Returns true if trading should be halted.
 */
function checkMaxDailyLoss(
  accountId: string,
  currentLoss: number,
  maxDailyLoss: number = DEFAULT_MAX_DAILY_LOSS_DOLLARS
): { halted: boolean; currentLoss: number; maxDailyLoss: number; reason?: string } {
  const today = getETDateString();
  let tracker = dailyLossTracker.get(accountId);

  // Reset tracker if it's a new day
  if (!tracker || tracker.date !== today) {
    tracker = { date: today, realizedLoss: 0, haltTriggered: false };
    dailyLossTracker.set(accountId, tracker);
  }

  // If halt was already triggered today, maintain it
  if (tracker.haltTriggered) {
    return {
      halted: true,
      currentLoss: tracker.realizedLoss,
      maxDailyLoss,
      reason: `Max daily loss of $${maxDailyLoss} was triggered earlier today`,
    };
  }

  // Check if current loss exceeds max
  if (currentLoss >= maxDailyLoss) {
    tracker.realizedLoss = currentLoss;
    tracker.haltTriggered = true;
    dailyLossTracker.set(accountId, tracker);
    return {
      halted: true,
      currentLoss,
      maxDailyLoss,
      reason: `Max daily loss of $${maxDailyLoss} exceeded (current: $${currentLoss.toFixed(2)})`,
    };
  }

  return {
    halted: false,
    currentLoss,
    maxDailyLoss,
  };
}

/**
 * Update daily loss tracker with realized loss from a trade.
 */
function recordRealizedLoss(accountId: string, lossAmount: number): void {
  const today = getETDateString();
  let tracker = dailyLossTracker.get(accountId);

  if (!tracker || tracker.date !== today) {
    tracker = { date: today, realizedLoss: 0, haltTriggered: false };
  }

  if (lossAmount > 0) {
    tracker.realizedLoss += lossAmount;
    dailyLossTracker.set(accountId, tracker);
    console.log(`[DAILY_LOSS] Recorded loss of $${lossAmount.toFixed(2)}, total today: $${tracker.realizedLoss.toFixed(2)}`);
  }
}

/**
 * Get mark price for a leg with fallbacks:
 * 1. markPrice if present
 * 2. mid = (bid + ask) / 2 if both exist
 * 3. last price
 * 4. 0 (invalid)
 */
function getMarkPrice(leg: any): number {
  if (typeof leg.markPrice === 'number' && leg.markPrice > 0) {
    return leg.markPrice;
  }
  const bid = Number(leg.bid ?? 0);
  const ask = Number(leg.ask ?? 0);
  if (bid > 0 && ask > 0) {
    return (bid + ask) / 2;
  }
  const last = Number(leg.lastPrice ?? leg.last ?? 0);
  if (last > 0) {
    return last;
  }
  return 0;
}

/**
 * Infer leg direction from option symbol strikes for iron condors
 * Returns 'short' or 'long' based on iron condor structure:
 * - Calls: lower strike = short, higher strike = long
 * - Puts: higher strike = short, lower strike = long
 */
function inferLegDirFromStrikes(
  legSymbol: string, 
  allLegSymbols: string[]
): 'short' | 'long' | null {
  // Parse OCC symbol: ROOT + YYMMDD + C/P + 8-digit strike
  const parseSymbol = (sym: string) => {
    const match = sym.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (!match) return null;
    return {
      optionType: match[3] as 'C' | 'P',
      strike: parseInt(match[4], 10) / 1000,
    };
  };
  
  const thisParsed = parseSymbol(legSymbol);
  if (!thisParsed) return null;
  
  // Get all legs of same option type
  const sameType = allLegSymbols
    .map(s => ({ symbol: s, parsed: parseSymbol(s) }))
    .filter(x => x.parsed && x.parsed.optionType === thisParsed.optionType);
  
  if (sameType.length !== 2) return null; // Need exactly 2 for spread
  
  // Sort by strike
  sameType.sort((a, b) => a.parsed!.strike - b.parsed!.strike);
  
  const isLowerStrike = sameType[0].symbol === legSymbol;
  
  if (thisParsed.optionType === 'C') {
    // Calls: lower = short, higher = long
    return isLowerStrike ? 'short' : 'long';
  } else {
    // Puts: lower = long, higher = short
    return isLowerStrike ? 'long' : 'short';
  }
}

interface PositionConflict {
  symbol: string;
  proposedSide: string;
  existingQty: number;
  conflict: 'long_vs_sell_open' | 'short_vs_buy_open';
  resolution: 'block' | 'netting_applied';
  convertedQty?: number;
}

interface ConflictCheckResult {
  hasConflict: boolean;
  entryConflict: boolean;
  conflictSymbols: string[];
  conflicts: PositionConflict[];
  canProceed: boolean;
  adjustedLegs: any[];
  nettingApplied: boolean;
}

// Check for position conflicts before entry
// STRICT MODE (default): Block on ANY overlap - no auto-conversion
// NETTING MODE: Only enabled when allowNetting=true explicitly
function checkEntryConflicts(
  proposedLegs: any[],
  brokerPositions: Array<{ symbol: string; quantity: number }>,
  allowNetting: boolean = false // Default: STRICT mode - no netting
): ConflictCheckResult {
  const positionMap = new Map<string, number>();
  for (const pos of brokerPositions) {
    const existing = positionMap.get(pos.symbol) || 0;
    positionMap.set(pos.symbol, existing + pos.quantity);
  }
  
  const conflicts: PositionConflict[] = [];
  const conflictSymbols: string[] = [];
  const adjustedLegs = proposedLegs.map(leg => ({ ...leg }));
  let hasConflict = false;
  let nettingApplied = false;
  
  for (let i = 0; i < adjustedLegs.length; i++) {
    const leg = adjustedLegs[i];
    const optionSymbol = leg.option_symbol || leg.symbol;
    const existingQty = positionMap.get(optionSymbol) || 0;
    
    if (existingQty === 0) continue;
    
    // ANY overlap with existing position = conflict
    hasConflict = true;
    if (!conflictSymbols.includes(optionSymbol)) {
      conflictSymbols.push(optionSymbol);
    }
    
    // Long position exists + sell_to_open = conflict
    if (existingQty > 0 && leg.side === 'sell_to_open') {
      if (allowNetting && existingQty >= leg.quantity) {
        // NETTING MODE: Convert to sell_to_close
        conflicts.push({
          symbol: optionSymbol,
          proposedSide: leg.side,
          existingQty,
          conflict: 'long_vs_sell_open',
          resolution: 'netting_applied',
          convertedQty: leg.quantity,
        });
        adjustedLegs[i] = { ...leg, side: 'sell_to_close' };
        nettingApplied = true;
      } else {
        // STRICT MODE: Block entry
        conflicts.push({
          symbol: optionSymbol,
          proposedSide: leg.side,
          existingQty,
          conflict: 'long_vs_sell_open',
          resolution: 'block',
        });
      }
    }
    
    // Short position exists + buy_to_open = conflict
    if (existingQty < 0 && leg.side === 'buy_to_open') {
      const absExisting = Math.abs(existingQty);
      if (allowNetting && absExisting >= leg.quantity) {
        // NETTING MODE: Convert to buy_to_close
        conflicts.push({
          symbol: optionSymbol,
          proposedSide: leg.side,
          existingQty,
          conflict: 'short_vs_buy_open',
          resolution: 'netting_applied',
          convertedQty: leg.quantity,
        });
        adjustedLegs[i] = { ...leg, side: 'buy_to_close' };
        nettingApplied = true;
      } else {
        // STRICT MODE: Block entry
        conflicts.push({
          symbol: optionSymbol,
          proposedSide: leg.side,
          existingQty,
          conflict: 'short_vs_buy_open',
          resolution: 'block',
        });
      }
    }
    
    // Also catch any position overlap even if sides don't match the patterns above
    // (e.g., existing long and trying to buy more - still a potential structure issue)
    if (existingQty !== 0 && !conflicts.some(c => c.symbol === optionSymbol)) {
      conflicts.push({
        symbol: optionSymbol,
        proposedSide: leg.side,
        existingQty,
        conflict: existingQty > 0 ? 'long_vs_sell_open' : 'short_vs_buy_open',
        resolution: 'block',
      });
    }
  }
  
  // In STRICT mode, any conflict blocks entry
  // In NETTING mode, only blocks if netting couldn't fully resolve
  const canProceed = !hasConflict || (allowNetting && conflicts.every(c => c.resolution === 'netting_applied'));
  
  return { 
    hasConflict,
    entryConflict: hasConflict && !canProceed,
    conflictSymbols,
    conflicts, 
    canProceed, 
    adjustedLegs,
    nettingApplied,
  };
}

// Types
type ExitTriggerMode = 'percent_only' | 'dollars_only' | 'both_required' | 'either';

interface Strategy {
  id: string;
  name: string;
  type: string;
  underlying: string;
  enabled: boolean;
  maxPositions: number;
  positionSize: number;
  entryConditions: {
    minDte: number;
    maxDte: number;
    shortDeltaTarget?: number;
    longDeltaTarget?: number;
    maxDelta?: number; // deprecated
    minPremium?: number;
    minIvRank?: number;
    maxIvRank?: number;
    marketHoursOnly: boolean;
    startTime?: string;
    endTime?: string;
    maFilter?: {
      enabled: boolean;
      sma20?: boolean;
      sma50?: boolean;
      sma200?: boolean;
      rules?: Array<{ left: string; op: string; right: string }>;
    };
    // Higher-conviction entry filters
    minWingWidthPoints?: number;
    maxBidAskSpreadPerLegPercent?: number;
    minEntryCreditDollars?: number;
  };
  exitConditions: {
    profitTargetPercent: number;
    stopLossPercent: number;
    timeStopDte?: number;
    timeStopTime?: string;
    trailingStop?: {
      enabled: boolean;
      type: string;
      amount: number;
      activationProfit?: number;
      basis?: string;
    };
    // Dollar-based exits
    profitTargetDollars?: number;
    stopLossDollars?: number;
    exitTriggerMode?: ExitTriggerMode;
  };
  sizing?: {
    mode: 'fixed' | 'risk';
    fixedContracts?: number;
    riskPerTrade?: number;
    maxContracts?: number;
    maxTotalRiskDollars?: number;
    minContractsOnRisk?: number;
  };
  trackedLegs?: Array<{
    role: string;
    optionType: string;
    side: string;
    closeOnExit: boolean;
  }>;
}

interface Safeguards {
  maxBidAskSpreadPercent: number;
  zeroDteCloseBufferMinutes: number;
  fillPriceBufferPercent: number;
  maxCondorsPerExpiry: number;
  maxDailyLossDollars?: number;
  maxConsecutiveRejections?: number;
}

interface OptionContract {
  symbol: string;
  strike: number;
  option_type: string;
  expiration_date: string;
  bid: number;
  ask: number;
  greeks?: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
  };
}

interface Gate {
  name: string;
  expected: string;
  actual: Record<string, unknown> | string | number | boolean;
  pass: boolean;
  reason?: string;
}

interface JitterResult {
  applied: boolean;
  existingCondors: number;
  strikeStep: number;
  offset: number;
  jitterSize: number;
  originalStrikes: { shortPut: number; longPut: number; shortCall: number; longCall: number };
  shiftedStrikes: { shortPut: number; longPut: number; shortCall: number; longCall: number };
  allUnique: boolean;
  allExistInChain: boolean;
}

interface EvaluationResult {
  decision: 'PASS' | 'FAIL' | 'OPEN' | 'SKIP' | 'CLOSE' | 'HOLD';
  reason: string;
  gates: Gate[];
  inputs: {
    market: Record<string, unknown>;
    account: Record<string, unknown>;
  };
  proposedOrder?: {
    legs: Array<{
      role: string;
      option_symbol?: string;
      strike: number;
      delta: number;
      side: string;
      quantity: number;
    }>;
    estimated_credit?: number;
    estimated_max_loss?: number;
    entry_rationale?: string;
    sizing_result?: {
      mode: string;
      computed_contracts: number;
      risk_per_trade?: number;
    };
    jitter?: JitterResult;
  };
}

// Compute strike step from option chain (minimum adjacent strike difference)
function computeStrikeStep(options: OptionContract[]): number {
  const strikes = [...new Set(options.map(o => o.strike))].sort((a, b) => a - b);
  if (strikes.length < 2) return 1;
  
  let minStep = Infinity;
  for (let i = 1; i < strikes.length; i++) {
    const diff = strikes[i] - strikes[i - 1];
    if (diff > 0 && diff < minStep) {
      minStep = diff;
    }
  }
  return minStep === Infinity ? 1 : minStep;
}

// Count existing condors for a given underlying+expiration from broker positions
function countExistingCondors(
  brokerPositions: Array<{ symbol: string; quantity: number }>,
  underlying: string,
  expiration: string
): number {
  // Parse OCC symbols to find matching positions
  // OCC format: SYMBOL + YYMMDD + C/P + Strike (8 digits)
  // Example: SPY260113C00580000
  
  const matchingPositions = brokerPositions.filter(p => {
    // Extract underlying from symbol
    const match = p.symbol.match(/^([A-Z]+)\d{6}/);
    if (!match) return false;
    const posUnderlying = match[1];
    
    // Extract expiration (YYMMDD)
    const expMatch = p.symbol.match(/^[A-Z]+(\d{6})/);
    if (!expMatch) return false;
    const posExpYYMMDD = expMatch[1];
    
    // Convert expiration to YYMMDD for comparison
    // Input format might be YYYY-MM-DD
    const expDate = new Date(expiration);
    const expYYMMDD = expDate.toISOString().slice(2, 4) + 
                      expDate.toISOString().slice(5, 7) + 
                      expDate.toISOString().slice(8, 10);
    
    return posUnderlying === underlying && posExpYYMMDD === expYYMMDD;
  });
  
  // Group by trade_group heuristically: 4-leg structures = 1 condor
  // Count unique strikes to estimate condor count
  const uniqueStrikes = new Set<number>();
  for (const pos of matchingPositions) {
    // Extract strike from OCC symbol (last 8 digits, divide by 1000)
    const strikeMatch = pos.symbol.match(/\d{8}$/);
    if (strikeMatch) {
      const strike = parseInt(strikeMatch[0]) / 1000;
      uniqueStrikes.add(strike);
    }
  }
  
  // Iron condor has 4 distinct strikes
  // Estimate condor count = floor(unique strikes / 4)
  // This is conservative - if there are 8 strikes, we assume 2 condors
  const condorCount = Math.floor(uniqueStrikes.size / 4);
  
  return condorCount;
}

// Helper: Get current ET time with full provenance
function getETTime(): { 
  now: Date; 
  timeStr: string; 
  dateStr: string; 
  isoET: string;
  utcIso: string;
} {
  const now = new Date();
  const etOptions: Intl.DateTimeFormatOptions = { 
    timeZone: 'America/New_York', 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false 
  };
  const etFormatter = new Intl.DateTimeFormat('en-US', etOptions);
  const etParts = etFormatter.formatToParts(now);
  const etHour = etParts.find(p => p.type === 'hour')?.value || '00';
  const etMinute = etParts.find(p => p.type === 'minute')?.value || '00';
  const timeStr = `${etHour}:${etMinute}`;
  
  const dateFormatter = new Intl.DateTimeFormat('en-US', { 
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const dateStr = dateFormatter.format(now);
  
  // Full ISO in ET for storage
  const fullFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const isoET = fullFormatter.format(now).replace(', ', 'T');
  
  return { now, timeStr, dateStr, isoET, utcIso: now.toISOString() };
}

// Evaluate a single strategy with full trace - ALWAYS emits all gates
async function evaluateStrategyWithTrace(
  strategy: Strategy,
  marketState: string,
  positions: any[],
  apiToken: string,
  baseUrl: string,
  supabaseClient: any,
  evalOptions?: { 
    overrideMarketStatus?: string;
    overrideTimeET?: string; // Format: "HH:MM"
  }
): Promise<EvaluationResult> {
  const gates: Gate[] = [];
  const { timeStr: realTimeStr, dateStr, isoET, utcIso } = getETTime();
  const today = new Date();
  
  // Determine effective market state (support override for testing)
  const effectiveMarketState = evalOptions?.overrideMarketStatus || marketState;
  const isMarketOverridden = !!evalOptions?.overrideMarketStatus;
  
  // Determine effective time (support override for testing)
  const effectiveTimeStr = evalOptions?.overrideTimeET || realTimeStr;
  const isTimeOverridden = !!evalOptions?.overrideTimeET;
  
  // Get delta target (support both old and new field names) with provenance
  const usedDeltaField = strategy.entryConditions.shortDeltaTarget !== undefined 
    ? 'shortDeltaTarget' 
    : strategy.entryConditions.maxDelta !== undefined 
    ? 'maxDelta (legacy)' 
    : 'default (0.16)';
  const shortDeltaTarget = strategy.entryConditions.shortDeltaTarget ?? strategy.entryConditions.maxDelta ?? 0.16;
  const longDeltaTarget = strategy.entryConditions.longDeltaTarget;
  
  // Initialize inputs with full clock provenance
  const inputs: EvaluationResult['inputs'] = {
    market: {
      now_et: `${dateStr} ${effectiveTimeStr}`,
      now_et_iso: isoET,
      now_utc_iso: utcIso,
      now_et_real: realTimeStr,
      underlying: strategy.underlying,
      clock_source: 'tradier_clock',
      clock_state_raw: marketState,
      clock_state_effective: effectiveMarketState,
      market_override_applied: isMarketOverridden,
      time_override_applied: isTimeOverridden,
      time_override_value: evalOptions?.overrideTimeET || null,
      strategy_startTime: strategy.entryConditions.startTime || null,
      strategy_endTime: strategy.entryConditions.endTime || null,
      marketHoursOnly: strategy.entryConditions.marketHoursOnly,
    },
    account: {
      open_positions_count: 0,
      max_positions: strategy.maxPositions,
    },
  };
  
  // Track if we hit a hard stop (for downstream gates)
  let hardStop = false;
  let hardStopReason = '';
  
  // GATE 1: Market Hours
  const marketHoursPass = !strategy.entryConditions.marketHoursOnly || effectiveMarketState === 'open';
  const marketHoursGate: Gate = {
    name: 'Market Hours',
    expected: strategy.entryConditions.marketHoursOnly ? 'market open' : 'any',
    actual: { 
      raw_state: marketState, 
      effective_state: effectiveMarketState,
      override_applied: isMarketOverridden,
      marketHoursOnly: strategy.entryConditions.marketHoursOnly,
    },
    pass: marketHoursPass,
    reason: !marketHoursPass 
      ? `Market is ${effectiveMarketState}, requires open` 
      : undefined,
  };
  gates.push(marketHoursGate);
  
  if (!marketHoursPass) {
    hardStop = true;
    hardStopReason = 'market_closed';
  }
  
  // GATE 2: Time Window (ET) - evaluate even if hard stop
  let timeWindowPass = true;
  let timeWindowReason: string | undefined;
  
  if (hardStop) {
    timeWindowPass = false;
    timeWindowReason = `skipped_due_to_${hardStopReason}`;
  } else {
    if (strategy.entryConditions.startTime && effectiveTimeStr < strategy.entryConditions.startTime) {
      timeWindowPass = false;
      timeWindowReason = `Current time ${effectiveTimeStr} is before start time ${strategy.entryConditions.startTime}`;
    }
    if (strategy.entryConditions.endTime && effectiveTimeStr > strategy.entryConditions.endTime) {
      timeWindowPass = false;
      timeWindowReason = `Current time ${effectiveTimeStr} is after end time ${strategy.entryConditions.endTime}`;
    }
  }
  
  const timeWindowGate: Gate = {
    name: 'Time Window (ET)',
    expected: strategy.entryConditions.startTime && strategy.entryConditions.endTime 
      ? `${strategy.entryConditions.startTime} - ${strategy.entryConditions.endTime}`
      : 'any',
    actual: { 
      current_time: effectiveTimeStr, 
      real_time: realTimeStr,
      time_override_applied: isTimeOverridden,
      startTime: strategy.entryConditions.startTime, 
      endTime: strategy.entryConditions.endTime 
    },
    pass: timeWindowPass,
    reason: timeWindowReason,
  };
  gates.push(timeWindowGate);
  
  if (!timeWindowPass && !hardStop) {
    hardStop = true;
    hardStopReason = 'time_window';
  }
  
  // GATE 3: Max Positions
  const strategyPositions = (positions || []).filter(
    (p: any) => p.strategyName === strategy.name && p.status === 'open'
  );
  const openPositionsCount = strategyPositions.length;
  inputs.account.open_positions_count = openPositionsCount;
  
  let maxPositionsPass = openPositionsCount < strategy.maxPositions;
  let maxPositionsReason: string | undefined;
  
  if (hardStop) {
    maxPositionsPass = false;
    maxPositionsReason = `skipped_due_to_${hardStopReason}`;
  } else if (!maxPositionsPass) {
    maxPositionsReason = `Position limit reached (${openPositionsCount}/${strategy.maxPositions})`;
  }
  
  const maxPositionsGate: Gate = {
    name: 'Max Positions',
    expected: `open < ${strategy.maxPositions}`,
    actual: { open: openPositionsCount, max: strategy.maxPositions },
    pass: maxPositionsPass,
    reason: maxPositionsReason,
  };
  gates.push(maxPositionsGate);
  
  if (!maxPositionsPass && !hardStop) {
    hardStop = true;
    hardStopReason = 'max_positions';
  }
  
  // Fetch option data - with caching for after-hours evaluation
  const headers = {
    'Authorization': `Bearer ${apiToken}`,
    'Accept': 'application/json',
  };
  
  let expirations: string[] = [];
  let optionChain: OptionContract[] = [];
  let underlyingPrice: number | null = null;
  let targetExpiration: string | null = null;
  let selectedDte: number | null = null;
  let dataFetchError = false;
  let dataSource: 'live' | 'cache' = 'live';
  let cacheTimestamp: string | null = null;
  
  // Helper: Get cached data
  async function getCachedData(underlying: string, cacheType: string, expiration?: string): Promise<{ data: any; cachedAt: string } | null> {
    const query = supabaseClient
      .from('options_cache')
      .select('data, cached_at')
      .eq('underlying', underlying)
      .eq('cache_type', cacheType)
      .gt('expires_at', new Date().toISOString())
      .order('cached_at', { ascending: false })
      .limit(1);
    
    if (expiration) {
      query.eq('expiration', expiration);
    }
    
    const { data } = await query.single();
    return data ? { data: data.data, cachedAt: data.cached_at } : null;
  }
  
  // Helper: Save to cache (expires in 4 hours for after-hours use)
  async function saveToCache(underlying: string, cacheType: string, cacheData: any, expiration?: string): Promise<void> {
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(); // 4 hours
    await supabaseClient.from('options_cache').upsert({
      underlying,
      cache_type: cacheType,
      expiration: expiration || null,
      data: cacheData,
      cached_at: new Date().toISOString(),
      expires_at: expiresAt,
    }, { onConflict: 'underlying,cache_type,expiration' }).select();
  }
  
  // Fetch expirations (always try, even if hardStop - for testing/cache)
  const expUrl = `${baseUrl}/markets/options/expirations?symbol=${strategy.underlying}`;
  console.log(`[OPTIONS] Fetching expirations: ${expUrl}`);
  
  try {
    const expResponse = await fetch(expUrl, { headers });
    const expStatus = expResponse.status;
    const expData = await expResponse.json();
    console.log(`[OPTIONS] Expirations response (${expStatus}):`, JSON.stringify(expData).slice(0, 200));
    
    expirations = expData?.expirations?.date || [];
    
    // If we got live data, cache it
    if (expirations.length > 0) {
      await saveToCache(strategy.underlying, 'expirations', expirations);
    } else {
      // Try cache if live returned empty (after-hours)
      console.log(`[OPTIONS] No live expirations, checking cache...`);
      const cached = await getCachedData(strategy.underlying, 'expirations');
      if (cached) {
        expirations = cached.data;
        dataSource = 'cache';
        cacheTimestamp = cached.cachedAt;
        console.log(`[OPTIONS] Using cached expirations from ${cached.cachedAt}: ${expirations.length} dates`);
      }
    }
  } catch (error) {
    console.error(`[OPTIONS] Error fetching expirations:`, error);
    // Try cache on error
    const cached = await getCachedData(strategy.underlying, 'expirations');
    if (cached) {
      expirations = cached.data;
      dataSource = 'cache';
      cacheTimestamp = cached.cachedAt;
      console.log(`[OPTIONS] Using cached expirations (fetch error): ${expirations.length} dates`);
    } else {
      dataFetchError = true;
    }
  }
  
  // Find target expiration
  const evalDate = new Date();
  for (const exp of expirations) {
    const expDate = new Date(exp);
    const dte = Math.ceil((expDate.getTime() - evalDate.getTime()) / (1000 * 60 * 60 * 24));
    if (dte >= strategy.entryConditions.minDte && dte <= strategy.entryConditions.maxDte) {
      targetExpiration = exp;
      selectedDte = dte;
      break;
    }
  }
  
  inputs.market.dte_selected = selectedDte;
  inputs.market.expiration_selected = targetExpiration;
  inputs.market.data_source = dataSource;
  if (cacheTimestamp) {
    inputs.market.cache_timestamp = cacheTimestamp;
  }
  
  // Fetch option chain if we have an expiration
  if (targetExpiration) {
    const chainUrl = `${baseUrl}/markets/options/chains?symbol=${strategy.underlying}&expiration=${targetExpiration}&greeks=true`;
    console.log(`[OPTIONS] Fetching chain: ${chainUrl}`);
    
    try {
      const chainResponse = await fetch(chainUrl, { headers });
      const chainStatus = chainResponse.status;
      const chainData = await chainResponse.json();
      const rawChain = chainData?.options?.option || [];
      console.log(`[OPTIONS] Chain response (${chainStatus}): ${rawChain.length} contracts`);
      
      optionChain = rawChain;
      
      // Cache if we got live data
      if (optionChain.length > 0) {
        await saveToCache(strategy.underlying, 'chain', optionChain, targetExpiration);
      } else if (dataSource === 'cache' || optionChain.length === 0) {
        // Try cache for chain
        console.log(`[OPTIONS] No live chain, checking cache...`);
        const cachedChain = await getCachedData(strategy.underlying, 'chain', targetExpiration);
        if (cachedChain) {
          optionChain = cachedChain.data;
          dataSource = 'cache';
          cacheTimestamp = cachedChain.cachedAt;
          console.log(`[OPTIONS] Using cached chain from ${cachedChain.cachedAt}: ${optionChain.length} contracts`);
        }
      }
      
      // Get underlying price
      const quoteUrl = `${baseUrl}/markets/quotes?symbols=${strategy.underlying}`;
      const quoteResponse = await fetch(quoteUrl, { headers });
      const quoteData = await quoteResponse.json();
      underlyingPrice = quoteData?.quotes?.quote?.last || quoteData?.quotes?.quote?.close;
      
      // Cache quote
      if (underlyingPrice) {
        await saveToCache(strategy.underlying, 'quote', { price: underlyingPrice });
      } else {
        const cachedQuote = await getCachedData(strategy.underlying, 'quote');
        if (cachedQuote) {
          underlyingPrice = cachedQuote.data?.price;
          console.log(`[OPTIONS] Using cached quote: ${underlyingPrice}`);
        }
      }
      
      inputs.market.underlying_price = underlyingPrice;
    } catch (error) {
      console.error(`[OPTIONS] Error fetching chain:`, error);
      // Try cache on error
      const cachedChain = await getCachedData(strategy.underlying, 'chain', targetExpiration);
      if (cachedChain) {
        optionChain = cachedChain.data;
        dataSource = 'cache';
        cacheTimestamp = cachedChain.cachedAt;
        console.log(`[OPTIONS] Using cached chain (fetch error): ${optionChain.length} contracts`);
      } else {
        dataFetchError = true;
      }
    }
  }
  
  // Update inputs with final data source info
  inputs.market.data_source = dataSource;
  inputs.market.data_stale = dataSource === 'cache';
  if (cacheTimestamp) {
    inputs.market.cache_timestamp = cacheTimestamp;
  }
  
  // GATE 4: DTE Range
  let dtePass = targetExpiration !== null;
  let dteReason: string | undefined;
  
  if (hardStop) {
    dtePass = false;
    dteReason = `skipped_due_to_${hardStopReason}`;
  } else if (!dtePass) {
    dteReason = dataFetchError 
      ? 'Could not fetch expirations - data unavailable'
      : `No expiration found in DTE range ${strategy.entryConditions.minDte}-${strategy.entryConditions.maxDte}`;
  }
  
  const dteGate: Gate = {
    name: 'DTE Range',
    expected: `${strategy.entryConditions.minDte} - ${strategy.entryConditions.maxDte}`,
    actual: selectedDte !== null 
      ? { dte: selectedDte, expiration: targetExpiration, available_expirations: expirations.slice(0, 5) } 
      : { available_expirations: expirations.slice(0, 5), error: dataFetchError ? 'fetch_failed' : 'no_match' },
    pass: dtePass,
    reason: dteReason,
  };
  gates.push(dteGate);
  
  if (!dtePass && !hardStop) {
    hardStop = true;
    hardStopReason = 'dte_range';
  }
  
  // GATE 5: Delta Selection (Short Strike)
  const puts = optionChain.filter((o: OptionContract) => 
    o.option_type === 'put' && o.greeks && o.bid > 0
  );
  const calls = optionChain.filter((o: OptionContract) => 
    o.option_type === 'call' && o.greeks && o.bid > 0
  );
  
  const shortPut = puts.find((p: OptionContract) => p.greeks && Math.abs(p.greeks.delta) <= shortDeltaTarget + 0.05);
  const shortCall = calls.find((c: OptionContract) => c.greeks && Math.abs(c.greeks.delta) <= shortDeltaTarget + 0.05);
  
  let shortDeltaPass = true;
  if (strategy.type.includes('put') && !shortPut) shortDeltaPass = false;
  if (strategy.type.includes('call') && !shortCall) shortDeltaPass = false;
  if (['iron_condor', 'strangle', 'straddle', 'iron_fly'].includes(strategy.type) && (!shortPut || !shortCall)) {
    shortDeltaPass = false;
  }
  
  let shortDeltaReason: string | undefined;
  if (hardStop) {
    shortDeltaPass = false;
    shortDeltaReason = `skipped_due_to_${hardStopReason}`;
  } else if (!shortDeltaPass) {
    shortDeltaReason = optionChain.length === 0 
      ? 'Option chain unavailable'
      : 'No strikes found matching delta target';
  }
  
  const shortDeltaGate: Gate = {
    name: 'Short Delta Target',
    expected: `|delta| ≤ ${shortDeltaTarget}`,
    actual: {
      usedField: usedDeltaField,
      shortDeltaTarget,
      put: shortPut ? { strike: shortPut.strike, delta: shortPut.greeks?.delta } : 'not found',
      call: shortCall ? { strike: shortCall.strike, delta: shortCall.greeks?.delta } : 'not found',
      chain_size: optionChain.length,
    },
    pass: shortDeltaPass,
    reason: shortDeltaReason,
  };
  gates.push(shortDeltaGate);
  
  // Build proposed order based on strategy type with multi-condor jitter support
  // For iron condors, count existing condors and apply strike jitter if needed
  const jitterConfig = (strategy.type === 'iron_condor' || strategy.type === 'iron_fly') && targetExpiration
    ? {
        existingCondors: countExistingCondors(positions.map(p => ({ symbol: p.symbol, quantity: p.quantity || 1 })), strategy.underlying, targetExpiration),
        maxCondorsPerExpiry: 3, // Default, will be overridden by safeguards when available
        brokerPositionSymbols: positions.map(p => p.symbol),
      }
    : undefined;
  
  const proposedOrder = !hardStop && optionChain.length > 0 
    ? buildProposedOrder(strategy, optionChain, shortDeltaTarget, longDeltaTarget, jitterConfig)
    : null;
  
  // GATE 6: Long Delta Target (for spreads)
  let longDeltaPass = true;
  let longDeltaReason: string | undefined;
  const longLegs = proposedOrder?.legs.filter((l: any) => l.side.includes('buy')) || [];
  
  if (longDeltaTarget !== undefined) {
    if (hardStop) {
      longDeltaPass = false;
      longDeltaReason = `skipped_due_to_${hardStopReason}`;
    } else if (['iron_condor', 'credit_put_spread', 'credit_call_spread', 'iron_fly'].includes(strategy.type) && longLegs.length === 0) {
      longDeltaPass = false;
      longDeltaReason = 'No long strikes found for spread';
    }
  }
  
  const longDeltaGate: Gate = {
    name: 'Long Delta Target',
    expected: longDeltaTarget !== undefined ? `|delta| ≤ ${longDeltaTarget}` : 'not configured',
    actual: longDeltaTarget !== undefined
      ? { longDeltaTarget, legs: longLegs.map((l: any) => ({ strike: l.strike, delta: l.delta })) }
      : { configured: false },
    pass: longDeltaPass,
    reason: longDeltaReason,
  };
  gates.push(longDeltaGate);
  
  // GATE 7: Premium Filter (optional)
  const estimatedCredit = proposedOrder?.estimated_credit || 0;
  const premiumEnabled = !!strategy.entryConditions.minPremium;
  let premiumPass = true;
  let premiumReason: string | undefined;
  
  if (!premiumEnabled) {
    premiumPass = true;
    premiumReason = 'disabled';
  } else if (hardStop) {
    premiumPass = false;
    premiumReason = `skipped_due_to_${hardStopReason}`;
  } else if (optionChain.length === 0 || estimatedCredit === 0) {
    premiumPass = false;
    premiumReason = 'data_unavailable';
  } else if (estimatedCredit < strategy.entryConditions.minPremium!) {
    premiumPass = false;
    premiumReason = `Credit $${estimatedCredit.toFixed(2)} below minimum $${strategy.entryConditions.minPremium}`;
  }
  
  const premiumGate: Gate = {
    name: 'Premium Filter',
    expected: premiumEnabled 
      ? `credit ≥ $${strategy.entryConditions.minPremium}` 
      : 'disabled',
    actual: { 
      enabled: premiumEnabled,
      minPremium: strategy.entryConditions.minPremium || null,
      estimated_credit: estimatedCredit 
    },
    pass: premiumPass,
    reason: premiumReason,
  };
  gates.push(premiumGate);
  
  if (!premiumPass && !hardStop && premiumEnabled && premiumReason !== 'data_unavailable') {
    hardStop = true;
    hardStopReason = 'premium_filter';
  }

  // GATE 7b: Entry Credit Dollar Minimum (optional)
  const minEntryCreditDollars = strategy.entryConditions.minEntryCreditDollars;
  const entryCreditDollarsEnabled = minEntryCreditDollars !== undefined && minEntryCreditDollars > 0;
  let entryCreditDollarsPass = true;
  let entryCreditDollarsReason: string | undefined;

  if (!entryCreditDollarsEnabled) {
    entryCreditDollarsPass = true;
    entryCreditDollarsReason = 'disabled';
  } else if (hardStop) {
    entryCreditDollarsPass = false;
    entryCreditDollarsReason = `skipped_due_to_${hardStopReason}`;
  } else {
    // estimatedCredit is per-contract, multiply by 100 for dollars
    const estimatedCreditDollars = (estimatedCredit || 0) * 100;
    if (estimatedCreditDollars < minEntryCreditDollars) {
      entryCreditDollarsPass = false;
      entryCreditDollarsReason = `Entry credit $${estimatedCreditDollars.toFixed(0)} below minimum $${minEntryCreditDollars}`;
    }
  }

  const entryCreditDollarsGate: Gate = {
    name: 'Entry Credit Dollar Minimum',
    expected: entryCreditDollarsEnabled
      ? `credit ≥ $${minEntryCreditDollars}`
      : 'disabled',
    actual: {
      enabled: entryCreditDollarsEnabled,
      minEntryCreditDollars: minEntryCreditDollars ?? null,
      estimatedCreditDollars: (estimatedCredit || 0) * 100,
    },
    pass: entryCreditDollarsPass,
    reason: entryCreditDollarsReason,
  };
  gates.push(entryCreditDollarsGate);

  if (!entryCreditDollarsPass && !hardStop && entryCreditDollarsEnabled) {
    hardStop = true;
    hardStopReason = 'entry_credit_dollar_minimum';
  }

  // GATE 7c: Minimum Wing Width (optional)
  const minWingWidthRequired = strategy.entryConditions.minWingWidthPoints;
  const wingWidthEnabled = minWingWidthRequired !== undefined && minWingWidthRequired > 0;
  let wingWidthPass = true;
  let wingWidthReason: string | undefined;
  let actualWingWidth = 0;
  let putWidth = 0;
  let callWidth = 0;

  if (!wingWidthEnabled) {
    wingWidthPass = true;
    wingWidthReason = 'disabled';
  } else if (hardStop) {
    wingWidthPass = false;
    wingWidthReason = `skipped_due_to_${hardStopReason}`;
  } else if (proposedOrder?.legs) {
    // Calculate wing widths from proposed order legs
    const putLegs = proposedOrder.legs.filter((l: any) => l.role?.includes('put'));
    const callLegs = proposedOrder.legs.filter((l: any) => l.role?.includes('call'));

    if (putLegs.length >= 2) {
      const putStrikes = putLegs.map((l: any) => l.strike).sort((a: number, b: number) => a - b);
      putWidth = putStrikes[putStrikes.length - 1] - putStrikes[0];
    }
    if (callLegs.length >= 2) {
      const callStrikes = callLegs.map((l: any) => l.strike).sort((a: number, b: number) => a - b);
      callWidth = callStrikes[callStrikes.length - 1] - callStrikes[0];
    }

    // For iron condors, use the minimum wing width
    // For spreads, use the only available width
    actualWingWidth = Math.min(
      putWidth > 0 ? putWidth : Infinity,
      callWidth > 0 ? callWidth : Infinity
    );
    if (actualWingWidth === Infinity) actualWingWidth = 0;

    if (actualWingWidth < minWingWidthRequired) {
      wingWidthPass = false;
      wingWidthReason = `Wing width ${actualWingWidth} pts below minimum ${minWingWidthRequired} pts`;
    }
  } else {
    wingWidthPass = false;
    wingWidthReason = 'No legs available to calculate wing width';
  }

  const wingWidthGate: Gate = {
    name: 'Minimum Wing Width',
    expected: wingWidthEnabled
      ? `width ≥ ${minWingWidthRequired} pts`
      : 'disabled',
    actual: {
      enabled: wingWidthEnabled,
      minWingWidthPoints: minWingWidthRequired ?? null,
      putWidth,
      callWidth,
      actualWingWidth,
    },
    pass: wingWidthPass,
    reason: wingWidthReason,
  };
  gates.push(wingWidthGate);

  if (!wingWidthPass && !hardStop && wingWidthEnabled) {
    hardStop = true;
    hardStopReason = 'min_wing_width';
  }

  // GATE 8: IV Rank Filter (optional)
  const ivEnabled = strategy.entryConditions.minIvRank !== undefined || strategy.entryConditions.maxIvRank !== undefined;
  let ivPass = true;
  let ivReason: string | undefined;
  
  if (!ivEnabled) {
    ivPass = true;
    ivReason = 'disabled';
  } else if (hardStop) {
    ivPass = false;
    ivReason = `skipped_due_to_${hardStopReason}`;
  } else {
    // IV rank requires historical data - not available from Tradier options endpoint
    ivPass = false;
    ivReason = 'data_unavailable';
  }
  
  const ivGate: Gate = {
    name: 'IV Rank Filter',
    expected: ivEnabled
      ? `${strategy.entryConditions.minIvRank ?? 0}% - ${strategy.entryConditions.maxIvRank ?? 100}%`
      : 'disabled',
    actual: {
      enabled: ivEnabled,
      minIvRank: strategy.entryConditions.minIvRank ?? null,
      maxIvRank: strategy.entryConditions.maxIvRank ?? null,
      iv_data: ivEnabled ? 'unavailable' : null,
    },
    pass: ivPass,
    reason: ivReason,
  };
  gates.push(ivGate);
  
  // GATE 9: Risk Sizing
  let sizingPass = true;
  let sizingReason: string | undefined;
  let computedContracts = strategy.sizing?.fixedContracts ?? strategy.positionSize ?? 1;
  const minContractsOnRisk = strategy.sizing?.minContractsOnRisk ?? 1;

  if (strategy.sizing?.mode === 'risk' && strategy.sizing.riskPerTrade) {
    const maxLoss = proposedOrder?.estimated_max_loss || 0;
    if (hardStop) {
      sizingPass = false;
      sizingReason = `skipped_due_to_${hardStopReason}`;
      computedContracts = 0;
    } else if (maxLoss <= 0) {
      sizingPass = false;
      sizingReason = 'Cannot compute risk sizing - max loss unknown';
      computedContracts = 0;
    } else {
      computedContracts = Math.floor(strategy.sizing.riskPerTrade / maxLoss);
      computedContracts = Math.min(computedContracts, strategy.sizing.maxContracts || 10);
      computedContracts = Math.max(computedContracts, minContractsOnRisk);

      // Check if exceeds maxTotalRiskDollars (portfolio risk cap)
      if (strategy.sizing.maxTotalRiskDollars) {
        const totalRisk = computedContracts * maxLoss;
        if (totalRisk > strategy.sizing.maxTotalRiskDollars) {
          const cappedContracts = Math.floor(strategy.sizing.maxTotalRiskDollars / maxLoss);
          computedContracts = Math.max(cappedContracts, minContractsOnRisk);
        }
      }

      if (computedContracts < minContractsOnRisk) {
        sizingPass = false;
        sizingReason = `Risk sizing resulted in ${computedContracts} contracts (min: ${minContractsOnRisk})`;
      }
    }
  } else if (hardStop) {
    sizingPass = false;
    sizingReason = `skipped_due_to_${hardStopReason}`;
  }

  const sizingGate: Gate = {
    name: 'Risk Sizing',
    expected: strategy.sizing?.mode === 'risk'
      ? `risk/trade = $${strategy.sizing.riskPerTrade}, max = ${strategy.sizing.maxContracts || 10}, min = ${minContractsOnRisk}`
      : `fixed = ${strategy.sizing?.fixedContracts ?? strategy.positionSize ?? 1}`,
    actual: {
      mode: strategy.sizing?.mode || 'fixed',
      computed_contracts: computedContracts,
      riskPerTrade: strategy.sizing?.riskPerTrade || null,
      maxContracts: strategy.sizing?.maxContracts || null,
      minContractsOnRisk,
      maxTotalRiskDollars: strategy.sizing?.maxTotalRiskDollars || null,
      fixedContracts: strategy.sizing?.fixedContracts ?? strategy.positionSize ?? 1,
      estimated_max_loss: proposedOrder?.estimated_max_loss || null,
    },
    pass: sizingPass,
    reason: sizingReason,
  };
  gates.push(sizingGate);
  
  // Update proposed order quantities if sizing passed
  if (proposedOrder && sizingPass && computedContracts > 0) {
    proposedOrder.sizing_result = {
      mode: strategy.sizing?.mode || 'fixed',
      computed_contracts: computedContracts,
      risk_per_trade: strategy.sizing?.riskPerTrade,
    };
    proposedOrder.legs.forEach((leg: any) => {
      leg.quantity = computedContracts;
    });
  }
  
  // GATE 10: MA Filter (optional)
  const maEnabled = !!strategy.entryConditions.maFilter?.enabled && (strategy.entryConditions.maFilter.rules?.length ?? 0) > 0;
  let maPass = true;
  let maReason: string | undefined;
  
  if (!maEnabled) {
    maPass = true;
    maReason = 'disabled';
  } else if (hardStop) {
    maPass = false;
    maReason = `skipped_due_to_${hardStopReason}`;
  } else {
    // MA calculation requires historical data - not available from Tradier
    maPass = false;
    maReason = 'data_unavailable';
  }
  
  const maGate: Gate = {
    name: 'MA Filter',
    expected: maEnabled 
      ? strategy.entryConditions.maFilter!.rules?.map((r: any) => `${r.left} ${r.op} ${r.right}`).join(' AND ') || 'enabled'
      : 'disabled',
    actual: {
      enabled: maEnabled,
      rules: strategy.entryConditions.maFilter?.rules || [],
      sma_data: maEnabled ? 'unavailable' : null,
      underlying_price: underlyingPrice,
    },
    pass: maPass,
    reason: maReason,
  };
  gates.push(maGate);
  
  // Record chain slice in inputs if available
  if (proposedOrder?.legs) {
    inputs.market.chain_slice = proposedOrder.legs.map((leg: any) => ({
      symbol: leg.option_symbol,
      strike: leg.strike,
      delta: leg.delta,
      role: leg.role,
      side: leg.side,
    }));
  }
  
  // Determine final decision
  const criticalGates = gates.filter(g => 
    !g.pass && 
    !g.name.includes('IV') && 
    !g.name.includes('MA') &&
    !g.reason?.startsWith('skipped_due_to')
  );
  
  if (hardStop || criticalGates.length > 0) {
    const firstFail = gates.find(g => !g.pass && !g.reason?.startsWith('skipped_due_to'));
    return { 
      decision: 'SKIP', 
      reason: firstFail?.reason || `Hard stop: ${hardStopReason}`, 
      gates, 
      inputs,
      proposedOrder: proposedOrder || undefined 
    };
  }
  
  if (!proposedOrder || proposedOrder.legs.length === 0) {
    return { decision: 'SKIP', reason: 'Could not construct valid order', gates, inputs };
  }
  
  return { 
    decision: 'OPEN', 
    reason: 'All gates passed - eligible for entry', 
    gates, 
    inputs,
    proposedOrder 
  };
}

// === IRON CONDOR VALIDATION TYPES ===
interface CondorValidation {
  valid: boolean;
  reasons: string[];
  structureValid: boolean; // LP < SP and SC < LC
  symbolsUnique: boolean;  // all 4 symbols distinct
}

interface CondorLegs {
  shortPut: OptionContract;
  longPut: OptionContract;
  shortCall: OptionContract;
  longCall: OptionContract;
}

/**
 * Validate iron condor structure:
 * - longPut.strike < shortPut.strike
 * - shortCall.strike < longCall.strike  
 * - All 4 option symbols unique
 */
function validateCondorStructure(legs: CondorLegs): CondorValidation {
  const reasons: string[] = [];
  
  // Check put side: long put must be LOWER than short put
  const putValid = legs.longPut.strike < legs.shortPut.strike;
  if (!putValid) {
    reasons.push(`put_ordering_invalid: longPut=${legs.longPut.strike} >= shortPut=${legs.shortPut.strike}`);
  }
  
  // Check call side: short call must be LOWER than long call
  const callValid = legs.shortCall.strike < legs.longCall.strike;
  if (!callValid) {
    reasons.push(`call_ordering_invalid: shortCall=${legs.shortCall.strike} >= longCall=${legs.longCall.strike}`);
  }
  
  // Check all symbols unique
  const symbols = [legs.shortPut.symbol, legs.longPut.symbol, legs.shortCall.symbol, legs.longCall.symbol];
  const uniqueSymbols = new Set(symbols);
  const symbolsUnique = uniqueSymbols.size === 4;
  if (!symbolsUnique) {
    const duplicates = symbols.filter((s, i) => symbols.indexOf(s) !== i);
    reasons.push(`duplicate_symbols: ${duplicates.join(', ')}`);
  }
  
  return {
    valid: putValid && callValid && symbolsUnique,
    reasons,
    structureValid: putValid && callValid,
    symbolsUnique,
  };
}

/**
 * Attempt to repair invalid condor by widening long wings outward.
 * - If longCall <= shortCall, move longCall UP by strikeStep increments
 * - If longPut >= shortPut, move longPut DOWN by strikeStep increments
 * Max attempts: 8 steps per wing
 */
function repairCondorLegs(
  legs: CondorLegs,
  strikeStep: number,
  findByStrike: (optionType: 'put' | 'call', strike: number) => OptionContract | undefined,
  symbolConflicts: (symbol: string) => boolean,
  maxSteps: number = 8
): { repaired: boolean; legs: CondorLegs; repairLog: string[] } {
  const repairLog: string[] = [];
  let repairedLegs = { ...legs };
  let needsRepair = false;
  
  // Check if call side needs repair
  if (repairedLegs.longCall.strike <= repairedLegs.shortCall.strike || 
      repairedLegs.longCall.symbol === repairedLegs.shortCall.symbol) {
    needsRepair = true;
    repairLog.push(`[REPAIR] Call side invalid: longCall=${repairedLegs.longCall.strike} vs shortCall=${repairedLegs.shortCall.strike}`);
    
    let repaired = false;
    for (let step = 1; step <= maxSteps; step++) {
      const candidateStrike = repairedLegs.shortCall.strike + (step * strikeStep);
      const candidate = findByStrike('call', candidateStrike);
      
      repairLog.push(`[REPAIR] Call step ${step}: trying strike ${candidateStrike}, found=${!!candidate}`);
      
      if (candidate && 
          candidateStrike > repairedLegs.shortCall.strike && 
          candidate.symbol !== repairedLegs.shortCall.symbol &&
          !symbolConflicts(candidate.symbol)) {
        repairedLegs.longCall = candidate;
        repairLog.push(`[REPAIR] Call side FIXED: longCall moved to strike ${candidateStrike}`);
        repaired = true;
        break;
      }
    }
    
    if (!repaired) {
      repairLog.push(`[REPAIR] Call side FAILED after ${maxSteps} steps`);
      return { repaired: false, legs: repairedLegs, repairLog };
    }
  }
  
  // Check if put side needs repair
  if (repairedLegs.longPut.strike >= repairedLegs.shortPut.strike || 
      repairedLegs.longPut.symbol === repairedLegs.shortPut.symbol) {
    needsRepair = true;
    repairLog.push(`[REPAIR] Put side invalid: longPut=${repairedLegs.longPut.strike} vs shortPut=${repairedLegs.shortPut.strike}`);
    
    let repaired = false;
    for (let step = 1; step <= maxSteps; step++) {
      const candidateStrike = repairedLegs.shortPut.strike - (step * strikeStep);
      const candidate = findByStrike('put', candidateStrike);
      
      repairLog.push(`[REPAIR] Put step ${step}: trying strike ${candidateStrike}, found=${!!candidate}`);
      
      if (candidate && 
          candidateStrike < repairedLegs.shortPut.strike && 
          candidate.symbol !== repairedLegs.shortPut.symbol &&
          !symbolConflicts(candidate.symbol)) {
        repairedLegs.longPut = candidate;
        repairLog.push(`[REPAIR] Put side FIXED: longPut moved to strike ${candidateStrike}`);
        repaired = true;
        break;
      }
    }
    
    if (!repaired) {
      repairLog.push(`[REPAIR] Put side FAILED after ${maxSteps} steps`);
      return { repaired: false, legs: repairedLegs, repairLog };
    }
  }
  
  // Final validation after repair
  const finalValidation = validateCondorStructure(repairedLegs);
  if (!finalValidation.valid) {
    repairLog.push(`[REPAIR] Final validation FAILED: ${finalValidation.reasons.join(', ')}`);
    return { repaired: false, legs: repairedLegs, repairLog };
  }
  
  if (needsRepair) {
    repairLog.push(`[REPAIR] SUCCESS: Final structure valid`);
  }
  
  return { repaired: !needsRepair || finalValidation.valid, legs: repairedLegs, repairLog };
}

function buildProposedOrder(
  strategy: Strategy, 
  options: OptionContract[], 
  shortDeltaTarget: number,
  longDeltaTarget?: number,
  jitterConfig?: {
    existingCondors: number;
    maxCondorsPerExpiry: number;
    brokerPositionSymbols: string[];
  }
): EvaluationResult['proposedOrder'] | null {
  const effectiveLongDelta = longDeltaTarget ?? shortDeltaTarget * 0.5;
  const positionSize = strategy.sizing?.fixedContracts ?? strategy.positionSize ?? 1;
  
  // Find options by delta
  const puts = options.filter(o => o.option_type === 'put' && o.greeks && o.bid > 0)
    .sort((a, b) => Math.abs(b.greeks!.delta) - Math.abs(a.greeks!.delta));
  const calls = options.filter(o => o.option_type === 'call' && o.greeks && o.bid > 0)
    .sort((a, b) => Math.abs(b.greeks!.delta) - Math.abs(a.greeks!.delta));
  
  // Enhanced findByDelta with exclusions (Rule C)
  const findByDelta = (
    opts: OptionContract[], 
    targetDelta: number, 
    above = false,
    excludeSymbols: string[] = [],
    excludeStrikes: number[] = []
  ) => {
    return opts.find(o => {
      // Apply exclusions first
      if (excludeSymbols.includes(o.symbol)) return false;
      if (excludeStrikes.includes(o.strike)) return false;
      
      const d = Math.abs(o.greeks!.delta);
      return above ? d >= targetDelta : d <= targetDelta + 0.05;
    });
  };
  
  // Helper: Find option by exact strike
  const findByStrike = (optionType: 'put' | 'call', strike: number): OptionContract | undefined => {
    return options.find(o => o.option_type === optionType && o.strike === strike && o.bid > 0);
  };
  
  // Helper: Check if symbol conflicts with existing positions
  const symbolConflicts = (symbol: string): boolean => {
    return jitterConfig?.brokerPositionSymbols?.includes(symbol) ?? false;
  };
  
  const legs: Array<{
    role: string;
    option_symbol?: string;
    strike: number;
    delta: number;
    side: string;
    quantity: number;
  }> = [];
  
  let estimatedCredit = 0;
  let estimatedMaxLoss = 0;
  let jitterResult: JitterResult | undefined;
  
  switch (strategy.type) {
    case 'iron_condor':
    case 'iron_fly': {
      // Find base strikes via delta targeting with exclusions (Rule C)
      const baseShortPut = findByDelta(puts, shortDeltaTarget);
      if (!baseShortPut) {
        console.log(`[CONDOR] No short put found at delta ${shortDeltaTarget}`);
        return null;
      }
      
      // When finding long put, exclude short put's strike/symbol
      const baseLongPut = findByDelta(
        puts, 
        effectiveLongDelta, 
        false,
        [baseShortPut.symbol],
        [baseShortPut.strike]
      );
      if (!baseLongPut) {
        console.log(`[CONDOR] No long put found at delta ${effectiveLongDelta} (excluding ${baseShortPut.symbol})`);
        return null;
      }
      
      const baseShortCall = findByDelta(calls, shortDeltaTarget);
      if (!baseShortCall) {
        console.log(`[CONDOR] No short call found at delta ${shortDeltaTarget}`);
        return null;
      }
      
      // When finding long call, exclude short call's strike/symbol
      const baseLongCall = findByDelta(
        calls, 
        effectiveLongDelta, 
        false,
        [baseShortCall.symbol],
        [baseShortCall.strike]
      );
      if (!baseLongCall) {
        console.log(`[CONDOR] No long call found at delta ${effectiveLongDelta} (excluding ${baseShortCall.symbol})`);
        return null;
      }
      
      // Initialize jitter result
      const strikeStep = computeStrikeStep(options);
      const existingCondors = jitterConfig?.existingCondors ?? 0;
      
      // Log selected strikes/deltas (Rule F)
      console.log(`[CONDOR_SELECT] shortPut: strike=${baseShortPut.strike}, delta=${baseShortPut.greeks?.delta}, symbol=${baseShortPut.symbol}`);
      console.log(`[CONDOR_SELECT] longPut: strike=${baseLongPut.strike}, delta=${baseLongPut.greeks?.delta}, symbol=${baseLongPut.symbol}`);
      console.log(`[CONDOR_SELECT] shortCall: strike=${baseShortCall.strike}, delta=${baseShortCall.greeks?.delta}, symbol=${baseShortCall.symbol}`);
      console.log(`[CONDOR_SELECT] longCall: strike=${baseLongCall.strike}, delta=${baseLongCall.greeks?.delta}, symbol=${baseLongCall.symbol}`);
      
      // === RULE A: Validate base structure before proceeding ===
      let baseLegs: CondorLegs = {
        shortPut: baseShortPut,
        longPut: baseLongPut,
        shortCall: baseShortCall,
        longCall: baseLongCall,
      };
      
      let baseValidation = validateCondorStructure(baseLegs);
      
      // Compute baseAllUnique correctly (Rule D)
      const baseSymbols = [baseShortPut.symbol, baseLongPut.symbol, baseShortCall.symbol, baseLongCall.symbol];
      const baseAllUnique = new Set(baseSymbols).size === 4;
      
      console.log(`[CONDOR_VALIDATE] Base validation: valid=${baseValidation.valid}, structureValid=${baseValidation.structureValid}, symbolsUnique=${baseValidation.symbolsUnique}`);
      if (!baseValidation.valid) {
        console.log(`[CONDOR_VALIDATE] Base validation failed: ${baseValidation.reasons.join(', ')}`);
      }
      
      // === RULE B: Attempt repair if base is invalid ===
      if (!baseValidation.valid) {
        console.log(`[CONDOR_REPAIR] Attempting repair for invalid base structure...`);
        const repairResult = repairCondorLegs(baseLegs, strikeStep, findByStrike, symbolConflicts, 8);
        
        for (const log of repairResult.repairLog) {
          console.log(log);
        }
        
        if (repairResult.repaired) {
          baseLegs = repairResult.legs;
          baseValidation = validateCondorStructure(baseLegs);
          console.log(`[CONDOR_REPAIR] Repair successful, using repaired legs`);
        } else {
          console.log(`[CONDOR_REPAIR] Repair FAILED - blocking entry`);
          return null;
        }
      }
      
      jitterResult = {
        applied: false,
        existingCondors,
        strikeStep,
        offset: 0,
        jitterSize: 0,
        originalStrikes: {
          shortPut: baseLegs.shortPut.strike,
          longPut: baseLegs.longPut.strike,
          shortCall: baseLegs.shortCall.strike,
          longCall: baseLegs.longCall.strike,
        },
        shiftedStrikes: {
          shortPut: baseLegs.shortPut.strike,
          longPut: baseLegs.longPut.strike,
          shortCall: baseLegs.shortCall.strike,
          longCall: baseLegs.longCall.strike,
        },
        allUnique: baseAllUnique, // Rule D: correctly computed
        allExistInChain: true,
      };
      
      // Apply strike jitter if there are existing condors
      let shortPut = baseLegs.shortPut;
      let longPut = baseLegs.longPut;
      let shortCall = baseLegs.shortCall;
      let longCall = baseLegs.longCall;
      
      if (existingCondors > 0) {
        // Try jitterSize = 1, then 2
        let jitterSuccess = false;
        for (const jitterSize of [1, 2]) {
          const offset = existingCondors * strikeStep * jitterSize;
          
          // Symmetric jitter: puts move DOWN, calls move UP
          const newShortPutStrike = baseLegs.shortPut.strike - offset;
          const newLongPutStrike = baseLegs.longPut.strike - offset;
          const newShortCallStrike = baseLegs.shortCall.strike + offset;
          const newLongCallStrike = baseLegs.longCall.strike + offset;
          
          // Find options at shifted strikes
          const shiftedShortPut = findByStrike('put', newShortPutStrike);
          const shiftedLongPut = findByStrike('put', newLongPutStrike);
          const shiftedShortCall = findByStrike('call', newShortCallStrike);
          const shiftedLongCall = findByStrike('call', newLongCallStrike);
          
          // Check all shifted strikes exist in chain
          const allExist = !!(shiftedShortPut && shiftedLongPut && shiftedShortCall && shiftedLongCall);
          
          if (!allExist) {
            console.log(`[JITTER] jitterSize=${jitterSize} failed: not all strikes exist in chain`);
            continue;
          }
          
          // === RULE A: Validate jittered structure ===
          const jitteredLegs: CondorLegs = {
            shortPut: shiftedShortPut!,
            longPut: shiftedLongPut!,
            shortCall: shiftedShortCall!,
            longCall: shiftedLongCall!,
          };
          
          let jitteredValidation = validateCondorStructure(jitteredLegs);
          
          // Check for position conflicts
          const jitteredSymbols = [shiftedShortPut!.symbol, shiftedLongPut!.symbol, shiftedShortCall!.symbol, shiftedLongCall!.symbol];
          const hasSymbolConflict = jitteredSymbols.some(s => symbolConflicts(s));
          
          if (hasSymbolConflict) {
            console.log(`[JITTER] jitterSize=${jitterSize} failed: symbol conflict with existing positions`);
            continue;
          }
          
          // === RULE B: Attempt repair on jittered legs if invalid ===
          if (!jitteredValidation.valid) {
            console.log(`[JITTER] jitterSize=${jitterSize} needs repair: ${jitteredValidation.reasons.join(', ')}`);
            const repairResult = repairCondorLegs(jitteredLegs, strikeStep, findByStrike, symbolConflicts, 8);
            
            for (const log of repairResult.repairLog) {
              console.log(log);
            }
            
            if (repairResult.repaired) {
              shortPut = repairResult.legs.shortPut;
              longPut = repairResult.legs.longPut;
              shortCall = repairResult.legs.shortCall;
              longCall = repairResult.legs.longCall;
              jitteredValidation = validateCondorStructure(repairResult.legs);
            } else {
              console.log(`[JITTER] jitterSize=${jitterSize} repair failed, trying next jitter size`);
              continue;
            }
          } else {
            shortPut = shiftedShortPut!;
            longPut = shiftedLongPut!;
            shortCall = shiftedShortCall!;
            longCall = shiftedLongCall!;
          }
          
          const allUnique = new Set([shortPut.symbol, longPut.symbol, shortCall.symbol, longCall.symbol]).size === 4;
          
          jitterResult = {
            applied: true,
            existingCondors,
            strikeStep,
            offset,
            jitterSize,
            originalStrikes: {
              shortPut: baseLegs.shortPut.strike,
              longPut: baseLegs.longPut.strike,
              shortCall: baseLegs.shortCall.strike,
              longCall: baseLegs.longCall.strike,
            },
            shiftedStrikes: {
              shortPut: shortPut.strike,
              longPut: longPut.strike,
              shortCall: shortCall.strike,
              longCall: longCall.strike,
            },
            allUnique,
            allExistInChain: true,
          };
          
          console.log(`[JITTER] Applied jitterSize=${jitterSize}, offset=${offset} for condor #${existingCondors + 1}`);
          jitterSuccess = true;
          break;
        }
        
        if (!jitterSuccess) {
          // Both jitter sizes failed - return null to block entry
          console.log(`[JITTER] All jitter attempts failed for ${strategy.underlying}, blocking entry`);
          return null;
        }
      } else {
        // No existing condors - still check for symbol conflicts with base strikes
        const hasConflict = [shortPut.symbol, longPut.symbol, shortCall.symbol, longCall.symbol].some(s => symbolConflicts(s));
        if (hasConflict) {
          console.log(`[JITTER] Base strikes conflict with existing positions, attempting jitter`);
          // Recursively try with existingCondors = 1 to force jitter
          return buildProposedOrder(strategy, options, shortDeltaTarget, longDeltaTarget, {
            ...jitterConfig!,
            existingCondors: 1,
          });
        }
      }
      
      // === FINAL VALIDATION before building legs ===
      const finalLegs: CondorLegs = { shortPut, longPut, shortCall, longCall };
      const finalValidation = validateCondorStructure(finalLegs);
      
      console.log(`[CONDOR_VALIDATE] Final validation: valid=${finalValidation.valid}, symbols=[${shortPut.symbol}, ${longPut.symbol}, ${shortCall.symbol}, ${longCall.symbol}]`);
      
      if (!finalValidation.valid) {
        console.error(`[CONDOR_VALIDATE] BLOCKED: Final validation failed after all attempts: ${finalValidation.reasons.join(', ')}`);
        return null;
      }
      
      legs.push(
        { role: 'long_put', option_symbol: longPut.symbol, strike: longPut.strike, delta: longPut.greeks!.delta, side: 'buy_to_open', quantity: positionSize },
        { role: 'short_put', option_symbol: shortPut.symbol, strike: shortPut.strike, delta: shortPut.greeks!.delta, side: 'sell_to_open', quantity: positionSize },
        { role: 'short_call', option_symbol: shortCall.symbol, strike: shortCall.strike, delta: shortCall.greeks!.delta, side: 'sell_to_open', quantity: positionSize },
        { role: 'long_call', option_symbol: longCall.symbol, strike: longCall.strike, delta: longCall.greeks!.delta, side: 'buy_to_open', quantity: positionSize },
      );
      
      estimatedCredit = (shortPut.bid + shortCall.bid) - (longPut.ask + longCall.ask);
      const putWidth = shortPut.strike - longPut.strike;
      const callWidth = longCall.strike - shortCall.strike;
      estimatedMaxLoss = (Math.max(putWidth, callWidth) - estimatedCredit) * 100 * positionSize;
      break;
    }
    
    case 'credit_put_spread': {
      const shortPut = findByDelta(puts, shortDeltaTarget);
      if (!shortPut) return null;
      
      // Exclude short put when finding long put
      const longPut = findByDelta(puts, effectiveLongDelta, false, [shortPut.symbol], [shortPut.strike]);
      
      if (!longPut) return null;
      
      // Validate structure: longPut < shortPut
      if (longPut.strike >= shortPut.strike) {
        console.log(`[PUT_SPREAD] Invalid structure: longPut=${longPut.strike} >= shortPut=${shortPut.strike}`);
        return null;
      }
      
      legs.push(
        { role: 'long_put', option_symbol: longPut.symbol, strike: longPut.strike, delta: longPut.greeks!.delta, side: 'buy_to_open', quantity: positionSize },
        { role: 'short_put', option_symbol: shortPut.symbol, strike: shortPut.strike, delta: shortPut.greeks!.delta, side: 'sell_to_open', quantity: positionSize },
      );
      
      estimatedCredit = shortPut.bid - longPut.ask;
      estimatedMaxLoss = ((shortPut.strike - longPut.strike) - estimatedCredit) * 100 * positionSize;
      break;
    }
    
    case 'credit_call_spread': {
      const shortCall = findByDelta(calls, shortDeltaTarget);
      if (!shortCall) return null;
      
      // Exclude short call when finding long call
      const longCall = findByDelta(calls, effectiveLongDelta, false, [shortCall.symbol], [shortCall.strike]);
      
      if (!longCall) return null;
      
      // Validate structure: shortCall < longCall
      if (shortCall.strike >= longCall.strike) {
        console.log(`[CALL_SPREAD] Invalid structure: shortCall=${shortCall.strike} >= longCall=${longCall.strike}`);
        return null;
      }
      
      legs.push(
        { role: 'short_call', option_symbol: shortCall.symbol, strike: shortCall.strike, delta: shortCall.greeks!.delta, side: 'sell_to_open', quantity: positionSize },
        { role: 'long_call', option_symbol: longCall.symbol, strike: longCall.strike, delta: longCall.greeks!.delta, side: 'buy_to_open', quantity: positionSize },
      );
      
      estimatedCredit = shortCall.bid - longCall.ask;
      estimatedMaxLoss = ((longCall.strike - shortCall.strike) - estimatedCredit) * 100 * positionSize;
      break;
    }
    
    case 'strangle':
    case 'straddle': {
      const shortPut = findByDelta(puts, shortDeltaTarget);
      const shortCall = findByDelta(calls, shortDeltaTarget);
      
      if (!shortPut || !shortCall) return null;
      
      legs.push(
        { role: 'short_put', option_symbol: shortPut.symbol, strike: shortPut.strike, delta: shortPut.greeks!.delta, side: 'sell_to_open', quantity: positionSize },
        { role: 'short_call', option_symbol: shortCall.symbol, strike: shortCall.strike, delta: shortCall.greeks!.delta, side: 'sell_to_open', quantity: positionSize },
      );
      
      estimatedCredit = shortPut.bid + shortCall.bid;
      estimatedMaxLoss = Infinity; // Undefined risk
      break;
    }
    
    default:
      return null;
  }
  
  // === FINAL POST-CONSTRUCTION VALIDATION (Rule E backup) ===
  const allSymbols = legs.map(l => l.option_symbol).filter(Boolean);
  if (new Set(allSymbols).size !== allSymbols.length) {
    console.error(`[ORDER VALIDATION] BLOCKED: Duplicate symbols in proposed order: ${allSymbols.join(', ')}`);
    return null;
  }
  
  return {
    legs,
    estimated_credit: estimatedCredit,
    estimated_max_loss: estimatedMaxLoss === Infinity ? undefined : estimatedMaxLoss,
    entry_rationale: `${strategy.type} on ${strategy.underlying} with ${legs.length} legs`,
    jitter: jitterResult,
  };
}

// Save evaluation to database
async function saveEvaluation(
  supabase: any,
  strategyId: string,
  underlying: string,
  eventType: string,
  result: EvaluationResult,
  configJson: Record<string, unknown>,
  tradeGroupId?: string
) {
  try {
    const { data, error } = await supabase
      .from('strategy_evaluations')
      .insert({
        strategy_id: strategyId,
        underlying,
        event_type: eventType,
        decision: result.decision,
        reason: result.reason,
        config_json: configJson,
        inputs_json: result.inputs,
        gates_json: result.gates,
        proposed_order_json: result.proposedOrder || null,
        trade_group_id: tradeGroupId || null,
      })
      .select()
      .single();
    
    if (error) {
      console.error('Error saving evaluation:', error);
      return null;
    }
    return data;
  } catch (err) {
    console.error('Exception saving evaluation:', err);
    return null;
  }
}

/**
 * Reconcile stale close orders that have close_status='submitted' but no fill data.
 * This handles cases where the browser tab was closed after submitting a close order
 * before the fill could be recorded.
 *
 * For each stale order:
 * - If filled: update close_status, exit_price, exit_debit, compute P&L
 * - If still pending after timeout: mark as 'timeout_unknown'
 */
async function reconcileStaleCloseOrders(supabaseClient: any): Promise<{ reconciled: number; timedOut: number; errors: string[] }> {
  const STALE_THRESHOLD_MS = 30 * 1000; // 30 seconds
  const TIMEOUT_THRESHOLD_MS = 120 * 1000; // 2 minutes

  const result = { reconciled: 0, timedOut: 0, errors: [] as string[] };

  try {
    // Get trades with close_status='submitted' and a close_order_id
    const { data: staleTrades, error } = await supabaseClient
      .from('trades')
      .select('*')
      .eq('close_status', 'submitted')
      .not('close_order_id', 'is', null);

    if (error) {
      console.error('[RECONCILE] Error fetching stale trades:', error);
      result.errors.push(`DB error: ${error.message}`);
      return result;
    }

    if (!staleTrades?.length) {
      return result;
    }

    console.log(`[RECONCILE] Found ${staleTrades.length} trades with close_status='submitted'`);

    // Group trades by close_order_id (multi-leg orders share the same order ID)
    const orderGroups = new Map<string, any[]>();
    for (const trade of staleTrades) {
      const orderId = trade.close_order_id;
      if (!orderId) continue;

      const submittedAt = trade.close_submitted_at
        ? new Date(trade.close_submitted_at).getTime()
        : Date.now() - TIMEOUT_THRESHOLD_MS; // Treat missing timestamp as very old
      const elapsed = Date.now() - submittedAt;

      if (elapsed < STALE_THRESHOLD_MS) {
        continue; // Not stale yet
      }

      const existing = orderGroups.get(orderId) || [];
      existing.push({ ...trade, elapsed });
      orderGroups.set(orderId, existing);
    }

    if (orderGroups.size === 0) {
      return result;
    }

    console.log(`[RECONCILE] Processing ${orderGroups.size} stale order group(s)`);

    // Query Tradier for each stale order
    for (const [orderId, trades] of orderGroups) {
      const elapsed = trades[0].elapsed;
      const tradeGroupId = trades[0].trade_group_id;

      try {
        // Call tradier-api to get order status
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

        const resp = await fetch(`${supabaseUrl}/functions/v1/tradier-api`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action: 'order_status', orderId }),
        });

        if (!resp.ok) {
          console.error(`[RECONCILE] Failed to fetch order status for ${orderId}: ${resp.status}`);
          result.errors.push(`Order ${orderId}: HTTP ${resp.status}`);
          continue;
        }

        const orderStatus = await resp.json();
        console.log(`[RECONCILE] Order ${orderId} status:`, orderStatus.closeStatus, `elapsed: ${Math.round(elapsed/1000)}s`);

        if (orderStatus.closeStatus === 'filled') {
          // Order is filled - update all legs with fill data
          const legFills = orderStatus.legFills || {};

          for (const trade of trades) {
            // Get per-leg fill price if available, otherwise use order-level average
            const legFill = legFills[trade.symbol];
            const exitPrice = legFill?.avgFillPrice ?? orderStatus.avgFillPrice ?? null;

            // Calculate exit_debit: for credit spreads, this is cost to close
            // exit_debit = exit_price * quantity * 100 (per contract multiplier)
            const quantity = Math.abs(trade.quantity || 1);
            const exitDebit = exitPrice != null ? exitPrice * quantity * 100 : null;

            // Calculate P&L: entry_credit - exit_debit
            // For credit strategies: positive credit at entry, positive debit at exit
            // P&L = credit received - debit paid to close
            const entryCredit = trade.entry_credit ?? 0;
            const pnl = exitDebit != null ? entryCredit - exitDebit : null;

            // Update the trade record
            const { error: updateError } = await supabaseClient
              .from('trades')
              .update({
                close_status: 'filled',
                exit_price: exitPrice,
                exit_debit: exitDebit,
                pnl: pnl,
                realized_pnl: pnl,
                exit_time: orderStatus.rawOrder?.transaction_date || new Date().toISOString(),
              })
              .eq('id', trade.id);

            if (updateError) {
              console.error(`[RECONCILE] Error updating trade ${trade.id}:`, updateError);
              result.errors.push(`Trade ${trade.id}: ${updateError.message}`);
            } else {
              console.log(`[RECONCILE] Updated trade ${trade.id} (${trade.symbol}): exit_price=${exitPrice}, pnl=${pnl?.toFixed(2)}`);
              result.reconciled++;
            }
          }
        } else if (orderStatus.closeStatus === 'rejected' || orderStatus.closeStatus === 'canceled' || orderStatus.closeStatus === 'expired') {
          // Order failed - update status accordingly
          for (const trade of trades) {
            const { error: updateError } = await supabaseClient
              .from('trades')
              .update({
                close_status: orderStatus.closeStatus,
                exit_reason: orderStatus.rejectReason || `Order ${orderStatus.closeStatus}`,
              })
              .eq('id', trade.id);

            if (updateError) {
              console.error(`[RECONCILE] Error updating failed trade ${trade.id}:`, updateError);
              result.errors.push(`Trade ${trade.id}: ${updateError.message}`);
            } else {
              console.log(`[RECONCILE] Marked trade ${trade.id} as ${orderStatus.closeStatus}: ${orderStatus.rejectReason || ''}`);
            }
          }
        } else if (elapsed > TIMEOUT_THRESHOLD_MS) {
          // Still pending after timeout - mark as unknown
          console.warn(`[RECONCILE] Order ${orderId} timed out after ${Math.round(elapsed/1000)}s, marking as timeout_unknown`);

          const { error: updateError } = await supabaseClient
            .from('trades')
            .update({ close_status: 'timeout_unknown' })
            .eq('close_order_id', orderId);

          if (updateError) {
            console.error(`[RECONCILE] Error marking timeout for order ${orderId}:`, updateError);
            result.errors.push(`Order ${orderId} timeout: ${updateError.message}`);
          } else {
            result.timedOut += trades.length;
          }
        }
        // else: still pending but not timed out yet - leave as is
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[RECONCILE] Exception processing order ${orderId}:`, errMsg);
        result.errors.push(`Order ${orderId}: ${errMsg}`);
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[RECONCILE] Exception:', errMsg);
    result.errors.push(errMsg);
  }

  if (result.reconciled > 0 || result.timedOut > 0) {
    console.log(`[RECONCILE] Complete: ${result.reconciled} reconciled, ${result.timedOut} timed out`);
  }

  return result;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const apiToken = Deno.env.get('TRADIER_API_TOKEN');
    const accountId = Deno.env.get('TRADIER_ACCOUNT_ID');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!apiToken || !accountId) {
      console.error('Missing Tradier credentials');
      return new Response(
        JSON.stringify({ error: 'Tradier API not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(supabaseUrl!, supabaseKey!);
    const body = await req.json();
    const { action, strategies, positions, strategyId, overrideMarketStatus, overrideTimeET } = body;

    const baseUrl = 'https://sandbox.tradier.com/v1';
    const headers = {
      'Authorization': `Bearer ${apiToken}`,
      'Accept': 'application/json',
    };

    // Check if market is open
    const clockResponse = await fetch(`${baseUrl}/markets/clock`, { headers });
    const clockData = await clockResponse.json();
    const marketState = clockData?.clock?.state || 'closed';
    
    console.log('Market state:', marketState);

    // Handle run_evaluation for a single strategy
    if (action === 'run_evaluation' && strategyId) {
      // Fetch strategy from DB
      const { data: strategyData, error: strategyError } = await supabase
        .from('strategies')
        .select('*')
        .eq('id', strategyId)
        .single();
      
      if (strategyError || !strategyData) {
        return new Response(
          JSON.stringify({ error: 'Strategy not found' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      // Convert DB format to expected format
      const strategy: Strategy = {
        id: strategyData.id,
        name: strategyData.name,
        type: strategyData.type,
        underlying: strategyData.underlying,
        enabled: strategyData.enabled,
        maxPositions: strategyData.max_positions,
        positionSize: strategyData.position_size,
        entryConditions: strategyData.entry_conditions,
        exitConditions: strategyData.exit_conditions,
        sizing: strategyData.entry_conditions?.sizing,
        trackedLegs: strategyData.entry_conditions?.trackedLegs,
      };
      
      // Fetch current positions (if any)
      const currentPositions: any[] = positions || [];
      
      // Run evaluation with trace (support override for testing)
      const evalOptions: { overrideMarketStatus?: string; overrideTimeET?: string } = {};
      if (overrideMarketStatus) evalOptions.overrideMarketStatus = overrideMarketStatus;
      if (overrideTimeET) evalOptions.overrideTimeET = overrideTimeET;
      
      const result = await evaluateStrategyWithTrace(
        strategy,
        marketState,
        currentPositions,
        apiToken,
        baseUrl,
        supabase,
        Object.keys(evalOptions).length > 0 ? evalOptions : undefined
      );
      
      // Save evaluation to DB
      const savedEval = await saveEvaluation(
        supabase,
        strategy.id,
        strategy.underlying,
        'evaluation',
        result,
        {
          name: strategy.name,
          type: strategy.type,
          entryConditions: strategy.entryConditions,
          exitConditions: strategy.exitConditions,
          sizing: strategy.sizing,
          trackedLegs: strategy.trackedLegs,
        }
      );
      
      return new Response(
        JSON.stringify({ 
          evaluation: savedEval,
          result,
          marketState 
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'evaluate') {
      // Evaluate strategies and return signals
      const signals: any[] = [];
      const evaluations: any[] = [];
      
      for (const strategy of strategies as Strategy[]) {
        if (!strategy.enabled) continue;

        // SAFETY: Block undefined-risk strategies (straddle/strangle) from automated trading
        if (strategy.type === 'straddle' || strategy.type === 'strangle') {
          console.warn(`[SAFETY] BLOCKED: Strategy "${strategy.name}" is type "${strategy.type}" with UNLIMITED LOSS potential. Not allowed for automated trading.`);
          continue;
        }

        // Run full evaluation with trace
        const result = await evaluateStrategyWithTrace(
          strategy,
          marketState,
          positions || [],
          apiToken,
          baseUrl,
          supabase
        );
        
        // Save evaluation (will be de-duped if no change)
        const savedEval = await saveEvaluation(
          supabase,
          strategy.id,
          strategy.underlying,
          'evaluation',
          result,
          {
            name: strategy.name,
            type: strategy.type,
            entryConditions: strategy.entryConditions,
            exitConditions: strategy.exitConditions,
            sizing: strategy.sizing,
          }
        );
        
        if (savedEval) {
          evaluations.push(savedEval);
        }
        
        // If eligible for entry, create signal
        if (result.decision === 'OPEN' && result.proposedOrder) {
          signals.push({
            strategyName: strategy.name,
            strategyId: strategy.id,
            type: strategy.type,
            underlying: strategy.underlying,
            expiration: result.inputs.market.expiration_selected,
            credit: result.proposedOrder.estimated_credit,
            legs: result.proposedOrder.legs.map(leg => ({
              symbol: leg.option_symbol,
              side: leg.side,
              quantity: leg.quantity,
            })),
            proposedOrder: result.proposedOrder,
          });
        }
      }

      return new Response(
        JSON.stringify({ signals, evaluations, marketState }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'execute') {
      // Execute a trade signal with VERIFIED ENTRY flow
      // 1. Place order
      // 2. Wait up to 60 seconds for fill confirmation
      // 3. If not filled, BAIL OUT (cancel + market close orphan legs)
      // 4. Only persist mapping if fully verified
      const { signal, tradeGroupId } = body;
      
      if (!signal || !signal.legs) {
        return new Response(
          JSON.stringify({ error: 'Invalid signal' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Generate trade_group_id if not provided
      const effectiveTradeGroupId = tradeGroupId || crypto.randomUUID();
      const gates: Gate[] = [];

      // PREFLIGHT 0: MAX DAILY LOSS CHECK
      // Fetch today's realized P&L from database to check if we've hit the daily loss limit
      const maxDailyLossLimit = signal.maxDailyLoss ?? DEFAULT_MAX_DAILY_LOSS_DOLLARS;
      let todayRealizedLoss = 0;

      try {
        const today = getETDateString();
        const { data: todayTrades } = await supabase
          .from('trades')
          .select('realized_pnl')
          .gte('exit_time', `${today}T00:00:00`)
          .lt('exit_time', `${today}T23:59:59`)
          .eq('close_status', 'filled');

        if (todayTrades) {
          todayRealizedLoss = todayTrades
            .filter((t: any) => t.realized_pnl < 0)
            .reduce((sum: number, t: any) => sum + Math.abs(t.realized_pnl || 0), 0);
        }
      } catch (err) {
        console.error('[PREFLIGHT] Error fetching daily P&L:', err);
      }

      const dailyLossCheck = checkMaxDailyLoss(accountId, todayRealizedLoss, maxDailyLossLimit);

      gates.push({
        name: 'Max Daily Loss',
        expected: `realized loss < $${maxDailyLossLimit}`,
        actual: {
          halted: dailyLossCheck.halted,
          currentLoss: dailyLossCheck.currentLoss,
          maxDailyLoss: dailyLossCheck.maxDailyLoss,
        },
        pass: !dailyLossCheck.halted,
        reason: dailyLossCheck.reason,
      });

      if (dailyLossCheck.halted) {
        console.log(`[PREFLIGHT] Entry blocked by max daily loss: ${dailyLossCheck.reason}`);

        if (signal.strategyId) {
          await saveEvaluation(
            supabase,
            signal.strategyId,
            signal.underlying,
            'entry_attempt',
            {
              decision: 'FAIL',
              reason: dailyLossCheck.reason || 'Max daily loss limit reached',
              gates,
              inputs: { market: {}, account: {} },
              proposedOrder: signal.proposedOrder,
            },
            {
              signal,
              blocked: 'max_daily_loss',
              dailyLossCheck,
            },
            effectiveTradeGroupId
          );
        }

        return new Response(
          JSON.stringify({
            success: false,
            error: dailyLossCheck.reason || 'Max daily loss limit reached',
            blocked: 'max_daily_loss',
            dailyLossCheck,
            tradeGroupId: effectiveTradeGroupId,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // PREFLIGHT 1: Entry cooldown check
      const cooldownKey = generateEntryCooldownKey(
        signal.strategyId || 'unknown',
        signal.underlying,
        signal.expiration || '',
        signal.proposedOrder?.legs || signal.legs
      );
      
      const isCoolingDown = isEntryCoolingDown(cooldownKey);
      gates.push({
        name: 'Entry Cooldown',
        expected: 'no recent rejected entry',
        actual: { coolingDown: isCoolingDown, key: cooldownKey },
        pass: !isCoolingDown,
        reason: isCoolingDown ? 'Entry blocked - recent rejection, wait 2 minutes' : undefined,
      });
      
      if (isCoolingDown) {
        console.log(`[PREFLIGHT] Entry blocked by cooldown: ${cooldownKey}`);
        if (signal.strategyId) {
          await saveEvaluation(
            supabase,
            signal.strategyId,
            signal.underlying,
            'entry_attempt',
            {
              decision: 'FAIL',
              reason: 'Entry blocked by cooldown (recent rejection)',
              gates,
              inputs: { market: {}, account: {} },
              proposedOrder: signal.proposedOrder,
            },
            { signal, blocked: 'cooldown' },
            effectiveTradeGroupId
          );
        }
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: 'Entry blocked by cooldown (recent rejection, wait 2 minutes)',
            blocked: 'cooldown',
            tradeGroupId: effectiveTradeGroupId,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      // PREFLIGHT 2: In-flight order check (prevents duplicate entries before broker updates)
      const inFlightKey = generateInFlightKey(
        signal.underlying,
        signal.expiration || '',
        signal.proposedOrder?.legs || signal.legs
      );
      
      const orderInFlight = isOrderInFlight(inFlightKey);
      gates.push({
        name: 'In-Flight Order',
        expected: 'no duplicate in-flight order',
        actual: { inFlight: orderInFlight, key: inFlightKey },
        pass: !orderInFlight,
        reason: orderInFlight ? 'Entry blocked - identical order already in-flight (wait 90 seconds)' : undefined,
      });
      
      if (orderInFlight) {
        console.log(`[PREFLIGHT] Entry blocked by in-flight order: ${inFlightKey}`);
        if (signal.strategyId) {
          await saveEvaluation(
            supabase,
            signal.strategyId,
            signal.underlying,
            'entry_attempt',
            {
              decision: 'FAIL',
              reason: 'Entry blocked - identical order already in-flight',
              gates,
              inputs: { market: {}, account: {} },
              proposedOrder: signal.proposedOrder,
            },
            { signal, blocked: 'in_flight' },
            effectiveTradeGroupId
          );
        }
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: 'Entry blocked - identical order already in-flight (wait 90 seconds)',
            blocked: 'in_flight',
            tradeGroupId: effectiveTradeGroupId,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      // PREFLIGHT 3: Fetch current broker positions and check for conflicts
      let brokerPositions: Array<{ symbol: string; quantity: number }> = [];
      try {
        const posUrl = `${baseUrl}/accounts/${accountId}/positions`;
        const posResponse = await fetch(posUrl, {
          headers: { 'Authorization': `Bearer ${apiToken}`, 'Accept': 'application/json' },
        });
        const posData = await posResponse.json();
        const rawPositions = posData?.positions?.position;
        if (rawPositions) {
          brokerPositions = (Array.isArray(rawPositions) ? rawPositions : [rawPositions])
            .map((p: any) => ({ symbol: p.symbol, quantity: p.quantity }));
        }
        console.log(`[PREFLIGHT] Fetched ${brokerPositions.length} broker positions`);
      } catch (err) {
        console.error('[PREFLIGHT] Failed to fetch positions:', err);
      }
      
      // Add in-flight symbols as virtual positions (qty=1) to prevent conflicts
      const inFlightSymbols = getInFlightSymbols();
      for (const symbol of inFlightSymbols) {
        // Only add if not already in broker positions
        if (!brokerPositions.some(p => p.symbol === symbol)) {
          brokerPositions.push({ symbol, quantity: 1 }); // Virtual position
        }
      }
      if (inFlightSymbols.size > 0) {
        console.log(`[PREFLIGHT] Added ${inFlightSymbols.size} in-flight symbols as virtual positions`);
      }
      
      // Build position map for conflict check
      // STRICT MODE by default (allowNetting = false)
      const proposedLegs = signal.proposedOrder?.legs || signal.legs;
      const allowNetting = signal.allowEntryNetting === true; // Default: false (STRICT mode)
      const conflictResult = checkEntryConflicts(proposedLegs, brokerPositions, allowNetting);
      
      gates.push({
        name: 'Entry Conflict',
        expected: 'no conflicting positions',
        actual: {
          entry_conflict: conflictResult.entryConflict,
          conflict_symbols: conflictResult.conflictSymbols,
          conflicts: conflictResult.conflicts,
          brokerPositionCount: brokerPositions.length,
          canProceed: conflictResult.canProceed,
          allow_entry_netting: allowNetting,
          netting_applied: conflictResult.nettingApplied,
        },
        pass: conflictResult.canProceed,
        reason: !conflictResult.canProceed 
          ? `STRICT MODE: Entry blocked due to overlapping positions [${conflictResult.conflictSymbols.join(', ')}]. Close/flatten existing positions first.`
          : conflictResult.nettingApplied
          ? `Netting applied: ${conflictResult.conflicts.filter(c => c.resolution === 'netting_applied').length} leg(s) converted to close. WARNING: May create broken structure.`
          : undefined,
      });
      
      if (!conflictResult.canProceed) {
        console.log(`[PREFLIGHT] STRICT MODE: Entry blocked by conflicts:`, conflictResult.conflicts);
        setEntryCooldown(cooldownKey);
        
        const conflictDetails = conflictResult.conflicts.map(c => 
          `${c.symbol}: ${c.existingQty > 0 ? 'LONG' : 'SHORT'} ${Math.abs(c.existingQty)} vs proposed ${c.proposedSide}`
        );
        
        if (signal.strategyId) {
          await saveEvaluation(
            supabase,
            signal.strategyId,
            signal.underlying,
            'entry_attempt',
            {
              decision: 'FAIL',
              reason: `STRICT MODE: Entry blocked - overlapping positions on ${conflictResult.conflictSymbols.join(', ')}`,
              gates,
              inputs: { market: {}, account: {} },
              proposedOrder: signal.proposedOrder,
            },
            { 
              signal, 
              blocked: 'conflict', 
              entry_conflict: true,
              conflict_symbols: conflictResult.conflictSymbols,
              conflicts: conflictResult.conflicts,
              allow_entry_netting: allowNetting,
            },
            effectiveTradeGroupId
          );
        }
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: `STRICT MODE: Entry blocked due to overlapping positions. Close existing positions first.`,
            blocked: 'conflict',
            entry_conflict: true,
            conflict_symbols: conflictResult.conflictSymbols,
            conflicts: conflictResult.conflicts,
            conflictDetails,
            allow_entry_netting: allowNetting,
            tradeGroupId: effectiveTradeGroupId,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Save entry_attempt evaluation with trade_group_id
      if (signal.strategyId) {
        await saveEvaluation(
          supabase,
          signal.strategyId,
          signal.underlying,
          'entry_attempt',
          {
            decision: 'OPEN',
            reason: conflictResult.nettingApplied 
              ? `Entry proceeding with netting` 
              : 'Executing entry order (no conflicts)',
            gates,
            inputs: { market: {}, account: {} },
            proposedOrder: signal.proposedOrder,
          },
          { 
            signal, 
            netting_applied: conflictResult.nettingApplied,
          },
          effectiveTradeGroupId
        );
      }
      
      // Use adjusted legs if netting was applied
      const signalToExecute = conflictResult.nettingApplied
        ? { ...signal, legs: conflictResult.adjustedLegs.map(l => ({ symbol: l.option_symbol, side: l.side, quantity: l.quantity })) }
        : signal;

      // === PREFLIGHT 4: BID/ASK SPREAD VALIDATION ===
      // Prevent slippage on wide-spread options
      const maxSpreadPercent = signal.maxBidAskSpreadPercent ?? DEFAULT_MAX_BID_ASK_SPREAD_PERCENT;
      const legSymbolsForSpread = signalToExecute.legs.map((l: any) => l.symbol).filter(Boolean);

      const spreadValidation = await validateBidAskSpreads(
        legSymbolsForSpread,
        maxSpreadPercent,
        apiToken,
        baseUrl
      );

      gates.push({
        name: 'Bid/Ask Spread',
        expected: `spread <= ${maxSpreadPercent}%`,
        actual: {
          valid: spreadValidation.valid,
          maxSpreadPercent,
          legs: spreadValidation.legs,
          failedSymbols: spreadValidation.failedSymbols,
        },
        pass: spreadValidation.valid,
        reason: spreadValidation.reason,
      });

      if (!spreadValidation.valid) {
        console.log(`[PREFLIGHT] Entry blocked by wide bid/ask spread: ${spreadValidation.reason}`);
        setEntryCooldown(cooldownKey);

        if (signal.strategyId) {
          await saveEvaluation(
            supabase,
            signal.strategyId,
            signal.underlying,
            'entry_attempt',
            {
              decision: 'FAIL',
              reason: `Wide bid/ask spread: ${spreadValidation.reason}`,
              gates,
              inputs: { market: {}, account: {} },
              proposedOrder: signal.proposedOrder,
            },
            {
              signal,
              blocked: 'wide_spread',
              spreadValidation,
            },
            effectiveTradeGroupId
          );
        }

        return new Response(
          JSON.stringify({
            success: false,
            error: `Entry blocked - wide bid/ask spread. ${spreadValidation.reason}`,
            blocked: 'wide_spread',
            spreadValidation,
            tradeGroupId: effectiveTradeGroupId,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // === PREFLIGHT 5: PRE-EXECUTE DUPLICATE SYMBOL GUARD (Rule E) ===
      const orderSymbols = signalToExecute.legs.map((l: any) => l.symbol);
      const uniqueOrderSymbols = new Set(orderSymbols);
      const hasDuplicateSymbols = uniqueOrderSymbols.size !== orderSymbols.length;
      
      gates.push({
        name: 'Symbol Uniqueness',
        expected: 'all leg symbols unique',
        actual: { 
          symbols: orderSymbols, 
          uniqueCount: uniqueOrderSymbols.size, 
          totalCount: orderSymbols.length,
          hasDuplicates: hasDuplicateSymbols,
        },
        pass: !hasDuplicateSymbols,
        reason: hasDuplicateSymbols 
          ? `BLOCKED: Duplicate symbols detected in order: ${orderSymbols.join(', ')}`
          : undefined,
      });
      
      if (hasDuplicateSymbols) {
        // Set cooldown to prevent spam retries
        setEntryCooldown(cooldownKey);
        
        console.error(`[PRE-EXECUTE] BLOCKED: Duplicate symbols in order: ${orderSymbols.join(', ')}`);
        
        if (signal.strategyId) {
          await saveEvaluation(
            supabase,
            signal.strategyId,
            signal.underlying,
            'entry_attempt',
            {
              decision: 'FAIL',
              reason: `BLOCKED: Duplicate symbols in order legs - ${orderSymbols.join(', ')}`,
              gates,
              inputs: { market: {}, account: {} },
              proposedOrder: signal.proposedOrder,
            },
            { 
              signal, 
              blocked: 'duplicate_symbols',
              symbols: orderSymbols,
            },
            effectiveTradeGroupId
          );
        }
        
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: `Order blocked - duplicate symbols detected: ${orderSymbols.join(', ')}`,
            blocked: 'duplicate_symbols',
            symbols: orderSymbols,
            tradeGroupId: effectiveTradeGroupId,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // === SET IN-FLIGHT IMMEDIATELY (before order submission) ===
      setOrderInFlight(inFlightKey);
      
      // === STEP 1: Place the order ===
      const orderResponse = await placeOrderOnly(baseUrl, accountId, apiToken, signalToExecute, effectiveTradeGroupId);
      
      if (!orderResponse.success || !orderResponse.orderId) {
        // Order failed - set cooldown and return
        setEntryCooldown(cooldownKey);
        console.log(`[EXECUTE] Order rejected: ${orderResponse.error}`);
        
        if (signal.strategyId) {
          await saveEvaluation(
            supabase,
            signal.strategyId,
            signal.underlying,
            'exit_rejected', // Using this for order rejection
            {
              decision: 'FAIL',
              reason: orderResponse.error || 'Order failed',
              gates,
              inputs: { market: {}, account: {} },
              proposedOrder: signal.proposedOrder,
            },
            { signal, orderResponse },
            effectiveTradeGroupId
          );
        }
        
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: orderResponse.error,
            tradeGroupId: effectiveTradeGroupId,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      console.log(`[EXECUTE] Order placed: ${orderResponse.orderId} - Starting verified entry flow (60s timeout)`);
      
      // === STEP 2: VERIFIED ENTRY - Poll for up to 60 seconds ===
      const startTime = Date.now();
      const expectedSymbols = signalToExecute.legs.map((l: any) => l.symbol);
      const expectedLegCount = expectedSymbols.length;
      let verified = false;
      let orderStatus = 'pending';
      let filledLegs: string[] = [];
      let lastBrokerPositions: Array<{ symbol: string; quantity: number }> = [];
      let verifiedOrderData: any = null; // Capture order data for fill price extraction
      
      while (Date.now() - startTime < VERIFICATION_TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, VERIFICATION_POLL_INTERVAL_MS));
        
        // Check order status
        try {
          const orderStatusUrl = `${baseUrl}/accounts/${accountId}/orders/${orderResponse.orderId}`;
          const statusResponse = await fetch(orderStatusUrl, { headers });
          const statusData = await statusResponse.json();
          verifiedOrderData = statusData?.order; // Capture for fill price extraction
          orderStatus = verifiedOrderData?.status?.toLowerCase() || 'unknown';
          console.log(`[VERIFY] Order ${orderResponse.orderId} status: ${orderStatus} (elapsed: ${Date.now() - startTime}ms)`);
          
          // If order was rejected/canceled, exit immediately
          if (orderStatus === 'rejected' || orderStatus === 'canceled' || orderStatus === 'expired') {
            console.log(`[VERIFY] Order ${orderResponse.orderId} terminal status: ${orderStatus}`);
            break;
          }
        } catch (err) {
          console.error(`[VERIFY] Error checking order status:`, err);
        }
        
        // Check broker positions
        try {
          const posUrl = `${baseUrl}/accounts/${accountId}/positions`;
          const posResponse = await fetch(posUrl, { headers });
          const posData = await posResponse.json();
          const rawPositions = posData?.positions?.position;
          lastBrokerPositions = rawPositions 
            ? (Array.isArray(rawPositions) ? rawPositions : [rawPositions])
                .map((p: any) => ({ symbol: p.symbol, quantity: p.quantity }))
            : [];
          
          // Check which expected symbols are present with non-zero qty
          filledLegs = expectedSymbols.filter((sym: string) => 
            lastBrokerPositions.some((bp: any) => bp.symbol === sym && bp.quantity !== 0)
          );
          
          console.log(`[VERIFY] Filled legs: ${filledLegs.length}/${expectedLegCount}`);
          
          if (filledLegs.length === expectedLegCount) {
            verified = true;
            break;
          }
        } catch (err) {
          console.error(`[VERIFY] Error checking positions:`, err);
        }
      }
      
      // === STEP 3: EVALUATE RESULT ===
      if (verified) {
        // SUCCESS: All legs filled - persist mapping
        console.log(`[VERIFIED] ✅ All ${expectedLegCount} legs filled for order ${orderResponse.orderId}`);
        
        // === COMPUTE NET ENTRY CREDIT FROM ACTUAL FILLS ===
        let netEntryCreditDollars = 0;
        const orderLegs = verifiedOrderData?.leg 
          ? (Array.isArray(verifiedOrderData.leg) ? verifiedOrderData.leg : [verifiedOrderData.leg]) 
          : [];

        console.log(`[ENTRY CREDIT] Computing from ${orderLegs.length} order legs (actual fills)`);

        for (const signalLeg of signalToExecute.legs) {
          const orderLeg = orderLegs.find((ol: any) => ol.option_symbol === signalLeg.symbol);
          const fillPrice = Number(orderLeg?.avg_fill_price || 0);
          const qty = Math.abs(Number(signalLeg.quantity) || 1);
          
          // Normalize leg_dir using helper
          const legDir = normalizeLegDir(signalLeg.side);
          
          if (legDir === 'short') {
            // Short leg (sell_to_open): receives credit
            netEntryCreditDollars += fillPrice * qty * 100;
          } else if (legDir === 'long') {
            // Long leg (buy_to_open): pays debit
            netEntryCreditDollars -= fillPrice * qty * 100;
          }
          
          console.log(`[ENTRY CREDIT] Leg ${signalLeg.symbol}: side=${signalLeg.side}, dir=${legDir}, fill=${fillPrice}, qty=${qty}`);
        }

        console.log(`[ENTRY CREDIT] Total entry credit from fills: $${netEntryCreditDollars.toFixed(2)}`);
        
        await persistPositionGroupMap(supabase, {
          tradeGroupId: effectiveTradeGroupId,
          openOrderId: String(orderResponse.orderId),
          underlying: signal.underlying,
          expiration: signal.expiration || null,
          strategyName: signal.strategyName || null,
          strategyType: signal.type || null,
          legs: signalToExecute.legs.map((leg: any) => ({
            symbol: leg.symbol,
            quantity: leg.quantity || 1,
            side: leg.side || 'unknown',
          })),
          entryCredit: netEntryCreditDollars, // NEW: computed from actual fills
        });
        
        if (signal.strategyId) {
          await saveEvaluation(
            supabase,
            signal.strategyId,
            signal.underlying,
            'entry_filled',
            {
              decision: 'OPEN',
              reason: `All ${expectedLegCount} legs verified and filled`,
              gates: [...gates, {
                name: 'Fill Verification',
                expected: `${expectedLegCount} legs filled`,
                actual: { filledLegs: filledLegs.length, verified: true, orderStatus },
                pass: true,
              }],
              inputs: { market: {}, account: {} },
              proposedOrder: { ...signal.proposedOrder, order_id: orderResponse.orderId },
            },
            { signal, orderResponse, verified: true },
            effectiveTradeGroupId
          );
        }
        
        return new Response(
          JSON.stringify({ 
            success: true,
            orderId: orderResponse.orderId,
            tradeGroupId: effectiveTradeGroupId,
            verified: true,
            filledLegs,
            mappingPersisted: true,
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      // === STEP 4: BAIL-OUT (Automatic rollback) ===
      const missingLegs = expectedSymbols.filter((s: string) => !filledLegs.includes(s));
      console.error(`[BAILOUT] 🚨 PARTIAL FILL: Order ${orderResponse.orderId} - ${filledLegs.length}/${expectedLegCount} legs after 60s`);
      console.error(`[BAILOUT] Missing: ${missingLegs.join(', ')}, Filled: ${filledLegs.join(', ')}`);
      
      const bailOutOrders: Array<{ symbol: string; orderId?: string; error?: string; side: string }> = [];
      
      // Step 4a: Try to cancel unfilled order portions
      if (orderStatus === 'open' || orderStatus === 'pending' || orderStatus === 'partially_filled') {
        try {
          const cancelUrl = `${baseUrl}/accounts/${accountId}/orders/${orderResponse.orderId}`;
          const cancelResponse = await fetch(cancelUrl, { 
            method: 'DELETE',
            headers 
          });
          const cancelData = await cancelResponse.json();
          console.log(`[BAILOUT] Cancel attempt for order ${orderResponse.orderId}:`, cancelData);
        } catch (err) {
          console.error(`[BAILOUT] Cancel failed:`, err);
        }
      }
      
      // Step 4b: Close any filled legs at market
      for (const sym of filledLegs) {
        await new Promise(r => setTimeout(r, BAILOUT_ORDER_DELAY_MS));
        
        // Find the leg info to determine close side
        const leg = signalToExecute.legs.find((l: any) => l.symbol === sym);
        const entryWasSell = leg?.side?.includes('sell');
        const closeSide = entryWasSell ? 'buy_to_close' : 'sell_to_close';
        
        // Find current position qty
        const positionQty = lastBrokerPositions.find(p => p.symbol === sym)?.quantity || 0;
        const closeQty = Math.abs(positionQty);
        
        if (closeQty === 0) {
          console.log(`[BAILOUT] Skip ${sym} - qty is 0`);
          continue;
        }
        
        try {
          const closeUrl = `${baseUrl}/accounts/${accountId}/orders`;
          const closeResponse = await fetch(closeUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiToken}`,
              'Accept': 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              class: 'option',
              symbol: signal.underlying,
              option_symbol: sym,
              side: closeSide,
              quantity: closeQty.toString(),
              type: 'market',
              duration: 'day',
            }).toString(),
          });
          const closeData = await closeResponse.json();
          const closeOrderId = closeData?.order?.id;
          
          bailOutOrders.push({
            symbol: sym,
            orderId: closeOrderId,
            error: closeData?.errors?.error,
            side: closeSide,
          });
          console.log(`[BAILOUT] Close order for ${sym}: ${closeOrderId || closeData?.errors?.error}`);
        } catch (err) {
          bailOutOrders.push({
            symbol: sym,
            error: err instanceof Error ? err.message : 'Unknown error',
            side: closeSide,
          });
          console.error(`[BAILOUT] Close order failed for ${sym}:`, err);
        }
      }
      
      // Step 4c: Log CRITICAL_AUTO_RECONCILE event
      if (signal.strategyId) {
        await saveEvaluation(
          supabase,
          signal.strategyId,
          signal.underlying,
          'critical_auto_reconcile',
          {
            decision: 'FAIL',
            reason: `PARTIAL FILL - ${filledLegs.length}/${expectedLegCount} legs after 60s. Auto bail-out executed.`,
            gates: [...gates, {
              name: 'Fill Verification',
              expected: `${expectedLegCount} legs filled within 60s`,
              actual: { 
                filledLegs: filledLegs.length, 
                missingLegs: missingLegs.length,
                verified: false, 
                orderStatus,
                timeoutMs: VERIFICATION_TIMEOUT_MS,
              },
              pass: false,
              reason: 'Timeout exceeded - automatic bail-out triggered',
            }],
            inputs: { 
              market: {
                bailout_orders: bailOutOrders,
                missing_legs: missingLegs,
                filled_legs: filledLegs,
              }, 
              account: {} 
            },
            proposedOrder: { 
              ...signal.proposedOrder, 
              order_id: orderResponse.orderId,
              bailout_orders: bailOutOrders,
            },
          },
          { 
            signal, 
            orderResponse, 
            verified: false, 
            critical: true,
            bailOutOrders,
            missingLegs,
            filledLegs,
          },
          effectiveTradeGroupId
        );
      }
      
      // DO NOT persist mapping - bail-out occurred
      console.error(`[BAILOUT] ⚠️ Mapping NOT persisted for order ${orderResponse.orderId} - requires manual reconciliation`);
      
      return new Response(
        JSON.stringify({ 
          success: false,
          orderId: orderResponse.orderId,
          tradeGroupId: effectiveTradeGroupId,
          verified: false,
          critical: true,
          orderStatus,
          filledLegs,
          missingLegs,
          bailOutOrders,
          message: 'CRITICAL: Partial fill detected. Automatic bail-out executed. Manual review required.',
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'check_exits') {
      // === RECONCILE STALE CLOSE ORDERS FIRST ===
      // This handles cases where browser tab was closed after submitting close orders
      // before fill data could be recorded. Must run before processing exits.
      const reconcileResult = await reconcileStaleCloseOrders(supabase);
      if (reconcileResult.reconciled > 0 || reconcileResult.timedOut > 0) {
        console.log(`[CHECK_EXITS] Reconciled ${reconcileResult.reconciled} stale orders, ${reconcileResult.timedOut} timed out`);
      }

      // Check if any positions should be closed
      // CRITICAL: Return group-level exit signals, not per-leg
      const exitSignals: any[] = [];

      // Track exit status for ALL groups (for UI visibility into why positions aren't exiting)
      const exitStatus: Array<{
        tradeGroupId: string | null;
        symbol: string;
        strategyName: string;
        pnlPercent: number;
        profitTargetPercent: number;
        stopLossPercent: number;
        dte?: number;
        timeStopDte?: number;
        triggered: boolean;
        reason: string | null;
        blockedReason?: string;
      }> = [];
      
      // Helper: Get expected leg count for strategy type
      function getExpectedLegCount(strategyType: string | null | undefined): number | null {
        if (!strategyType) return null;
        switch (strategyType) {
          case 'iron_condor':
          case 'iron_fly':
            return 4;
          case 'credit_put_spread':
          case 'credit_call_spread':
          case 'straddle':
          case 'strangle':
            return 2;
          case 'butterfly':
            return 3;
          default:
            return null;
        }
      }
      
      // Group positions by tradeGroupId first
      const groupedPositions = new Map<string, any[]>();
      const ungroupedPositions: any[] = [];
      
      for (const position of positions || []) {
        if (position.status !== 'open' || !position.strategyName) continue;
        
        if (position.tradeGroupId) {
          if (!groupedPositions.has(position.tradeGroupId)) {
            groupedPositions.set(position.tradeGroupId, []);
          }
          groupedPositions.get(position.tradeGroupId)!.push(position);
        } else {
          ungroupedPositions.push(position);
        }
      }
      
      // Process grouped positions - evaluate as a group, emit one signal per group
      for (const [tradeGroupId, groupLegs] of groupedPositions) {
        // Get strategy from first leg
        const firstLeg = groupLegs[0];
        const strategy = (strategies as Strategy[]).find(s => s.name === firstLeg.strategyName);
        if (!strategy) continue;
        
        const strategyType = firstLeg.strategyType || strategy.type;
        const expectedLegs = getExpectedLegCount(strategyType);
        const observedLegs = groupLegs.length;
        
        // === EXIT GATE: Block if structure is broken ===
        if (expectedLegs !== null && observedLegs < expectedLegs) {
          console.log(`[EXIT GATE] BLOCKED: ${tradeGroupId} has ${observedLegs}/${expectedLegs} legs - broken structure`);
          
          // Save evaluation record for visibility
          if (strategy.id) {
            await saveEvaluation(
              supabase,
              strategy.id,
              firstLeg.underlying || strategy.underlying,
              'exit_blocked',
              {
                decision: 'HOLD',
                reason: `Broken structure — ${observedLegs}/${expectedLegs} legs present. Manual intervention required.`,
                gates: [{
                  name: 'Structure Integrity',
                  expected: `${expectedLegs} legs`,
                  actual: { observed: observedLegs, expected: expectedLegs, strategyType },
                  pass: false,
                  reason: 'Cannot auto-close broken multi-leg structure',
                }],
                inputs: { 
                  market: { group_id: tradeGroupId, legs: groupLegs.map((l: any) => l.symbol) }, 
                  account: {} 
                },
              },
              { groupLegs, blocked: 'broken_structure' },
              tradeGroupId
            );
          }
          
          // Record blocked status for UI visibility
          exitStatus.push({
            tradeGroupId,
            symbol: firstLeg.symbol,
            strategyName: strategy.name,
            pnlPercent: 0, // Cannot calculate without full structure
            profitTargetPercent: strategy.exitConditions.profitTargetPercent,
            stopLossPercent: strategy.exitConditions.stopLossPercent,
            triggered: false,
            reason: null,
            blockedReason: `Broken structure (${observedLegs}/${expectedLegs} legs)`,
          });

          continue; // Skip this group - don't generate exit signal
        }

        // === FIXED: Direction-aware mark P&L for credit strategies ===

        // Step 1: Fetch entry_credit and leg_side for ALL legs in this group
        const { data: mappings } = await supabase
          .from('position_group_map')
          .select('entry_credit, symbol, leg_side')
          .eq('trade_group_id', tradeGroupId);  // NO .limit(1) - fetch all legs

        // Step 2: Validate entry_credit consistency
        const entryCredits = (mappings || [])
          .map((m: any) => m.entry_credit)
          .filter((ec: any) => ec != null);
        const distinctEntryCredits = [...new Set(entryCredits)];
        if (distinctEntryCredits.length > 1) {
          console.warn(`[EXIT] WARNING: Group ${tradeGroupId} has ${distinctEntryCredits.length} distinct entry_credit values: ${distinctEntryCredits.join(', ')}`);
        }
        const entryCreditDollars = Number(distinctEntryCredits[0]) || 0;

        // Step 3: Build leg side lookup from stored data
        const legSideMap = new Map<string, string>();
        for (const mapping of mappings || []) {
          if (mapping.symbol && mapping.leg_side) {
            legSideMap.set(mapping.symbol, mapping.leg_side);
          }
        }

        // Step 4: Check for missing/zero mark prices
        const allLegSymbols = groupLegs.map((l: any) => l.symbol);
        const missingMarkLegs: string[] = [];
        for (const leg of groupLegs) {
          const mark = getMarkPrice(leg);
          if (mark <= 0) {
            missingMarkLegs.push(leg.symbol);
          }
        }

        if (missingMarkLegs.length > 0) {
          console.warn(`[EXIT] SKIPPING group ${tradeGroupId}: ${missingMarkLegs.length} legs have missing/zero markPrice: ${missingMarkLegs.join(', ')}`);
          continue; // Skip this group - cannot evaluate exit without valid marks
        }

        // Step 5: Compute costToCloseDebit per-leg using abs(leg.quantity)
        let costToCloseDebit = 0;
        let legDirUnknown = false;
        for (const leg of groupLegs) {
          const markPrice = getMarkPrice(leg);
          const qty = Math.abs(Number(leg.quantity ?? 0));
          
          // Get stored leg_side and normalize to direction (no costBasis fallback!)
          const storedSide = legSideMap.get(leg.symbol);
          let legDir = normalizeLegDir(storedSide);
          
          // Fallback: infer from strikes using iron condor rules
          if (!legDir) {
            legDir = inferLegDirFromStrikes(leg.symbol, allLegSymbols);
            if (legDir) {
              console.log(`[EXIT] Inferred leg_dir from strikes for ${leg.symbol}: ${legDir}`);
            }
          }
          
          // If still unknown, flag and skip this group
          if (!legDir) {
            console.warn(`[EXIT] Cannot determine leg_dir for ${leg.symbol} - skipping group`);
            legDirUnknown = true;
            break;
          }
          
          if (legDir === 'short') {
            // Short leg: buy_to_close = pay debit
            costToCloseDebit += markPrice * qty * 100;
          } else {
            // Long leg: sell_to_close = receive credit (reduces net cost)
            costToCloseDebit -= markPrice * qty * 100;
          }
        }

        // Skip group if any leg direction is unknown
        if (legDirUnknown) {
          console.warn(`[EXIT] SKIPPING group ${tradeGroupId}: Unable to determine leg direction for all legs`);
          continue;
        }

        // Clamp tiny negative to 0 (quote noise)
        if (costToCloseDebit < 0 && costToCloseDebit > -1) {
          costToCloseDebit = 0;
        }

        // Step 6: Compute unrealized P&L (entry_credit stored in DOLLARS)
        const unrealizedPnlDollars = entryCreditDollars - costToCloseDebit;

        // Step 7: Strategy type guard
        // Only use credit P&L% formula when entryCreditDollars > 0
        let unrealizedPnlPercent: number;
        if (entryCreditDollars > 0) {
          unrealizedPnlPercent = (unrealizedPnlDollars / entryCreditDollars) * 100;
        } else {
          // Debit strategy or missing entry credit: skip percentage-based triggers
          console.warn(`[EXIT] Group ${tradeGroupId}: entryCreditDollars=${entryCreditDollars} <= 0, skipping P&L% triggers`);
          unrealizedPnlPercent = 0;
        }

        // Use these for exit evaluation
        const pnl = unrealizedPnlDollars;
        const pnlPercent = unrealizedPnlPercent;

        console.log(`[EXIT] Group ${tradeGroupId}: entryCredit=$${entryCreditDollars.toFixed(2)}, costToClose=$${costToCloseDebit.toFixed(2)}, unrealizedPnl=$${unrealizedPnlDollars.toFixed(2)}, pnl%=${unrealizedPnlPercent.toFixed(2)}%, pnl_basis=mark`);
        
        // === SANITY GUARD: Skip absurd P&L% values ===
        if (Math.abs(pnlPercent) > 200) {
          console.warn(`[EXIT SANITY] Absurd P&L% detected: ${pnlPercent.toFixed(2)}% for group ${tradeGroupId}`);
          console.warn(`[EXIT SANITY] Debug: entryCreditDollars=${entryCreditDollars.toFixed(2)}, costToClose=${costToCloseDebit.toFixed(2)}, legs=${observedLegs}`);
          console.warn(`[EXIT SANITY] Skipping exit trigger - requires manual review`);
          continue; // Skip this group
        }
        
        let exitReason: string | null = null;

        // === Enhanced Exit Logic with Dollar-Based Triggers ===
        const exitMode = strategy.exitConditions.exitTriggerMode ?? 'either';
        const profitTargetPercent = strategy.exitConditions.profitTargetPercent;
        const stopLossPercent = strategy.exitConditions.stopLossPercent;
        const profitTargetDollars = strategy.exitConditions.profitTargetDollars;
        const stopLossDollars = strategy.exitConditions.stopLossDollars;

        // Calculate which thresholds are met
        const profitPercentMet = pnlPercent >= profitTargetPercent && pnlPercent > 0;
        const profitDollarsMet = profitTargetDollars !== undefined && pnl >= profitTargetDollars;
        const stopPercentMet = pnlPercent <= -stopLossPercent;
        const stopDollarsMet = stopLossDollars !== undefined && pnl <= -stopLossDollars;

        // Determine exit reason based on mode
        if (exitMode === 'both_required') {
          // Profit: BOTH percent AND dollars must be satisfied
          if (profitPercentMet && profitDollarsMet) {
            exitReason = 'profit_target_combined';
          } else if (stopPercentMet && stopDollarsMet) {
            exitReason = 'stop_loss_combined';
          }
        } else if (exitMode === 'percent_only') {
          // Only percent thresholds considered
          if (profitPercentMet) {
            exitReason = 'profit_target';
          } else if (stopPercentMet) {
            exitReason = 'stop_loss';
          }
        } else if (exitMode === 'dollars_only') {
          // Only dollar thresholds considered
          if (profitDollarsMet) {
            exitReason = 'profit_target_dollars';
          } else if (stopDollarsMet) {
            exitReason = 'stop_loss_dollars';
          }
        } else {
          // 'either' mode (default): trigger if ANY threshold is met
          if (profitPercentMet || profitDollarsMet) {
            exitReason = profitPercentMet ? 'profit_target' : 'profit_target_dollars';
          } else if (stopPercentMet || stopDollarsMet) {
            exitReason = stopPercentMet ? 'stop_loss' : 'stop_loss_dollars';
          }
        }

        // Calculate earliest DTE for the group (used for time stop and status reporting)
        let earliestDte = Infinity;
        for (const leg of groupLegs) {
          if (leg.expirationDate) {
            const expDate = new Date(leg.expirationDate);
            const dte = Math.ceil((expDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
            earliestDte = Math.min(earliestDte, dte);
          }
        }

        // Check time stop - always checked
        if (!exitReason && strategy.exitConditions.timeStopDte) {
          if (earliestDte <= strategy.exitConditions.timeStopDte) {
            exitReason = 'time_stop';
          }
        }

        // Check time stop by clock time (timeStopTime)
        if (!exitReason && strategy.exitConditions.timeStopTime) {
          const { timeStr } = getETTime();
          if (timeStr >= strategy.exitConditions.timeStopTime) {
            exitReason = 'time_stop_clock';
          }
        }

        if (exitReason) {
          // Get current timestamp for trigger snapshot
          const { isoET } = getETTime();
          
          // Build expected description based on exit reason
          const getExpectedDescription = (reason: string) => {
            switch (reason) {
              case 'profit_target':
                return `P&L >= ${profitTargetPercent}%`;
              case 'profit_target_dollars':
                return `P&L >= $${profitTargetDollars}`;
              case 'profit_target_combined':
                return `P&L >= ${profitTargetPercent}% AND >= $${profitTargetDollars}`;
              case 'stop_loss':
                return `P&L <= -${stopLossPercent}%`;
              case 'stop_loss_dollars':
                return `P&L <= -$${stopLossDollars}`;
              case 'stop_loss_combined':
                return `P&L <= -${stopLossPercent}% AND <= -$${stopLossDollars}`;
              case 'time_stop':
                return `DTE <= ${strategy.exitConditions.timeStopDte}`;
              case 'time_stop_clock':
                return `Time >= ${strategy.exitConditions.timeStopTime} ET`;
              default:
                return `Unknown trigger: ${reason}`;
            }
          };

          // Save exit_attempt evaluation with trigger snapshot in inputs.market
          if (strategy.id) {
            await saveEvaluation(
              supabase,
              strategy.id,
              firstLeg.underlying || strategy.underlying,
              'exit_attempt',
              {
                decision: 'CLOSE',
                reason: `Group exit triggered: ${exitReason} (P&L: ${pnlPercent.toFixed(2)}%, $${pnl.toFixed(2)})`,
                gates: [{
                  name: exitReason,
                  expected: getExpectedDescription(exitReason),
                  actual: {
                    pnl_percent: pnlPercent,
                    pnl_dollars: pnl,
                    legs: observedLegs,
                    pnl_basis: 'mark',
                    exit_mode: exitMode,
                  },
                  pass: true,
                }],
                inputs: {
                  market: {
                    pnl_percent: pnlPercent,
                    pnl_dollars: pnl,
                    pnl_basis: 'mark',
                    exit_mode: exitMode,
                    entry_credit_dollars: entryCreditDollars,
                    cost_to_close_debit: costToCloseDebit,
                    unrealized_pnl_dollars: unrealizedPnlDollars,
                    profit_target_percent: profitTargetPercent,
                    profit_target_dollars: profitTargetDollars,
                    stop_loss_percent: stopLossPercent,
                    stop_loss_dollars: stopLossDollars,
                    leg_count: observedLegs,
                    leg_sides: Object.fromEntries(legSideMap),
                    distinct_entry_credits: distinctEntryCredits.length,
                    trigger_timestamp: isoET,
                  },
                  account: {}
                },
              },
              { groupLegs, exitReason },
              tradeGroupId
            );
          }
          
          // Emit ONE exit signal per group, include ALL leg symbols
          // The frontend will close all legs when it receives this
          for (const leg of groupLegs) {
            exitSignals.push({
              positionId: leg.id,
              symbol: leg.symbol,
              quantity: leg.quantity,
              reason: exitReason,
              pnlPercent,
              tradeGroupId,
              isGroupExit: true,
              groupLegCount: observedLegs,
            });
          }

          // Record exit status (triggered)
          exitStatus.push({
            tradeGroupId,
            symbol: firstLeg.symbol,
            strategyName: strategy.name,
            pnlPercent,
            profitTargetPercent: strategy.exitConditions.profitTargetPercent,
            stopLossPercent: strategy.exitConditions.stopLossPercent,
            dte: earliestDte !== Infinity ? earliestDte : undefined,
            timeStopDte: strategy.exitConditions.timeStopDte,
            triggered: true,
            reason: exitReason,
          });
        } else {
          // Log WHY no exit triggered for debugging
          console.log(`[EXIT] Group ${tradeGroupId}: NO TRIGGER - mode=${exitMode}, ` +
            `pnl%=${pnlPercent.toFixed(2)}%, pnl$=$${pnl.toFixed(2)}, ` +
            `profitTarget%=${profitTargetPercent}%, profitTarget$=${profitTargetDollars ?? 'n/a'}, ` +
            `stopLoss%=${stopLossPercent}%, stopLoss$=${stopLossDollars ?? 'n/a'}`);

          // Record exit status (not triggered)
          exitStatus.push({
            tradeGroupId,
            symbol: firstLeg.symbol,
            strategyName: strategy.name,
            pnlPercent,
            profitTargetPercent: strategy.exitConditions.profitTargetPercent,
            stopLossPercent: strategy.exitConditions.stopLossPercent,
            dte: earliestDte !== Infinity ? earliestDte : undefined,
            timeStopDte: strategy.exitConditions.timeStopDte,
            triggered: false,
            reason: null,
          });
        }
      }

      // Process ungrouped positions individually
      for (const position of ungroupedPositions) {
        const strategy = (strategies as Strategy[]).find(s => s.name === position.strategyName);
        if (!strategy) continue;

        const costBasis = Number(position.costBasis ?? 0);
        const currentValue = Number(position.currentValue ?? 0);
        const isShort = Number(position.quantity ?? 0) < 0 || costBasis < 0;

        const pnl = isShort ? Math.abs(costBasis) - currentValue : currentValue - costBasis;
        const pnlPercent = Math.abs(costBasis) > 0 ? (pnl / Math.abs(costBasis)) * 100 : 0;

        // Enhanced exit logic with dollar-based triggers
        const exitMode = strategy.exitConditions.exitTriggerMode ?? 'either';
        const profitTargetPercent = strategy.exitConditions.profitTargetPercent;
        const stopLossPercent = strategy.exitConditions.stopLossPercent;
        const profitTargetDollars = strategy.exitConditions.profitTargetDollars;
        const stopLossDollars = strategy.exitConditions.stopLossDollars;

        const profitPercentMet = pnlPercent >= profitTargetPercent && pnlPercent > 0;
        const profitDollarsMet = profitTargetDollars !== undefined && pnl >= profitTargetDollars;
        const stopPercentMet = pnlPercent <= -stopLossPercent;
        const stopDollarsMet = stopLossDollars !== undefined && pnl <= -stopLossDollars;

        let exitReason: string | null = null;

        if (exitMode === 'both_required') {
          if (profitPercentMet && profitDollarsMet) {
            exitReason = 'profit_target_combined';
          } else if (stopPercentMet && stopDollarsMet) {
            exitReason = 'stop_loss_combined';
          }
        } else if (exitMode === 'percent_only') {
          if (profitPercentMet) exitReason = 'profit_target';
          else if (stopPercentMet) exitReason = 'stop_loss';
        } else if (exitMode === 'dollars_only') {
          if (profitDollarsMet) exitReason = 'profit_target_dollars';
          else if (stopDollarsMet) exitReason = 'stop_loss_dollars';
        } else {
          // 'either' mode
          if (profitPercentMet || profitDollarsMet) {
            exitReason = profitPercentMet ? 'profit_target' : 'profit_target_dollars';
          } else if (stopPercentMet || stopDollarsMet) {
            exitReason = stopPercentMet ? 'stop_loss' : 'stop_loss_dollars';
          }
        }

        // Check time stop
        if (!exitReason && strategy.exitConditions.timeStopDte && position.expirationDate) {
          const expDate = new Date(position.expirationDate);
          const dte = Math.ceil((expDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
          if (dte <= strategy.exitConditions.timeStopDte) {
            exitReason = 'time_stop';
          }
        }

        if (exitReason) {
          exitSignals.push({
            positionId: position.id,
            symbol: position.symbol,
            quantity: position.quantity,
            reason: exitReason,
            pnlPercent,
            tradeGroupId: null,
            isGroupExit: false,
          });
        }
      }

      return new Response(
        JSON.stringify({ exitSignals, exitStatus, marketState }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    if (action === 'close_position') {
      // Close a specific position and save exit evaluation
      const { position, reason, strategyId, tradeGroupId } = body;
      
      if (!position) {
        return new Response(
          JSON.stringify({ error: 'Position required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      // Save exit_attempt evaluation
      if (strategyId && tradeGroupId) {
        await saveEvaluation(
          supabase,
          strategyId,
          position.underlying || 'SPY',
          'exit_attempt',
          {
            decision: 'CLOSE',
            reason: reason || 'Manual close',
            gates: [],
            inputs: { market: {}, account: {} },
          },
          { position, reason },
          tradeGroupId
        );
      }
      
      // TODO: Actually place close order via Tradier
      // For now, return success indicator
      return new Response(
        JSON.stringify({ success: true, message: 'Exit evaluation saved' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // === ATOMIC MAPPING VERIFICATION ===
    // Verifies all legs are filled before persisting to position_group_map
    if (action === 'verify_fill') {
      const { orderId, expectedLegs, tradeGroupId, strategyName, strategyType, underlying, expiration } = body;
      
      if (!orderId || !expectedLegs || !tradeGroupId) {
        return new Response(
          JSON.stringify({ error: 'orderId, expectedLegs, and tradeGroupId required' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      // Step 1: Check Order Status FIRST (primary source of truth)
      const orderStatusUrl = `${baseUrl}/accounts/${accountId}/orders/${orderId}`;
      let orderStatus = 'unknown';
      
      try {
        const orderResponse = await fetch(orderStatusUrl, { headers });
        const orderData = await orderResponse.json();
        orderStatus = orderData?.order?.status?.toLowerCase() || 'unknown';
        console.log(`[verify_fill] Order ${orderId} status: ${orderStatus}`);
      } catch (err) {
        console.error(`[verify_fill] Error fetching order status:`, err);
      }
      
      // If order still pending, return non-critical - will retry
      if (orderStatus === 'pending' || orderStatus === 'open') {
        return new Response(JSON.stringify({ 
          verified: false, 
          critical: false,
          orderStatus,
          message: 'Order still pending - will retry'
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      
      // Step 2: Poll broker positions to verify all legs filled
      const MAX_RETRIES = 3;
      const RETRY_DELAY_MS = 3000;
      const FILLED_EXTRA_WAIT_MS = 5000; // Extra wait if order shows FILLED but positions not showing
      
      let filledLegs: string[] = [];
      let verified = false;
      const expectedSymbols = expectedLegs.map((l: any) => l.symbol);
      
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const positionsResponse = await fetch(
            `${baseUrl}/accounts/${accountId}/positions`,
            { headers }
          );
          const posData = await positionsResponse.json();
          const rawPositions = posData?.positions?.position;
          const brokerPositions = rawPositions ? (Array.isArray(rawPositions) ? rawPositions : [rawPositions]) : [];
          
          // Check which expected symbols are present with non-zero qty
          filledLegs = expectedSymbols.filter((sym: string) => 
            brokerPositions.some((bp: any) => bp.symbol === sym && bp.quantity !== 0)
          );
          
          console.log(`[verify_fill] Attempt ${attempt + 1}: ${filledLegs.length}/${expectedSymbols.length} legs found`);
          
          if (filledLegs.length === expectedSymbols.length) {
            verified = true;
            break;
          }
          
          // If order status is FILLED but positions not showing yet, wait extra 5 seconds
          if (orderStatus === 'filled' && attempt === 0) {
            console.log(`[verify_fill] Order FILLED but only ${filledLegs.length}/${expectedSymbols.length} positions visible - waiting ${FILLED_EXTRA_WAIT_MS}ms`);
            await new Promise(r => setTimeout(r, FILLED_EXTRA_WAIT_MS));
          } else {
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
          }
        } catch (err) {
          console.error(`[verify_fill] Error fetching positions:`, err);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
      }
      
      if (verified) {
        // SUCCESS: Fetch order fill prices to calculate entry credit
        let entryCredit: number | undefined;
        try {
          const orderDetailUrl = `${baseUrl}/accounts/${accountId}/orders/${orderId}`;
          const orderDetailResp = await fetch(orderDetailUrl, { headers });
          const orderDetail = await orderDetailResp.json();

          // For multi-leg orders, Tradier provides leg array with fill prices
          const legs = orderDetail?.order?.leg;
          if (legs && Array.isArray(legs)) {
            let totalCredit = 0;
            for (const leg of legs) {
              const avgFill = Number(leg.avg_fill_price) || 0;
              const qty = Math.abs(Number(leg.quantity) || 0);
              const side = leg.side?.toLowerCase();

              if (side === 'sell_to_open') {
                totalCredit += avgFill * qty * 100; // Credit received
              } else if (side === 'buy_to_open') {
                totalCredit -= avgFill * qty * 100; // Debit paid
              }
            }
            entryCredit = totalCredit; // Net credit in dollars
            console.log(`[verify_fill] Calculated entry credit: $${entryCredit.toFixed(2)} from ${legs.length} legs`);
          } else {
            console.warn(`[verify_fill] No leg array found in order ${orderId}, entry_credit will be null`);
          }
        } catch (err) {
          console.error('[verify_fill] Error fetching order fill prices:', err);
        }

        // Persist the mapping with entry credit
        await persistPositionGroupMap(supabase, {
          tradeGroupId,
          openOrderId: String(orderId),
          underlying,
          expiration: expiration || null,
          strategyName: strategyName || null,
          strategyType: strategyType || null,
          legs: expectedLegs,
          entryCredit,
        });
        
        console.log(`[verify_fill] SUCCESS: All ${filledLegs.length} legs verified and mapping persisted for order ${orderId}`);
        
        return new Response(JSON.stringify({ 
          verified: true, 
          filledLegs,
          mappingPersisted: true,
          orderStatus,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } else {
        // PARTIAL FILL - DO NOT PERSIST
        const missingLegs = expectedSymbols.filter((s: string) => !filledLegs.includes(s));
        
        console.error(`[CRITICAL] PARTIAL FILL: Order ${orderId} - only ${filledLegs.length}/${expectedSymbols.length} legs filled`);
        console.error(`[CRITICAL] Missing legs: ${missingLegs.join(', ')}`);
        
        return new Response(JSON.stringify({ 
          verified: false,
          critical: true,
          orderStatus,
          filledLegs,
          missingLegs,
          message: 'PARTIAL FILL DETECTED - Manual intervention required. Mapping NOT persisted.'
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }
    
    // === STRUCTURE INTEGRITY CHECK ===
    // Checks for orphan positions and broken groups
    if (action === 'check_structure_integrity') {
      const positionsToCheck = body.positions || [];
      
      const brokenGroups: { groupId: string; expected: number; observed: number; strategyType: string }[] = [];
      const orphanSymbols: string[] = [];
      
      // Check for orphans
      for (const pos of positionsToCheck) {
        if (pos.id?.endsWith('-orphan')) {
          orphanSymbols.push(pos.symbol);
        }
      }
      
      // Group by tradeGroupId
      const groupedPositions = new Map<string, any[]>();
      for (const pos of positionsToCheck.filter((p: any) => p.tradeGroupId)) {
        const group = groupedPositions.get(pos.tradeGroupId) || [];
        group.push(pos);
        groupedPositions.set(pos.tradeGroupId, group);
      }
      
      // Check for broken groups
      for (const [groupId, groupLegs] of groupedPositions) {
        const strategyType = groupLegs[0]?.strategyType;
        let expected: number | null = null;
        
        switch (strategyType) {
          case 'iron_condor':
          case 'iron_fly':
            expected = 4;
            break;
          case 'credit_put_spread':
          case 'credit_call_spread':
          case 'straddle':
          case 'strangle':
            expected = 2;
            break;
          case 'butterfly':
            expected = 3;
            break;
        }
        
        if (expected !== null && groupLegs.length < expected) {
          brokenGroups.push({ 
            groupId, 
            expected, 
            observed: groupLegs.length,
            strategyType: strategyType || 'unknown',
          });
        }
      }
      
      const healthy = brokenGroups.length === 0 && orphanSymbols.length === 0;
      const reason = healthy ? '' : 
        `${brokenGroups.length} broken group(s), ${orphanSymbols.length} orphan position(s)`;
      
      return new Response(JSON.stringify({ 
        healthy, 
        brokenGroups, 
        orphanSymbols, 
        reason 
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    // === CLEANUP STALE MAPPINGS ===
    // Removes old position_group_map entries that no longer correspond to broker positions
    // ALSO removes mappings for rejected orders to prevent "Broken Structure" ghost warnings
    if (action === 'cleanup_maps') {
      // Support aggressive mode (no 24h cutoff - deletes all mappings for closed positions)
      const aggressive = body.aggressive === true;
      
      // Fetch current broker positions
      let activeSymbols = new Set<string>();
      
      try {
        const positionsResponse = await fetch(
          `${baseUrl}/accounts/${accountId}/positions`,
          { headers }
        );
        const posData = await positionsResponse.json();
        const rawPositions = posData?.positions?.position;
        const brokerPositions = rawPositions ? (Array.isArray(rawPositions) ? rawPositions : [rawPositions]) : [];
        activeSymbols = new Set(brokerPositions.map((p: any) => p.symbol));
        console.log(`[cleanup_maps] Found ${activeSymbols.size} active broker positions, aggressive=${aggressive}`);
      } catch (err) {
        console.error('[cleanup_maps] Error fetching positions:', err);
        return new Response(JSON.stringify({ 
          error: 'Failed to fetch broker positions',
          deletedCount: 0,
          activeSymbolsCount: 0,
        }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      
      // === NEW: Clean up mappings for REJECTED entry orders ===
      let rejectedOrderIds: string[] = [];
      let rejectedMappingsDeleted = 0;
      
      try {
        // Fetch recent orders (last 24h) to find rejected ones
        const ordersUrl = `${baseUrl}/accounts/${accountId}/orders`;
        const ordersResp = await fetch(ordersUrl, { headers });
        const ordersData = await ordersResp.json();
        const rawOrders = ordersData?.orders?.order;
        const orders = rawOrders ? (Array.isArray(rawOrders) ? rawOrders : [rawOrders]) : [];
        
        // Find rejected orders
        rejectedOrderIds = orders
          .filter((o: any) => o.status === 'rejected' || o.status === 'canceled' || o.status === 'expired')
          .map((o: any) => String(o.id));
        
        console.log(`[cleanup_maps] Found ${rejectedOrderIds.length} rejected/canceled/expired orders`);
        
        // Delete mappings for rejected orders
        if (rejectedOrderIds.length > 0) {
          const { data: deletedRejected, error: rejectDelErr } = await supabase
            .from('position_group_map')
            .delete()
            .in('open_order_id', rejectedOrderIds)
            .select('id');
          
          if (rejectDelErr) {
            console.error('[cleanup_maps] Error deleting rejected mappings:', rejectDelErr);
          } else {
            rejectedMappingsDeleted = deletedRejected?.length || 0;
            if (rejectedMappingsDeleted > 0) {
              console.log(`[cleanup_maps] Deleted ${rejectedMappingsDeleted} mappings for rejected orders`);
            }
          }
        }
      } catch (err) {
        console.error('[cleanup_maps] Error fetching orders for rejection cleanup:', err);
      }
      
      // In aggressive mode: fetch ALL mappings; otherwise only older than 24h
      let staleMaps: any[] = [];
      let fetchErr: any = null;
      
      if (aggressive) {
        // AGGRESSIVE: Fetch ALL mappings for symbols NOT at broker
        // Include extra fields for exit detection logging
        const { data, error } = await supabase
          .from('position_group_map')
          .select('id, symbol, trade_group_id, created_at, underlying, strategy_type, strategy_name, leg_qty');
        staleMaps = data || [];
        fetchErr = error;
        console.log(`[cleanup_maps] AGGRESSIVE mode: checking ${staleMaps.length} total mappings`);
      } else {
        // NORMAL: Only mappings older than 24h
        // Include extra fields for exit detection logging
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await supabase
          .from('position_group_map')
          .select('id, symbol, trade_group_id, created_at, underlying, strategy_type, strategy_name, leg_qty')
          .lt('created_at', cutoff);
        staleMaps = data || [];
        fetchErr = error;
      }
      
      if (fetchErr) {
        console.error('[cleanup_maps] Error fetching maps:', fetchErr);
        return new Response(JSON.stringify({ 
          error: fetchErr.message,
          deletedCount: rejectedMappingsDeleted,
          activeSymbolsCount: activeSymbols.size,
          rejectedMappingsDeleted,
        }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      
      // Filter to only delete if symbol is NOT in broker positions
      const toDelete = staleMaps.filter((m: any) => !activeSymbols.has(m.symbol));
      
      // === MANUAL EXIT DETECTION: Log exit_detected evaluations for closed groups ===
      // Group toDelete mappings by trade_group_id to detect which trade groups were manually closed
      const closedGroupsMap = new Map<string, { symbols: string[]; underlying: string; strategyType?: string; strategyName?: string; legQtys: number[] }>();
      
      for (const m of toDelete) {
        if (!m.trade_group_id) continue;
        const existing = closedGroupsMap.get(m.trade_group_id);
        if (existing) {
          existing.symbols.push(m.symbol);
          existing.legQtys.push(m.leg_qty || 1);
        } else {
          closedGroupsMap.set(m.trade_group_id, {
            symbols: [m.symbol],
            underlying: m.underlying || extractUnderlyingFromOccSymbol(m.symbol) || 'UNKNOWN',
            strategyType: m.strategy_type,
            strategyName: m.strategy_name,
            legQtys: [m.leg_qty || 1],
          });
        }
      }
      
      // Fetch recent filled close orders from Tradier (last 30 minutes)
      let recentCloseOrders: any[] = [];
      if (closedGroupsMap.size > 0) {
        try {
          const ordersUrl = `${baseUrl}/accounts/${accountId}/orders`;
          const ordersResp = await fetch(ordersUrl, { headers });
          const ordersData = await ordersResp.json();
          const rawOrders = ordersData?.orders?.order;
          const allOrders = rawOrders ? (Array.isArray(rawOrders) ? rawOrders : [rawOrders]) : [];
          
          // Filter to filled closing orders in last 30 minutes
          const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
          recentCloseOrders = allOrders.filter((o: any) => {
            if (o.status !== 'filled') return false;
            const isCloseOrder = o.side === 'buy_to_close' || o.side === 'sell_to_close' || 
                                 (o.class === 'multileg' && o.leg?.some?.((l: any) => 
                                   l.side === 'buy_to_close' || l.side === 'sell_to_close'));
            if (!isCloseOrder) return false;
            const txDate = new Date(o.transaction_date || o.create_date).getTime();
            return txDate > thirtyMinAgo;
          });
          console.log(`[cleanup_maps] Found ${recentCloseOrders.length} recent close orders for exit detection`);
        } catch (orderErr) {
          console.error('[cleanup_maps] Error fetching recent orders for exit detection:', orderErr);
        }
      }
      
      // Log exit_detected evaluations for each closed group
      let exitEvaluationsLogged = 0;
      for (const [groupId, groupInfo] of closedGroupsMap) {
        try {
          // Find matching close order(s) by symbol
          const groupSymbolSet = new Set(groupInfo.symbols);
          let matchedOrders: any[] = [];
          let realizedPnl: number | null = null;
          let pnlBasis = 'unknown';
          
          for (const order of recentCloseOrders) {
            // Check single-leg order
            const orderSymbol = order.option_symbol || order.symbol;
            if (groupSymbolSet.has(orderSymbol)) {
              matchedOrders.push({
                symbol: orderSymbol,
                avg_fill_price: order.avg_fill_price,
                exec_quantity: order.exec_quantity || order.quantity,
                side: order.side,
              });
            }
            // Check multi-leg order
            if (order.leg && Array.isArray(order.leg)) {
              for (const leg of order.leg) {
                const legSymbol = leg.option_symbol || leg.symbol;
                if (groupSymbolSet.has(legSymbol)) {
                  matchedOrders.push({
                    symbol: legSymbol,
                    avg_fill_price: leg.avg_fill_price,
                    exec_quantity: leg.exec_quantity || leg.quantity,
                    side: leg.side,
                  });
                }
              }
            }
          }
          
          if (matchedOrders.length > 0) {
            pnlBasis = 'realized';
          }
          
          // Try to find strategy_id from existing evaluations for this group
          let strategyId: string | null = null;
          const { data: existingEval } = await supabase
            .from('strategy_evaluations')
            .select('strategy_id')
            .eq('trade_group_id', groupId)
            .limit(1)
            .single();
          
          if (existingEval?.strategy_id) {
            strategyId = existingEval.strategy_id;
          }
          
          // Get current time in ET
          const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
          
          // Insert exit_detected evaluation
          const evalPayload = {
            strategy_id: strategyId || groupId, // fallback to groupId if no strategy
            underlying: groupInfo.underlying,
            event_type: 'exit_detected',
            decision: 'CLOSE',
            reason: 'Manual close detected from broker',
            config_json: {
              strategy_type: groupInfo.strategyType,
              strategy_name: groupInfo.strategyName,
            },
            inputs_json: {
              market: {
                now_et: nowET,
                underlying_price: 0, // Unknown at cleanup time
                pnl_basis: pnlBasis,
                close_fills: matchedOrders.length > 0 ? matchedOrders : undefined,
              },
              account: {
                open_positions_count: activeSymbols.size,
                max_positions: 5,
              },
            },
            gates_json: [{
              name: 'broker_position_check',
              expected: 'positions exist',
              actual: 'no positions found for group symbols',
              pass: true,
              reason: `Symbols ${groupInfo.symbols.join(', ')} no longer at broker`,
            }],
            proposed_order_json: null,
            trade_group_id: groupId,
          };
          
          const { error: evalErr } = await supabase
            .from('strategy_evaluations')
            .insert(evalPayload);
          
          if (evalErr) {
            console.error(`[cleanup_maps] Error logging exit_detected for group ${groupId}:`, evalErr);
          } else {
            exitEvaluationsLogged++;
            console.log(`[cleanup_maps] Logged exit_detected for group ${groupId}: ${groupInfo.symbols.length} legs, pnl_basis=${pnlBasis}`);
          }
        } catch (evalError) {
          console.error(`[cleanup_maps] Error processing exit detection for group ${groupId}:`, evalError);
        }
      }
      
      // Now delete the mappings
      let deletedCount = 0;
      if (toDelete.length > 0) {
        const { error: deleteErr } = await supabase
          .from('position_group_map')
          .delete()
          .in('id', toDelete.map((m: any) => m.id));
        
        if (deleteErr) {
          console.error('[cleanup_maps] Delete error:', deleteErr);
        } else {
          deletedCount = toDelete.length;
          console.log(`[cleanup_maps] Deleted ${deletedCount} stale mappings (aggressive=${aggressive})`);
        }
      }
      
      return new Response(JSON.stringify({ 
        deletedCount: deletedCount + rejectedMappingsDeleted,
        activeSymbolsCount: activeSymbols.size,
        staleChecked: staleMaps.length,
        aggressive,
        rejectedMappingsDeleted,
        rejectedOrdersChecked: rejectedOrderIds.length,
        exitEvaluationsLogged,
        closedGroupsDetected: closedGroupsMap.size,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // === DELETE GROUP MAPPINGS (called after successful close) ===
    if (action === 'delete_group_mappings') {
      const { tradeGroupId } = body;
      
      if (!tradeGroupId) {
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Missing tradeGroupId',
          deletedCount: 0,
        }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      
      console.log(`[delete_group_mappings] Deleting mappings for group ${tradeGroupId}`);
      
      const { data: deleted, error: deleteErr } = await supabase
        .from('position_group_map')
        .delete()
        .eq('trade_group_id', tradeGroupId)
        .select('id');
      
      if (deleteErr) {
        console.error('[delete_group_mappings] Delete error:', deleteErr);
        return new Response(JSON.stringify({ 
          success: false, 
          error: deleteErr.message,
          deletedCount: 0,
        }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      
      const deletedCount = deleted?.length || 0;
      console.log(`[delete_group_mappings] Deleted ${deletedCount} mappings for group ${tradeGroupId}`);
      
      return new Response(JSON.stringify({ 
        success: true,
        deletedCount,
        tradeGroupId,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(
      JSON.stringify({ error: 'Invalid action' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in strategy-engine:', error);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

/**
 * Place order ONLY - no verification, no mapping persistence.
 * This is step 1 of the Verified Entry flow.
 * Returns immediately after broker accepts/rejects the order.
 */
async function placeOrderOnly(
  baseUrl: string, 
  accountId: string, 
  apiToken: string, 
  signal: any, 
  tradeGroupId: string
) {
  const orderUrl = `${baseUrl}/accounts/${accountId}/orders`;
  
  // For multi-leg orders, use combo order
  if (signal.legs.length > 1) {
    const legParams = signal.legs.map((leg: any, i: number) => ({
      [`option_symbol[${i}]`]: leg.symbol,
      [`side[${i}]`]: leg.side,
      [`quantity[${i}]`]: leg.quantity.toString(),
    })).reduce((acc: any, curr: any) => ({ ...acc, ...curr }), {});

    const orderBody = new URLSearchParams({
      class: 'multileg',
      symbol: signal.underlying,
      type: 'market',
      duration: 'day',
      ...legParams,
    }).toString();

    console.log('[placeOrderOnly] Placing multi-leg order:', orderBody);

    const response = await fetch(orderUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: orderBody,
    });

    const data = await response.json();
    console.log('[placeOrderOnly] Order response:', JSON.stringify(data));
    
    const orderId = data?.order?.id;
    const success = !!orderId;
    
    return {
      success,
      orderId,
      error: data?.errors?.error,
      signal,
    };
  }

  // Single leg order
  const leg = signal.legs[0];
  const response = await fetch(orderUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      class: 'option',
      symbol: signal.underlying,
      option_symbol: leg.symbol,
      side: leg.side,
      quantity: leg.quantity.toString(),
      type: 'market',
      duration: 'day',
    }).toString(),
  });

  const data = await response.json();
  const orderId = data?.order?.id;
  const success = !!orderId;
  
  return {
    success,
    orderId,
    error: data?.errors?.error,
    signal,
  };
}

/**
 * Persist symbol -> trade_group_id mapping when an entry order is placed.
 * This is the SOURCE OF TRUTH for position grouping.
 * Stores leg_qty and leg_side for deterministic stacking support.
 * 
 * CRITICAL: This should ONLY be called AFTER verify_fill confirms all legs are present.
 */
async function persistPositionGroupMap(
  supabaseClient: any,
  params: {
    tradeGroupId: string;
    openOrderId: string;
    underlying: string;
    expiration: string | null;
    strategyName: string | null;
    strategyType: string | null;
    legs: Array<{ symbol: string; quantity: number; side: string }>;
    entryCredit?: number; // NEW: in DOLLARS for whole group (computed from actual fills)
  }
): Promise<void> {
  const { tradeGroupId, openOrderId, underlying, expiration, strategyName, strategyType, legs, entryCredit } = params;
  
  const records = legs.map(leg => ({
    trade_group_id: tradeGroupId,
    open_order_id: openOrderId,
    symbol: leg.symbol,
    underlying,
    expiration,
    strategy_name: strategyName,
    strategy_type: strategyType,
    leg_qty: leg.quantity,
    leg_side: leg.side,
    entry_credit: entryCredit, // Same value for all legs in group (DOLLARS)
  }));
  
  try {
    // Insert each record - no upsert since same symbol can exist in multiple groups
    const { error } = await supabaseClient
      .from('position_group_map')
      .insert(records);
    
    if (error) {
      console.error('[persistPositionGroupMap] Error inserting:', error);
    } else {
      console.log(`[persistPositionGroupMap] Saved ${legs.length} leg mappings for order ${openOrderId}, group ${tradeGroupId}, entryCredit=$${entryCredit?.toFixed(2) || 'N/A'}`);
    }
  } catch (err) {
    console.error('[persistPositionGroupMap] Exception:', err);
  }
}