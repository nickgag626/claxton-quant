-- Add close lifecycle status fields to trades table
ALTER TABLE public.trades 
ADD COLUMN IF NOT EXISTS close_status text DEFAULT 'submitted' CHECK (close_status IN ('submitted', 'filled', 'rejected', 'canceled', 'expired')),
ADD COLUMN IF NOT EXISTS close_submitted_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS close_filled_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS close_reject_reason text,
ADD COLUMN IF NOT EXISTS close_avg_fill_price numeric,
ADD COLUMN IF NOT EXISTS close_filled_qty integer;

-- Update existing verified trades to have close_status = 'filled'
UPDATE public.trades 
SET close_status = 'filled', 
    close_filled_at = exit_time
WHERE needs_reconcile = false AND pnl IS NOT NULL AND close_order_id IS NOT NULL;

-- Update existing unverified trades to have close_status = 'submitted' 
UPDATE public.trades 
SET close_status = 'submitted'
WHERE needs_reconcile = true OR pnl IS NULL;

-- Create index for efficient querying of pending closes
CREATE INDEX IF NOT EXISTS idx_trades_close_status ON public.trades(close_status) WHERE close_status IN ('submitted', 'pending');