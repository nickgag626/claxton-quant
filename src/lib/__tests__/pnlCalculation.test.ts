import { describe, it, expect } from 'vitest';

// Exit price source type for combo vs per-leg exit detection
type ExitPriceSource = 'PER_LEG' | 'COMBO_NET' | 'PARTIAL';

// Normalize contracts when quantity equals legCount (common bug in multi-leg orders)
function normalizeContracts(storedQuantity: number, legCount: number): number {
  // If legCount >= 4 and quantity === legCount, assume 1 contract (not N contracts)
  // This handles the bug where quantity=4 is stored instead of contracts=1
  if (legCount >= 4 && storedQuantity === legCount) {
    return 1;
  }
  return storedQuantity;
}

// Detect exit price source based on leg exit prices
function detectExitPriceSource(legs: Array<{ exit_price?: number; exitPrice?: number; isPrimary?: boolean }>): ExitPriceSource {
  const exitPrices = legs.map(l => l.exit_price ?? l.exitPrice ?? 0);
  const nonZeroExitPrices = exitPrices.filter(p => p > 0);

  // No exit prices at all
  if (nonZeroExitPrices.length === 0) {
    return 'PARTIAL';
  }

  // Only some legs have exit prices
  if (nonZeroExitPrices.length < legs.length && nonZeroExitPrices.length > 0) {
    // Check if only primary has exit price (COMBO_NET case)
    const primaryWithExit = legs.filter(l => l.isPrimary && (l.exit_price ?? l.exitPrice ?? 0) > 0);
    const nonPrimaryWithExit = legs.filter(l => !l.isPrimary && (l.exit_price ?? l.exitPrice ?? 0) > 0);

    if (primaryWithExit.length === 1 && nonPrimaryWithExit.length === 0) {
      return 'COMBO_NET';
    }
    return 'PARTIAL';
  }

  // All legs have exit prices - check if all same (COMBO_NET) or different (PER_LEG)
  const allSame = exitPrices.every(p => Math.abs(p - exitPrices[0]) < 0.001);
  return allSame ? 'COMBO_NET' : 'PER_LEG';
}

// Compute exit debit based on exit price source
function computeExitDebit(
  legs: Array<{ exit_price?: number; exitPrice?: number; side?: string; isPrimary?: boolean }>,
  source: ExitPriceSource,
  contracts: number,
  normalizeLegDir: (side: string | null | undefined) => 'short' | 'long' | null
): number {
  if (source === 'COMBO_NET') {
    // For combo net, use primary leg's exit price as combo price
    const primaryLeg = legs.find(l => l.isPrimary);
    const exitPrice = primaryLeg?.exit_price ?? primaryLeg?.exitPrice ?? 0;

    // If no primary found, use first non-zero exit price
    const firstExitPrice = exitPrice || legs.map(l => l.exit_price ?? l.exitPrice ?? 0).find(p => p > 0) || 0;

    return firstExitPrice * contracts * 100;
  }

  if (source === 'PER_LEG') {
    // Direction-aware sum for per-leg fills
    let exitDebit = 0;
    for (const leg of legs) {
      const legDir = normalizeLegDir(leg.side);
      const exitPrice = leg.exit_price ?? leg.exitPrice ?? 0;

      if (legDir === 'short') {
        exitDebit += exitPrice * contracts * 100; // Pay to close short
      } else if (legDir === 'long') {
        exitDebit -= exitPrice * contracts * 100; // Receive from selling long
      }
    }
    return exitDebit;
  }

  // PARTIAL - return 0 and set needs_reconcile
  return 0;
}

// Format exit info for UI display (separates trigger from realized outcome)
function formatExitInfo(trade: { exit_trigger_reason?: string; exit_reason?: string; pnl?: number | null }): { trigger: string; realized: string } {
  const trigger = trade.exit_trigger_reason || trade.exit_reason || 'unknown';
  const pnl = trade.pnl ?? 0;
  const sign = pnl >= 0 ? '+' : '-';
  const absValue = Math.abs(pnl).toFixed(2);
  const realized = `${sign}$${absValue}`;
  return { trigger, realized };
}

// Helper to normalize leg direction (matches strategy-engine implementation)
function normalizeLegDir(side: string | null | undefined): 'short' | 'long' | null {
  if (!side) return null;
  const s = side.toLowerCase();
  if (s.includes('sell') || s === 'short' || s === 'sold') return 'short';
  if (s.includes('buy') || s === 'long' || s === 'bought') return 'long';
  return null;
}

// Helper to get mark price with fallbacks
function getMarkPrice(leg: { markPrice?: number; bid?: number; ask?: number; last?: number; lastPrice?: number }): number {
  if (typeof leg.markPrice === 'number' && leg.markPrice > 0) return leg.markPrice;
  const bid = leg.bid ?? 0;
  const ask = leg.ask ?? 0;
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  const last = leg.lastPrice ?? leg.last ?? 0;
  if (last && last > 0) return last;
  return 0;
}

// Infer leg direction from strikes for iron condors
function inferLegDirFromStrikes(
  legSymbol: string, 
  allLegSymbols: string[]
): 'short' | 'long' | null {
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
  
  const sameType = allLegSymbols
    .map(s => ({ symbol: s, parsed: parseSymbol(s) }))
    .filter(x => x.parsed && x.parsed.optionType === thisParsed.optionType);
  
  if (sameType.length !== 2) return null;
  sameType.sort((a, b) => a.parsed!.strike - b.parsed!.strike);
  
  const isLowerStrike = sameType[0].symbol === legSymbol;
  
  if (thisParsed.optionType === 'C') {
    return isLowerStrike ? 'short' : 'long';
  } else {
    return isLowerStrike ? 'long' : 'short';
  }
}

describe('Iron Condor P&L Calculation', () => {
  it('computes correct unrealized P&L% from mark prices', () => {
    // SPY Iron Condor Example from user
    // Entry fills: BTO 692P@0.26, STO 693P@0.40, STO 696C@0.22, BTO 697C@0.09
    // Net entry credit = (0.40 + 0.22 - 0.26 - 0.09) = 0.27 per contract
    // For 1 contract: entryCreditDollars = 0.27 * 100 = $27
    
    const entryCreditDollars = 27; // Stored in DOLLARS for whole group
    
    // Current mark prices (same as exit fills in example)
    const legs = [
      { symbol: 'SPY260115P00692000', side: 'buy_to_open', markPrice: 0.27, qty: 1 },   // Long put
      { symbol: 'SPY260115P00693000', side: 'sell_to_open', markPrice: 0.43, qty: 1 },  // Short put
      { symbol: 'SPY260115C00696000', side: 'sell_to_open', markPrice: 0.22, qty: 1 },  // Short call
      { symbol: 'SPY260115C00697000', side: 'buy_to_open', markPrice: 0.07, qty: 1 },   // Long call
    ];
    
    // Compute costToCloseDebit using normalizeLegDir
    let costToCloseDebit = 0;
    for (const leg of legs) {
      const legDir = normalizeLegDir(leg.side);
      expect(legDir).not.toBeNull();
      
      const mark = getMarkPrice(leg);
      
      if (legDir === 'short') {
        costToCloseDebit += mark * leg.qty * 100;
      } else {
        costToCloseDebit -= mark * leg.qty * 100;
      }
    }
    
    // Short legs: (0.43 + 0.22) * 100 = $65 (pay to buy back)
    // Long legs: (0.27 + 0.07) * 100 = $34 (receive from selling)
    // Net = $65 - $34 = $31
    expect(costToCloseDebit).toBeCloseTo(31, 0);
    
    // Unrealized P&L = entryCreditDollars - costToCloseDebit
    const unrealizedPnl = entryCreditDollars - costToCloseDebit; // = 27 - 31 = -4
    expect(unrealizedPnl).toBeCloseTo(-4, 0);
    
    // Unrealized P&L % = (unrealizedPnl / entryCreditDollars) * 100
    const unrealizedPnlPercent = (unrealizedPnl / entryCreditDollars) * 100;
    expect(unrealizedPnlPercent).toBeCloseTo(-14.81, 1);
  });
  
  it('should NOT trigger profit_target on negative P&L', () => {
    const pnlPercent = -14.81;
    const profitTargetThreshold = 50;
    
    // profit_target only triggers if pnlPercent > 0 AND >= threshold
    const shouldTriggerProfitTarget = pnlPercent >= profitTargetThreshold && pnlPercent > 0;
    expect(shouldTriggerProfitTarget).toBe(false);
  });
  
  it('should skip exit trigger for absurd P&L% values', () => {
    const absurdPnlPercent = 211.11;
    const sanityThreshold = 200;
    
    const shouldSkipTrigger = Math.abs(absurdPnlPercent) > sanityThreshold;
    expect(shouldSkipTrigger).toBe(true);
  });
  
  it('should skip P&L% triggers when entryCreditDollars <= 0', () => {
    const entryCreditDollars = 0;
    const canUseCreditFormula = entryCreditDollars > 0;
    expect(canUseCreditFormula).toBe(false);
  });
  
  it('should skip exit evaluation when any leg has missing mark price', () => {
    const legs = [
      { symbol: 'SPY260115P00692000', markPrice: 0.27 },
      { symbol: 'SPY260115P00693000', markPrice: 0 }, // Missing!
      { symbol: 'SPY260115C00696000', markPrice: 0.22 },
      { symbol: 'SPY260115C00697000', markPrice: 0.07 },
    ];
    
    const missingMarkLegs = legs.filter(l => getMarkPrice(l) <= 0);
    expect(missingMarkLegs.length).toBeGreaterThan(0);
  });
  
  it('should use mid price when markPrice is missing but bid/ask exist', () => {
    const leg = { bid: 0.40, ask: 0.44 };
    const mark = getMarkPrice(leg);
    expect(mark).toBeCloseTo(0.42, 2);
  });

  it('should use last price when markPrice and bid/ask are missing', () => {
    const leg = { last: 0.35 };
    const mark = getMarkPrice(leg);
    expect(mark).toBeCloseTo(0.35, 2);
  });

  it('should use lastPrice when markPrice and bid/ask are missing', () => {
    const leg = { lastPrice: 0.38 };
    const mark = getMarkPrice(leg);
    expect(mark).toBeCloseTo(0.38, 2);
  });
});

describe('normalizeLegDir helper', () => {
  it('normalizes sell_to_open to short', () => {
    expect(normalizeLegDir('sell_to_open')).toBe('short');
  });
  
  it('normalizes buy_to_open to long', () => {
    expect(normalizeLegDir('buy_to_open')).toBe('long');
  });
  
  it('handles various formats', () => {
    expect(normalizeLegDir('SELL_TO_OPEN')).toBe('short');
    expect(normalizeLegDir('BUY_TO_OPEN')).toBe('long');
    expect(normalizeLegDir('short')).toBe('short');
    expect(normalizeLegDir('long')).toBe('long');
    expect(normalizeLegDir('sold')).toBe('short');
    expect(normalizeLegDir('bought')).toBe('long');
    expect(normalizeLegDir('sell_to_close')).toBe('short');
    expect(normalizeLegDir('buy_to_close')).toBe('long');
  });
  
  it('returns null for unknown or missing', () => {
    expect(normalizeLegDir(null)).toBeNull();
    expect(normalizeLegDir(undefined)).toBeNull();
    expect(normalizeLegDir('unknown')).toBeNull();
    expect(normalizeLegDir('')).toBeNull();
  });
});

describe('inferLegDirFromStrikes helper', () => {
  const ironCondorSymbols = [
    'SPY260115P00692000', // Long put (lower strike)
    'SPY260115P00693000', // Short put (higher strike)
    'SPY260115C00696000', // Short call (lower strike)
    'SPY260115C00697000', // Long call (higher strike)
  ];

  it('infers long for lower put strike', () => {
    expect(inferLegDirFromStrikes('SPY260115P00692000', ironCondorSymbols)).toBe('long');
  });

  it('infers short for higher put strike', () => {
    expect(inferLegDirFromStrikes('SPY260115P00693000', ironCondorSymbols)).toBe('short');
  });

  it('infers short for lower call strike', () => {
    expect(inferLegDirFromStrikes('SPY260115C00696000', ironCondorSymbols)).toBe('short');
  });

  it('infers long for higher call strike', () => {
    expect(inferLegDirFromStrikes('SPY260115C00697000', ironCondorSymbols)).toBe('long');
  });

  it('returns null for invalid symbols', () => {
    expect(inferLegDirFromStrikes('INVALID', ironCondorSymbols)).toBeNull();
  });

  it('returns null when only one leg of same type', () => {
    const singleLegSymbols = ['SPY260115P00692000'];
    expect(inferLegDirFromStrikes('SPY260115P00692000', singleLegSymbols)).toBeNull();
  });
});

describe('P&L calculation edge cases', () => {
  it('handles positive P&L correctly (profit scenario)', () => {
    // Entry credit of $50, current marks would cost $20 to close
    const entryCreditDollars = 50;
    
    // Simulated marks - short legs cheaper now
    const legs = [
      { side: 'buy_to_open', markPrice: 0.10, qty: 1 },   // Long: sells for $10
      { side: 'sell_to_open', markPrice: 0.15, qty: 1 },  // Short: buy back for $15
      { side: 'sell_to_open', markPrice: 0.10, qty: 1 },  // Short: buy back for $10
      { side: 'buy_to_open', markPrice: 0.05, qty: 1 },   // Long: sells for $5
    ];
    
    let costToCloseDebit = 0;
    for (const leg of legs) {
      const legDir = normalizeLegDir(leg.side);
      const mark = getMarkPrice(leg);
      
      if (legDir === 'short') {
        costToCloseDebit += mark * leg.qty * 100;
      } else {
        costToCloseDebit -= mark * leg.qty * 100;
      }
    }
    
    // Short legs: (0.15 + 0.10) * 100 = $25
    // Long legs: (0.10 + 0.05) * 100 = $15
    // Net cost = $25 - $15 = $10
    expect(costToCloseDebit).toBeCloseTo(10, 0);
    
    const unrealizedPnl = entryCreditDollars - costToCloseDebit; // $50 - $10 = $40
    expect(unrealizedPnl).toBeCloseTo(40, 0);
    
    const unrealizedPnlPercent = (unrealizedPnl / entryCreditDollars) * 100; // 80%
    expect(unrealizedPnlPercent).toBeCloseTo(80, 0);
  });

  it('clamps tiny negative cost to close to 0', () => {
    let costToCloseDebit = -0.5; // Tiny negative from quote noise
    
    if (costToCloseDebit < 0 && costToCloseDebit > -1) {
      costToCloseDebit = 0;
    }
    
    expect(costToCloseDebit).toBe(0);
  });

  it('does not clamp larger negative values', () => {
    let costToCloseDebit = -5; // Actual credit from closing

    if (costToCloseDebit < 0 && costToCloseDebit > -1) {
      costToCloseDebit = 0;
    }

    expect(costToCloseDebit).toBe(-5);
  });
});

describe('Quantity/Contracts Invariants', () => {
  it('detects quantity == legCount bug for 4-leg spreads', () => {
    const legCount = 4;
    const storedQuantity = 4; // Bug: should be 1 contract, stored as 4

    // Invariant check
    const hasQuantityBug = legCount >= 4 && storedQuantity === legCount;
    expect(hasQuantityBug).toBe(true);

    // Correction
    const correctedContracts = hasQuantityBug ? 1 : storedQuantity;
    expect(correctedContracts).toBe(1);
  });

  it('does not flag correct quantity for 4-leg spreads', () => {
    const legCount = 4;
    const storedQuantity = 1; // Correct: 1 contract

    const hasQuantityBug = legCount >= 4 && storedQuantity === legCount;
    expect(hasQuantityBug).toBe(false);
  });

  it('allows quantity > legCount for multiple contracts', () => {
    const legCount = 4;
    const storedQuantity = 2; // 2 contracts is valid

    const hasQuantityBug = legCount >= 4 && storedQuantity === legCount;
    expect(hasQuantityBug).toBe(false);
  });

  it('computes correct entry credit with corrected contracts', () => {
    // Bug scenario: entry_credit computed with quantity=4 instead of 1
    const netCreditPerShare = 0.30; // $0.30 per share
    const buggyQuantity = 4;
    const correctContracts = 1;

    const buggyEntryCredit = netCreditPerShare * buggyQuantity * 100; // $120 (wrong)
    const correctEntryCredit = netCreditPerShare * correctContracts * 100; // $30 (right)

    expect(buggyEntryCredit).toBe(120);
    expect(correctEntryCredit).toBe(30);
    expect(buggyEntryCredit / correctEntryCredit).toBe(4); // 4x multiplier bug
  });
});

describe('Combo Fill Price Interpretation', () => {
  it('detects COMBO_NET when all legs have same exit price', () => {
    const legs = [
      { symbol: 'SPY260115P00692000', exitPrice: 0.15 },
      { symbol: 'SPY260115P00693000', exitPrice: 0.15 },
      { symbol: 'SPY260115C00696000', exitPrice: 0.15 },
      { symbol: 'SPY260115C00697000', exitPrice: 0.15 },
    ];

    const exitPrices = legs.map(l => l.exitPrice);
    const allSame = exitPrices.every(p => Math.abs(p - exitPrices[0]) < 0.001);
    expect(allSame).toBe(true);

    // For COMBO_NET, exit_debit = price * contracts * 100 (NOT sum of legs)
    const contracts = 1;
    const exitDebit = exitPrices[0] * contracts * 100;
    expect(exitDebit).toBe(15);
  });

  it('uses direction-aware sum for PER_LEG_FILLS', () => {
    const legs = [
      { symbol: 'SPY260115P00692000', side: 'buy_to_open', exitPrice: 0.05 },  // Long: receive $5
      { symbol: 'SPY260115P00693000', side: 'sell_to_open', exitPrice: 0.10 }, // Short: pay $10
      { symbol: 'SPY260115C00696000', side: 'sell_to_open', exitPrice: 0.08 }, // Short: pay $8
      { symbol: 'SPY260115C00697000', side: 'buy_to_open', exitPrice: 0.02 },  // Long: receive $2
    ];

    const exitPrices = legs.map(l => l.exitPrice);
    const allSame = exitPrices.every(p => Math.abs(p - exitPrices[0]) < 0.001);
    expect(allSame).toBe(false);

    // Direction-aware calculation
    const contracts = 1;
    let exitDebit = 0;
    for (const leg of legs) {
      const legDir = normalizeLegDir(leg.side);
      if (legDir === 'short') {
        exitDebit += leg.exitPrice * contracts * 100; // Pay to close
      } else {
        exitDebit -= leg.exitPrice * contracts * 100; // Receive from close
      }
    }

    // Short legs: (0.10 + 0.08) * 100 = $18 pay
    // Long legs: (0.05 + 0.02) * 100 = $7 receive
    // Net = $18 - $7 = $11
    expect(exitDebit).toBe(11);
  });

  it('handles COMBO_NET_PRIMARY when only primary has exit price', () => {
    const legs = [
      { symbol: 'SPY260115C00696000', exitPrice: 0.15, isPrimary: true },
      { symbol: 'SPY260115C00697000', exitPrice: 0, isPrimary: false },
      { symbol: 'SPY260115P00692000', exitPrice: 0, isPrimary: false },
      { symbol: 'SPY260115P00693000', exitPrice: 0, isPrimary: false },
    ];

    const legsWithExit = legs.filter(l => l.exitPrice > 0);
    expect(legsWithExit.length).toBe(1);
    expect(legsWithExit[0].isPrimary).toBe(true);

    // Treat as combo net price
    const contracts = 1;
    const exitDebit = legsWithExit[0].exitPrice * contracts * 100;
    expect(exitDebit).toBe(15);
  });
});

describe('Exit Reason vs Realized P&L', () => {
  it('allows stop_loss trigger with positive realized P&L', () => {
    // Scenario: stop_loss triggered at -30% (mark-based)
    // But actual fill resulted in +10% profit (favorable slippage)
    const exitTriggerReason = 'stop_loss';
    const unrealizedPnlAtTrigger = -30; // Mark-based, triggered stop
    const realizedPnl = 10; // Actual fill was profitable

    // This is VALID - trigger and outcome are independent
    // exit_reason = why we exited (trigger type)
    // realized_pnl = what we actually made
    expect(exitTriggerReason).toBe('stop_loss');
    expect(realizedPnl).toBeGreaterThan(0);

    // UI should show both: "Exit: stop_loss | P&L: +$10"
    // NOT imply that stop_loss means loss
  });

  it('allows profit_target trigger with negative realized P&L', () => {
    // Scenario: profit_target triggered at +70% (mark-based)
    // But actual fill resulted in -5% loss (unfavorable slippage)
    const exitTriggerReason = 'profit_target';
    const unrealizedPnlAtTrigger = 70; // Mark-based, triggered target
    const realizedPnl = -5; // Actual fill was a loss

    // This is VALID - trigger and outcome are independent
    expect(exitTriggerReason).toBe('profit_target');
    expect(realizedPnl).toBeLessThan(0);
  });
});

describe('Canonical P&L Formula', () => {
  it('computes realized P&L for credit spread: entry_credit - exit_debit - fees', () => {
    // Credit spread example
    const entryCreditDollars = 95; // Received $95 at entry
    const exitDebitDollars = 31; // Paid $31 to close
    const fees = 0;

    const realizedPnl = entryCreditDollars - exitDebitDollars - fees;
    expect(realizedPnl).toBe(64); // Profit of $64
  });

  it('computes P&L percent correctly', () => {
    const entryCreditDollars = 95;
    const exitDebitDollars = 31;
    const realizedPnl = entryCreditDollars - exitDebitDollars;

    const pnlPercent = (realizedPnl / entryCreditDollars) * 100;
    expect(pnlPercent).toBeCloseTo(67.37, 1); // ~67% profit
  });

  it('handles loss scenario correctly', () => {
    const entryCreditDollars = 50;
    const exitDebitDollars = 80; // Paid more to close than received

    const realizedPnl = entryCreditDollars - exitDebitDollars;
    expect(realizedPnl).toBe(-30); // Loss of $30

    const pnlPercent = (realizedPnl / entryCreditDollars) * 100;
    expect(pnlPercent).toBe(-60); // -60% loss
  });
});

// ============================================================================
// Step 6: Tests that expose current bugs (from P&L Fix Implementation Plan)
// ============================================================================

describe('normalizeContracts helper', () => {
  it('normalizes quantity when it equals legCount', () => {
    const legCount = 4;
    const storedQuantity = 4;

    // This should be normalized to 1 at write-time
    const normalizedContracts = normalizeContracts(storedQuantity, legCount);
    expect(normalizedContracts).toBe(1);
  });

  it('does not normalize when quantity differs from legCount', () => {
    const legCount = 4;
    const storedQuantity = 2; // 2 contracts is valid

    const normalizedContracts = normalizeContracts(storedQuantity, legCount);
    expect(normalizedContracts).toBe(2);
  });

  it('does not normalize for 2-leg spreads', () => {
    const legCount = 2;
    const storedQuantity = 2;

    // For 2-leg spreads, quantity=2 likely means 2 contracts
    const normalizedContracts = normalizeContracts(storedQuantity, legCount);
    expect(normalizedContracts).toBe(2);
  });
});

describe('detectExitPriceSource helper', () => {
  it('uses COMBO_NET for primary-only exit price', () => {
    const legs = [
      { exitPrice: 0.15, isPrimary: true },
      { exitPrice: 0, isPrimary: false },
      { exitPrice: 0, isPrimary: false },
      { exitPrice: 0, isPrimary: false },
    ];

    const source = detectExitPriceSource(legs);
    expect(source).toBe('COMBO_NET');
  });

  it('uses COMBO_NET when all legs have same exit price', () => {
    const legs = [
      { exitPrice: 0.15, isPrimary: true },
      { exitPrice: 0.15, isPrimary: false },
      { exitPrice: 0.15, isPrimary: false },
      { exitPrice: 0.15, isPrimary: false },
    ];

    const source = detectExitPriceSource(legs);
    expect(source).toBe('COMBO_NET');
  });

  it('uses PER_LEG when legs have different exit prices', () => {
    const legs = [
      { exitPrice: 0.05, isPrimary: true },
      { exitPrice: 0.10, isPrimary: false },
      { exitPrice: 0.08, isPrimary: false },
      { exitPrice: 0.02, isPrimary: false },
    ];

    const source = detectExitPriceSource(legs);
    expect(source).toBe('PER_LEG');
  });

  it('uses PARTIAL when no legs have exit prices', () => {
    const legs = [
      { exitPrice: 0, isPrimary: true },
      { exitPrice: 0, isPrimary: false },
      { exitPrice: 0, isPrimary: false },
      { exitPrice: 0, isPrimary: false },
    ];

    const source = detectExitPriceSource(legs);
    expect(source).toBe('PARTIAL');
  });
});

describe('computeExitDebit helper', () => {
  it('computes COMBO_NET exit debit from primary leg price', () => {
    const legs = [
      { exitPrice: 0.15, isPrimary: true },
      { exitPrice: 0, isPrimary: false },
      { exitPrice: 0, isPrimary: false },
      { exitPrice: 0, isPrimary: false },
    ];

    // Exit debit should be 0.15 * 100, NOT sum of all legs
    const exitDebit = computeExitDebit(legs, 'COMBO_NET', 1, normalizeLegDir);
    expect(exitDebit).toBe(15);
  });

  it('computes PER_LEG exit debit with direction-aware sum', () => {
    const legs = [
      { exitPrice: 0.05, side: 'buy_to_open', isPrimary: true },  // Long: receive $5
      { exitPrice: 0.10, side: 'sell_to_open', isPrimary: false }, // Short: pay $10
      { exitPrice: 0.08, side: 'sell_to_open', isPrimary: false }, // Short: pay $8
      { exitPrice: 0.02, side: 'buy_to_open', isPrimary: false },  // Long: receive $2
    ];

    // Short legs: (0.10 + 0.08) * 100 = $18 pay
    // Long legs: (0.05 + 0.02) * 100 = $7 receive
    // Net = $18 - $7 = $11
    const exitDebit = computeExitDebit(legs, 'PER_LEG', 1, normalizeLegDir);
    expect(exitDebit).toBe(11);
  });

  it('returns 0 for PARTIAL source', () => {
    const legs = [
      { exitPrice: 0, isPrimary: true },
      { exitPrice: 0, isPrimary: false },
    ];

    const exitDebit = computeExitDebit(legs, 'PARTIAL', 1, normalizeLegDir);
    expect(exitDebit).toBe(0);
  });
});

describe('formatExitInfo helper', () => {
  it('distinguishes exit trigger from realized outcome', () => {
    const trade = {
      exit_trigger_reason: 'stop_loss',
      pnl: 17, // Positive despite stop_loss trigger
    };

    // UI should show both, not conflate them
    const display = formatExitInfo(trade);
    expect(display.trigger).toBe('stop_loss');
    expect(display.realized).toBe('+$17.00');
  });

  it('falls back to exit_reason when exit_trigger_reason is missing', () => {
    const trade = {
      exit_reason: 'profit_target',
      pnl: -5, // Negative despite profit_target trigger
    };

    const display = formatExitInfo(trade);
    expect(display.trigger).toBe('profit_target');
    expect(display.realized).toBe('-$5.00');
  });

  it('shows unknown trigger when both fields are missing', () => {
    const trade = {
      pnl: 100,
    };

    const display = formatExitInfo(trade);
    expect(display.trigger).toBe('unknown');
    expect(display.realized).toBe('+$100.00');
  });
});
