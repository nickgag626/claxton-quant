-- Create strategy_evaluations table for audit trail
CREATE TABLE public.strategy_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id uuid NOT NULL REFERENCES public.strategies(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  underlying text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('evaluation', 'entry_attempt', 'entry_submitted', 'entry_filled', 'exit_attempt', 'exit_filled', 'exit_rejected')),
  decision text NOT NULL CHECK (decision IN ('PASS', 'FAIL', 'OPEN', 'SKIP', 'CLOSE', 'HOLD')),
  reason text,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  inputs_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  gates_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  proposed_order_json jsonb,
  trade_group_id uuid,
  client_request_id text
);

-- Create indexes for efficient queries
CREATE INDEX idx_strategy_evaluations_strategy_created ON public.strategy_evaluations(strategy_id, created_at DESC);
CREATE INDEX idx_strategy_evaluations_trade_group ON public.strategy_evaluations(trade_group_id) WHERE trade_group_id IS NOT NULL;
CREATE INDEX idx_strategy_evaluations_event_type ON public.strategy_evaluations(event_type);

-- Enable RLS
ALTER TABLE public.strategy_evaluations ENABLE ROW LEVEL SECURITY;

-- Create RLS policy matching existing patterns (allow all for now - matches strategies/trades)
CREATE POLICY "Allow all on strategy_evaluations" 
ON public.strategy_evaluations 
FOR ALL 
USING (true) 
WITH CHECK (true);

-- Enable realtime for this table
ALTER PUBLICATION supabase_realtime ADD TABLE public.strategy_evaluations;