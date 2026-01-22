import { supabase } from '@/integrations/supabase/client';
import type { Strategy, RiskStatus, TradeSafeguards, EntryConditions, ExitConditions, StrategyType } from '@/types/trading';
import type { Json } from '@/integrations/supabase/types';

// Helper to map DB row to Strategy type
const mapDbToStrategy = (s: any): Strategy => ({
  id: s.id,
  name: s.name,
  type: s.type as StrategyType,
  underlying: s.underlying,
  enabled: s.enabled,
  maxPositions: s.max_positions,
  positionSize: s.position_size,
  entryConditions: s.entry_conditions as unknown as EntryConditions,
  exitConditions: s.exit_conditions as unknown as ExitConditions,
});

export const settingsService = {
  // Expose the mapper for real-time sync
  mapDbToStrategy,

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

    return data.map(mapDbToStrategy);
  },

  // Save a new strategy
  async addStrategy(strategy: Omit<Strategy, 'id'>): Promise<Strategy | null> {
    // Include sizing and trackedLegs in entry_conditions for the engine to read
    const entryConditionsWithExtras = {
      ...strategy.entryConditions,
      sizing: strategy.sizing,
      trackedLegs: strategy.trackedLegs,
    };

    const { data, error } = await supabase
      .from('strategies')
      .insert({
        name: strategy.name,
        type: strategy.type,
        underlying: strategy.underlying,
        enabled: strategy.enabled,
        max_positions: strategy.maxPositions,
        position_size: strategy.positionSize,
        entry_conditions: entryConditionsWithExtras as unknown as Json,
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

  // Update a strategy
  async updateStrategy(strategyId: string, strategy: Omit<Strategy, 'id'>): Promise<Strategy | null> {
    // Include sizing and trackedLegs in entry_conditions for the engine to read
    const entryConditionsWithExtras = {
      ...strategy.entryConditions,
      sizing: strategy.sizing,
      trackedLegs: strategy.trackedLegs,
    };

    const { data, error } = await supabase
      .from('strategies')
      .update({
        name: strategy.name,
        type: strategy.type,
        underlying: strategy.underlying,
        enabled: strategy.enabled,
        max_positions: strategy.maxPositions,
        position_size: strategy.positionSize,
        entry_conditions: entryConditionsWithExtras as unknown as Json,
        exit_conditions: strategy.exitConditions as unknown as Json,
        updated_at: new Date().toISOString(),
      })
      .eq('id', strategyId)
      .select()
      .single();

    if (error) {
      console.error('Error updating strategy:', error);
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
        maxCondorsPerExpiry: data.max_condors_per_expiry ?? 3,
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
        max_condors_per_expiry: safeguards.maxCondorsPerExpiry,
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
