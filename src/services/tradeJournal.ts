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

export const tradeJournal = {
  async saveTrade(trade: Omit<TradeRecord, 'id'>): Promise<{ success: boolean; error?: string; id?: string }> {
    try {
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
          pnl: trade.pnl,
          pnl_percent: trade.pnl_percent,
          exit_reason: trade.exit_reason,
          notes: trade.notes,
          trade_group_id: trade.trade_group_id,
        })
        .select('id')
        .single();

      if (error) throw error;
      return { success: true, id: data?.id };
    } catch (error) {
      console.error('Error saving trade:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  },

  // Save multiple trades as a group (for spreads, iron condors, etc.)
  async saveTradeGroup(trades: Omit<TradeRecord, 'id' | 'trade_group_id'>[]): Promise<{ success: boolean; error?: string; groupId?: string }> {
    if (trades.length === 0) return { success: false, error: 'No trades to save' };
    
    // Generate a group ID
    const groupId = crypto.randomUUID();
    
    try {
      const { error } = await supabase
        .from('trades')
        .insert(trades.map(trade => ({
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
          pnl: trade.pnl,
          pnl_percent: trade.pnl_percent,
          exit_reason: trade.exit_reason,
          notes: trade.notes,
          trade_group_id: groupId,
        })));

      if (error) throw error;
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

  // Get trades grouped by trade_group_id
  async getGroupedTrades(limit = 50): Promise<(TradeRecord | TradeGroup)[]> {
    try {
      const { data, error } = await supabase
        .from('trades')
        .select('*')
        .order('exit_time', { ascending: false })
        .limit(limit * 4); // Fetch more to account for legs

      if (error) throw error;
      
      const trades = data || [];
      const grouped = new Map<string, TradeRecord[]>();
      const ungrouped: TradeRecord[] = [];

      // Separate grouped and ungrouped trades
      trades.forEach(trade => {
        if (trade.trade_group_id) {
          const existing = grouped.get(trade.trade_group_id) || [];
          existing.push(trade);
          grouped.set(trade.trade_group_id, existing);
        } else {
          ungrouped.push(trade);
        }
      });

      // Build result array with groups and singles
      const result: (TradeRecord | TradeGroup)[] = [];
      const processedGroupIds = new Set<string>();

      // Go through original order and insert groups/singles
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

  async getTradeStats(): Promise<{
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    totalPnl: number;
    winRate: number;
    avgWinner: number;
    avgLoser: number;
  }> {
    try {
      const { data, error } = await supabase
        .from('trades')
        .select('pnl');

      if (error) throw error;

      const trades = data || [];
      const winners = trades.filter(t => t.pnl > 0);
      const losers = trades.filter(t => t.pnl < 0);
      
      const totalPnl = trades.reduce((sum, t) => sum + Number(t.pnl), 0);
      const avgWinner = winners.length > 0 
        ? winners.reduce((sum, t) => sum + Number(t.pnl), 0) / winners.length 
        : 0;
      const avgLoser = losers.length > 0 
        ? losers.reduce((sum, t) => sum + Number(t.pnl), 0) / losers.length 
        : 0;

      return {
        totalTrades: trades.length,
        winningTrades: winners.length,
        losingTrades: losers.length,
        totalPnl,
        winRate: trades.length > 0 ? (winners.length / trades.length) * 100 : 0,
        avgWinner,
        avgLoser,
      };
    } catch (error) {
      console.error('Error fetching trade stats:', error);
      return {
        totalTrades: 0,
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
};
