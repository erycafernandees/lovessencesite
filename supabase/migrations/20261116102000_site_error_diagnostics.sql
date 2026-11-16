alter table public.site_error_events
  add column if not exists page_path text,
  add column if not exists error_message text,
  add column if not exists script_location text;
