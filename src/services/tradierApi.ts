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
  async ping(): Promise<{ ok: boolean; timestamp?: string; error?: string; details?: any }> {
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/tradier-api`;
    console.log('[tradierApi.ping] Request URL:', url);
    
    try {
      const { data, error } = await supabase.functions.invoke('tradier-api', {
        body: { action: 'ping' },
      });

      if (error) {
        console.error('[tradierApi.ping] Supabase invoke error:', error);
        return { ok: false, error: error.message, details: error };
      }

      console.log('[tradierApi.ping] Response:', data);
      return { ok: data?.ok ?? false, timestamp: data?.timestamp };
    } catch (err) {
      const isCors = err instanceof TypeError && err.message.includes('Failed to fetch');
      console.error('[tradierApi.ping] Network/CORS error:', { error: err, isCors });
      return {
        ok: false,
        error: isCors ? 'CORS/network error - edge function unreachable' : String(err),
        details: { isCors, raw: String(err) },
      };
    }
  },

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
      
      // Get live quotes for all position symbols to calculate current value
      const symbols = posArray.map((p: TradierPosition) => p.symbol);
      let liveQuotes: Record<string, { last: number; bid: number; ask: number }> = {};
      
      if (symbols.length > 0) {
        try {
          const { data: quoteData } = await supabase.functions.invoke('tradier-api', {
            body: { action: 'quote', symbols },
          });
          
          const quotesArray = quoteData?.quotes?.quote;
          if (quotesArray) {
            const quotes = Array.isArray(quotesArray) ? quotesArray : [quotesArray];
            quotes.forEach((q: any) => {
              liveQuotes[q.symbol] = {
                last: q.last || 0,
                bid: q.bid || 0,
                ask: q.ask || 0,
              };
            });
          }
        } catch (quoteError) {
          console.error('Failed to fetch live quotes for positions:', quoteError);
        }
      }
      
      return posArray.map((p: TradierPosition) => {
        const quote = liveQuotes[p.symbol];
        // markPrice is PER-CONTRACT (mid of bid/ask or last) - never multiplied
        const markPrice = quote ? (quote.bid + quote.ask) / 2 || quote.last : 0;
        
        // currentValue is TOTAL DOLLARS: markPrice × |qty| × 100, with sign matching position
        // Tradier cost_basis is already TOTAL DOLLARS (includes qty × 100 multiplier)
        const marketValueAbs = markPrice * Math.abs(p.quantity) * 100;
        const signedMarketValue = p.quantity < 0 ? -marketValueAbs : marketValueAbs;
        
        // Parse option symbol to extract expiration date
        const parsed = parseOptionSymbol(p.symbol);
        
        return {
          id: String(p.id),
          symbol: p.symbol,
          quantity: p.quantity,
          // costBasis from Tradier is already total dollars (e.g., -38 for short position)
          costBasis: p.cost_basis,
          // currentValue is total dollars (sign matches position direction)
          currentValue: markPrice > 0 ? signedMarketValue : p.cost_basis,
          // markPrice is per-contract price for display (e.g., $0.38)
          markPrice: markPrice > 0 ? markPrice : undefined,
          status: 'open' as const,
          entryTime: new Date(p.date_acquired),
          expirationDate: parsed?.expiration,
          underlying: parsed?.underlying,
          // Include raw Tradier values for debugging
          _rawTradier: {
            cost_basis: p.cost_basis,
            market_value: markPrice > 0 ? signedMarketValue : undefined,
            quantity: p.quantity,
          },
        };
      });
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

  async closePosition(
    symbol: string,
    quantity: number,
    opts?: {
      dryRun?: boolean;
      debug?: boolean;
      clientRequestId?: string;
      trade_group_id?: string;
      source?: 'manual_ui' | 'bot_engine' | string;
      forceClose?: boolean; // Bypass spread safety check (for emergency)
    }
  ): Promise<{
    success: boolean;
    dryRun?: boolean;
    skipped?: boolean;
    notFound?: boolean; // Position doesn't exist at broker - not an error, just stale data
    orderId?: string;
    error?: string;
    debug?: any;
    clientRequestId?: string;
    // Additional details for trade journaling
    closeSide?: string;
    closeQty?: number;
    positionDetails?: {
      symbol: string;
      quantity: number;
      costBasis: number;
      side?: string;
    };
    // Spread blocked (safety gate)
    blocked?: boolean;
    blockReason?: string;
    spreadIssues?: Array<{ symbol: string; bid: number; ask: number; spreadPercent: number }>;
  }> {
    const clientRequestId = opts?.clientRequestId || crypto.randomUUID();
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/tradier-api`;

    // DEV-ONLY ASSERTION GUARD:
    // All broker closes MUST go through requestClose() in useTradingData.
    // requestClose temporarily sets a global allow-flag around broker calls.
    if (import.meta.env.DEV) {
      const allow = (globalThis as any).__ALLOW_BROKER_CLOSE__ === true;
      if (!allow) {
        console.error('[tradierApi.closePosition] FORBIDDEN direct call (must use requestClose)', {
          symbol,
          quantity,
          source: opts?.source,
          clientRequestId,
        });
        throw new Error('Direct broker closePosition call forbidden. Use requestClose().');
      }
    }

    console.log('[tradierApi.closePosition] Request', {
      url,
      symbol,
      quantity,
      source: opts?.source,
      clientRequestId,
      dryRun: opts?.dryRun,
      debug: opts?.debug,
    });

    try {
      const { data, error } = await supabase.functions.invoke('tradier-api', {
        body: {
          action: 'close_position',
          positionSymbol: symbol,
          positionQuantity: quantity,
          dryRun: opts?.dryRun,
          debug: opts?.debug,
          clientRequestId,
          trade_group_id: opts?.trade_group_id,
          source: opts?.source,
          forceClose: opts?.forceClose, // Bypass spread safety check
        },
        headers: { 'x-client-request-id': clientRequestId },
      });

      console.log('[tradierApi.closePosition] Response', { data, error, clientRequestId });

      if (error) {
        // Check if this is a "Position not found" 404 - this is expected when position was already closed
        // The Supabase client wraps edge function errors in FunctionsHttpError
        // The error.context is a Response object, need to call .json() on it
        let parsedBody: any = null;
        try {
          // error.context is the Response object for FunctionsHttpError
          if (error.context && typeof error.context.json === 'function') {
            parsedBody = await error.context.json();
          }
        } catch {
          // Ignore parse errors - context might already be consumed or not JSON
        }
        
        console.log('[tradierApi.closePosition] Error context parsed:', { parsedBody, errorMessage: error.message, clientRequestId });

        if (parsedBody?.error === 'Position not found') {
          console.log('[tradierApi.closePosition] Position not found (already closed or never existed):', { symbol, clientRequestId });
          return {
            success: false,
            notFound: true,
            error: 'Position not found at broker',
            debug: { parsedBody },
            clientRequestId,
          };
        }

        // Handle spread safety gate block
        if (parsedBody?.blocked && parsedBody?.reason === 'wide_spread') {
          console.warn('[tradierApi.closePosition] Blocked by spread safety gate:', {
            symbol,
            spreadPercent: parsedBody.spreadPercent,
            maxAllowed: parsedBody.maxAllowedSpreadPercent,
            clientRequestId,
          });
          return {
            success: false,
            blocked: true,
            blockReason: 'wide_spread',
            spreadIssues: [{ symbol, bid: parsedBody.bid, ask: parsedBody.ask, spreadPercent: parsedBody.spreadPercent }],
            error: `Exit blocked: bid/ask spread ${parsedBody.spreadPercent}% exceeds ${parsedBody.maxAllowedSpreadPercent}% limit`,
            debug: { parsedBody },
            clientRequestId,
          };
        }

        const isCors = error.message?.includes('Failed to fetch') || error.message?.includes('NetworkError');
        console.error('[tradierApi.closePosition] Invoke error:', { error, isCors, clientRequestId });
        return {
          success: false,
          error: isCors ? 'CORS/network error - edge function unreachable' : error.message,
          debug: { isCors, raw: error },
          clientRequestId,
        };
      }

      if (data?.skipped) {
        return {
          success: false,
          skipped: true,
          error: `SKIP: ${data?.reason || 'cooldown/lock'}`,
          debug: data?.debug,
          clientRequestId: data?.clientRequestId || clientRequestId,
        };
      }

      if (data?.dry_run) {
        return {
          success: true,
          dryRun: true,
          orderId: undefined,
          debug: data?.debug || { planned_order: data?.planned_order },
          clientRequestId: data?.clientRequestId || clientRequestId,
        };
      }

      if (data?.order?.id) {
        return {
          success: true,
          orderId: data.order.id,
          debug: data?.debug,
          clientRequestId: data?.clientRequestId || clientRequestId,
          closeSide: data?.debug?.instruction?.closeSide,
          closeQty: data?.debug?.instruction?.closeQty,
          positionDetails: data?.debug?.raw_position ? {
            symbol: data.debug.raw_position.symbol,
            quantity: data.debug.raw_position.quantity,
            costBasis: data.debug.raw_position.cost_basis,
            side: data.debug.raw_position.side,
          } : undefined,
        };
      }

      return {
        success: false,
        error: data?.errors?.error || data?.error || 'Order failed',
        debug: data?.debug,
        clientRequestId: data?.clientRequestId || clientRequestId,
      };
    } catch (err) {
      const isCors = err instanceof TypeError && String(err).includes('Failed to fetch');
      console.error('[tradierApi.closePosition] Network/CORS error:', { error: err, isCors, clientRequestId });
      return {
        success: false,
        error: isCors ? 'CORS/network error - edge function unreachable' : String(err),
        debug: { isCors, raw: String(err) },
        clientRequestId,
      };
    }
  },

  async closeGroup(
    symbols: string[],
    opts?: {
      dryRun?: boolean;
      debug?: boolean;
      clientRequestId?: string;
      trade_group_id?: string;
      source?: 'manual_ui_group' | 'bot_engine_group' | 'emergency_close' | string;
      forceClose?: boolean; // Bypass spread safety check (for emergency)
    }
  ): Promise<{
    success: boolean;
    dryRun?: boolean;
    skipped?: boolean;
    notFound?: boolean;
    orderId?: string;
    error?: string;
    debug?: any;
    clientRequestId?: string;
    legs?: Array<{ symbol: string; closeSide: string; closeQty: number; positionSide?: string }>;
    // Spread blocked (safety gate)
    blocked?: boolean;
    blockReason?: string;
    spreadIssues?: Array<{ symbol: string; bid: number; ask: number; spreadPercent: number }>;
  }> {
    const clientRequestId = opts?.clientRequestId || crypto.randomUUID();

    // Same dev-only guard as closePosition
    if (import.meta.env.DEV) {
      const allow = (globalThis as any).__ALLOW_BROKER_CLOSE__ === true;
      if (!allow) {
        console.error('[tradierApi.closeGroup] FORBIDDEN direct call (must use requestClose)', {
          symbols,
          source: opts?.source,
          clientRequestId,
        });
        throw new Error('Direct broker closeGroup call forbidden. Use requestClose().');
      }
    }

    try {
      const { data, error } = await supabase.functions.invoke('tradier-api', {
        body: {
          action: 'close_group',
          positionSymbols: symbols,
          dryRun: opts?.dryRun,
          debug: opts?.debug,
          clientRequestId,
          trade_group_id: opts?.trade_group_id,
          source: opts?.source,
          forceClose: opts?.forceClose, // Bypass spread safety check
        },
        headers: { 'x-client-request-id': clientRequestId },
      });

      if (error) {
        let parsedBody: any = null;
        try {
          if (error.context && typeof error.context.json === 'function') {
            parsedBody = await error.context.json();
          }
        } catch {
          // ignore
        }

        if (parsedBody?.error === 'Position not found') {
          return { success: false, notFound: true, error: 'Position not found at broker', debug: { parsedBody }, clientRequestId };
        }

        // Handle spread safety gate block
        if (parsedBody?.blocked && parsedBody?.reason === 'wide_spread') {
          console.warn('[tradierApi.closeGroup] Blocked by spread safety gate:', {
            spreadIssues: parsedBody.spreadIssues,
            maxAllowed: parsedBody.maxAllowedSpreadPercent,
            clientRequestId,
          });
          return {
            success: false,
            blocked: true,
            blockReason: 'wide_spread',
            spreadIssues: parsedBody.spreadIssues,
            error: `Exit blocked: bid/ask spreads exceed ${parsedBody.maxAllowedSpreadPercent}% limit`,
            debug: { parsedBody },
            clientRequestId,
          };
        }

        const isCors = error.message?.includes('Failed to fetch') || error.message?.includes('NetworkError');
        return {
          success: false,
          error: isCors ? 'CORS/network error - edge function unreachable' : error.message,
          debug: { isCors, raw: error },
          clientRequestId,
        };
      }

      if (data?.skipped) {
        return {
          success: false,
          skipped: true,
          error: `SKIP: ${data?.reason || 'cooldown/lock'}`,
          debug: data?.debug,
          clientRequestId: data?.clientRequestId || clientRequestId,
        };
      }

      if (data?.dry_run) {
        return {
          success: true,
          dryRun: true,
          orderId: undefined,
          legs: data?.legs,
          debug: data?.debug || { planned_order: data?.planned_order },
          clientRequestId: data?.clientRequestId || clientRequestId,
        };
      }

      if (data?.order?.id) {
        return {
          success: true,
          orderId: data.order.id,
          legs: data?.legs,
          debug: data?.debug,
          clientRequestId: data?.clientRequestId || clientRequestId,
        };
      }

      return {
        success: false,
        error: data?.errors?.error || data?.error || 'Order failed',
        debug: data?.debug,
        clientRequestId: data?.clientRequestId || clientRequestId,
      };
    } catch (err) {
      const isCors = err instanceof TypeError && String(err).includes('Failed to fetch');
      return {
        success: false,
        error: isCors ? 'CORS/network error - edge function unreachable' : String(err),
        debug: { isCors, raw: String(err) },
        clientRequestId,
      };
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

  /**
   * Get order status from Tradier - used for close lifecycle tracking
   */
  async getOrderStatus(orderId: string): Promise<{
    success: boolean;
    orderId: string;
    closeStatus: 'submitted' | 'filled' | 'rejected' | 'canceled' | 'expired';
    rejectReason?: string;
    avgFillPrice?: number;
    filledQty?: number;
    closeSide?: string;
    tradierStatus?: string;
    /** Per-leg fill prices for multi-leg orders (keyed by OCC symbol) */
    legFills?: Record<string, { avgFillPrice: number; filledQty: number; side: string }>;
    error?: string;
  }> {
    try {
      const { data, error } = await supabase.functions.invoke('tradier-api', {
        body: { action: 'order_status', orderId },
      });

      if (error) {
        console.error('Order status fetch error:', error);
        return { success: false, orderId, closeStatus: 'submitted', error: error.message };
      }

      if (data?.error) {
        return { success: false, orderId, closeStatus: 'submitted', error: data.error };
      }

      return {
        success: true,
        orderId,
        closeStatus: data.closeStatus || 'submitted',
        rejectReason: data.rejectReason,
        avgFillPrice: data.avgFillPrice,
        filledQty: data.filledQty,
        closeSide: data.closeSide,
        tradierStatus: data.tradierStatus,
        legFills: data.legFills,
      };
    } catch (error) {
      console.error('Failed to fetch order status:', error);
      return { 
        success: false, 
        orderId, 
        closeStatus: 'submitted', 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
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
