-- Add entry_credit column to position_group_map for storing actual fill-based entry credit
ALTER TABLE public.position_group_map
ADD COLUMN IF NOT EXISTS entry_credit NUMERIC;

COMMENT ON COLUMN public.position_group_map.entry_credit IS 'Net entry credit in DOLLARS computed from actual fill prices (same value for all legs in group)';