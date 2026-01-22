-- Reset P&L for all trades with trade_group_id to force recalculation with fixed logic
-- This will catch trades where exit_debit was incorrectly summed per-leg
UPDATE trades
SET 
  pnl = NULL,
  pnl_percent = NULL,
  pnl_formula = NULL,
  pnl_status = 'pending',
  pnl_computed_at = NULL,
  needs_reconcile = true
WHERE 
  trade_group_id IS NOT NULL
  AND exit_debit IS NOT NULL
  AND exit_debit > 100;  -- Only trades with substantial dollar exit_debit values