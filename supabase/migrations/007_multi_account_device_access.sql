-- Multi-account access to one physical PhoneBridge computer.
-- The computer keeps one device identity and one agent credential. Each approved
-- PhoneBridge account receives its own membership row; account data stays scoped
-- by user_id in the existing transfer, Drive, notes and file tables.

create table if not exists public.device_access (
  device_id uuid not null references public.devices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  created_at timestamptz not null default now(),
  primary key (device_id,user_id)
);

-- Preserve access for all existing device owners.
insert into public.device_access(device_id,user_id,role)
select id,user_id,'owner' from public.devices
on conflict (device_id,user_id) do nothing;

create index if not exists device_access_user_created_idx
  on public.device_access(user_id,created_at desc);
create index if not exists device_access_device_idx
  on public.device_access(device_id);

-- Enforce the ten-account ceiling in the database as well as in the API.
create or replace function public.phonebridge_enforce_device_access_limit()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  if not exists (
    select 1 from public.device_access
    where device_id=new.device_id and user_id=new.user_id
  ) and (
    select count(*) from public.device_access where device_id=new.device_id
  ) >= 10 then
    raise exception 'This computer already has ten authorized accounts.';
  end if;
  return new;
end;
$$;

drop trigger if exists phonebridge_device_access_limit on public.device_access;
create trigger phonebridge_device_access_limit
before insert on public.device_access
for each row execute function public.phonebridge_enforce_device_access_limit();

revoke all on function public.phonebridge_enforce_device_access_limit() from public, anon, authenticated;

alter table public.device_access enable row level security;
revoke all on public.device_access from anon, authenticated;
grant all on public.device_access to service_role;

comment on table public.device_access is
  'Per-account authorization to a shared physical PhoneBridge computer. One device supports at most ten active account memberships; all personal data remains owner-scoped.';
