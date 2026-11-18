-- PhoneBridge broker RPCs. Review before deployment.
-- Only the trusted server-side service_role may execute these functions.
create or replace function public.phonebridge_claim_device_command(
  p_device_id uuid,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_command public.device_commands;
begin
  if not exists (
    select 1 from public.device_agents a
    where a.device_id = p_device_id
      and a.token_hash = p_token_hash
      and a.enabled = true
  ) then
    raise exception 'device authentication failed' using errcode = '28000';
  end if;

  update public.device_agents
    set last_seen_at = now()
    where device_id = p_device_id and enabled = true;

  select * into v_command
    from public.device_commands
    where device_id = p_device_id
      and status = 'queued'
      and expires_at > now()
    order by created_at asc
    limit 1
    for update skip locked;

  if not found then
    return null;
  end if;

  update public.device_commands
    set status = 'claimed', claimed_at = now()
    where id = v_command.id
    returning * into v_command;

  return jsonb_build_object(
    'id', v_command.id,
    'action', v_command.action,
    'payload', v_command.payload,
    'expiresAt', v_command.expires_at
  );
end;
$$;

create or replace function public.phonebridge_complete_device_command(
  p_device_id uuid,
  p_token_hash text,
  p_command_id uuid,
  p_success boolean,
  p_result jsonb default null,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
begin
  if not exists (
    select 1 from public.device_agents a
    where a.device_id = p_device_id
      and a.token_hash = p_token_hash
      and a.enabled = true
  ) then
    raise exception 'device authentication failed' using errcode = '28000';
  end if;

  if p_result is not null and jsonb_typeof(p_result) <> 'object' then
    raise exception 'result must be a JSON object' using errcode = '22023';
  end if;

  update public.device_commands
    set status = case when p_success then 'completed' else 'failed' end,
        result = case when p_success then coalesce(p_result, '{}'::jsonb) else null end,
        error_message = case when p_success then null else left(coalesce(p_error, 'Command failed.'), 500) end,
        completed_at = now()
    where id = p_command_id
      and device_id = p_device_id
      and status = 'claimed'
      and claimed_at > now() - interval '3 minutes';

  get diagnostics v_updated = row_count;
  update public.device_agents set last_seen_at = now()
    where device_id = p_device_id and enabled = true;
  return v_updated = 1;
end;
$$;

revoke all on function public.phonebridge_claim_device_command(uuid, text) from public, anon, authenticated;
revoke all on function public.phonebridge_complete_device_command(uuid, text, uuid, boolean, jsonb, text) from public, anon, authenticated;
grant execute on function public.phonebridge_claim_device_command(uuid, text) to service_role;
grant execute on function public.phonebridge_complete_device_command(uuid, text, uuid, boolean, jsonb, text) to service_role;
