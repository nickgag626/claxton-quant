import { supabase } from '@/integrations/supabase/client';
import type { StrategyEvaluation, EventType, Decision, Gate, EvaluationInputs, ProposedOrder } from '@/types/evaluation';

export const evaluationService = {
  // Fetch latest evaluation for a strategy
  async getLatestEvaluation(strategyId: string): Promise<StrategyEvaluation | null> {
    const { data, error } = await supabase
      .from('strategy_evaluations')
      .select('*')
      .eq('strategy_id', strategyId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) return null;
    return data as unknown as StrategyEvaluation;
  },

  // Fetch evaluations for a trade group
  async getEvaluationsForTradeGroup(tradeGroupId: string): Promise<StrategyEvaluation[]> {
    const { data, error } = await supabase
      .from('strategy_evaluations')
      .select('*')
      .eq('trade_group_id', tradeGroupId)
      .order('created_at', { ascending: true });

    if (error || !data) return [];
    return data as unknown as StrategyEvaluation[];
  },

  // Fetch recent evaluations for a strategy
  async getRecentEvaluations(strategyId: string, limit = 50): Promise<StrategyEvaluation[]> {
    const { data, error } = await supabase
      .from('strategy_evaluations')
      .select('*')
      .eq('strategy_id', strategyId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return data as unknown as StrategyEvaluation[];
  },

  // Trigger a manual evaluation for a strategy
  async runEvaluation(strategyId: string): Promise<StrategyEvaluation | null> {
    try {
      const { data, error } = await supabase.functions.invoke('strategy-engine', {
        body: {
          action: 'run_evaluation',
          strategyId,
        },
      });

      if (error) throw error;
      return data?.evaluation || null;
    } catch (error) {
      console.error('Error running evaluation:', error);
      return null;
    }
  },

  // Save an evaluation record
  async saveEvaluation(params: {
    strategyId: string;
    underlying: string;
    eventType: EventType;
    decision: Decision;
    reason: string;
    configJson: Record<string, any>;
    inputsJson: EvaluationInputs;
    gatesJson: Gate[];
    proposedOrderJson?: ProposedOrder | null;
    tradeGroupId?: string | null;
    clientRequestId?: string | null;
  }): Promise<StrategyEvaluation | null> {
    const { data, error } = await supabase
      .from('strategy_evaluations')
      .insert({
        strategy_id: params.strategyId,
        underlying: params.underlying,
        event_type: params.eventType,
        decision: params.decision,
        reason: params.reason,
        config_json: params.configJson,
        inputs_json: params.inputsJson,
        gates_json: params.gatesJson,
        proposed_order_json: params.proposedOrderJson,
        trade_group_id: params.tradeGroupId,
        client_request_id: params.clientRequestId,
      })
      .select()
      .single();

    if (error) {
      console.error('Error saving evaluation:', error);
      return null;
    }
    return data as unknown as StrategyEvaluation;
  },
};
