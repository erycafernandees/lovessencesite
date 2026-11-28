create or replace function public.admin_order_totals()
returns table(direct_amount bigint, custom_amount bigint)
language sql stable security invoker set search_path = ''
as $$
  with eligible_orders as (
    select o.* from public.orders o
    where not o.is_test and left(coalesce(o.stripe_checkout_session_id,''),8) <> 'cs_test_'
      and o.order_status <> 'cancelled' and o.payment_status <> 'refunded'
      and (o.order_status in ('confirmed','production','ready_to_ship','shipped','completed')
        or o.payment_status in ('paid','partially_refunded') or o.manual_received_amount > 0)
  ), standalone as (
    select o.total_amount, (o.source = 'custom_quote' or o.id = '66d06841-5c0b-4ab6-9261-f962d7cafe12') as custom
    from eligible_orders o where o.project_request_id is null
  ), projects as (
    select coalesce(q.total_amount, linked.total_amount) as total_amount
    from public.project_requests p
    left join lateral (
      select o.total_amount from eligible_orders o where o.project_request_id = p.id
      order by o.paid_at desc nulls last, o.created_at desc limit 1
    ) linked on true
    left join lateral (
      select q.total_amount,q.status from public.quotes q
      where q.project_request_id = p.id and q.status not in ('cancelled','expired')
      order by (q.status in ('approved','paid')) desc,q.version desc limit 1
    ) q on true
    where p.status <> 'declined' and coalesce(p.fulfillment_status::text,'') <> 'cancelled'
      and (linked.total_amount is not null or not exists (
        select 1 from public.orders o where o.project_request_id = p.id
      ) or p.payment_received_amount > 0)
      and (linked.total_amount is not null or p.payment_received_amount > 0 or q.status in ('approved','paid')
        or p.status in ('approved','paid','production','completed')
        or p.fulfillment_status::text in ('confirmed','production','ready_to_ship','shipped','completed'))
  )
  select coalesce((select sum(total_amount) from standalone where not custom),0)::bigint,
    (coalesce((select sum(total_amount) from standalone where custom),0)
      + coalesce((select sum(total_amount) from projects),0))::bigint
  where public.is_admin();
$$;
revoke all on function public.admin_order_totals() from public, anon;
grant execute on function public.admin_order_totals() to authenticated;
