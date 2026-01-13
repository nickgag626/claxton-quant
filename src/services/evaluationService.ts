import { supabase } from '@/integrations/supabase/client';
import type { StrategyEvaluation, EventType, Decision, Gate, EvaluationInputs, ProposedOrder } from '@/types/evaluation';

// Generate a hash for de-duplication
function generateDecisionHash(config: Record<string, any>, inputs: EvaluationInputs, gates: Gate[]): string {
  const payload = JSON.stringify({ config, inputs, gates: gates.map(g => ({ name: g.name, pass: g.pass })) });
  // Simple hash function
  let hash = 0;
  for (let i = 0; i < payload.length; i++) {
    const char = payload.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

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
    return this.mapToEvaluation(data);
  },

  // Fetch evaluations for a trade group
  async getEvaluationsForTradeGroup(tradeGroupId: string): Promise<StrategyEvaluation[]> {
    const { data, error } = await supabase
      .from('strategy_evaluations')
      .select('*')
      .eq('trade_group_id', tradeGroupId)
      .order('created_at', { ascending: true });

    if (error || !data) return [];
    return data.map(d => this.mapToEvaluation(d));
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
    return data.map(d => this.mapToEvaluation(d));
  },

  // Check if we should save (de-dupe identical evaluations)
  async shouldSaveEvaluation(
    strategyId: string, 
    config: Record<string, any>, 
    inputs: EvaluationInputs, 
    gates: Gate[],
    eventType: EventType
  ): Promise<boolean> {
    // Always save action events
    if (eventType !== 'evaluation') return true;

    const latest = await this.getLatestEvaluation(strategyId);
    if (!latest) return true;

    const newHash = generateDecisionHash(config, inputs, gates);
    const oldHash = generateDecisionHash(
      latest.config_json, 
      latest.inputs_json, 
      latest.gates_json
    );

    // Save if hash changed
    return newHash !== oldHash;
  },

  // Trigger a manual evaluation for a strategy
  async runEvaluation(strategyId: string, options?: { 
    overrideMarketStatus?: string;
    overrideTimeET?: string;
  }): Promise<StrategyEvaluation | null> {
    try {
      const { data, error } = await supabase.functions.invoke('strategy-engine', {
        body: {
          action: 'run_evaluation',
          strategyId,
          overrideMarketStatus: options?.overrideMarketStatus,
          overrideTimeET: options?.overrideTimeET,
        },
      });

      if (error) throw error;
      return data?.evaluation ? this.mapToEvaluation(data.evaluation) : null;
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
    // Check for de-duplication on regular evaluations
    const shouldSave = await this.shouldSaveEvaluation(
      params.strategyId,
      params.configJson,
      params.inputsJson,
      params.gatesJson,
      params.eventType
    );

    if (!shouldSave) {
      console.log('Skipping duplicate evaluation for strategy:', params.strategyId);
      return await this.getLatestEvaluation(params.strategyId);
    }

    const payload: Record<string, unknown> = {
      strategy_id: params.strategyId,
      underlying: params.underlying,
      event_type: params.eventType,
      decision: params.decision,
      reason: params.reason,
      config_json: params.configJson,
      inputs_json: params.inputsJson,
      gates_json: params.gatesJson,
      proposed_order_json: params.proposedOrderJson ?? null,
      trade_group_id: params.tradeGroupId ?? null,
      client_request_id: params.clientRequestId ?? null,
    };

    const { data, error } = await supabase
      .from('strategy_evaluations')
      .insert(payload as any)
      .select()
      .single();

    if (error) {
      console.error('Error saving evaluation:', error);
      return null;
    }
    return this.mapToEvaluation(data);
  },

  // Map DB row to typed evaluation
  mapToEvaluation(data: any): StrategyEvaluation {
    return {
      id: data.id,
      strategy_id: data.strategy_id,
      created_at: data.created_at,
      underlying: data.underlying,
      event_type: data.event_type,
      decision: data.decision,
      reason: data.reason,
      config_json: data.config_json || {},
      inputs_json: data.inputs_json || { market: {}, account: {} },
      gates_json: Array.isArray(data.gates_json) ? data.gates_json : [],
      proposed_order_json: data.proposed_order_json,
      trade_group_id: data.trade_group_id,
      client_request_id: data.client_request_id,
    };
  },
};
