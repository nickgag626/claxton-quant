-- Create the mcp_signals table
CREATE TABLE mcp_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  symbol TEXT,
  signal_type TEXT,
  composite_score FLOAT,
  iv_rank FLOAT,
  rsi_14 FLOAT,
  trend TEXT,
  strategy TEXT,
  expiration TEXT,
  short_strike FLOAT,
  long_strike FLOAT,
  credit FLOAT,
  max_loss FLOAT,
  prob_profit FLOAT,
  risk_reward FLOAT,
  vix FLOAT,
  market_regime TEXT,
  acted_on BOOLEAN DEFAULT false,
  action_result TEXT,
  details JSONB
);

-- Enable RLS
ALTER TABLE mcp_signals ENABLE ROW LEVEL SECURITY;

-- Add permissive policy (matching your existing table patterns)
CREATE POLICY "Allow all on mcp_signals"
  ON mcp_signals
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE mcp_signals;