import { supabase } from '@/integrations/supabase/client';
import { tradeJournal, TradeRecord, calculatePnl } from './tradeJournal';

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
 * Reconcile trades from Tradier fills
 * Fetches order history and backfills missing data in trades table
 */
export async function reconcileFromTradierFills(
  startDate: string,
  endDate: string
): Promise<ReconcileResult> {
  const errors: string[] = [];
  const mismatches: string[] = [];
  let reconciled = 0;

  try {
    // 1. Fetch orders from Tradier
    const orders = await fetchTradierOrders(startDate, endDate);
    console.log(`Fetched ${orders.length} orders from Tradier`);

    if (orders.length === 0) {
      return { success: true, reconciled: 0, errors: [], mismatches: ['No orders found in date range'] };
    }

    // 2. Fetch trades needing reconciliation
    const tradesNeedingReconcile = await tradeJournal.getTradesNeedingReconciliation();
    console.log(`Found ${tradesNeedingReconcile.length} trades needing reconciliation`);

    // 3. Build a map of orders by option_symbol for quick lookup
    const openOrdersBySymbol = new Map<string, TradierOrder>();
    const closeOrdersBySymbol = new Map<string, TradierOrder>();

    for (const order of orders) {
      if (order.status !== 'filled') continue;
      
      const symbol = order.option_symbol || order.symbol;
      
      if (isOpeningOrder(order.side)) {
        // Keep the earliest open order
        if (!openOrdersBySymbol.has(symbol)) {
          openOrdersBySymbol.set(symbol, order);
        }
      } else if (isClosingOrder(order.side)) {
        // Keep the latest close order
        closeOrdersBySymbol.set(symbol, order);
      }
    }

    // 4. Reconcile each trade
    for (const trade of tradesNeedingReconcile) {
      const openOrder = openOrdersBySymbol.get(trade.symbol);
      const closeOrder = closeOrdersBySymbol.get(trade.symbol);

      const updates: Partial<TradeRecord> = {};
      let hasUpdates = false;

      // Backfill open data
      if (!trade.open_side && openOrder) {
        updates.open_side = openOrder.side;
        updates.open_order_id = String(openOrder.id);
        updates.entry_price = openOrder.avg_fill_price;
        updates.entry_time = openOrder.transaction_date || openOrder.create_date;
        hasUpdates = true;
      }

      // Backfill close data
      if (!trade.close_order_id && closeOrder) {
        updates.close_side = closeOrder.side;
        updates.close_order_id = String(closeOrder.id);
        updates.exit_price = closeOrder.avg_fill_price;
        updates.exit_time = closeOrder.transaction_date || closeOrder.create_date;
        hasUpdates = true;
      }

      // Recalculate P&L if we have both sides now
      const openSide = updates.open_side || trade.open_side;
      const openPrice = updates.entry_price ?? trade.entry_price;
      const closePrice = updates.exit_price ?? trade.exit_price;

      if (openSide && openPrice && closePrice) {
        const calc = calculatePnl(
          openSide,
          Number(openPrice),
          Number(closePrice),
          trade.quantity,
          trade.multiplier || 100,
          trade.fees || 0
        );
        updates.pnl = calc.pnl;
        updates.pnl_percent = calc.pnlPercent;
        updates.pnl_formula = calc.formula;
        updates.needs_reconcile = false;
        hasUpdates = true;
      } else {
        // Still missing data
        if (!openOrder && !closeOrder) {
          mismatches.push(`Trade ${trade.id?.slice(0, 8)} (${trade.symbol}): no matching orders found`);
        }
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
      }
    }

    return { success: true, reconciled, errors, mismatches };
  } catch (error) {
    console.error('Error in reconciliation:', error);
    return {
      success: false,
      reconciled,
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
        const openPrice = matchingOpen?.avg_fill_price;
        const closePrice = closeOrder.avg_fill_price;
        const qty = closeOrder.exec_quantity || closeOrder.quantity;

        let pnl = 0;
        let pnlPercent = 0;
        let pnlFormula = '';
        let needsReconcile = !matchingOpen;

        if (openSide && openPrice && closePrice) {
          const calc = calculatePnl(openSide, openPrice, closePrice, qty, 100, 0);
          pnl = calc.pnl;
          pnlPercent = calc.pnlPercent;
          pnlFormula = calc.formula;
        }

        const result = await tradeJournal.saveTrade({
          symbol,
          underlying,
          quantity: qty,
          entry_time: matchingOpen?.transaction_date || matchingOpen?.create_date || closeOrder.create_date,
          exit_time: closeOrder.transaction_date || closeOrder.create_date,
          entry_price: openPrice || 0,
          exit_price: closePrice,
          pnl,
          pnl_percent: pnlPercent,
          pnl_formula: pnlFormula,
          open_side: openSide,
          close_side: closeOrder.side,
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
