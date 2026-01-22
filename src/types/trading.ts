// Trading Types for Claxton Quant Dashboard

export interface Position {
  id: string;
  symbol: string;
  quantity: number;
  /** Total dollar cost basis from Tradier (already includes qty × multiplier) */
  costBasis: number;
  /** Total dollar current market value (already includes qty × multiplier) */
  currentValue: number;
  /** Per-contract mark price (mid of bid/ask or last) - NOT multiplied by qty or 100 */
  markPrice?: number;
  expirationDate?: string;
  strategyName?: string;
  strategyType?: string;
  underlying?: string;
  entryCredit?: number;
  status: 'open' | 'pending_close' | 'closed';
  entryTime: Date;
  // Group-aware closing: positions with the same trade_group_id should be closed together
  tradeGroupId?: string;
  // Debug: raw Tradier values for verification
  _rawTradier?: {
    cost_basis: number;
    market_value?: number;
    quantity: number;
  };
}

// Rejection reasons that indicate DTBP/margin issues (case-insensitive substring match)
export const DTBP_REJECTION_PATTERNS = [
  'day trading',
  'day-trading',
  'buying power',
  'margin',
  'dtbp',
  'insufficient',
  'naked',
  'uncovered',
];

export interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export interface Quote {
  symbol: string;
  last: number;
  change: number;
  changePercent: number;
  bid: number;
  ask: number;
  volume: number;
}

export interface Strategy {
  id: string;
  name: string;
  type: StrategyType;
  underlying: string;
  enabled: boolean;
  maxPositions: number;
  positionSize: number;
  entryConditions: EntryConditions;
  exitConditions: ExitConditions;
  // New fields
  trackedLegs?: TrackedLeg[];
  sizing?: StrategySizing;
}

export type StrategyType = 
  | 'iron_condor' 
  | 'credit_put_spread' 
  | 'credit_call_spread' 
  | 'strangle' 
  | 'straddle' 
  | 'butterfly' 
  | 'iron_fly' 
  | 'custom';

export type TrackedLegRole = 'short_put' | 'long_put' | 'short_call' | 'long_call' | 'custom';

export interface TrackedLeg {
  role: TrackedLegRole;
  optionType: 'put' | 'call';
  side: 'buy' | 'sell';
  closeOnExit: boolean;
}

export interface StrategySizing {
  mode: 'fixed' | 'risk';
  fixedContracts?: number;
  riskPerTrade?: number;
  maxContracts?: number;
  maxTotalRiskDollars?: number;  // Portfolio risk cap
  minContractsOnRisk?: number;   // Floor (default: 1)
}

export interface MAFilterRule {
  left: 'price' | 'sma20' | 'sma50' | 'sma200';
  op: 'above' | 'below' | 'crosses_above' | 'crosses_below';
  right: 'sma20' | 'sma50' | 'sma200';
}

export interface MAFilter {
  enabled: boolean;
  sma20?: boolean;
  sma50?: boolean;
  sma200?: boolean;
  rules: MAFilterRule[];
}

export interface EntryConditions {
  minDte: number;
  maxDte: number;
  // Delta targeting (replaces maxDelta)
  shortDeltaTarget: number;
  longDeltaTarget?: number;
  /** @deprecated Use shortDeltaTarget instead */
  maxDelta?: number;
  minPremium?: number;
  minIvRank?: number;
  maxIvRank?: number;
  marketHoursOnly: boolean;
  startTime?: string;
  endTime?: string;
  // Moving average filter
  maFilter?: MAFilter;
  // Higher-conviction entry filters
  minWingWidthPoints?: number;           // Min spread width (default: 5)
  maxBidAskSpreadPerLegPercent?: number; // Per-leg liquidity (default: 15%)
  minEntryCreditDollars?: number;        // Dollar minimum (e.g., $50)
}

export interface TrailingStopConfig {
  enabled: boolean;
  type: 'percent' | 'dollars';
  amount: number;
  activationProfit?: number;
  basis: 'group' | 'tracked_legs' | 'short_legs';
}

export type ExitTriggerMode = 'percent_only' | 'dollars_only' | 'both_required' | 'either';

export interface ExitConditions {
  profitTargetPercent: number;
  stopLossPercent: number;
  timeStopDte?: number;
  timeStopTime?: string;
  /** @deprecated Use trailingStop object instead */
  trailingStopPercent?: number;
  trailingStop?: TrailingStopConfig;
  // Dollar-based exits
  profitTargetDollars?: number;
  stopLossDollars?: number;
  exitTriggerMode?: ExitTriggerMode;
}

export interface RiskStatus {
  dailyPnl: number;
  realizedPnl: number;      // Sum of finalized trades (close_status='filled', needs_reconcile=false) for today ET
  unrealizedPnl: number;    // From current positions (Tradier open_pl)
  maxDailyLoss: number;
  tradeCount: number;
  maxPositions: number;
  killSwitchActive: boolean;
  killSwitchReason?: string;
}

export interface TradeSafeguards {
  maxBidAskSpreadPercent: number;  // 1-20%, default 5%
  zeroDteCloseBufferMinutes: number;  // 15-60, default 30
  fillPriceBufferPercent: number;  // 0-10%, default 2%
  maxCondorsPerExpiry: number;  // Max stacked condors per underlying+expiry, default 3
  maxDailyLossDollars?: number;       // Configurable (was hardcoded $1000)
  maxConsecutiveRejections?: number;  // Default: 5
}

export interface Trade {
  id: string;
  strategyName: string;
  underlying: string;
  entryTime: Date;
  exitTime?: Date;
  entryCredit: number;
  exitDebit?: number;
  pnl: number;
  pnlPercent: number;
  exitReason?: string;
}

export interface BacktestResult {
  strategyName: string;
  startDate: Date;
  endDate: Date;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalPnl: number;
  maxDrawdown: number;
  winRate: number;
  avgWinner: number;
  avgLoser: number;
  profitFactor: number;
  sharpeRatio: number;
  equityCurve: number[];
}

export interface ActivityEvent {
  id: string;
  timestamp: Date;
  type: 'BOT' | 'TRADE' | 'RISK' | 'EMERGENCY' | 'SYSTEM';
  message: string;
}

export type MarketState = 'open' | 'premarket' | 'postmarket' | 'closed' | 'unknown';

export type BadgeVariant = 'green' | 'red' | 'amber' | 'blue' | 'gray';
