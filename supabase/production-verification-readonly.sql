-- PhoneBridge production schema verification (READ ONLY)
-- Run these SELECT statements in the existing PhoneBridge Supabase SQL Editor.
-- Do not run migrations from this file. No row data, secrets, tokens, or file
-- contents are selected. Compare results with migrations 001 -> 002 -> 003.
--
-- The filenames' Supabase migration versions are exactly 001, 002, and 003.
-- Run Query 1B only when Query 1A confirms the history relation exists.
-- Run Query 8B only when Query 8A confirms storage.buckets exists.
-- Each query is independent so a missing optional Supabase relation does not
-- prevent the remaining catalog checks from being run.

-- 1A. Migration history relation preflight.
select 'supabase_migrations.schema_migrations' as item,
       case when to_regclass('supabase_migrations.schema_migrations') is null
            then 'UNVERIFIED: migration history relation is absent'
            else 'PRESENT: run Query 1B'
       end as status;

-- 1B. Migration history: compares the filename prefixes with `version` only.
-- Do not infer application from schema objects if a version is absent.
with expected(version, migration_file) as (
  values ('001', '001_phone_bridge_multiuser.sql'),
         ('002', '002_device_command_relay.sql'),
         ('003', '003_device_relay_functions.sql')
)
select e.version as expected_version,
       e.migration_file,
       case when m.version is null then 'MISSING from recorded history'
            else 'CONFIRMED recorded'
       end as status
from expected e
left join supabase_migrations.schema_migrations m
  on m.version::text = e.version
order by e.version;

-- 2. Required columns, types and NOT NULL status from migrations 001 and 002.
with expected(table_name, column_name, data_type, required) as (
  values
    ('profiles','id','uuid',true), ('profiles','display_name','text',true), ('profiles','avatar_url','text',false), ('profiles','created_at','timestamp with time zone',true), ('profiles','updated_at','timestamp with time zone',true),
    ('user_files','id','uuid',true), ('user_files','user_id','uuid',true), ('user_files','object_path','text',true), ('user_files','original_name','text',true), ('user_files','mime_type','text',false), ('user_files','size_bytes','bigint',true), ('user_files','folder','text',true), ('user_files','is_favorite','boolean',true), ('user_files','created_at','timestamp with time zone',true), ('user_files','updated_at','timestamp with time zone',true),
    ('notes','id','uuid',true), ('notes','user_id','uuid',true), ('notes','title','text',true), ('notes','body','text',true), ('notes','created_at','timestamp with time zone',true), ('notes','updated_at','timestamp with time zone',true),
    ('devices','id','uuid',true), ('devices','user_id','uuid',true), ('devices','name','text',true), ('devices','device_type','text',true), ('devices','last_seen_at','timestamp with time zone',false), ('devices','created_at','timestamp with time zone',true),
    ('security_events','id','bigint',true), ('security_events','user_id','uuid',true), ('security_events','event_type','text',true), ('security_events','device_label','text',false), ('security_events','created_at','timestamp with time zone',true),
    ('device_agents','device_id','uuid',true), ('device_agents','token_hash','text',true), ('device_agents','enabled','boolean',true), ('device_agents','last_seen_at','timestamp with time zone',false), ('device_agents','created_at','timestamp with time zone',true),
    ('device_enrollments','id','uuid',true), ('device_enrollments','user_id','uuid',true), ('device_enrollments','code_hash','text',true), ('device_enrollments','device_name','text',true), ('device_enrollments','created_at','timestamp with time zone',true), ('device_enrollments','expires_at','timestamp with time zone',true), ('device_enrollments','consumed_at','timestamp with time zone',false),
    ('device_commands','id','uuid',true), ('device_commands','user_id','uuid',true), ('device_commands','device_id','uuid',true), ('device_commands','action','text',true), ('device_commands','payload','jsonb',true), ('device_commands','status','text',true), ('device_commands','result','jsonb',false), ('device_commands','error_message','text',false), ('device_commands','created_at','timestamp with time zone',true), ('device_commands','expires_at','timestamp with time zone',true), ('device_commands','claimed_at','timestamp with time zone',false), ('device_commands','completed_at','timestamp with time zone',false)
), actual as (
  select table_name, column_name, data_type, is_nullable
  from information_schema.columns where table_schema = 'public'
)
select e.table_name, e.column_name, e.data_type as expected_type,
       case when a.column_name is null then 'MISSING'
            when a.data_type <> e.data_type then 'DRIFT: type differs'
            when (a.is_nullable = 'NO') <> e.required then 'DRIFT: nullability differs'
            else 'CONFIRMED: type and nullability'
       end as status,
       a.data_type as actual_type, a.is_nullable as actual_nullable
from expected e
left join actual a using (table_name, column_name)
order by e.table_name, e.column_name;

-- 3. Required tables and row-level security flags. A missing row is MISSING.
with expected(table_schema, table_name) as (
  values ('public','profiles'), ('public','user_files'), ('public','notes'),
         ('public','devices'), ('public','security_events'), ('public','device_agents'),
         ('public','device_enrollments'), ('public','device_commands'), ('storage','objects')
)
select e.table_schema, e.table_name,
       case when c.oid is null then 'MISSING'
            when c.relrowsecurity then 'CONFIRMED: RLS enabled'
            else 'DRIFT: RLS disabled'
       end as status,
       coalesce(c.relforcerowsecurity, false) as force_rls
from expected e
left join pg_namespace n on n.nspname = e.table_schema
left join pg_class c on c.relnamespace = n.oid and c.relname = e.table_name
order by e.table_schema, e.table_name;

-- 4. Required indexes. Presence, owning table, validity and key-column order
-- are catalog-confirmable. DESC ordering and partial predicates are displayed
-- as advisory definitions for direct comparison with the migration SQL.
with expected(table_name, index_name) as (
  values ('user_files','user_files_user_created_idx'),
         ('notes','notes_user_updated_idx'), ('devices','devices_user_idx'),
         ('security_events','security_events_user_created_idx'),
         ('device_enrollments','device_enrollments_user_created_idx'),
         ('device_commands','device_commands_queue_idx'),
         ('device_commands','device_commands_user_created_idx')
)
select e.table_name, e.index_name,
       case when i.indexrelid is null then 'MISSING'
            when t.relname <> e.table_name then 'DRIFT: attached to another table'
            when not i.indisvalid or not i.indisready then 'DRIFT: index not valid/ready'
            else 'PRESENT: inspect definition (advisory)'
       end as status,
       case when i.indexrelid is not null then pg_get_indexdef(i.indexrelid) end as definition_for_review
from expected e
left join pg_namespace ins on ins.nspname = 'public'
left join pg_class idx on idx.relnamespace = ins.oid and idx.relname = e.index_name
left join pg_index i on i.indexrelid = idx.oid
left join pg_class t on t.oid = i.indrelid
order by e.table_name, e.index_name;

-- 5. Named primary/unique/check/foreign-key constraints from migrations 001/002.
-- Exact names and types are definitive; the server-rendered check expression
-- is shown for review rather than accepted by a loose text-fragment match.
with expected(table_name, constraint_name, constraint_type) as (
  values
    ('profiles','profiles_pkey','p'), ('profiles','profiles_id_fkey','f'),
    ('user_files','user_files_pkey','p'), ('user_files','user_files_object_path_key','u'), ('user_files','user_files_user_id_fkey','f'), ('user_files','user_files_size_bytes_check','c'),
    ('notes','notes_pkey','p'), ('notes','notes_user_id_fkey','f'), ('notes','notes_title_check','c'), ('notes','notes_body_check','c'),
    ('devices','devices_pkey','p'), ('devices','devices_user_id_fkey','f'),
    ('security_events','security_events_pkey','p'), ('security_events','security_events_user_id_fkey','f'),
    ('device_agents','device_agents_pkey','p'), ('device_agents','device_agents_device_id_fkey','f'), ('device_agents','device_agents_token_hash_check','c'),
    ('device_enrollments','device_enrollments_pkey','p'), ('device_enrollments','device_enrollments_user_id_fkey','f'), ('device_enrollments','device_enrollments_code_hash_key','u'), ('device_enrollments','device_enrollments_code_hash_check','c'), ('device_enrollments','device_enrollments_device_name_check','c'), ('device_enrollments','device_enrollments_expiry','c'),
    ('device_commands','device_commands_pkey','p'), ('device_commands','device_commands_user_id_fkey','f'), ('device_commands','device_commands_device_id_fkey','f'), ('device_commands','device_commands_action_check','c'), ('device_commands','device_commands_status_check','c'), ('device_commands','device_commands_payload_object','c')
)
select e.table_name, e.constraint_name,
       case when c.oid is null then 'MISSING'
            when c.contype <> e.constraint_type then 'DRIFT: constraint type differs'
            else 'CONFIRMED: name and type; compare definition'
       end as status,
       case when c.oid is not null then pg_get_constraintdef(c.oid, true) end as definition_for_review
from expected e
left join pg_namespace n on n.nspname = 'public'
left join pg_class t on t.relnamespace = n.oid and t.relname = e.table_name
left join pg_constraint c on c.conrelid = t.oid and c.conname = e.constraint_name
order by e.table_name, e.constraint_name;

-- 6. Expected public-table RLS policy names, commands, roles and expressions.
-- Names/commands/roles are definitive metadata. Compare USING/WITH CHECK with
-- migration text; expression text is intentionally not treated as a fragment test.
with expected(table_name, policy_name, command, role_name) as (
  values
    ('profiles','profile owner read','SELECT','authenticated'),
    ('profiles','profile owner insert','INSERT','authenticated'),
    ('profiles','profile owner update','UPDATE','authenticated'),
    ('user_files','files owner all','ALL','authenticated'),
    ('notes','notes owner all','ALL','authenticated'),
    ('devices','devices owner all','ALL','authenticated'),
    ('security_events','security owner read','SELECT','authenticated'),
    ('device_commands','device commands owner read','SELECT','authenticated'),
    ('device_commands','device commands owner cancel','UPDATE','authenticated')
)
select e.table_name, e.policy_name,
       case when p.policyname is null then 'MISSING'
            when p.cmd <> e.command or not (e.role_name::name = any(p.roles)) then 'DRIFT: command/role differs'
            else 'CONFIRMED: name, command and role; compare expressions'
       end as status,
       p.qual as using_expression, p.with_check as check_expression
from expected e
left join pg_policies p on p.schemaname = 'public'
  and p.tablename = e.table_name and p.policyname = e.policy_name
order by e.table_name, e.policy_name;

-- 7. Storage policy inventory (safe even if storage.objects has no policies).
-- Review the full expressions against migration 001 to confirm bucket and
-- first-folder ownership checks; names alone do not prove the policy is safe.
with expected(policy_name, command) as (
  values ('user files read own','SELECT'), ('user files insert own','INSERT'),
         ('user files update own','UPDATE'), ('user files delete own','DELETE')
)
select e.policy_name,
       case when p.policyname is null then 'MISSING'
            when p.cmd <> e.command or not ('authenticated'::name = any(p.roles)) then 'DRIFT: command/role differs'
            else 'PRESENT: compare full expression with migration 001'
       end as status,
       p.cmd, p.roles, p.qual as using_expression, p.with_check as check_expression
from expected e
left join pg_policies p on p.schemaname='storage' and p.tablename='objects'
  and p.policyname=e.policy_name
order by e.policy_name;

-- 8A. Storage bucket relation preflight.
select 'storage.buckets' as item,
       case when to_regclass('storage.buckets') is null
            then 'UNVERIFIED: storage.buckets relation is absent'
            else 'PRESENT: run Query 8B'
       end as status;

-- 8B. Bucket metadata. Run only if Query 8A reports PRESENT.
select b.id, b.name, b.public, b.file_size_limit,
       case when b.id is null then 'MISSING: user-files bucket'
            when b.public = false and b.file_size_limit = 262144000
            then 'CONFIRMED: private and expected 250 MiB limit'
            else 'DRIFT: compare private flag/limit with migration 001'
       end as status
from (select 1) seed
left join storage.buckets b on b.id = 'user-files';

-- 9. Required roles and grants. Missing roles are reported without calling
-- privilege functions with invalid OIDs. Table/column grants are definitive
-- for the current database role ACLs; effective privileges also include role
-- membership and are what has_*_privilege reports.
with expected(table_name, role_name, privilege_type) as (
  values ('device_agents','service_role','SELECT'),
         ('device_agents','service_role','INSERT'),
         ('device_agents','service_role','UPDATE'),
         ('device_agents','service_role','DELETE'),
         ('device_enrollments','service_role','SELECT'),
         ('device_enrollments','service_role','INSERT'),
         ('device_enrollments','service_role','UPDATE'),
         ('device_enrollments','service_role','DELETE'),
         ('device_commands','service_role','SELECT'),
         ('device_commands','service_role','INSERT'),
         ('device_commands','service_role','UPDATE'),
         ('device_commands','service_role','DELETE'),
         ('device_commands','authenticated','SELECT')
), checked as (
  select e.*, c.oid as table_oid, r.oid as role_oid,
         case when c.oid is not null and r.oid is not null
              then has_table_privilege(r.oid,c.oid,e.privilege_type)
              else null end as has_privilege
  from expected e
  left join pg_namespace n on n.nspname = 'public'
  left join pg_class c on c.relnamespace = n.oid and c.relname = e.table_name
  left join pg_roles r on r.rolname::text = e.role_name
)
select table_name, role_name, privilege_type,
       case when role_oid is null then 'UNVERIFIED: role missing'
            when table_oid is null then 'UNVERIFIED: table missing'
            when has_privilege then 'CONFIRMED: effective privilege granted'
            else 'MISSING: effective privilege'
       end as status
from checked
order by table_name, role_name, privilege_type;

-- 10. device_commands.status column update grant. The privilege function is
-- evaluated only after both the table and column are found.
with target as (
  select c.oid as table_oid, a.attnum, r.oid as role_oid
  from (select 1) seed
  left join pg_namespace n on n.nspname = 'public'
  left join pg_class c on c.relnamespace = n.oid and c.relname = 'device_commands'
  left join pg_attribute a on a.attrelid = c.oid and a.attname = 'status'
    and a.attnum > 0 and not a.attisdropped
  left join pg_roles r on r.rolname = 'authenticated'
), checked as (
  select *, case when table_oid is not null and attnum is not null and role_oid is not null
                 then has_column_privilege(role_oid,table_oid,attnum,'UPDATE')
                 else null end as can_update_status
  from target
)
select case when role_oid is null then 'UNVERIFIED: authenticated role missing'
            when table_oid is null then 'UNVERIFIED: device_commands table missing'
            when attnum is null then 'UNVERIFIED: device_commands.status column missing'
            when can_update_status then 'CONFIRMED: authenticated can update status column'
            else 'MISSING: authenticated status-column UPDATE privilege'
       end as status
from checked;

-- 11. RPC functions, security settings and EXECUTE privileges.
-- Migration 003 requires public, pg_temp for both broker RPCs. Production
-- hardening expects handle_new_user to use public, pg_temp as well (even
-- though the checked-in 001 source currently specifies public only).
with expected(function_name, argument_types, expected_search_path, expected_security_definer, service_role_execute) as (
  values ('handle_new_user','', 'search_path=public, pg_temp', true, false),
         ('phonebridge_claim_device_command','uuid, text', 'search_path=public, pg_temp', true, true),
         ('phonebridge_complete_device_command','uuid, text, uuid, boolean, jsonb, text', 'search_path=public, pg_temp', true, true)
), roles as (
  select (max(oid::bigint) filter (where rolname='service_role'))::oid as service_oid,
         (max(oid::bigint) filter (where rolname='anon'))::oid as anon_oid,
         (max(oid::bigint) filter (where rolname='authenticated'))::oid as authenticated_oid
  from pg_roles
), actual as (
  select p.oid, p.proname,
         oidvectortypes(p.proargtypes) as argument_types,
         p.prosecdef as security_definer,
         array_to_string(p.proconfig, ', ') as function_settings
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
), joined as (
  select e.*, a.oid, a.security_definer, a.function_settings, r.*,
         case when a.oid is not null and r.service_oid is not null then has_function_privilege(r.service_oid,a.oid,'EXECUTE') end as service_exec,
         case when a.oid is not null and r.anon_oid is not null then has_function_privilege(r.anon_oid,a.oid,'EXECUTE') end as anon_exec,
         case when a.oid is not null and r.authenticated_oid is not null then has_function_privilege(r.authenticated_oid,a.oid,'EXECUTE') end as authenticated_exec
  from expected e cross join roles r
  left join actual a on a.proname::text=e.function_name and a.argument_types=e.argument_types
)
select function_name, argument_types,
       case when oid is null then 'MISSING'
            when security_definer <> expected_security_definer then 'DRIFT: SECURITY DEFINER differs'
            when function_settings is distinct from expected_search_path then 'DRIFT: expected search_path differs'
            else 'CONFIRMED: function signature/security/search_path'
       end as function_status,
       case when service_role_execute and service_oid is null then 'UNVERIFIED: service_role missing'
            when service_role_execute and service_exec then 'CONFIRMED: service_role EXECUTE'
            when service_role_execute then 'MISSING: service_role EXECUTE'
            when service_oid is null then 'UNVERIFIED: service_role missing'
            when service_exec then 'ADVISORY: service_role has EXECUTE; compare intended grants'
            else 'CONFIRMED: service_role lacks EXECUTE'
       end as service_role_status,
       case when not service_role_execute then 'ADVISORY: trigger function; browser EXECUTE privilege is not an RPC access test'
            when anon_oid is null or authenticated_oid is null then 'UNVERIFIED: anon/authenticated role missing'
            when coalesce(anon_exec,false) or coalesce(authenticated_exec,false) then 'DRIFT: browser role can EXECUTE'
            else 'CONFIRMED: browser roles lack EXECUTE'
       end as browser_role_status,
       function_settings as actual_function_settings
from joined
order by function_name;

-- 12. Auth trigger existence and target function. Trigger name, event and
-- function binding are definitive; trigger body behavior is not re-executed.
with target as (
  select t.oid, t.tgname, t.tgenabled, p.proname, n.nspname as function_schema,
         (t.tgtype & 1) = 1 as is_row,
         (t.tgtype & 2) = 0 as fires_after,
         (t.tgtype & 4) = 4 as on_insert
  from pg_trigger t
  join pg_class c on c.oid=t.tgrelid
  join pg_namespace cn on cn.oid=c.relnamespace
  join pg_proc p on p.oid=t.tgfoid
  join pg_namespace n on n.oid=p.pronamespace
  where cn.nspname='auth' and c.relname='users'
    and not t.tgisinternal and t.tgname='on_auth_user_created'
)
select 'auth.users.on_auth_user_created' as item,
       case when oid is null then 'MISSING'
            when proname <> 'handle_new_user' or function_schema <> 'public' then 'DRIFT: wrong trigger function'
            when not is_row or not fires_after or not on_insert then 'DRIFT: expected AFTER INSERT FOR EACH ROW'
            when tgenabled not in ('O','A') then 'DRIFT: trigger not enabled for normal execution'
            else 'CONFIRMED: enabled AFTER INSERT row trigger'
       end as status
from (select 1) seed
left join target on true;

-- 13. pgcrypto extension presence (gen_random_uuid is also available in
-- modern PostgreSQL without this extension; this is an advisory migration check).
select case when exists (select 1 from pg_extension where extname='pgcrypto')
            then 'PRESENT: pgcrypto extension'
            else 'UNVERIFIED/ADVISORY: pgcrypto extension not listed'
       end as status;

-- Interpretation:
-- * CONFIRMED/MISSING/DRIFT are definitive only for the catalog property named.
-- * Query 1B confirms recorded migration history, not that later edits were
--   applied; absent history is UNVERIFIED, not proof the schema is absent.
-- * Index and constraint definitions and policy expressions must be compared
--   with the corresponding migration text; names or fragments alone are not proof.
-- * This script cannot prove RLS behavior using real users, ownership isolation,
--   worker authentication, live pairing, or file-operation correctness.
