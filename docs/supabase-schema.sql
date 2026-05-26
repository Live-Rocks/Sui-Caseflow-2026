create table if not exists public.snapshot_records (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  seed_address text not null,
  quilt_id text not null,
  report_url text not null,
  snapshot_url text not null,
  case_memory_url text not null,
  snapshot_hash text not null,
  case_memory_hash text not null,
  visible_node_count integer not null default 0,
  visible_flow_count integer not null default 0,
  tx_count integer not null default 0,
  created_at_ms bigint not null,
  uploaded_at timestamptz not null default now()
);

create index if not exists snapshot_records_wallet_uploaded_idx
  on public.snapshot_records (wallet_address, uploaded_at desc);
