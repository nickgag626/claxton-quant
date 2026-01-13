import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
  };
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
  evalOptions?: { overrideMarketStatus?: string }
): Promise<EvaluationResult> {
  const gates: Gate[] = [];
  const { timeStr, dateStr, isoET, utcIso } = getETTime();
  const today = new Date();
  
  // Determine effective market state (support override for testing)
  const effectiveMarketState = evalOptions?.overrideMarketStatus || marketState;
  const isMarketOverridden = !!evalOptions?.overrideMarketStatus;
  
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
      now_et: `${dateStr} ${timeStr}`,
      now_et_iso: isoET,
      now_utc_iso: utcIso,
      underlying: strategy.underlying,
      clock_source: 'tradier_clock',
      clock_state_raw: marketState,
      clock_state_effective: effectiveMarketState,
      market_override_applied: isMarketOverridden,
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
    if (strategy.entryConditions.startTime && timeStr < strategy.entryConditions.startTime) {
      timeWindowPass = false;
      timeWindowReason = `Current time ${timeStr} is before start time ${strategy.entryConditions.startTime}`;
    }
    if (strategy.entryConditions.endTime && timeStr > strategy.entryConditions.endTime) {
      timeWindowPass = false;
      timeWindowReason = `Current time ${timeStr} is after end time ${strategy.entryConditions.endTime}`;
    }
  }
  
  const timeWindowGate: Gate = {
    name: 'Time Window (ET)',
    expected: strategy.entryConditions.startTime && strategy.entryConditions.endTime 
      ? `${strategy.entryConditions.startTime} - ${strategy.entryConditions.endTime}`
      : 'any',
    actual: { current_time: timeStr, startTime: strategy.entryConditions.startTime, endTime: strategy.entryConditions.endTime },
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
  
  // Fetch option data (only if not hard stopped)
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
  
  if (!hardStop) {
    try {
      const expResponse = await fetch(
        `${baseUrl}/markets/options/expirations?symbol=${strategy.underlying}`,
        { headers }
      );
      const expData = await expResponse.json();
      expirations = expData?.expirations?.date || [];
    } catch (error) {
      dataFetchError = true;
    }
    
    // Find target expiration
    const today = new Date();
    for (const exp of expirations) {
      const expDate = new Date(exp);
      const dte = Math.ceil((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      if (dte >= strategy.entryConditions.minDte && dte <= strategy.entryConditions.maxDte) {
        targetExpiration = exp;
        selectedDte = dte;
        break;
      }
    }
    
    inputs.market.dte_selected = selectedDte;
    inputs.market.expiration_selected = targetExpiration;
    
    // Fetch option chain if we have an expiration
    if (targetExpiration) {
      try {
        const chainResponse = await fetch(
          `${baseUrl}/markets/options/chains?symbol=${strategy.underlying}&expiration=${targetExpiration}&greeks=true`,
          { headers }
        );
        const chainData = await chainResponse.json();
        optionChain = chainData?.options?.option || [];
        
        // Get underlying price
        const quoteResponse = await fetch(
          `${baseUrl}/markets/quotes?symbols=${strategy.underlying}`,
          { headers }
        );
        const quoteData = await quoteResponse.json();
        underlyingPrice = quoteData?.quotes?.quote?.last || quoteData?.quotes?.quote?.close;
        inputs.market.underlying_price = underlyingPrice;
      } catch (error) {
        dataFetchError = true;
      }
    }
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
  
  // Build proposed order based on strategy type (even if we won't use it)
  const proposedOrder = !hardStop && optionChain.length > 0 
    ? buildProposedOrder(strategy, optionChain, shortDeltaTarget, longDeltaTarget)
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
  longDeltaTarget?: number
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
  
  switch (strategy.type) {
    case 'iron_condor':
    case 'iron_fly': {
      const shortPut = findByDelta(puts, shortDeltaTarget);
      const longPut = findByDelta(puts, effectiveLongDelta);
      const shortCall = findByDelta(calls, shortDeltaTarget);
      const longCall = findByDelta(calls, effectiveLongDelta);
      
      if (!shortPut || !longPut || !shortCall || !longCall) return null;
      
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
    const { action, strategies, positions, strategyId, overrideMarketStatus } = body;

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
      const evalOptions = overrideMarketStatus ? { overrideMarketStatus } : undefined;
      const result = await evaluateStrategyWithTrace(
        strategy,
        marketState,
        currentPositions,
        apiToken,
        baseUrl,
        evalOptions
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
          baseUrl
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
      // Execute a trade signal
      const { signal, tradeGroupId } = body;
      
      if (!signal || !signal.legs) {
        return new Response(
          JSON.stringify({ error: 'Invalid signal' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Generate trade_group_id if not provided
      const effectiveTradeGroupId = tradeGroupId || crypto.randomUUID();

      // Save entry_attempt evaluation with trade_group_id
      if (signal.strategyId) {
        await saveEvaluation(
          supabase,
          signal.strategyId,
          signal.underlying,
          'entry_attempt',
          {
            decision: 'OPEN',
            reason: 'Executing entry order',
            gates: [],
            inputs: { market: {}, account: {} },
            proposedOrder: signal.proposedOrder,
          },
          { signal },
          effectiveTradeGroupId
        );
      }

      const orderResponse = await placeOrder(baseUrl, accountId, apiToken, signal);
      
      // Save entry_submitted or entry_rejected based on result
      if (signal.strategyId) {
        await saveEvaluation(
          supabase,
          signal.strategyId,
          signal.underlying,
          orderResponse.success ? 'entry_submitted' : 'exit_rejected',
          {
            decision: orderResponse.success ? 'OPEN' : 'FAIL',
            reason: orderResponse.success ? `Order submitted: ${orderResponse.orderId}` : orderResponse.error || 'Order failed',
            gates: [],
            inputs: { market: {}, account: {} },
            proposedOrder: { ...signal.proposedOrder, order_id: orderResponse.orderId },
          },
          { signal, orderResponse },
          effectiveTradeGroupId
        );
      }
      
      return new Response(
        JSON.stringify({ ...orderResponse, tradeGroupId: effectiveTradeGroupId }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'check_exits') {
      // Check if any positions should be closed
      const exitSignals: any[] = [];
      
      for (const position of positions || []) {
        if (position.status !== 'open' || !position.strategyName) continue;
        
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
          // Save exit_attempt evaluation with trade_group_id
          if (position.tradeGroupId && strategy.id) {
            await saveEvaluation(
              supabase,
              strategy.id,
              position.underlying || strategy.underlying,
              'exit_attempt',
              {
                decision: 'CLOSE',
                reason: `Exit triggered: ${exitReason} (P&L: ${pnlPercent.toFixed(2)}%)`,
                gates: [{
                  name: exitReason,
                  expected: exitReason === 'profit_target' 
                    ? `P&L >= ${strategy.exitConditions.profitTargetPercent}%`
                    : exitReason === 'stop_loss'
                    ? `P&L <= -${strategy.exitConditions.stopLossPercent}%`
                    : `DTE <= ${strategy.exitConditions.timeStopDte}`,
                  actual: { pnl_percent: pnlPercent },
                  pass: true,
                }],
                inputs: { 
                  market: { pnl_percent: pnlPercent, cost_basis: costBasis, current_value: currentValue }, 
                  account: {} 
                },
              },
              { position, exitReason },
              position.tradeGroupId
            );
          }
          
          exitSignals.push({
            positionId: position.id,
            symbol: position.symbol,
            quantity: position.quantity,
            reason: exitReason,
            pnlPercent,
            tradeGroupId: position.tradeGroupId,
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

async function placeOrder(baseUrl: string, accountId: string, apiToken: string, signal: any) {
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

    console.log('Placing multi-leg order:', orderBody);

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
    console.log('Order response:', JSON.stringify(data));
    
    return {
      success: !!data?.order?.id,
      orderId: data?.order?.id,
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
  return {
    success: !!data?.order?.id,
    orderId: data?.order?.id,
    error: data?.errors?.error,
    signal,
  };
}