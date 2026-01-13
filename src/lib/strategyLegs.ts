// Strategy leg count helpers for multi-leg structure validation

import type { StrategyType } from '@/types/trading';

/**
 * Returns the expected number of legs for a given strategy type.
 * Returns null for custom strategies or those with undefined structure.
 */
export function expectedLegCount(strategyType: StrategyType | string | null | undefined): number | null {
  if (!strategyType) return null;
  
  switch (strategyType) {
    case 'iron_condor':
      return 4;
    case 'iron_fly':
      return 4;
    case 'credit_put_spread':
    case 'credit_call_spread':
      return 2;
    case 'butterfly':
      return 3;
    case 'straddle':
    case 'strangle':
      return 2;
    case 'custom':
    default:
      return null;
  }
}

/**
 * Friendly display name for a strategy type
 */
export function strategyDisplayName(strategyType: StrategyType | string | null | undefined): string {
  if (!strategyType) return 'Position';
  
  switch (strategyType) {
    case 'iron_condor':
      return 'Iron Condor';
    case 'iron_fly':
      return 'Iron Fly';
    case 'credit_put_spread':
      return 'Put Spread';
    case 'credit_call_spread':
      return 'Call Spread';
    case 'butterfly':
      return 'Butterfly';
    case 'straddle':
      return 'Straddle';
    case 'strangle':
      return 'Strangle';
    case 'custom':
      return 'Custom';
    default:
      return strategyType;
  }
}

export type GroupHealth = 'ok' | 'broken' | 'unknown';

export interface GroupHealthInfo {
  status: GroupHealth;
  reason: string;
  expectedLegs: number | null;
  observedLegs: number;
}

/**
 * Compute group health based on expected vs observed leg count
 */
export function computeGroupHealth(
  strategyType: StrategyType | string | null | undefined,
  observedLegs: number
): GroupHealthInfo {
  const expected = expectedLegCount(strategyType);
  
  if (expected === null) {
    return {
      status: 'unknown',
      reason: 'No expected leg count defined for this strategy type',
      expectedLegs: null,
      observedLegs,
    };
  }
  
  if (observedLegs === expected) {
    return {
      status: 'ok',
      reason: `All ${expected} legs present`,
      expectedLegs: expected,
      observedLegs,
    };
  }
  
  return {
    status: 'broken',
    reason: `Expected ${expected} legs, found ${observedLegs} — structure broken`,
    expectedLegs: expected,
    observedLegs,
  };
}
