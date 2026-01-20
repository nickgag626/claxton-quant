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

// Exit status for ALL positions (shows why positions didn't trigger exit)
export interface ExitStatus {
  tradeGroupId: string | null;
  symbol: string;
  strategyName: string;
  pnlPercent: number;
  profitTargetPercent: number;
  stopLossPercent: number;
  dte?: number;
  timeStopDte?: number;
  triggered: boolean;
  reason: string | null;
  blockedReason?: string;
}

export interface VerifyFillParams {
  orderId: string;
  expectedLegs: { symbol: string; quantity: number; side: string }[];
  tradeGroupId: string;
  strategyName: string;
  strategyType: string;
  underlying: string;
  expiration?: string;
}

export interface VerifyFillResult {
  verified: boolean;
  filledLegs?: string[];
  missingLegs?: string[];
  critical?: boolean;
  orderStatus?: string;
  mappingPersisted?: boolean;
  message?: string;
}

export interface StructureIntegrityResult {
  healthy: boolean;
  brokenGroups: { groupId: string; expected: number; observed: number; strategyType: string }[];
  orphanSymbols: string[];
  reason: string;
}

export interface StrategyEngineError {
  error: true;
  message: string;
  code?: string;
}

export const strategyEngine = {
  async evaluateStrategies(strategies: Strategy[], positions: Position[]): Promise<{
    signals: TradeSignal[];
    marketState: string;
    error?: StrategyEngineError;
  }> {
    try {
      const { data, error } = await supabase.functions.invoke('strategy-engine', {
        body: {
          action: 'evaluate',
          strategies,
          positions,
        },
      });

      if (error) {
        console.error('Error evaluating strategies:', error);
        return {
          signals: [],
          marketState: 'error',
          error: {
            error: true,
            message: error.message || 'Failed to evaluate strategies',
            code: 'EVALUATE_ERROR',
          },
        };
      }
      return data;
    } catch (error) {
      console.error('Error evaluating strategies:', error);
      return {
        signals: [],
        marketState: 'error',
        error: {
          error: true,
          message: error instanceof Error ? error.message : 'Unknown error evaluating strategies',
          code: 'EVALUATE_EXCEPTION',
        },
      };
    }
  },

  async executeSignal(signal: TradeSignal & { allowEntryNetting?: boolean }): Promise<{
    success: boolean;
    orderId?: string;
    error?: string;
    blocked?: 'cooldown' | 'conflict' | 'in_flight';
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
    tradeGroupId?: string;
    // Verified Entry response fields
    verified?: boolean;
    critical?: boolean;
    filledLegs?: string[];
    missingLegs?: string[];
    bailOutOrders?: Array<{
      symbol: string;
      orderId?: string;
      error?: string;
      side: string;
    }>;
    orderStatus?: string;
    mappingPersisted?: boolean;
    message?: string;
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
    exitStatus?: ExitStatus[];
    marketState: string;
    error?: StrategyEngineError;
  }> {
    try {
      const { data, error } = await supabase.functions.invoke('strategy-engine', {
        body: {
          action: 'check_exits',
          strategies,
          positions,
        },
      });

      if (error) {
        console.error('Error checking exits:', error);
        return {
          exitSignals: [],
          marketState: 'error',
          error: {
            error: true,
            message: error.message || 'Failed to check exits',
            code: 'CHECK_EXITS_ERROR',
          },
        };
      }
      return data;
    } catch (error) {
      console.error('Error checking exits:', error);
      return {
        exitSignals: [],
        marketState: 'error',
        error: {
          error: true,
          message: error instanceof Error ? error.message : 'Unknown error checking exits',
          code: 'CHECK_EXITS_EXCEPTION',
        },
      };
    }
  },

  /**
   * Verify that all legs of an order were filled before persisting to position_group_map.
   * Checks order status first (primary source of truth), then verifies positions.
   * If order status is 'filled' but positions not showing, waits extra 5 seconds.
   */
  async verifyFill(params: VerifyFillParams): Promise<VerifyFillResult> {
    try {
      const { data, error } = await supabase.functions.invoke('strategy-engine', {
        body: {
          action: 'verify_fill',
          ...params,
        },
      });

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error verifying fill:', error);
      return { 
        verified: false, 
        critical: false, 
        message: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  },

  /**
   * Check structure integrity of current positions.
   * Returns orphans and broken groups that would block new entries.
   */
  async checkStructureIntegrity(positions: Position[]): Promise<StructureIntegrityResult> {
    try {
      const { data, error } = await supabase.functions.invoke('strategy-engine', {
        body: {
          action: 'check_structure_integrity',
          positions,
        },
      });

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error checking structure integrity:', error);
      return { 
        healthy: true, // Fail open to avoid blocking during errors
        brokenGroups: [], 
        orphanSymbols: [], 
        reason: 'integrity_check_failed' 
      };
    }
  },

  /**
   * Clean up stale position_group_map entries.
   * @param aggressive - If true, deletes ALL mappings for symbols not at broker (no 24h cutoff)
   */
  async cleanupMaps(aggressive: boolean = false): Promise<{ deletedCount: number; activeSymbolsCount: number; aggressive?: boolean }> {
    try {
      const { data, error } = await supabase.functions.invoke('strategy-engine', {
        body: {
          action: 'cleanup_maps',
          aggressive,
        },
      });

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error cleaning up maps:', error);
      return { deletedCount: 0, activeSymbolsCount: 0 };
    }
  },

  /**
   * Delete position_group_map entries for a specific trade group.
   * Call this after a successful close to prevent stale mapping accumulation.
   */
  async deleteGroupMappings(tradeGroupId: string): Promise<{ success: boolean; deletedCount: number }> {
    try {
      const { data, error } = await supabase.functions.invoke('strategy-engine', {
        body: {
          action: 'delete_group_mappings',
          tradeGroupId,
        },
      });

      if (error) throw error;
      return data || { success: true, deletedCount: 0 };
    } catch (error) {
      console.error('Error deleting group mappings:', error);
      return { success: false, deletedCount: 0 };
    }
  },
};
