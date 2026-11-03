-- Privacy-safe browser error telemetry. Only service-role code may read/write these tables.
create table if not exists public.site_error_events (
  id bigint generated always as identity primary key,
  category text not null check (category in ('form_submit','checkout','upload','script_error','promise_rejection')),
  area text not null check (area in ('contact','cart','checkout','shop','other')),
  created_at timestamptz not null default now()
);
create index if not exists site_error_events_category_time_idx
  on public.site_error_events(category, created_at desc);
alter table public.site_error_events enable row level security;
revoke all on public.site_error_events from anon, authenticated;

create table if not exists public.site_alert_locks (
  category text not null check (category in ('form_submit','checkout','upload','script_error','promise_rejection')),
  alert_day date not null default (now() at time zone 'UTC')::date,
  created_at timestamptz not null default now(),
  primary key(category,alert_day)
);
alter table public.site_alert_locks enable row level security;
revoke all on public.site_alert_locks from anon, authenticated;
