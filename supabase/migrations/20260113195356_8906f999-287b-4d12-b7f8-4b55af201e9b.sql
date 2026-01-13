-- Map broker position symbols to deterministic entry groups (based on Tradier open order id)
create table if not exists public.position_group_map (
  id uuid primary key default gen_random_uuid(),
  trade_group_id uuid not null,
  open_order_id text not null,
  symbol text not null,
  underlying text not null,
  expiration text null,
  strategy_name text null,
  strategy_type text null,
  created_at timestamp with time zone not null default now(),
  constraint position_group_map_open_order_symbol_key unique (open_order_id, symbol)
);

create index if not exists idx_position_group_map_symbol on public.position_group_map (symbol);
create index if not exists idx_position_group_map_trade_group_id on public.position_group_map (trade_group_id);
create index if not exists idx_position_group_map_open_order_id on public.position_group_map (open_order_id);

alter table public.position_group_map enable row level security;

-- Keep consistent with current single-tenant dev posture (existing tables are open)
create policy "Allow all operations on position_group_map"
on public.position_group_map
for all
using (true)
with check (true);
