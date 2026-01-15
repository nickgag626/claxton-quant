-- Add exit_debit column if not exists (for storing net group exit debit on multi-leg orders)
ALTER TABLE trades 
ADD COLUMN IF NOT EXISTS exit_debit DECIMAL(10, 4);

COMMENT ON COLUMN trades.exit_debit IS 'Net debit paid to close the entire group (for multi-leg orders)';