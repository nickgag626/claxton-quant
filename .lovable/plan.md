

## Create MCP Signals Table

This plan will create a new `mcp_signals` table in your database to store trading signals with realtime capabilities.

### Table Structure

The table will include the following columns:

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key, auto-generated |
| `created_at` | TIMESTAMPTZ | Timestamp, defaults to now() |
| `symbol` | TEXT | Trading symbol (e.g., SPY, QQQ) |
| `signal_type` | TEXT | Type of signal |
| `composite_score` | FLOAT | Overall signal score |
| `iv_rank` | FLOAT | Implied volatility rank |
| `rsi_14` | FLOAT | 14-period RSI value |
| `trend` | TEXT | Market trend direction |
| `strategy` | TEXT | Recommended strategy |
| `expiration` | TEXT | Options expiration date |
| `short_strike` | FLOAT | Short strike price |
| `long_strike` | FLOAT | Long strike price |
| `credit` | FLOAT | Credit received |
| `max_loss` | FLOAT | Maximum potential loss |
| `prob_profit` | FLOAT | Probability of profit |
| `risk_reward` | FLOAT | Risk/reward ratio |
| `vix` | FLOAT | VIX level at signal time |
| `market_regime` | TEXT | Current market regime |
| `acted_on` | BOOLEAN | Whether signal was acted upon |
| `action_result` | TEXT | Result of action taken |
| `details` | JSONB | Additional flexible data |

### Implementation Steps

1. **Create the table** using the provided SQL schema
2. **Enable realtime** so you can subscribe to new signals in real-time
3. **Add RLS policy** - Since your existing tables use permissive "allow all" policies, I'll add a matching policy for consistency

### SQL to Execute

```sql
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
```

### Security Note

The RLS policy matches your existing tables (open access). If you later need to restrict access to authenticated users or specific roles, we can update the policy.

