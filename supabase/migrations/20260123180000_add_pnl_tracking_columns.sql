-- P&L Tracking Columns Migration
-- Adds 4 columns to fix combo order handling and separate trigger from outcome
-- Generated: 2026-01-23

-- =============================================================================
-- COLUMN 1: exit_price_source
-- Tracks how exit_debit was calculated
-- =============================================================================
ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_price_source TEXT;

-- Leave NULL for legacy rows, application code will populate going forward
-- Values: PER_LEG | COMBO_NET | PARTIAL

COMMENT ON COLUMN trades.exit_price_source IS 'PER_LEG|COMBO_NET|PARTIAL - how exit_debit was calculated';

-- =============================================================================
-- COLUMN 2: exit_trigger_reason
-- Why exit was initiated (mark-based decision from strategy engine)
-- Separated from exit_reason which historically conflated trigger with outcome
-- =============================================================================
ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_trigger_reason TEXT;

-- Migrate existing exit_reason values to exit_trigger_reason
-- This preserves the original trigger reason
UPDATE trades
SET exit_trigger_reason = exit_reason
WHERE exit_reason IS NOT NULL
  AND exit_trigger_reason IS NULL;

COMMENT ON COLUMN trades.exit_trigger_reason IS 'Why exit was initiated (mark-based): stop_loss, profit_target, time_stop, manual, etc.';

-- =============================================================================
-- COLUMN 3: contracts
-- Actual number of contracts traded (NOT leg count)
-- Conservative: Do NOT backfill legacy rows to avoid misclassifying real 4-contract trades
-- Code will detect NULL and apply normalization logic at read time
-- =============================================================================
ALTER TABLE trades ADD COLUMN IF NOT EXISTS contracts INTEGER;

-- Do NOT backfill legacy rows - they will remain NULL
-- Code detects NULL contracts and applies: if (contracts === null && legCount >= 4 && quantity === legCount) → 1
-- This avoids misclassifying legitimate 4-contract iron condor trades

-- Set default for NEW rows only
ALTER TABLE trades ALTER COLUMN contracts SET DEFAULT 1;

COMMENT ON COLUMN trades.contracts IS 'Actual contracts traded. NULL = legacy row, apply code-side normalization';

-- =============================================================================
-- COLUMN 4: leg_count
-- Number of legs in the spread (e.g., 4 for iron condor, 2 for vertical)
-- Uses COUNT(DISTINCT symbol) to avoid counting duplicate rows
-- =============================================================================
ALTER TABLE trades ADD COLUMN IF NOT EXISTS leg_count INTEGER;

-- Populate from distinct symbol count per group
UPDATE trades t
SET leg_count = sub.cnt
FROM (
  SELECT trade_group_id, COUNT(DISTINCT symbol) as cnt
  FROM trades
  WHERE trade_group_id IS NOT NULL
  GROUP BY trade_group_id
) sub
WHERE t.trade_group_id = sub.trade_group_id
  AND t.leg_count IS NULL;

-- Single trades without group get leg_count = 1
UPDATE trades
SET leg_count = 1
WHERE trade_group_id IS NULL
  AND leg_count IS NULL;

-- Set default for new rows
ALTER TABLE trades ALTER COLUMN leg_count SET DEFAULT 1;

COMMENT ON COLUMN trades.leg_count IS 'Number of distinct legs in spread (from COUNT(DISTINCT symbol))';

-- =============================================================================
-- INDEXES
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_trades_exit_price_source ON trades(exit_price_source);
CREATE INDEX IF NOT EXISTS idx_trades_exit_trigger_reason ON trades(exit_trigger_reason);

-- =============================================================================
-- VERIFICATION QUERY (run manually to check migration)
-- =============================================================================
-- SELECT
--   exit_price_source,
--   exit_trigger_reason,
--   contracts,
--   leg_count,
--   COUNT(*) as cnt
-- FROM trades
-- GROUP BY exit_price_source, exit_trigger_reason, contracts, leg_count
-- ORDER BY cnt DESC;
