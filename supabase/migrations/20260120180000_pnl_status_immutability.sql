-- Migration: Add P&L status tracking for immutable realized P&L
-- Purpose: Ensure P&L is computed once from actual fills and never re-inferred

-- Add new columns to trades table
ALTER TABLE public.trades
ADD COLUMN IF NOT EXISTS pnl_status TEXT DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS exit_debit_dollars NUMERIC,
ADD COLUMN IF NOT EXISTS entry_credit_dollars NUMERIC,
ADD COLUMN IF NOT EXISTS pnl_computed_at TIMESTAMPTZ;

-- Add check constraint for valid pnl_status values
ALTER TABLE public.trades
ADD CONSTRAINT trades_pnl_status_check
CHECK (pnl_status IN ('pending', 'computed', 'final', 'missing_fills'));

-- Backfill existing data: copy entry_credit to entry_credit_dollars
UPDATE public.trades
SET entry_credit_dollars = entry_credit
WHERE entry_credit IS NOT NULL AND entry_credit_dollars IS NULL;

-- Backfill existing data: copy exit_debit to exit_debit_dollars
UPDATE public.trades
SET exit_debit_dollars = exit_debit
WHERE exit_debit IS NOT NULL AND exit_debit_dollars IS NULL;

-- Backfill pnl_status based on existing state
UPDATE public.trades
SET pnl_status = CASE
  WHEN close_status != 'filled' THEN 'pending'
  WHEN close_status IS NULL THEN 'pending'
  WHEN pnl IS NOT NULL AND needs_reconcile = false THEN 'computed'
  WHEN needs_reconcile = true THEN 'missing_fills'
  ELSE 'pending'
END
WHERE pnl_status IS NULL OR pnl_status = 'pending';

-- Set pnl_computed_at for already-computed trades
UPDATE public.trades
SET pnl_computed_at = COALESCE(close_filled_at, exit_time, NOW())
WHERE pnl_status = 'computed' AND pnl_computed_at IS NULL;

-- Create index for efficient queries on pnl_status
CREATE INDEX IF NOT EXISTS idx_trades_pnl_status ON public.trades(pnl_status);

COMMENT ON COLUMN public.trades.pnl_status IS 'P&L computation status: pending (awaiting close), computed (calculated from fills), final (locked), missing_fills (incomplete data)';
COMMENT ON COLUMN public.trades.exit_debit_dollars IS 'Exit debit in dollars captured from actual fill prices (immutable once set)';
COMMENT ON COLUMN public.trades.entry_credit_dollars IS 'Entry credit in dollars captured from actual fill prices (immutable once set)';
COMMENT ON COLUMN public.trades.pnl_computed_at IS 'Timestamp when P&L was computed from fills';
