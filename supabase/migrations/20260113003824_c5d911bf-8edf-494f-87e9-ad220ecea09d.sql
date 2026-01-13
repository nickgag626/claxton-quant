-- Create options cache table for after-hours evaluation
CREATE TABLE public.options_cache (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  underlying text NOT NULL,
  expiration text,
  cache_type text NOT NULL CHECK (cache_type IN ('expirations', 'chain', 'quote')),
  data jsonb NOT NULL DEFAULT '{}',
  cached_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Index for fast lookups
CREATE INDEX idx_options_cache_lookup ON public.options_cache(underlying, cache_type, expiration);
CREATE INDEX idx_options_cache_expires ON public.options_cache(expires_at);

-- Enable RLS
ALTER TABLE public.options_cache ENABLE ROW LEVEL SECURITY;

-- Allow all operations (service role + anon for edge functions)
CREATE POLICY "Allow all on options_cache" ON public.options_cache FOR ALL USING (true) WITH CHECK (true);