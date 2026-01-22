import { describe, it, expect } from 'vitest';

/**
 * Entry Gates and Exit Trigger Tests
 *
 * Tests the higher-conviction entry filters and combined exit triggers:
 * - Wing width validation
 * - Entry credit dollar minimum
 * - Combined exit trigger modes (percent_only, dollars_only, both_required, either)
 */

type ExitTriggerMode = 'percent_only' | 'dollars_only' | 'both_required' | 'either';

// Helper: Validate wing width
function validateWingWidth(
  putLegs: { strike: number }[],
  callLegs: { strike: number }[],
  minWingWidthRequired: number
): { pass: boolean; putWidth: number; callWidth: number; actualWingWidth: number; reason?: string } {
  let putWidth = 0;
  let callWidth = 0;

  if (putLegs.length >= 2) {
    const putStrikes = putLegs.map(l => l.strike).sort((a, b) => a - b);
    putWidth = putStrikes[putStrikes.length - 1] - putStrikes[0];
  }
  if (callLegs.length >= 2) {
    const callStrikes = callLegs.map(l => l.strike).sort((a, b) => a - b);
    callWidth = callStrikes[callStrikes.length - 1] - callStrikes[0];
  }

  const actualWingWidth = Math.min(
    putWidth > 0 ? putWidth : Infinity,
    callWidth > 0 ? callWidth : Infinity
  );
  const effectiveWidth = actualWingWidth === Infinity ? 0 : actualWingWidth;

  if (effectiveWidth < minWingWidthRequired) {
    return {
      pass: false,
      putWidth,
      callWidth,
      actualWingWidth: effectiveWidth,
      reason: `Wing width ${effectiveWidth} pts below minimum ${minWingWidthRequired} pts`,
    };
  }

  return {
    pass: true,
    putWidth,
    callWidth,
    actualWingWidth: effectiveWidth,
  };
}

// Helper: Check exit trigger based on mode
function checkExitTrigger(
  pnlPercent: number,
  pnlDollars: number,
  profitTargetPercent: number,
  stopLossPercent: number,
  profitTargetDollars?: number,
  stopLossDollars?: number,
  exitMode: ExitTriggerMode = 'either'
): { triggered: boolean; reason: string | null } {
  const profitPercentMet = pnlPercent >= profitTargetPercent && pnlPercent > 0;
  const profitDollarsMet = profitTargetDollars !== undefined && pnlDollars >= profitTargetDollars;
  const stopPercentMet = pnlPercent <= -stopLossPercent;
  const stopDollarsMet = stopLossDollars !== undefined && pnlDollars <= -stopLossDollars;

  let reason: string | null = null;

  if (exitMode === 'both_required') {
    if (profitPercentMet && profitDollarsMet) {
      reason = 'profit_target_combined';
    } else if (stopPercentMet && stopDollarsMet) {
      reason = 'stop_loss_combined';
    }
  } else if (exitMode === 'percent_only') {
    if (profitPercentMet) reason = 'profit_target';
    else if (stopPercentMet) reason = 'stop_loss';
  } else if (exitMode === 'dollars_only') {
    if (profitDollarsMet) reason = 'profit_target_dollars';
    else if (stopDollarsMet) reason = 'stop_loss_dollars';
  } else {
    // 'either' mode
    if (profitPercentMet || profitDollarsMet) {
      reason = profitPercentMet ? 'profit_target' : 'profit_target_dollars';
    } else if (stopPercentMet || stopDollarsMet) {
      reason = stopPercentMet ? 'stop_loss' : 'stop_loss_dollars';
    }
  }

  return {
    triggered: reason !== null,
    reason,
  };
}

describe('Wing Width Validation', () => {
  it('passes for adequate wing width (5pt wings, 5pt required)', () => {
    const putLegs = [{ strike: 600 }, { strike: 605 }];
    const callLegs = [{ strike: 610 }, { strike: 615 }];

    const result = validateWingWidth(putLegs, callLegs, 5);
    expect(result.pass).toBe(true);
    expect(result.putWidth).toBe(5);
    expect(result.callWidth).toBe(5);
    expect(result.actualWingWidth).toBe(5);
  });

  it('fails for degenerate 1-wide structure', () => {
    const putLegs = [{ strike: 600 }, { strike: 601 }];
    const callLegs = [{ strike: 610 }, { strike: 611 }];

    const result = validateWingWidth(putLegs, callLegs, 5);
    expect(result.pass).toBe(false);
    expect(result.actualWingWidth).toBe(1);
    expect(result.reason).toContain('below minimum');
  });

  it('uses minimum of put and call widths for iron condors', () => {
    const putLegs = [{ strike: 600 }, { strike: 610 }]; // 10 wide
    const callLegs = [{ strike: 620 }, { strike: 623 }]; // 3 wide

    const result = validateWingWidth(putLegs, callLegs, 5);
    expect(result.pass).toBe(false);
    expect(result.putWidth).toBe(10);
    expect(result.callWidth).toBe(3);
    expect(result.actualWingWidth).toBe(3); // Uses narrower wing
  });

  it('handles credit put spread (no call legs)', () => {
    const putLegs = [{ strike: 600 }, { strike: 605 }];
    const callLegs: { strike: number }[] = [];

    const result = validateWingWidth(putLegs, callLegs, 5);
    expect(result.pass).toBe(true);
    expect(result.actualWingWidth).toBe(5);
  });

  it('handles credit call spread (no put legs)', () => {
    const putLegs: { strike: number }[] = [];
    const callLegs = [{ strike: 610 }, { strike: 615 }];

    const result = validateWingWidth(putLegs, callLegs, 5);
    expect(result.pass).toBe(true);
    expect(result.actualWingWidth).toBe(5);
  });

  it('fails when no legs available', () => {
    const putLegs: { strike: number }[] = [];
    const callLegs: { strike: number }[] = [];

    const result = validateWingWidth(putLegs, callLegs, 5);
    expect(result.pass).toBe(false);
    expect(result.actualWingWidth).toBe(0);
  });
});

describe('Entry Credit Dollar Minimum', () => {
  it('passes when credit exceeds minimum', () => {
    const estimatedCreditPerContract = 0.75; // $0.75
    const estimatedCreditDollars = estimatedCreditPerContract * 100; // $75
    const minEntryCreditDollars = 50;

    expect(estimatedCreditDollars >= minEntryCreditDollars).toBe(true);
  });

  it('fails when credit below minimum', () => {
    const estimatedCreditPerContract = 0.30; // $0.30
    const estimatedCreditDollars = estimatedCreditPerContract * 100; // $30
    const minEntryCreditDollars = 50;

    expect(estimatedCreditDollars >= minEntryCreditDollars).toBe(false);
  });

  it('passes when filter disabled (minEntryCreditDollars = 0)', () => {
    const minEntryCreditDollars = 0;
    const estimatedCreditDollars = 10;

    const enabled = minEntryCreditDollars > 0;
    expect(enabled).toBe(false); // Filter is disabled
  });
});

describe('Combined Exit Triggers - percent_only mode', () => {
  it('triggers profit on percent threshold', () => {
    const result = checkExitTrigger(
      55, // pnlPercent
      200, // pnlDollars
      50, // profitTargetPercent
      100, // stopLossPercent
      300, // profitTargetDollars (NOT met)
      undefined,
      'percent_only'
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('profit_target');
  });

  it('ignores dollar threshold in percent_only mode', () => {
    const result = checkExitTrigger(
      30, // pnlPercent (NOT met for 50% target)
      400, // pnlDollars (WOULD meet $300 target if checked)
      50,
      100,
      300,
      undefined,
      'percent_only'
    );
    expect(result.triggered).toBe(false);
  });
});

describe('Combined Exit Triggers - dollars_only mode', () => {
  it('triggers profit on dollar threshold', () => {
    const result = checkExitTrigger(
      30, // pnlPercent (NOT met)
      350, // pnlDollars
      50,
      100,
      300, // profitTargetDollars (met)
      undefined,
      'dollars_only'
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('profit_target_dollars');
  });

  it('ignores percent threshold in dollars_only mode', () => {
    const result = checkExitTrigger(
      60, // pnlPercent (WOULD meet 50% target if checked)
      100, // pnlDollars (NOT met)
      50,
      100,
      300,
      undefined,
      'dollars_only'
    );
    expect(result.triggered).toBe(false);
  });
});

describe('Combined Exit Triggers - both_required mode', () => {
  it('does NOT trigger when only percent met', () => {
    const result = checkExitTrigger(
      55, // pnlPercent (met)
      200, // pnlDollars (NOT met for $300)
      50,
      100,
      300,
      undefined,
      'both_required'
    );
    expect(result.triggered).toBe(false);
  });

  it('does NOT trigger when only dollars met', () => {
    const result = checkExitTrigger(
      30, // pnlPercent (NOT met)
      350, // pnlDollars (met for $300)
      50,
      100,
      300,
      undefined,
      'both_required'
    );
    expect(result.triggered).toBe(false);
  });

  it('TRIGGERS when both percent AND dollars met', () => {
    const result = checkExitTrigger(
      55, // pnlPercent (met)
      350, // pnlDollars (met)
      50,
      100,
      300,
      undefined,
      'both_required'
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('profit_target_combined');
  });

  it('triggers stop loss when both percent AND dollars met', () => {
    const result = checkExitTrigger(
      -110, // pnlPercent (met for -100%)
      -250, // pnlDollars (met for -$200)
      50,
      100,
      undefined,
      200, // stopLossDollars
      'both_required'
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('stop_loss_combined');
  });
});

describe('Combined Exit Triggers - either mode (default)', () => {
  it('triggers when percent met', () => {
    const result = checkExitTrigger(
      55,
      100,
      50,
      100,
      300,
      undefined,
      'either'
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('profit_target');
  });

  it('triggers when dollars met', () => {
    const result = checkExitTrigger(
      30,
      350,
      50,
      100,
      300,
      undefined,
      'either'
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('profit_target_dollars');
  });

  it('prefers percent trigger when both met', () => {
    const result = checkExitTrigger(
      55,
      350,
      50,
      100,
      300,
      undefined,
      'either'
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('profit_target');
  });

  it('does not trigger when neither met', () => {
    const result = checkExitTrigger(
      30,
      100,
      50,
      100,
      300,
      undefined,
      'either'
    );
    expect(result.triggered).toBe(false);
    expect(result.reason).toBeNull();
  });
});

describe('Stop Loss Triggers', () => {
  it('triggers stop loss on percent threshold', () => {
    const result = checkExitTrigger(
      -110,
      -500,
      50,
      100, // stopLossPercent
      undefined,
      undefined,
      'either'
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('stop_loss');
  });

  it('triggers stop loss on dollar threshold', () => {
    const result = checkExitTrigger(
      -50,
      -250,
      50,
      100,
      undefined,
      200, // stopLossDollars
      'either'
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('stop_loss_dollars');
  });

  it('does not trigger profit on negative P&L', () => {
    // Even if percent threshold is technically "reached" with weird math
    const result = checkExitTrigger(
      -60, // negative
      100,
      50,
      100,
      undefined,
      undefined,
      'either'
    );
    expect(result.triggered).toBe(false);
  });
});

describe('Edge Cases', () => {
  it('handles zero P&L correctly', () => {
    const result = checkExitTrigger(
      0,
      0,
      50,
      100,
      50,
      100,
      'either'
    );
    expect(result.triggered).toBe(false);
  });

  it('handles undefined dollar thresholds in either mode', () => {
    const result = checkExitTrigger(
      60,
      1000, // high dollars but no threshold
      50,
      100,
      undefined, // no profitTargetDollars
      undefined, // no stopLossDollars
      'either'
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('profit_target'); // Only percent checked
  });

  it('does not trigger dollars_only mode with no dollar thresholds', () => {
    const result = checkExitTrigger(
      60,
      1000,
      50,
      100,
      undefined,
      undefined,
      'dollars_only'
    );
    expect(result.triggered).toBe(false);
  });
});
