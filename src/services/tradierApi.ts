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

  async closePosition(symbol: string, quantity: number): Promise<{ success: boolean; orderId?: string; error?: string }> {
    try {
      const { data, error } = await supabase.functions.invoke('tradier-api', {
        body: { action: 'close_position', positionSymbol: symbol, positionQuantity: quantity },
      });

      if (error) throw error;
      
      if (data?.order?.id) {
        return { success: true, orderId: data.order.id };
      }
      
      return { success: false, error: data?.errors?.error || 'Order failed' };
    } catch (error) {
      console.error('Error closing position:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
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

// Parse OCC option symbol (e.g., SPY260112C00700000)
export const parseOptionSymbol = (symbol: string): { underlying: string; expiration: string; type: 'call' | 'put'; strike: number } | null => {
  // OCC format: SYMBOL + YYMMDD + C/P + 8-digit strike (multiplied by 1000)
  const match = symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  
  const [, underlying, dateStr, typeChar, strikeStr] = match;
  const year = 2000 + parseInt(dateStr.slice(0, 2));
  const month = parseInt(dateStr.slice(2, 4)) - 1;
  const day = parseInt(dateStr.slice(4, 6));
  const expiration = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const strike = parseInt(strikeStr) / 1000;
  
  return {
    underlying,
    expiration,
    type: typeChar === 'C' ? 'call' : 'put',
    strike,
  };
};

// Helper to calculate portfolio Greeks from positions
export const calculatePortfolioGreeks = (positions: Position[], optionData: any[]): Greeks => {
  let delta = 0;
  let gamma = 0;
  let theta = 0;
  let vega = 0;

  // Match positions with option data and sum Greeks
  positions.forEach(pos => {
    // First try direct symbol match
    let optionInfo = optionData.find(o => o.symbol === pos.symbol);
    
    // If not found, try matching by parsed strike/type
    if (!optionInfo) {
      const parsed = parseOptionSymbol(pos.symbol);
      if (parsed) {
        optionInfo = optionData.find(o => 
          o.strike === parsed.strike && 
          o.option_type === parsed.type
        );
      }
    }
    
    if (optionInfo?.greeks) {
      const multiplier = pos.quantity; // Already in contracts
      delta += (optionInfo.greeks.delta || 0) * multiplier;
      gamma += (optionInfo.greeks.gamma || 0) * multiplier;
      theta += (optionInfo.greeks.theta || 0) * multiplier;
      vega += (optionInfo.greeks.vega || 0) * multiplier;
    }
  });

  return { delta, gamma, theta, vega };
};
