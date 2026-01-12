import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-client-request-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
    | "close_position";
  symbols?: string[];
  symbol?: string;
  expiration?: string;

  // close_position
  positionSymbol?: string;
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

const isOccOptionSymbol = (s: string) => /^[A-Z]+\d{6}[CP]\d{8}$/.test(s);

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
      console.warn("WARN: inferred position side from cost_basis as last resort", {
        positionSymbol,
        cost_basis: costBasis,
      });
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
    console.error("Tradier returned HTML instead of JSON:", text.slice(0, 500));
    return { error: "Tradier API returned HTML error page", status: resp.status, html_preview: text.slice(0, 200) };
  }
  try {
    return JSON.parse(text);
  } catch {
    console.error("Failed to parse Tradier response:", text.slice(0, 500));
    return { error: "Invalid JSON from Tradier", raw: text.slice(0, 200) };
  }
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Safely parse request body
    let body: TradierRequest;
    try {
      const rawText = await req.text();
      console.log("RAW_REQUEST_BODY", { length: rawText.length, preview: rawText.slice(0, 200) });
      body = JSON.parse(rawText) as TradierRequest;
    } catch (parseError) {
      console.error("Failed to parse request body as JSON:", parseError);
      return new Response(
        JSON.stringify({ error: "Invalid JSON in request body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const action = body.action;

    // Handle ping immediately (no Tradier credentials needed)
    if (action === "ping") {
      console.log("PING received");
      return new Response(
        JSON.stringify({ ok: true, timestamp: new Date().toISOString(), action: "ping" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const apiToken = Deno.env.get("TRADIER_API_TOKEN");
    const accountId = Deno.env.get("TRADIER_ACCOUNT_ID");

    if (!apiToken || !accountId) {
      console.error("Missing Tradier credentials");
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
        console.log("Fetching quotes:", url);
        response = await fetch(url, { headers });
        data = await safeParseTradierResponse(response);
        console.log("Quote response:", JSON.stringify(data));
        break;
      }

      case "positions": {
        const url = `${baseUrl}/accounts/${accountId}/positions`;
        console.log("Fetching positions:", url);
        response = await fetch(url, { headers });
        data = await safeParseTradierResponse(response);
        console.log("Positions response:", JSON.stringify(data));
        break;
      }

      case "balances": {
        const url = `${baseUrl}/accounts/${accountId}/balances`;
        console.log("Fetching balances:", url);
        response = await fetch(url, { headers });
        data = await safeParseTradierResponse(response);
        console.log("Balances response:", JSON.stringify(data));
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
        console.log("Fetching expirations:", url);
        response = await fetch(url, { headers });
        data = await safeParseTradierResponse(response);
        console.log("Expirations response:", JSON.stringify(data));
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
        console.log("Fetching chain:", url);
        response = await fetch(url, { headers });
        data = await safeParseTradierResponse(response);
        console.log("Chain response received");
        break;
      }

      case "clock": {
        const url = `${baseUrl}/markets/clock`;
        console.log("Fetching market clock:", url);
        response = await fetch(url, { headers });
        data = await safeParseTradierResponse(response);
        console.log("Clock response:", JSON.stringify(data));
        break;
      }

      case "orders": {
        // Fetch order history for reconciliation
        const startDate = body.startDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const endDate = body.endDate || new Date().toISOString().split('T')[0];
        const url = `${baseUrl}/accounts/${accountId}/orders?includeTags=true`;
        console.log("Fetching orders:", url);
        response = await fetch(url, { headers });
        data = await safeParseTradierResponse(response);
        console.log("Orders response received, count:", Array.isArray(data?.orders?.order) ? data.orders.order.length : (data?.orders?.order ? 1 : 0));
        break;
      }

      case "order_detail": {
        // Fetch specific order details with leg info (includes fill prices)
        const orderId = body.orderId;
        if (!orderId) {
          return new Response(JSON.stringify({ error: "orderId required for order_detail" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const url = `${baseUrl}/accounts/${accountId}/orders/${orderId}`;
        console.log("Fetching order detail:", url);
        response = await fetch(url, { headers });
        data = await safeParseTradierResponse(response);
        console.log("Order detail response:", JSON.stringify(data));
        break;
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
          lockKey,
          dryRun,
          debug,
        });

        if (lock?.inFlight) {
          console.log("SKIP: cooldown/lock (in-flight)", { source, clientRequestId, lockKey });
          return new Response(
            JSON.stringify({ skipped: true, reason: "lock_in_flight", clientRequestId }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        if (lock?.lastAcceptedAt && now - lock.lastAcceptedAt < CLOSE_COOLDOWN_MS) {
          console.log("SKIP: cooldown/lock (recently accepted)", { source, clientRequestId, lockKey });
          return new Response(
            JSON.stringify({ skipped: true, reason: "cooldown", clientRequestId }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }

        closeLocks.set(lockKey, { inFlight: true, lastAcceptedAt: lock?.lastAcceptedAt || 0 });

        try {
          // 0) Fetch exact position snapshot
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
            console.log("CLOSE_DECISION: position_not_found", {
              source,
              clientRequestId,
              positionSymbol,
              positionsCount: posArray.length,
            });
            return new Response(
              JSON.stringify({ error: "Position not found", symbol: positionSymbol, clientRequestId }),
              { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }

          // Pull quote to get instrument type if possible
          let quoteType: string | undefined;
          try {
            const qUrl = `${baseUrl}/markets/quotes?symbols=${encodeURIComponent(positionSymbol)}`;
            const qResp = await fetch(qUrl, { headers });
            const qData = await safeParseTradierResponse(qResp);
            const q = qData?.quotes?.quote;
            quoteType = (Array.isArray(q) ? q[0]?.type : q?.type) as string | undefined;
          } catch (e) {
            console.warn("WARN: failed to fetch quote for instrument_type", {
              source,
              clientRequestId,
              positionSymbol,
              error: e instanceof Error ? e.message : String(e),
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

          console.log("CLOSE_RAW_POSITION", {
            source,
            clientRequestId,
            symbol: positionSymbol,
            instrument_type,
            quantity: qty,
            cost_basis: costBasis,
            side: side || undefined,
            raw: matched,
          });

          const instruction = getCloseInstruction(matched, positionSymbol, quoteType);
          if (!instruction.ok) {
            console.log("CLOSE_DECISION_ERROR", { source, clientRequestId, ...instruction });
            return new Response(
              JSON.stringify({ error: instruction.error, clientRequestId, debug: { instruction } }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }

          // 2) Never exceed position size
          const positionSize = Math.abs(qty);
          const closeQty = Math.min(instruction.closeQty, positionSize);
          if (!Number.isFinite(closeQty) || closeQty <= 0) {
            console.log("CLOSE_DECISION: zero_position_size", {
              source,
              clientRequestId,
              positionSymbol,
              qty,
              instruction,
            });
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

          console.log("CLOSE_DECISION", {
            source,
            clientRequestId,
            trade_group_id,
            symbol: positionSymbol,
            instrument_type: instruction.instrument_type,
            side: instruction.side,
            computed: instruction,
            orderParams,
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
                    raw_position: matched,
                    quote_type: quoteType,
                    instruction,
                    orderParams,
                    response: { dry_run: true },
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
          console.log("CLOSE_ORDER_RESPONSE_TEXT", {
            source,
            clientRequestId,
            responseText,
          });

          let parsed: any = null;
          try {
            parsed = JSON.parse(responseText);
          } catch {
            parsed = { error: responseText };
          }

          // mark accepted timestamp only when Tradier returns an order id
          if (parsed?.order?.id) {
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
                  raw_position: matched,
                  quote_type: quoteType,
                  instruction,
                  orderParams,
                  response: parsed,
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
      console.error("Tradier API error:", response?.status, data);
      return new Response(JSON.stringify({ error: "Tradier API error", details: data }), {
        status: response?.status || 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "close_position" && response && !response.ok) {
      console.error("Tradier API close_position error:", response.status, data);
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
    console.error("Error in tradier-api function:", error);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
