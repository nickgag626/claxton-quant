-- Migration: Add UNIQUE constraint to options_cache for upsert support
-- Fixes: "there is no unique or exclusion constraint matching the ON CONFLICT specification"

-- Drop the existing regular index (if it exists)
DROP INDEX IF EXISTS idx_options_cache_lookup;

-- Create a UNIQUE index on the same columns
-- This allows onConflict: 'underlying,cache_type,expiration' to work correctly
CREATE UNIQUE INDEX IF NOT EXISTS idx_options_cache_unique
ON public.options_cache(underlying, cache_type, expiration);

-- Add comment explaining the index purpose
COMMENT ON INDEX idx_options_cache_unique IS 'UNIQUE constraint for upsert operations on options_cache';
