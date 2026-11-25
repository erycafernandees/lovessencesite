-- Run ONLY against a disposable local Supabase/PostgreSQL test database after
-- applying the schema and security migrations. Fixtures roll back at the end.
\set ON_ERROR_STOP on
begin;
create function pg_temp.assert_true(ok boolean, message text) returns void
language plpgsql as $$ begin if ok is distinct from true then raise exception '%', message; end if; end $$;

insert into public.orders(id, order_number, access_token_hash, payment_provider, subtotal_amount, discount_amount, shipping_amount, total_amount, stripe_checkout_session_id)
values ('00000000-0000-4000-8000-000000000601', 'SECURITY-LOCAL-601', 'test-only', 'stripe', 2000, 100, 590, 2490, 'cs_local_security_601');

do $$
declare
  s jsonb := '{"id":"cs_local_security_601","mode":"payment","status":"complete","payment_status":"paid","currency":"eur","amount_subtotal":2490,"amount_total":2290,"total_details":{"amount_discount":200,"amount_tax":0,"amount_shipping":0},"metadata":{"order_id":"00000000-0000-4000-8000-000000000601"},"customer_details":{"email":"test@example.invalid"}}';
  p jsonb := '{"payment_intent_id":"pi_local_security_601","charge_id":"ch_local_security_601","refunded_amount":0,"fee":50,"net":2240}';
  bad jsonb;
  accepted boolean;
begin
  foreach bad in array array[
    jsonb_set(s, '{id}', '"cs_other"'),
    jsonb_set(s, '{currency}', '"usd"'),
    jsonb_set(s, '{amount_total}', '1'),
    jsonb_set(s, '{amount_total}', 'null'),
    jsonb_set(s, '{payment_status}', '"unpaid"'),
    jsonb_set(s, '{total_details,amount_discount}', '-1')
  ] loop
    accepted := false;
    begin
      perform public.finalize_stripe_checkout(bad, p, null);
      accepted := true;
    exception when others then null;
    end;
    perform pg_temp.assert_true(not accepted, 'Invalid Stripe session was accepted');
  end loop;
  perform pg_temp.assert_true((select payment_status = 'unpaid' from public.orders where id = '00000000-0000-4000-8000-000000000601'), 'Rejected request changed payment state');
  perform public.finalize_stripe_checkout(s, p, 'admin@example.invalid');
  perform pg_temp.assert_true((select payment_status = 'paid' and total_amount = 2290 and discount_amount = 300 from public.orders where id = '00000000-0000-4000-8000-000000000601'), 'Wrong final amount or status');
  perform public.finalize_stripe_checkout(s, p, 'admin@example.invalid');
  perform pg_temp.assert_true((select count(*) = 1 from public.payments where order_id = '00000000-0000-4000-8000-000000000601'), 'Duplicate payment row');
  perform pg_temp.assert_true((select count(*) = 1 from public.order_status_history where order_id = '00000000-0000-4000-8000-000000000601'), 'Duplicate payment history');
  perform pg_temp.assert_true((select count(*) = 2 from public.notification_outbox where payload->>'orderId' = '00000000-0000-4000-8000-000000000601'), 'Duplicate notifications');
  perform public.record_stripe_refund('{"id":"ch_local_security_601","currency":"eur","amount":2290,"amount_refunded":2290,"refunds":{"data":[]}}');
  perform public.record_stripe_refund('{"id":"ch_local_security_601","currency":"eur","amount":2290,"amount_refunded":100,"refunds":{"data":[]}}');
  perform public.finalize_stripe_checkout(s, p, null);
  perform pg_temp.assert_true((select payment_status = 'refunded' from public.orders where id = '00000000-0000-4000-8000-000000000601'), 'Stale event undid refund');
  perform pg_temp.assert_true((select refunded_amount = 2290 from public.payments where order_id = '00000000-0000-4000-8000-000000000601'), 'Stale partial refund reduced total');
end;
$$;

select pg_temp.assert_true(not has_function_privilege('anon', 'public.finalize_stripe_checkout(jsonb,jsonb,text)', 'execute'), 'Anonymous checkout RPC access');
select pg_temp.assert_true(not has_function_privilege('authenticated', 'public.record_stripe_refund(jsonb)', 'execute'), 'Authenticated refund RPC access');
rollback;
