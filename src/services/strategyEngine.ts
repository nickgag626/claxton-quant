import { supabase } from '@/integrations/supabase/client';
import type { Strategy, Position } from '@/types/trading';

export interface TradeSignal {
  strategyName: string;
  type: string;
  underlying: string;
  expiration: string;
  credit: number;
  legs: {
    symbol: string;
    side: string;
    quantity: number;
  }[];
}

export interface ExitSignal {
  positionId: string;
  symbol: string;
  quantity: number;
  reason: 'profit_target' | 'stop_loss' | 'time_stop';
  pnlPercent?: number;
  dte?: number;
}

export const strategyEngine = {
  async evaluateStrategies(strategies: Strategy[], positions: Position[]): Promise<{
    signals: TradeSignal[];
    marketState: string;
  }> {
    try {
      const { data, error } = await supabase.functions.invoke('strategy-engine', {
        body: {
          action: 'evaluate',
          strategies,
          positions,
        },
      });

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error evaluating strategies:', error);
      return { signals: [], marketState: 'unknown' };
    }
  },

  async executeSignal(signal: TradeSignal & { allowEntryNetting?: boolean }): Promise<{
    success: boolean;
    orderId?: string;
    error?: string;
    blocked?: 'cooldown' | 'conflict';
    entry_conflict?: boolean;
    conflict_symbols?: string[];
    conflictDetails?: string[];
    conflicts?: Array<{
      symbol: string;
      proposedSide: string;
      existingQty: number;
      conflict: string;
      resolution: string;
    }>;
    allow_entry_netting?: boolean;
  }> {
    try {
      const { data, error } = await supabase.functions.invoke('strategy-engine', {
        body: {
          action: 'execute',
          signal,
        },
      });

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error executing signal:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  async checkExits(strategies: Strategy[], positions: Position[]): Promise<{
    exitSignals: ExitSignal[];
    marketState: string;
  }> {
    try {
      const { data, error } = await supabase.functions.invoke('strategy-engine', {
        body: {
          action: 'check_exits',
          strategies,
          positions,
        },
      });

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error checking exits:', error);
      return { exitSignals: [], marketState: 'unknown' };
    }
  },
};
