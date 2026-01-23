import { supabase } from '@/integrations/supabase/client';
import { inferLegSides, getInferredSide, computeNetExitDebit, type InferredLeg } from '@/lib/legSideInference';

export type CloseStatus = 'submitted' | 'filled' | 'rejected' | 'canceled' | 'expired' | 'timeout_unknown';

// Order timeout - after 60 seconds in 'submitted' status, mark as timeout_unknown
export const ORDER_TIMEOUT_MS = 60 * 1000;

export type PnlStatus = 'pending' | 'computed' | 'final' | 'missing_fills';

// Exit price source - how exit_debit was calculated
// PER_LEG: Direction-aware sum of individual leg fill prices
// COMBO_NET: Combo order's net fill price from Tradier
// PARTIAL: Some legs missing fill data, needs reconciliation
export type ExitPriceSource = 'PER_LEG' | 'COMBO_NET' | 'PARTIAL';

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
  exit_price?: number; // NULL/undefined for submitted trades, set when filled
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
  // Immutable P&L tracking columns
  pnl_status?: PnlStatus;
  entry_credit_dollars?: number;
  exit_debit_dollars?: number;
  pnl_computed_at?: string;
  // Exit price source tracking
  exit_price_source?: ExitPriceSource;
  // Exit trigger vs realized outcome separation
  exit_trigger_reason?: string; // Why exit was initiated (mark-based decision)
}

// Helper to cast DB row to TradeRecord (handles string → CloseStatus, PnlStatus, ExitPriceSource)
function castToTradeRecord(row: any): TradeRecord {
  return {
    ...row,
    close_status: row.close_status as CloseStatus | undefined,
    pnl_status: row.pnl_status as PnlStatus | undefined,
    exit_price_source: row.exit_price_source as ExitPriceSource | undefined,
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
  exitTriggerReason?: string; // Why exit was initiated (mark-based decision)
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
  const isFilled = trade.close_status === 'filled';
  // Legacy data (undefined close_status) should NOT be included in verified - it must be explicitly filled
  return hasDirection && isFilled;
}

/**
 * HARD RULE: Check if trade is fully finalized and can be included in stats
 * A trade is finalized when:
 * - close_status = 'filled'
 * - needs_reconcile = false
 * - pnl IS NOT NULL
 */
export function isFullyFinalized(trade: Partial<TradeRecord>): boolean {
  return (
    trade.close_status === 'filled' &&
    trade.needs_reconcile === false &&
    trade.pnl != null
  );
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
  return trade.close_status === 'rejected' || trade.close_status === 'canceled' || trade.close_status === 'expired' || trade.close_status === 'timeout_unknown';
}

/**
 * Check if close timed out (order status unknown after 60s)
 */
export function isCloseTimedOut(trade: Partial<TradeRecord>): boolean {
  return trade.close_status === 'timeout_unknown';
}

/**
 * Check if trade has complete fill data for immutable P&L calculation
 * Returns true if we have actual fill prices (not inferred values)
 */
export function hasCompleteFillData(trade: TradeRecord): boolean {
  if (trade.trade_group_id) {
    // Multi-leg trade: need both entry and exit dollars from actual fills
    return trade.entry_credit_dollars != null &&
           trade.exit_debit_dollars != null &&
           trade.close_status === 'filled';
  }
  // Single-leg trade: need entry/exit prices and direction
  return trade.entry_price != null &&
         trade.exit_price != null &&
         trade.open_side != null &&
         trade.close_status === 'filled';
}

/**
 * Check if P&L is finalized and should NOT be recomputed
 * Returns true for 'computed' or 'final' status
 */
export function isPnlFinalized(trade: Partial<TradeRecord>): boolean {
  return trade.pnl_status === 'computed' || trade.pnl_status === 'final';
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

/**
 * GROUP-LEVEL NET P&L CALCULATION (for multi-leg orders like iron condors)
 *
 * **IMPORTANT: Values must be in DOLLARS (already multiplied by contracts × 100)**
 *
 * The strategy-engine stores entry_credit and exit_debit as total dollars:
 *   entry_credit = avgFill × qty × 100 (e.g., $920 for 4 contracts at $2.30 net)
 *
 * Formula: P&L = Entry Credit (dollars) - Exit Debit (dollars) - fees
 *
 * Example:
 * - Entry credit: $920 (received $2.30 × 4 contracts × 100)
 * - Exit debit: $924 (paid $2.31 × 4 contracts × 100)
 * - P&L = $920 - $924 - $0 = -$4.00
 *
 * @param netEntryCreditDollars Total net credit in dollars (already multiplied)
 * @param netExitDebitDollars Total net debit in dollars (already multiplied)
 * @param contracts Number of contracts (for formula display only, NOT used in calculation)
 * @param multiplier Kept for API compatibility (NOT used in calculation)
 * @param fees Trading fees in dollars
 */
export function calculateGroupPnl(
  netEntryCreditDollars: number,  // Total dollars received at entry
  netExitDebitDollars: number,    // Total dollars paid at exit
  contracts: number,              // For display only
  multiplier: number = 100,       // Unused - kept for API compatibility
  fees: number = 0
): { pnl: number; pnlPercent: number; formula: string } {
  // P&L = Entry Credit - Exit Debit - fees (all in dollars, NO multiplication)
  const pnl = netEntryCreditDollars - netExitDebitDollars - fees;
  const pnlPercent = netEntryCreditDollars > 0
    ? ((netEntryCreditDollars - netExitDebitDollars) / netEntryCreditDollars) * 100
    : 0;

  const formula = `$${netEntryCreditDollars.toFixed(2)} - $${netExitDebitDollars.toFixed(2)} - $${fees.toFixed(2)} = $${pnl.toFixed(2)} [${contracts} contracts]`;

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

      // For single trade inserts, leg_count defaults to 1
      const legCount = 1;
      const contracts = Math.abs(trade.quantity || 1);

      const { data, error } = await supabase
        .from('trades')
        .insert({
          symbol: trade.symbol,
          underlying: trade.underlying,
          strategy_name: trade.strategy_name,
          strategy_type: trade.strategy_type,
          quantity: trade.quantity,
          entry_time: trade.entry_time,
          // exit_time should be null for submitted trades, set when filled
          exit_time: trade.exit_time || null,
          entry_price: trade.entry_price,
          // exit_price should be null for submitted trades, set when filled from avg_fill_price
          exit_price: trade.exit_price ?? null,
          entry_credit: trade.entry_credit,
          exit_debit: trade.exit_debit,
          // pnl should be null for submitted trades, computed when filled
          pnl: trade.close_status === 'submitted' ? null : pnl,
          pnl_percent: trade.close_status === 'submitted' ? null : pnlPercent,
          exit_reason: trade.exit_reason,
          notes: trade.notes,
          trade_group_id: trade.trade_group_id,
          open_side: trade.open_side,
          close_side: trade.close_side,
          open_order_id: trade.open_order_id,
          close_order_id: trade.close_order_id,
          fees: trade.fees || 0,
          multiplier: trade.multiplier || 100,
          pnl_formula: trade.close_status === 'submitted' ? null : pnlFormula,
          needs_reconcile: trade.close_status === 'submitted' ? true : needsReconcile,
          // Close lifecycle fields - use provided values, don't default
          close_status: trade.close_status || 'submitted',
          close_submitted_at: trade.close_submitted_at || new Date().toISOString(),
          close_filled_at: trade.close_filled_at || null,
          close_avg_fill_price: trade.close_avg_fill_price || null,
          close_filled_qty: trade.close_filled_qty || null,
          // P&L tracking columns
          contracts,
          leg_count: legCount,
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
        
        // Normalize contracts: if qty == legCount for 4+ legs, assume 1 contract
        const legCount = trades.length;
        const storedQty = Math.abs(trade.quantity || 1);
        const contracts = (legCount >= 4 && storedQty === legCount) ? 1 : storedQty;

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
          // P&L tracking columns
          contracts,
          leg_count: legCount,
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
            
            // Check if all legs are filled
            const allFilled = groupTrades.every(t => t.close_status === 'filled');
            const hasUnfinalized = !allFilled || groupTrades.some(t => t.needs_reconcile);
            
            // === GROUP-LEVEL P&L: Use stored pnl values (computed by recalculatePnl) ===
            // The stored pnl values are the source of truth - they were computed correctly
            // with direction-aware exit debit calculation. The exit_debit field may have
            // incorrect values due to a bug in the close order flow, so we DON'T recalculate
            // from entry_credit/exit_debit here.
            let totalPnl = 0;

            if (allFilled) {
              // Sum the stored pnl values from all legs
              // Primary leg has the group P&L, other legs have 0 (included in group total)
              const finalizedLegs = groupTrades.filter(t => isFullyFinalized(t));
              totalPnl = finalizedLegs.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
            }
            
            const group: TradeGroup = {
              groupId: trade.trade_group_id,
              trades: groupTrades.sort((a, b) => a.symbol.localeCompare(b.symbol)),
              totalPnl,
              strategyName: groupTrades[0].strategy_name,
              strategyType: groupTrades[0].strategy_type,
              underlying: groupTrades[0].underlying,
              exitTime: groupTrades[0].exit_time,
              exitReason: groupTrades[0].exit_reason,
              exitTriggerReason: groupTrades[0].exit_trigger_reason,
              needsReconcile: hasUnfinalized,
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
   * Get "today" start boundary in America/New_York timezone
   * Returns ISO string for midnight ET today
   */
  getTodayStartET(): string {
    const now = new Date();
    // Format in ET to get today's date
    const etDateStr = now.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
    // Parse back and get midnight
    const [month, day, year] = etDateStr.split('/');
    // Create midnight ET as ISO
    // Construct a date string and use the fact that ET is UTC-5 or UTC-4 depending on DST
    const etMidnight = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00`);
    // Get the offset for ET timezone
    const etOffset = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' });
    const isDST = etOffset.includes('EDT');
    const offsetHours = isDST ? 4 : 5;
    // Convert ET midnight to UTC
    const utcMidnight = new Date(Date.UTC(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      offsetHours, 0, 0, 0
    ));
    return utcMidnight.toISOString();
  },

  /**
   * Get realized P&L for TODAY in America/New_York timezone
   * HARD FILTERS:
   * - close_status = 'filled'
   * - needs_reconcile = false  
   * - pnl IS NOT NULL
   * - close_filled_at >= today midnight ET
   */
  async getRealizedTodayPnl(): Promise<{ realized: number; tradeCount: number }> {
    try {
      const todayStart = this.getTodayStartET();
      
      const { data, error } = await supabase
        .from('trades')
        .select('pnl, close_filled_at, close_status, needs_reconcile')
        .eq('close_status', 'filled')
        .eq('needs_reconcile', false)
        .not('pnl', 'is', null)
        .gte('close_filled_at', todayStart);

      if (error) throw error;

      const trades = data || [];
      const realized = trades.reduce((sum, t) => sum + Number(t.pnl), 0);
      
      return { realized, tradeCount: trades.length };
    } catch (error) {
      console.error('Error fetching realized today PnL:', error);
      return { realized: 0, tradeCount: 0 };
    }
  },

  /**
   * Get stats - ONLY includes FULLY FINALIZED trades
   * HARD FILTERS:
   * - close_status = 'filled'
   * - needs_reconcile = false
   * - pnl IS NOT NULL
   * Excludes: submitted, rejected, canceled, expired, or legacy (null) close_status
   */
  async getTradeStats(countByLeg: boolean = false): Promise<TradeStats> {
    try {
      const { data, error } = await supabase
        .from('trades')
        .select('pnl, trade_group_id, needs_reconcile, close_status');

      if (error) throw error;

      const trades = data || [];
      
      // HARD FILTER: Only include trades where close_status='filled' AND needs_reconcile=false AND pnl IS NOT NULL
      const finalizedTrades = trades.filter(t => 
        t.close_status === 'filled' && 
        t.needs_reconcile === false && 
        t.pnl != null
      );
      
      // Count non-finalized for display
      const nonFinalizedCount = trades.filter(t => 
        t.close_status !== 'filled' || 
        t.needs_reconcile === true || 
        t.pnl == null
      ).length;
      
      const totalLegsFinalized = finalizedTrades.length;
      
      if (countByLeg) {
        // Count individual finalized legs only
        const winners = finalizedTrades.filter(t => Number(t.pnl) > 0);
        const losers = finalizedTrades.filter(t => Number(t.pnl) < 0);
        const totalPnl = finalizedTrades.reduce((sum, t) => sum + Number(t.pnl), 0);
        const avgWinner = winners.length > 0 
          ? winners.reduce((sum, t) => sum + Number(t.pnl), 0) / winners.length 
          : 0;
        const avgLoser = losers.length > 0 
          ? losers.reduce((sum, t) => sum + Number(t.pnl), 0) / losers.length 
          : 0;

        return {
          totalTrades: totalLegsFinalized,
          totalLegs: totalLegsFinalized,
          winningTrades: winners.length,
          losingTrades: losers.length,
          totalPnl,
          winRate: totalLegsFinalized > 0 ? (winners.length / totalLegsFinalized) * 100 : 0,
          avgWinner,
          avgLoser,
          needsReconcileCount: nonFinalizedCount,
          verifiedCount: totalLegsFinalized,
        };
      }
      
      // Group by trade_group_id (default - count strategies)
      // Only include groups where ALL legs are finalized (filled + verified + pnl not null)
      const grouped = new Map<string, { pnl: number; allFinalized: boolean; legCount: number; finalizedCount: number }>();
      let singleTradeIndex = 0;
      
      trades.forEach(t => {
        const groupKey = t.trade_group_id || `single_${singleTradeIndex++}`;
        const existing = grouped.get(groupKey) || { pnl: 0, allFinalized: true, legCount: 0, finalizedCount: 0 };
        
        existing.legCount++;
        
        const isLegFinalized = t.close_status === 'filled' && t.needs_reconcile === false && t.pnl != null;
        
        if (isLegFinalized) {
          existing.pnl += Number(t.pnl);
          existing.finalizedCount++;
        } else {
          existing.allFinalized = false;
        }
        
        grouped.set(groupKey, existing);
      });

      // Only count groups where ALL legs are finalized
      const fullyFinalizedGroups = Array.from(grouped.entries())
        .filter(([_, g]) => g.allFinalized && g.finalizedCount === g.legCount);
      
      const groupPnls = fullyFinalizedGroups.map(([_, g]) => g.pnl);
      const winners = groupPnls.filter(pnl => pnl > 0);
      const losers = groupPnls.filter(pnl => pnl < 0);
      
      const totalPnl = groupPnls.reduce((sum, pnl) => sum + pnl, 0);
      const avgWinner = winners.length > 0 
        ? winners.reduce((sum, pnl) => sum + pnl, 0) / winners.length 
        : 0;
      const avgLoser = losers.length > 0 
        ? losers.reduce((sum, pnl) => sum + pnl, 0) / losers.length 
        : 0;

      // Count partial/unfinalized groups
      const partialGroups = Array.from(grouped.entries())
        .filter(([_, g]) => !g.allFinalized || g.finalizedCount !== g.legCount).length;

      return {
        totalTrades: fullyFinalizedGroups.length,
        totalLegs: totalLegsFinalized,
        winningTrades: winners.length,
        losingTrades: losers.length,
        totalPnl,
        winRate: fullyFinalizedGroups.length > 0 ? (winners.length / fullyFinalizedGroups.length) * 100 : 0,
        avgWinner,
        avgLoser,
        needsReconcileCount: partialGroups,
        verifiedCount: fullyFinalizedGroups.length,
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
   * Recalculate P&L for trades with verified direction AND filled close_status
   * DOES NOT compute P&L if:
   * - direction is unknown
   * - close_status is not 'filled'
   * In these cases, marks needs_reconcile=true and pnl=NULL
   *
   * IMMUTABILITY: Skips trades with pnl_status 'computed' or 'final' unless force=true
   *
   * @param options.force - If true, recompute even finalized trades (use sparingly)
   */
  async recalculatePnl(options?: { force?: boolean }): Promise<{ success: boolean; updated: number; skipped: number; sanitized: number; finalized: number; errors: string[] }> {
    try {
      const { data: trades, error } = await supabase
        .from('trades')
        .select('*');

      if (error) throw error;

      let updated = 0;
      let skipped = 0;
      let sanitized = 0;
      let finalized = 0; // Count of trades skipped due to immutability
      const errors: string[] = [];
      const now = new Date().toISOString();

      // === DIAGNOSTIC: Capture before-state for delta tracking ===
      const beforePnlByGroup = new Map<string, number>();
      let totalBeforePnl = 0;
      for (const row of trades || []) {
        const trade = castToTradeRecord(row);
        const pnl = Number(trade.pnl) || 0;
        if (trade.trade_group_id) {
          // For groups, only count primary leg (first alphabetically)
          const existing = beforePnlByGroup.get(trade.trade_group_id) || 0;
          beforePnlByGroup.set(trade.trade_group_id, existing + pnl);
        } else {
          totalBeforePnl += pnl;
        }
      }
      for (const groupPnl of beforePnlByGroup.values()) {
        totalBeforePnl += groupPnl;
      }
      console.log(`[recompute] === STARTING RECOMPUTE === Total P&L before: $${totalBeforePnl.toFixed(2)}, force=${options?.force || false}`);

      // Step 1: Group trades by trade_group_id
      const groupedTrades = new Map<string, TradeRecord[]>();
      const ungroupedTrades: TradeRecord[] = [];

      for (const row of trades || []) {
        const trade = castToTradeRecord(row);
        if (trade.trade_group_id) {
          const existing = groupedTrades.get(trade.trade_group_id) || [];
          existing.push(trade);
          groupedTrades.set(trade.trade_group_id, existing);
        } else {
          ungroupedTrades.push(trade);
        }
      }

      // Step 2: Process multi-leg groups using calculateGroupPnl
      for (const [groupId, groupLegs] of groupedTrades.entries()) {
        // PHASE 1: Deterministic primary leg selection - sort by symbol, then by id
        groupLegs.sort((a, b) => {
          const symCmp = a.symbol.localeCompare(b.symbol);
          if (symCmp !== 0) return symCmp;
          return (a.id || '').localeCompare(b.id || '');
        });

        const primaryLeg = groupLegs[0];

        // IMMUTABILITY CHECK: Skip if already computed (unless force mode)
        if (!options?.force && isPnlFinalized(primaryLeg)) {
          console.log(`[recalculatePnl] Skipping finalized group ${groupId.slice(0, 8)} (pnl_status=${primaryLeg.pnl_status})`);
          finalized += groupLegs.length;
          continue;
        }

        // Sanitize non-filled groups
        const allFilled = groupLegs.every(t => t.close_status === 'filled');
        if (!allFilled) {
          for (const leg of groupLegs) {
            if (leg.pnl != null || leg.pnl_percent != null || !leg.needs_reconcile) {
              await supabase.from('trades').update({
                needs_reconcile: true,
                pnl: null,
                pnl_percent: null,
                pnl_formula: null,
                pnl_status: 'pending',
              }).eq('id', leg.id);
              sanitized++;
            } else {
              skipped++;
            }
          }
          continue;
        }

        // Multi-leg group: use group-level P&L calculation with SELF-HEALING
        if (groupLegs.length > 1) {
          const strategyType = primaryLeg.strategy_type;

          // PHASE 1: contracts = max(quantity) across all legs for robustness
          const contracts = Math.max(...groupLegs.map(l => Number(l.quantity) || 1));
          const totalFees = groupLegs.reduce((sum, t) => sum + (Number(t.fees) || 0), 0);

          // IMMUTABLE P&L: Prefer stored _dollars values from actual fills
          const storedEntryCreditDollars = Number(primaryLeg.entry_credit_dollars) || 0;
          const storedExitDebitDollars = Number(primaryLeg.exit_debit_dollars) || 0;

          // Build leg infos with exit prices for inference
          const legInfos = groupLegs.map(leg => ({
            symbol: leg.symbol,
            entryPrice: Number(leg.entry_price) || 0,
            exitPrice: Number(leg.exit_price) || undefined,
          }));

          // PHASE 2: Prefer strike-based inference over position_group_map
          const inference = inferLegSides(legInfos, strategyType);
          let inferredLegs: InferredLeg[] = [];

          // === FIX: Get entry_credit from position_group_map (SOURCE OF TRUTH in DOLLARS) ===
          // trades.entry_credit may contain per-share values from UI path
          let computedEntryCredit = 0;
          let entryCreditSource = 'unknown';

          // First try position_group_map (always in DOLLARS)
          const { data: groupMapping } = await supabase
            .from('position_group_map')
            .select('entry_credit')
            .eq('trade_group_id', groupId)
            .limit(1)
            .maybeSingle();

          if (groupMapping?.entry_credit != null && Number(groupMapping.entry_credit) > 0) {
            computedEntryCredit = Number(groupMapping.entry_credit);
            entryCreditSource = 'position_group_map';
            console.log(`[recalculatePnl] Group ${groupId.slice(0, 8)}: entry_credit from position_group_map: $${computedEntryCredit.toFixed(2)}`);
          } else {
            // Fallback: only use trades.entry_credit if it looks like dollars (> $50)
            const storedValue = Number(primaryLeg.entry_credit) || 0;
            if (storedValue > 50) {
              computedEntryCredit = storedValue;
              entryCreditSource = 'stored_dollars';
              console.log(`[recalculatePnl] Group ${groupId.slice(0, 8)}: entry_credit from trades (appears to be dollars): $${computedEntryCredit.toFixed(2)}`);
            } else if (storedValue > 0) {
              console.warn(`[recalculatePnl] Group ${groupId.slice(0, 8)}: entry_credit ${storedValue} appears to be per-share, will use inference`);
            }
          }

          let computedExitDebit = 0;
          let exitDebitSource = 'unknown';
          let pnlStatus: PnlStatus = 'computed';

          // Use stored dollars values if available (IMMUTABLE - from actual fills)
          if (storedEntryCreditDollars > 0 && storedExitDebitDollars !== 0) {
            // Use immutable values from actual fills
            const finalPnl = storedEntryCreditDollars - storedExitDebitDollars;
            const finalPnlPercent = storedEntryCreditDollars > 0
              ? ((storedEntryCreditDollars - storedExitDebitDollars) / storedEntryCreditDollars) * 100 : 0;

            const formulaImmutable = `(${storedEntryCreditDollars.toFixed(2)} - ${storedExitDebitDollars.toFixed(2)}) = ${finalPnl.toFixed(2)} [from actual fills - IMMUTABLE]`;

            // Build side data map from inference
            if (inference.success) {
              inferredLegs = inference.legs;
            }
            const legSideData = new Map<string, { openSide: string; closeSide: string }>();
            if (inferredLegs.length > 0) {
              for (const leg of groupLegs) {
                const inferred = getInferredSide(inferredLegs, leg.symbol);
                if (inferred) {
                  legSideData.set(leg.id!, { openSide: inferred.openSide, closeSide: inferred.closeSide });
                }
              }
            }

            // Update PRIMARY leg with immutable P&L
            const primaryLegSides = legSideData.get(primaryLeg.id!);
            const { error: primaryLegError } = await supabase.from('trades').update({
              pnl: finalPnl,
              pnl_percent: finalPnlPercent,
              pnl_formula: formulaImmutable,
              needs_reconcile: false,
              pnl_status: 'computed',
              pnl_computed_at: primaryLeg.pnl_computed_at || now,
              ...(primaryLegSides ? {
                open_side: primaryLegSides.openSide,
                close_side: primaryLegSides.closeSide
              } : {}),
            }).eq('id', primaryLeg.id);

            if (primaryLegError) {
              errors.push(`Trade ${primaryLeg.id}: ${primaryLegError.message}`);
            } else {
              updated++;
            }

            // Set other legs to 0 P&L
            for (let i = 1; i < groupLegs.length; i++) {
              const leg = groupLegs[i];
              const legSides = legSideData.get(leg.id!);
              const { error: legError } = await supabase.from('trades').update({
                pnl: 0,
                pnl_percent: 0,
                pnl_formula: 'Included in group total',
                needs_reconcile: false,
                pnl_status: 'computed',
                pnl_computed_at: leg.pnl_computed_at || now,
                ...(legSides ? {
                  open_side: legSides.openSide,
                  close_side: legSides.closeSide
                } : {}),
              }).eq('id', leg.id);

              if (legError) {
                errors.push(`Trade ${leg.id}: ${legError.message}`);
              } else {
                updated++;
              }
            }
            continue; // Skip inference-based calculation
          }

          // Fallback to inference-based calculation for entry credit
          if (inference.success) {
            inferredLegs = inference.legs;

            // IMPORTANT: inference.netEntryCredit is PER-SHARE, need to convert to dollars
            const inferredEntryCreditDollars = inference.netEntryCredit * contracts * 100;

            // Use inference if we don't have entry credit yet
            if (computedEntryCredit === 0 && inferredEntryCreditDollars > 0) {
              console.log(`[recalculatePnl] Group ${groupId.slice(0, 8)}: entry_credit from inference: $${inferredEntryCreditDollars.toFixed(2)} (${inference.netEntryCredit.toFixed(4)} × ${contracts} × 100)`);
              computedEntryCredit = inferredEntryCreditDollars;
              entryCreditSource = 'inferred_dollars';
            }
          }

          // EXIT DEBIT RESOLVER - Priority-based selection for correct group exit debit
          // IMPORTANT: exit_debit column = DOLLARS, exit_price column = PER-SHARE
          // All outputs must be in DOLLARS for calculateGroupPnl

          // Priority 1: Check if any leg already has a non-zero exit_debit (already in dollars)
          // HEURISTIC: Detect if exit_debit is per-share (≈ exit_price) vs dollars
          const existingExitDebitsWithPrices = groupLegs
            .map(l => ({ 
              exitDebit: Number(l.exit_debit) || 0, 
              exitPrice: Number(l.exit_price) || 0 
            }))
            .filter(ed => ed.exitDebit > 0.001);

          if (existingExitDebitsWithPrices.length > 0) {
            const first = existingExitDebitsWithPrices[0];
            const legCount = groupLegs.length;
            
            // CRITICAL FIX #1: Detect per-share values stored in exit_debit column
            // If exit_debit is very close to exit_price, it's likely per-share not dollars
            const isLikelyPerShareByPrice = first.exitPrice > 0.01 &&
              first.exitDebit < 50 && // Dollar values for condors typically > $50
              Math.abs(first.exitDebit - first.exitPrice) / Math.max(first.exitPrice, 0.01) < 0.5;

            // CRITICAL FIX #1b: Also detect per-share when exit_debit is tiny compared to entry_credit
            // For spreads, exit_debit should be comparable to entry_credit (not 100x smaller)
            const isLikelyPerShareByRatio = first.exitDebit < 5 &&
              computedEntryCredit > 10 &&
              first.exitDebit < (computedEntryCredit * 0.1); // exit_debit is < 10% of entry_credit

            // CRITICAL FIX #1c: For small premium trades, detect per-share by absolute threshold
            // Any exit_debit between $0.01 and $1 is almost certainly per-share (real dollar costs are > $1)
            const isLikelyPerShareByAbsolute = first.exitDebit > 0.01 && first.exitDebit < 1;

            const isLikelyPerShare = isLikelyPerShareByPrice || isLikelyPerShareByRatio || isLikelyPerShareByAbsolute;
            
            // CRITICAL FIX #2: Detect if exit_debit = exit_price × 100 × leg_count (incorrectly summed per-leg)
            // This happens when broker returns per-leg prices and they get summed instead of netted
            const expectedPerLegDollars = first.exitPrice * 100;
            const expectedSummedValue = expectedPerLegDollars * legCount;
            const isSummedPerLegDollars = legCount >= 4 && 
              first.exitDebit > 100 && // Must be a substantial dollar value
              Math.abs(first.exitDebit - expectedSummedValue) < (expectedSummedValue * 0.1); // Within 10% of summed value
            
            if (isLikelyPerShare) {
              // Convert per-share net combo price to dollars
              computedExitDebit = first.exitDebit * contracts * 100;
              exitDebitSource = 'existingExitDebit_convertedToDollars';
              console.log(`[recalculatePnl] Group ${groupId.slice(0, 8)}: CONVERTED per-share exit_debit=${first.exitDebit.toFixed(4)} → $${computedExitDebit.toFixed(2)}`);
            } else if (isSummedPerLegDollars) {
              // exit_debit was incorrectly calculated as sum of per-leg values - divide by leg count
              computedExitDebit = first.exitDebit / legCount;
              exitDebitSource = 'existingExitDebit_correctedFromSummedLegs';
              console.log(`[recalculatePnl] Group ${groupId.slice(0, 8)}: CORRECTED summed exit_debit=${first.exitDebit.toFixed(2)} ÷ ${legCount} legs → $${computedExitDebit.toFixed(2)}`);
            } else {
              // Already in dollars - use median of existing non-zero exit_debit values
              const debits = existingExitDebitsWithPrices.map(e => e.exitDebit).sort((a, b) => a - b);
              const midIdx = Math.floor(debits.length / 2);
              computedExitDebit = debits.length % 2 === 0
                ? (debits[midIdx - 1] + debits[midIdx]) / 2
                : debits[midIdx];
              exitDebitSource = 'existingExitDebit_dollars';
              console.log(`[recalculatePnl] Group ${groupId.slice(0, 8)}: using existing exit_debit=$${computedExitDebit.toFixed(2)}`);
            }
          } else {
            // Priority 2: Check if exit_price is duplicated combo net price (all legs have same exit_price)
            // NOTE: exit_price is PER-SHARE, need to convert to dollars
            const exitPrices = groupLegs
              .map(l => Number(l.exit_price) || 0)
              .filter(ep => ep > 0.001);

            if (exitPrices.length >= 2) {
              const minExit = Math.min(...exitPrices);
              const maxExit = Math.max(...exitPrices);
              const isComboNetPrice = (maxExit - minExit) < 0.005; // All within 0.5 cents = duplicated combo price

              if (isComboNetPrice && groupLegs.length >= 4) {
                // Duplicated combo net close price - convert per-share to dollars
                const comboNetPerShare = exitPrices[0];
                computedExitDebit = comboNetPerShare * contracts * 100;
                exitDebitSource = 'comboExitPrice_dollars';
                console.log(`[recalculatePnl] Group ${groupId.slice(0, 8)}: combo exit_price=${comboNetPerShare.toFixed(4)} → $${computedExitDebit.toFixed(2)}`);
              } else if (inference.success && inference.netExitDebit != null && Math.abs(inference.netExitDebit) > 0.001) {
                // Priority 3: Per-leg netting from inference - convert per-share to dollars
                const inferredExitPerShare = inference.netExitDebit;
                computedExitDebit = inferredExitPerShare * contracts * 100;
                exitDebitSource = 'perLegNet_dollars';
                console.log(`[recalculatePnl] Group ${groupId.slice(0, 8)}: inferred exit_debit=${inferredExitPerShare.toFixed(4)} → $${computedExitDebit.toFixed(2)}`);
              } else if (!isComboNetPrice) {
                // Exit prices differ but inference gave 0 - per-leg netting might give 0 (e.g., expired worthless)
                const inferredExitPerShare = inference.netExitDebit ?? 0;
                computedExitDebit = inferredExitPerShare * contracts * 100;
                exitDebitSource = 'perLegNet_dollars';
              } else {
                // 2-3 leg spread with identical exit prices - convert per-share to dollars
                const comboNetPerShare = exitPrices[0];
                computedExitDebit = comboNetPerShare * contracts * 100;
                exitDebitSource = 'comboExitPrice_dollars';
              }
            } else {
              // Priority 4: Fallback to primary leg's exit_price - convert per-share to dollars
              const exitPricePerShare = Number(primaryLeg.exit_price) || 0;
              computedExitDebit = exitPricePerShare * contracts * 100;
              exitDebitSource = 'fallbackPrimaryExitPrice_dollars';
            }
          }

          // Validate we have entry/exit data
          if (computedEntryCredit === 0 && computedExitDebit === 0) {
            errors.push(`Group ${groupId.slice(0, 8)}: Missing entry_credit and exit_debit`);
            for (const leg of groupLegs) {
              await supabase.from('trades').update({
                needs_reconcile: true,
                pnl: null,
                pnl_percent: null,
                pnl_formula: null,
                pnl_status: 'missing_fills',
              }).eq('id', leg.id);
            }
            skipped += groupLegs.length;
            continue;
          }

          // Validate we have real exit data (not just zero from missing fills)
          if (computedExitDebit < 0.01 && exitDebitSource === 'unknown') {
            console.warn(`[recalculatePnl] Group ${groupId.slice(0, 8)}: Missing exit_debit data (source=unknown), marking for reconcile`);
            for (const leg of groupLegs) {
              await supabase.from('trades').update({
                needs_reconcile: true,
                pnl_status: 'missing_fills',
              }).eq('id', leg.id);
            }
            skipped += groupLegs.length;
            continue;
          }

          // Calculate group P&L with corrected values
          const groupCalc = calculateGroupPnl(computedEntryCredit, computedExitDebit, contracts, 100, totalFees);
          // Add source tracing to formula for debugging
          const formulaWithTrace = `${groupCalc.formula} [entry:${entryCreditSource}, exit:${exitDebitSource}]`;
          // Build side data map from inference (preferred) - Phase 2
          const legSideData = new Map<string, { openSide: string; closeSide: string }>();

          // First use inference for all legs if available
          if (inferredLegs.length > 0) {
            for (const leg of groupLegs) {
              const inferred = getInferredSide(inferredLegs, leg.symbol);
              if (inferred) {
                legSideData.set(leg.id!, { openSide: inferred.openSide, closeSide: inferred.closeSide });
              }
            }
          }

          // Only fall back to position_group_map for legs where inference failed
          for (const leg of groupLegs) {
            if (!legSideData.has(leg.id!)) {
              const { data: mapping } = await supabase
                .from('position_group_map')
                .select('leg_side')
                .eq('symbol', leg.symbol)
                .eq('trade_group_id', leg.trade_group_id)
                .maybeSingle();
              if (mapping?.leg_side) {
                const closeSide = mapping.leg_side === 'sell_to_open' ? 'buy_to_close' :
                                 mapping.leg_side === 'buy_to_open' ? 'sell_to_close' : 'buy_to_close';
                legSideData.set(leg.id!, { openSide: mapping.leg_side, closeSide });
              }
            }
          }

          // Update PRIMARY leg with group P&L, corrected entry_credit, exit_debit, and sides
          const primaryLegSides = legSideData.get(primaryLeg.id!);
          const { error: primaryLegError } = await supabase.from('trades').update({
            pnl: groupCalc.pnl,
            pnl_percent: groupCalc.pnlPercent,
            pnl_formula: formulaWithTrace,
            needs_reconcile: false,
            pnl_status: pnlStatus,
            pnl_computed_at: now,
            // Always persist entry_credit and exit_debit on primary leg
            entry_credit: computedEntryCredit,
            exit_debit: computedExitDebit,
            // Fix side labels from inference
            ...(primaryLegSides ? {
              open_side: primaryLegSides.openSide,
              close_side: primaryLegSides.closeSide
            } : {}),
          }).eq('id', primaryLeg.id);

          if (primaryLegError) {
            errors.push(`Trade ${primaryLeg.id}: ${primaryLegError.message}`);
          } else {
            updated++;
          }

          // Set other legs to 0 P&L (included in group total), update entry_credit for consistency, and fix their sides
          for (let i = 1; i < groupLegs.length; i++) {
            const leg = groupLegs[i];
            const legSides = legSideData.get(leg.id!);
            const { error: legError } = await supabase.from('trades').update({
              pnl: 0,
              pnl_percent: 0,
              pnl_formula: 'Included in group total',
              needs_reconcile: false,
              pnl_status: pnlStatus,
              pnl_computed_at: now,
              // Persist corrected entry_credit on all legs for consistency
              entry_credit: computedEntryCredit,
              // Fix side labels from inference
              ...(legSides ? {
                open_side: legSides.openSide,
                close_side: legSides.closeSide
              } : {}),
            }).eq('id', leg.id);

            if (legError) {
              errors.push(`Trade ${leg.id}: ${legError.message}`);
            } else {
              updated++;
            }
          }
        } else {
          // Single-leg "group" - process as individual trade
          ungroupedTrades.push(primaryLeg);
        }
      }

      // Step 3: Process single-leg trades using per-leg calculation
      for (const trade of ungroupedTrades) {
        // IMMUTABILITY CHECK: Skip if already computed (unless force mode)
        if (!options?.force && isPnlFinalized(trade)) {
          console.log(`[recalculatePnl] Skipping finalized trade ${trade.id?.slice(0, 8)} (pnl_status=${trade.pnl_status})`);
          finalized++;
          continue;
        }

        // HARD RULE: If close_status is not 'filled', nullify P&L
        if (trade.close_status !== 'filled') {
          if (trade.pnl != null || trade.pnl_percent != null || !trade.needs_reconcile) {
            await supabase.from('trades').update({
              needs_reconcile: true,
              pnl: null,
              pnl_percent: null,
              pnl_formula: null,
              pnl_status: 'pending',
            }).eq('id', trade.id);
            sanitized++;
          } else {
            skipped++;
          }
          continue;
        }

        // Check if we have verified direction
        if (!hasVerifiedDirection(trade)) {
          if (!trade.needs_reconcile || trade.pnl != null) {
            await supabase.from('trades').update({
              needs_reconcile: true,
              pnl: null,
              pnl_percent: null,
              pnl_formula: null,
              pnl_status: 'missing_fills',
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
            pnl_status: 'missing_fills',
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
            pnl_status: 'computed',
            pnl_computed_at: now,
          })
          .eq('id', trade.id);

        if (updateError) {
          errors.push(`Trade ${trade.id}: ${updateError.message}`);
        } else {
          updated++;
        }
      }

      // === DIAGNOSTIC: Capture after-state and log summary ===
      const { data: afterTrades } = await supabase.from('trades').select('pnl, trade_group_id');
      let totalAfterPnl = 0;
      const afterPnlByGroup = new Map<string, number>();
      for (const row of afterTrades || []) {
        const pnl = Number(row.pnl) || 0;
        if (row.trade_group_id) {
          const existing = afterPnlByGroup.get(row.trade_group_id) || 0;
          afterPnlByGroup.set(row.trade_group_id, existing + pnl);
        } else {
          totalAfterPnl += pnl;
        }
      }
      for (const groupPnl of afterPnlByGroup.values()) {
        totalAfterPnl += groupPnl;
      }
      const delta = totalAfterPnl - totalBeforePnl;
      console.log(`[recompute] === RECOMPUTE COMPLETE === Total P&L after: $${totalAfterPnl.toFixed(2)}, delta: $${delta.toFixed(2)}`);
      console.log(`[recompute] Stats: updated=${updated}, skipped=${skipped}, sanitized=${sanitized}, finalized=${finalized}, errors=${errors.length}`);
      if (Math.abs(delta) > 100) {
        console.warn(`[recompute] WARNING: Large P&L delta detected ($${delta.toFixed(2)}). Review may be needed.`);
      }

      return { success: true, updated, skipped, sanitized, finalized, errors };
    } catch (error) {
      console.error('Error recalculating P&L:', error);
      return {
        success: false,
        updated: 0,
        skipped: 0,
        sanitized: 0,
        finalized: 0,
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
    leg_count?: number; // Number of legs in the spread
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

      // Normalize contracts: if qty == legCount for 4+ legs, assume 1 contract
      const legCount = tradeData.leg_count || 1;
      const storedQty = Math.abs(tradeData.quantity || 1);
      const contracts = (legCount >= 4 && storedQty === legCount) ? 1 : storedQty;

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
          // P&L tracking columns
          contracts,
          leg_count: legCount,
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
   * For multi-leg combo orders, uses GROUP-LEVEL NET P&L calculation
   * 
   * @param closeOrderId - The Tradier order ID
   * @param status - The new status (filled, rejected, etc.)
   * @param details - Fill details
   *   - avgFillPrice: For combo orders, this is the NET exit debit (not per-leg)
   *   - filledQty: Number of contracts
   *   - isComboOrder: If true, uses group-level P&L calculation
   *   - legFills: Per-leg fill prices (for reference, not used in P&L calc for combos)
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
      /** If true, this is a multi-leg combo order - use group P&L calculation */
      isComboOrder?: boolean;
      /** Per-leg fill prices for multi-leg orders (for reference only in combo mode) */
      legFills?: Record<string, { avgFillPrice: number; filledQty: number; side: string }>;
    }
  ): Promise<{ success: boolean; error?: string; groupPnl?: number }> {
    try {
      const { data: trades, error: fetchError } = await supabase
        .from('trades')
        .select('*')
        .eq('close_order_id', closeOrderId);

      if (fetchError) throw fetchError;
      if (!trades || trades.length === 0) {
        return { success: false, error: 'Trade not found for close_order_id' };
      }

      // Detect multi-leg combo order
      const isMultiLeg = trades.length > 1 || details?.isComboOrder;
      let groupPnl: number | undefined;

      if (isMultiLeg && status === 'filled' && details?.avgFillPrice != null) {
        // === MULTI-LEG COMBO ORDER: Use GROUP-LEVEL NET P&L ===
        const typedTrades = trades.map(t => castToTradeRecord(t));

        // PHASE 3: Deterministic primary leg selection - sort by symbol, then by id
        typedTrades.sort((a, b) => {
          const symCmp = a.symbol.localeCompare(b.symbol);
          if (symCmp !== 0) return symCmp;
          return (a.id || '').localeCompare(b.id || '');
        });
        const primaryLeg = typedTrades[0];

        const strategyType = primaryLeg.strategy_type;

        // DEFENSIVE: The quantity field is sometimes incorrectly set to leg count instead of contracts
        // For multi-leg trades (4+ legs like iron condors), if quantity == legCount, assume 1 contract
        let contracts = details.filledQty || Math.max(...typedTrades.map(t => Number(t.quantity) || 1));
        if (typedTrades.length >= 4 && contracts === typedTrades.length) {
          contracts = 1; // Quantity was set to leg count, actual contracts is 1
          console.warn(`[updateCloseStatus] Detected quantity=${typedTrades.length} == legCount, correcting to 1 contract`);
        }

        const fees = details.fees || 0;

        // === IMMUTABLE P&L: Compute exit_debit_dollars from actual per-leg fills ===
        let exitDebitDollars = 0;
        let hasAllLegFills = true;

        if (details?.legFills) {
          for (const trade of typedTrades) {
            const legFill = details.legFills[trade.symbol];
            if (legFill && legFill.avgFillPrice > 0) {
              const fillPrice = legFill.avgFillPrice;
              const qty = legFill.filledQty || Math.abs(trade.quantity);
              // For closing: short positions pay to close, long positions receive
              if (trade.open_side === 'sell_to_open') {
                exitDebitDollars += fillPrice * qty * 100; // Pay to close short
              } else if (trade.open_side === 'buy_to_open') {
                exitDebitDollars -= fillPrice * qty * 100; // Receive to close long
              } else {
                // Open side unknown - try to infer from position_group_map
                const { data: mapping } = await supabase
                  .from('position_group_map')
                  .select('leg_side')
                  .eq('symbol', trade.symbol)
                  .eq('trade_group_id', trade.trade_group_id)
                  .maybeSingle();
                if (mapping?.leg_side === 'sell_to_open') {
                  exitDebitDollars += fillPrice * qty * 100;
                } else if (mapping?.leg_side === 'buy_to_open') {
                  exitDebitDollars -= fillPrice * qty * 100;
                } else {
                  hasAllLegFills = false; // Can't determine direction
                }
              }
            } else {
              hasAllLegFills = false;
              console.warn(`[updateCloseStatus] Missing or zero fill for ${trade.symbol}: legFill=${JSON.stringify(legFill)}`);
            }
          }
        } else {
          hasAllLegFills = false;
        }

        // === FIX: Fetch entry_credit from position_group_map (SOURCE OF TRUTH in DOLLARS) ===
        // The trades.entry_credit may contain per-share values from UI path, which is WRONG.
        // position_group_map.entry_credit is always in DOLLARS (set by strategy-engine from actual fills).
        let entryCreditDollars = 0;

        if (primaryLeg.trade_group_id) {
          const { data: groupMapping } = await supabase
            .from('position_group_map')
            .select('entry_credit')
            .eq('trade_group_id', primaryLeg.trade_group_id)
            .limit(1)
            .maybeSingle();

          if (groupMapping?.entry_credit != null) {
            entryCreditDollars = Number(groupMapping.entry_credit);
            console.log(`[updateCloseStatus] Entry credit from position_group_map: $${entryCreditDollars.toFixed(2)}`);
          }
        }

        // Fallback to trades.entry_credit only if position_group_map lookup failed
        // AND the value looks like dollars (> $50 suggests it's not per-share)
        if (entryCreditDollars === 0) {
          const storedValue = Number(primaryLeg.entry_credit) || 0;
          // Sanity check: per-share values are typically < $20, dollars are typically > $50
          // If value is small, it's likely per-share and we should use inference instead
          if (storedValue > 50) {
            entryCreditDollars = storedValue;
            console.log(`[updateCloseStatus] Entry credit from trades table (appears to be dollars): $${entryCreditDollars.toFixed(2)}`);
          } else if (storedValue > 0) {
            console.warn(`[updateCloseStatus] Entry credit ${storedValue} appears to be per-share, will use inference`);
          }
        }

        // Build leg infos with exit prices for inference
        // For combo orders, avgFillPrice is net debit - but we may also have per-leg fills
        const legInfos = typedTrades.map(t => ({
          symbol: t.symbol,
          entryPrice: Number(t.entry_price) || 0,
          exitPrice: (details?.legFills?.[t.symbol]?.avgFillPrice ?? Number(t.exit_price)) || undefined,
        }));

        // PHASE 3: Infer leg sides and compute entry_credit and exit_debit
        const inference = inferLegSides(legInfos, strategyType);
        let inferredLegs: InferredLeg[] = [];

        // IMPORTANT: details.avgFillPrice from Tradier is PER-SHARE, need to convert to dollars
        const tradierExitPricePerShare = Math.abs(details.avgFillPrice);
        let netExitDebitDollars = tradierExitPricePerShare * contracts * 100;
        let netEntryCreditDollars = entryCreditDollars; // Already in dollars

        if (inference.success) {
          inferredLegs = inference.legs;

          // Only use inference for entry credit if stored value is missing
          if (netEntryCreditDollars === 0) {
            const inferredEntryCreditDollars = inference.netEntryCredit * contracts * 100;
            console.log(`[updateCloseStatus] Entry credit from inference: $${inferredEntryCreditDollars.toFixed(2)}`);
            netEntryCreditDollars = inferredEntryCreditDollars;
          }

          // Only use inference for exit debit if Tradier price is missing
          if (tradierExitPricePerShare === 0 && inference.netExitDebit != null) {
            const inferredExitDebitDollars = inference.netExitDebit * contracts * 100;
            console.log(`[updateCloseStatus] Exit debit from inference: $${inferredExitDebitDollars.toFixed(2)}`);
            netExitDebitDollars = inferredExitDebitDollars;
          }
        }

        // Calculate group P&L using net credit/debit formula
        let groupCalc: { pnl: number; pnlPercent: number; formula: string } | null = null;
        let pnlStatus: PnlStatus = 'missing_fills';
        const now = new Date().toISOString();

        // VALIDATION: Don't compute P&L if exit debit is suspiciously low with missing fills
        if (netExitDebitDollars < 0.01 && !hasAllLegFills) {
          console.error(`[updateCloseStatus] Cannot compute P&L: exit_debit is $${netExitDebitDollars.toFixed(2)} with missing leg fills`);
          pnlStatus = 'missing_fills';
          // Skip P&L calculation entirely - leave groupCalc as null
        } else if (hasAllLegFills && entryCreditDollars > 0 && exitDebitDollars !== 0) {
          // IMMUTABLE: Use actual per-leg fill prices
          const finalPnl = entryCreditDollars - exitDebitDollars;
          const finalPnlPercent = entryCreditDollars > 0 ? ((entryCreditDollars - exitDebitDollars) / entryCreditDollars) * 100 : 0;
          groupCalc = {
            pnl: finalPnl,
            pnlPercent: finalPnlPercent,
            formula: `$${entryCreditDollars.toFixed(2)} - $${exitDebitDollars.toFixed(2)} = $${finalPnl.toFixed(2)} [from actual fills]`
          };
          groupPnl = finalPnl;
          pnlStatus = 'computed';
          console.log(`[updateCloseStatus] IMMUTABLE P&L from fills: Entry=$${entryCreditDollars.toFixed(2)}, Exit=$${exitDebitDollars.toFixed(2)}, P&L=$${finalPnl.toFixed(2)}`);
        } else if (netEntryCreditDollars > 0 || netExitDebitDollars > 0) {
          // Fallback: use combo order fill price (already converted to dollars)
          groupCalc = calculateGroupPnl(netEntryCreditDollars, netExitDebitDollars, contracts, 100, fees);
          groupPnl = groupCalc.pnl;
          pnlStatus = 'computed';
          console.log(`[updateCloseStatus] Combo P&L: Entry=$${netEntryCreditDollars.toFixed(2)}, Exit=$${netExitDebitDollars.toFixed(2)}, P&L=$${groupCalc.pnl.toFixed(2)}`);
        }

        // Build side data map from inference (preferred)
        const legSideData = new Map<string, { openSide: string; closeSide: string }>();

        if (inferredLegs.length > 0) {
          for (const trade of typedTrades) {
            const inferred = getInferredSide(inferredLegs, trade.symbol);
            if (inferred) {
              legSideData.set(trade.id!, { openSide: inferred.openSide, closeSide: inferred.closeSide });
            }
          }
        }

        // Fall back to position_group_map only for legs where inference failed
        for (const trade of typedTrades) {
          if (!legSideData.has(trade.id!)) {
            const { data: mapping } = await supabase
              .from('position_group_map')
              .select('leg_qty, leg_side')
              .eq('symbol', trade.symbol)
              .eq('trade_group_id', trade.trade_group_id)
              .maybeSingle();

            if (mapping?.leg_side) {
              const closeSide = mapping.leg_side === 'sell_to_open' ? 'buy_to_close' :
                               mapping.leg_side === 'buy_to_open' ? 'sell_to_close' : null;
              if (closeSide) {
                legSideData.set(trade.id!, { openSide: mapping.leg_side, closeSide });
              }
            }
          }
        }

        // Update all legs with group info
        const updateErrors: string[] = [];
        for (let i = 0; i < typedTrades.length; i++) {
          const trade = typedTrades[i];
          const isPrimaryLeg = i === 0;
          const sides = legSideData.get(trade.id!);
          const legFill = details?.legFills?.[trade.symbol];

          const updates: Record<string, any> = {
            close_status: 'filled',
            close_filled_at: now,
            exit_time: now,
            needs_reconcile: false,
            // Persist entry_credit in dollars on all legs
            entry_credit: netEntryCreditDollars,
            // IMMUTABLE P&L tracking
            entry_credit_dollars: entryCreditDollars,
            pnl_status: pnlStatus,
            pnl_computed_at: groupCalc ? now : null,
            // Set exit_price from per-leg fills
            ...(legFill?.avgFillPrice != null && {
              exit_price: legFill.avgFillPrice,
              close_avg_fill_price: legFill.avgFillPrice,
            }),
          };

          // Store exit values only on primary leg
          // IMPORTANT: Use the same exit debit value that was used for P&L calculation
          // exitDebitDollars = direction-aware per-leg calculation (preferred)
          // netExitDebitDollars = combo fill price calculation (fallback)
          if (isPrimaryLeg) {
            // Prefer per-leg calculation if available, otherwise use combo price
            const exitDebitToStore = (exitDebitDollars !== 0) ? exitDebitDollars : netExitDebitDollars;
            updates.exit_debit = exitDebitToStore;
            updates.exit_debit_dollars = exitDebitDollars || null;
          }

          // Detect exit_price_source: PER_LEG if we have all leg fills, COMBO_NET if using combo price
          const exitPriceSource = (hasAllLegFills && exitDebitDollars !== 0) ? 'PER_LEG' : 'COMBO_NET';
          updates.exit_price_source = exitPriceSource;

          // Fix side labels from inference
          if (sides) {
            updates.open_side = sides.openSide;
            updates.close_side = sides.closeSide;
          }

          // P&L: Store group total on primary leg, zero on others
          if (groupCalc) {
            if (isPrimaryLeg) {
              updates.pnl = groupCalc.pnl;
              updates.pnl_percent = groupCalc.pnlPercent;
              updates.pnl_formula = groupCalc.formula;
            } else {
              updates.pnl = 0;
              updates.pnl_percent = 0;
              updates.pnl_formula = 'Included in group total';
            }
          }

          // CRITICAL: Capture and log errors - previously these failed silently
          const { error: updateError } = await supabase.from('trades').update(updates).eq('id', trade.id);
          if (updateError) {
            console.error(`[updateCloseStatus] Failed to update trade ${trade.id} (${trade.symbol}):`, updateError.message);
            updateErrors.push(`${trade.symbol}: ${updateError.message}`);
          }
        }

        // Return failure if any updates failed
        if (updateErrors.length > 0) {
          console.error(`[updateCloseStatus] ${updateErrors.length} leg updates failed for closeOrderId=${closeOrderId}`);
          return { success: false, error: `Failed to update ${updateErrors.length} legs: ${updateErrors.join('; ')}` };
        }

        return { success: true, groupPnl };
      }

      // === SINGLE-LEG ORDER or non-filled status ===
      for (const row of trades) {
        const trade = castToTradeRecord(row);
        const now = new Date().toISOString();
        const updates: Record<string, any> = { close_status: status };

        if (status === 'filled') {
          updates.close_filled_at = now;
          updates.exit_time = now;

          // Get leg data from mapping for correct quantity and side
          const { data: mapping } = await supabase
            .from('position_group_map')
            .select('leg_qty, leg_side')
            .eq('symbol', trade.symbol)
            .eq('trade_group_id', trade.trade_group_id)
            .maybeSingle();

          const legFill = details?.legFills?.[trade.symbol];
          const fillPrice = legFill?.avgFillPrice ?? details?.avgFillPrice;
          const fillQty = mapping?.leg_qty ?? legFill?.filledQty ?? details?.filledQty ?? trade.quantity;
          const openSide = mapping?.leg_side || details?.open_side || trade.open_side;
          const closeSide = openSide === 'sell_to_open' ? 'buy_to_close' :
                           openSide === 'buy_to_open' ? 'sell_to_close' :
                           legFill?.side;

          if (fillPrice != null) {
            updates.close_avg_fill_price = fillPrice;
            updates.exit_price = fillPrice;
            updates.exit_price_source = 'PER_LEG'; // Single-leg always has per-leg fill
          }
          updates.close_filled_qty = fillQty;
          updates.quantity = fillQty;
          updates.close_side = closeSide;
          updates.open_side = openSide;

          if (details?.fees != null) {
            updates.fees = details.fees;
          }

          // Compute per-leg P&L for single-leg orders
          const openPrice = trade.entry_price;
          const closePrice = fillPrice ?? trade.exit_price;
          const fees = details?.fees ?? trade.fees ?? 0;

          if (openSide && openPrice && closePrice && fillQty) {
            const pnlCalc = calculatePnl(openSide, openPrice, closePrice, fillQty, 100, fees);
            if (pnlCalc) {
              updates.pnl = pnlCalc.pnl;
              updates.pnl_percent = pnlCalc.pnlPercent;
              updates.pnl_formula = pnlCalc.formula;
              updates.needs_reconcile = false;
              // IMMUTABLE P&L tracking for single-leg
              updates.pnl_status = 'computed';
              updates.pnl_computed_at = now;
            } else {
              updates.pnl_status = 'missing_fills';
            }
          } else {
            updates.pnl_status = 'missing_fills';
          }
        } else if (status === 'rejected' || status === 'canceled' || status === 'expired') {
          updates.close_reject_reason = details?.rejectReason || status;
          // Do NOT set exit_time, exit_price, pnl - trade is still open
          updates.pnl = null;
          updates.needs_reconcile = true;
          updates.pnl_status = 'pending';
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

  /**
   * Get trades that need manual recovery (timeout_unknown, rejected, canceled, expired)
   * These are orders that failed or timed out and require user intervention
   */
  async getTradesNeedingRecovery(): Promise<TradeRecord[]> {
    try {
      const { data, error } = await supabase
        .from('trades')
        .select('*')
        .in('close_status', ['timeout_unknown', 'rejected', 'canceled', 'expired'])
        .order('close_submitted_at', { ascending: false });

      if (error) throw error;
      return (data || []).map(castToTradeRecord);
    } catch (error) {
      console.error('Error fetching trades needing recovery:', error);
      return [];
    }
  },

  /**
   * Mark a timed-out trade as manually verified (either filled or still open)
   * Called by recovery UI when user has verified the order status in Tradier
   *
   * @param tradeId - The trade record ID
   * @param actualStatus - The verified status: 'filled' (close completed) or 'open' (close failed, position still exists)
   * @param details - Fill details if status is 'filled'
   */
  async resolveTimedOutTrade(
    tradeId: string,
    actualStatus: 'filled' | 'open',
    details?: {
      avgFillPrice?: number;
      filledQty?: number;
      fees?: number;
    }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (actualStatus === 'filled') {
        // User verified the order was filled - update with provided details
        const updates: Record<string, any> = {
          close_status: 'filled',
          close_filled_at: new Date().toISOString(),
          needs_reconcile: true, // Still needs P&L reconciliation
        };

        if (details?.avgFillPrice != null) {
          updates.close_avg_fill_price = details.avgFillPrice;
          updates.exit_price = details.avgFillPrice;
        }
        if (details?.filledQty != null) {
          updates.close_filled_qty = details.filledQty;
        }
        if (details?.fees != null) {
          updates.fees = details.fees;
        }

        const { error } = await supabase
          .from('trades')
          .update(updates)
          .eq('id', tradeId);

        if (error) throw error;
        return { success: true };
      } else {
        // User verified the order was NOT filled - position is still open
        // Delete the trade record so it doesn't show as a ghost trade
        const { error } = await supabase
          .from('trades')
          .delete()
          .eq('id', tradeId);

        if (error) throw error;
        return { success: true };
      }
    } catch (error) {
      console.error('Error resolving timed-out trade:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  /**
   * DB HYGIENE: Force pnl/pnl_percent to NULL for any non-filled trades
   * This ensures stale values can't leak into stats
   */
  async sanitizeNonFilledTrades(): Promise<{ success: boolean; sanitized: number; error?: string }> {
    try {
      // Find trades where close_status != 'filled' but pnl is not null
      const { data: trades, error: fetchError } = await supabase
        .from('trades')
        .select('id, close_status, pnl, pnl_percent')
        .or('close_status.neq.filled,close_status.is.null');

      if (fetchError) throw fetchError;

      let sanitized = 0;
      const toUpdate = (trades || []).filter(t => t.pnl != null || t.pnl_percent != null);

      for (const trade of toUpdate) {
        const { error: updateError } = await supabase
          .from('trades')
          .update({
            pnl: null,
            pnl_percent: null,
            pnl_formula: null,
            needs_reconcile: true,
          })
          .eq('id', trade.id);

        if (!updateError) {
          sanitized++;
        }
      }

      console.log(`DB Hygiene: Sanitized ${sanitized} trades with non-filled close_status`);
      return { success: true, sanitized };
    } catch (error) {
      console.error('Error sanitizing non-filled trades:', error);
      return { 
        success: false, 
        sanitized: 0,
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  },

  /**
   * Recover missing fill data for trades marked as needs_reconcile
   * Fetches actual fill prices from Tradier order history and updates P&L
   */
  async reconcileMissingFills(): Promise<{
    success: boolean;
    recovered: number;
    stillMissing: number;
    errors: string[];
  }> {
    const errors: string[] = [];
    let recovered = 0;
    let stillMissing = 0;

    // Get trades with missing fills
    const { data: trades, error } = await supabase
      .from('trades')
      .select('*')
      .eq('needs_reconcile', true)
      .eq('pnl_status', 'missing_fills')
      .not('close_order_id', 'is', null);

    if (error) {
      return { success: false, recovered: 0, stillMissing: 0, errors: [error.message] };
    }

    if (!trades || trades.length === 0) {
      console.log('[reconcileMissingFills] No trades with missing fills found');
      return { success: true, recovered: 0, stillMissing: 0, errors: [] };
    }

    // Group by close_order_id
    const orderIds = [...new Set(trades.map(t => t.close_order_id).filter(Boolean))];
    console.log(`[reconcileMissingFills] Found ${orderIds.length} orders to reconcile`);

    for (const orderId of orderIds) {
      try {
        // Fetch order details from Tradier
        const { data: orderData, error: fetchError } = await supabase.functions.invoke('tradier-api', {
          body: { action: 'order_status', orderId },
        });

        if (fetchError || !orderData?.closeStatus) {
          errors.push(`Order ${orderId}: Failed to fetch - ${fetchError?.message || 'Unknown error'}`);
          stillMissing++;
          continue;
        }

        if (orderData.closeStatus !== 'filled') {
          errors.push(`Order ${orderId}: Status is ${orderData.closeStatus}, not filled`);
          stillMissing++;
          continue;
        }

        // Check if we have valid fill data now
        const hasValidComboPrice = orderData.avgFillPrice && orderData.avgFillPrice > 0.01;
        const hasLegFills = orderData.legFills && Object.keys(orderData.legFills).length > 0;

        if (!hasValidComboPrice && !hasLegFills) {
          console.log(`[reconcileMissingFills] Order ${orderId} still missing fill data`);
          stillMissing++;
          continue;
        }

        // Update trades with recovered fill data
        const result = await this.updateCloseStatus(orderId, 'filled', {
          avgFillPrice: orderData.avgFillPrice,
          filledQty: orderData.filledQty,
          legFills: orderData.legFills,
          isComboOrder: true,
        });

        if (result.success) {
          console.log(`[reconcileMissingFills] Recovered order ${orderId}`);
          recovered++;
        } else {
          errors.push(`Order ${orderId}: Update failed - ${result.error}`);
          stillMissing++;
        }

      } catch (err) {
        errors.push(`Order ${orderId}: ${err instanceof Error ? err.message : 'Unknown error'}`);
        stillMissing++;
      }
    }

    console.log(`[reconcileMissingFills] Complete: recovered=${recovered}, stillMissing=${stillMissing}, errors=${errors.length}`);
    return { success: true, recovered, stillMissing, errors };
  },

  /**
   * Clear ALL trades from the database
   * WARNING: This permanently deletes all trade history
   */
  async clearAllTrades(): Promise<{ success: boolean; deleted: number; error?: string }> {
    try {
      // First count how many we're about to delete
      const { count, error: countError } = await supabase
        .from('trades')
        .select('*', { count: 'exact', head: true });

      if (countError) throw countError;

      // Delete all trades
      const { error: deleteError } = await supabase
        .from('trades')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all (workaround for "delete all" requirement)

      if (deleteError) throw deleteError;

      console.log(`Cleared ${count || 0} trades from database`);
      return { success: true, deleted: count || 0 };
    } catch (error) {
      console.error('Error clearing trades:', error);
      return { 
        success: false, 
        deleted: 0,
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  },
};
