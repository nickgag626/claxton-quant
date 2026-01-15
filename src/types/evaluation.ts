// Strategy Evaluation / Audit Trail Types

export type EventType = 
  | 'evaluation' 
  | 'entry_attempt' 
  | 'entry_submitted' 
  | 'entry_filled' 
  | 'exit_attempt' 
  | 'exit_filled' 
  | 'exit_rejected'
  | 'exit_blocked'
  | 'exit_detected'
  | 'critical_auto_reconcile';

export type Decision = 'PASS' | 'FAIL' | 'OPEN' | 'SKIP' | 'CLOSE' | 'HOLD';

export interface Gate {
  name: string;
  expected: string;
  actual: Record<string, any> | string | number | boolean;
  pass: boolean;
  reason?: string;
}

export interface MarketInputs {
  now_et: string;
  underlying_price: number;
  dte_selected?: number;
  expiration_selected?: string;
  chain_slice?: {
    symbol: string;
    strike: number;
    delta: number;
    bid: number;
    ask: number;
    option_type: string;
  }[];
  iv_rank?: number;
  iv_value?: number;
  sma20?: number;
  sma50?: number;
  sma200?: number;
  candle_metadata?: {
    asOfDate: string;
    barCount: number;
  };
}

export interface AccountInputs {
  account_equity?: number;
  buying_power?: number;
  open_positions_count: number;
  max_positions: number;
}

export interface EvaluationInputs {
  market: MarketInputs;
  account: AccountInputs;
}

export interface ProposedOrderLeg {
  role: string;
  option_symbol?: string;
  strike: number;
  delta: number;
  side: string;
  quantity: number;
}

export interface ProposedOrder {
  legs: ProposedOrderLeg[];
  estimated_credit?: number;
  estimated_debit?: number;
  estimated_max_loss?: number;
  entry_rationale?: string;
  sizing_result?: {
    mode: string;
    computed_contracts: number;
    risk_per_trade?: number;
  };
}

export interface StrategyEvaluation {
  id: string;
  strategy_id: string;
  created_at: string;
  underlying: string;
  event_type: EventType;
  decision: Decision;
  reason: string | null;
  config_json: Record<string, any>;
  inputs_json: EvaluationInputs;
  gates_json: Gate[];
  proposed_order_json: ProposedOrder | null;
  trade_group_id: string | null;
  client_request_id: string | null;
}

export interface EvaluationResult {
  decision: Decision;
  reason: string;
  gates: Gate[];
  inputs: EvaluationInputs;
  proposedOrder?: ProposedOrder;
}
