-- Add max_condors_per_expiry setting for multi-condor stacking
ALTER TABLE public.settings 
ADD COLUMN IF NOT EXISTS max_condors_per_expiry integer NOT NULL DEFAULT 3;