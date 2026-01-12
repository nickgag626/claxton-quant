-- Add new columns for proper fills-based P&L tracking
ALTER TABLE public.trades
ADD COLUMN IF NOT EXISTS open_side text,
ADD COLUMN IF NOT EXISTS close_side text,
ADD COLUMN IF NOT EXISTS open_order_id text,
ADD COLUMN IF NOT EXISTS close_order_id text,
ADD COLUMN IF NOT EXISTS fees numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS multiplier integer DEFAULT 100,
ADD COLUMN IF NOT EXISTS pnl_formula text;

-- Create unique constraint to prevent duplicate closes
-- Using symbol + close_order_id as the unique key
CREATE UNIQUE INDEX IF NOT EXISTS trades_symbol_close_order_id_unique 
ON public.trades (symbol, close_order_id) 
WHERE close_order_id IS NOT NULL;

-- Add index for faster lookups by exit_time for deduplication
CREATE INDEX IF NOT EXISTS trades_exit_time_symbol_idx ON public.trades (exit_time, symbol);

-- Clean up duplicates: keep only the earliest close per symbol per 2-minute window for today
WITH duplicates AS (
  SELECT 
    id,
    symbol,
    exit_time,
    ROW_NUMBER() OVER (
      PARTITION BY symbol, 
        DATE_TRUNC('minute', exit_time) - (EXTRACT(MINUTE FROM exit_time)::int % 2) * INTERVAL '1 minute'
      ORDER BY exit_time ASC
    ) as rn
  FROM public.trades
  WHERE exit_time >= CURRENT_DATE
)
DELETE FROM public.trades
WHERE id IN (
  SELECT id FROM duplicates WHERE rn > 1
);