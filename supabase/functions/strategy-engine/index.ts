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
  };
  sizing?: {
    mode: 'fixed' | 'risk';
    fixedContracts?: number;
    riskPerTrade?: number;
    maxContracts?: number;
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
      if (computedContracts < 1) {
        sizingPass = false;
        sizingReason = 'Risk sizing resulted in 0 contracts';
      }
    }
  } else if (hardStop) {
    sizingPass = false;
    sizingReason = `skipped_due_to_${hardStopReason}`;
  }
  
  const sizingGate: Gate = {
    name: 'Risk Sizing',
    expected: strategy.sizing?.mode === 'risk' 
      ? `risk/trade = $${strategy.sizing.riskPerTrade}, max = ${strategy.sizing.maxContracts || 10}`
      : `fixed = ${strategy.sizing?.fixedContracts ?? strategy.positionSize ?? 1}`,
    actual: {
      mode: strategy.sizing?.mode || 'fixed',
      computed_contracts: computedContracts,
      riskPerTrade: strategy.sizing?.riskPerTrade || null,
      maxContracts: strategy.sizing?.maxContracts || null,
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
  
  const findByDelta = (opts: OptionContract[], targetDelta: number, above = false) => {
    return opts.find(o => {
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
      // Find base strikes via delta targeting
      const baseShortPut = findByDelta(puts, shortDeltaTarget);
      const baseLongPut = findByDelta(puts, effectiveLongDelta);
      const baseShortCall = findByDelta(calls, shortDeltaTarget);
      const baseLongCall = findByDelta(calls, effectiveLongDelta);
      
      if (!baseShortPut || !baseLongPut || !baseShortCall || !baseLongCall) return null;
      
      // Initialize jitter result
      const strikeStep = computeStrikeStep(options);
      const existingCondors = jitterConfig?.existingCondors ?? 0;
      
      jitterResult = {
        applied: false,
        existingCondors,
        strikeStep,
        offset: 0,
        jitterSize: 0,
        originalStrikes: {
          shortPut: baseShortPut.strike,
          longPut: baseLongPut.strike,
          shortCall: baseShortCall.strike,
          longCall: baseLongCall.strike,
        },
        shiftedStrikes: {
          shortPut: baseShortPut.strike,
          longPut: baseLongPut.strike,
          shortCall: baseShortCall.strike,
          longCall: baseLongCall.strike,
        },
        allUnique: true,
        allExistInChain: true,
      };
      
      // Apply strike jitter if there are existing condors
      let shortPut = baseShortPut;
      let longPut = baseLongPut;
      let shortCall = baseShortCall;
      let longCall = baseLongCall;
      
      if (existingCondors > 0) {
        // Try jitterSize = 1, then 2
        for (const jitterSize of [1, 2]) {
          const offset = existingCondors * strikeStep * jitterSize;
          
          // Symmetric jitter: puts move DOWN, calls move UP
          const newShortPutStrike = baseShortPut.strike - offset;
          const newLongPutStrike = baseLongPut.strike - offset;
          const newShortCallStrike = baseShortCall.strike + offset;
          const newLongCallStrike = baseLongCall.strike + offset;
          
          // Find options at shifted strikes
          const shiftedShortPut = findByStrike('put', newShortPutStrike);
          const shiftedLongPut = findByStrike('put', newLongPutStrike);
          const shiftedShortCall = findByStrike('call', newShortCallStrike);
          const shiftedLongCall = findByStrike('call', newLongCallStrike);
          
          // Check all shifted strikes exist in chain
          const allExist = !!(shiftedShortPut && shiftedLongPut && shiftedShortCall && shiftedLongCall);
          
          // Check all symbols are unique (no conflicts with existing positions)
          const symbols = [
            shiftedShortPut?.symbol,
            shiftedLongPut?.symbol,
            shiftedShortCall?.symbol,
            shiftedLongCall?.symbol,
          ].filter(Boolean) as string[];
          
          const hasSymbolConflict = symbols.some(s => symbolConflicts(s));
          const allUnique = new Set(symbols).size === 4 && !hasSymbolConflict;
          
          jitterResult = {
            applied: true,
            existingCondors,
            strikeStep,
            offset,
            jitterSize,
            originalStrikes: {
              shortPut: baseShortPut.strike,
              longPut: baseLongPut.strike,
              shortCall: baseShortCall.strike,
              longCall: baseLongCall.strike,
            },
            shiftedStrikes: {
              shortPut: newShortPutStrike,
              longPut: newLongPutStrike,
              shortCall: newShortCallStrike,
              longCall: newLongCallStrike,
            },
            allUnique,
            allExistInChain: allExist,
          };
          
          if (allExist && allUnique) {
            // Success! Use shifted strikes
            shortPut = shiftedShortPut!;
            longPut = shiftedLongPut!;
            shortCall = shiftedShortCall!;
            longCall = shiftedLongCall!;
            console.log(`[JITTER] Applied jitterSize=${jitterSize}, offset=${offset} for condor #${existingCondors + 1}`);
            break;
          } else {
            console.log(`[JITTER] jitterSize=${jitterSize} failed: allExist=${allExist}, allUnique=${allUnique}`);
            if (jitterSize === 2) {
              // Both jitter sizes failed - return null to block entry
              console.log(`[JITTER] All jitter attempts failed for ${strategy.underlying}, blocking entry`);
              return null;
            }
          }
        }
      } else {
        // No existing condors - still check for symbol conflicts with base strikes
        const baseSymbols = [shortPut.symbol, longPut.symbol, shortCall.symbol, longCall.symbol];
        const hasConflict = baseSymbols.some(s => symbolConflicts(s));
        if (hasConflict) {
          console.log(`[JITTER] Base strikes conflict with existing positions, attempting jitter`);
          // Recursively try with existingCondors = 1 to force jitter
          return buildProposedOrder(strategy, options, shortDeltaTarget, longDeltaTarget, {
            ...jitterConfig!,
            existingCondors: 1,
          });
        }
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
      const longPut = findByDelta(puts, effectiveLongDelta);
      
      if (!shortPut || !longPut) return null;
      
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
      const longCall = findByDelta(calls, effectiveLongDelta);
      
      if (!shortCall || !longCall) return null;
      
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
      
      while (Date.now() - startTime < VERIFICATION_TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, VERIFICATION_POLL_INTERVAL_MS));
        
        // Check order status
        try {
          const orderStatusUrl = `${baseUrl}/accounts/${accountId}/orders/${orderResponse.orderId}`;
          const statusResponse = await fetch(orderStatusUrl, { headers });
          const statusData = await statusResponse.json();
          orderStatus = statusData?.order?.status?.toLowerCase() || 'unknown';
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
      // Check if any positions should be closed
      // CRITICAL: Return group-level exit signals, not per-leg
      const exitSignals: any[] = [];
      
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
          
          continue; // Skip this group - don't generate exit signal
        }
        
        // Calculate aggregate P&L for the group
        let totalCostBasis = 0;
        let totalCurrentValue = 0;
        
        for (const leg of groupLegs) {
          totalCostBasis += Number(leg.costBasis ?? 0);
          totalCurrentValue += Number(leg.currentValue ?? 0);
        }
        
        const isShort = totalCostBasis < 0;
        const pnl = isShort ? Math.abs(totalCostBasis) - totalCurrentValue : totalCurrentValue - totalCostBasis;
        const pnlPercent = Math.abs(totalCostBasis) > 0 ? (pnl / Math.abs(totalCostBasis)) * 100 : 0;
        
        let exitReason: string | null = null;
        
        // Check profit target
        if (pnlPercent >= strategy.exitConditions.profitTargetPercent) {
          exitReason = 'profit_target';
        }
        // Check stop loss
        else if (pnlPercent <= -strategy.exitConditions.stopLossPercent) {
          exitReason = 'stop_loss';
        }
        // Check time stop (use earliest expiration in group)
        else if (strategy.exitConditions.timeStopDte) {
          let earliestDte = Infinity;
          for (const leg of groupLegs) {
            if (leg.expirationDate) {
              const expDate = new Date(leg.expirationDate);
              const dte = Math.ceil((expDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
              earliestDte = Math.min(earliestDte, dte);
            }
          }
          if (earliestDte <= strategy.exitConditions.timeStopDte) {
            exitReason = 'time_stop';
          }
        }
        
        if (exitReason) {
          // Save exit_attempt evaluation
          if (strategy.id) {
            await saveEvaluation(
              supabase,
              strategy.id,
              firstLeg.underlying || strategy.underlying,
              'exit_attempt',
              {
                decision: 'CLOSE',
                reason: `Group exit triggered: ${exitReason} (P&L: ${pnlPercent.toFixed(2)}%)`,
                gates: [{
                  name: exitReason,
                  expected: exitReason === 'profit_target' 
                    ? `P&L >= ${strategy.exitConditions.profitTargetPercent}%`
                    : exitReason === 'stop_loss'
                    ? `P&L <= -${strategy.exitConditions.stopLossPercent}%`
                    : `DTE <= ${strategy.exitConditions.timeStopDte}`,
                  actual: { pnl_percent: pnlPercent, legs: observedLegs },
                  pass: true,
                }],
                inputs: { 
                  market: { 
                    pnl_percent: pnlPercent, 
                    total_cost_basis: totalCostBasis, 
                    total_current_value: totalCurrentValue,
                    leg_count: observedLegs,
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
        
        let exitReason: string | null = null;
        
        // Check profit target
        if (pnlPercent >= strategy.exitConditions.profitTargetPercent) {
          exitReason = 'profit_target';
        }
        // Check stop loss
        else if (pnlPercent <= -strategy.exitConditions.stopLossPercent) {
          exitReason = 'stop_loss';
        }
        // Check time stop
        else if (strategy.exitConditions.timeStopDte && position.expirationDate) {
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
        JSON.stringify({ exitSignals, marketState }),
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
        // SUCCESS: Persist the mapping NOW
        await persistPositionGroupMap(supabase, {
          tradeGroupId,
          openOrderId: String(orderId),
          underlying,
          expiration: expiration || null,
          strategyName: strategyName || null,
          strategyType: strategyType || null,
          legs: expectedLegs,
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
        const { data, error } = await supabase
          .from('position_group_map')
          .select('id, symbol, trade_group_id, created_at');
        staleMaps = data || [];
        fetchErr = error;
        console.log(`[cleanup_maps] AGGRESSIVE mode: checking ${staleMaps.length} total mappings`);
      } else {
        // NORMAL: Only mappings older than 24h
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await supabase
          .from('position_group_map')
          .select('id, symbol, trade_group_id, created_at')
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
  }
): Promise<void> {
  const { tradeGroupId, openOrderId, underlying, expiration, strategyName, strategyType, legs } = params;
  
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
  }));
  
  try {
    // Insert each record - no upsert since same symbol can exist in multiple groups
    const { error } = await supabaseClient
      .from('position_group_map')
      .insert(records);
    
    if (error) {
      console.error('[persistPositionGroupMap] Error inserting:', error);
    } else {
      console.log(`[persistPositionGroupMap] Saved ${legs.length} leg mappings for order ${openOrderId}, group ${tradeGroupId}`);
    }
  } catch (err) {
    console.error('[persistPositionGroupMap] Exception:', err);
  }
}