-- Add leg_role to position_group_map (exit monitor source of truth)
ALTER TABLE IF EXISTS public.position_group_map
  ADD COLUMN IF NOT EXISTS leg_role text;

CREATE INDEX IF NOT EXISTS position_group_map_trade_group_id_leg_role_idx
  ON public.position_group_map (trade_group_id, leg_role);

CREATE INDEX IF NOT EXISTS position_group_map_leg_role_idx
  ON public.position_group_map (leg_role);

-- Add leg_role to trades table (one row per leg)
ALTER TABLE IF EXISTS public.trades
  ADD COLUMN IF NOT EXISTS leg_role text;

CREATE INDEX IF NOT EXISTS trades_trade_group_id_leg_role_idx
  ON public.trades (trade_group_id, leg_role);

CREATE INDEX IF NOT EXISTS trades_leg_role_idx
  ON public.trades (leg_role);