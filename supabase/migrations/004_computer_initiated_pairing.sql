-- Computer-initiated pairing: a computer connector creates the code and the phone approves it.
alter table public.device_enrollments
  add column if not exists approved_at timestamptz;

create index if not exists device_enrollments_pending_approval_idx
  on public.device_enrollments(expires_at)
  where consumed_at is null;

comment on column public.device_enrollments.approved_at is
  'Set only by the authenticated account owner when approving a computer-generated pairing code.';
