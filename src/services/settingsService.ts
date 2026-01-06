import { supabase } from '@/integrations/supabase/client';
import type { Strategy, RiskStatus, TradeSafeguards, EntryConditions, ExitConditions, StrategyType } from '@/types/trading';
import type { Json } from '@/integrations/supabase/types';

export const settingsService = {
  // Load strategies from database
  async getStrategies(): Promise<Strategy[]> {
    const { data, error } = await supabase
      .from('strategies')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error loading strategies:', error);
      return [];
    }

    if (!data) return [];

    return data.map(s => ({
      id: s.id,
      name: s.name,
      type: s.type as StrategyType,
      underlying: s.underlying,
      enabled: s.enabled,
      maxPositions: s.max_positions,
      positionSize: s.position_size,
      entryConditions: s.entry_conditions as unknown as EntryConditions,
      exitConditions: s.exit_conditions as unknown as ExitConditions,
    }));
  },

  // Save a new strategy
  async addStrategy(strategy: Omit<Strategy, 'id'>): Promise<Strategy | null> {
    const { data, error } = await supabase
      .from('strategies')
      .insert({
        name: strategy.name,
        type: strategy.type,
        underlying: strategy.underlying,
        enabled: strategy.enabled,
        max_positions: strategy.maxPositions,
        position_size: strategy.positionSize,
        entry_conditions: strategy.entryConditions as unknown as Json,
        exit_conditions: strategy.exitConditions as unknown as Json,
      })
      .select()
      .single();

    if (error) {
      console.error('Error adding strategy:', error);
      return null;
    }

    if (!data) return null;

    return {
      id: data.id,
      name: data.name,
      type: data.type as StrategyType,
      underlying: data.underlying,
      enabled: data.enabled,
      maxPositions: data.max_positions,
      positionSize: data.position_size,
      entryConditions: data.entry_conditions as unknown as EntryConditions,
      exitConditions: data.exit_conditions as unknown as ExitConditions,
    };
  },

  // Update strategy enabled state
  async updateStrategyEnabled(strategyId: string, enabled: boolean): Promise<boolean> {
    const { error } = await supabase
      .from('strategies')
      .update({ enabled, updated_at: new Date().toISOString() })
      .eq('id', strategyId);

    if (error) {
      console.error('Error updating strategy:', error);
      return false;
    }
    return true;
  },

  // Delete a strategy
  async deleteStrategy(strategyId: string): Promise<boolean> {
    const { error } = await supabase
      .from('strategies')
      .delete()
      .eq('id', strategyId);

    if (error) {
      console.error('Error deleting strategy:', error);
      return false;
    }
    return true;
  },

  // Load settings from database
  async getSettings(): Promise<{ riskStatus: Partial<RiskStatus>; safeguards: TradeSafeguards } | null> {
    const { data, error } = await supabase
      .from('settings')
      .select('*')
      .limit(1)
      .single();

    if (error) {
      console.error('Error loading settings:', error);
      return null;
    }

    if (!data) return null;

    return {
      riskStatus: {
        maxDailyLoss: Number(data.max_daily_loss),
        maxPositions: data.max_positions,
      },
      safeguards: {
        maxBidAskSpreadPercent: Number(data.max_bid_ask_spread_percent),
        zeroDteCloseBufferMinutes: data.zero_dte_close_buffer_minutes,
        fillPriceBufferPercent: Number(data.fill_price_buffer_percent),
      },
    };
  },

  // Update risk settings
  async updateRiskSettings(maxDailyLoss: number, maxPositions: number): Promise<boolean> {
    const { error } = await supabase
      .from('settings')
      .update({
        max_daily_loss: maxDailyLoss,
        max_positions: maxPositions,
        updated_at: new Date().toISOString(),
      })
      .neq('id', '00000000-0000-0000-0000-000000000000'); // Update all rows

    if (error) {
      console.error('Error updating risk settings:', error);
      return false;
    }
    return true;
  },

  // Update safeguards
  async updateSafeguards(safeguards: TradeSafeguards): Promise<boolean> {
    const { error } = await supabase
      .from('settings')
      .update({
        max_bid_ask_spread_percent: safeguards.maxBidAskSpreadPercent,
        zero_dte_close_buffer_minutes: safeguards.zeroDteCloseBufferMinutes,
        fill_price_buffer_percent: safeguards.fillPriceBufferPercent,
        updated_at: new Date().toISOString(),
      })
      .neq('id', '00000000-0000-0000-0000-000000000000'); // Update all rows

    if (error) {
      console.error('Error updating safeguards:', error);
      return false;
    }
    return true;
  },
};
