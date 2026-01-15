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

/**
 * GROUP-LEVEL NET P&L CALCULATION (for multi-leg orders like iron condors)
 * 
 * Formula: P&L = (Net Entry Credit - Net Exit Debit) × multiplier × contracts
 * 
 * This is the CORRECT way to calculate P&L for combo orders:
 * - Entry credit: The net premium received when opening the position
 * - Exit debit: The net premium paid when closing the position
 * - Contracts: Number of contracts (NOT number of legs)
 * 
 * Example:
 * - Entry credit: $1.18 (sold for net $1.18 credit)
 * - Exit debit: $1.19 (bought back for net $1.19 debit)
 * - Contracts: 4
 * - P&L = ($1.18 - $1.19) × 100 × 4 = -$4.00
 */
export function calculateGroupPnl(
  netEntryCredit: number,  // Total net credit received at entry (from entry_credit)
  netExitDebit: number,    // Total net debit paid at exit (combo order fill price)
  contracts: number,       // Number of contracts (NOT number of legs)
  multiplier: number = 100,
  fees: number = 0
): { pnl: number; pnlPercent: number; formula: string } {
  // P&L = (Credit Received - Debit Paid) × multiplier × contracts - fees
  const pnl = (netEntryCredit - netExitDebit) * multiplier * contracts - fees;
  const pnlPercent = netEntryCredit > 0 
    ? ((netEntryCredit - netExitDebit) / netEntryCredit) * 100 
    : 0;
  
  const formula = `(${netEntryCredit.toFixed(4)} - ${netExitDebit.toFixed(4)}) × ${multiplier} × ${contracts} - ${fees.toFixed(2)} = ${pnl.toFixed(2)}`;
  
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
            
            // Check if all legs are filled
            const allFilled = groupTrades.every(t => t.close_status === 'filled');
            const hasUnfinalized = !allFilled || groupTrades.some(t => t.needs_reconcile);
            
            // === GROUP-LEVEL NET P&L CALCULATION ===
            // Use entry_credit and exit_debit for net calculation (not per-leg sums)
            let totalPnl = 0;
            
            if (allFilled) {
              // Get net entry credit (should be same for all legs in a group)
              const netEntryCredit = groupTrades[0]?.entry_credit || 0;
              // Get net exit debit (stored on first leg, or use exit_debit if available)
              const netExitDebit = groupTrades[0]?.exit_debit || 0;
              // Get contracts count (from first leg's quantity - NOT number of legs)
              const contracts = groupTrades[0]?.quantity || 1;
              
              // If we have proper entry_credit and exit_debit, use group formula
              if (netEntryCredit > 0 && netExitDebit > 0) {
                const groupCalc = calculateGroupPnl(netEntryCredit, netExitDebit, contracts, 100, 0);
                totalPnl = groupCalc.pnl;
              } else {
                // Fallback: Sum individual leg P&Ls (legacy data)
                const finalizedLegs = groupTrades.filter(t => isFullyFinalized(t));
                totalPnl = finalizedLegs.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
              }
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
   */
  async recalculatePnl(): Promise<{ success: boolean; updated: number; skipped: number; sanitized: number; errors: string[] }> {
    try {
      const { data: trades, error } = await supabase
        .from('trades')
        .select('*');

      if (error) throw error;

      let updated = 0;
      let skipped = 0;
      let sanitized = 0;
      const errors: string[] = [];

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
        // Sort by entry_time to ensure consistent first leg
        groupLegs.sort((a, b) => 
          new Date(a.entry_time || 0).getTime() - new Date(b.entry_time || 0).getTime()
        );

        const firstLeg = groupLegs[0];
        
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
              }).eq('id', leg.id);
              sanitized++;
            } else {
              skipped++;
            }
          }
          continue;
        }

        // Multi-leg group: use group-level P&L calculation
        if (groupLegs.length > 1) {
          const entryCredit = Number(firstLeg.entry_credit) || 0;
          // Use exit_debit if available, otherwise use first leg's exit_price (which is the combo net price)
          // DO NOT sum exit_price across legs - each leg stores the same combo net price
          const exitDebit = Number(firstLeg.exit_debit) || Number(firstLeg.exit_price) || 0;
          const contracts = Number(firstLeg.quantity) || 1;
          const totalFees = groupLegs.reduce((sum, t) => sum + (Number(t.fees) || 0), 0);

          // Validate we have entry/exit data
          if (entryCredit === 0 && exitDebit === 0) {
            errors.push(`Group ${groupId.slice(0, 8)}: Missing entry_credit and exit_debit`);
            for (const leg of groupLegs) {
              await supabase.from('trades').update({ 
                needs_reconcile: true,
                pnl: null,
                pnl_percent: null,
                pnl_formula: null,
              }).eq('id', leg.id);
            }
            skipped += groupLegs.length;
            continue;
          }

          const groupCalc = calculateGroupPnl(entryCredit, exitDebit, contracts, 100, totalFees);
          
          // Also fix close_side labels by looking up from position_group_map
          const legSideData = new Map<string, { openSide: string; closeSide: string | null }>();
          for (const leg of groupLegs) {
            const { data: mapping } = await supabase
              .from('position_group_map')
              .select('leg_side')
              .eq('symbol', leg.symbol)
              .eq('trade_group_id', leg.trade_group_id)
              .maybeSingle();
            if (mapping?.leg_side) {
              const closeSide = mapping.leg_side === 'sell_to_open' ? 'buy_to_close' : 
                               mapping.leg_side === 'buy_to_open' ? 'sell_to_close' : null;
              legSideData.set(leg.id!, { openSide: mapping.leg_side, closeSide });
            }
          }

          // Update first leg with group P&L and correct sides
          const firstLegSides = legSideData.get(firstLeg.id!);
          const { error: firstLegError } = await supabase.from('trades').update({
            pnl: groupCalc.pnl,
            pnl_percent: groupCalc.pnlPercent,
            pnl_formula: groupCalc.formula,
            needs_reconcile: false,
            ...(firstLegSides ? { 
              open_side: firstLegSides.openSide, 
              close_side: firstLegSides.closeSide 
            } : {}),
          }).eq('id', firstLeg.id);

          if (firstLegError) {
            errors.push(`Trade ${firstLeg.id}: ${firstLegError.message}`);
          } else {
            updated++;
          }

          // Set other legs to 0 P&L (included in group total) and fix their sides
          for (let i = 1; i < groupLegs.length; i++) {
            const leg = groupLegs[i];
            const legSides = legSideData.get(leg.id!);
            const { error: legError } = await supabase.from('trades').update({
              pnl: 0,
              pnl_percent: 0,
              pnl_formula: 'Included in group total',
              needs_reconcile: false,
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
          ungroupedTrades.push(firstLeg);
        }
      }

      // Step 3: Process single-leg trades using per-leg calculation
      for (const trade of ungroupedTrades) {
        // HARD RULE: If close_status is not 'filled', nullify P&L
        if (trade.close_status !== 'filled') {
          if (trade.pnl != null || trade.pnl_percent != null || !trade.needs_reconcile) {
            await supabase.from('trades').update({ 
              needs_reconcile: true,
              pnl: null,
              pnl_percent: null,
              pnl_formula: null,
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

      return { success: true, updated, skipped, sanitized, errors };
    } catch (error) {
      console.error('Error recalculating P&L:', error);
      return { 
        success: false, 
        updated: 0, 
        skipped: 0,
        sanitized: 0,
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
        // avgFillPrice from Tradier is the NET exit debit for the entire combo
        const netExitDebit = Math.abs(details.avgFillPrice); // Ensure positive for debit
        
        // Get net entry credit from first leg (should be same for all legs in group)
        const firstTrade = castToTradeRecord(trades[0]);
        const netEntryCredit = firstTrade.entry_credit || 0;
        const contracts = details.filledQty || firstTrade.quantity || 1;
        const fees = details.fees || 0;
        
        // Calculate group P&L using net credit/debit formula
        let groupCalc: { pnl: number; pnlPercent: number; formula: string } | null = null;
        
        if (netEntryCredit > 0) {
          groupCalc = calculateGroupPnl(netEntryCredit, netExitDebit, contracts, 100, fees);
          groupPnl = groupCalc.pnl;
          console.log(`[updateCloseStatus] Multi-leg combo P&L: Entry Credit=$${netEntryCredit}, Exit Debit=$${netExitDebit}, Contracts=${contracts}, P&L=$${groupCalc.pnl}`);
        }
        
        // Update all legs with group info
        for (let i = 0; i < trades.length; i++) {
          const trade = castToTradeRecord(trades[i]);
          const isFirstLeg = i === 0;
          
          // Get leg-specific data from mapping if available
          const { data: mapping } = await supabase
            .from('position_group_map')
            .select('leg_qty, leg_side')
            .eq('symbol', trade.symbol)
            .eq('trade_group_id', trade.trade_group_id)
            .maybeSingle();
          
          const legQty = mapping?.leg_qty || trade.quantity;
          const openSide = mapping?.leg_side || trade.open_side;
          const closeSide = openSide === 'sell_to_open' ? 'buy_to_close' : 
                           openSide === 'buy_to_open' ? 'sell_to_close' : 
                           null;
          
          const updates: Record<string, any> = {
            close_status: 'filled',
            close_filled_at: new Date().toISOString(),
            exit_time: new Date().toISOString(),
            exit_debit: isFirstLeg ? netExitDebit : null, // Store exit debit on first leg only
            quantity: legQty,
            open_side: openSide,
            close_side: closeSide,
            needs_reconcile: false,
          };
          
          // P&L: Store group total on first leg, zero on others
          if (groupCalc) {
            if (isFirstLeg) {
              updates.pnl = groupCalc.pnl;
              updates.pnl_percent = groupCalc.pnlPercent;
              updates.pnl_formula = groupCalc.formula;
            } else {
              updates.pnl = 0; // Other legs contribute 0 (total is on first leg)
              updates.pnl_percent = 0;
              updates.pnl_formula = 'Included in group total (see first leg)';
            }
          }
          
          await supabase.from('trades').update(updates).eq('id', trade.id);
        }
        
        return { success: true, groupPnl };
      }

      // === SINGLE-LEG ORDER or non-filled status ===
      for (const row of trades) {
        const trade = castToTradeRecord(row);
        const updates: Record<string, any> = { close_status: status };

        if (status === 'filled') {
          updates.close_filled_at = new Date().toISOString();
          updates.exit_time = new Date().toISOString();
          
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
