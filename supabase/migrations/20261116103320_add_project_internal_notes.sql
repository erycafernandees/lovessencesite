-- Aplicada ao projeto Love Essences em 2026-11-16.
alter table public.project_requests add column if not exists admin_notes text;
comment on column public.project_requests.admin_notes is 'Notas internas da equipa, nunca apresentadas ao cliente.';
