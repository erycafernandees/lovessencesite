-- LOCAL REVIEW ONLY. Apply in a disposable PostgreSQL/Supabase test database
-- before deployment. No existing data is rewritten by this migration.
begin;

create or replace function public.finalize_stripe_checkout(
  p_session jsonb, p_payment jsonb, p_admin_email text default null
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  o public.orders%rowtype;
  total integer;
  base integer;
  coupon integer;
  v_payment_status public.payment_state;
  next_state public.order_state;
  quote_id uuid;
  notifications jsonb;
begin
  -- Quote reservation takes quote -> order locks. Use the same order here.
  if p_session->'metadata'->>'quote_id' is not null then
    perform 1 from public.quotes
      where id=(p_session->'metadata'->>'quote_id')::uuid
        and order_id=(p_session->'metadata'->>'order_id')::uuid for update;
    if not found then raise exception 'Quote does not own this order'; end if;
  end if;
  -- Serialize different events for the same order, including concurrent retries.
  select * into strict o from public.orders
    where id = (p_session->'metadata'->>'order_id')::uuid for update;
  if o.payment_provider <> 'stripe' or o.stripe_checkout_session_id is distinct from p_session->>'id'
    or p_session->>'currency' is distinct from o.currency
    or p_session->>'mode' is distinct from 'payment'
    or p_session->>'status' is distinct from 'complete' then
    raise exception 'Stripe session binding mismatch';
  end if;
  if jsonb_typeof(p_session->'amount_total') is distinct from 'number'
    or jsonb_typeof(p_session->'amount_subtotal') is distinct from 'number'
    or jsonb_typeof(p_session->'total_details'->'amount_discount') is distinct from 'number' then
    raise exception 'Stripe amount missing';
  end if;
  total := (p_session->>'amount_total')::integer;
  base := (p_session->>'amount_subtotal')::integer;
  coupon := (p_session->'total_details'->>'amount_discount')::integer;
  if total < 0 or coupon < 0 or coupon > base or total <> base - coupon
    or p_session->'total_details'->>'amount_tax' is distinct from '0'
    or coalesce(p_session->'total_details'->>'amount_shipping','0') is distinct from '0'
    or (p_session->>'payment_status' is distinct from 'paid'
      and (total <> 0 or p_session->>'payment_status' is distinct from 'no_payment_required')) then
    raise exception 'Stripe payment amount/status mismatch';
  end if;

  if o.payment_status in ('paid', 'partially_refunded', 'refunded') then
    if total <> o.total_amount or base <> o.subtotal_amount + o.shipping_amount - o.discount_amount + coupon then
      raise exception 'Previously recorded payment mismatch';
    end if;
  else
    if o.order_status = 'cancelled' or o.payment_status = 'cancelled'
      or base <> o.subtotal_amount - o.discount_amount + o.shipping_amount then
      raise exception 'Order is unavailable or total differs';
    end if;
    if o.source = 'custom_quote' then
      -- Read ownership from the database, never trust project IDs in metadata.
      select id into strict quote_id from public.quotes
        where order_id = o.id and project_request_id = o.project_request_id
          and id = (p_session->'metadata'->>'quote_id')::uuid;
    end if;
    if (p_payment->>'refunded_amount')::integer < 0 or (p_payment->>'refunded_amount')::integer > total then
      raise exception 'Invalid refunded amount';
    end if;
    v_payment_status := case when total > 0 and (p_payment->>'refunded_amount')::integer >= total then 'refunded'::public.payment_state
      when (p_payment->>'refunded_amount')::integer > 0 then 'partially_refunded'::public.payment_state
      else 'paid'::public.payment_state end;
    next_state := case when o.order_status in ('draft', 'awaiting_payment') then 'confirmed'::public.order_state else o.order_status end;
    insert into public.payments (
      order_id, provider, status, provider_checkout_id, provider_payment_id,
      provider_charge_id, provider_balance_transaction_id, currency, gross_amount,
      processing_fee_amount, net_amount, refunded_amount, payment_method_type, provider_data
    ) values (
      o.id, 'stripe', v_payment_status, p_session->>'id', p_payment->>'payment_intent_id',
      p_payment->>'charge_id', p_payment->>'balance_id', o.currency, total,
      (p_payment->>'fee')::integer, (p_payment->>'net')::integer,
      (p_payment->>'refunded_amount')::integer, p_payment->>'method', p_payment
    ) on conflict (provider, provider_checkout_id) do update set
      status = excluded.status, currency = excluded.currency, provider_payment_id = excluded.provider_payment_id,
      provider_charge_id = excluded.provider_charge_id,
      provider_balance_transaction_id = excluded.provider_balance_transaction_id,
      gross_amount = excluded.gross_amount, processing_fee_amount = excluded.processing_fee_amount,
      net_amount = excluded.net_amount, refunded_amount = excluded.refunded_amount,
      payment_method_type = excluded.payment_method_type, provider_data = excluded.provider_data
    where public.payments.order_id = o.id;
    if not found then raise exception 'Checkout is already bound to a different order'; end if;

    update public.orders set payment_status = v_payment_status, order_status = next_state,
      customer_name = coalesce(p_session->'customer_details'->>'name', customer_name),
      customer_email = coalesce(p_session->'customer_details'->>'email', customer_email),
      customer_phone = coalesce(p_session->'customer_details'->>'phone', customer_phone),
      shipping_address = coalesce(nullif(p_session->'collected_information'->'shipping_details', 'null'::jsonb), shipping_address),
      stripe_customer_id = p_payment->>'customer_id', stripe_payment_intent_id = p_payment->>'payment_intent_id',
      total_amount = total, discount_amount = subtotal_amount + shipping_amount - total,
      paid_at = coalesce(paid_at, now()) where id = o.id;
    insert into public.order_status_history(order_id, order_status, payment_status, note)
      values(o.id, next_state, v_payment_status, 'Pagamento confirmado pela Stripe');
    if quote_id is not null then
      update public.quotes set status = 'paid' where id = quote_id;
      update public.project_requests set status = 'paid' where id = o.project_request_id;
    end if;
    if v_payment_status = 'paid' then
      if coalesce(p_session->'customer_details'->>'email', o.customer_email) is not null then
        insert into public.notification_outbox(template, recipient, payload) values
          ('order_paid', coalesce(p_session->'customer_details'->>'email', o.customer_email), jsonb_build_object('orderId', o.id, 'orderNumber', o.order_number));
      end if;
      if p_admin_email is not null then
        insert into public.notification_outbox(template, recipient, payload) values
          ('admin_order_paid', p_admin_email, jsonb_build_object('orderId', o.id, 'orderNumber', o.order_number));
      end if;
    end if;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'template', template, 'recipient', recipient, 'payload', payload)), '[]'::jsonb)
    into notifications from public.notification_outbox
    where payload->>'orderId' = o.id::text and template in ('order_paid', 'admin_order_paid') and sent_at is null
      and coalesce(v_payment_status, o.payment_status) = 'paid';
  return jsonb_build_object('notifications', notifications);
end;
$$;
revoke all on function public.finalize_stripe_checkout(jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.finalize_stripe_checkout(jsonb, jsonb, text) to service_role;

create or replace function public.record_stripe_refund(p_charge jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  p public.payments%rowtype;
  o public.orders%rowtype;
  r jsonb;
  refunded integer;
  v_status public.payment_state;
begin
  select * into strict p from public.payments
    where provider = 'stripe' and provider_charge_id = p_charge->>'id';
  -- Same lock order as checkout finalization: order first, then payment.
  select * into strict o from public.orders where id = p.order_id for update;
  select * into strict p from public.payments where id = p.id for update;
  if p_charge->>'currency' is distinct from p.currency
    or (p_charge->>'amount')::integer is distinct from p.gross_amount
    or jsonb_typeof(p_charge->'amount_refunded') is distinct from 'number' then
    raise exception 'Refund does not match payment';
  end if;
  refunded := (p_charge->>'amount_refunded')::integer;
  if refunded < 0 or refunded > p.gross_amount then raise exception 'Invalid refund amount'; end if;
  for r in select value from jsonb_array_elements(coalesce(p_charge->'refunds'->'data', '[]'::jsonb)) loop
    insert into public.refunds(payment_id, provider_refund_id, amount, status, reason)
      values(p.id, r->>'id', (r->>'amount')::integer, coalesce(r->>'status', 'unknown'), r->>'reason')
      on conflict(provider_refund_id) do update set status = excluded.status, reason = excluded.reason
      where public.refunds.payment_id = p.id;
    if not found then raise exception 'Refund belongs to another payment'; end if;
  end loop;
  if refunded <= p.refunded_amount then return; end if;
  v_status := case when refunded >= p.gross_amount then 'refunded'::public.payment_state else 'partially_refunded'::public.payment_state end;
  update public.payments set status = v_status, refunded_amount = refunded where id = p.id;
  update public.orders set payment_status = v_status where id = o.id;
  insert into public.order_status_history(order_id, payment_status, note)
    values(o.id, v_status, 'Reembolso atualizado pela Stripe');
end;
$$;
revoke all on function public.record_stripe_refund(jsonb) from public, anon, authenticated;
grant execute on function public.record_stripe_refund(jsonb) to service_role;
commit;
