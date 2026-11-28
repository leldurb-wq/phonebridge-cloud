-- PhoneBridge workspace durability: folders, sync manifests/history, and note versions.
create table if not exists public.drive_folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now(),
  unique(user_id,name)
);
create index if not exists drive_folders_user_idx on public.drive_folders(user_id,name);

create table if not exists public.sync_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  relative_path text not null check (char_length(relative_path) between 1 and 500),
  file_id uuid not null references public.user_files(id) on delete cascade,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  source_mtime bigint not null default 0,
  content_sha256 text not null,
  updated_at timestamptz not null default now(),
  unique(user_id,relative_path)
);
create index if not exists sync_items_user_updated_idx on public.sync_items(user_id,updated_at desc);

create table if not exists public.sync_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  relative_path text not null,
  file_id uuid references public.user_files(id) on delete set null,
  size_bytes bigint not null default 0,
  source_mtime bigint not null default 0,
  content_sha256 text not null,
  saved_at timestamptz not null default now()
);
create index if not exists sync_history_user_saved_idx on public.sync_history(user_id,saved_at desc);

create table if not exists public.note_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id uuid not null references public.notes(id) on delete cascade,
  title text not null default 'Untitled note',
  body text not null default '',
  saved_at timestamptz not null default now()
);
create index if not exists note_versions_note_saved_idx on public.note_versions(user_id,note_id,saved_at desc);

alter table public.drive_folders enable row level security;
alter table public.sync_items enable row level security;
alter table public.sync_history enable row level security;
alter table public.note_versions enable row level security;

revoke all on public.drive_folders,public.sync_items,public.sync_history,public.note_versions from anon,authenticated;
grant all on public.drive_folders,public.sync_items,public.sync_history,public.note_versions to service_role;
