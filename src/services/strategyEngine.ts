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
    pendingVerification?: VerifyFillParams;
    requiresVerification?: boolean;
    tradeGroupId?: string;
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
   * Clean up stale position_group_map entries (older than 24h, no matching broker positions).
   */
  async cleanupMaps(): Promise<{ deletedCount: number; activeSymbolsCount: number }> {
    try {
      const { data, error } = await supabase.functions.invoke('strategy-engine', {
        body: {
          action: 'cleanup_maps',
        },
      });

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('Error cleaning up maps:', error);
      return { deletedCount: 0, activeSymbolsCount: 0 };
    }
  },
};
