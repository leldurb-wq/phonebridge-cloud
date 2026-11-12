-- Phone Bridge multi-user foundation.
-- Run in Supabase SQL Editor only after reviewing the project settings.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  object_path text not null unique,
  original_name text not null,
  mime_type text,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  folder text not null default '',
  is_favorite boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists user_files_user_created_idx on public.user_files(user_id, created_at desc);

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Untitled note' check (char_length(title) <= 100),
  body text not null default '' check (char_length(body) <= 50000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists notes_user_updated_idx on public.notes(user_id, updated_at desc);

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  device_type text not null default 'browser',
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists devices_user_idx on public.devices(user_id);

create table if not exists public.security_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  device_label text,
  created_at timestamptz not null default now()
);
create index if not exists security_events_user_created_idx on public.security_events(user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.user_files enable row level security;
alter table public.notes enable row level security;
alter table public.devices enable row level security;
alter table public.security_events enable row level security;

drop policy if exists "profile owner read" on public.profiles;
create policy "profile owner read" on public.profiles for select to authenticated using (id = (select auth.uid()));
drop policy if exists "profile owner insert" on public.profiles;
create policy "profile owner insert" on public.profiles for insert to authenticated with check (id = (select auth.uid()));
drop policy if exists "profile owner update" on public.profiles;
create policy "profile owner update" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists "files owner all" on public.user_files;
create policy "files owner all" on public.user_files for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "notes owner all" on public.notes;
create policy "notes owner all" on public.notes for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "devices owner all" on public.devices;
create policy "devices owner all" on public.devices for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "security owner read" on public.security_events;
create policy "security owner read" on public.security_events for select to authenticated using (user_id = (select auth.uid()));

-- Private object storage. Each user's objects must live under their auth UUID.
insert into storage.buckets (id, name, public, file_size_limit)
values ('user-files','user-files',false,262144000)
on conflict (id) do update set public=false, file_size_limit=262144000;

drop policy if exists "user files read own" on storage.objects;
create policy "user files read own" on storage.objects for select to authenticated
using (bucket_id='user-files' and (storage.foldername(name))[1]=(select auth.uid())::text);
drop policy if exists "user files insert own" on storage.objects;
create policy "user files insert own" on storage.objects for insert to authenticated
with check (bucket_id='user-files' and (storage.foldername(name))[1]=(select auth.uid())::text);
drop policy if exists "user files update own" on storage.objects;
create policy "user files update own" on storage.objects for update to authenticated
using (bucket_id='user-files' and (storage.foldername(name))[1]=(select auth.uid())::text)
with check (bucket_id='user-files' and (storage.foldername(name))[1]=(select auth.uid())::text);
drop policy if exists "user files delete own" on storage.objects;
create policy "user files delete own" on storage.objects for delete to authenticated
using (bucket_id='user-files' and (storage.foldername(name))[1]=(select auth.uid())::text);

-- Create a profile automatically for each newly registered account.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path=public
as $$
begin
  insert into public.profiles(id,display_name)
  values(new.id, coalesce(new.raw_user_meta_data->>'name',''));
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();
