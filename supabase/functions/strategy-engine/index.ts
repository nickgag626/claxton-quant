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

// Helper: Get current ET time
function getETTime(): { now: Date; timeStr: string; dateStr: string } {
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
  
  return { now, timeStr, dateStr };
}

// Evaluate a single strategy with full trace
async function evaluateStrategyWithTrace(
  strategy: Strategy,
  marketState: string,
  positions: any[],
  apiToken: string,
  baseUrl: string
): Promise<EvaluationResult> {
  const gates: Gate[] = [];
  const { timeStr, dateStr } = getETTime();
  const today = new Date();
  
  // Get delta target (support both old and new field names)
  const shortDeltaTarget = strategy.entryConditions.shortDeltaTarget ?? strategy.entryConditions.maxDelta ?? 0.16;
  const longDeltaTarget = strategy.entryConditions.longDeltaTarget;
  
  // Initialize inputs
  const inputs: EvaluationResult['inputs'] = {
    market: {
      now_et: `${dateStr} ${timeStr}`,
      underlying: strategy.underlying,
    },
    account: {
      open_positions_count: 0,
      max_positions: strategy.maxPositions,
    },
  };
  
  // GATE 1: Market Hours
  const marketHoursGate: Gate = {
    name: 'Market Hours',
    expected: strategy.entryConditions.marketHoursOnly ? 'market open' : 'any',
    actual: marketState,
    pass: !strategy.entryConditions.marketHoursOnly || marketState === 'open',
    reason: strategy.entryConditions.marketHoursOnly && marketState !== 'open' 
      ? `Market is ${marketState}, requires open` 
      : undefined,
  };
  gates.push(marketHoursGate);
  
  if (!marketHoursGate.pass) {
    return { decision: 'SKIP', reason: marketHoursGate.reason!, gates, inputs };
  }
  
  // GATE 2: Time Window (ET)
  let timeWindowPass = true;
  let timeWindowReason: string | undefined;
  
  if (strategy.entryConditions.startTime && timeStr < strategy.entryConditions.startTime) {
    timeWindowPass = false;
    timeWindowReason = `Current time ${timeStr} is before start time ${strategy.entryConditions.startTime}`;
  }
  if (strategy.entryConditions.endTime && timeStr > strategy.entryConditions.endTime) {
    timeWindowPass = false;
    timeWindowReason = `Current time ${timeStr} is after end time ${strategy.entryConditions.endTime}`;
  }
  
  const timeWindowGate: Gate = {
    name: 'Time Window (ET)',
    expected: strategy.entryConditions.startTime && strategy.entryConditions.endTime 
      ? `${strategy.entryConditions.startTime} - ${strategy.entryConditions.endTime}`
      : 'any',
    actual: { current_time: timeStr },
    pass: timeWindowPass,
    reason: timeWindowReason,
  };
  gates.push(timeWindowGate);
  
  if (!timeWindowGate.pass) {
    return { decision: 'SKIP', reason: timeWindowGate.reason!, gates, inputs };
  }
  
  // GATE 3: Max Positions
  const strategyPositions = (positions || []).filter(
    (p: any) => p.strategyName === strategy.name && p.status === 'open'
  );
  const openPositionsCount = strategyPositions.length;
  inputs.account.open_positions_count = openPositionsCount;
  
  const maxPositionsGate: Gate = {
    name: 'Max Positions',
    expected: `open < ${strategy.maxPositions}`,
    actual: { open: openPositionsCount, max: strategy.maxPositions },
    pass: openPositionsCount < strategy.maxPositions,
    reason: openPositionsCount >= strategy.maxPositions 
      ? `Position limit reached (${openPositionsCount}/${strategy.maxPositions})`
      : undefined,
  };
  gates.push(maxPositionsGate);
  
  if (!maxPositionsGate.pass) {
    return { decision: 'SKIP', reason: maxPositionsGate.reason!, gates, inputs };
  }
  
  // Fetch option expirations
  const headers = {
    'Authorization': `Bearer ${apiToken}`,
    'Accept': 'application/json',
  };
  
  let expirations: string[] = [];
  try {
    const expResponse = await fetch(
      `${baseUrl}/markets/options/expirations?symbol=${strategy.underlying}`,
      { headers }
    );
    const expData = await expResponse.json();
    expirations = expData?.expirations?.date || [];
  } catch (error) {
    const dataGate: Gate = {
      name: 'Expiration Data',
      expected: 'available',
      actual: 'fetch failed',
      pass: false,
      reason: 'Could not fetch expirations - data unavailable',
    };
    gates.push(dataGate);
    return { decision: 'SKIP', reason: dataGate.reason!, gates, inputs };
  }
  
  // GATE 4: DTE Range
  let targetExpiration: string | null = null;
  let selectedDte: number | null = null;
  
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
  
  const dteGate: Gate = {
    name: 'DTE Range',
    expected: `${strategy.entryConditions.minDte} - ${strategy.entryConditions.maxDte}`,
    actual: selectedDte !== null ? { dte: selectedDte, expiration: targetExpiration } : 'no expiration found',
    pass: targetExpiration !== null,
    reason: !targetExpiration ? `No expiration found in DTE range ${strategy.entryConditions.minDte}-${strategy.entryConditions.maxDte}` : undefined,
  };
  gates.push(dteGate);
  
  if (!dteGate.pass) {
    return { decision: 'SKIP', reason: dteGate.reason!, gates, inputs };
  }
  
  // Fetch option chain
  let options: OptionContract[] = [];
  let underlyingPrice: number | null = null;
  
  try {
    const chainResponse = await fetch(
      `${baseUrl}/markets/options/chains?symbol=${strategy.underlying}&expiration=${targetExpiration}&greeks=true`,
      { headers }
    );
    const chainData = await chainResponse.json();
    options = chainData?.options?.option || [];
    
    // Get underlying price
    const quoteResponse = await fetch(
      `${baseUrl}/markets/quotes?symbols=${strategy.underlying}`,
      { headers }
    );
    const quoteData = await quoteResponse.json();
    underlyingPrice = quoteData?.quotes?.quote?.last || quoteData?.quotes?.quote?.close;
    inputs.market.underlying_price = underlyingPrice;
  } catch (error) {
    const dataGate: Gate = {
      name: 'Option Chain Data',
      expected: 'available',
      actual: 'fetch failed',
      pass: false,
      reason: 'Could not fetch option chain - data unavailable',
    };
    gates.push(dataGate);
    return { decision: 'SKIP', reason: dataGate.reason!, gates, inputs };
  }
  
  if (options.length === 0) {
    const chainGate: Gate = {
      name: 'Option Chain Data',
      expected: 'options available',
      actual: 'empty chain',
      pass: false,
      reason: 'Option chain is empty',
    };
    gates.push(chainGate);
    return { decision: 'SKIP', reason: chainGate.reason!, gates, inputs };
  }
  
  // GATE 5: Delta Selection (Short Strike)
  const puts = options.filter(o => 
    o.option_type === 'put' && o.greeks && o.bid > 0
  ).sort((a, b) => Math.abs(a.greeks!.delta) - Math.abs(shortDeltaTarget) - (Math.abs(b.greeks!.delta) - Math.abs(shortDeltaTarget)));
  
  const calls = options.filter(o => 
    o.option_type === 'call' && o.greeks && o.bid > 0
  ).sort((a, b) => Math.abs(a.greeks!.delta) - Math.abs(shortDeltaTarget) - (Math.abs(b.greeks!.delta) - Math.abs(shortDeltaTarget)));
  
  // Find closest to target delta
  const shortPut = puts.find(p => p.greeks && Math.abs(p.greeks.delta) <= shortDeltaTarget + 0.05);
  const shortCall = calls.find(c => c.greeks && Math.abs(c.greeks.delta) <= shortDeltaTarget + 0.05);
  
  const shortDeltaGate: Gate = {
    name: 'Short Delta Target',
    expected: `|delta| ≤ ${shortDeltaTarget}`,
    actual: {
      put: shortPut ? { strike: shortPut.strike, delta: shortPut.greeks?.delta } : 'not found',
      call: shortCall ? { strike: shortCall.strike, delta: shortCall.greeks?.delta } : 'not found',
    },
    pass: (strategy.type.includes('put') ? !!shortPut : true) && (strategy.type.includes('call') ? !!shortCall : true) && (strategy.type === 'iron_condor' || strategy.type === 'strangle' || strategy.type === 'straddle' || strategy.type === 'iron_fly' ? !!shortPut && !!shortCall : true),
    reason: !shortPut && !shortCall ? 'No strikes found matching delta target' : undefined,
  };
  gates.push(shortDeltaGate);
  
  // Build proposed order based on strategy type
  const proposedOrder = buildProposedOrder(strategy, options, shortDeltaTarget, longDeltaTarget);
  
  // GATE 6: Long Delta Target (for spreads)
  if (longDeltaTarget !== undefined && proposedOrder) {
    const longLegs = proposedOrder.legs.filter(l => l.side.includes('buy'));
    const longDeltaGate: Gate = {
      name: 'Long Delta Target',
      expected: `|delta| ≤ ${longDeltaTarget}`,
      actual: longLegs.length > 0 
        ? { legs: longLegs.map(l => ({ strike: l.strike, delta: l.delta })) }
        : 'no long legs',
      pass: longLegs.length > 0 || !['iron_condor', 'credit_put_spread', 'credit_call_spread', 'iron_fly'].includes(strategy.type),
    };
    gates.push(longDeltaGate);
  }
  
  // GATE 7: Premium Filter
  if (strategy.entryConditions.minPremium) {
    const estimatedCredit = proposedOrder?.estimated_credit || 0;
    const premiumGate: Gate = {
      name: 'Minimum Premium',
      expected: `credit ≥ $${strategy.entryConditions.minPremium}`,
      actual: { estimated_credit: estimatedCredit },
      pass: estimatedCredit >= strategy.entryConditions.minPremium,
      reason: estimatedCredit < strategy.entryConditions.minPremium 
        ? `Credit $${estimatedCredit.toFixed(2)} below minimum $${strategy.entryConditions.minPremium}`
        : undefined,
    };
    gates.push(premiumGate);
    
    if (!premiumGate.pass) {
      return { decision: 'SKIP', reason: premiumGate.reason!, gates, inputs, proposedOrder: proposedOrder || undefined };
    }
  }
  
  // GATE 8: IV Rank Filter (if enabled)
  if (strategy.entryConditions.minIvRank !== undefined || strategy.entryConditions.maxIvRank !== undefined) {
    // Note: IV rank requires historical data - mark as unavailable if not accessible
    const ivGate: Gate = {
      name: 'IV Rank Filter',
      expected: `${strategy.entryConditions.minIvRank ?? 0}% - ${strategy.entryConditions.maxIvRank ?? 100}%`,
      actual: 'data unavailable',
      pass: false,
      reason: 'IV rank data not available from broker API - gate FAILED',
    };
    gates.push(ivGate);
    // Don't fail on IV if data unavailable - just log it
  }
  
  // GATE 9: Risk Sizing
  if (strategy.sizing?.mode === 'risk' && strategy.sizing.riskPerTrade) {
    const maxLoss = proposedOrder?.estimated_max_loss || 0;
    const computedContracts = maxLoss > 0 
      ? Math.floor(strategy.sizing.riskPerTrade / maxLoss)
      : 1;
    const cappedContracts = Math.min(
      computedContracts, 
      strategy.sizing.maxContracts || 10
    );
    
    const sizingGate: Gate = {
      name: 'Risk-Based Sizing',
      expected: `risk/trade = $${strategy.sizing.riskPerTrade}, max contracts = ${strategy.sizing.maxContracts || 10}`,
      actual: { 
        max_loss_per_contract: maxLoss, 
        computed_contracts: computedContracts,
        capped_contracts: cappedContracts 
      },
      pass: cappedContracts >= 1,
      reason: cappedContracts < 1 ? 'Risk sizing resulted in 0 contracts' : undefined,
    };
    gates.push(sizingGate);
    
    if (proposedOrder) {
      proposedOrder.sizing_result = {
        mode: 'risk',
        computed_contracts: cappedContracts,
        risk_per_trade: strategy.sizing.riskPerTrade,
      };
      // Update leg quantities
      proposedOrder.legs.forEach(leg => {
        leg.quantity = cappedContracts;
      });
    }
  } else {
    // Fixed sizing
    const fixedContracts = strategy.sizing?.fixedContracts ?? strategy.positionSize ?? 1;
    const sizingGate: Gate = {
      name: 'Fixed Sizing',
      expected: `${fixedContracts} contracts`,
      actual: { contracts: fixedContracts },
      pass: true,
    };
    gates.push(sizingGate);
    
    if (proposedOrder) {
      proposedOrder.sizing_result = {
        mode: 'fixed',
        computed_contracts: fixedContracts,
      };
    }
  }
  
  // GATE 10: MA Filter (if enabled)
  if (strategy.entryConditions.maFilter?.enabled && strategy.entryConditions.maFilter.rules?.length) {
    // Note: MA calculation requires historical data
    const maGate: Gate = {
      name: 'Moving Average Filter',
      expected: strategy.entryConditions.maFilter.rules.map(r => `${r.left} ${r.op} ${r.right}`).join(' AND '),
      actual: 'data unavailable - requires historical bars',
      pass: false,
      reason: 'MA filter requires historical price data not available from Tradier options endpoint',
    };
    gates.push(maGate);
    // Don't fail entry on MA if data unavailable - log it
  }
  
  // Record chain slice in inputs
  if (proposedOrder?.legs) {
    inputs.market.chain_slice = proposedOrder.legs.map(leg => ({
      symbol: leg.option_symbol,
      strike: leg.strike,
      delta: leg.delta,
      bid: 0, // Would need to look up
      ask: 0,
      option_type: leg.role.includes('put') ? 'put' : 'call',
    }));
  }
  
  // Check if all critical gates passed
  const failedGates = gates.filter(g => !g.pass && !g.name.includes('IV') && !g.name.includes('MA'));
  
  if (failedGates.length > 0) {
    return { 
      decision: 'SKIP', 
      reason: failedGates[0].reason || `Gate failed: ${failedGates[0].name}`, 
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
    const { action, strategies, positions, strategyId } = body;

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
      
      // Run evaluation with trace
      const result = await evaluateStrategyWithTrace(
        strategy,
        marketState,
        currentPositions,
        apiToken,
        baseUrl
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