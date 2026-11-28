-- Store the real identity and hardware profile reported by each paired computer.
alter table public.devices
  add column if not exists device_info jsonb not null default '{}'::jsonb;

comment on column public.devices.device_info is
  'Sanitized computer-reported model, OS, processor, memory and graphics details. Never contains user files or personal account data.';
