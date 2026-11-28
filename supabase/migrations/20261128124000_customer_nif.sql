alter table public.orders add column customer_nif text check(customer_nif ~ '^[0-9]{9}$');
alter table public.project_requests add column customer_nif text check(customer_nif ~ '^[0-9]{9}$');

create function public.save_quote_checkout_nif(p_order uuid, p_project uuid, p_nif text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  update public.orders set customer_nif=p_nif
    where id=p_order and project_request_id=p_project and payment_status in ('unpaid','failed');
  if found then
    update public.project_requests set customer_nif=p_nif where id=p_project;
  end if;
end;
$$;
revoke all on function public.save_quote_checkout_nif(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.save_quote_checkout_nif(uuid,uuid,text) to service_role;
