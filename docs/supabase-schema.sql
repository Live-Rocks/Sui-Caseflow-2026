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
  uploaded_at timestamptz not null default now(),
  walrus_epochs integer,
  walrus_expires_at timestamptz
);

create index if not exists snapshot_records_wallet_uploaded_idx
  on public.snapshot_records (wallet_address, uploaded_at desc);

-- Estimated Walrus expiry metadata. Existing projects can run these ALTERs safely.
alter table public.snapshot_records add column if not exists walrus_epochs integer;
alter table public.snapshot_records add column if not exists walrus_expires_at timestamptz;

-- Backfill historical records. Old uploads used the project default of 5 Walrus epochs.
update public.snapshot_records
set walrus_epochs = 5
where walrus_epochs is null;

update public.snapshot_records
set walrus_expires_at = case
  when uploaded_at is not null then uploaded_at + (walrus_epochs * interval '1 day')
  when created_at_ms is not null and created_at_ms > 0 then to_timestamp(created_at_ms / 1000.0) + (walrus_epochs * interval '1 day')
  else now() - interval '1 day'
end
where walrus_expires_at is null;

-- Optional MemWal remember metadata. Existing projects can run these ALTERs safely.
alter table public.snapshot_records add column if not exists memwal_status text not null default 'skipped';
alter table public.snapshot_records add column if not exists memwal_namespace text;
alter table public.snapshot_records add column if not exists memwal_job_id text;
alter table public.snapshot_records add column if not exists memwal_blob_id text;
alter table public.snapshot_records add column if not exists memwal_error text;
alter table public.snapshot_records add column if not exists memwal_queued_at timestamptz;
alter table public.snapshot_records add column if not exists memwal_saved_at timestamptz;

create table if not exists public.analyst_profiles (
  wallet_address text primary key,
  xp_total integer not null default 0,
  level integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.xp_events (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  event_type text not null,
  xp_delta integer not null,
  action_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists xp_events_wallet_event_action_idx
  on public.xp_events (wallet_address, event_type, action_key);

create index if not exists xp_events_wallet_created_idx
  on public.xp_events (wallet_address, created_at desc);
