/**
 * Leg Side Inference from Option Symbols
 * 
 * Infers open_side (sell_to_open / buy_to_open) for multi-leg strategies
 * based on option symbol strikes, without relying on position_group_map.
 * 
 * Iron Condor structure:
 * - Calls: lower strike = sell, higher strike = buy (short call spread)
 * - Puts: higher strike = sell, lower strike = buy (short put spread)
 */

export interface LegInfo {
  symbol: string;
  entryPrice: number;
  exitPrice?: number;
}

export interface InferredLeg extends LegInfo {
  openSide: 'sell_to_open' | 'buy_to_open';
  closeSide: 'buy_to_close' | 'sell_to_close';
  optionType: 'C' | 'P';
  strike: number;
}

export interface InferenceResult {
  success: boolean;
  legs: InferredLeg[];
  netEntryCredit: number;
  netExitDebit?: number; // Computed from exit prices if available
  error?: string;
}

/**
 * Compute net exit debit from inferred leg sides and exit prices
 * For shorts (sell_to_open): closing = buy_to_close, contributes +exitPrice
 * For longs (buy_to_open): closing = sell_to_close, contributes -exitPrice
 */
export function computeNetExitDebit(inferredLegs: InferredLeg[]): number | null {
  if (inferredLegs.some(l => l.exitPrice == null)) return null;
  
  let netDebit = 0;
  for (const leg of inferredLegs) {
    const exitPrice = leg.exitPrice!;
    if (leg.openSide === 'sell_to_open') {
      // Short leg: buy_to_close = pay debit
      netDebit += exitPrice;
    } else {
      // Long leg: sell_to_close = receive credit (reduces net debit)
      netDebit -= exitPrice;
    }
  }
  return netDebit;
}

/**
 * Parse an OCC option symbol to extract components
 * Format: ROOT + YYMMDD + C/P + 8-digit strike (strike * 1000)
 * Example: SPY260115C00693000 -> SPY, 2026-01-15, C, 693.00
 */
export function parseOptionSymbol(symbol: string): { root: string; expiry: string; optionType: 'C' | 'P'; strike: number } | null {
  // OCC format: ROOT (variable) + 6 digits (YYMMDD) + C/P + 8 digits (strike * 1000)
  const match = symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  
  const [, root, expiry, optionType, strikeStr] = match;
  const strike = parseInt(strikeStr, 10) / 1000;
  
  return {
    root,
    expiry,
    optionType: optionType as 'C' | 'P',
    strike,
  };
}

/**
 * Infer leg sides for an Iron Condor based on strikes
 * 
 * Iron Condor has 4 legs:
 * - Short Call Spread: sell lower strike call, buy higher strike call
 * - Short Put Spread: sell higher strike put, buy lower strike put
 * 
 * Net Entry Credit = sum(sell leg entry prices) - sum(buy leg entry prices)
 */
export function inferIronCondorLegs(legs: LegInfo[]): InferenceResult {
  if (legs.length !== 4) {
    return { success: false, legs: [], netEntryCredit: 0, error: `Expected 4 legs for iron condor, got ${legs.length}` };
  }
  
  // Parse all leg symbols
  const parsedLegs = legs.map(leg => {
    const parsed = parseOptionSymbol(leg.symbol);
    if (!parsed) return null;
    return { ...leg, ...parsed };
  });
  
  if (parsedLegs.some(l => l === null)) {
    return { success: false, legs: [], netEntryCredit: 0, error: 'Could not parse all leg symbols' };
  }
  
  const validLegs = parsedLegs as NonNullable<typeof parsedLegs[0]>[];
  
  // Separate calls and puts
  const calls = validLegs.filter(l => l.optionType === 'C');
  const puts = validLegs.filter(l => l.optionType === 'P');
  
  if (calls.length !== 2 || puts.length !== 2) {
    return { success: false, legs: [], netEntryCredit: 0, error: `Expected 2 calls and 2 puts, got ${calls.length} calls and ${puts.length} puts` };
  }
  
  // Sort by strike
  calls.sort((a, b) => a.strike - b.strike);
  puts.sort((a, b) => a.strike - b.strike);
  
  // Infer sides based on iron condor structure:
  // Calls: lower strike = sell, higher strike = buy
  // Puts: higher strike = sell, lower strike = buy
  const inferredLegs: InferredLeg[] = [];
  let totalSellEntry = 0;
  let totalBuyEntry = 0;
  
  // Lower call = sell
  inferredLegs.push({
    symbol: calls[0].symbol,
    entryPrice: calls[0].entryPrice,
    exitPrice: calls[0].exitPrice,
    openSide: 'sell_to_open',
    closeSide: 'buy_to_close',
    optionType: 'C',
    strike: calls[0].strike,
  });
  totalSellEntry += calls[0].entryPrice;
  
  // Higher call = buy
  inferredLegs.push({
    symbol: calls[1].symbol,
    entryPrice: calls[1].entryPrice,
    exitPrice: calls[1].exitPrice,
    openSide: 'buy_to_open',
    closeSide: 'sell_to_close',
    optionType: 'C',
    strike: calls[1].strike,
  });
  totalBuyEntry += calls[1].entryPrice;
  
  // Lower put = buy
  inferredLegs.push({
    symbol: puts[0].symbol,
    entryPrice: puts[0].entryPrice,
    exitPrice: puts[0].exitPrice,
    openSide: 'buy_to_open',
    closeSide: 'sell_to_close',
    optionType: 'P',
    strike: puts[0].strike,
  });
  totalBuyEntry += puts[0].entryPrice;
  
  // Higher put = sell
  inferredLegs.push({
    symbol: puts[1].symbol,
    entryPrice: puts[1].entryPrice,
    exitPrice: puts[1].exitPrice,
    openSide: 'sell_to_open',
    closeSide: 'buy_to_close',
    optionType: 'P',
    strike: puts[1].strike,
  });
  totalSellEntry += puts[1].entryPrice;
  
  // Net entry credit = what we received - what we paid
  const netEntryCredit = totalSellEntry - totalBuyEntry;
  
  // Compute net exit debit if exit prices are available
  const netExitDebit = computeNetExitDebit(inferredLegs);
  
  return {
    success: true,
    legs: inferredLegs,
    netEntryCredit,
    netExitDebit: netExitDebit ?? undefined,
  };
}

/**
 * Infer leg sides for a credit spread (put or call spread)
 * 
 * Credit Put Spread: sell higher strike put, buy lower strike put
 * Credit Call Spread: sell lower strike call, buy higher strike call
 */
export function inferCreditSpreadLegs(legs: LegInfo[], spreadType: 'put' | 'call'): InferenceResult {
  if (legs.length !== 2) {
    return { success: false, legs: [], netEntryCredit: 0, error: `Expected 2 legs for credit spread, got ${legs.length}` };
  }
  
  const parsedLegs = legs.map(leg => {
    const parsed = parseOptionSymbol(leg.symbol);
    if (!parsed) return null;
    return { ...leg, ...parsed };
  });
  
  if (parsedLegs.some(l => l === null)) {
    return { success: false, legs: [], netEntryCredit: 0, error: 'Could not parse all leg symbols' };
  }
  
  const validLegs = parsedLegs as NonNullable<typeof parsedLegs[0]>[];
  validLegs.sort((a, b) => a.strike - b.strike);
  
  const inferredLegs: InferredLeg[] = [];
  let totalSellEntry = 0;
  let totalBuyEntry = 0;
  
  if (spreadType === 'call') {
    // Credit call spread: sell lower, buy higher
    inferredLegs.push({
      symbol: validLegs[0].symbol,
      entryPrice: validLegs[0].entryPrice,
      exitPrice: validLegs[0].exitPrice,
      openSide: 'sell_to_open',
      closeSide: 'buy_to_close',
      optionType: validLegs[0].optionType,
      strike: validLegs[0].strike,
    });
    totalSellEntry += validLegs[0].entryPrice;
    
    inferredLegs.push({
      symbol: validLegs[1].symbol,
      entryPrice: validLegs[1].entryPrice,
      exitPrice: validLegs[1].exitPrice,
      openSide: 'buy_to_open',
      closeSide: 'sell_to_close',
      optionType: validLegs[1].optionType,
      strike: validLegs[1].strike,
    });
    totalBuyEntry += validLegs[1].entryPrice;
  } else {
    // Credit put spread: sell higher, buy lower
    inferredLegs.push({
      symbol: validLegs[0].symbol,
      entryPrice: validLegs[0].entryPrice,
      exitPrice: validLegs[0].exitPrice,
      openSide: 'buy_to_open',
      closeSide: 'sell_to_close',
      optionType: validLegs[0].optionType,
      strike: validLegs[0].strike,
    });
    totalBuyEntry += validLegs[0].entryPrice;
    
    inferredLegs.push({
      symbol: validLegs[1].symbol,
      entryPrice: validLegs[1].entryPrice,
      exitPrice: validLegs[1].exitPrice,
      openSide: 'sell_to_open',
      closeSide: 'buy_to_close',
      optionType: validLegs[1].optionType,
      strike: validLegs[1].strike,
    });
    totalSellEntry += validLegs[1].entryPrice;
  }
  
  const netEntryCredit = totalSellEntry - totalBuyEntry;
  
  // Compute net exit debit if exit prices are available
  const netExitDebit = computeNetExitDebit(inferredLegs);
  
  return {
    success: true,
    legs: inferredLegs,
    netEntryCredit,
    netExitDebit: netExitDebit ?? undefined,
  };
}

/**
 * Infer leg sides based on strategy type
 */
export function inferLegSides(legs: LegInfo[], strategyType: string | null | undefined): InferenceResult {
  if (!strategyType || legs.length === 0) {
    return { success: false, legs: [], netEntryCredit: 0, error: 'Missing strategy type or legs' };
  }
  
  switch (strategyType) {
    case 'iron_condor':
    case 'iron_fly':
      return inferIronCondorLegs(legs);
    case 'credit_put_spread':
      return inferCreditSpreadLegs(legs, 'put');
    case 'credit_call_spread':
      return inferCreditSpreadLegs(legs, 'call');
    default:
      return { success: false, legs: [], netEntryCredit: 0, error: `Unsupported strategy type: ${strategyType}` };
  }
}

/**
 * Get inferred side for a specific leg symbol from the inference result
 */
export function getInferredSide(inferredLegs: InferredLeg[], symbol: string): { openSide: string; closeSide: string } | null {
  const leg = inferredLegs.find(l => l.symbol === symbol);
  if (!leg) return null;
  return { openSide: leg.openSide, closeSide: leg.closeSide };
}
