-- Review/test locally before any production application.
begin;
create or replace function public.reserve_quote_checkout(p_quote_id uuid, p_access_hash text, p_order_token_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  q public.quotes%rowtype;
  p public.project_requests%rowtype;
  o public.orders%rowtype;
  items jsonb;
begin
  select * into strict q from public.quotes where id = p_quote_id for update;
  if q.access_token_hash is distinct from p_access_hash or q.access_token_expires_at is null or q.access_token_expires_at <= now() then
    raise exception 'Quote access is invalid or expired';
  end if;
  if q.status not in ('sent','approved') or (q.valid_until is not null and q.valid_until < (now() at time zone 'UTC')::date) then
    raise exception 'Quote is unavailable';
  end if;
  select * into strict p from public.project_requests where id = q.project_request_id;
  if q.order_id is not null then
    select * into strict o from public.orders where id = q.order_id for update;
    if o.payment_status not in ('unpaid','processing','failed') or o.order_status = 'cancelled' then
      raise exception 'Order is no longer payable';
    end if;
    if o.total_amount <> q.total_amount or o.currency <> q.currency then raise exception 'Quote changed after reservation'; end if;
  else
    insert into public.orders(source,order_status,payment_status,payment_provider,currency,
      subtotal_amount,discount_amount,shipping_amount,total_amount,customer_name,customer_email,customer_phone,
      project_request_id,access_token_hash)
    values('custom_quote','awaiting_payment','unpaid','stripe',q.currency,
      q.subtotal_amount,q.discount_amount,q.shipping_amount,q.total_amount,p.customer_name,p.customer_email,p.customer_phone,
      p.id,p_order_token_hash) returning * into o;
    update public.quotes set order_id=o.id,status='approved',approved_at=coalesce(approved_at,now()) where id=q.id;
    update public.project_requests set status='payment_pending' where id=p.id;
  end if;
  select coalesce(jsonb_agg(to_jsonb(i) order by i.created_at,i.id),'[]'::jsonb) into items from public.quote_items i where i.quote_id=q.id;
  return jsonb_build_object('order',to_jsonb(o),'quote',to_jsonb(q)||jsonb_build_object('quote_items',items,'project_requests',to_jsonb(p)));
end;
$$;
revoke all on function public.reserve_quote_checkout(uuid,text,text) from public,anon,authenticated;
grant execute on function public.reserve_quote_checkout(uuid,text,text) to service_role;

create or replace function public.attach_stripe_checkout(p_order_id uuid,p_session_id text)
returns void language plpgsql security invoker set search_path = '' as $$
declare o public.orders%rowtype;
begin
  select * into strict o from public.orders where id=p_order_id for update;
  if o.payment_provider <> 'stripe' or o.order_status='cancelled'
    or p_session_id is null or p_session_id !~ '^cs_[A-Za-z0-9_]+' then raise exception 'Checkout is unavailable'; end if;
  if o.stripe_checkout_session_id is not null and o.stripe_checkout_session_id <> p_session_id then raise exception 'Checkout already bound'; end if;
  if o.payment_status in ('paid','partially_refunded','refunded') then
    if o.stripe_checkout_session_id=p_session_id then return; end if;
    raise exception 'Order is already paid';
  end if;
  if o.payment_status='cancelled' then raise exception 'Payment is cancelled'; end if;
  update public.orders set stripe_checkout_session_id=p_session_id,order_status='awaiting_payment' where id=o.id;
  insert into public.payments(order_id,provider,status,provider_checkout_id,currency)
    values(o.id,'stripe','unpaid',p_session_id,o.currency)
    on conflict(provider,provider_checkout_id) do nothing;
  if not exists(select 1 from public.payments where provider='stripe' and provider_checkout_id=p_session_id and order_id=o.id) then
    raise exception 'Session belongs to another order';
  end if;
end;
$$;
revoke all on function public.attach_stripe_checkout(uuid,text) from public,anon,authenticated;
grant execute on function public.attach_stripe_checkout(uuid,text) to service_role;

-- Existing production coupon: one order globally, retryable by that same order.
create or replace function public.claim_test_checkout_code(p_code text,p_order_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.one_time_checkout_codes set order_id=p_order_id,claimed_at=coalesce(claimed_at,now())
    where code=p_code and (order_id is null or order_id=p_order_id);
  return found;
end;
$$;
revoke all on function public.claim_test_checkout_code(text,uuid) from public,anon,authenticated;
grant execute on function public.claim_test_checkout_code(text,uuid) to service_role;
commit;
