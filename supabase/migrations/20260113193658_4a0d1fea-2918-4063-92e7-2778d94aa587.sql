-- Add 'exit_blocked' to the allowed event types for strategy_evaluations
ALTER TABLE public.strategy_evaluations 
DROP CONSTRAINT strategy_evaluations_event_type_check;

ALTER TABLE public.strategy_evaluations 
ADD CONSTRAINT strategy_evaluations_event_type_check 
CHECK (event_type = ANY (ARRAY['evaluation'::text, 'entry_attempt'::text, 'entry_submitted'::text, 'entry_filled'::text, 'exit_attempt'::text, 'exit_filled'::text, 'exit_rejected'::text, 'exit_blocked'::text]));