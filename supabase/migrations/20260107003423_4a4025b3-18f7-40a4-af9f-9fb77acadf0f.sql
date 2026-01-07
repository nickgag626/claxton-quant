-- Add trade_group_id to group multi-leg trades together (e.g., spreads, iron condors)
ALTER TABLE public.trades 
ADD COLUMN trade_group_id uuid DEFAULT NULL;

-- Add index for efficient grouping queries
CREATE INDEX idx_trades_group_id ON public.trades(trade_group_id) WHERE trade_group_id IS NOT NULL;