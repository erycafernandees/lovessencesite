begin;

create extension if not exists pgcrypto with schema extensions;

create type public.order_source as enum ('catalog', 'custom_quote');
create type public.order_state as enum (
  'draft', 'awaiting_payment', 'confirmed', 'review', 'awaiting_details',
  'production', 'ready_to_ship', 'shipped', 'completed', 'cancelled'
);
create type public.payment_state as enum (
  'unpaid', 'processing', 'paid', 'failed', 'partially_refunded', 'refunded', 'cancelled'
);
create type public.payment_provider as enum ('stripe', 'mypos', 'manual');
create type public.project_state as enum (
  'draft', 'submitted', 'in_review', 'awaiting_details', 'quoted', 'approved',
  'payment_pending', 'paid', 'production', 'completed', 'declined', 'archived'
);
create type public.attachment_state as enum ('pending_upload', 'uploaded', 'verified', 'rejected');
create type public.quote_state as enum ('draft', 'sent', 'approved', 'expired', 'cancelled', 'paid');

create sequence public.order_number_seq start 1001;
create sequence public.project_number_seq start 101;

create or replace function public.next_order_number()
returns text language sql volatile set search_path = '' as $$
  select 'LE-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.order_number_seq')::text, 5, '0');
$$;

create or replace function public.next_project_number()
returns text language sql volatile set search_path = '' as $$
  select 'LP-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.project_number_seq')::text, 4, '0');
$$;

create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'manager' check (role in ('owner', 'manager', 'viewer')),
  display_name text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  category text not null,
  image_path text,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  code text not null unique,
  label text not null,
  unit_amount integer not null check (unit_amount >= 0),
  currency text not null default 'eur' check (currency = lower(currency) and char_length(currency) = 3),
  minimum_quantity integer not null default 1 check (minimum_quantity > 0),
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.product_addons (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  code text not null unique,
  label text not null,
  unit_amount integer not null check (unit_amount >= 0),
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.promotion_rules (
  id uuid primary key default gen_random_uuid(),
  code text unique,
  name text not null,
  stripe_promotion_code_id text,
  kind text not null check (kind in ('percentage', 'fixed')),
  amount integer not null check (amount > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default false,
  conditions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique default public.next_order_number(),
  source public.order_source not null default 'catalog',
  order_status public.order_state not null default 'draft',
  payment_status public.payment_state not null default 'unpaid',
  payment_provider public.payment_provider not null default 'stripe',
  currency text not null default 'eur' check (currency = lower(currency) and char_length(currency) = 3),
  subtotal_amount integer not null default 0 check (subtotal_amount >= 0),
  discount_amount integer not null default 0 check (discount_amount >= 0),
  shipping_amount integer not null default 0 check (shipping_amount >= 0),
  tax_amount integer not null default 0 check (tax_amount >= 0),
  total_amount integer not null default 0 check (total_amount >= 0),
  customer_name text,
  customer_email text,
  customer_phone text,
  shipping_address jsonb,
  billing_address jsonb,
  shipping_destination text not null default 'mainland',
  shipping_method text,
  notes text,
  access_token_hash text not null,
  access_token_expires_at timestamptz not null default (now() + interval '48 hours'),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  stripe_customer_id text,
  project_request_id uuid,
  promotion_snapshot jsonb,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id),
  variant_id uuid references public.product_variants(id),
  product_code text not null,
  variant_code text not null,
  name text not null,
  quantity integer not null check (quantity > 0),
  unit_amount integer not null check (unit_amount >= 0),
  line_amount integer not null check (line_amount >= 0),
  personalization jsonb not null default '{}'::jsonb,
  product_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.project_requests (
  id uuid primary key default gen_random_uuid(),
  project_number text not null unique default public.next_project_number(),
  status public.project_state not null default 'draft',
  customer_name text not null,
  customer_email text not null,
  customer_phone text,
  occasion text not null,
  project_type text not null,
  approximate_quantity text,
  event_date date,
  approximate_budget text,
  idea text not null,
  access_token_hash text not null,
  access_token_expires_at timestamptz not null default (now() + interval '30 days'),
  consent_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.orders
  add constraint orders_project_request_fk foreign key (project_request_id)
  references public.project_requests(id) on delete set null;

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  project_request_id uuid not null references public.project_requests(id) on delete cascade,
  version integer not null default 1 check (version > 0),
  status public.quote_state not null default 'draft',
  currency text not null default 'eur' check (currency = lower(currency) and char_length(currency) = 3),
  subtotal_amount integer not null default 0 check (subtotal_amount >= 0),
  discount_amount integer not null default 0 check (discount_amount >= 0),
  shipping_amount integer not null default 0 check (shipping_amount >= 0),
  total_amount integer not null default 0 check (total_amount >= 0),
  notes text,
  valid_until date,
  access_token_hash text,
  access_token_expires_at timestamptz,
  approved_at timestamptz,
  order_id uuid references public.orders(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_request_id, version)
);

create table public.quote_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  description text not null,
  quantity integer not null check (quantity > 0),
  unit_amount integer not null check (unit_amount >= 0),
  line_amount integer not null check (line_amount >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete cascade,
  order_item_id uuid references public.order_items(id) on delete cascade,
  project_request_id uuid references public.project_requests(id) on delete cascade,
  bucket_id text not null default 'private-references',
  object_path text not null unique,
  original_name text not null,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  sha256 text,
  status public.attachment_state not null default 'pending_upload',
  rejection_reason text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint attachment_owner check (
    (order_id is not null and project_request_id is null) or
    (order_id is null and order_item_id is null and project_request_id is not null)
  )
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  provider public.payment_provider not null default 'stripe',
  status public.payment_state not null default 'unpaid',
  currency text not null default 'eur',
  provider_checkout_id text,
  provider_payment_id text,
  provider_charge_id text,
  provider_balance_transaction_id text,
  gross_amount integer not null default 0,
  processing_fee_amount integer,
  net_amount integer,
  refunded_amount integer not null default 0,
  payment_method_type text,
  provider_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, provider_payment_id),
  unique(provider, provider_checkout_id)
);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete cascade,
  provider_refund_id text not null unique,
  amount integer not null check (amount > 0),
  status text not null,
  reason text,
  created_at timestamptz not null default now()
);

create table public.order_status_history (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  order_status public.order_state,
  payment_status public.payment_state,
  note text,
  actor_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.project_status_history (
  id bigint generated always as identity primary key,
  project_request_id uuid not null references public.project_requests(id) on delete cascade,
  status public.project_state not null,
  note text,
  actor_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.webhook_events (
  provider public.payment_provider not null,
  event_id text not null,
  event_type text not null,
  payload jsonb not null,
  processed_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  primary key(provider, event_id)
);

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  channel text not null default 'email' check (channel in ('email','whatsapp')),
  template text not null,
  recipient text not null,
  payload jsonb not null default '{}'::jsonb,
  provider_message_id text,
  sent_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

create table public.api_requests (
  id bigint generated always as identity primary key,
  action text not null,
  client_hash text not null,
  created_at timestamptz not null default now()
);
create index api_requests_rate_idx on public.api_requests(action, client_hash, created_at desc);

create index orders_created_at_idx on public.orders(created_at desc);
create index orders_status_idx on public.orders(order_status, payment_status);
create index order_items_order_id_idx on public.order_items(order_id);
create index project_requests_created_at_idx on public.project_requests(created_at desc);
create index attachments_order_id_idx on public.attachments(order_id);
create index attachments_project_id_idx on public.attachments(project_request_id);
create index payments_order_id_idx on public.payments(order_id);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger products_updated_at before update on public.products for each row execute function public.set_updated_at();
create trigger orders_updated_at before update on public.orders for each row execute function public.set_updated_at();
create trigger projects_updated_at before update on public.project_requests for each row execute function public.set_updated_at();
create trigger quotes_updated_at before update on public.quotes for each row execute function public.set_updated_at();
create trigger payments_updated_at before update on public.payments for each row execute function public.set_updated_at();

create or replace function public.is_admin(required_roles text[] default array['owner','manager','viewer'])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users a
    where a.user_id = auth.uid()
      and a.active
      and a.role = any(required_roles)
  ) and coalesce((auth.jwt() ->> 'aal') = 'aal2', false);
$$;

revoke all on function public.is_admin(text[]) from public;
grant execute on function public.is_admin(text[]) to authenticated;

alter table public.admin_users enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.product_addons enable row level security;
alter table public.promotion_rules enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.project_requests enable row level security;
alter table public.quotes enable row level security;
alter table public.quote_items enable row level security;
alter table public.attachments enable row level security;
alter table public.payments enable row level security;
alter table public.refunds enable row level security;
alter table public.order_status_history enable row level security;
alter table public.project_status_history enable row level security;
alter table public.webhook_events enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.audit_log enable row level security;
alter table public.api_requests enable row level security;

create policy "public reads active products" on public.products for select to anon, authenticated using (active);
create policy "public reads active variants" on public.product_variants for select to anon, authenticated using (active);
create policy "public reads active addons" on public.product_addons for select to anon, authenticated using (active);

create policy "admins read themselves" on public.admin_users for select to authenticated using (user_id = auth.uid() and active);
create policy "admins read products" on public.products for select to authenticated using (public.is_admin());
create policy "admins manage products" on public.products for all to authenticated using (public.is_admin(array['owner','manager'])) with check (public.is_admin(array['owner','manager']));
create policy "admins read variants" on public.product_variants for select to authenticated using (public.is_admin());
create policy "admins manage variants" on public.product_variants for all to authenticated using (public.is_admin(array['owner','manager'])) with check (public.is_admin(array['owner','manager']));
create policy "admins read addons" on public.product_addons for select to authenticated using (public.is_admin());
create policy "admins manage addons" on public.product_addons for all to authenticated using (public.is_admin(array['owner','manager'])) with check (public.is_admin(array['owner','manager']));

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'promotion_rules','orders','order_items','project_requests','quotes','quote_items',
    'attachments','payments','refunds','order_status_history','project_status_history',
    'webhook_events','notification_outbox','audit_log','api_requests'
  ] loop
    execute format(
      'create policy "admins read %1$s" on public.%1$I for select to authenticated using (public.is_admin())',
      table_name
    );
  end loop;
end $$;

create policy "admins update orders" on public.orders for update to authenticated using (public.is_admin(array['owner','manager'])) with check (public.is_admin(array['owner','manager']));
create policy "admins update projects" on public.project_requests for update to authenticated using (public.is_admin(array['owner','manager'])) with check (public.is_admin(array['owner','manager']));
create policy "admins manage quotes" on public.quotes for all to authenticated using (public.is_admin(array['owner','manager'])) with check (public.is_admin(array['owner','manager']));
create policy "admins manage quote items" on public.quote_items for all to authenticated using (public.is_admin(array['owner','manager'])) with check (public.is_admin(array['owner','manager']));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'private-references', 'private-references', false, 10485760,
  array['image/jpeg','image/png','application/pdf']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "admins read private references"
on storage.objects for select to authenticated
using (bucket_id = 'private-references' and public.is_admin());

commit;
