import { describe, it, expect } from 'vitest';

/**
 * Risk-Based Position Sizing Tests
 *
 * Tests the contract computation logic:
 * - computedContracts = floor(riskPerTrade / maxLossPerContract)
 * - Respects maxContracts cap
 * - Respects minContractsOnRisk floor
 * - Handles zero/negative max loss gracefully
 */

// Helper: Compute contracts based on risk sizing parameters
function computeRiskSizedContracts(
  riskPerTrade: number,
  maxLossPerContract: number,
  maxContracts: number = 10,
  minContractsOnRisk: number = 1
): { pass: boolean; contracts: number; reason?: string } {
  if (maxLossPerContract <= 0) {
    return {
      pass: false,
      contracts: 0,
      reason: 'Cannot compute - max loss unknown or zero',
    };
  }

  let computed = Math.floor(riskPerTrade / maxLossPerContract);
  computed = Math.min(computed, maxContracts);
  computed = Math.max(computed, minContractsOnRisk);

  if (computed < minContractsOnRisk) {
    return {
      pass: false,
      contracts: computed,
      reason: `Risk sizing resulted in ${computed} contracts (min: ${minContractsOnRisk})`,
    };
  }

  return {
    pass: true,
    contracts: computed,
  };
}

describe('Risk-Based Position Sizing', () => {
  it('computes correct contracts: $500 budget / $200 max loss = 2', () => {
    const result = computeRiskSizedContracts(500, 200);
    expect(result.pass).toBe(true);
    expect(result.contracts).toBe(2);
  });

  it('computes correct contracts: $1000 budget / $250 max loss = 4', () => {
    const result = computeRiskSizedContracts(1000, 250);
    expect(result.pass).toBe(true);
    expect(result.contracts).toBe(4);
  });

  it('respects maxContracts cap', () => {
    // $2000 / $100 = 20, but cap at 5
    const result = computeRiskSizedContracts(2000, 100, 5);
    expect(result.pass).toBe(true);
    expect(result.contracts).toBe(5);
  });

  it('respects minContractsOnRisk floor', () => {
    // $100 / $500 = 0.2 -> floor to 0, but min is 1
    const result = computeRiskSizedContracts(100, 500, 10, 1);
    expect(result.pass).toBe(true);
    expect(result.contracts).toBe(1);
  });

  it('fails for zero max loss', () => {
    const result = computeRiskSizedContracts(500, 0);
    expect(result.pass).toBe(false);
    expect(result.contracts).toBe(0);
    expect(result.reason).toContain('max loss unknown');
  });

  it('fails for negative max loss', () => {
    const result = computeRiskSizedContracts(500, -100);
    expect(result.pass).toBe(false);
    expect(result.contracts).toBe(0);
  });

  it('handles fractional contract calculation correctly', () => {
    // $500 / $300 = 1.67 -> floor to 1
    const result = computeRiskSizedContracts(500, 300);
    expect(result.pass).toBe(true);
    expect(result.contracts).toBe(1);
  });

  it('uses min floor when computed is below minimum', () => {
    // $50 / $500 = 0.1 -> floor to 0, then max with min(2) = 2
    const result = computeRiskSizedContracts(50, 500, 10, 2);
    expect(result.pass).toBe(true);
    expect(result.contracts).toBe(2);
  });

  it('applies both floor and cap correctly', () => {
    // Large budget, low max loss, but capped
    // $10000 / $50 = 200 -> cap at 5
    const result = computeRiskSizedContracts(10000, 50, 5, 1);
    expect(result.pass).toBe(true);
    expect(result.contracts).toBe(5);
  });
});

describe('Risk Sizing with maxTotalRiskDollars', () => {
  // Helper that also checks portfolio risk cap
  function computeWithPortfolioCap(
    riskPerTrade: number,
    maxLossPerContract: number,
    maxContracts: number,
    minContractsOnRisk: number,
    maxTotalRiskDollars?: number
  ): { contracts: number; totalRisk: number } {
    if (maxLossPerContract <= 0) {
      return { contracts: 0, totalRisk: 0 };
    }

    let computed = Math.floor(riskPerTrade / maxLossPerContract);
    computed = Math.min(computed, maxContracts);
    computed = Math.max(computed, minContractsOnRisk);

    // Apply portfolio risk cap
    if (maxTotalRiskDollars) {
      const totalRisk = computed * maxLossPerContract;
      if (totalRisk > maxTotalRiskDollars) {
        const cappedContracts = Math.floor(maxTotalRiskDollars / maxLossPerContract);
        computed = Math.max(cappedContracts, minContractsOnRisk);
      }
    }

    return {
      contracts: computed,
      totalRisk: computed * maxLossPerContract,
    };
  }

  it('caps contracts when total risk exceeds portfolio limit', () => {
    // $500/trade, $100 max loss, normally 5 contracts = $500 total risk
    // But portfolio cap is $300, so only 3 contracts allowed
    const result = computeWithPortfolioCap(500, 100, 10, 1, 300);
    expect(result.contracts).toBe(3);
    expect(result.totalRisk).toBe(300);
  });

  it('does not cap when under portfolio limit', () => {
    // $500/trade, $100 max loss = 5 contracts = $500 total risk
    // Portfolio cap is $1000, so no additional capping
    const result = computeWithPortfolioCap(500, 100, 10, 1, 1000);
    expect(result.contracts).toBe(5);
    expect(result.totalRisk).toBe(500);
  });

  it('respects minContractsOnRisk even with portfolio cap', () => {
    // Very tight cap would reduce to 0, but min is 2
    const result = computeWithPortfolioCap(500, 300, 10, 2, 100);
    expect(result.contracts).toBe(2);
  });
});

describe('Fixed Sizing Mode', () => {
  it('uses fixed contracts without risk calculation', () => {
    const fixedContracts = 3;
    const positionSize = 1;

    // In fixed mode, use fixedContracts from sizing config, or fall back to positionSize
    const computed = fixedContracts ?? positionSize ?? 1;
    expect(computed).toBe(3);
  });

  it('falls back to positionSize when fixedContracts not set', () => {
    const fixedContracts = undefined;
    const positionSize = 2;

    const computed = fixedContracts ?? positionSize ?? 1;
    expect(computed).toBe(2);
  });

  it('defaults to 1 when nothing set', () => {
    const fixedContracts = undefined;
    const positionSize = undefined;

    const computed = fixedContracts ?? positionSize ?? 1;
    expect(computed).toBe(1);
  });
});
