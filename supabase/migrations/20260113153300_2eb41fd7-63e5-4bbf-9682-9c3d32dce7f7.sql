-- Allow pending closes to be recorded without guessing fills
-- (Tradier 'ok' != filled, so pnl/exit_price must be nullable)

ALTER TABLE public.trades
  ALTER COLUMN pnl DROP NOT NULL;

ALTER TABLE public.trades
  ALTER COLUMN exit_price DROP NOT NULL;
