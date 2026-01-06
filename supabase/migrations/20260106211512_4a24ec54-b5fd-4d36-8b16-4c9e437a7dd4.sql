-- Create trades journal table
CREATE TABLE public.trades (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol TEXT NOT NULL,
  underlying TEXT NOT NULL,
  strategy_name TEXT,
  strategy_type TEXT,
  quantity INTEGER NOT NULL,
  entry_time TIMESTAMP WITH TIME ZONE NOT NULL,
  exit_time TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  entry_price DECIMAL(12, 4) NOT NULL,
  exit_price DECIMAL(12, 4) NOT NULL,
  entry_credit DECIMAL(12, 2),
  exit_debit DECIMAL(12, 2),
  pnl DECIMAL(12, 2) NOT NULL,
  pnl_percent DECIMAL(8, 2),
  exit_reason TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;

-- For now, allow all operations (can add auth later)
CREATE POLICY "Allow all operations on trades" 
ON public.trades 
FOR ALL 
USING (true)
WITH CHECK (true);

-- Create index for faster queries
CREATE INDEX idx_trades_exit_time ON public.trades(exit_time DESC);
CREATE INDEX idx_trades_strategy_name ON public.trades(strategy_name);
CREATE INDEX idx_trades_underlying ON public.trades(underlying);

-- Enable realtime for trades table
ALTER PUBLICATION supabase_realtime ADD TABLE public.trades;