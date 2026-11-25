-- PhoneBridge computer-generated pairing flow.
-- The Windows Agent requests a short-lived code; an authenticated phone claims
-- it, and the Agent receives its credential only after that account approval.

create table if not exists public.device_pairing_requests (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (code_hash ~ '^[a-f0-9]{64}$'),
  poll_token_hash text not null unique check (poll_token_hash ~ '^[a-f0-9]{64}$'),
  installation_id uuid not null,
  previous_device_id uuid,
  device_name text not null check (char_length(device_name) between 1 and 80),
  user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  approved_at timestamptz,
  consumed_at timestamptz,
  constraint device_pairing_requests_expiry check (expires_at > created_at),
  constraint device_pairing_requests_approval check (
    (user_id is null and approved_at is null) or
    (user_id is not null and approved_at is not null)
  )
);

create index if not exists device_pairing_requests_expiry_idx
  on public.device_pairing_requests(expires_at);
alter table public.device_pairing_requests enable row level security;
revoke all on public.device_pairing_requests from anon, authenticated;
grant all on public.device_pairing_requests to service_role;

create or replace function public.phonebridge_complete_pairing_request(
  p_request_id uuid,
  p_poll_token_hash text,
  p_agent_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.device_pairing_requests;
  v_device_id uuid;
  v_agent_id uuid;
  v_final_device_name text;
begin
  select * into v_request
    from public.device_pairing_requests
    where id = p_request_id
      and poll_token_hash = p_poll_token_hash
      and user_id is not null
      and approved_at is not null
      and consumed_at is null
      and expires_at > now()
    for update;

  if not found then
    return null;
  end if;
  if p_poll_token_hash !~ '^[a-f0-9]{64}$' or p_agent_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid pairing credential hash' using errcode = '22023';
  end if;

  if v_request.previous_device_id is not null then
    select id, name into v_device_id, v_final_device_name
      from public.devices
      where id = v_request.previous_device_id
        and user_id = v_request.user_id;
  end if;

  if v_device_id is null then
    insert into public.devices(user_id, name, device_type)
      values (v_request.user_id, v_request.device_name, 'windows_agent')
      returning id into v_device_id;
    v_final_device_name := v_request.device_name;
    insert into public.device_agents(device_id, token_hash, enabled)
      values (v_device_id, p_agent_token_hash, true);
  else
    update public.devices
      set device_type = 'windows_agent'
      where id = v_device_id and user_id = v_request.user_id;
    update public.device_agents
      set token_hash = p_agent_token_hash, enabled = true, last_seen_at = null
      where device_id = v_device_id
      returning device_id into v_agent_id;
    if v_agent_id is null then
      insert into public.device_agents(device_id, token_hash, enabled)
        values (v_device_id, p_agent_token_hash, true);
    end if;
  end if;

  update public.device_pairing_requests
    set consumed_at = now()
    where id = v_request.id;

  return jsonb_build_object('deviceId', v_device_id, 'deviceName', v_final_device_name);
end;
$$;

revoke all on function public.phonebridge_complete_pairing_request(uuid, text, text) from public, anon, authenticated;
grant execute on function public.phonebridge_complete_pairing_request(uuid, text, text) to service_role;

comment on table public.device_pairing_requests is
  'Short-lived pairing challenges. Codes and agent poll secrets are stored only as keyed hashes; only the authenticated account can approve a request.';
