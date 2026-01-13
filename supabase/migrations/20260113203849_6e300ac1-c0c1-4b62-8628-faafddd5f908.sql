-- Add per-leg quantity metadata to support deterministic grouping/splitting for stacked entries
ALTER TABLE public.position_group_map
ADD COLUMN IF NOT EXISTS leg_qty integer NOT NULL DEFAULT 1;

-- Optional: store the order-side for audit/debug (buy_to_open / sell_to_open)
ALTER TABLE public.position_group_map
ADD COLUMN IF NOT EXISTS leg_side text;

-- Speed up enrichment lookups + deterministic allocation ordering
CREATE INDEX IF NOT EXISTS idx_position_group_map_symbol_created_at
ON public.position_group_map (symbol, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_position_group_map_symbol_order
ON public.position_group_map (symbol, open_order_id);