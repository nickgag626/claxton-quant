-- Add needs_reconcile flag for legacy rows
ALTER TABLE public.trades
ADD COLUMN IF NOT EXISTS needs_reconcile boolean DEFAULT false;

-- Mark existing rows that are missing key audit fields as needing reconciliation
UPDATE public.trades
SET needs_reconcile = true
WHERE open_side IS NULL OR close_order_id IS NULL;