import { supabase } from '@/integrations/supabase/client';

export interface TradeRecord {
  id?: string;
  symbol: string;
  underlying: string;
  strategy_name?: string;
  strategy_type?: string;
  quantity: number;
  entry_time: string;
  exit_time?: string;
  entry_price: number;
  exit_price: number;
  entry_credit?: number;
  exit_debit?: number;
  pnl: number;
  pnl_percent?: number;
  exit_reason?: string;
  notes?: string;
  trade_group_id?: string;
  // Audit columns
  open_side?: string;
  close_side?: string;
  open_order_id?: string;
  close_order_id?: string;
  fees?: number;
  multiplier?: number;
  pnl_formula?: string;
  needs_reconcile?: boolean;
}

export interface TradeGroup {
  groupId: string;
  trades: TradeRecord[];
  totalPnl: number;
  strategyName?: string;
  strategyType?: string;
  underlying: string;
  exitTime?: string;
  exitReason?: string;
}

export interface TradeStats {
  totalTrades: number;      // Number of trade groups (strategies)
  totalLegs: number;        // Number of individual legs
  winningTrades: number;    // Groups with pnl > 0
  losingTrades: number;     // Groups with pnl < 0
  totalPnl: number;         // Sum of all realized P&L
  winRate: number;          // % of winning groups
  avgWinner: number;
  avgLoser: number;
}

export interface DuplicateCandidate {
  id: string;
  symbol: string;
  close_order_id?: string;
  exit_time: string;
  pnl: number;
  reason: string;
}

/**
 * Calculate P&L based on fills-derived entry/exit prices
 * open_side = 'sell_to_open': pnl = (open_price - close_price) * qty * multiplier - fees
 * open_side = 'buy_to_open': pnl = (close_price - open_price) * qty * multiplier - fees
 */
export function calculatePnl(
  openSide: string,
  openPrice: number,
  closePrice: number,
  quantity: number,
  multiplier: number = 100,
  fees: number = 0
): { pnl: number; pnlPercent: number; formula: string } {
  let pnl: number;
  let formula: string;
  
  if (openSide === 'sell_to_open' || openSide === 'sell') {
    // Credit trade: profit when close price < open price
    pnl = (openPrice - closePrice) * quantity * multiplier - fees;
    formula = `(${openPrice.toFixed(4)} - ${closePrice.toFixed(4)}) × ${quantity} × ${multiplier} - ${fees.toFixed(2)} = ${pnl.toFixed(2)}`;
  } else {
    // Debit trade: profit when close price > open price
    pnl = (closePrice - openPrice) * quantity * multiplier - fees;
    formula = `(${closePrice.toFixed(4)} - ${openPrice.toFixed(4)}) × ${quantity} × ${multiplier} - ${fees.toFixed(2)} = ${pnl.toFixed(2)}`;
  }
  
  const cost = openPrice * quantity * multiplier;
  const pnlPercent = cost > 0 ? (pnl / cost) * 100 : 0;
  
  return { pnl, pnlPercent, formula };
}

export const tradeJournal = {
  /**
   * Save a single trade with proper deduplication by close_order_id
   */
  async saveTrade(trade: Omit<TradeRecord, 'id'>): Promise<{ success: boolean; error?: string; id?: string; duplicate?: boolean }> {
    try {
      // Calculate P&L from fills if we have the data
      let pnl = trade.pnl;
      let pnlPercent = trade.pnl_percent;
      let pnlFormula = trade.pnl_formula;
      let needsReconcile = false;
      
      if (trade.open_side && trade.entry_price && trade.exit_price) {
        const calc = calculatePnl(
          trade.open_side,
          trade.entry_price,
          trade.exit_price,
          trade.quantity,
          trade.multiplier || 100,
          trade.fees || 0
        );
        pnl = calc.pnl;
        pnlPercent = calc.pnlPercent;
        pnlFormula = calc.formula;
      } else {
        // Missing critical fields - mark for reconciliation
        needsReconcile = true;
      }

      const { data, error } = await supabase
        .from('trades')
        .insert({
          symbol: trade.symbol,
          underlying: trade.underlying,
          strategy_name: trade.strategy_name,
          strategy_type: trade.strategy_type,
          quantity: trade.quantity,
          entry_time: trade.entry_time,
          exit_time: trade.exit_time || new Date().toISOString(),
          entry_price: trade.entry_price,
          exit_price: trade.exit_price,
          entry_credit: trade.entry_credit,
          exit_debit: trade.exit_debit,
          pnl,
          pnl_percent: pnlPercent,
          exit_reason: trade.exit_reason,
          notes: trade.notes,
          trade_group_id: trade.trade_group_id,
          open_side: trade.open_side,
          close_side: trade.close_side,
          open_order_id: trade.open_order_id,
          close_order_id: trade.close_order_id,
          fees: trade.fees || 0,
          multiplier: trade.multiplier || 100,
          pnl_formula: pnlFormula,
          needs_reconcile: needsReconcile,
        })
        .select('id')
        .single();

      if (error) {
        // Check for unique constraint violation (duplicate close_order_id)
        if (error.code === '23505') {
          console.warn('Duplicate trade detected (same close_order_id), skipping:', trade.symbol, trade.close_order_id);
          return { success: true, duplicate: true };
        }
        throw error;
      }
      return { success: true, id: data?.id };
    } catch (error) {
      console.error('Error saving trade:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  /**
   * Save multiple trades as a group (for spreads, iron condors, etc.)
   */
  async saveTradeGroup(trades: Omit<TradeRecord, 'id' | 'trade_group_id'>[]): Promise<{ success: boolean; error?: string; groupId?: string }> {
    if (trades.length === 0) return { success: false, error: 'No trades to save' };
    
    const groupId = crypto.randomUUID();
    
    try {
      const tradesWithPnl = trades.map(trade => {
        let pnl = trade.pnl;
        let pnlPercent = trade.pnl_percent;
        let pnlFormula = trade.pnl_formula;
        let needsReconcile = false;
        
        if (trade.open_side && trade.entry_price && trade.exit_price) {
          const calc = calculatePnl(
            trade.open_side,
            trade.entry_price,
            trade.exit_price,
            trade.quantity,
            trade.multiplier || 100,
            trade.fees || 0
          );
          pnl = calc.pnl;
          pnlPercent = calc.pnlPercent;
          pnlFormula = calc.formula;
        } else {
          needsReconcile = true;
        }
        
        return {
          symbol: trade.symbol,
          underlying: trade.underlying,
          strategy_name: trade.strategy_name,
          strategy_type: trade.strategy_type,
          quantity: trade.quantity,
          entry_time: trade.entry_time,
          exit_time: trade.exit_time || new Date().toISOString(),
          entry_price: trade.entry_price,
          exit_price: trade.exit_price,
          entry_credit: trade.entry_credit,
          exit_debit: trade.exit_debit,
          pnl,
          pnl_percent: pnlPercent,
          exit_reason: trade.exit_reason,
          notes: trade.notes,
          trade_group_id: groupId,
          open_side: trade.open_side,
          close_side: trade.close_side,
          open_order_id: trade.open_order_id,
          close_order_id: trade.close_order_id,
          fees: trade.fees || 0,
          multiplier: trade.multiplier || 100,
          pnl_formula: pnlFormula,
          needs_reconcile: needsReconcile,
        };
      });

      const { error } = await supabase
        .from('trades')
        .insert(tradesWithPnl);

      if (error) {
        if (error.code === '23505') {
          console.warn('Duplicate trade group detected, some legs may have been skipped');
          return { success: true, groupId };
        }
        throw error;
      }
      return { success: true, groupId };
    } catch (error) {
      console.error('Error saving trade group:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  async getTrades(limit = 100): Promise<TradeRecord[]> {
    try {
      const { data, error } = await supabase
        .from('trades')
        .select('*')
        .order('exit_time', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error fetching trades:', error);
      return [];
    }
  },

  async getGroupedTrades(limit = 50): Promise<(TradeRecord | TradeGroup)[]> {
    try {
      const { data, error } = await supabase
        .from('trades')
        .select('*')
        .order('exit_time', { ascending: false })
        .limit(limit * 4);

      if (error) throw error;
      
      const trades = data || [];
      const grouped = new Map<string, TradeRecord[]>();

      trades.forEach(trade => {
        if (trade.trade_group_id) {
          const existing = grouped.get(trade.trade_group_id) || [];
          existing.push(trade);
          grouped.set(trade.trade_group_id, existing);
        }
      });

      const result: (TradeRecord | TradeGroup)[] = [];
      const processedGroupIds = new Set<string>();

      trades.forEach(trade => {
        if (trade.trade_group_id) {
          if (!processedGroupIds.has(trade.trade_group_id)) {
            const groupTrades = grouped.get(trade.trade_group_id)!;
            const group: TradeGroup = {
              groupId: trade.trade_group_id,
              trades: groupTrades.sort((a, b) => a.symbol.localeCompare(b.symbol)),
              totalPnl: groupTrades.reduce((sum, t) => sum + Number(t.pnl), 0),
              strategyName: groupTrades[0].strategy_name,
              strategyType: groupTrades[0].strategy_type,
              underlying: groupTrades[0].underlying,
              exitTime: groupTrades[0].exit_time,
              exitReason: groupTrades[0].exit_reason,
            };
            result.push(group);
            processedGroupIds.add(trade.trade_group_id);
          }
        } else {
          result.push(trade);
        }
      });

      return result.slice(0, limit);
    } catch (error) {
      console.error('Error fetching grouped trades:', error);
      return [];
    }
  },

  /**
   * Get stats - can toggle between counting by strategy group vs by individual leg
   */
  async getTradeStats(countByLeg: boolean = false): Promise<TradeStats> {
    try {
      const { data, error } = await supabase
        .from('trades')
        .select('pnl, trade_group_id');

      if (error) throw error;

      const trades = data || [];
      const totalLegs = trades.length;
      
      if (countByLeg) {
        // Count individual legs
        const winners = trades.filter(t => Number(t.pnl) > 0);
        const losers = trades.filter(t => Number(t.pnl) < 0);
        const totalPnl = trades.reduce((sum, t) => sum + Number(t.pnl), 0);
        const avgWinner = winners.length > 0 
          ? winners.reduce((sum, t) => sum + Number(t.pnl), 0) / winners.length 
          : 0;
        const avgLoser = losers.length > 0 
          ? losers.reduce((sum, t) => sum + Number(t.pnl), 0) / losers.length 
          : 0;

        return {
          totalTrades: totalLegs,
          totalLegs,
          winningTrades: winners.length,
          losingTrades: losers.length,
          totalPnl,
          winRate: totalLegs > 0 ? (winners.length / totalLegs) * 100 : 0,
          avgWinner,
          avgLoser,
        };
      }
      
      // Group by trade_group_id (default - count strategies)
      const grouped = new Map<string, number>();
      let singleTradeIndex = 0;
      
      trades.forEach(t => {
        const groupKey = t.trade_group_id || `single_${singleTradeIndex++}`;
        const currentPnl = grouped.get(groupKey) || 0;
        grouped.set(groupKey, currentPnl + Number(t.pnl));
      });

      const groupPnls = Array.from(grouped.values());
      const winners = groupPnls.filter(pnl => pnl > 0);
      const losers = groupPnls.filter(pnl => pnl < 0);
      
      const totalPnl = groupPnls.reduce((sum, pnl) => sum + pnl, 0);
      const avgWinner = winners.length > 0 
        ? winners.reduce((sum, pnl) => sum + pnl, 0) / winners.length 
        : 0;
      const avgLoser = losers.length > 0 
        ? losers.reduce((sum, pnl) => sum + pnl, 0) / losers.length 
        : 0;

      return {
        totalTrades: groupPnls.length,
        totalLegs,
        winningTrades: winners.length,
        losingTrades: losers.length,
        totalPnl,
        winRate: groupPnls.length > 0 ? (winners.length / groupPnls.length) * 100 : 0,
        avgWinner,
        avgLoser,
      };
    } catch (error) {
      console.error('Error fetching trade stats:', error);
      return {
        totalTrades: 0,
        totalLegs: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalPnl: 0,
        winRate: 0,
        avgWinner: 0,
        avgLoser: 0,
      };
    }
  },

  async updateTradeNotes(tradeId: string, notes: string): Promise<{ success: boolean; error?: string }> {
    try {
      const { error } = await supabase
        .from('trades')
        .update({ notes })
        .eq('id', tradeId);

      if (error) throw error;
      return { success: true };
    } catch (error) {
      console.error('Error updating trade notes:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  /**
   * Recalculate P&L for all trades using stored open_side, prices, qty
   */
  async recalculatePnl(): Promise<{ success: boolean; updated: number; errors: string[] }> {
    try {
      const { data: trades, error } = await supabase
        .from('trades')
        .select('*');

      if (error) throw error;

      let updated = 0;
      const errors: string[] = [];

      for (const trade of trades || []) {
        if (!trade.open_side) {
          errors.push(`Trade ${trade.id?.slice(0, 8)} (${trade.symbol}): missing open_side - marked needs_reconcile`);
          await supabase.from('trades').update({ needs_reconcile: true }).eq('id', trade.id);
          continue;
        }

        const calc = calculatePnl(
          trade.open_side,
          Number(trade.entry_price),
          Number(trade.exit_price),
          Number(trade.quantity),
          Number(trade.multiplier) || 100,
          Number(trade.fees) || 0
        );

        const { error: updateError } = await supabase
          .from('trades')
          .update({
            pnl: calc.pnl,
            pnl_percent: calc.pnlPercent,
            pnl_formula: calc.formula,
            needs_reconcile: false,
          })
          .eq('id', trade.id);

        if (updateError) {
          errors.push(`Trade ${trade.id}: ${updateError.message}`);
        } else {
          updated++;
        }
      }

      return { success: true, updated, errors };
    } catch (error) {
      console.error('Error recalculating P&L:', error);
      return { 
        success: false, 
        updated: 0, 
        errors: [error instanceof Error ? error.message : 'Unknown error'] 
      };
    }
  },

  /**
   * Detect duplicate trades based on close_order_id (safe, non-destructive)
   */
  async detectDuplicates(): Promise<{ candidates: DuplicateCandidate[]; error?: string }> {
    try {
      const { data: trades, error } = await supabase
        .from('trades')
        .select('id, symbol, close_order_id, exit_time, pnl')
        .order('exit_time', { ascending: true });

      if (error) throw error;

      const candidates: DuplicateCandidate[] = [];
      const seenByOrderId = new Map<string, string>(); // close_order_id -> first trade id
      
      for (const trade of trades || []) {
        if (trade.close_order_id) {
          const key = `${trade.symbol}:${trade.close_order_id}`;
          if (seenByOrderId.has(key)) {
            // This is a duplicate - same symbol + close_order_id
            candidates.push({
              id: trade.id,
              symbol: trade.symbol,
              close_order_id: trade.close_order_id,
              exit_time: trade.exit_time,
              pnl: Number(trade.pnl),
              reason: `Duplicate close_order_id (first: ${seenByOrderId.get(key)?.slice(0, 8)})`,
            });
          } else {
            seenByOrderId.set(key, trade.id);
          }
        }
      }

      return { candidates };
    } catch (error) {
      console.error('Error detecting duplicates:', error);
      return { 
        candidates: [], 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  },

  /**
   * Delete specific duplicate trades by ID (requires explicit confirmation)
   */
  async deleteDuplicates(tradeIds: string[]): Promise<{ success: boolean; deleted: number; error?: string }> {
    if (tradeIds.length === 0) return { success: true, deleted: 0 };

    try {
      const { error } = await supabase
        .from('trades')
        .delete()
        .in('id', tradeIds);

      if (error) throw error;
      return { success: true, deleted: tradeIds.length };
    } catch (error) {
      console.error('Error deleting duplicates:', error);
      return { 
        success: false, 
        deleted: 0, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  },

  /**
   * Get trades that need reconciliation (missing open_side, close_order_id, etc.)
   */
  async getTradesNeedingReconciliation(): Promise<TradeRecord[]> {
    try {
      const { data, error } = await supabase
        .from('trades')
        .select('*')
        .eq('needs_reconcile', true)
        .order('exit_time', { ascending: false });

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error fetching trades needing reconciliation:', error);
      return [];
    }
  },
};
