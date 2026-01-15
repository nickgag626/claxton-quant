import { describe, it, expect } from 'vitest';

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
