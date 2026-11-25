-- Resumable phone-to-computer transfers through private, short-lived cloud chunks.
create table if not exists public.phone_transfers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  file_name text not null,
  mime_type text not null default 'application/octet-stream',
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 2147483648),
  chunk_size integer not null check (chunk_size = 8388608),
  chunk_count integer not null check (chunk_count between 1 and 256),
  status text not null default 'uploading' check (status in ('uploading','queued','receiving','completed','failed','cancelled')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists phone_transfers_owner_created_idx on public.phone_transfers(user_id, created_at desc);
create index if not exists phone_transfers_device_queue_idx on public.phone_transfers(device_id, status, created_at);
create table if not exists public.phone_transfer_chunks (
  transfer_id uuid not null references public.phone_transfers(id) on delete cascade,
  chunk_index integer not null check (chunk_index between 0 and 255),
  object_path text not null unique,
  size_bytes integer not null check (size_bytes between 1 and 8388608),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  primary key (transfer_id, chunk_index)
);
alter table public.phone_transfers enable row level security;
alter table public.phone_transfer_chunks enable row level security;
revoke all on public.phone_transfers from anon, authenticated;
revoke all on public.phone_transfer_chunks from anon, authenticated;
grant all on public.phone_transfers, public.phone_transfer_chunks to service_role;
insert into storage.buckets (id, name, public, file_size_limit)
values ('transfer-chunks','transfer-chunks',false,16777216)
on conflict (id) do update set public=false, file_size_limit=16777216;
