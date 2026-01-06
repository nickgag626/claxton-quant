import { supabase } from '@/integrations/supabase/client';
import type { Quote, Position, Greeks, MarketState } from '@/types/trading';

interface TradierQuote {
  symbol: string;
  last: number;
  change: number;
  change_percentage: number;
  bid: number;
  ask: number;
  volume: number;
}

interface TradierPosition {
  id: number;
  symbol: string;
  quantity: number;
  cost_basis: number;
  date_acquired: string;
}

interface TradierBalance {
  total_equity: number;
  total_cash: number;
  market_value: number;
  open_pl: number;
  close_pl: number;
  pending_cash: number;
  uncleard_funds: number;
}

export const tradierApi = {
  async getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    try {
      const { data, error } = await supabase.functions.invoke('tradier-api', {
        body: { action: 'quote', symbols },
      });

      if (error) {
        console.error('Quote fetch error:', error);
        throw error;
      }

      const quotes: Record<string, Quote> = {};
      const quotesData = data?.quotes?.quote;
      
      if (!quotesData) return quotes;
      
      const quoteArray = Array.isArray(quotesData) ? quotesData : [quotesData];
      
      quoteArray.forEach((q: TradierQuote) => {
        quotes[q.symbol] = {
          symbol: q.symbol,
          last: q.last || 0,
          change: q.change || 0,
          changePercent: q.change_percentage || 0,
          bid: q.bid || 0,
          ask: q.ask || 0,
          volume: q.volume || 0,
        };
      });

      return quotes;
    } catch (error) {
      console.error('Failed to fetch quotes:', error);
      throw error;
    }
  },

  async getPositions(): Promise<Position[]> {
    try {
      const { data, error } = await supabase.functions.invoke('tradier-api', {
        body: { action: 'positions' },
      });

      if (error) {
        console.error('Positions fetch error:', error);
        throw error;
      }

      const positionsData = data?.positions?.position;
      
      if (!positionsData) return [];
      
      const posArray = Array.isArray(positionsData) ? positionsData : [positionsData];
      
      return posArray.map((p: TradierPosition) => ({
        id: String(p.id),
        symbol: p.symbol,
        quantity: p.quantity,
        costBasis: p.cost_basis,
        currentValue: p.cost_basis, // Will be updated with live price
        status: 'open' as const,
        entryTime: new Date(p.date_acquired),
      }));
    } catch (error) {
      console.error('Failed to fetch positions:', error);
      throw error;
    }
  },

  async getBalances(): Promise<TradierBalance | null> {
    try {
      const { data, error } = await supabase.functions.invoke('tradier-api', {
        body: { action: 'balances' },
      });

      if (error) {
        console.error('Balances fetch error:', error);
        throw error;
      }

      return data?.balances || null;
    } catch (error) {
      console.error('Failed to fetch balances:', error);
      throw error;
    }
  },

  async getMarketClock(): Promise<{ state: MarketState; timestamp: string }> {
    try {
      const { data, error } = await supabase.functions.invoke('tradier-api', {
        body: { action: 'clock' },
      });

      if (error) {
        console.error('Clock fetch error:', error);
        throw error;
      }

      const clock = data?.clock;
      let state: MarketState = 'unknown';
      
      if (clock?.state) {
        const stateMap: Record<string, MarketState> = {
          'open': 'open',
          'premarket': 'premarket',
          'postmarket': 'postmarket',
          'closed': 'closed',
        };
        state = stateMap[clock.state] || 'unknown';
      }

      return {
        state,
        timestamp: clock?.timestamp || new Date().toISOString(),
      };
    } catch (error) {
      console.error('Failed to fetch market clock:', error);
      return { state: 'unknown', timestamp: new Date().toISOString() };
    }
  },

  async getOptionExpirations(symbol: string): Promise<string[]> {
    try {
      const { data, error } = await supabase.functions.invoke('tradier-api', {
        body: { action: 'expirations', symbol },
      });

      if (error) {
        console.error('Expirations fetch error:', error);
        throw error;
      }

      const expirations = data?.expirations?.date;
      if (!expirations) return [];
      
      return Array.isArray(expirations) ? expirations : [expirations];
    } catch (error) {
      console.error('Failed to fetch expirations:', error);
      throw error;
    }
  },

  async getOptionChain(symbol: string, expiration: string): Promise<any[]> {
    try {
      const { data, error } = await supabase.functions.invoke('tradier-api', {
        body: { action: 'chain', symbol, expiration },
      });

      if (error) {
        console.error('Chain fetch error:', error);
        throw error;
      }

      const options = data?.options?.option;
      if (!options) return [];
      
      return Array.isArray(options) ? options : [options];
    } catch (error) {
      console.error('Failed to fetch option chain:', error);
      throw error;
    }
  },
};

// Helper to calculate portfolio Greeks from positions
export const calculatePortfolioGreeks = (positions: Position[], optionData: any[]): Greeks => {
  let delta = 0;
  let gamma = 0;
  let theta = 0;
  let vega = 0;

  // Match positions with option data and sum Greeks
  positions.forEach(pos => {
    const optionInfo = optionData.find(o => o.symbol === pos.symbol);
    if (optionInfo?.greeks) {
      const multiplier = pos.quantity * 100; // Options are 100 shares
      delta += (optionInfo.greeks.delta || 0) * multiplier;
      gamma += (optionInfo.greeks.gamma || 0) * multiplier;
      theta += (optionInfo.greeks.theta || 0) * multiplier;
      vega += (optionInfo.greeks.vega || 0) * multiplier;
    }
  });

  return { delta, gamma, theta, vega };
};
