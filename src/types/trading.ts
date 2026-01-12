// Trading Types for Claxton Quant Dashboard

export interface Position {
  id: string;
  symbol: string;
  quantity: number;
  costBasis: number;
  currentValue: number;
  expirationDate?: string;
  strategyName?: string;
  strategyType?: string;
  underlying?: string;
  entryCredit?: number;
  status: 'open' | 'pending_close' | 'closed';
  entryTime: Date;
}

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

export interface EntryConditions {
  minDte: number;
  maxDte: number;
  maxDelta: number;
  minPremium?: number;
  minIvRank?: number;
  maxIvRank?: number;
  marketHoursOnly: boolean;
  startTime?: string;
  endTime?: string;
}

export interface ExitConditions {
  profitTargetPercent: number;
  stopLossPercent: number;
  timeStopDte?: number;
  timeStopTime?: string;
  trailingStopPercent?: number;
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
