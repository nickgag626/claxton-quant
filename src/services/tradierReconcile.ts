import { supabase } from '@/integrations/supabase/client';
import { tradeJournal, TradeRecord, calculatePnl, hasVerifiedDirection } from './tradeJournal';

export interface TradierFill {
  id: string;
  order_id: string;
  symbol: string;
  option_symbol?: string;
  side: string;
  quantity: number;
  price: number;
  exec_quantity: number;
  avg_fill_price: number;
  transaction_date: string;
  create_date: string;
}

export interface TradierOrder {
  id: number;
  type: string;
  symbol: string;
  option_symbol?: string;
  side: string;
  quantity: number;
  status: string;
  duration: string;
  avg_fill_price: number;
  exec_quantity: number;
  create_date: string;
  transaction_date: string;
  class: string;
}

export interface ReconcileResult {
  success: boolean;
  reconciled: number;
  skipped: number;
  errors: string[];
  mismatches: string[];
}

/**
 * Fetch order history from Tradier for a date range
 */
async function fetchTradierOrders(startDate: string, endDate: string): Promise<TradierOrder[]> {
  try {
    const { data, error } = await supabase.functions.invoke('tradier-api', {
      body: {
        action: 'orders',
        startDate,
        endDate,
      },
    });

    if (error) throw error;
    
    const orders = data?.orders?.order;
    if (!orders) return [];
    return Array.isArray(orders) ? orders : [orders];
  } catch (error) {
    console.error('Error fetching Tradier orders:', error);
    return [];
  }
}

/**
 * Extract underlying from OCC option symbol
 */
function extractUnderlying(optionSymbol: string): string {
  // OCC format: SPY260112P00693000 -> SPY
  const match = optionSymbol.match(/^([A-Z]+)\d/);
  return match ? match[1] : optionSymbol;
}

/**
 * Determine if this is a closing order based on side
 */
function isClosingOrder(side: string): boolean {
  return side === 'buy_to_close' || side === 'sell_to_close';
}

/**
 * Determine if this is an opening order based on side
 */
function isOpeningOrder(side: string): boolean {
  return side === 'buy_to_open' || side === 'sell_to_open';
}

/**
 * Match trades using priority:
 * 1. Match by close_order_id or open_order_id
 * 2. Heuristic match by symbol, qty, price, timestamp
 */
function findMatchingOrder(
  trade: TradeRecord,
  orders: TradierOrder[],
  isOpening: boolean
): TradierOrder | null {
  const filterFn = isOpening ? isOpeningOrder : isClosingOrder;
  const matchingOrders = orders.filter(o => 
    o.status === 'filled' && 
    filterFn(o.side) &&
    (o.option_symbol === trade.symbol || o.symbol === trade.symbol)
  );

  if (matchingOrders.length === 0) return null;

  // Priority 1: Match by order ID
  const orderId = isOpening ? trade.open_order_id : trade.close_order_id;
  if (orderId) {
    const exactMatch = matchingOrders.find(o => String(o.id) === orderId);
    if (exactMatch) return exactMatch;
  }

  // Priority 2: Heuristic match
  const tradeTime = new Date(isOpening ? trade.entry_time : (trade.exit_time || trade.entry_time));
  const tradePrice = isOpening ? trade.entry_price : trade.exit_price;
  const tradeQty = trade.quantity;

  // Score each order
  let bestMatch: TradierOrder | null = null;
  let bestScore = 0;

  for (const order of matchingOrders) {
    let score = 0;
    
    // Quantity match (±1 tolerance)
    const qtyDiff = Math.abs((order.exec_quantity || order.quantity) - tradeQty);
    if (qtyDiff === 0) score += 10;
    else if (qtyDiff <= 1) score += 5;
    else continue; // Skip if qty is off by more than 1

    // Price proximity (within 10%)
    if (order.avg_fill_price > 0 && tradePrice > 0) {
      const priceDiff = Math.abs(order.avg_fill_price - tradePrice) / tradePrice;
      if (priceDiff < 0.01) score += 10;
      else if (priceDiff < 0.05) score += 5;
      else if (priceDiff < 0.10) score += 2;
    }

    // Timestamp proximity (within 24h)
    const orderTime = new Date(order.transaction_date || order.create_date);
    const timeDiff = Math.abs(orderTime.getTime() - tradeTime.getTime());
    const hoursDiff = timeDiff / (1000 * 60 * 60);
    if (hoursDiff < 1) score += 10;
    else if (hoursDiff < 6) score += 5;
    else if (hoursDiff < 24) score += 2;
    else continue; // Skip if more than 24h apart

    if (score > bestScore) {
      bestScore = score;
      bestMatch = order;
    }
  }

  return bestMatch;
}

/**
 * Reconcile trades from Tradier fills
 * NON-DESTRUCTIVE: Only backfills missing data, never deletes
 */
export async function reconcileFromTradierFills(
  startDate: string,
  endDate: string
): Promise<ReconcileResult> {
  const errors: string[] = [];
  const mismatches: string[] = [];
  let reconciled = 0;
  let skipped = 0;

  try {
    // 1. Fetch orders from Tradier
    const orders = await fetchTradierOrders(startDate, endDate);
    console.log(`Fetched ${orders.length} orders from Tradier`);

    if (orders.length === 0) {
      return { success: true, reconciled: 0, skipped: 0, errors: [], mismatches: ['No orders found in date range'] };
    }

    // 2. Fetch trades needing reconciliation
    const tradesNeedingReconcile = await tradeJournal.getTradesNeedingReconciliation();
    console.log(`Found ${tradesNeedingReconcile.length} trades needing reconciliation`);

    // 3. Reconcile each trade
    for (const trade of tradesNeedingReconcile) {
      const updates: Partial<TradeRecord> = {};
      let hasUpdates = false;

      // Find opening order
      if (!trade.open_side || !trade.open_order_id) {
        const openOrder = findMatchingOrder(trade, orders, true);
        if (openOrder) {
          updates.open_side = openOrder.side;
          updates.open_order_id = String(openOrder.id);
          updates.entry_price = openOrder.avg_fill_price;
          updates.entry_time = openOrder.transaction_date || openOrder.create_date;
          hasUpdates = true;
        }
      }

      // Find closing order
      if (!trade.close_side || !trade.close_order_id) {
        const closeOrder = findMatchingOrder(trade, orders, false);
        if (closeOrder) {
          updates.close_side = closeOrder.side;
          updates.close_order_id = String(closeOrder.id);
          updates.exit_price = closeOrder.avg_fill_price;
          updates.exit_time = closeOrder.transaction_date || closeOrder.create_date;
          hasUpdates = true;
        }
      }

      // Check if we now have verified direction
      const finalOpenSide = updates.open_side || trade.open_side;
      const finalCloseSide = updates.close_side || trade.close_side;
      const finalCloseOrderId = updates.close_order_id || trade.close_order_id;
      const finalOpenPrice = updates.entry_price ?? trade.entry_price;
      const finalClosePrice = updates.exit_price ?? trade.exit_price;

      if (finalOpenSide && finalCloseSide && finalCloseOrderId && finalOpenPrice && finalClosePrice) {
        // Calculate P&L
        const calc = calculatePnl(
          finalOpenSide,
          Number(finalOpenPrice),
          Number(finalClosePrice),
          trade.quantity,
          trade.multiplier || 100,
          trade.fees || 0
        );

        if (calc) {
          updates.pnl = calc.pnl;
          updates.pnl_percent = calc.pnlPercent;
          updates.pnl_formula = calc.formula;
          updates.needs_reconcile = false;
          hasUpdates = true;
        }
      } else {
        // Still missing required data
        mismatches.push(
          `Trade ${trade.id?.slice(0, 8)} (${trade.symbol}): ` +
          `missing ${!finalOpenSide ? 'open_side ' : ''}${!finalCloseSide ? 'close_side ' : ''}${!finalCloseOrderId ? 'close_order_id' : ''}`
        );
        skipped++;
        continue;
      }

      // Apply updates
      if (hasUpdates && trade.id) {
        const { error } = await supabase
          .from('trades')
          .update(updates)
          .eq('id', trade.id);

        if (error) {
          errors.push(`Trade ${trade.id}: ${error.message}`);
        } else {
          reconciled++;
        }
      } else {
        skipped++;
      }
    }

    return { success: true, reconciled, skipped, errors, mismatches };
  } catch (error) {
    console.error('Error in reconciliation:', error);
    return {
      success: false,
      reconciled,
      skipped,
      errors: [error instanceof Error ? error.message : 'Unknown error'],
      mismatches,
    };
  }
}

/**
 * Create missing trade records from Tradier order history
 * Useful for trades that were executed but never journaled
 */
export async function importMissingTrades(
  startDate: string,
  endDate: string
): Promise<{ success: boolean; imported: number; errors: string[] }> {
  const errors: string[] = [];
  let imported = 0;

  try {
    const orders = await fetchTradierOrders(startDate, endDate);
    
    // Get existing close_order_ids to avoid duplicates
    const { data: existingTrades } = await supabase
      .from('trades')
      .select('close_order_id')
      .not('close_order_id', 'is', null);

    const existingCloseOrderIds = new Set(
      (existingTrades || []).map(t => t.close_order_id)
    );

    // Group orders by option_symbol to pair opens with closes
    const ordersBySymbol = new Map<string, TradierOrder[]>();
    for (const order of orders) {
      if (order.status !== 'filled') continue;
      const symbol = order.option_symbol || order.symbol;
      const existing = ordersBySymbol.get(symbol) || [];
      existing.push(order);
      ordersBySymbol.set(symbol, existing);
    }

    // Process each symbol
    for (const [symbol, symbolOrders] of ordersBySymbol) {
      const opens = symbolOrders.filter(o => isOpeningOrder(o.side));
      const closes = symbolOrders.filter(o => isClosingOrder(o.side));

      for (const closeOrder of closes) {
        const closeOrderId = String(closeOrder.id);
        
        // Skip if already exists
        if (existingCloseOrderIds.has(closeOrderId)) {
          continue;
        }

        // Find matching open (simple heuristic: earliest open before this close)
        const matchingOpen = opens
          .filter(o => new Date(o.create_date) < new Date(closeOrder.create_date))
          .sort((a, b) => new Date(a.create_date).getTime() - new Date(b.create_date).getTime())[0];

        const underlying = extractUnderlying(symbol);
        const openSide = matchingOpen?.side;
        const closeSide = closeOrder.side;
        const openPrice = matchingOpen?.avg_fill_price;
        const closePrice = closeOrder.avg_fill_price;
        const qty = closeOrder.exec_quantity || closeOrder.quantity;

        // Only create trade if we have verified direction
        let pnl: number | null = null;
        let pnlPercent: number | null = null;
        let pnlFormula: string | null = null;
        let needsReconcile = true;

        if (openSide && closeSide && openPrice && closePrice) {
          const calc = calculatePnl(openSide, openPrice, closePrice, qty, 100, 0);
          if (calc) {
            pnl = calc.pnl;
            pnlPercent = calc.pnlPercent;
            pnlFormula = calc.formula;
            needsReconcile = false;
          }
        }

        const result = await tradeJournal.saveTrade({
          symbol,
          underlying,
          quantity: qty,
          entry_time: matchingOpen?.transaction_date || matchingOpen?.create_date || closeOrder.create_date,
          exit_time: closeOrder.transaction_date || closeOrder.create_date,
          entry_price: openPrice || 0,
          exit_price: closePrice,
          pnl: pnl as number, // Will be null if needs_reconcile
          pnl_percent: pnlPercent as number,
          pnl_formula: pnlFormula || undefined,
          open_side: openSide,
          close_side: closeSide,
          open_order_id: matchingOpen ? String(matchingOpen.id) : undefined,
          close_order_id: closeOrderId,
          multiplier: 100,
          fees: 0,
          needs_reconcile: needsReconcile,
        });

        if (result.success && !result.duplicate) {
          imported++;
        } else if (!result.success) {
          errors.push(`Order ${closeOrderId}: ${result.error}`);
        }
      }
    }

    return { success: true, imported, errors };
  } catch (error) {
    console.error('Error importing trades:', error);
    return {
      success: false,
      imported,
      errors: [error instanceof Error ? error.message : 'Unknown error'],
    };
  }
}
