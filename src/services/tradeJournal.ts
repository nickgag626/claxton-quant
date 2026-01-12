import { supabase } from '@/integrations/supabase/client';

export type CloseStatus = 'submitted' | 'filled' | 'rejected' | 'canceled' | 'expired';

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
  pnl: number | null; // NULL if direction unknown or close not filled
  pnl_percent?: number | null;
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
  // Close lifecycle columns
  close_status?: CloseStatus;
  close_submitted_at?: string;
  close_filled_at?: string;
  close_reject_reason?: string;
  close_avg_fill_price?: number;
  close_filled_qty?: number;
}

// Helper to cast DB row to TradeRecord (handles string → CloseStatus)
function castToTradeRecord(row: any): TradeRecord {
  return {
    ...row,
    close_status: row.close_status as CloseStatus | undefined,
  };
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
  needsReconcile?: boolean; // True if any leg needs reconcile
}

export interface TradeStats {
  totalTrades: number;      // Number of VERIFIED trade groups (excludes needs_reconcile)
  totalLegs: number;        // Number of VERIFIED individual legs
  winningTrades: number;    // Groups with pnl > 0 (verified only)
  losingTrades: number;     // Groups with pnl < 0 (verified only)
  totalPnl: number;         // Sum of VERIFIED P&L only
  winRate: number;          // % of winning groups (verified only)
  avgWinner: number;
  avgLoser: number;
  // Reconciliation stats
  needsReconcileCount: number;
  verifiedCount: number;
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
 * HARD RULE: Check if trade has required fields for P&L calculation
 * Returns true if direction is KNOWN AND close is FILLED
 */
export function hasVerifiedDirection(trade: Partial<TradeRecord>): boolean {
  // P&L requires: direction known + close filled
  const hasDirection = Boolean(trade.open_side && trade.close_side && trade.close_order_id);
  const isFilled = trade.close_status === 'filled' || trade.close_status === undefined; // undefined = legacy data
  return hasDirection && isFilled;
}

/**
 * Check if close is pending (submitted but not yet filled/rejected)
 */
export function isClosePending(trade: Partial<TradeRecord>): boolean {
  return trade.close_status === 'submitted';
}

/**
 * Check if close was rejected or failed
 */
export function isCloseRejected(trade: Partial<TradeRecord>): boolean {
  return trade.close_status === 'rejected' || trade.close_status === 'canceled' || trade.close_status === 'expired';
}

/**
 * CANONICAL P&L CALCULATION (options only)
 * Only computes P&L when ALL required fields exist:
 * - open_side (sell_to_open or buy_to_open)
 * - open_price, close_price
 * - quantity, multiplier
 * 
 * NEVER infers direction from price movement.
 * NEVER uses cost_basis for realized P&L.
 */
export function calculatePnl(
  openSide: string,
  openPrice: number,
  closePrice: number,
  quantity: number,
  multiplier: number = 100,
  fees: number = 0
): { pnl: number; pnlPercent: number; formula: string } | null {
  // Validate inputs - never compute with missing data
  if (!openSide || openPrice == null || closePrice == null || !quantity) {
    return null;
  }

  let pnl: number;
  let formula: string;
  
  if (openSide === 'sell_to_open' || openSide === 'sell') {
    // Credit trade: profit when close price < open price
    pnl = (openPrice - closePrice) * quantity * multiplier - fees;
    formula = `(${openPrice.toFixed(4)} - ${closePrice.toFixed(4)}) × ${quantity} × ${multiplier} - ${fees.toFixed(2)} = ${pnl.toFixed(2)}`;
  } else if (openSide === 'buy_to_open' || openSide === 'buy') {
    // Debit trade: profit when close price > open price
    pnl = (closePrice - openPrice) * quantity * multiplier - fees;
    formula = `(${closePrice.toFixed(4)} - ${openPrice.toFixed(4)}) × ${quantity} × ${multiplier} - ${fees.toFixed(2)} = ${pnl.toFixed(2)}`;
  } else {
    // Unknown direction - NEVER guess
    return null;
  }
  
  const cost = openPrice * quantity * multiplier;
  const pnlPercent = cost > 0 ? (pnl / cost) * 100 : 0;
  
  return { pnl, pnlPercent, formula };
}

export const tradeJournal = {
  /**
   * Save a single trade with proper deduplication by close_order_id
   * HARD RULE: If direction unknown, pnl = NULL and needs_reconcile = true
   */
  async saveTrade(trade: Omit<TradeRecord, 'id'>): Promise<{ success: boolean; error?: string; id?: string; duplicate?: boolean }> {
    try {
      // Check idempotency: if (symbol, close_order_id) exists, skip insert
      if (trade.close_order_id) {
        const { data: existing } = await supabase
          .from('trades')
          .select('id')
          .eq('symbol', trade.symbol)
          .eq('close_order_id', trade.close_order_id)
          .maybeSingle();
        
        if (existing) {
          console.log('Trade already exists (idempotent check):', trade.symbol, trade.close_order_id);
          return { success: true, duplicate: true, id: existing.id };
        }
      }

      // Determine if we can compute P&L
      const canComputePnl = hasVerifiedDirection(trade) && 
                            trade.entry_price != null && 
                            trade.exit_price != null;
      
      let pnl: number | null = null;
      let pnlPercent: number | null = null;
      let pnlFormula: string | null = null;
      let needsReconcile = true;
      
      if (canComputePnl && trade.open_side) {
        const calc = calculatePnl(
          trade.open_side,
          trade.entry_price,
          trade.exit_price,
          trade.quantity,
          trade.multiplier || 100,
          trade.fees || 0
        );
        
        if (calc) {
          pnl = calc.pnl;
          pnlPercent = calc.pnlPercent;
          pnlFormula = calc.formula;
          needsReconcile = false;
        }
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
          pnl, // NULL if direction unknown
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
          console.warn('Duplicate trade detected (DB constraint):', trade.symbol, trade.close_order_id);
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
        const canComputePnl = hasVerifiedDirection(trade) && 
                              trade.entry_price != null && 
                              trade.exit_price != null;
        
        let pnl: number | null = null;
        let pnlPercent: number | null = null;
        let pnlFormula: string | null = null;
        let needsReconcile = true;
        
        if (canComputePnl && trade.open_side) {
          const calc = calculatePnl(
            trade.open_side,
            trade.entry_price,
            trade.exit_price,
            trade.quantity,
            trade.multiplier || 100,
            trade.fees || 0
          );
          
          if (calc) {
            pnl = calc.pnl;
            pnlPercent = calc.pnlPercent;
            pnlFormula = calc.formula;
            needsReconcile = false;
          }
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
      return (data || []).map(castToTradeRecord);
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
      
      const trades = (data || []).map(castToTradeRecord);
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
            // Only sum verified P&L (not null)
            const verifiedLegs = groupTrades.filter(t => t.pnl != null && !t.needs_reconcile);
            const totalPnl = verifiedLegs.reduce((sum, t) => sum + Number(t.pnl), 0);
            const hasUnverified = groupTrades.some(t => t.needs_reconcile);
            
            const group: TradeGroup = {
              groupId: trade.trade_group_id,
              trades: groupTrades.sort((a, b) => a.symbol.localeCompare(b.symbol)),
              totalPnl,
              strategyName: groupTrades[0].strategy_name,
              strategyType: groupTrades[0].strategy_type,
              underlying: groupTrades[0].underlying,
              exitTime: groupTrades[0].exit_time,
              exitReason: groupTrades[0].exit_reason,
              needsReconcile: hasUnverified,
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
   * Get stats - ONLY includes VERIFIED trades (needs_reconcile = false AND pnl IS NOT NULL)
   * Excludes trades with unknown direction from all totals
   */
  async getTradeStats(countByLeg: boolean = false): Promise<TradeStats> {
    try {
      const { data, error } = await supabase
        .from('trades')
        .select('pnl, trade_group_id, needs_reconcile');

      if (error) throw error;

      const trades = data || [];
      
      // Separate verified and unverified
      const verifiedTrades = trades.filter(t => !t.needs_reconcile && t.pnl != null);
      const unverifiedCount = trades.filter(t => t.needs_reconcile || t.pnl == null).length;
      
      const totalLegsVerified = verifiedTrades.length;
      
      if (countByLeg) {
        // Count individual verified legs only
        const winners = verifiedTrades.filter(t => Number(t.pnl) > 0);
        const losers = verifiedTrades.filter(t => Number(t.pnl) < 0);
        const totalPnl = verifiedTrades.reduce((sum, t) => sum + Number(t.pnl), 0);
        const avgWinner = winners.length > 0 
          ? winners.reduce((sum, t) => sum + Number(t.pnl), 0) / winners.length 
          : 0;
        const avgLoser = losers.length > 0 
          ? losers.reduce((sum, t) => sum + Number(t.pnl), 0) / losers.length 
          : 0;

        return {
          totalTrades: totalLegsVerified,
          totalLegs: totalLegsVerified,
          winningTrades: winners.length,
          losingTrades: losers.length,
          totalPnl,
          winRate: totalLegsVerified > 0 ? (winners.length / totalLegsVerified) * 100 : 0,
          avgWinner,
          avgLoser,
          needsReconcileCount: unverifiedCount,
          verifiedCount: totalLegsVerified,
        };
      }
      
      // Group by trade_group_id (default - count strategies)
      // Only include groups where ALL legs are verified
      const grouped = new Map<string, { pnl: number; hasUnverified: boolean }>();
      let singleTradeIndex = 0;
      
      trades.forEach(t => {
        const groupKey = t.trade_group_id || `single_${singleTradeIndex++}`;
        const existing = grouped.get(groupKey) || { pnl: 0, hasUnverified: false };
        
        if (t.needs_reconcile || t.pnl == null) {
          existing.hasUnverified = true;
        } else {
          existing.pnl += Number(t.pnl);
        }
        
        grouped.set(groupKey, existing);
      });

      // Only count fully verified groups
      const verifiedGroups = Array.from(grouped.entries())
        .filter(([_, g]) => !g.hasUnverified);
      
      const groupPnls = verifiedGroups.map(([_, g]) => g.pnl);
      const winners = groupPnls.filter(pnl => pnl > 0);
      const losers = groupPnls.filter(pnl => pnl < 0);
      
      const totalPnl = groupPnls.reduce((sum, pnl) => sum + pnl, 0);
      const avgWinner = winners.length > 0 
        ? winners.reduce((sum, pnl) => sum + pnl, 0) / winners.length 
        : 0;
      const avgLoser = losers.length > 0 
        ? losers.reduce((sum, pnl) => sum + pnl, 0) / losers.length 
        : 0;

      // Count unverified groups
      const unverifiedGroups = Array.from(grouped.entries())
        .filter(([_, g]) => g.hasUnverified).length;

      return {
        totalTrades: verifiedGroups.length,
        totalLegs: totalLegsVerified,
        winningTrades: winners.length,
        losingTrades: losers.length,
        totalPnl,
        winRate: verifiedGroups.length > 0 ? (winners.length / verifiedGroups.length) * 100 : 0,
        avgWinner,
        avgLoser,
        needsReconcileCount: unverifiedGroups,
        verifiedCount: verifiedGroups.length,
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
        needsReconcileCount: 0,
        verifiedCount: 0,
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

  // manualOverride has been REMOVED - direction must be inferred automatically from Tradier executions

  /**
   * Recalculate P&L for trades with verified direction
   * DOES NOT compute P&L if direction is unknown - marks needs_reconcile instead
   */
  async recalculatePnl(): Promise<{ success: boolean; updated: number; skipped: number; errors: string[] }> {
    try {
      const { data: trades, error } = await supabase
        .from('trades')
        .select('*');

      if (error) throw error;

      let updated = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (const row of trades || []) {
        const trade = castToTradeRecord(row);
        // Check if we have verified direction
        if (!hasVerifiedDirection(trade)) {
          // Mark as needs reconcile, set pnl to NULL
          if (!trade.needs_reconcile || trade.pnl != null) {
            await supabase.from('trades').update({ 
              needs_reconcile: true,
              pnl: null,
              pnl_percent: null,
              pnl_formula: null,
            }).eq('id', trade.id);
            skipped++;
          } else {
            skipped++;
          }
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

        if (!calc) {
          errors.push(`Trade ${trade.id?.slice(0, 8)} (${trade.symbol}): P&L calculation failed`);
          await supabase.from('trades').update({ 
            needs_reconcile: true,
            pnl: null,
            pnl_percent: null,
            pnl_formula: null,
          }).eq('id', trade.id);
          skipped++;
          continue;
        }

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

      return { success: true, updated, skipped, errors };
    } catch (error) {
      console.error('Error recalculating P&L:', error);
      return { 
        success: false, 
        updated: 0, 
        skipped: 0,
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
              pnl: Number(trade.pnl || 0),
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
   * Get trades that need reconciliation (missing verified direction)
   */
  async getTradesNeedingReconciliation(): Promise<TradeRecord[]> {
    try {
      const { data, error } = await supabase
        .from('trades')
        .select('*')
        .eq('needs_reconcile', true)
        .order('exit_time', { ascending: false });

      if (error) throw error;
      return (data || []).map(castToTradeRecord);
    } catch (error) {
      console.error('Error fetching trades needing reconciliation:', error);
      return [];
    }
  },

  /**
   * Save a pending close (when order is submitted but not yet filled)
   */
  async savePendingClose(tradeData: {
    symbol: string;
    underlying: string;
    close_order_id: string;
    close_side: string;
    quantity: number;
    entry_price: number;
    entry_time: string;
    open_side?: string;
    open_order_id?: string;
    strategy_name?: string;
    strategy_type?: string;
    exit_reason?: string;
    trade_group_id?: string;
  }): Promise<{ success: boolean; error?: string; id?: string }> {
    try {
      // Check if already exists
      const { data: existing } = await supabase
        .from('trades')
        .select('id')
        .eq('symbol', tradeData.symbol)
        .eq('close_order_id', tradeData.close_order_id)
        .maybeSingle();

      if (existing) {
        console.log('Pending close already exists:', tradeData.symbol, tradeData.close_order_id);
        return { success: true, id: existing.id };
      }

      const { data, error } = await supabase
        .from('trades')
        .insert({
          symbol: tradeData.symbol,
          underlying: tradeData.underlying,
          strategy_name: tradeData.strategy_name,
          strategy_type: tradeData.strategy_type,
          quantity: tradeData.quantity,
          entry_time: tradeData.entry_time,
          entry_price: tradeData.entry_price,
          exit_price: 0, // Unknown until filled
          exit_time: null, // Not set until filled
          pnl: null, // Not computed until filled
          pnl_percent: null,
          exit_reason: tradeData.exit_reason,
          trade_group_id: tradeData.trade_group_id,
          open_side: tradeData.open_side,
          close_side: tradeData.close_side,
          open_order_id: tradeData.open_order_id,
          close_order_id: tradeData.close_order_id,
          needs_reconcile: true,
          close_status: 'submitted',
          close_submitted_at: new Date().toISOString(),
          multiplier: 100,
          fees: 0,
        })
        .select('id')
        .single();

      if (error) {
        if (error.code === '23505') {
          return { success: true }; // Duplicate, ok
        }
        throw error;
      }
      return { success: true, id: data?.id };
    } catch (error) {
      console.error('Error saving pending close:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  /**
   * Update close status after verifying with Tradier
   */
  async updateCloseStatus(
    closeOrderId: string,
    status: CloseStatus,
    details?: {
      avgFillPrice?: number;
      filledQty?: number;
      rejectReason?: string;
      open_side?: string;
      fees?: number;
    }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { data: trades, error: fetchError } = await supabase
        .from('trades')
        .select('*')
        .eq('close_order_id', closeOrderId);

      if (fetchError) throw fetchError;
      if (!trades || trades.length === 0) {
        return { success: false, error: 'Trade not found for close_order_id' };
      }

      for (const row of trades) {
        const trade = castToTradeRecord(row);
        const updates: Record<string, any> = { close_status: status };

        if (status === 'filled') {
          updates.close_filled_at = new Date().toISOString();
          updates.exit_time = new Date().toISOString();
          
          if (details?.avgFillPrice != null) {
            updates.close_avg_fill_price = details.avgFillPrice;
            updates.exit_price = details.avgFillPrice;
          }
          if (details?.filledQty != null) {
            updates.close_filled_qty = details.filledQty;
            updates.quantity = details.filledQty;
          }
          if (details?.open_side) {
            updates.open_side = details.open_side;
          }
          if (details?.fees != null) {
            updates.fees = details.fees;
          }

          // Compute P&L if we have all required data
          const openSide = details?.open_side || trade.open_side;
          const openPrice = trade.entry_price;
          const closePrice = details?.avgFillPrice ?? trade.exit_price;
          const qty = details?.filledQty ?? trade.quantity;
          const fees = details?.fees ?? trade.fees ?? 0;

          if (openSide && openPrice && closePrice && qty) {
            const pnlCalc = calculatePnl(openSide, openPrice, closePrice, qty, 100, fees);
            if (pnlCalc) {
              updates.pnl = pnlCalc.pnl;
              updates.pnl_percent = pnlCalc.pnlPercent;
              updates.pnl_formula = pnlCalc.formula;
              updates.needs_reconcile = false;
            }
          }
        } else if (status === 'rejected' || status === 'canceled' || status === 'expired') {
          updates.close_reject_reason = details?.rejectReason || status;
          // Do NOT set exit_time, exit_price, pnl - trade is still open
          updates.pnl = null;
          updates.needs_reconcile = true;
        }

        const { error: updateError } = await supabase
          .from('trades')
          .update(updates)
          .eq('id', trade.id);

        if (updateError) {
          console.error('Error updating close status:', updateError);
        }
      }

      return { success: true };
    } catch (error) {
      console.error('Error updating close status:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  /**
   * Get trades with pending closes that need status check
   */
  async getTradesWithPendingClose(): Promise<TradeRecord[]> {
    try {
      const { data, error } = await supabase
        .from('trades')
        .select('*')
        .eq('close_status', 'submitted')
        .order('close_submitted_at', { ascending: true });

      if (error) throw error;
      return (data || []).map(castToTradeRecord);
    } catch (error) {
      console.error('Error fetching trades with pending close:', error);
      return [];
    }
  },
};
