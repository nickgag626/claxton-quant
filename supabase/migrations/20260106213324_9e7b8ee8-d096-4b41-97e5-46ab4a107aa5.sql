-- Create strategies table
CREATE TABLE public.strategies (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  underlying TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  max_positions INTEGER NOT NULL DEFAULT 1,
  position_size INTEGER NOT NULL DEFAULT 1,
  entry_conditions JSONB NOT NULL DEFAULT '{}',
  exit_conditions JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create settings table (single row for global settings)
CREATE TABLE public.settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  max_daily_loss NUMERIC NOT NULL DEFAULT 1000,
  max_positions INTEGER NOT NULL DEFAULT 5,
  max_bid_ask_spread_percent NUMERIC NOT NULL DEFAULT 5,
  zero_dte_close_buffer_minutes INTEGER NOT NULL DEFAULT 30,
  fill_price_buffer_percent NUMERIC NOT NULL DEFAULT 2,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.strategies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

-- Allow all operations (single user, no auth)
CREATE POLICY "Allow all on strategies" ON public.strategies FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on settings" ON public.settings FOR ALL USING (true) WITH CHECK (true);

-- Insert default settings row
INSERT INTO public.settings (max_daily_loss, max_positions, max_bid_ask_spread_percent, zero_dte_close_buffer_minutes, fill_price_buffer_percent)
VALUES (1000, 5, 5, 30, 2);