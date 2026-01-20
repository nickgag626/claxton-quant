import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// ============================================================================
// CORS Configuration
// - Set ALLOWED_ORIGINS env var to comma-separated list for production
// - Set DEV_ALLOW_ALL_ORIGINS=true for local development with wildcard CORS
// ============================================================================
function getCorsHeaders(requestOrigin?: string | null): Record<string, string> {
  const allowedOriginsEnv = Deno.env.get("ALLOWED_ORIGINS");
  const devAllowAll = Deno.env.get("DEV_ALLOW_ALL_ORIGINS") === "true";

  let allowOrigin = "";

  if (devAllowAll) {
    // Local dev: allow all
    allowOrigin = "*";
  } else if (allowedOriginsEnv) {
    // Production: check against allowlist
    const allowedOrigins = allowedOriginsEnv.split(",").map(o => o.trim());
    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
      allowOrigin = requestOrigin;
    } else if (allowedOrigins.length > 0) {
      // Default to first allowed origin if no match
      allowOrigin = allowedOrigins[0];
    }
  } else {
    // Fallback: allow all (for backwards compatibility during migration)
    allowOrigin = "*";
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-client-request-id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

interface TradierRequest {
  action:
    | "ping"
    | "quote"
    | "positions"
    | "balances"
    | "expirations"
    | "chain"
    | "clock"
    | "orders"
    | "order_detail"
    | "order_status"
    | "close_position"
    | "close_group";
  symbols?: string[];
  symbol?: string;
  expiration?: string;

  // close_position
  positionSymbol?: string;
  // close_group
  positionSymbols?: string[];

  // kept for backwards compatibility; close logic derives from live Tradier position
  positionQuantity?: number;

  // orders / order_detail (for reconciliation)
  startDate?: string;
  endDate?: string;
  orderId?: string; // For fetching specific order details

  // debug / idempotency
  dryRun?: boolean;
  debug?: boolean;
  clientRequestId?: string;
  trade_group_id?: string;
  source?: "manual_ui" | "bot_engine" | string;

  // SAFETY: Force close even if spread is wide (for emergency situations)
  forceClose?: boolean;
}

type TradierPosition = Record<string, unknown> & {
  symbol?: string;
  quantity?: number | string;
  cost_basis?: number | string;
  side?: string;
  instrument_type?: string;
};

type InstrumentType = "option" | "equity";

type CloseInstruction = {
  ok: true;
  instrument_type: InstrumentType;
  side: "long" | "short";
  closeSide: "buy_to_close" | "sell_to_close" | "buy_to_cover" | "sell";
  closeQty: number;
};

type CloseInstructionError = {
  ok: false;
  instrument_type: InstrumentType;
  side: "long" | "short" | "unknown";
  quantity: number;
  cost_basis: number;
  error: string;
};

const closeLocks = new Map<string, { inFlight: boolean; lastAcceptedAt: number }>();
const CLOSE_COOLDOWN_MS = 120_000;

// SAFETY: Maximum bid/ask spread percentage allowed for exit orders
// Wider spreads during fast markets can significantly impact fill quality
const MAX_EXIT_SPREAD_PERCENT = 15;

const isOccOptionSymbol = (s: string) => /^[A-Z]+\d{6}[CP]\d{8}$/.test(s);

// Calculate bid/ask spread as a percentage of the midpoint
function calculateSpreadPercent(bid: number, ask: number): number {
  if (bid <= 0 || ask <= 0) return Infinity; // Invalid quote
  const mid = (bid + ask) / 2;
  if (mid <= 0) return Infinity;
  return ((ask - bid) / mid) * 100;
}

function normalizeNumber(n: unknown): number {
  if (typeof n === "number") return n;
  if (typeof n === "string" && n.trim() !== "") {
    const parsed = Number(n);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function extractUnderlyingFromOcc(positionSymbol: string): string {
  const match = positionSymbol.match(/^([A-Z]+)\d{6}[CP]\d{8}$/);
  return match ? match[1] : positionSymbol;
}

function inferSide(pos: TradierPosition, qty: number): "long" | "short" | "unknown" {
  const side = String(pos.side || "").toLowerCase();
  if (side === "long" || side === "short") return side as "long" | "short";
  if (qty < 0) return "short";
  if (qty > 0) return "long";
  return "unknown";
}

function inferSideFromCostBasis(costBasis: number): "long" | "short" | "unknown" {
  if (costBasis < 0) return "short";
  if (costBasis > 0) return "long";
  return "unknown";
}

function detectInstrumentType(
  pos: TradierPosition,
  positionSymbol: string,
  quoteType?: string,
): InstrumentType {
  const fromPos = String(pos.instrument_type || "").toLowerCase();
  if (fromPos.includes("option")) return "option";
  if (fromPos.includes("equity") || fromPos.includes("stock")) return "equity";

  const fromQuote = String(quoteType || "").toLowerCase();
  if (fromQuote === "option") return "option";

  // fallback
  return isOccOptionSymbol(positionSymbol) ? "option" : "equity";
}

// Truth table: SINGLE deterministic mapping used everywhere.
function getCloseInstruction(
  pos: TradierPosition,
  positionSymbol: string,
  quoteType?: string,
): CloseInstruction | CloseInstructionError {
  const qty = normalizeNumber(pos.quantity);
  const costBasis = normalizeNumber(pos.cost_basis);
  const instrument_type = detectInstrumentType(pos, positionSymbol, quoteType);

  let side = inferSide(pos, qty);
  if (side === "unknown") {
    const cbSide = inferSideFromCostBasis(costBasis);
    if (cbSide !== "unknown") {
      side = cbSide;
      console.warn("INFER_SIDE_FROM_COST_BASIS", { positionSymbol, cost_basis: costBasis });
    }
  }

  if (side === "unknown" || qty === 0) {
    return {
      ok: false,
      instrument_type,
      side,
      quantity: qty,
      cost_basis: costBasis,
      error: `Unable to determine reliable side/size for ${positionSymbol}`,
    };
  }

  if (instrument_type === "option") {
    return {
      ok: true,
      instrument_type,
      side,
      closeSide: side === "short" ? "buy_to_close" : "sell_to_close",
      closeQty: Math.abs(qty),
    };
  }

  return {
    ok: true,
    instrument_type,
    side,
    closeSide: side === "short" ? "buy_to_cover" : "sell",
    closeQty: Math.abs(qty),
  };
}

// Helper to safely parse Tradier responses (handles HTML error pages)
async function safeParseTradierResponse(resp: Response): Promise<any> {
  const text = await resp.text();
  if (text.trim().startsWith("<")) {
    console.error("TRADIER_HTML_ERROR", { status: resp.status });
    return { error: "Tradier API returned HTML error page", status: resp.status };
  }
  try {
    return JSON.parse(text);
  } catch {
    console.error("TRADIER_JSON_PARSE_ERROR", { status: resp.status });
    return { error: "Invalid JSON from Tradier" };
  }
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req.headers.get("origin"));

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Safely parse request body
    let body: TradierRequest;
    try {
      const rawText = await req.text();
      // SECURITY: Only log action and metadata, not full body
      body = JSON.parse(rawText) as TradierRequest;
      console.log("REQUEST", {
        action: body.action,
        symbol: body.symbol || body.positionSymbol,
        symbols_count: body.symbols?.length,
        clientRequestId: body.clientRequestId,
      });
    } catch (parseError) {
      console.error("PARSE_ERROR", { error: "Invalid JSON" });
      return new Response(
        JSON.stringify({ error: "Invalid JSON in request body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const action = body.action;

    // Handle ping immediately (no Tradier credentials needed)
    if (action === "ping") {
      console.log("PING");
      return new Response(
        JSON.stringify({ ok: true, timestamp: new Date().toISOString(), action: "ping" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const apiToken = Deno.env.get("TRADIER_API_TOKEN");
    const accountId = Deno.env.get("TRADIER_ACCOUNT_ID");

    if (!apiToken || !accountId) {
      console.error("MISSING_CREDENTIALS");
      return new Response(JSON.stringify({ error: "Tradier API not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const symbols = body.symbols;
    const symbol = body.symbol;
    const expiration = body.expiration;
    const positionSymbol = body.positionSymbol;

    // debug fields
    const dryRun = !!body.dryRun;
    const debug = !!body.debug;
    const clientRequestId =
      body.clientRequestId || req.headers.get("x-client-request-id") || crypto.randomUUID();
    const trade_group_id = body.trade_group_id;
    const source = body.source || "unknown";

    // Use sandbox for paper trading - change to api.tradier.com for live
    const baseUrl = "https://sandbox.tradier.com/v1";

    const headers = {
      Authorization: `Bearer ${apiToken}`,
      Accept: "application/json",
    };

    let response: Response | undefined;
    let data: any;

    switch (action) {
      case "quote": {
        if (!symbols || symbols.length === 0) {
          return new Response(JSON.stringify({ error: "Symbols required for quote" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const url = `${baseUrl}/markets/quotes?symbols=${symbols.join(",")}`;
        console.log("QUOTE_REQUEST", { symbols_count: symbols.length });
        response = await fetch(url, { headers });
        data = await safeParseTradierResponse(response);
        console.log("QUOTE_RESPONSE", { status: response.status });
        break;
      }

      case "positions": {
        const url = `${baseUrl}/accounts/${accountId}/positions`;
        console.log("POSITIONS_REQUEST");
        response = await fetch(url, { headers });
        data = await safeParseTradierResponse(response);
        const posCount = Array.isArray(data?.positions?.position)
          ? data.positions.position.length
          : data?.positions?.position ? 1 : 0;
        console.log("POSITIONS_RESPONSE", { status: response.status, count: posCount });
        break;
      }

      case "balances": {
        const url = `${baseUrl}/accounts/${accountId}/balances`;
        console.log("BALANCES_REQUEST");
        response = await fetch(url, { headers });
        data = await safeParseTradierResponse(response);
        console.log("BALANCES_RESPONSE", { status: response.status });
        break;
      }

      case "expirations": {
        if (!symbol) {
          return new Response(JSON.stringify({ error: "Symbol required for expirations" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const url = `${baseUrl}/markets/options/expirations?symbol=${symbol}`;
        console.log("EXPIRATIONS_REQUEST", { symbol });
        response = await fetch(url, { headers });
        data = await safeParseTradierResponse(response);
        console.log("EXPIRATIONS_RESPONSE", { status: response.status, symbol });
        break;
      }

      case "chain": {
        if (!symbol || !expiration) {
          return new Response(
            JSON.stringify({ error: "Symbol and expiration required for chain" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        const url = `${baseUrl}/markets/options/chains?symbol=${symbol}&expiration=${expiration}&greeks=true`;
        console.log("CHAIN_REQUEST", { symbol, expiration });
        response = await fetch(url, { headers });
        data = await safeParseTradierResponse(response);
        console.log("CHAIN_RESPONSE", { status: response.status, symbol, expiration });
        break;
      }

      case "clock": {
        const url = `${baseUrl}/markets/clock`;
        console.log("CLOCK_REQUEST");
        response = await fetch(url, { headers });
        data = await safeParseTradierResponse(response);
        console.log("CLOCK_RESPONSE", { status: response.status, state: data?.clock?.state });
        break;
      }

      case "orders": {
        // Fetch order history for reconciliation
        const url = `${baseUrl}/accounts/${accountId}/orders?includeTags=true`;
        console.log("ORDERS_REQUEST");
        response = await fetch(url, { headers });
        data = await safeParseTradierResponse(response);
        const orderCount = Array.isArray(data?.orders?.order) ? data.orders.order.length : (data?.orders?.order ? 1 : 0);
        console.log("ORDERS_RESPONSE", { status: response.status, count: orderCount });
        break;
      }

      case "order_detail": {
        const orderId = body.orderId;
        if (!orderId) {
          return new Response(JSON.stringify({ error: "orderId required for order_detail" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const url = `${baseUrl}/accounts/${accountId}/orders/${orderId}`;
        console.log("ORDER_DETAIL_REQUEST", { orderId });
        response = await fetch(url, { headers });
        data = await safeParseTradierResponse(response);
        console.log("ORDER_DETAIL_RESPONSE", { status: response.status, orderId });
        break;
      }

      case "order_status": {
        const orderId = body.orderId;
        if (!orderId) {
          return new Response(JSON.stringify({ error: "orderId required for order_status" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const url = `${baseUrl}/accounts/${accountId}/orders/${orderId}`;
        console.log("ORDER_STATUS_REQUEST", { orderId });
        response = await fetch(url, { headers });
        const orderData = await safeParseTradierResponse(response);
        console.log("ORDER_STATUS_RESPONSE", { status: response.status, orderId });

        const order = orderData?.order;
        if (!order) {
          data = { error: "Order not found", orderId };
          break;
        }

        const tradierStatus = String(order.status || '').toLowerCase();
        let closeStatus: 'submitted' | 'filled' | 'rejected' | 'canceled' | 'expired' = 'submitted';
        let rejectReason: string | undefined;

        if (tradierStatus === 'filled') {
          closeStatus = 'filled';
        } else if (tradierStatus === 'rejected') {
          closeStatus = 'rejected';
          rejectReason = order.reason_description || order.reject_reason || 'Order rejected';
        } else if (tradierStatus === 'canceled' || tradierStatus === 'cancelled') {
          closeStatus = 'canceled';
          rejectReason = 'Order canceled';
        } else if (tradierStatus === 'expired') {
          closeStatus = 'expired';
          rejectReason = 'Order expired';
        } else if (tradierStatus === 'open' || tradierStatus === 'pending' || tradierStatus === 'partially_filled') {
          closeStatus = 'submitted';
        }

        let avgFillPrice: number | undefined;
        let filledQty: number | undefined;
        let closeSide: string | undefined;
        
        // For multi-leg orders, extract per-leg fill prices
        let legFills: Record<string, { avgFillPrice: number; filledQty: number; side: string }> | undefined;

        if (closeStatus === 'filled') {
          avgFillPrice = normalizeNumber(order.avg_fill_price);
          filledQty = normalizeNumber(order.exec_quantity) || normalizeNumber(order.quantity);
          closeSide = order.side;
          
          // Check for multi-leg order structure
          if (order.leg) {
            const legs = Array.isArray(order.leg) ? order.leg : [order.leg];
            legFills = {};
            for (const leg of legs) {
              if (leg.option_symbol) {
                legFills[leg.option_symbol] = {
                  avgFillPrice: normalizeNumber(leg.avg_fill_price) || 0,
                  filledQty: normalizeNumber(leg.exec_quantity) || normalizeNumber(leg.quantity) || 0,
                  side: leg.side || '',
                };
              }
            }
          }
        }

        data = {
          orderId,
          tradierStatus,
          closeStatus,
          rejectReason,
          avgFillPrice,
          filledQty,
          closeSide,
          legFills, // Per-leg fill prices for multi-leg orders
          rawOrder: order,
        };
        break;
      }

      case "close_group": {
        const positionSymbols = body.positionSymbols;
        if (!positionSymbols || positionSymbols.length < 2) {
          return new Response(
            JSON.stringify({ error: "positionSymbols (2+) required for close_group" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        const symbolsSorted = [...positionSymbols].map(String).sort();
        const lockKey = `${accountId}:group:${symbolsSorted.join("|")}`;
        const now = Date.now();
        const lock = closeLocks.get(lockKey);

        console.log("CLOSE_GROUP_REQUEST", {
          source,
          clientRequestId,
          trade_group_id,
          symbols: symbolsSorted,
          dryRun,
        });

        if (lock?.inFlight) {
          console.log("CLOSE_GROUP_SKIP_INFLIGHT", { source, clientRequestId });
          return new Response(
            JSON.stringify({ skipped: true, reason: "lock_in_flight", clientRequestId }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        if (lock?.lastAcceptedAt && now - lock.lastAcceptedAt < CLOSE_COOLDOWN_MS) {
          console.log("CLOSE_GROUP_SKIP_COOLDOWN", { source, clientRequestId });
          return new Response(
            JSON.stringify({ skipped: true, reason: "cooldown", clientRequestId }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        closeLocks.set(lockKey, { inFlight: true, lastAcceptedAt: lock?.lastAcceptedAt || 0 });

        try {
          // Fetch positions once
          const posUrl = `${baseUrl}/accounts/${accountId}/positions`;
          const posResp = await fetch(posUrl, { headers });
          const posData = await safeParseTradierResponse(posResp);
          const positionsRaw = posData?.positions?.position;
          const posArray: TradierPosition[] = Array.isArray(positionsRaw)
            ? positionsRaw
            : positionsRaw
              ? [positionsRaw]
              : [];

          const legs: Array<{ symbol: string; closeSide: string; closeQty: number; positionSide?: string }> = [];

          // All legs must be options with same underlying
          const underlying0 = extractUnderlyingFromOcc(symbolsSorted[0]);
          for (const sym of symbolsSorted) {
            const matched = posArray.find((p) => String(p.symbol) === sym);
            if (!matched) {
              console.log("CLOSE_GROUP_NOT_FOUND", { source, clientRequestId, symbol: sym });
              return new Response(
                JSON.stringify({ error: "Position not found", symbol: sym, clientRequestId }),
                { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }

            if (!isOccOptionSymbol(sym)) {
              return new Response(
                JSON.stringify({ error: "close_group supports OCC option symbols only", symbol: sym, clientRequestId }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }

            const underlying = extractUnderlyingFromOcc(sym);
            if (underlying !== underlying0) {
              return new Response(
                JSON.stringify({ error: "All legs must share the same underlying", clientRequestId, debug: { underlying0, underlying } }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }

            const instruction = getCloseInstruction(matched, sym, "option");
            if (!instruction.ok) {
              return new Response(
                JSON.stringify({ error: instruction.error, clientRequestId, debug: { instruction, sym } }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }

            const qty = normalizeNumber(matched.quantity);
            const closeQty = Math.min(instruction.closeQty, Math.abs(qty));
            if (!Number.isFinite(closeQty) || closeQty <= 0) {
              return new Response(
                JSON.stringify({ error: "Position size is zero", clientRequestId, debug: { sym, qty } }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }

            legs.push({
              symbol: sym,
              closeSide: instruction.closeSide,
              closeQty,
              positionSide: String((matched as any).side || "") || undefined,
            });
          }

          // SAFETY: Check bid/ask spreads before placing close order
          const forceClose = !!body.forceClose;
          if (!forceClose) {
            const quoteUrl = `${baseUrl}/markets/quotes?symbols=${symbolsSorted.join(",")}`;
            const quoteResp = await fetch(quoteUrl, { headers });
            const quoteData = await safeParseTradierResponse(quoteResp);
            const quotesRaw = quoteData?.quotes?.quote;
            const quotesArray = Array.isArray(quotesRaw) ? quotesRaw : quotesRaw ? [quotesRaw] : [];

            const spreadIssues: Array<{ symbol: string; bid: number; ask: number; spreadPercent: number }> = [];

            for (const sym of symbolsSorted) {
              const quote = quotesArray.find((q: any) => q.symbol === sym);
              if (!quote) {
                console.warn("SPREAD_CHECK_NO_QUOTE", { symbol: sym, clientRequestId });
                continue; // Allow if no quote available
              }
              const bid = normalizeNumber(quote.bid);
              const ask = normalizeNumber(quote.ask);
              const spreadPercent = calculateSpreadPercent(bid, ask);

              if (spreadPercent > MAX_EXIT_SPREAD_PERCENT) {
                spreadIssues.push({ symbol: sym, bid, ask, spreadPercent: Math.round(spreadPercent * 10) / 10 });
              }
            }

            if (spreadIssues.length > 0) {
              console.warn("CLOSE_GROUP_BLOCKED_WIDE_SPREAD", {
                source,
                clientRequestId,
                trade_group_id,
                maxAllowed: MAX_EXIT_SPREAD_PERCENT,
                issues: spreadIssues,
              });
              closeLocks.set(lockKey, { inFlight: false, lastAcceptedAt: lock?.lastAcceptedAt || 0 });
              return new Response(
                JSON.stringify({
                  blocked: true,
                  reason: "wide_spread",
                  maxAllowedSpreadPercent: MAX_EXIT_SPREAD_PERCENT,
                  spreadIssues,
                  clientRequestId,
                  hint: "Set forceClose=true to override this safety check",
                }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }
          } else {
            console.warn("CLOSE_GROUP_FORCE_CLOSE_BYPASSING_SPREAD_CHECK", {
              source,
              clientRequestId,
              trade_group_id,
            });
          }

          const orderUrl = `${baseUrl}/accounts/${accountId}/orders`;

          const orderParams: Record<string, string> = {
            type: "market",
            duration: "day",
            class: "multileg",
            symbol: underlying0,
          };

          legs.forEach((leg, idx) => {
            orderParams[`option_symbol[${idx}]`] = leg.symbol;
            orderParams[`side[${idx}]`] = leg.closeSide;
            orderParams[`quantity[${idx}]`] = String(leg.closeQty);
          });

          console.log("CLOSE_GROUP_ORDER_PARAMS", { source, clientRequestId, legs: legs.length, dryRun });

          if (dryRun) {
            closeLocks.set(lockKey, { inFlight: false, lastAcceptedAt: lock?.lastAcceptedAt || 0 });
            data = {
              dry_run: true,
              clientRequestId,
              planned_order: orderParams,
              legs,
              debug: debug
                ? { source, trade_group_id, orderParams, legs }
                : undefined,
            };
            break;
          }

          response = await fetch(orderUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiToken}`,
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams(orderParams).toString(),
          });

          const responseText = await response.text();
          let parsed: any = null;
          try {
            parsed = JSON.parse(responseText);
          } catch {
            parsed = { error: "Invalid response" };
          }

          const orderId = parsed?.order?.id;
          console.log("CLOSE_GROUP_ORDER_RESULT", { source, clientRequestId, orderId, status: response.status });

          if (orderId) {
            closeLocks.set(lockKey, { inFlight: false, lastAcceptedAt: Date.now() });
          } else {
            closeLocks.set(lockKey, { inFlight: false, lastAcceptedAt: lock?.lastAcceptedAt || 0 });
          }

          data = {
            ...parsed,
            clientRequestId,
            legs,
            debug: debug ? { source, trade_group_id, orderParams, legs } : undefined,
          };

          break;
        } finally {
          const cur = closeLocks.get(lockKey);
          if (cur) closeLocks.set(lockKey, { ...cur, inFlight: false });
        }
      }

      case "close_position": {
        if (!positionSymbol) {
          return new Response(
            JSON.stringify({ error: "positionSymbol required for close_position" }),
            {
              status: 400,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        const lockKey = `${accountId}:${positionSymbol}`;
        const now = Date.now();
        const lock = closeLocks.get(lockKey);

        console.log("CLOSE_REQUEST", {
          source,
          clientRequestId,
          trade_group_id,
          symbol: positionSymbol,
          dryRun,
        });

        if (lock?.inFlight) {
          console.log("CLOSE_SKIP_INFLIGHT", { source, clientRequestId, symbol: positionSymbol });
          return new Response(
            JSON.stringify({ skipped: true, reason: "lock_in_flight", clientRequestId }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        if (lock?.lastAcceptedAt && now - lock.lastAcceptedAt < CLOSE_COOLDOWN_MS) {
          console.log("CLOSE_SKIP_COOLDOWN", { source, clientRequestId, symbol: positionSymbol });
          return new Response(
            JSON.stringify({ skipped: true, reason: "cooldown", clientRequestId }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        closeLocks.set(lockKey, { inFlight: true, lastAcceptedAt: lock?.lastAcceptedAt || 0 });

        try {
          // Fetch exact position snapshot
          const posUrl = `${baseUrl}/accounts/${accountId}/positions`;
          const posResp = await fetch(posUrl, { headers });
          const posData = await safeParseTradierResponse(posResp);
          const positionsRaw = posData?.positions?.position;
          const posArray: TradierPosition[] = Array.isArray(positionsRaw)
            ? positionsRaw
            : positionsRaw
              ? [positionsRaw]
              : [];

          const matched = posArray.find((p) => String(p.symbol) === positionSymbol);
          if (!matched) {
            console.log("CLOSE_NOT_FOUND", { source, clientRequestId, symbol: positionSymbol });
            return new Response(
              JSON.stringify({ error: "Position not found", symbol: positionSymbol, clientRequestId }),
              { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }

          // Pull quote to get instrument type and check spread
          let quoteType: string | undefined;
          let quoteBid: number = 0;
          let quoteAsk: number = 0;
          try {
            const qUrl = `${baseUrl}/markets/quotes?symbols=${encodeURIComponent(positionSymbol)}`;
            const qResp = await fetch(qUrl, { headers });
            const qData = await safeParseTradierResponse(qResp);
            const q = qData?.quotes?.quote;
            const quote = Array.isArray(q) ? q[0] : q;
            quoteType = quote?.type as string | undefined;
            quoteBid = normalizeNumber(quote?.bid);
            quoteAsk = normalizeNumber(quote?.ask);
          } catch (e) {
            console.warn("QUOTE_FETCH_FAILED", { symbol: positionSymbol });
          }

          // SAFETY: Check bid/ask spread before placing close order
          const forceClose = !!body.forceClose;
          if (!forceClose && quoteBid > 0 && quoteAsk > 0) {
            const spreadPercent = calculateSpreadPercent(quoteBid, quoteAsk);
            if (spreadPercent > MAX_EXIT_SPREAD_PERCENT) {
              console.warn("CLOSE_POSITION_BLOCKED_WIDE_SPREAD", {
                source,
                clientRequestId,
                trade_group_id,
                symbol: positionSymbol,
                bid: quoteBid,
                ask: quoteAsk,
                spreadPercent: Math.round(spreadPercent * 10) / 10,
                maxAllowed: MAX_EXIT_SPREAD_PERCENT,
              });
              closeLocks.set(lockKey, { inFlight: false, lastAcceptedAt: lock?.lastAcceptedAt || 0 });
              return new Response(
                JSON.stringify({
                  blocked: true,
                  reason: "wide_spread",
                  symbol: positionSymbol,
                  bid: quoteBid,
                  ask: quoteAsk,
                  spreadPercent: Math.round(spreadPercent * 10) / 10,
                  maxAllowedSpreadPercent: MAX_EXIT_SPREAD_PERCENT,
                  clientRequestId,
                  hint: "Set forceClose=true to override this safety check",
                }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
              );
            }
          } else if (forceClose) {
            console.warn("CLOSE_POSITION_FORCE_CLOSE_BYPASSING_SPREAD_CHECK", {
              source,
              clientRequestId,
              trade_group_id,
              symbol: positionSymbol,
            });
          }

          const qty = normalizeNumber(matched.quantity);
          const costBasis = normalizeNumber(matched.cost_basis);
          const side = String(matched.side || "");
          const instrument_type = String(
            matched.instrument_type ||
              quoteType ||
              (isOccOptionSymbol(positionSymbol) ? "option" : "equity"),
          );

          console.log("CLOSE_POSITION_DATA", {
            source,
            clientRequestId,
            symbol: positionSymbol,
            instrument_type,
            quantity: qty,
            side: side || undefined,
          });

          const instruction = getCloseInstruction(matched, positionSymbol, quoteType);
          if (!instruction.ok) {
            console.log("CLOSE_INSTRUCTION_ERROR", { source, clientRequestId, error: instruction.error });
            return new Response(
              JSON.stringify({ error: instruction.error, clientRequestId, debug: { instruction } }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }

          const positionSize = Math.abs(qty);
          const closeQty = Math.min(instruction.closeQty, positionSize);
          if (!Number.isFinite(closeQty) || closeQty <= 0) {
            console.log("CLOSE_ZERO_SIZE", { source, clientRequestId, symbol: positionSymbol });
            return new Response(
              JSON.stringify({ error: "Position size is zero", clientRequestId, debug: { instruction } }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }

          const underlying = instruction.instrument_type === "option"
            ? extractUnderlyingFromOcc(positionSymbol)
            : positionSymbol;

          const orderUrl = `${baseUrl}/accounts/${accountId}/orders`;

          const orderParams: Record<string, string> = {
            class: instruction.instrument_type,
            symbol: underlying,
            side: instruction.closeSide,
            quantity: closeQty.toString(),
            type: "market",
            duration: "day",
          };
          if (instruction.instrument_type === "option") {
            orderParams.option_symbol = positionSymbol;
          }

          console.log("CLOSE_ORDER_PARAMS", {
            source,
            clientRequestId,
            symbol: positionSymbol,
            closeSide: instruction.closeSide,
            closeQty,
            dryRun,
          });

          if (dryRun) {
            closeLocks.set(lockKey, { inFlight: false, lastAcceptedAt: lock?.lastAcceptedAt || 0 });
            data = {
              dry_run: true,
              clientRequestId,
              planned_order: orderParams,
              debug: debug
                ? {
                    source,
                    trade_group_id,
                    instruction,
                    orderParams,
                  }
                : undefined,
            };
            break;
          }

          response = await fetch(orderUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiToken}`,
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams(orderParams).toString(),
          });

          const responseText = await response.text();
          let parsed: any = null;
          try {
            parsed = JSON.parse(responseText);
          } catch {
            parsed = { error: "Invalid response" };
          }

          const orderId = parsed?.order?.id;
          console.log("CLOSE_ORDER_RESULT", {
            source,
            clientRequestId,
            symbol: positionSymbol,
            orderId,
            status: response.status,
          });

          if (orderId) {
            closeLocks.set(lockKey, { inFlight: false, lastAcceptedAt: Date.now() });
          } else {
            closeLocks.set(lockKey, { inFlight: false, lastAcceptedAt: lock?.lastAcceptedAt || 0 });
          }

          data = {
            ...parsed,
            clientRequestId,
            debug: debug
              ? {
                  source,
                  trade_group_id,
                  instruction,
                  orderParams,
                }
              : undefined,
          };

          break;
        } finally {
          const cur = closeLocks.get(lockKey);
          if (cur) closeLocks.set(lockKey, { ...cur, inFlight: false });
        }
      }

      default:
        return new Response(JSON.stringify({ error: "Invalid action" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    if (!response?.ok && action !== "close_position") {
      console.error("TRADIER_API_ERROR", { action, status: response?.status });
      return new Response(JSON.stringify({ error: "Tradier API error", details: data }), {
        status: response?.status || 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "close_position" && response && !response.ok) {
      console.error("CLOSE_API_ERROR", { status: response.status });
      return new Response(JSON.stringify({ error: "Tradier API error", details: data }), {
        status: response.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("FUNCTION_ERROR", { error: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...getCorsHeaders(), "Content-Type": "application/json" },
    });
  }
});
