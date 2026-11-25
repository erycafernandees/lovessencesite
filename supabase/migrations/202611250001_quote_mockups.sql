alter table public.attachments add column quote_id uuid references public.quotes(id) on delete cascade;
create index attachments_quote_id_idx on public.attachments(quote_id) where quote_id is not null;
alter table public.attachments add constraint quote_mockup_project_required check (quote_id is null or (project_request_id is not null and order_id is null));
