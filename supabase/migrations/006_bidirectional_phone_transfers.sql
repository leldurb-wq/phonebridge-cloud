-- Bidirectional PhoneBridge transfers and authenticated browser-client presence.
alter table public.phone_transfers
  add column if not exists direction text not null default 'phone_to_pc'
    check (direction in ('phone_to_pc','pc_to_phone')),
  add column if not exists target_client_id uuid;

create table if not exists public.phone_transfer_clients (
  id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_type text not null check (device_type in ('phone','computer')),
  label text not null check (char_length(label) between 1 and 80),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (user_id,id)
);
create index if not exists phone_transfer_clients_owner_seen_idx
  on public.phone_transfer_clients(user_id,device_type,last_seen_at desc);

alter table public.phone_transfer_clients enable row level security;
revoke all on public.phone_transfer_clients from anon, authenticated;
grant all on public.phone_transfer_clients to service_role;

create index if not exists phone_transfers_target_inbox_idx
  on public.phone_transfers(user_id,target_client_id,status,created_at desc);
