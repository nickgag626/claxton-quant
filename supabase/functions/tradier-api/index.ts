import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface TradierRequest {
  action: 'quote' | 'positions' | 'balances' | 'expirations' | 'chain' | 'clock' | 'close_position';
  symbols?: string[];
  symbol?: string;
  expiration?: string;
  positionSymbol?: string;
  positionQuantity?: number;
}

serve(async (req) => {
  // Handle CORS preflight
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

    const { action, symbols, symbol, expiration, positionSymbol, positionQuantity }: TradierRequest = await req.json();
    
    // Use sandbox for paper trading - change to api.tradier.com for live
    const baseUrl = 'https://sandbox.tradier.com/v1';
    
    const headers = {
      'Authorization': `Bearer ${apiToken}`,
      'Accept': 'application/json',
    };

    let response;
    let data;

    switch (action) {
      case 'quote': {
        if (!symbols || symbols.length === 0) {
          return new Response(
            JSON.stringify({ error: 'Symbols required for quote' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        const url = `${baseUrl}/markets/quotes?symbols=${symbols.join(',')}`;
        console.log('Fetching quotes:', url);
        response = await fetch(url, { headers });
        data = await response.json();
        console.log('Quote response:', JSON.stringify(data));
        break;
      }

      case 'positions': {
        const url = `${baseUrl}/accounts/${accountId}/positions`;
        console.log('Fetching positions:', url);
        response = await fetch(url, { headers });
        data = await response.json();
        console.log('Positions response:', JSON.stringify(data));
        break;
      }

      case 'balances': {
        const url = `${baseUrl}/accounts/${accountId}/balances`;
        console.log('Fetching balances:', url);
        response = await fetch(url, { headers });
        data = await response.json();
        console.log('Balances response:', JSON.stringify(data));
        break;
      }

      case 'expirations': {
        if (!symbol) {
          return new Response(
            JSON.stringify({ error: 'Symbol required for expirations' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        const url = `${baseUrl}/markets/options/expirations?symbol=${symbol}`;
        console.log('Fetching expirations:', url);
        response = await fetch(url, { headers });
        data = await response.json();
        console.log('Expirations response:', JSON.stringify(data));
        break;
      }

      case 'chain': {
        if (!symbol || !expiration) {
          return new Response(
            JSON.stringify({ error: 'Symbol and expiration required for chain' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        const url = `${baseUrl}/markets/options/chains?symbol=${symbol}&expiration=${expiration}&greeks=true`;
        console.log('Fetching chain:', url);
        response = await fetch(url, { headers });
        data = await response.json();
        console.log('Chain response received');
        break;
      }

      case 'clock': {
        const url = `${baseUrl}/markets/clock`;
        console.log('Fetching market clock:', url);
        response = await fetch(url, { headers });
        data = await response.json();
        console.log('Clock response:', JSON.stringify(data));
        break;
      }

      case 'close_position': {
        if (!positionSymbol || positionQuantity === undefined) {
          return new Response(
            JSON.stringify({ error: 'Symbol and quantity required for close_position' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        
        // Determine order side (buy to close short, sell to close long)
        const side = positionQuantity < 0 ? 'buy_to_close' : 'sell_to_close';
        const orderUrl = `${baseUrl}/accounts/${accountId}/orders`;
        
        console.log('Closing position:', positionSymbol, 'qty:', positionQuantity, 'side:', side);
        
        response = await fetch(orderUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            class: positionSymbol.includes(' ') ? 'option' : 'equity',
            symbol: positionSymbol.split(' ')[0],
            option_symbol: positionSymbol.includes(' ') ? positionSymbol : '',
            side: side,
            quantity: Math.abs(positionQuantity).toString(),
            type: 'market',
            duration: 'day',
          }).toString(),
        });
        
        data = await response.json();
        console.log('Close order response:', JSON.stringify(data));
        break;
      }

      default:
        return new Response(
          JSON.stringify({ error: 'Invalid action' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }

    if (!response.ok) {
      console.error('Tradier API error:', response.status, data);
      return new Response(
        JSON.stringify({ error: 'Tradier API error', details: data }),
        { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify(data),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in tradier-api function:', error);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
