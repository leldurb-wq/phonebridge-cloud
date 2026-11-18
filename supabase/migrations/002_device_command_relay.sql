-- PhoneBridge remote-agent relay foundation.
-- Deployment candidate: review the complete relay flow and apply only after a backup.
-- Agent tokens are stored as SHA-256 hashes, never plaintext.

create table if not exists public.device_agents (
  device_id uuid primary key references public.devices(id) on delete cascade,
  token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'),
  enabled boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

-- Short-lived one-time enrollment tickets. Only the trusted cloud server can read or mutate these.
create table if not exists public.device_enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code_hash text not null unique check (code_hash ~ '^[a-f0-9]{64}$'),
  device_name text not null check (char_length(device_name) between 1 and 80),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint device_enrollments_expiry check (expires_at > created_at)
);
create index if not exists device_enrollments_user_created_idx on public.device_enrollments(user_id, created_at desc);
alter table public.device_enrollments enable row level security;
revoke all on public.device_enrollments from anon, authenticated;

create table if not exists public.device_commands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  action text not null check (action in (
    'system_info', 'screen_capture', 'list_files', 'read_file',
    'write_file', 'create_folder', 'launch_app'
  )),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','claimed','completed','failed','cancelled','expired')),
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 minutes'),
  claimed_at timestamptz,
  completed_at timestamptz,
  constraint device_commands_payload_object check (jsonb_typeof(payload) = 'object')
);
create index if not exists device_commands_queue_idx
  on public.device_commands(device_id, created_at)
  where status = 'queued';
create index if not exists device_commands_user_created_idx
  on public.device_commands(user_id, created_at desc);

alter table public.device_agents enable row level security;
alter table public.device_commands enable row level security;

-- Browser users can see and cancel only their own commands. Enqueueing is brokered by the cloud server; they cannot read agent tokens.
drop policy if exists "device commands owner read" on public.device_commands;
create policy "device commands owner read" on public.device_commands
  for select to authenticated using (user_id = (select auth.uid()));
-- Command insertion is brokered by the authenticated cloud server so it can
-- validate action payloads and require explicit approval for mutating actions.
drop policy if exists "device commands owner create" on public.device_commands;
drop policy if exists "device commands owner cancel" on public.device_commands;
create policy "device commands owner cancel" on public.device_commands
  for update to authenticated using (
    user_id = (select auth.uid()) and status = 'queued'
  ) with check (
    user_id = (select auth.uid()) and status = 'cancelled'
  );

-- Device-agent credentials and queue operations are deliberately inaccessible
-- through normal browser RLS. A trusted server-side broker will call narrowly
-- scoped SECURITY DEFINER functions after validating the device bearer token.
revoke all on public.device_agents from anon, authenticated;
revoke all on public.device_commands from anon;
-- Trusted server uses the service_role key; never expose it to browser code.
grant all on public.device_agents, public.device_enrollments, public.device_commands to service_role;

comment on table public.device_agents is
  'Server-managed device agent credentials; token_hash is SHA-256 of a high-entropy per-device bearer token.';
comment on table public.device_commands is
  'Owner-scoped remote action queue. Only allowlisted actions are accepted; agent polling/completion is broker-only.';
-- Browser owners may read their own commands and cancel only queued command status.
-- New commands are inserted by the authenticated server after validating the action.
revoke all on public.device_commands from anon, authenticated;
grant select on public.device_commands to authenticated;
grant update (status) on public.device_commands to authenticated;
