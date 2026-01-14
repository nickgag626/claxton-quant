-- Add 'critical_auto_reconcile' to the event_type check constraint for strategy_evaluations
-- This event type is used when the bot automatically bails out of a partial fill

-- First, we need to drop the existing check constraint (if it exists) and add a new one
-- Since we're using an enum-like column, we'll update it to allow the new event type

-- The event_type column appears to be a text column with no explicit constraint
-- Let's verify the current structure and add a comment documenting valid types
COMMENT ON COLUMN strategy_evaluations.event_type IS 'Valid types: evaluation, entry_attempt, entry_submitted, entry_filled, exit_attempt, exit_filled, exit_rejected, exit_blocked, critical_auto_reconcile';