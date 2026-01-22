-- Add missing P&L tracking columns to trades table
ALTER TABLE public.trades 
ADD COLUMN IF NOT EXISTS entry_credit_dollars numeric NULL,
ADD COLUMN IF NOT EXISTS exit_debit_dollars numeric NULL,
ADD COLUMN IF NOT EXISTS pnl_status text NULL DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS pnl_computed_at timestamptz NULL;

-- Add indexes to speed up journal queries
CREATE INDEX IF NOT EXISTS idx_trades_close_order_id ON public.trades(close_order_id);
CREATE INDEX IF NOT EXISTS idx_trades_trade_group_id ON public.trades(trade_group_id);
CREATE INDEX IF NOT EXISTS idx_trades_close_status_submitted ON public.trades(close_status, close_submitted_at);