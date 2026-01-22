-- Reset trades that have suspiciously low exit_debit values (per-share stored as dollars)
-- These trades will be recalculated with the fixed Exit Debit Resolver logic
UPDATE trades
SET 
  pnl = NULL,
  pnl_percent = NULL,
  pnl_formula = NULL,
  pnl_status = 'pending',
  pnl_computed_at = NULL,
  needs_reconcile = true
WHERE 
  exit_debit IS NOT NULL 
  AND exit_debit > 0 
  AND exit_debit < 15  -- Likely per-share (dollars would be 100x larger)
  AND exit_price IS NOT NULL
  AND exit_price > 0.01;  -- Non-trivial exit price