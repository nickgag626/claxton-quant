/**
 * Tradier Execution-Based Reconciliation Service
 * 
 * Uses Tradier order details to infer:
 * - Trade direction (open_side / close_side) from execution sides
 * - Prices from weighted avg fill prices
 * - Fees from order data
 * 
 * RULES:
 * - No manual override - automatic inference only
 * - If direction cannot be inferred from executions, trade stays unverified
 * - P&L is only computed when direction is verified from executions
 */

import { supabase } from '@/integrations/supabase/client';
import { tradeJournal, TradeRecord, calculatePnl } from './tradeJournal';

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
  leg?: TradierLeg | TradierLeg[];
}

interface TradierLeg {
  id: number;
  type: string;
  symbol: string;
  side: string;
  quantity: number;
  status: string;
  avg_fill_price: number;
  exec_quantity: number;
  option_symbol?: string;
}

export interface ReconcileResult {
  success: boolean;
  reconciled: number;
  skipped: number;
  errors: string[];
  summary: {
    verified: number;
    unverified: number;
    totalPnl: number;
  };
}

/**
 * Determine if this is a closing order based on side
 */
function isClosingOrder(side: string): boolean {
  return side === 'buy_to_close' || side === 'sell_to_close' || side === 'buy_to_cover';
}

/**
 * Determine if this is an opening order based on side
 */
function isOpeningOrder(side: string): boolean {
  return side === 'buy_to_open' || side === 'sell_to_open' || side === 'buy' || side === 'sell';
}

/**
 * Normalize side to canonical close_side format
 */
function normalizeToCloseSide(side: string): string | null {
  if (side === 'sell_to_close') return 'sell_to_close';
  if (side === 'buy_to_close' || side === 'buy_to_cover') return 'buy_to_close';
  return null;
}

/**
 * Normalize side to canonical open_side format
 */
function normalizeToOpenSide(side: string): string | null {
  if (side === 'sell_to_open' || side === 'sell') return 'sell_to_open';
  if (side === 'buy_to_open' || side === 'buy') return 'buy_to_open';
  return null;
}

/**
 * Infer open_side from close_side (complementary sides)
 * This is the KEY inference rule based on Tradier execution data
 */
function inferOpenSideFromCloseSide(closeSide: string): string | null {
  // If we closed with buy_to_close, we must have opened with sell_to_open (short)
  if (closeSide === 'buy_to_close') return 'sell_to_open';
  // If we closed with sell_to_close, we must have opened with buy_to_open (long)
  if (closeSide === 'sell_to_close') return 'buy_to_open';
  return null;
}

/**
 * Extract underlying from OCC option symbol
 */
function extractUnderlying(optionSymbol: string): string {
  const match = optionSymbol.match(/^([A-Z]+)\d/);
  return match ? match[1] : optionSymbol;
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
 * Extract execution data from an order (handles multi-leg orders)
 */
function extractExecutionFromOrder(
  order: TradierOrder, 
  targetSymbol: string
): { side: string; avgFillPrice: number; execQty: number } | null {
  // Check if order has legs (multi-leg order like spreads)
  if (order.leg) {
    const legs = Array.isArray(order.leg) ? order.leg : [order.leg];
    const matchingLeg = legs.find(l => 
      (l.option_symbol === targetSymbol) || (l.symbol === targetSymbol)
    );
    
    if (matchingLeg && matchingLeg.status === 'filled') {
      return {
        side: matchingLeg.side,
        avgFillPrice: matchingLeg.avg_fill_price,
        execQty: matchingLeg.exec_quantity || matchingLeg.quantity
      };
    }
  }
  
  // Single-leg order
  const orderSymbol = order.option_symbol || order.symbol;
  if (orderSymbol === targetSymbol && order.status === 'filled') {
    return {
      side: order.side,
      avgFillPrice: order.avg_fill_price,
      execQty: order.exec_quantity || order.quantity
    };
  }
  
  return null;
}

/**
 * Find matching orders for a trade
 * Priority:
 * 1. Exact match by close_order_id or open_order_id
 * 2. Heuristic match by symbol + qty + timestamp proximity (±30 min)
 */
function findMatchingOrders(
  trade: TradeRecord,
  orders: TradierOrder[]
): { openOrder: TradierOrder | null; closeOrder: TradierOrder | null } {
  const filledOrders = orders.filter(o => o.status === 'filled');
  const tradeSymbol = trade.symbol;
  
  // 1. Match by close_order_id
  let closeOrder: TradierOrder | null = null;
  if (trade.close_order_id) {
    closeOrder = filledOrders.find(o => String(o.id) === String(trade.close_order_id)) || null;
  }
  
  // 2. Match by open_order_id
  let openOrder: TradierOrder | null = null;
  if (trade.open_order_id) {
    openOrder = filledOrders.find(o => String(o.id) === String(trade.open_order_id)) || null;
  }
  
  // 3. Heuristic matching if no exact match
  const tradeQty = Math.abs(trade.quantity);
  const entryTime = new Date(trade.entry_time).getTime();
  const exitTime = trade.exit_time ? new Date(trade.exit_time).getTime() : Date.now();
  
  // Filter orders that match the trade symbol
  const candidateOrders = filledOrders.filter(order => {
    // Check main order symbol
    if (order.option_symbol === tradeSymbol || order.symbol === tradeSymbol) {
      return true;
    }
    // Check legs for multi-leg orders
    if (order.leg) {
      const legs = Array.isArray(order.leg) ? order.leg : [order.leg];
      return legs.some(l => l.option_symbol === tradeSymbol || l.symbol === tradeSymbol);
    }
    return false;
  });
  
  // Find close order by heuristic (within 30 min of exit, matching qty, closing side)
  if (!closeOrder) {
    for (const order of candidateOrders) {
      const exec = extractExecutionFromOrder(order, tradeSymbol);
      if (!exec) continue;
      
      // Must be a closing order
      if (!isClosingOrder(exec.side)) continue;
      
      // Check quantity (±1 tolerance)
      if (Math.abs(exec.execQty - tradeQty) > 1) continue;
      
      // Check timestamp proximity (within 30 min of exit)
      const orderTime = new Date(order.transaction_date || order.create_date).getTime();
      const timeDiff = Math.abs(orderTime - exitTime);
      if (timeDiff < 30 * 60 * 1000) {
        closeOrder = order;
        break;
      }
    }
  }
  
  // Find open order by heuristic (within 30 min of entry, matching qty, opening side)
  if (!openOrder) {
    for (const order of candidateOrders) {
      const exec = extractExecutionFromOrder(order, tradeSymbol);
      if (!exec) continue;
      
      // Must be an opening order
      if (!isOpeningOrder(exec.side)) continue;
      
      // Check quantity (±1 tolerance)
      if (Math.abs(exec.execQty - tradeQty) > 1) continue;
      
      // Check timestamp proximity (within 30 min of entry)
      const orderTime = new Date(order.transaction_date || order.create_date).getTime();
      const timeDiff = Math.abs(orderTime - entryTime);
      if (timeDiff < 30 * 60 * 1000) {
        openOrder = order;
        break;
      }
    }
  }
  
  return { openOrder, closeOrder };
}

/**
 * Reconcile trades from Tradier executions
 * NON-DESTRUCTIVE: Only backfills missing data, never deletes
 * 
 * Direction inference:
 * - Uses close_side from Tradier execution to infer open_side
 * - If close_side is buy_to_close -> open_side was sell_to_open (short)
 * - If close_side is sell_to_close -> open_side was buy_to_open (long)
 */
export async function reconcileFromTradierFills(
  startDate: string,
  endDate: string
): Promise<ReconcileResult> {
  const errors: string[] = [];
  let reconciled = 0;
  let skipped = 0;

  try {
    // 1. Fetch orders from Tradier
    const orders = await fetchTradierOrders(startDate, endDate);
    console.log(`Fetched ${orders.length} orders from Tradier`);

    if (orders.length === 0) {
      // Still calculate summary
      const { data: verifiedTrades } = await supabase
        .from('trades')
        .select('pnl')
        .eq('needs_reconcile', false)
        .not('pnl', 'is', null);
      
      const { data: unverifiedTrades } = await supabase
        .from('trades')
        .select('id')
        .eq('needs_reconcile', true);
      
      const totalPnl = (verifiedTrades || []).reduce((sum, t) => sum + Number(t.pnl || 0), 0);
      
      return { 
        success: true, 
        reconciled: 0, 
        skipped: 0, 
        errors: ['No orders found in date range'],
        summary: {
          verified: verifiedTrades?.length || 0,
          unverified: unverifiedTrades?.length || 0,
          totalPnl
        }
      };
    }

    // 2. Fetch trades needing reconciliation
    const tradesNeedingReconcile = await tradeJournal.getTradesNeedingReconciliation();
    console.log(`Found ${tradesNeedingReconcile.length} trades needing reconciliation`);

    // 3. Reconcile each trade
    for (const trade of tradesNeedingReconcile) {
      try {
        const { openOrder, closeOrder } = findMatchingOrders(trade, orders);
        
        // We NEED the close order to infer direction
        if (!closeOrder) {
          console.log(`No matching close order for ${trade.symbol} - staying unverified`);
          skipped++;
          continue;
        }
        
        // Extract execution data from close order
        const closeExec = extractExecutionFromOrder(closeOrder, trade.symbol);
        if (!closeExec) {
          console.log(`Could not extract close execution for ${trade.symbol}`);
          skipped++;
          continue;
        }
        
        // Get canonical close_side
        const closeSide = normalizeToCloseSide(closeExec.side);
        if (!closeSide) {
          console.log(`Unknown close side: ${closeExec.side} for ${trade.symbol} - not a closing order`);
          skipped++;
          continue;
        }
        
        // INFER open_side from close_side (this is the key automatic inference)
        const openSide = inferOpenSideFromCloseSide(closeSide);
        if (!openSide) {
          console.log(`Could not infer open side from close side: ${closeSide}`);
          skipped++;
          continue;
        }
        
        // Get prices
        const closePrice = closeExec.avgFillPrice;
        let openPrice = trade.entry_price;
        let openOrderId = trade.open_order_id;
        
        // If we have an open order, use its price
        if (openOrder) {
          const openExec = extractExecutionFromOrder(openOrder, trade.symbol);
          if (openExec) {
            openPrice = openExec.avgFillPrice;
            openOrderId = String(openOrder.id);
          }
        }
        
        const quantity = closeExec.execQty || trade.quantity;
        const multiplier = trade.multiplier || 100;
        const fees = Number(trade.fees) || 0;
        
        // Calculate P&L with verified direction
        const pnlCalc = calculatePnl(openSide, openPrice, closePrice, quantity, multiplier, fees);
        
        if (!pnlCalc) {
          console.log(`P&L calculation failed for ${trade.symbol}`);
          errors.push(`${trade.symbol}: P&L calculation failed`);
          skipped++;
          continue;
        }
        
        // Update the trade with verified data
        const { error: updateError } = await supabase
          .from('trades')
          .update({
            open_side: openSide,
            close_side: closeSide,
            open_order_id: openOrderId,
            close_order_id: String(closeOrder.id),
            entry_price: openPrice,
            exit_price: closePrice,
            quantity: quantity,
            pnl: pnlCalc.pnl,
            pnl_percent: pnlCalc.pnlPercent,
            pnl_formula: pnlCalc.formula,
            needs_reconcile: false,
          })
          .eq('id', trade.id);
        
        if (updateError) {
          errors.push(`${trade.symbol}: ${updateError.message}`);
          skipped++;
        } else {
          console.log(`Reconciled ${trade.symbol}: ${openSide} → ${closeSide}, P&L: ${pnlCalc.pnl.toFixed(2)}`);
          reconciled++;
        }
        
      } catch (tradeError) {
        const msg = tradeError instanceof Error ? tradeError.message : String(tradeError);
        errors.push(`${trade.symbol}: ${msg}`);
        skipped++;
      }
    }

    // 4. Fetch summary stats
    const { data: verifiedTrades } = await supabase
      .from('trades')
      .select('pnl')
      .eq('needs_reconcile', false)
      .not('pnl', 'is', null);
    
    const { data: unverifiedTrades } = await supabase
      .from('trades')
      .select('id')
      .eq('needs_reconcile', true);
    
    const totalPnl = (verifiedTrades || []).reduce((sum, t) => sum + Number(t.pnl || 0), 0);

    return { 
      success: true, 
      reconciled, 
      skipped, 
      errors,
      summary: {
        verified: verifiedTrades?.length || 0,
        unverified: unverifiedTrades?.length || 0,
        totalPnl
      }
    };
  } catch (error) {
    console.error('Error in reconciliation:', error);
    return {
      success: false,
      reconciled,
      skipped,
      errors: [error instanceof Error ? error.message : 'Unknown error'],
      summary: { verified: 0, unverified: 0, totalPnl: 0 }
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

        // Get close side and infer open side
        const closeSide = normalizeToCloseSide(closeOrder.side);
        if (!closeSide) continue;
        
        const openSide = inferOpenSideFromCloseSide(closeSide);
        if (!openSide) continue;

        // Find matching open (simple heuristic: earliest open before this close)
        const matchingOpen = opens
          .filter(o => new Date(o.create_date) < new Date(closeOrder.create_date))
          .sort((a, b) => new Date(a.create_date).getTime() - new Date(b.create_date).getTime())[0];

        const underlying = extractUnderlying(symbol);
        const openPrice = matchingOpen?.avg_fill_price;
        const closePrice = closeOrder.avg_fill_price;
        const qty = closeOrder.exec_quantity || closeOrder.quantity;

        // Only create trade if we have all required data
        let pnl: number | null = null;
        let pnlPercent: number | null = null;
        let pnlFormula: string | null = null;
        let needsReconcile = true;

        if (openPrice && closePrice) {
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
          pnl: pnl as number,
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
