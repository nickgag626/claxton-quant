-- Add new columns for improved P&L tracking and combo order handling
-- These columns separate trigger reason from outcome and track actual contracts

-- 1. exit_price_source: How the exit_debit was calculated
-- Values: 'PER_LEG' (individual fills), 'COMBO_NET' (combo order net), 'PARTIAL' (mixed)
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS exit_price_source TEXT;

-- 2. exit_trigger_reason: Why exit was initiated (separated from outcome)
-- Values: 'profit_target', 'stop_loss', 'expiry', 'manual', 'eod', etc.
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS exit_trigger_reason TEXT;

-- 3. contracts: Actual number of contracts traded (not leg count)
-- For IC with 2 contracts: contracts=2, leg_count=4
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS contracts INTEGER;

-- 4. leg_count: Number of distinct legs in the spread
-- Iron Condor = 4, Vertical = 2, Single = 1
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS leg_count INTEGER;

-- Migrate existing exit_reason data to exit_trigger_reason where appropriate
-- Only copy if exit_trigger_reason is null (don't overwrite)
UPDATE public.trades 
SET exit_trigger_reason = exit_reason 
WHERE exit_trigger_reason IS NULL 
  AND exit_reason IS NOT NULL;

-- Populate leg_count from existing grouped trades
-- Count distinct symbols per trade_group_id
WITH leg_counts AS (
  SELECT trade_group_id, COUNT(DISTINCT symbol) as legs
  FROM public.trades
  WHERE trade_group_id IS NOT NULL
  GROUP BY trade_group_id
)
UPDATE public.trades t
SET leg_count = lc.legs
FROM leg_counts lc
WHERE t.trade_group_id = lc.trade_group_id
  AND t.leg_count IS NULL;

-- Set leg_count = 1 for ungrouped trades
UPDATE public.trades
SET leg_count = 1
WHERE trade_group_id IS NULL
  AND leg_count IS NULL;

-- Add indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_trades_exit_price_source ON public.trades(exit_price_source);
CREATE INDEX IF NOT EXISTS idx_trades_exit_trigger_reason ON public.trades(exit_trigger_reason);

-- Note: contracts column intentionally NOT backfilled
-- Legacy rows stay NULL; app code detects and applies normalization at read time