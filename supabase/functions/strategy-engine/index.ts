import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Strategy {
  id: string;
  name: string;
  type: string;
  underlying: string;
  enabled: boolean;
  maxPositions: number;
  positionSize: number;
  entryConditions: {
    minDte: number;
    maxDte: number;
    maxDelta: number;
    minPremium?: number;
    minIvRank?: number;
    maxIvRank?: number;
    marketHoursOnly: boolean;
    startTime?: string;
    endTime?: string;
  };
  exitConditions: {
    profitTargetPercent: number;
    stopLossPercent: number;
    timeStopDte?: number;
    timeStopTime?: string;
  };
}

interface OptionContract {
  symbol: string;
  strike: number;
  option_type: string;
  expiration_date: string;
  bid: number;
  ask: number;
  greeks?: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const apiToken = Deno.env.get('TRADIER_API_TOKEN');
    const accountId = Deno.env.get('TRADIER_ACCOUNT_ID');

    if (!apiToken || !accountId) {
      console.error('Missing Tradier credentials');
      return new Response(
        JSON.stringify({ error: 'Tradier API not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body = await req.json();
    const { action, strategies, positions } = body;

    const baseUrl = 'https://sandbox.tradier.com/v1';
    const headers = {
      'Authorization': `Bearer ${apiToken}`,
      'Accept': 'application/json',
    };

    // Check if market is open
    const clockResponse = await fetch(`${baseUrl}/markets/clock`, { headers });
    const clockData = await clockResponse.json();
    const marketState = clockData?.clock?.state || 'closed';
    
    console.log('Market state:', marketState);

    if (action === 'evaluate') {
      // Evaluate strategies and return signals
      const signals: any[] = [];
      
      for (const strategy of strategies as Strategy[]) {
        if (!strategy.enabled) continue;
        
        // Check market hours condition
        if (strategy.entryConditions.marketHoursOnly && marketState !== 'open') {
          console.log(`Skipping ${strategy.name}: market not open`);
          continue;
        }

        // Check time window
        const now = new Date();
        const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        
        if (strategy.entryConditions.startTime && currentTime < strategy.entryConditions.startTime) {
          console.log(`Skipping ${strategy.name}: before start time`);
          continue;
        }
        if (strategy.entryConditions.endTime && currentTime > strategy.entryConditions.endTime) {
          console.log(`Skipping ${strategy.name}: after end time`);
          continue;
        }

        // Check position limits
        const strategyPositions = (positions || []).filter(
          (p: any) => p.strategyName === strategy.name && p.status === 'open'
        );
        if (strategyPositions.length >= strategy.maxPositions) {
          console.log(`Skipping ${strategy.name}: max positions reached`);
          continue;
        }

        // Get option expirations for the underlying
        const expResponse = await fetch(
          `${baseUrl}/markets/options/expirations?symbol=${strategy.underlying}`,
          { headers }
        );
        const expData = await expResponse.json();
        const expirations = expData?.expirations?.date || [];

        // Find expiration within DTE range
        const today = new Date();
        const targetExpiration = expirations.find((exp: string) => {
          const expDate = new Date(exp);
          const dte = Math.ceil((expDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
          return dte >= strategy.entryConditions.minDte && dte <= strategy.entryConditions.maxDte;
        });

        if (!targetExpiration) {
          console.log(`Skipping ${strategy.name}: no suitable expiration found`);
          continue;
        }

        console.log(`Found expiration for ${strategy.name}: ${targetExpiration}`);

        // Get option chain with greeks
        const chainResponse = await fetch(
          `${baseUrl}/markets/options/chains?symbol=${strategy.underlying}&expiration=${targetExpiration}&greeks=true`,
          { headers }
        );
        const chainData = await chainResponse.json();
        const options: OptionContract[] = chainData?.options?.option || [];

        if (options.length === 0) {
          console.log(`Skipping ${strategy.name}: no options in chain`);
          continue;
        }

        // Find contracts matching delta criteria
        const signal = evaluateStrategy(strategy, options, targetExpiration);
        if (signal) {
          signals.push(signal);
        }
      }

      return new Response(
        JSON.stringify({ signals, marketState }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'execute') {
      // Execute a trade signal
      const { signal } = body;
      
      if (!signal || !signal.legs) {
        return new Response(
          JSON.stringify({ error: 'Invalid signal' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const orderResponse = await placeOrder(baseUrl, accountId, apiToken, signal);
      
      return new Response(
        JSON.stringify(orderResponse),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'check_exits') {
      // Check if any positions should be closed
      const exitSignals: any[] = [];
      
      for (const position of positions || []) {
        if (position.status !== 'open' || !position.strategyName) continue;
        
        const strategy = (strategies as Strategy[]).find(s => s.name === position.strategyName);
        if (!strategy) continue;

        const pnlPercent = ((position.currentValue - position.entryCredit) / position.entryCredit) * 100;
        
        // Check profit target
        if (pnlPercent >= strategy.exitConditions.profitTargetPercent) {
          exitSignals.push({
            positionId: position.id,
            symbol: position.symbol,
            quantity: position.quantity,
            reason: 'profit_target',
            pnlPercent,
          });
          continue;
        }

        // Check stop loss
        if (pnlPercent <= -strategy.exitConditions.stopLossPercent) {
          exitSignals.push({
            positionId: position.id,
            symbol: position.symbol,
            quantity: position.quantity,
            reason: 'stop_loss',
            pnlPercent,
          });
          continue;
        }

        // Check time stop
        if (strategy.exitConditions.timeStopDte && position.expirationDate) {
          const expDate = new Date(position.expirationDate);
          const dte = Math.ceil((expDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
          if (dte <= strategy.exitConditions.timeStopDte) {
            exitSignals.push({
              positionId: position.id,
              symbol: position.symbol,
              quantity: position.quantity,
              reason: 'time_stop',
              dte,
            });
          }
        }
      }

      return new Response(
        JSON.stringify({ exitSignals, marketState }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Invalid action' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in strategy-engine:', error);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function evaluateStrategy(strategy: Strategy, options: OptionContract[], expiration: string): any | null {
  const maxDelta = strategy.entryConditions.maxDelta;
  const minPremium = strategy.entryConditions.minPremium || 0;

  // Find puts and calls within delta range
  const puts = options.filter(o => 
    o.option_type === 'put' && 
    o.greeks && 
    Math.abs(o.greeks.delta) <= maxDelta &&
    o.bid > 0
  ).sort((a, b) => Math.abs(b.greeks!.delta) - Math.abs(a.greeks!.delta));

  const calls = options.filter(o => 
    o.option_type === 'call' && 
    o.greeks && 
    Math.abs(o.greeks.delta) <= maxDelta &&
    o.bid > 0
  ).sort((a, b) => Math.abs(b.greeks!.delta) - Math.abs(a.greeks!.delta));

  switch (strategy.type) {
    case 'iron_condor': {
      if (puts.length < 2 || calls.length < 2) return null;
      
      const shortPut = puts[0];
      const longPut = puts.find(p => p.strike < shortPut.strike);
      const shortCall = calls[0];
      const longCall = calls.find(c => c.strike > shortCall.strike);
      
      if (!longPut || !longCall) return null;
      
      const credit = (shortPut.bid + shortCall.bid) - (longPut.ask + longCall.ask);
      if (credit < minPremium) return null;
      
      return {
        strategyName: strategy.name,
        type: 'iron_condor',
        underlying: strategy.underlying,
        expiration,
        credit,
        legs: [
          { symbol: longPut.symbol, side: 'buy_to_open', quantity: strategy.positionSize },
          { symbol: shortPut.symbol, side: 'sell_to_open', quantity: strategy.positionSize },
          { symbol: shortCall.symbol, side: 'sell_to_open', quantity: strategy.positionSize },
          { symbol: longCall.symbol, side: 'buy_to_open', quantity: strategy.positionSize },
        ],
      };
    }

    case 'credit_put_spread': {
      if (puts.length < 2) return null;
      
      const shortPut = puts[0];
      const longPut = puts.find(p => p.strike < shortPut.strike);
      
      if (!longPut) return null;
      
      const credit = shortPut.bid - longPut.ask;
      if (credit < minPremium) return null;
      
      return {
        strategyName: strategy.name,
        type: 'credit_put_spread',
        underlying: strategy.underlying,
        expiration,
        credit,
        legs: [
          { symbol: longPut.symbol, side: 'buy_to_open', quantity: strategy.positionSize },
          { symbol: shortPut.symbol, side: 'sell_to_open', quantity: strategy.positionSize },
        ],
      };
    }

    case 'credit_call_spread': {
      if (calls.length < 2) return null;
      
      const shortCall = calls[0];
      const longCall = calls.find(c => c.strike > shortCall.strike);
      
      if (!longCall) return null;
      
      const credit = shortCall.bid - longCall.ask;
      if (credit < minPremium) return null;
      
      return {
        strategyName: strategy.name,
        type: 'credit_call_spread',
        underlying: strategy.underlying,
        expiration,
        credit,
        legs: [
          { symbol: shortCall.symbol, side: 'sell_to_open', quantity: strategy.positionSize },
          { symbol: longCall.symbol, side: 'buy_to_open', quantity: strategy.positionSize },
        ],
      };
    }

    default:
      console.log(`Strategy type ${strategy.type} not implemented`);
      return null;
  }
}

async function placeOrder(baseUrl: string, accountId: string, apiToken: string, signal: any) {
  const orderUrl = `${baseUrl}/accounts/${accountId}/orders`;
  
  // For multi-leg orders, use combo order
  if (signal.legs.length > 1) {
    const legParams = signal.legs.map((leg: any, i: number) => ({
      [`option_symbol[${i}]`]: leg.symbol,
      [`side[${i}]`]: leg.side,
      [`quantity[${i}]`]: leg.quantity.toString(),
    })).reduce((acc: any, curr: any) => ({ ...acc, ...curr }), {});

    const body = new URLSearchParams({
      class: 'multileg',
      symbol: signal.underlying,
      type: 'market',
      duration: 'day',
      ...legParams,
    }).toString();

    console.log('Placing multi-leg order:', body);

    const response = await fetch(orderUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const data = await response.json();
    console.log('Order response:', JSON.stringify(data));
    
    return {
      success: !!data?.order?.id,
      orderId: data?.order?.id,
      error: data?.errors?.error,
      signal,
    };
  }

  // Single leg order
  const leg = signal.legs[0];
  const response = await fetch(orderUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      class: 'option',
      symbol: signal.underlying,
      option_symbol: leg.symbol,
      side: leg.side,
      quantity: leg.quantity.toString(),
      type: 'market',
      duration: 'day',
    }).toString(),
  });

  const data = await response.json();
  return {
    success: !!data?.order?.id,
    orderId: data?.order?.id,
    error: data?.errors?.error,
    signal,
  };
}
